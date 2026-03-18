import * as admin from "firebase-admin";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import twilio from "twilio";
import {getUnbilledEntries, getLastInvoice, getTimeEntriesForRange, getCustomers, getInvoices, Customer} from "./fta-client";
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
  {cors: true, region: "us-central1", memory: "256MiB", timeoutSeconds: 300},
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

    const [unbilledEntries, lastInvoice, todayBriefing, alerts, tasks, recentCompletedTasks, sessionHistory, customCategories, chatCalendarEvents, customers] =
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
        // Load 20 most recently completed tasks so Maisie can reopen them
        db.collection("tasks")
          .where("completed", "==", true)
          .orderBy("completedAt", "desc").limit(20).get()
          .then((s) => s.docs.map((d) => ({id: d.id, ...d.data()})))
          .catch(() =>
            // Fallback: index may not be ready yet — order by createdAt instead
            db.collection("tasks")
              .where("completed", "==", true)
              .orderBy("createdAt", "desc").limit(20).get()
              .then((s) => s.docs.map((d) => ({id: d.id, ...d.data()})))
              .catch(() => [])
          ),
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
        // Active customers from fta-time-tracker (for name/rate lookups in tools)
        getCustomers().catch(() => [] as Customer[]),
      ]);

    const totalUnbilled = unbilledEntries.reduce(
      (sum, e) => sum + e.durationHours, 0
    );
    const unbilledAmount = totalUnbilled * 150;

    // fta-time-tracker stores Firestore doc ID (c.id) as customerId on time entries
    const customerMap = new Map<string, {name: string; rate: number}>(
      customers.map((c) => [c.id, {
        name: c.companyName,
        rate: c.hourlyRate ?? 150,
      }])
    );

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
- For detailed unbilled breakdown (by customer/project/description), use get_unbilled_detail
- For time log questions (what did I work on this week?), use get_time_entries
- For invoice status or which clients need invoicing, use get_invoice_status
- Active tasks: ${tasks.length > 0 ? tasks.map((t: Record<string, unknown>) => {
  const due = t["dueDate"] ? ` (due: ${t["dueDate"]})` : "";
  return `[${t["id"]}][${t["category"]}] ${t["title"]}${due}`;
}).join("; ") : "None"}
- Recently completed tasks (last 20, use reopen_task to restore): ${recentCompletedTasks.length > 0 ? recentCompletedTasks.map((t: Record<string, unknown>) => `[${t["id"]}] ${t["title"]}`).join("; ") : "None"}
- Active alerts: ${alerts.length > 0 ? alerts.map((a: Record<string, unknown>) => `${a["type"]}: ${a["message"]}`).join("; ") : "None"}
- Today's briefing: ${todayBriefing ? JSON.stringify(todayBriefing) : "Not generated yet"}
- Calendar (today & tomorrow): ${chatCalendarEvents.length > 0 ? chatCalendarEvents.map((e) => {
  const day = e.startTime.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York"});
  return `${day} ${formatEventTime(e.startTime)}–${formatEventTime(e.endTime)}: ${e.summary}${e.location ? ` (${e.location})` : ""}`;
}).join("; ") : "No upcoming events"}
- Task categories: ${allCategories.map((c) => `${c.key} (${c.label})`).join(", ")}

Be concise and direct. Never use emojis in any response. Use a warm, professional tone — like a trusted assistant who knows Jack well. Use his first name (Jack) occasionally to keep the conversation natural — not in every message, but enough that it feels personal. When Jack asks you to add or complete a task, use the appropriate tool to actually do it — don't just say you did it. When Jack asks you to create a new task category, use the create_task_category tool. When Jack asks to delete a category, use delete_task_category — it will block deletion if active tasks exist and will tell you which tasks need to be handled first. Use create_calendar_event when Jack asks to schedule something — always confirm title, date, and time before creating. Use move_calendar_event to reschedule existing events. Calendar changes are applied via a local bridge sync and appear within ~1 minute.

