import * as admin from "firebase-admin";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getUnbilledEntries, getLastInvoice, getTimeEntriesForRange} from "./fta-client";
import Anthropic from "@anthropic-ai/sdk";

admin.initializeApp();
const db = admin.firestore();

// ─── Auth helper ───────────────────────────────────────────────
async function verifyAuth(
  req: {headers: {authorization?: string}}
): Promise<admin.auth.DecodedIdToken> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  return admin.auth().verifyIdToken(auth.split("Bearer ")[1]);
}

// ─── TTS: ElevenLabs proxy (same pattern as Solomon) ───────────
const ELEVENLABS_VOICE_ID: Record<string, string> = {
  "female-american": "WyFXw4PzMbRnp8iLMJwY",
  "male-american": "ZoiZ8fuDWInAcwPXaVeq",
  "female-british": "kBag1HOZlaVBH7ICPE8x",
  "male-british": "onwK4e9ZLuTAKqWW03F9",
};

export const synthesizeSpeech = onRequest(
  {cors: true, region: "us-central1", memory: "256MiB"},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    const {text, voice} = req.body as {text?: string; voice?: string};
    if (!text) {
      res.status(400).json({error: "text is required"});
      return;
    }

    const voiceId = ELEVENLABS_VOICE_ID[voice || "female-american"]
      || ELEVENLABS_VOICE_ID["female-american"];

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      res.status(500).json({error: "ELEVENLABS_API_KEY not configured"});
      return;
    }

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: {stability: 0.5, similarity_boost: 0.75},
          }),
        }
      );

      if (!response.ok) {
        const errBody = await response.text();
        if (errBody.includes("quota_exceeded")) {
          res.status(429).json({error: "quota_exceeded"});
          return;
        }
        res.status(response.status).json({error: errBody});
        return;
      }

      // Buffer full response for Content-Length (iOS Safari compatibility)
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.set("Content-Type", "audio/mpeg");
      res.set("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "TTS failed";
      res.status(500).json({error: message});
    }
  }
);