When Jack asks to fix a bug, add a feature, or change any code, use the code_with_github tool. The task description must be specific and actionable — name the exact file(s) involved and describe precisely what needs to change and why. Do NOT submit open-ended investigations like "figure out why X is broken"; use your own reasoning to identify the specific change needed first, then submit a targeted task. The coding agent has a fixed time limit, so vague tasks waste it on exploration instead of implementation. Once the agent returns, tell Jack the PR URL and remind him CI/CD will auto-deploy once he approves and merges.
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
        name: "reopen_task",
        description: "Mark a completed task as incomplete/active again. Use the task ID from the recently completed tasks list.",
        input_schema: {
          type: "object" as const,
          properties: {
            taskId: {
              type: "string",
              description: "The Firestore document ID of the completed task to reopen",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "update_task",
        description: "Update an existing task's due date, title, or category. Use the task ID from the active tasks list. Use this when Jack asks to change or set a due date on an existing task.",
        input_schema: {
          type: "object" as const,
          properties: {
            taskId: {
              type: "string",
              description: "The Firestore document ID of the task to update",
            },
            dueDate: {
              type: "string",
              description: "New due date in YYYY-MM-DD format. Omit to leave unchanged. Pass null to clear the due date.",
            },
            title: {
              type: "string",
              description: "New title for the task. Omit to leave unchanged.",
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
      {
        name: "delete_task_category",
        description: "Delete a custom task category. Cannot delete built-in categories (ihrdc, solomon, dial, ppk, church, general). Will fail if there are active tasks under that category — those must be completed or reassigned first.",
        input_schema: {
          type: "object" as const,
          properties: {
            key: {
              type: "string",
              description: "The category key to delete (e.g. 'acme'). Must be a custom category, not a built-in one.",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "get_unbilled_detail",
        description: "Get detailed breakdown of all unbilled time entries, grouped by customer and project, with descriptions and amounts. Use when Jack asks what unbilled work he has, what he owes a client an invoice for, or needs detail beyond the total summary.",
        input_schema: {
          type: "object" as const,
          properties: {
            customer_id: {
              type: "string",
              description: "Optional: filter to a specific customer (e.g. 'ihrdc'). Omit to get all customers.",
            },
          },
          required: [],
        },
      },
      {
        name: "get_time_entries",
        description: "Get time entries for a date range (all statuses: unbilled, billed, paid). Use when Jack asks what he worked on this week/month, needs context on project work, or wants a time log for a period.",
        input_schema: {
          type: "object" as const,
          properties: {
            days_back: {
              type: "number",
              description: "Number of days back from today (default 7). Ignored if start_date is provided.",
            },
            start_date: {
              type: "string",
              description: "Start date in YYYY-MM-DD format.",
            },
            end_date: {
              type: "string",
              description: "End date in YYYY-MM-DD format. Defaults to today if omitted.",
            },
            customer_id: {
              type: "string",
              description: "Optional: filter to a specific customer.",
            },
          },
          required: [],
        },
      },
      {
        name: "get_invoice_status",
        description: "Get recent invoices with status, and show which customers have unbilled hours ready to invoice. Use when Jack asks about outstanding invoices, payment status, or whether a client needs to be invoiced.",
        input_schema: {
          type: "object" as const,
          properties: {
            customer_id: {
              type: "string",
              description: "Optional: filter to a specific customer.",
            },
            status_filter: {
              type: "string",
              enum: ["all", "unpaid", "paid"],
              description: "'unpaid' = sent+overdue, 'paid' = paid only, 'all' = everything. Defaults to 'all'.",
            },
          },
          required: [],
        },
      },
      {
        name: "create_calendar_event",
        description: "Create a new event on Jack's calendar. Always confirm the title, date, and time before calling this tool. Warn Jack that the event will appear within ~1 minute (bridge sync). If the calendar sync is stale (>30 min), warn that the bridge may need to be run.",
        input_schema: {
          type: "object" as const,
          properties: {
            title: {type: "string", description: "Event title/summary"},
            date: {type: "string", description: "Date in YYYY-MM-DD format"},
            start_time: {type: "string", description: "Start time in HH:MM format (24-hour, ET), e.g. '14:00'"},
            end_time: {type: "string", description: "End time in HH:MM format (24-hour, ET), e.g. '15:00'"},
            location: {type: "string", description: "Optional location"},
            notes: {type: "string", description: "Optional notes or description"},
          },
          required: ["title", "date", "start_time", "end_time"],
        },
      },
      {
        name: "move_calendar_event",
        description: "Reschedule an existing calendar event to a new date/time. Always confirm the event title, original date, and new time before calling. Warn Jack that changes will appear within ~1 minute (bridge sync).",
        input_schema: {
          type: "object" as const,
          properties: {
            event_title: {type: "string", description: "Title of the event to move (must match exactly or closely)"},
            original_date: {type: "string", description: "Original date of the event in YYYY-MM-DD format"},
            new_date: {type: "string", description: "New date in YYYY-MM-DD format"},
            new_start_time: {type: "string", description: "New start time in HH:MM format (24-hour, ET)"},
            new_end_time: {type: "string", description: "New end time in HH:MM format (24-hour, ET)"},
          },
          required: ["event_title", "original_date", "new_date", "new_start_time", "new_end_time"],
        },
      },
      {
        name: "code_with_github",
        description: "Delegate ANY coding task — bug fix, feature, refactor, or file change — to a local coding agent running on Jack's machine. Use this whenever Jack asks to fix a bug, add a feature, or change any code. The agent has full repo access, creates a branch, makes the changes, and opens a PR. Returns the PR URL when done.",
        input_schema: {
          type: "object" as const,
          properties: {
            task: {
              type: "string",
              description: "Complete description of what needs to be done. Include: the bug/feature, expected behavior, and all relevant context Jack provided.",
            },
          },
          required: ["task"],
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
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });

      // Helper: human-readable label for each tool call
      const thinkingRef = db.collection("chatThinking").doc(sessionId);
      const toolLabel = (name: string, input: Record<string, unknown>): string => {
        switch (name) {
          case "get_calendar": return "Checking your calendar...";
          case "add_task": return `Adding task: "${input["title"]}"`;
          case "complete_task": return "Marking task complete...";
          case "reopen_task": return "Reopening task...";
          case "update_task": return "Updating task...";
          case "create_task_category": return `Creating category "${input["label"]}"...`;
          case "delete_task_category": return `Deleting category "${input["key"]}"...`;
          case "get_unbilled_detail": return "Fetching unbilled time entries...";
          case "get_time_entries": return "Loading time log...";
          case "get_invoice_status": return "Checking invoice status...";
          case "create_calendar_event": return `Scheduling "${input["title"]}"...`;
          case "move_calendar_event": return `Rescheduling "${input["event_title"]}"...`;
          case "code_with_github": return "Sending task to coding agent...";
          default: return `Running ${name}...`;
        }
      };

      // Tool use loop — execute any tool calls, then get the final text response
      while (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
        );
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          // Broadcast current tool step to Firestore so the frontend can show it
          await thinkingRef.set({
            step: toolLabel(block.name, block.input as Record<string, unknown>),
            tool: block.name,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

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
          } else if (block.name === "reopen_task") {
            const input = block.input as {taskId: string};
            await db.collection("tasks").doc(input.taskId).update({
              completed: false,
              completedAt: admin.firestore.FieldValue.delete(),
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({success: true}),
            });
          } else if (block.name === "update_task") {
            const input = block.input as {taskId: string; dueDate?: string | null; title?: string};
            const updates: Record<string, unknown> = {};
            if (input.title !== undefined) updates["title"] = input.title;
            if (input.dueDate !== undefined) updates["dueDate"] = input.dueDate ?? null;
            await db.collection("tasks").doc(input.taskId).update(updates);
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
          } else if (block.name === "delete_task_category") {
            const input = block.input as {key: string};
            const sanitizedDeleteKey = input.key.toLowerCase().replace(/[^a-z0-9-_]/g, "");
            const defaultKeys = ["ihrdc", "solomon", "dial", "ppk", "church", "general"];
            if (defaultKeys.includes(sanitizedDeleteKey)) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({success: false, error: `"${input.key}" is a built-in category and cannot be deleted.`}),
              });
            } else {
              // Check for active tasks under this category
              const activeTasksSnap = await db.collection("tasks")
                .where("category", "==", sanitizedDeleteKey)
                .where("completed", "==", false)
                .get();
              if (!activeTasksSnap.empty) {
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: JSON.stringify({
                    success: false,
                    error: `Cannot delete category "${sanitizedDeleteKey}" — it has ${activeTasksSnap.size} active task(s). Complete or reassign those tasks first.`,
                    activeTasks: activeTasksSnap.docs.map((d) => ({id: d.id, title: d.data()["title"]})),
                  }),
                });
              } else {
                const catSnap = await db.collection("taskCategories")
                  .where("key", "==", sanitizedDeleteKey).limit(1).get();
                if (catSnap.empty) {
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: JSON.stringify({success: false, error: `Category "${sanitizedDeleteKey}" not found.`}),
                  });
                } else {
                  await catSnap.docs[0].ref.delete();
                  // Update in-memory list and rebuild tools
                  const idx = allCategories.findIndex((c) => c.key === sanitizedDeleteKey);
                  if (idx !== -1) allCategories.splice(idx, 1);
                  tools = buildTools(allCategories);
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: JSON.stringify({success: true, key: sanitizedDeleteKey}),
                  });
                }
              }
            }
          } else if (block.name === "get_unbilled_detail") {
            const input = block.input as {customer_id?: string};
            const entries = await getUnbilledEntries(input.customer_id).catch(() => []);

            // Group by customerId → projectId
            const grouped: Record<string, {
              customerName: string;
              projects: Record<string, {hours: number; amount: number; entries: Array<{date: string; hours: number; description: string}>}>;
              totalHours: number;
              totalAmount: number;
            }> = {};

            for (const entry of entries) {
              const custInfo = customerMap.get(entry.customerId);
              if (!grouped[entry.customerId]) {
                grouped[entry.customerId] = {
                  customerName: custInfo?.name || entry.customerId,
                  projects: {},
                  totalHours: 0,
                  totalAmount: 0,
                };
              }
              const cust = grouped[entry.customerId];
              const rate = custInfo?.rate ?? 150;
              if (!cust.projects[entry.projectId]) {
                cust.projects[entry.projectId] = {hours: 0, amount: 0, entries: []};
              }
              cust.projects[entry.projectId].hours += entry.durationHours;
              cust.projects[entry.projectId].amount += entry.durationHours * rate;
              cust.projects[entry.projectId].entries.push({
                date: entry.date,
                hours: entry.durationHours,
                description: entry.description || "(no description)",
              });
              cust.totalHours += entry.durationHours;
              cust.totalAmount += entry.durationHours * rate;
            }

            const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                totalUnbilledHours: totalHours,
                totalUnbilledAmount: totalHours * 150,
                entryCount: entries.length,
                customers: grouped,
              }),
            });
          } else if (block.name === "get_time_entries") {
            const input = block.input as {
              days_back?: number;
              start_date?: string;
              end_date?: string;
              customer_id?: string;
            };

            const todayStr = new Date().toISOString().split("T")[0];
            let startDate: string;
            let endDate: string;

            if (input.start_date) {
              startDate = input.start_date;
              endDate = input.end_date || todayStr;
            } else {
              const daysBack = input.days_back ?? 7;
              const start = new Date();
              start.setDate(start.getDate() - daysBack);
              startDate = start.toISOString().split("T")[0];
              endDate = todayStr;
            }

            const entries = await getTimeEntriesForRange(startDate, endDate, input.customer_id).catch(() => []);

            const grouped: Record<string, {
              customerName: string;
              projects: Record<string, {hours: number; entries: Array<{date: string; hours: number; description: string; status: string}>}>;
              totalHours: number;
            }> = {};

            for (const entry of entries) {
              const custInfo = customerMap.get(entry.customerId);
              if (!grouped[entry.customerId]) {
                grouped[entry.customerId] = {
                  customerName: custInfo?.name || entry.customerId,
                  projects: {},
                  totalHours: 0,
                };
              }
              const cust = grouped[entry.customerId];
              if (!cust.projects[entry.projectId]) {
                cust.projects[entry.projectId] = {hours: 0, entries: []};
              }
              cust.projects[entry.projectId].hours += entry.durationHours;
              cust.projects[entry.projectId].entries.push({
                date: entry.date,
                hours: entry.durationHours,
                description: entry.description || "(no description)",
                status: entry.status,
              });
              cust.totalHours += entry.durationHours;
            }

            const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                dateRange: {startDate, endDate},
                totalHours,
                entryCount: entries.length,
                customers: grouped,
              }),
            });
          } else if (block.name === "get_invoice_status") {
            const input = block.input as {customer_id?: string; status_filter?: "all" | "unpaid" | "paid"};
            const statusFilter = input.status_filter || "all";
            const invoiceStatusOpt = statusFilter === "all" ? undefined :
              statusFilter === "paid" ? "paid" as const : "unpaid" as const;

            const [invoices, unbilledForStatus] = await Promise.all([
              getInvoices({customerId: input.customer_id, status: invoiceStatusOpt, limit: 20}).catch(() => []),
              statusFilter !== "paid"
                ? getUnbilledEntries(input.customer_id).catch(() => [])
                : Promise.resolve([]),
            ]);

            // Build "ready to invoice" summary per customer
            const readyToInvoice: Record<string, {customerName: string; hours: number; amount: number}> = {};
            for (const entry of unbilledForStatus) {
              const custInfo = customerMap.get(entry.customerId);
              if (!readyToInvoice[entry.customerId]) {
                readyToInvoice[entry.customerId] = {
                  customerName: custInfo?.name || entry.customerId,
                  hours: 0,
                  amount: 0,
                };
              }
              const rate = custInfo?.rate ?? 150;
              readyToInvoice[entry.customerId].hours += entry.durationHours;
              readyToInvoice[entry.customerId].amount += entry.durationHours * rate;
            }

            const formattedInvoices = invoices.map((inv) => ({
              invoiceNumber: inv.invoiceNumber,
              customer: inv.customerName || customerMap.get(inv.customerId)?.name || inv.customerId,
              issueDate: inv.issueDate,
              dueDate: inv.dueDate,
              total: inv.total,
              status: inv.status,
            }));

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                invoices: formattedInvoices,
                invoiceCount: invoices.length,
                readyToInvoice: Object.keys(readyToInvoice).length > 0 ? readyToInvoice : null,
              }),
            });
          } else if (block.name === "create_calendar_event") {
            const input = block.input as {
              title: string;
              date: string;
              start_time: string;
              end_time: string;
              location?: string;
              notes?: string;
            };
            const actionRef = await db.collection("pendingCalendarActions").add({
              action: "create",
              status: "pending",
              payload: {
                title: input.title,
                date: input.date,
                startTime: input.start_time,
                endTime: input.end_time,
                location: input.location || null,
                notes: input.notes || null,
              },
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              appliedAt: null,
              error: null,
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                success: true,
                actionId: actionRef.id,
                message: `Calendar event "${input.title}" on ${input.date} at ${input.start_time}–${input.end_time} has been queued. It will appear on the calendar within ~1 minute once the bridge syncs.`,
              }),
            });
          } else if (block.name === "move_calendar_event") {
            const input = block.input as {
              event_title: string;
              original_date: string;
              new_date: string;
              new_start_time: string;
              new_end_time: string;
            };
            const actionRef = await db.collection("pendingCalendarActions").add({
              action: "move",
              status: "pending",
              payload: {
                eventTitle: input.event_title,
                originalDate: input.original_date,
                newDate: input.new_date,
                newStartTime: input.new_start_time,
                newEndTime: input.new_end_time,
              },
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              appliedAt: null,
              error: null,
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                success: true,
                actionId: actionRef.id,
                message: `"${input.event_title}" has been queued to move from ${input.original_date} to ${input.new_date} at ${input.new_start_time}–${input.new_end_time}. The change will appear within ~1 minute once the bridge syncs.`,
              }),
            });
          } else if (block.name === "code_with_github") {
            const input = block.input as {task: string};

            // Write task to Firestore queue for the local coding bridge to pick up
            const taskRef = await db.collection("pendingCodingTasks").add({
              task: input.task,
              status: "pending",
              sessionId,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              completedAt: null,
              result: null,
              error: null,
            });

            // Poll for result — bridge picks it up within ~30s and runs Claude Code locally
            const POLL_INTERVAL_MS = 3000;
            const TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes (bridge runs up to 10 min)
            const pollStart = Date.now();
            let codingResult: {success: boolean; pr_url?: string; pr_number?: number; summary?: string; error?: string} | null = null;

            while (Date.now() - pollStart < TIMEOUT_MS) {
              await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
              const snap = await db.collection("pendingCodingTasks").doc(taskRef.id).get();
              const data = snap.data();
              if (data?.["status"] === "completed" || data?.["status"] === "failed") {
                codingResult = data?.["result"] ?? {success: false, error: data?.["error"] ?? "Unknown error"};
                break;
              }
              const elapsed = Math.round((Date.now() - pollStart) / 1000);
              await thinkingRef.set({
                step: `Coding agent working... (${elapsed}s)`,
                tool: "code_with_github",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }

            if (!codingResult) {
              codingResult = {success: false, error: "Coding agent timed out after 5 minutes."};
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(codingResult),
            });
          }
        }

        messages.push({role: "assistant", content: response.content});
        messages.push({role: "user", content: toolResults});

        response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        });
      }

      // Clear thinking indicator now that we have a final response
      await thinkingRef.delete().catch(() => {/* ignore if doesn't exist */});

      const rawText = response.content
        .filter((b) => b.type === "text")
        .map((b) => {
          if (b.type === "text") return b.text;
          return "";
        })
        .join("");

      // Strip all emoji characters regardless of system prompt compliance
      const text = rawText.replace(
        /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu,
        ""
      ).replace(/\s{2,}/g, " ").trim();

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
      // Clear thinking indicator on error too
      if (sessionId) {
        await db.collection("chatThinking").doc(sessionId).delete().catch(() => {});
      }
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

    let entries: Awaited<ReturnType<typeof getUnbilledEntries>> = [];
    let lastInvoice: Awaited<ReturnType<typeof getLastInvoice>> = null;

    try {
      entries = await getUnbilledEntries();
    } catch (err) {
      console.error("[getUnbilledSummary] getUnbilledEntries failed:", err);
    }
    try {
      lastInvoice = await getLastInvoice();
    } catch (err) {
      console.error("[getUnbilledSummary] getLastInvoice failed:", err);
    }

    // Load customers for name lookup
    let customers: Awaited<ReturnType<typeof getCustomers>> = [];
    try {
      customers = await getCustomers();
    } catch (err) {
      console.error("[getUnbilledSummary] getCustomers failed:", err);
    }
    // fta-time-tracker stores Firestore doc ID (c.id) as customerId on time entries
    const custNameMap = new Map(customers.map((c) => [c.id, c.companyName]));

    const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
    const entryItems = entries.map((e) => ({
      customerId: e.customerId,
      customerName: custNameMap.get(e.customerId) || e.customerId,
      projectId: e.projectId,
      date: e.date,
      hours: e.durationHours,
      description: e.description || "",
      status: e.status,
    }));

    res.json({
      totalHours: Math.round(totalHours * 100) / 100,
      totalAmount: Math.round(totalHours * 150 * 100) / 100,
      entryCount: entries.length,
      lastInvoice: lastInvoice
        ? {issueDate: lastInvoice.issueDate, total: lastInvoice.total}
        : null,
      entries: entryItems,
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
    const todayDayOfWeek = today.getDay();   // 0 (Sun) – 6 (Sat)
    const todayDayOfMonth = today.getDate(); // 1 – 31

    const overdueTasks = activeTasks.filter((t) => {
      const due = t["dueDate"] as string | undefined;
      return due && due < todayStr;
    }).map((t) => ({
      title: t["title"] as string,
      category: t["category"] as string,
      dueDate: t["dueDate"] as string,
    }));

    // Explicit due-date tasks due today
    const explicitDueTodayIds = new Set(
      activeTasks
        .filter((t) => (t["dueDate"] as string | undefined) === todayStr)
        .map((t) => t["id"] as string)
    );

    const explicitDueTodayTasks = activeTasks
      .filter((t) => explicitDueTodayIds.has(t["id"] as string))
      .map((t) => ({
        title: t["title"] as string,
        category: t["category"] as string,
        dueDate: t["dueDate"] as string,
      }));

    // Recurring tasks whose rule fires today (not already counted above)
    const recurringDueTodayTasks = activeTasks
      .filter((t) => {
        if (explicitDueTodayIds.has(t["id"] as string)) return false; // already included
        const rec = t["recurrence"] as { type: string; dayOfWeek?: number; dayOfMonth?: number } | null | undefined;
        if (!rec) return false;
        if (rec.type === "daily") return true;
        if (rec.type === "weekly") return rec.dayOfWeek === todayDayOfWeek;
        if (rec.type === "monthly") return rec.dayOfMonth === todayDayOfMonth;
        return false;
      })
      .map((t) => ({
        title: t["title"] as string,
        category: t["category"] as string,
        dueDate: todayStr,
      }));

    const dueTodayTasks = [...explicitDueTodayTasks, ...recurringDueTodayTasks];

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

// ─── SMS: Receive inbound texts and act on them ─────────────────
// Twilio sends form-encoded POST to this endpoint when Jack texts
// the Twilio number. Claude Haiku parses the natural language command
// into a structured action, executes it, and replies via TwiML.
export const receiveSms = onRequest(
  {region: "us-central1", memory: "256MiB", timeoutSeconds: 60},
  async (req, res) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const jackPhone = process.env.JACK_PHONE_NUMBER;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    if (!accountSid || !authToken || !jackPhone || !anthropicApiKey) {
      console.error("[receiveSms] Missing required environment variables");
      res.status(500).send("Server misconfigured");
      return;
    }

    // ── 1. Validate Twilio signature ───────────────────────────
    // Temporarily logging URL for debugging — signature check bypassed
    const signature = req.headers["x-twilio-signature"] as string;
    const webhookUrl = `https://${req.headers.host}${req.originalUrl}`;
    console.log(`[receiveSms] hit. URL: ${webhookUrl}, sig present: ${!!signature}, from: ${req.body?.From}`);
    // TODO: re-enable signature validation once confirmed working
    // const isValid = twilio.validateRequest(authToken, signature, webhookUrl, req.body as Record<string, string>);
    // if (!isValid) {
    //   console.warn(`[receiveSms] Invalid Twilio signature. URL used: ${webhookUrl}`);
    //   res.status(403).send("Forbidden");
    //   return;
    // }

    // ── 2. Only accept messages from Jack's phone ──────────────
    const fromNumber = req.body.From as string;
    const messageBody = (req.body.Body as string || "").trim();

    if (fromNumber !== jackPhone) {
      console.warn(`[receiveSms] Rejected message from unknown number: ${fromNumber}`);
      res.type("text/xml").send("<Response></Response>");
      return;
    }

    if (!messageBody) {
      res.type("text/xml").send("<Response><Message>I didn't catch that. Try: \"add task X\" or \"what are my tasks?\"</Message></Response>");
      return;
    }

    // ── 3. Load active tasks for context (needed for complete/list) ─
    console.log("[receiveSms] loading active tasks");
    const activeTasks = await db.collection("tasks")
      .where("completed", "==", false)
      .get()
      .then((s) => s.docs.map((d) => ({id: d.id, ...d.data()} as Record<string, unknown>)))
      .catch((err) => {
        console.error("[receiveSms] Firestore tasks load failed:", err);
        return [] as Array<Record<string, unknown>>;
      });
    console.log(`[receiveSms] loaded ${activeTasks.length} tasks`);

    const taskListStr = activeTasks.length > 0
      ? activeTasks.map((t) => {
        const due = t["dueDate"] ? ` (due: ${t["dueDate"]})` : "";
        return `[${t["id"]}][${t["category"]}] ${t["title"]}${due}`;
      }).join("\n")
      : "No active tasks";

    // ── 4. Parse intent with Claude Haiku ──────────────────────
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York",
    });
    const todayIso = new Date().toLocaleDateString("en-CA", {timeZone: "America/New_York"}); // YYYY-MM-DD

    const systemPrompt = `You are a task parser for Maisie, Jack Notarangelo's personal assistant. Parse the SMS message into a JSON action.
Respond ONLY with valid JSON — no markdown, no explanation, no extra text.

Available actions:
- add_task: {"action":"add_task","title":"string","category":"string","dueDate":"YYYY-MM-DD or null"}
- complete_task: {"action":"complete_task","taskId":"string"}
- list_tasks: {"action":"list_tasks"}
- unknown: {"action":"unknown","clarification":"string"}

Rules:
- Default category is "general". Other categories: ihrdc, solomon, dial, ppk, church.
- For complete_task, match the taskId from the active task list by fuzzy-matching the title. If ambiguous, use action "unknown".
- For due dates, convert relative terms to absolute YYYY-MM-DD using today's date.
- If the message is a list request ("tasks", "what's on my list", "show tasks"), use list_tasks.
- If you cannot confidently parse the intent, use unknown with a helpful clarification.

Today is ${today} (${todayIso}).

Active tasks:
${taskListStr}`;

    let parsed: {
      action: string;
      title?: string;
      category?: string;
      dueDate?: string | null;
      taskId?: string;
      clarification?: string;
    };

    try {
      const anthropic = new Anthropic({apiKey: anthropicApiKey});
      const aiResponse = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: systemPrompt,
        messages: [{role: "user", content: messageBody}],
      });

      const rawJson = aiResponse.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");

      parsed = JSON.parse(rawJson);
    } catch (err) {
      console.error("[receiveSms] Claude parse error:", err);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("Sorry, I had trouble understanding that. Try: \"add task X\" or \"what are my tasks?\"");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // ── 5. Execute the action ──────────────────────────────────
    let replyText: string;
    const twiml = new twilio.twiml.MessagingResponse();

    try {
      if (parsed.action === "add_task") {
        const title = parsed.title || messageBody;
        const category = parsed.category || "general";
        const dueDate = parsed.dueDate || null;
        const docRef = await db.collection("tasks").add({
          title,
          category,
          completed: false,
          dueDate,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const duePart = dueDate ? ` (due ${dueDate})` : "";
        replyText = `Task added: ${title}${duePart} [${category}]\nID: ${docRef.id.substring(0, 8)}`;
      } else if (parsed.action === "complete_task") {
        if (!parsed.taskId) {
          replyText = "Could not find a matching task to complete. Try: \"complete task <exact title>\"";
        } else {
          await db.collection("tasks").doc(parsed.taskId).update({
            completed: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          const completedTask = activeTasks.find((t) => t["id"] === parsed.taskId);
          const completedTitle = completedTask ? (completedTask["title"] as string) : parsed.taskId;
          replyText = `Done: ${completedTitle}`;
        }
      } else if (parsed.action === "list_tasks") {
        if (activeTasks.length === 0) {
          replyText = "No active tasks.";
        } else {
          const lines = activeTasks.slice(0, 10).map((t) => {
            const due = t["dueDate"] ? ` — due ${t["dueDate"]}` : "";
            return `• [${t["category"]}] ${t["title"]}${due}`;
          });
          const more = activeTasks.length > 10 ? `\n...and ${activeTasks.length - 10} more` : "";
          replyText = `${activeTasks.length} active tasks:\n${lines.join("\n")}${more}`;
        }
      } else {
        // unknown
        replyText = parsed.clarification || "I didn't understand that. Try: \"add task X\", \"complete task Y\", or \"what are my tasks?\"";
      }
    } catch (err) {
      console.error("[receiveSms] Action execution error:", err);
      replyText = "Something went wrong. Please try again or check the app.";
    }

    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());
  }
);