// ─── Chat: Conversational AI via Anthropic ─────────────────────
export const chat = onRequest(
  {cors: true, region: "us-central1", memory: "256MiB", timeoutSeconds: 60},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    const {message, sessionId} = req.body as {message?: string; sessionId?: string};
    if (!message) {
      res.status(400).json({error: "message is required"});
      return;
    }
    if (!sessionId) {
      res.status(400).json({error: "sessionId is required"});
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({error: "ANTHROPIC_API_KEY not configured"});
      return;
    }

    // Gather context from Firestore and fta-time-tracker
    const chatNow = new Date();
    const chatTodayStart = new Date(chatNow);
    chatTodayStart.setHours(0, 0, 0, 0);
    const chatTomorrowEnd = new Date(chatNow);
    chatTomorrowEnd.setDate(chatTomorrowEnd.getDate() + 2);
    chatTomorrowEnd.setHours(0, 0, 0, 0);

    const [unbilledEntries, lastInvoice, todayBriefing, alerts, tasks, sessionHistory, customCategories, chatCalendarEvents] =
      await Promise.all([
        getUnbilledEntries().catch(() => []),
        getLastInvoice().catch(() => null),
        db.collection("briefings")
          .orderBy("createdAt", "desc").limit(1).get()
          .then((s) => s.empty ? null : s.docs[0].data())
          .catch(() => null),
        db.collection("alerts")
          .where("dismissed", "==", false)
          .orderBy("createdAt", "desc").limit(10).get()
          .then((s) => s.docs.map((d) => d.data()))
          .catch(() => []),
        db.collection("tasks")
          .where("completed", "==", false)
          .orderBy("createdAt", "desc").get()
          .then((s) => s.docs.map((d) => ({id: d.id, ...d.data()})))
          .catch(() => []),
        // Load last 40 messages for this session as conversation history
        // Order by sequence (integer) for deterministic ordering — serverTimestamp
        // is not reliable within the same batch commit (both msgs get same timestamp)
        db.collection("chatMessages")
          .where("sessionId", "==", sessionId)
          .orderBy("sequence", "asc")
          .limitToLast(40)
          .get()
          .then((s) => s.docs.map((d) => d.data() as {role: string; content: string}))
          .catch(() => []),
        // Load custom categories (defaults are always available client-side)
        db.collection("taskCategories")
          .orderBy("order", "asc").get()
          .then((s) => s.docs.map((d) => d.data() as {key: string; label: string}))
          .catch(() => []),
        // Calendar events for today + tomorrow
        getCalendarEvents(chatTodayStart, chatTomorrowEnd).catch(() => []),
      ]);

    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );
    const unbilledAmount = totalUnbilled * 150;

    const defaultCategoryKeys = ["ihrdc", "solomon", "dial", "ppk", "church", "general"];
    const allCategories: Array<{key: string; label: string}> = [
      {key: "ihrdc", label: "IHRDC"},
      {key: "solomon", label: "Solomon"},
      {key: "dial", label: "DIAL"},
      {key: "ppk", label: "PPK"},
      {key: "church", label: "Church"},
      {key: "general", label: "General"},
      ...customCategories.filter((c) => !defaultCategoryKeys.includes(c.key)),
    ];

    const systemPrompt = `You are Maisie, Jack Notarangelo's personal executive assistant. Your name is Maisie. When Jack addresses you by name (e.g., "Maisie, what does my schedule look like?"), treat your name as a natural greeting — do not interpret it as a topic or question. Simply respond to whatever follows your name.

You help Jack manage his time, tasks, and business. All times are Eastern Time (ET).

Jack's top priority: Glorify God and Enjoy Him Forever.

Current context:
- Unbilled hours: ${totalUnbilled.toFixed(1)}h ($${unbilledAmount.toFixed(0)}) at $150/hr
- Last invoice: ${lastInvoice ? `${lastInvoice.issueDate} for $${lastInvoice.total}` : "None found"}
- Active tasks: ${tasks.length > 0 ? tasks.map((t: Record<string, unknown>) => {
  const due = t["dueDate"] ? ` (due: ${t["dueDate"]})` : "";
  return `[${t["id"]}][${t["category"]}] ${t["title"]}${due}`;
}).join("; ") : "None"}
- Active alerts: ${alerts.length > 0 ? alerts.map((a: Record<string, unknown>) => `${a["type"]}: ${a["message"]}`).join("; ") : "None"}
- Today's briefing: ${todayBriefing ? JSON.stringify(todayBriefing) : "Not generated yet"}
- Calendar (today & tomorrow): ${chatCalendarEvents.length > 0 ? chatCalendarEvents.map((e) => {
  const day = e.startTime.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York"});
  return `${day} ${formatEventTime(e.startTime)}–${formatEventTime(e.endTime)}: ${e.summary}${e.location ? ` (${e.location})` : ""}`;
}).join("; ") : "No upcoming events"}
- Task categories: ${allCategories.map((c) => `${c.key} (${c.label})`).join(", ")}

Be concise and direct. Use a warm, professional tone — like a trusted assistant who knows Jack well. When Jack asks you to add or complete a task, use the appropriate tool to actually do it — don't just say you did it. When Jack asks you to create a new task category, use the create_task_category tool.
Today is ${new Date().toLocaleDateString("en-US", {weekday: "long", year: "numeric", month: "long", day: "numeric"})}.`;

    const buildTools = (cats: Array<{key: string; label: string}>): Anthropic.Messages.Tool[] => [
      {
        name: "get_calendar",
        description: "Get Jack's calendar events for a date range. Use this when Jack asks about his schedule, meetings, or availability.",
        input_schema: {
          type: "object" as const,
          properties: {
            days_ahead: {
              type: "number",
              description: "Number of days ahead to look (default 1 = today only, 2 = today + tomorrow, 7 = this week)",
            },
          },
          required: [],
        },
      },
      {
        name: "add_task",
        description: "Add a new task to Jack's task list",
        input_schema: {
          type: "object" as const,
          properties: {
            title: {type: "string", description: "The task description"},
            category: {
              type: "string",
              enum: cats.map((c) => c.key),
              description: `Task category. Available: ${cats.map((c) => `${c.key} (${c.label})`).join(", ")}. Use 'church' for Grace Pres church tasks. If a suitable category doesn't exist, create it first with create_task_category.`,
            },
            dueDate: {
              type: "string",
              description: "Optional due date in YYYY-MM-DD format",
            },
          },
          required: ["title", "category"],
        },
      },
      {
        name: "complete_task",
        description: "Mark a task as completed. Use the task ID from the active tasks list.",
        input_schema: {
          type: "object" as const,
          properties: {
            taskId: {
              type: "string",
              description: "The Firestore document ID of the task to complete",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "create_task_category",
        description: "Create a new task category. Use this when Jack wants to organize tasks under a new project or area that doesn't have a category yet.",
        input_schema: {
          type: "object" as const,
          properties: {
            key: {
              type: "string",
              description: "A short lowercase identifier for the category (e.g. 'acme', 'fitness'). No spaces or special characters.",
            },
            label: {
              type: "string",
              description: "The human-readable display name for the category (e.g. 'Acme Corp', 'Fitness').",
            },
          },
          required: ["key", "label"],
        },
      },
    ];

    let tools = buildTools(allCategories);

    try {
      const anthropic = new Anthropic({apiKey});

      // Build messages: prior session history + current user message
      const historyMessages: Anthropic.Messages.MessageParam[] = sessionHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      const messages: Anthropic.Messages.MessageParam[] = [
        ...historyMessages,
        {role: "user", content: message},
      ];

      let response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages,
      });

      // Tool use loop — execute any tool calls, then get the final text response
      while (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
        );
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          if (block.name === "get_calendar") {
            const input = block.input as {days_ahead?: number};
            const daysAhead = input.days_ahead || 1;
            const calStart = new Date();
            calStart.setHours(0, 0, 0, 0);
            const calEnd = new Date(calStart);
            calEnd.setDate(calEnd.getDate() + daysAhead);
            const events = await getCalendarEvents(calStart, calEnd).catch(() => []);
            const formatted = events.map((e) => {
              const day = e.startTime.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York"});
              const time = `${formatEventTime(e.startTime)}–${formatEventTime(e.endTime)}`;
              return `${day} ${time}: ${e.summary}${e.location ? ` (${e.location})` : ""}`;
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                events: formatted,
                count: events.length,
                range: `Next ${daysAhead} day(s)`,
              }),
            });
          } else if (block.name === "add_task") {
            const input = block.input as {
              title: string;
              category: string;
              dueDate?: string;
            };
            const docRef = await db.collection("tasks").add({
              title: input.title,
              category: input.category,
              completed: false,
              dueDate: input.dueDate || null,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({success: true, taskId: docRef.id}),
            });
          } else if (block.name === "complete_task") {
            const input = block.input as {taskId: string};
            await db.collection("tasks").doc(input.taskId).update({
              completed: true,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({success: true}),
            });
          } else if (block.name === "create_task_category") {
            const input = block.input as {key: string; label: string};
            const sanitizedKey = input.key.toLowerCase().replace(/[^a-z0-9-_]/g, "");
            const isDefault = ["ihrdc", "solomon", "dial", "ppk", "church", "general"].includes(sanitizedKey);
            const existingSnap = await db.collection("taskCategories")
              .where("key", "==", sanitizedKey).limit(1).get();
            if (isDefault || !existingSnap.empty) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({success: false, error: `Category "${sanitizedKey}" already exists.`}),
              });
            } else {
              const orderSnap = await db.collection("taskCategories")
                .orderBy("order", "desc").limit(1).get();
              const existingOrders = orderSnap.docs.map((d) => (d.data()["order"] as number) ?? 0);
              const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) + 1 : 100;
              await db.collection("taskCategories").add({
                key: sanitizedKey,
                label: input.label,
                order: maxOrder,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              // Update allCategories and rebuild tools so subsequent add_task calls can use the new key
              allCategories.push({key: sanitizedKey, label: input.label});
              tools = buildTools(allCategories);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({success: true, key: sanitizedKey, label: input.label}),
              });
            }
          }
        }

        messages.push({role: "assistant", content: response.content});
        messages.push({role: "user", content: toolResults});

        response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          messages,
        });
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => {
          if (b.type === "text") return b.text;
          return "";
        })
        .join("");

      // Store user message and assistant reply in the session
      // Use integer sequence for deterministic ordering (same approach as Solomon).
      // serverTimestamp resolves to the same value for both docs in a batch,
      // so timestamp-based ordering is unreliable.
      const seqSnap = await db.collection("chatMessages")
        .where("sessionId", "==", sessionId)
        .orderBy("sequence", "desc")
        .limit(1)
        .get();
      const baseSeq = seqSnap.empty ? 0 : ((seqSnap.docs[0].data()["sequence"] as number) + 1);

      const now = admin.firestore.FieldValue.serverTimestamp();
      const batch = db.batch();

      const userMsgRef = db.collection("chatMessages").doc();
      batch.set(userMsgRef, {
        sessionId,
        role: "user",
        content: message,
        sequence: baseSeq,
        createdAt: now,
      });

      const assistantMsgRef = db.collection("chatMessages").doc();
      batch.set(assistantMsgRef, {
        sessionId,
        role: "assistant",
        content: text,
        sequence: baseSeq + 1,
        createdAt: now,
      });

      // Update session metadata
      const sessionRef = db.collection("chatSessions").doc(sessionId);
      batch.update(sessionRef, {
        lastMessage: text.substring(0, 100),
        updatedAt: now,
      });

      await batch.commit();

      res.json({response: text});
    } catch (err: unknown) {
      console.error("[chat] error:", err);
      const errMessage = err instanceof Error ? err.message : "Chat failed";
      res.status(500).json({error: errMessage});
    }
  }
);

// ─── Callable: Get unbilled summary ────────────────────────────
export const getUnbilledSummary = onRequest(
  {cors: true, region: "us-central1"},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }

    const entries = await getUnbilledEntries();
    const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
    res.json({
      totalHours: Math.round(totalHours * 100) / 100,
      totalAmount: Math.round(totalHours * 150 * 100) / 100,
      entryCount: entries.length,
      entries: entries.slice(0, 10),
    });
  }
);

// ─── Helper: Get today's calendar events from Firestore ─────────
async function getCalendarEvents(
  startOfDay: Date, endOfDay: Date
): Promise<Array<{summary: string; startTime: Date; endTime: Date; location?: string}>> {
  const snap = await db.collection("calendarEvents")
    .where("startTime", ">=", admin.firestore.Timestamp.fromDate(startOfDay))
    .where("startTime", "<", admin.firestore.Timestamp.fromDate(endOfDay))
    .orderBy("startTime", "asc")
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      summary: data.summary,
      startTime: data.startTime.toDate(),
      endTime: data.endTime.toDate(),
      location: data.location || undefined,
    };
  });
}

function formatEventTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
}

// ─── Scheduled: Briefing (weekdays 7am & 1pm ET) ────────────────
export const morningBriefing = onSchedule(
  {
    schedule: "0 7,13 * * 1-5",
    timeZone: "America/New_York",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const dayOfMonth = today.getDate();
    const isFriday = dayOfWeek === 5;
    const isFirstWeek = dayOfMonth <= 7;
    const etHour = parseInt(
      today.toLocaleString("en-US", {hour: "numeric", hour12: false, timeZone: "America/New_York"})
    );
    const isAfternoon = etHour >= 12;
    const timeOfDay = isAfternoon ? "afternoon" : "morning";
    const todayStr = today.toISOString().split("T")[0];

    // Get today's calendar events — afternoon run only shows remaining events
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);
    const calendarWindowStart = isAfternoon ? today : todayStart;

    const [unbilledEntries, lastInvoice, calendarEvents, activeTasks, lastSyncDoc, existingTodayAlerts] =
      await Promise.all([
        getUnbilledEntries().catch(() => []),
        getLastInvoice().catch(() => null),
        getCalendarEvents(calendarWindowStart, todayEnd).catch(() => []),
        db.collection("tasks")
          .where("completed", "==", false)
          .orderBy("createdAt", "desc").get()
          .then((s) => s.docs.map((d) => ({id: d.id, ...d.data()} as Record<string, unknown>)))
          .catch(() => [] as Array<Record<string, unknown>>),
        db.collection("metadata").doc("calendarSync").get()
          .catch(() => null),
        // Load alert types already written today to avoid duplicates on 2nd run
        db.collection("alerts")
          .where("briefingDate", "==", todayStr)
          .get()
          .then((s) => new Set(s.docs.map((d) => d.data()["type"] as string)))
          .catch(() => new Set<string>()),
      ]);

    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );

    // Get this week's time entries for status report
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + 1);
    const weekStartStr = weekStart.toISOString().split("T")[0];

    const weekEntries = await getTimeEntriesForRange(
      weekStartStr, todayStr
    ).catch(() => []);
    const weekHours = weekEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );

    // ── Task filtering ──────────────────────────────────────────
    const overdueTasks = activeTasks.filter((t) => {
      const due = t["dueDate"] as string | undefined;
      return due && due < todayStr;
    }).map((t) => ({
      title: t["title"] as string,
      category: t["category"] as string,
      dueDate: t["dueDate"] as string,
    }));

    const dueTodayTasks = activeTasks.filter((t) => {
      const due = t["dueDate"] as string | undefined;
      return due && due === todayStr;
    }).map((t) => ({
      title: t["title"] as string,
      category: t["category"] as string,
      dueDate: t["dueDate"] as string,
    }));

    // ── Calendar sync staleness ─────────────────────────────────
    let calendarSyncAge: number | null = null;
    if (lastSyncDoc && lastSyncDoc.exists) {
      const lastRun = lastSyncDoc.data()?.lastRun?.toDate?.();
      if (lastRun) {
        calendarSyncAge = Math.round(
          (today.getTime() - lastRun.getTime()) / 60000
        );
      }
    }

    // ── Friday lookahead ────────────────────────────────────────
    let nextWeekEvents: Array<{
      summary: string; startTime: string; endTime: string;
      date: string; location: string | null;
    }> = [];
    if (isFriday) {
      const nextMonday = new Date(today);
      nextMonday.setDate(today.getDate() + (8 - today.getDay()));
      nextMonday.setHours(0, 0, 0, 0);
      const nextFridayEnd = new Date(nextMonday);
      nextFridayEnd.setDate(nextMonday.getDate() + 4);
      nextFridayEnd.setHours(23, 59, 59, 999);
      const rawNextWeek = await getCalendarEvents(nextMonday, nextFridayEnd)
        .catch(() => []);
      nextWeekEvents = rawNextWeek.map((e) => ({
        summary: e.summary,
        startTime: formatEventTime(e.startTime),
        endTime: formatEventTime(e.endTime),
        date: e.startTime.toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          timeZone: "America/New_York",
        }),
        location: e.location || null,
      }));
    }

    // ── Alerts ──────────────────────────────────────────────────
    // Helper: only add an alert if that type hasn't already been written today
    const alerts: Array<{type: string; message: string}> = [];
    const addAlert = (type: string, message: string) => {
      if (!existingTodayAlerts.has(type)) {
        alerts.push({type, message});
      }
    };

    // Friday alerts — morning run only (already sent by afternoon)
    if (isFriday && !isAfternoon) {
      addAlert("status-report", `Weekly status report due. This week: ${weekHours.toFixed(1)}h logged.`);
      if (nextWeekEvents.length > 0) {
        const uniqueDays = new Set(nextWeekEvents.map((e) => e.date));
        addAlert("lookahead", `Next week: ${nextWeekEvents.length} meeting${nextWeekEvents.length > 1 ? "s" : ""} across ${uniqueDays.size} day${uniqueDays.size > 1 ? "s" : ""}. `);
      }
    }

    // Early meeting alerts — morning run only
    if (!isAfternoon) {
      const earlyEvents = calendarEvents.filter((e) => {
        const etH = new Date(e.startTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
        return etH.getHours() <= 9;
      });
      for (const e of earlyEvents) {
        // Each early event gets its own type key to avoid suppressing multiple events
        const key = `calendar-early-${e.summary.substring(0, 20)}`;
        if (!existingTodayAlerts.has(key)) {
          alerts.push({
            type: key,
            message: `Early meeting: ${formatEventTime(e.startTime)} — ${e.summary}`,
          });
        }
      }
    }

    if (isFirstWeek) {
      const lastMonth = new Date(today);
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const lastMonthName = lastMonth.toLocaleString("en-US", {month: "long"});
      if (!lastInvoice || new Date(lastInvoice.issueDate) < lastMonth) {
        addAlert("invoice", `${lastMonthName} invoice may be due. Unbilled: ${totalUnbilled.toFixed(1)}h ($${(totalUnbilled * 150).toFixed(0)}).`);
      }
    }

    if (overdueTasks.length > 0) {
      const titles = overdueTasks.slice(0, 3).map((t) => t.title).join(", ");
      addAlert("overdue-tasks", `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}: ${titles}${overdueTasks.length > 3 ? "…" : ""}. `);
    }

    if (calendarSyncAge !== null && calendarSyncAge > 30) {
      addAlert("calendar-stale", "Calendar data may be outdated. Mac sync hasn't run recently.");
    } else if (calendarSyncAge === null) {
      addAlert("calendar-stale", "Calendar sync status unknown. Bridge may not be running.");
    }

    // ── Build briefing ──────────────────────────────────────────
    const briefingData = {
      date: todayStr,
      dayOfWeek: today.toLocaleDateString("en-US", {weekday: "long"}),
      timeOfDay,
      unbilledHours: Math.round(totalUnbilled * 100) / 100,
      unbilledAmount: Math.round(totalUnbilled * 150 * 100) / 100,
      weekHours: Math.round(weekHours * 100) / 100,
      lastInvoiceDate: lastInvoice?.issueDate || null,
      lastInvoiceAmount: lastInvoice?.total || null,
      calendarEvents: calendarEvents.map((e) => ({
        summary: e.summary,
        startTime: formatEventTime(e.startTime),
        endTime: formatEventTime(e.endTime),
        location: e.location || null,
      })),
      overdueTasks,
      dueTodayTasks,
      totalActiveTasks: activeTasks.length,
      nextWeekEvents: isFriday ? nextWeekEvents : [],
      calendarSyncAge,
      alerts,
    };

    // ── AI narrative summary ────────────────────────────────────
    let narrativeSummary: string | null = null;
    try {
      const anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
      const systemMsg = isAfternoon
        ? `You are Maisie, Jack Notarangelo's executive assistant. Write a concise afternoon check-in (3-5 sentences). Be warm but direct. Focus on what's left for the rest of the day — remaining meetings, any overdue tasks still open, and current unbilled hours. Do not repeat things Jack already knows from the morning. All times are Eastern Time. No markdown — plain text only, suitable for text-to-speech.`
        : `You are Maisie, Jack Notarangelo's executive assistant. Write a concise morning briefing (3-5 sentences). Be warm but direct. Contextualize the numbers — mention trends, what to focus on, and any urgent items. If there are overdue tasks or early meetings, highlight them. On Fridays, mention the week ahead. All times are Eastern Time. No markdown — plain text only, suitable for text-to-speech.`;
      const aiResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: systemMsg,
        messages: [{
          role: "user",
          content: JSON.stringify({...briefingData, timeOfDay}),
        }],
      });
      const block = aiResponse.content[0];
      if (block.type === "text") {
        narrativeSummary = block.text;
      }
    } catch (err) {
      console.error("AI narrative generation failed:", err);
    }

    const briefing = {
      ...briefingData,
      narrativeSummary,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const briefingDocId = isAfternoon ? `${todayStr}-afternoon` : todayStr;
    await db.collection("briefings").doc(briefingDocId).set(briefing);

    // Write new alerts to the alerts collection (deduplication was handled above)
    for (const alert of alerts) {
      await db.collection("alerts").add({
        ...alert,
        dismissed: false,
        briefingDate: todayStr,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);

// ─── Scheduled: Invoice Reminder (first 7 days of month, weekdays 9am ET)
export const invoiceReminder = onSchedule(
  {
    schedule: "0 9 1-7 * 1-5",
    timeZone: "America/New_York",
    region: "us-central1",
  },
  async () => {
    const today = new Date();
    const lastMonth = new Date(today);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const lastInvoice = await getLastInvoice().catch(() => null);

    // Check if we already have an invoice for last month
    if (lastInvoice && new Date(lastInvoice.issueDate) >= lastMonth) {
      return; // Invoice already exists for last month
    }

    // Check if we already sent a reminder today
    const todayStr = today.toISOString().split("T")[0];
    const existing = await db.collection("alerts")
      .where("type", "==", "invoice")
      .where("briefingDate", "==", todayStr)
      .limit(1)
      .get();

    if (!existing.empty) return;

    const unbilledEntries = await getUnbilledEntries().catch(() => []);
    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );

    if (totalUnbilled > 0) {
      await db.collection("alerts").add({
        type: "invoice",
        message: `Invoice reminder: ${totalUnbilled.toFixed(1)} unbilled hours ($${(totalUnbilled * 150).toFixed(0)}).`,
        dismissed: false,
        briefingDate: todayStr,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);
