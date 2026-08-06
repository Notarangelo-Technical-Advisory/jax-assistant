import * as admin from "firebase-admin";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import twilio from "twilio";
import {getUnbilledEntries, getLastInvoice, getTimeEntriesForRange, getCustomers} from "./fta-client";
import Anthropic from "@anthropic-ai/sdk";
import {buildTools, WEB_TOOLS} from "./tools/definitions";
import {executeTool, toolLabel} from "./tools/execute";
import {loadMaisieContext, MAISIE_PERSONA, buildStateBlock, historyToMessages} from "./tools/context";
import {readCalendarEvents, formatEventTime} from "./tools/calendar-read";

admin.initializeApp();
const db = admin.firestore();

/**
 * The model behind every MAISIE call — chat, briefing, and SMS.
 * Kept in one place so the next migration is a one-line change.
 */
const MODEL = "claude-sonnet-5";

// Startup environment check — logs presence without exposing values
console.log(`[startup] GOOGLE_MAPS_API_KEY: ${process.env.GOOGLE_MAPS_API_KEY ? "present" : "MISSING"}`);

// ─── Eastern Time day math ─────────────────────────────────────
//
// The Cloud Functions runtime sets no TZ, so it is UTC. Every "what day is it"
// question in a briefing is really "what day is it in Norwell", and the two
// disagree from 8 PM ET onward (7 PM in winter): getDate/getDay/setHours and
// toISOString all roll into tomorrow four hours early. That is what stamped the
// 8 PM refresh with the next day's date, called a task due today overdue, and
// pointed "today's" calendar window at [8 PM yesterday → 8 PM today].
//
// Everything below derives the day from the ET wall clock instead. Prefer these
// over the Date accessors anywhere a calendar day or a due date is at stake.
const ET_ZONE = "America/New_York";

/** YYYY-MM-DD as it reads on a clock in Norwell. */
function etDateKey(d: Date): string {
  return d.toLocaleDateString("en-CA", {timeZone: ET_ZONE});
}

/** ET's UTC offset at a given instant, as "-04:00" / "-05:00". */
function etOffsetAt(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE, timeZoneName: "longOffset",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value
    ?.replace("GMT", "") || "+00:00";
}

/**
 * The instant ET midnight begins on `d`'s ET date.
 *
 * Read off the zone's own offset rather than assuming -05:00 or -04:00 — and
 * read twice, because on a DST-change day the offset at `d` is not the offset
 * that was in force at midnight. Resolving once from a 10 PM instant on
 * spring-forward Sunday lands on 11 PM the previous day; the second pass, using
 * the first guess, corrects it.
 */
function etDayStart(d: Date): Date {
  const key = etDateKey(d);
  const guess = new Date(`${key}T00:00:00${etOffsetAt(d)}`);
  return new Date(`${key}T00:00:00${etOffsetAt(guess)}`);
}

/**
 * The instant the *next* ET day begins.
 *
 * Snapping forward from midnight + 26h rather than adding 24h: a spring-forward
 * ET day is 23 hours long and a fall-back day is 25, and 26 lands inside the
 * following day either way.
 */
function etNextDayStart(d: Date): Date {
  return etDayStart(new Date(etDayStart(d).getTime() + 26 * 60 * 60 * 1000));
}

/** Day of week (0 = Sunday) and day of month, on the ET calendar. */
function etDayParts(d: Date): {dayOfWeek: number; dayOfMonth: number} {
  const key = etDateKey(d);
  // Noon UTC on the ET date — far enough from either midnight that no offset
  // can shift which date this lands on.
  const noon = new Date(`${key}T12:00:00Z`);
  return {dayOfWeek: noon.getUTCDay(), dayOfMonth: Number(key.slice(8, 10))};
}

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

/**
 * Turn text into MP3 bytes via ElevenLabs.
 *
 * Extracted from the synthesizeSpeech handler so the spoken-alert path can
 * reuse it. That path cannot call the HTTP endpoint: it requires a Firebase ID
 * token and the only caller would be a Cloud Function, not a signed-in user.
 *
 * Returns null rather than throwing — an alert that cannot be synthesized should
 * degrade to the system voice on the Mac, not fail the whole trigger.
 */
async function synthesizeToBuffer(
  text: string,
  voice = "female-british"
): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[synthesize] ELEVENLABS_API_KEY not configured");
    return null;
  }
  const voiceId = ELEVENLABS_VOICE_ID[voice] || ELEVENLABS_VOICE_ID["female-british"];
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
      console.error(`[synthesize] ElevenLabs ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error("[synthesize] failed:", err);
    return null;
  }
}

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

    // Gather context from Firestore and the NTA time tracker
    const maisieCtx = await loadMaisieContext(db, sessionId);
    const allCategories = maisieCtx.categories;

    // Two system blocks with the breakpoint on the first. Render order is
    // tools -> system -> messages, so this caches the tool schemas and the
    // persona together (~3.5k tokens measured) while leaving the volatile state
    // block after the boundary, where it costs nothing to change every request.
    const systemPrompt: Anthropic.Messages.TextBlockParam[] = [
      {type: "text", text: MAISIE_PERSONA, cache_control: {type: "ephemeral"}},
      {type: "text", text: buildStateBlock(maisieCtx)},
    ];

    // Custom tools first, then Anthropic's server-side web tools. WEB_TOOLS is a
    // constant and always appended last, so the rendered tool prefix stays
    // byte-identical across the requests in the loop below.
    let tools: Anthropic.Messages.ToolUnion[] = [
      ...buildTools(allCategories),
      ...WEB_TOOLS,
    ];

    try {
      const anthropic = new Anthropic({apiKey});

      // Build messages: prior session history + current user message
      const messages: Anthropic.Messages.MessageParam[] = [
        ...historyToMessages(maisieCtx.sessionHistory),
        {role: "user", content: message},
      ];

      // Both requests in this function must be byte-identical up to the cache
      // breakpoint, so they are built from one place. Reads `tools` and
      // `messages` at call time — tools is rebuilt when a category changes and
      // messages is pushed to in the loop below.
      const buildRequest = (): Anthropic.Messages.MessageCreateParamsNonStreaming => ({
        model: MODEL,
        max_tokens: 8192,
        thinking: {type: "adaptive"},
        output_config: {effort: "high"},
        system: systemPrompt,
        tools,
        messages,
      });

      let response = await anthropic.messages.create(buildRequest());

      const thinkingRef = db.collection("chatThinking").doc(sessionId);
      // Broadcast the current tool step to Firestore so the frontend can show it
      const writeStep = async (step: string, tool: string): Promise<void> => {
        await thinkingRef.set({
          step,
          tool,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      };

      // Server-side tools (web_search / web_fetch) run inside a single API
      // request, capped at ~10 internal iterations. Hitting that cap ends the
      // turn with "pause_turn" rather than "tool_use", so the loop has to treat
      // it as a continuation — otherwise a long research answer falls straight
      // through to the text extraction below and Jack gets a truncated reply
      // with nothing logged. Resuming needs no extra user message: the trailing
      // server_tool_use block tells the API where to pick up.
      let continuations = 0;
      const MAX_CONTINUATIONS = 5;

      // Tool use loop — execute any tool calls, then get the final text response
      while (
        response.stop_reason === "tool_use" ||
        response.stop_reason === "pause_turn"
      ) {
        if (response.stop_reason === "pause_turn") {
          if (++continuations > MAX_CONTINUATIONS) {
            console.warn(
              `[chat] hit continuation cap (${MAX_CONTINUATIONS}) — returning partial answer`
            );
            break;
          }
          await writeStep("Still researching...", "web_search");
          messages.push({role: "assistant", content: response.content});
          response = await anthropic.messages.create(buildRequest());
          continue;
        }

        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
        );
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          const input = block.input as Record<string, unknown>;
          await writeStep(toolLabel(block.name, input), block.name);

          const result = await executeTool(block.name, input, {
            db,
            customerMap: maisieCtx.customerMap,
            categories: allCategories,
            onStep: writeStep,
            // add_task's category enum is derived from allCategories, so the
            // schemas must be rebuilt when a category is added or removed
            // partway through the loop.
            onCategoriesChanged: () => {
              tools = [...buildTools(allCategories), ...WEB_TOOLS];
            },
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({role: "assistant", content: response.content});
        messages.push({role: "user", content: toolResults});

        response = await anthropic.messages.create(buildRequest());
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

      // Strip all emoji characters regardless of system prompt compliance.
      // Whitespace cleanup is deliberately horizontal-only: the old /\s{2,}/
      // collapsed newlines too, which was invisible on "task added" replies but
      // flattened any multi-paragraph answer into one unreadable run.
      const text = rawText.replace(
        /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu,
        ""
      )
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ +$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

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
// Thin wrapper so the many call sites below keep their existing signature.
// The implementation lives in tools/calendar-read so the MCP server can share it.
async function getCalendarEvents(
  startOfDay: Date, endOfDay: Date
): Promise<Array<{summary: string; startTime: Date; endTime: Date; location?: string; allDay?: boolean}>> {
  return readCalendarEvents(db, startOfDay, endOfDay);
}

// ─── Briefing: state, narration, and persistence ───────────────
//
// runBriefing used to be one 290-line function that gathered data, called the
// model, and wrote Firestore. It only ever ran on the 7am/1pm cron, so the
// briefing was frozen between beats and stale within the hour.
//
// It is now three pieces so a calendar change can refresh the *facts* without
// paying for the model, and re-narrate only when something actually warrants it:
//
//   computeBriefingState  — pure data gathering + alert rules, no model call
//   generateNarrative     — the single Anthropic call
//   writeBriefing         — persistence (briefings/live, archive, alerts)
//
// The split is also what makes a genuinely agentic briefing a contained change
// later: generateNarrative is the only seam that would become a tool loop.

/** The billing figures, which move on the order of hours rather than minutes. */
interface BillingSlice {
  unbilledHours: number;
  unbilledAmount: number;
  weekHours: number;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
}

/**
 * Gather everything the briefing reports on. No model call, no writes — so it
 * is cheap enough to run on every calendar change.
 *
 * `reuseBilling` skips the three cross-project reads into fta-invoice-tracking
 * when a recent result is already on hand. Unbilled hours do not move because a
 * meeting shifted, and those reads are the expensive part of this function.
 */
async function computeBriefingState(
  reuseBilling?: BillingSlice | null
): Promise<Record<string, unknown> & {alerts: Array<{type: string; message: string}>}> {
    const today = new Date();
    const {dayOfWeek, dayOfMonth} = etDayParts(today);
    const isFriday = dayOfWeek === 5;
    const isFirstWeek = dayOfMonth >= 5 && dayOfMonth <= 7;
    const etHour = parseInt(
      today.toLocaleString("en-US", {hour: "numeric", hour12: false, timeZone: "America/New_York"})
    );
    const isAfternoon = etHour >= 12;
    const timeOfDay = isAfternoon ? "afternoon" : "morning";
    const todayStr = etDateKey(today);

    // Get today's calendar events — afternoon run only shows remaining events
    const todayStart = etDayStart(today);
    const todayEnd = new Date(etNextDayStart(today).getTime() - 1);
    const calendarWindowStart = isAfternoon ? today : todayStart;

    const [unbilledEntries, lastInvoice, calendarEvents, activeTasks, lastSyncDoc, existingTodayAlerts] =
      await Promise.all([
        reuseBilling ? Promise.resolve(null) : getUnbilledEntries().catch(() => []),
        reuseBilling ? Promise.resolve(null) : getLastInvoice().catch(() => null),
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

    // Get this week's time entries for status report. Stepped off ET midday so
    // a DST change cannot push the subtraction onto the wrong date.
    const weekStartStr = etDateKey(new Date(
      etDayStart(today).getTime() +
      12 * 60 * 60 * 1000 -
      (dayOfWeek - 1) * 24 * 60 * 60 * 1000
    ));

    let totalUnbilled: number;
    let weekHours: number;
    let lastInvoiceDate: string | null;
    let lastInvoiceAmount: number | null;

    if (reuseBilling) {
      totalUnbilled = reuseBilling.unbilledHours;
      weekHours = reuseBilling.weekHours;
      lastInvoiceDate = reuseBilling.lastInvoiceDate;
      lastInvoiceAmount = reuseBilling.lastInvoiceAmount;
    } else {
      totalUnbilled = (unbilledEntries ?? []).reduce(
        (sum, e) => sum + e.durationHours, 0
      );
      const weekEntries = await getTimeEntriesForRange(
        weekStartStr, todayStr
      ).catch(() => []);
      weekHours = weekEntries.reduce(
        (sum, e) => sum + e.durationHours, 0
      );
      lastInvoiceDate = lastInvoice?.issueDate || null;
      lastInvoiceAmount = lastInvoice?.total || null;
    }

    // ── Task filtering ──────────────────────────────────────────
    const todayDayOfWeek = dayOfWeek;   // 0 (Sun) – 6 (Sat), ET
    const todayDayOfMonth = dayOfMonth; // 1 – 31, ET

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
      summary: string; startTime: string; endTime: string; allDay: boolean;
      date: string; location: string | null;
    }> = [];
    if (isFriday) {
      const day = 24 * 60 * 60 * 1000;
      const nextMonday = etDayStart(
        new Date(etDayStart(today).getTime() + 12 * 60 * 60 * 1000 + (8 - dayOfWeek) * day)
      );
      const nextFridayEnd = new Date(
        etNextDayStart(new Date(nextMonday.getTime() + 12 * 60 * 60 * 1000 + 4 * day)).getTime() - 1
      );
      const rawNextWeek = await getCalendarEvents(nextMonday, nextFridayEnd)
        .catch(() => []);
      nextWeekEvents = rawNextWeek.map((e) => ({
        summary: e.summary,
        startTime: formatEventTime(e.startTime),
        endTime: formatEventTime(e.endTime),
        allDay: e.allDay ?? false,
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
        // An all-day event starts at local midnight, which is not an early
        // meeting — it is not a meeting at all. Without this every holiday and
        // every travel day would alert as a 12:00 AM appointment.
        if (e.allDay) return false;
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
      if (!lastInvoiceDate || new Date(lastInvoiceDate) < lastMonth) {
        addAlert("invoice", `${lastMonthName} invoice may be due. Unbilled: ${totalUnbilled.toFixed(1)}h ($${(totalUnbilled * 150).toFixed(0)}).`);
      }
    }

    if (overdueTasks.length > 0) {
      const taskSummaries = overdueTasks.slice(0, 3).map((t) => `${t.title} (${t.category})`).join(", ");
      addAlert("overdue-tasks", `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}: ${taskSummaries}${overdueTasks.length > 3 ? "…" : ""}.`);
    }

    if (calendarSyncAge !== null && calendarSyncAge > 30) {
      addAlert("calendar-stale", "Calendar data may be outdated. Mac sync hasn't run recently.");
    } else if (calendarSyncAge === null) {
      addAlert("calendar-stale", "Calendar sync status unknown. Bridge may not be running.");
    }

    // ── Build briefing ──────────────────────────────────────────
    const briefingData = {
      date: todayStr,
      dayOfWeek: today.toLocaleDateString("en-US", {weekday: "long", timeZone: ET_ZONE}),
      timeOfDay,
      unbilledHours: Math.round(totalUnbilled * 100) / 100,
      unbilledAmount: Math.round(totalUnbilled * 150 * 100) / 100,
      weekHours: Math.round(weekHours * 100) / 100,
      lastInvoiceDate,
      lastInvoiceAmount,
      calendarEvents: calendarEvents.map((e) => ({
        summary: e.summary,
        startTime: formatEventTime(e.startTime),
        endTime: formatEventTime(e.endTime),
        allDay: e.allDay ?? false,
        location: e.location || null,
      })),
      overdueTasks,
      dueTodayTasks,
      totalActiveTasks: activeTasks.length,
      nextWeekEvents: isFriday ? nextWeekEvents : [],
      calendarSyncAge,
      calendarSyncAgeLabel: calendarSyncAge === null
        ? "unknown"
        : calendarSyncAge < 60
          ? `${calendarSyncAge} minutes`
          : calendarSyncAge < 1440
            ? `${Math.round(calendarSyncAge / 60)} hours`
            : `${Math.round(calendarSyncAge / 1440)} days`,
      alerts,
    };

    return briefingData;
}

/**
 * The one model call in the briefing path.
 *
 * `changeSummary` is what a scheduled run does not have: when a reschedule is
 * what prompted this narration, saying so is the whole point — otherwise the
 * prose silently reflects the new reality and Jack cannot tell what moved.
 */
async function generateNarrative(
  briefingData: Record<string, unknown>,
  changeSummary?: Record<string, unknown> | null
): Promise<string | null> {
    const isAfternoon = briefingData["timeOfDay"] === "afternoon";
    let narrativeSummary: string | null = null;
    try {
      const anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
      const systemMsg = isAfternoon
        ? `You are Maisie, Jack Notarangelo's executive assistant. Write a concise afternoon check-in (3-5 sentences). Be warm but direct — dry wit is welcome if it fits naturally. Focus on what's left for the rest of the day — remaining meetings, any overdue tasks still open, and current unbilled hours. Do not repeat things Jack already knows from the morning. All times are Eastern Time. No markdown — plain text only, suitable for text-to-speech. Jack publishes invoices at the beginning of each month — unbilled hours are normal and expected throughout the month, so do not mention them unless Jack specifically asks or an invoice alert is present.`
        : `You are Maisie, Jack Notarangelo's executive assistant. Write a concise morning briefing (3-5 sentences). Be warm but direct — dry wit is welcome if it fits naturally. Contextualize the numbers — mention trends, what to focus on, and any urgent items. If there are overdue tasks or early meetings, highlight them. On Fridays, mention the week ahead. All times are Eastern Time. No markdown — plain text only, suitable for text-to-speech. The calendarSyncAge field is in minutes; use calendarSyncAgeLabel for any human-readable reference to sync age. Jack publishes invoices at the beginning of each month — unbilled hours are normal and expected throughout the month, so do not mention them unless Jack specifically asks or an invoice alert is present.`;

      // A change-triggered re-narration is not a fresh briefing — Jack has
      // already read today's. Lead with what moved instead of restating the day.
      const changeMsg = changeSummary
        ? ` This is an update prompted by a calendar change, not a scheduled briefing. Jack has already seen today's briefing, so lead with what changed and keep it to 1-3 sentences. The changeSummary field lists the added, moved, and deleted events that triggered this update — name them specifically.`
        : "";

      const aiResponse = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        // Pure summarization of JSON assembled above — thinking buys nothing here.
        thinking: {type: "disabled"},
        output_config: {effort: "low"},
        system: systemMsg + changeMsg,
        messages: [{
          role: "user",
          content: JSON.stringify(
            changeSummary ? {...briefingData, changeSummary} : briefingData
          ),
        }],
      });
      // Filter by type rather than indexing content[0] — with thinking enabled
      // the first block is a thinking block, which would silently yield null.
      const text = aiResponse.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      if (text) {
        narrativeSummary = text;
      }
    } catch (err) {
      console.error("AI narrative generation failed:", err);
    }

    return narrativeSummary;
}

/**
 * Persist a briefing.
 *
 * `briefings/live` is the document the dashboard reads — always the current
 * state. The dated documents are an archive of what the 7am and 1pm runs said,
 * kept so "what did the morning briefing tell me" stays answerable.
 */
async function writeBriefing(
  briefingData: Record<string, unknown> & {alerts: Array<{type: string; message: string}>},
  narrativeSummary: string | null,
  opts: {archiveDocId?: string; changeSummary?: Record<string, unknown> | null} = {}
): Promise<void> {
    const todayStr = briefingData["date"] as string;
    const alerts = briefingData.alerts;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const briefing = {
      ...briefingData,
      narrativeSummary,
      createdAt: now,
      updatedAt: now,
      // Keyed separately from updatedAt so the dashboard can tell a facts-only
      // refresh from new prose — the TTS cache depends on that distinction.
      narrativeAt: now,
      lastChangeSummary: opts.changeSummary ?? null,
    };

    await db.collection("briefings").doc("live").set(briefing);
    if (opts.archiveDocId) {
      await db.collection("briefings").doc(opts.archiveDocId).set(briefing);
    }

    await syncAlerts(alerts, todayStr);
}

/**
 * Reconcile the alerts collection, which is what the dashboard's alert banner
 * reads — `briefings/live.alerts` is not rendered directly.
 *
 * Shared by both write paths on purpose. A facts-only refresh can surface a
 * genuinely new alert (a task crossing into overdue at midday, the calendar
 * sync going quiet), and if only the full-briefing path wrote here those would
 * sit invisible until the next cron beat.
 *
 * Idempotent: the alert type is the document id, so re-running replaces rather
 * than duplicates.
 */
async function syncAlerts(
  alerts: Array<{type: string; message: string}>,
  todayStr: string
): Promise<void> {
    // Delete any undismissed alerts from prior days (stale alerts with random or type-based IDs).
    // This prevents old overdue-tasks/calendar-stale/invoice alerts from piling up day after day.
    // Filter in JS (briefingDate < today) to avoid needing a composite index on dismissed+briefingDate.
    const staleSnap = await db.collection("alerts").where("dismissed", "==", false).get();
    const staleDocs = staleSnap.docs.filter((d) => (d.data()["briefingDate"] as string) < todayStr);
    if (staleDocs.length > 0) {
      const deleteBatch = db.batch();
      staleDocs.forEach((d) => deleteBatch.delete(d.ref));
      await deleteBatch.commit();
    }

    // Write new alerts to the alerts collection.
    // Use the alert type as the document ID so that set() replaces any existing
    // alert of the same type (including stale undismissed alerts from prior days).
    for (const alert of alerts) {
      await db.collection("alerts").doc(alert.type).set({
        ...alert,
        dismissed: false,
        briefingDate: todayStr,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
}

/**
 * Does the prose on `live` still describe the day the facts are about?
 *
 * A narrative is a point-in-time story — "rest of today is unchanged", "a new
 * event landed on tomorrow's calendar" — while the facts under it get replaced
 * every half hour. Once the ET date moves on, that prose is not stale by a
 * degree, it is wrong: yesterday's "tomorrow" is today.
 */
function narrativeIsCurrent(
  live: admin.firestore.DocumentData | null | undefined,
  state: Record<string, unknown>
): boolean {
  if (!live?.["narrativeSummary"]) return false;
  const narratedAt = live["narrativeAt"]?.toDate?.() as Date | undefined;
  if (!narratedAt) return false;
  return etDateKey(narratedAt) === (state["date"] as string);
}

/**
 * Update briefings/live with new facts while leaving the prose alone.
 *
 * Deliberately preserves narrativeSummary and narrativeAt: the dashboard keys
 * its TTS cache on narrativeAt, so bumping it here would re-synthesize audio
 * for words that did not change.
 *
 * Callers are responsible for not routing a day-old narrative through here —
 * see narrativeIsCurrent.
 */
async function writeFactsOnly(
  state: Record<string, unknown> & {alerts: Array<{type: string; message: string}>},
  changeSummary?: Record<string, unknown> | null
): Promise<void> {
  const liveRef = db.collection("briefings").doc("live");
  const liveSnap = await liveRef.get().catch(() => null);
  const live = liveSnap?.exists ? liveSnap.data() : null;
  const now = admin.firestore.FieldValue.serverTimestamp();

  await liveRef.set({
    ...state,
    narrativeSummary: (live?.["narrativeSummary"] as string | null) ?? null,
    narrativeAt: live?.["narrativeAt"] ?? null,
    createdAt: live?.["createdAt"] ?? now,
    updatedAt: now,
    lastChangeSummary: changeSummary ?? live?.["lastChangeSummary"] ?? null,
  });

  await syncAlerts(state.alerts, state["date"] as string);
}

/**
 * A full briefing: fresh state, fresh prose, written to live plus a dated
 * archive. This is what the 7am/1pm cron and the dashboard refresh button do.
 */
async function runBriefing(): Promise<void> {
  const state = await computeBriefingState();
  const narrative = await generateNarrative(state);
  const archiveDocId = state["timeOfDay"] === "afternoon"
    ? `${state["date"]}-afternoon`
    : (state["date"] as string);
  await writeBriefing(state, narrative, {archiveDocId});
}

// ─── Reactive: recompute when the calendar actually changes ─────
//
// Triggered by metadata/calendarChange, which the Mac bridge writes ONLY when a
// sync found a real difference. Triggering off metadata/calendarSync instead
// would fire on every heartbeat — every two minutes, all day — for nothing.

/** Minimum gap between two model-written narratives, to bound churn. */
const NARRATIVE_MIN_GAP_MS = 2 * 60 * 1000;

// ─── Spoken alerts ─────────────────────────────────────────────
//
// A calendar change worth speaking about goes out as a `speak` action on the
// pendingDesktopActions queue, which desktop-bridge drains every 30s and plays
// through afplay. Detection is ~120s (the sync poll) and delivery ~30s, so an
// invite lands audibly in about two and a half minutes.
//
// The audio travels with the action as base64 rather than as a URL because the
// bridge authenticates with a service account and synthesizeSpeech expects a
// user ID token. A one-sentence clip is ~25KB against a 1MB document limit.

/** Only speak about events starting inside this window — the "imminent" rule. */
const ANNOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Never leave an undelivered alert queued longer than this. */
const ANNOUNCE_MAX_TTL_MS = 6 * 60 * 60 * 1000;

interface CalendarChangeEntry {
  summary: string;
  kind: "added" | "moved" | "updated" | "deleted";
  startISO: string;
  calendarName: string;
  /** All-day event — startISO is local midnight and carries no time of day. */
  allDay?: boolean;
}

/**
 * "today at 4:15 PM", "tomorrow at 9 AM", "Thursday at 2 PM" — or, for an
 * all-day event, "all day today", since its start is local midnight and saying
 * "today at 12:00 AM" out loud is just wrong.
 */
function describeWhen(start: Date, now: Date, allDay = false): string {
  const et = (d: Date) => d.toLocaleDateString("en-CA", {timeZone: "America/New_York"});
  const time = formatEventTime(start);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const day = start.toLocaleDateString("en-US", {weekday: "long", timeZone: "America/New_York"});
  if (allDay) {
    if (et(start) === et(now)) return "all day today";
    if (et(start) === et(tomorrow)) return "all day tomorrow";
    return `all day ${day}`;
  }
  if (et(start) === et(now)) return `today at ${time}`;
  if (et(start) === et(tomorrow)) return `tomorrow at ${time}`;
  return `${day} at ${time}`;
}

/**
 * Turn the sync's change list into something worth saying out loud, or null.
 *
 * Deliberately templated rather than model-written. An alert competes for
 * attention with whatever Jack is already doing, so it needs to be short and
 * predictable; a model would sometimes editorialise at length, and would add a
 * couple of seconds to a path whose whole promise is speed.
 */
function buildAnnouncement(
  changes: CalendarChangeEntry[],
  now: Date
): {text: string; earliestStart: Date} | null {
  const imminent = changes.filter((c) => {
    if (c.kind === "updated") return false; // a tweaked note is not news
    const t = new Date(c.startISO).getTime();
    if (isNaN(t)) return false;
    // Forward-looking only, and only inside the imminent window.
    return t > now.getTime() && t - now.getTime() <= ANNOUNCE_WINDOW_MS;
  });
  if (imminent.length === 0) return null;

  const sentences = imminent.map((c) => {
    const start = new Date(c.startISO);
    const when = describeWhen(start, now, c.allDay ?? false);
    const cal = c.calendarName && c.calendarName !== "Jax" ? ` on your ${c.calendarName} calendar` : "";
    if (c.kind === "added") return `New invite${cal}: ${c.summary}, ${when}.`;
    if (c.kind === "moved") return `${c.summary} moved to ${when}.`;
    return `${c.summary}, ${when}, was cancelled.`;
  });

  const earliestStart = imminent
    .map((c) => new Date(c.startISO))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  // One utterance covers everything in this sync, which is not the same as rate
  // limiting — it is just not speaking three times for one batch of invites.
  // Spelled-out counts because this is read aloud, not displayed.
  const COUNT_WORDS = ["", "", "Two", "Three", "Four", "Five"];
  const lead = sentences.length > 1
    ? `${COUNT_WORDS[sentences.length] ?? sentences.length} calendar changes. `
    : "";
  return {
    text: (lead + sentences.join(" ")).trim(),
    earliestStart,
  };
}

/** The meeting currently in progress, if any, so an alert can wait for it. */
async function findMeetingInProgress(now: Date): Promise<{endTime: Date} | null> {
  // Single range on startTime plus a client-side end check — a two-field
  // inequality would need a composite index for no real benefit at this size.
  const snap = await db.collection("calendarEvents")
    .where("startTime", ">=", admin.firestore.Timestamp.fromDate(new Date(now.getTime() - 6 * 60 * 60 * 1000)))
    .where("startTime", "<=", admin.firestore.Timestamp.fromDate(now))
    .get()
    .catch(() => null);
  if (!snap) return null;
  let latestEnd: Date | null = null;
  for (const d of snap.docs) {
    const end = d.data()["endTime"]?.toDate?.();
    if (end && end.getTime() > now.getTime()) {
      if (!latestEnd || end.getTime() > latestEnd.getTime()) latestEnd = end;
    }
  }
  return latestEnd ? {endTime: latestEnd} : null;
}

/**
 * Queue a spoken alert for the Mac.
 *
 * `idempotencyKey` becomes the document id. Firestore triggers are at-least-once,
 * so the same change can invoke onCalendarChange more than once; a create-only
 * write on a deterministic id collapses those retries into a single alert
 * instead of speaking twice.
 */
async function queueSpokenAlert(
  text: string,
  idempotencyKey: string,
  opts: {notBefore?: Date; expiresAt: Date}
): Promise<"queued" | "duplicate" | "failed"> {
  const audio = await synthesizeToBuffer(text);
  const ref = db.collection("pendingDesktopActions").doc(idempotencyKey);
  try {
    await ref.create({
      action: "speak",
      status: "pending",
      payload: {
        text,
        // Absent when synthesis failed; the bridge falls back to `say`.
        audioBase64: audio ? audio.toString("base64") : null,
      },
      notBefore: opts.notBefore ? admin.firestore.Timestamp.fromDate(opts.notBefore) : null,
      expiresAt: admin.firestore.Timestamp.fromDate(opts.expiresAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return "queued";
  } catch (err) {
    // ALREADY_EXISTS is the expected outcome of a duplicate trigger delivery.
    if ((err as {code?: number}).code === 6) return "duplicate";
    console.error("[queueSpokenAlert] failed:", err);
    return "failed";
  }
}

export const onCalendarChange = onDocumentWritten(
  {
    document: "metadata/calendarChange",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // deletion — nothing to react to

    const changeSummary = {
      added: after["added"] ?? 0,
      moved: after["moved"] ?? 0,
      updated: after["updated"] ?? 0,
      deleted: after["deleted"] ?? 0,
      changes: after["changes"] ?? [],
    };
    const materialChange = after["materialChange"] === true;

    // Reuse the billing figures already on the live document when they are
    // recent. A meeting moving does not change unbilled hours, and those are
    // three cross-project reads into fta-invoice-tracking.
    const liveRef = db.collection("briefings").doc("live");
    const liveSnap = await liveRef.get().catch(() => null);
    const live = liveSnap?.exists ? liveSnap.data() : null;

    const liveUpdatedMs = live?.["updatedAt"]?.toDate?.()?.getTime() ?? 0;
    const billingFresh = Date.now() - liveUpdatedMs < 10 * 60 * 1000;
    const reuseBilling: BillingSlice | null = billingFresh && live ? {
      unbilledHours: (live["unbilledHours"] as number) ?? 0,
      unbilledAmount: (live["unbilledAmount"] as number) ?? 0,
      weekHours: (live["weekHours"] as number) ?? 0,
      lastInvoiceDate: (live["lastInvoiceDate"] as string | null) ?? null,
      lastInvoiceAmount: (live["lastInvoiceAmount"] as number | null) ?? null,
    } : null;

    const state = await computeBriefingState(reuseBilling);

    // Re-narrate only when the change is worth interrupting for, not too soon
    // after the last narration, and not in the middle of the night.
    const etHour = parseInt(
      new Date().toLocaleString("en-US", {
        hour: "numeric", hour12: false, timeZone: "America/New_York",
      })
    );
    const narrativeAgeMs = Date.now() -
      (live?.["narrativeAt"]?.toDate?.()?.getTime() ?? 0);
    const inWakingHours = etHour >= 6 && etHour < 21;

    // ── Spoken alert ──────────────────────────────────────────
    // Independent of the narrative decision: a new invite is worth saying out
    // loud even when the prose was just regenerated a minute ago.
    if (inWakingHours) {
      const now = new Date();
      const announcement = buildAnnouncement(
        (after["changes"] ?? []) as CalendarChangeEntry[],
        now
      );
      if (announcement) {
        const inProgress = await findMeetingInProgress(now);
        const expiresAt = new Date(Math.min(
          Math.max(announcement.earliestStart.getTime(), now.getTime() + 5 * 60 * 1000),
          now.getTime() + ANNOUNCE_MAX_TTL_MS
        ));
        // The change beacon's own timestamp is a natural idempotency key: one
        // sync-with-changes writes it exactly once.
        const changedAtMs = after["changedAt"]?.toDate?.()?.getTime() ?? Date.now();
        const outcome = await queueSpokenAlert(
          announcement.text,
          `speak-${changedAtMs}`,
          {notBefore: inProgress?.endTime, expiresAt}
        );
        console.log(
          `[onCalendarChange] spoken alert ${outcome}: "${announcement.text}"` +
          (inProgress ? ` (deferred until ${inProgress.endTime.toISOString()})` : "")
        );
      }
    }
    // No usable prose yet — first run after deploy, a previous generation that
    // failed, or a narrative left over from yesterday. Narrate regardless of
    // whether this particular change was material, otherwise the dashboard
    // shows bare numbers (or a day-old story) until the next cron beat.
    const hasNarrative = narrativeIsCurrent(live, state);
    const shouldNarrate =
      inWakingHours &&
      (!hasNarrative ||
        (materialChange && narrativeAgeMs > NARRATIVE_MIN_GAP_MS));

    if (shouldNarrate) {
      const narrative = await generateNarrative(state, changeSummary);
      await writeBriefing(state, narrative, {changeSummary});
      console.log(`[onCalendarChange] re-narrated: ${JSON.stringify(changeSummary)}`);
      return;
    }

    // Facts-only refresh: update everything except the prose, so the dashboard
    // is current without paying for a model call or churning the TTS cache.
    await writeFactsOnly(state, changeSummary);
    console.log(
      `[onCalendarChange] facts-only refresh (material=${materialChange}, ` +
      `narrativeAgeMin=${Math.round(narrativeAgeMs / 60000)}, etHour=${etHour})`
    );
  }
);

// ─── Scheduled: keep the facts fresh between calendar changes ───
//
// Unbilled hours, and a task crossing midnight into overdue, are not calendar
// events, so nothing above would notice them. This is a cheap facts-only
// refresh — no model call — on the half hour during the working day.
export const refreshBriefingFacts = onSchedule(
  {
    schedule: "*/30 6-20 * * 1-5",
    timeZone: "America/New_York",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const state = await computeBriefingState();
    const liveSnap = await db.collection("briefings").doc("live").get().catch(() => null);

    // Self-heal: if there is no prose on the live document — first run after
    // deploy, or a generation that failed — write a full briefing rather than
    // leaving the dashboard showing numbers with no narrative.
    //
    // Prose from a previous day counts as no prose. A facts-only refresh keeps
    // whatever narrative it finds, so the first run after midnight would
    // otherwise pair today's facts with last night's story — "a new event
    // landed on tomorrow's calendar" read aloud on the morning that tomorrow
    // became today.
    if (!liveSnap?.exists || !narrativeIsCurrent(liveSnap.data(), state)) {
      await writeBriefing(state, await generateNarrative(state));
      return;
    }
    await writeFactsOnly(state);
  }
);

// ─── On-demand: Refresh briefing (called from dashboard refresh button) ────
export const refreshBriefing = onRequest(
  {cors: true, region: "us-central1", memory: "512MiB", timeoutSeconds: 120},
  async (req, res) => {
    try {
      await verifyAuth(req);
    } catch {
      res.status(401).json({error: "Unauthorized"});
      return;
    }
    try {
      await runBriefing();
      res.json({ok: true});
    } catch (err) {
      console.error("[refreshBriefing] error:", err);
      res.status(500).json({error: "Briefing generation failed"});
    }
  }
);

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
    await runBriefing();
  }
);

// ─── Scheduled: Invoice Reminder (first 7 days of month, weekdays 9am ET)
export const invoiceReminder = onSchedule(
  {
    schedule: "0 9 5-7 * 1-5",
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

    // Check if we already sent a reminder today. ET, to match the briefingDate
    // the briefing paths write.
    const todayStr = etDateKey(today);
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
      // Use doc("invoice") so this upserts rather than appending a duplicate.
      await db.collection("alerts").doc("invoice").set({
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
  {region: "us-central1", memory: "256MiB", timeoutSeconds: 120},
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
- Default category is "general". Other categories: ihrdc, solomon, dial, ppk, church, embassy.
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

    const anthropic = new Anthropic({apiKey: anthropicApiKey});

    try {
      console.log("[receiveSms] calling Haiku for intent parse");
      const aiResponse = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        // Thinking off on both SMS calls: Twilio's webhook timeout is ~15s and
        // this handler makes two sequential model calls. Latency is the binding
        // constraint here, not reasoning depth.
        thinking: {type: "disabled"},
        output_config: {effort: "low"},
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
      console.log(`[receiveSms] intent parsed: ${parsed.action}`);
    } catch (err) {
      console.error("[receiveSms] Claude parse error:", err);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("Sorry, I had trouble understanding that. Try: \"add task X\" or \"what are my tasks?\"");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // ── 5. Execute the action ──────────────────────────────────
    let actionSummary: string;
    const twiml = new twilio.twiml.MessagingResponse();

    try {
      if (parsed.action === "add_task") {
        const title = parsed.title || messageBody;
        const category = parsed.category || "general";
        const dueDate = parsed.dueDate || null;
        await db.collection("tasks").add({
          title,
          category,
          completed: false,
          dueDate,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        actionSummary = `Task added successfully: "${title}", category: ${category}${dueDate ? `, due: ${dueDate}` : ", no due date"}`;
      } else if (parsed.action === "complete_task") {
        if (!parsed.taskId) {
          actionSummary = "Could not find a matching task to complete — the title was ambiguous";
        } else {
          await db.collection("tasks").doc(parsed.taskId).update({
            completed: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          const completedTask = activeTasks.find((t) => t["id"] === parsed.taskId);
          const completedTitle = completedTask ? (completedTask["title"] as string) : parsed.taskId;
          actionSummary = `Task completed: "${completedTitle}"`;
        }
      } else if (parsed.action === "list_tasks") {
        if (activeTasks.length === 0) {
          actionSummary = "Jack has no active tasks right now";
        } else {
          const lines = activeTasks.slice(0, 10).map((t) => {
            const due = t["dueDate"] ? ` (due ${t["dueDate"]})` : "";
            return `• [${t["category"]}] ${t["title"]}${due}`;
          });
          const more = activeTasks.length > 10 ? `\n...and ${activeTasks.length - 10} more` : "";
          actionSummary = `Jack's active tasks (${activeTasks.length} total):\n${lines.join("\n")}${more}`;
        }
      } else {
        actionSummary = `Could not parse the request: ${parsed.clarification || "unknown intent"}`;
      }
    } catch (err) {
      console.error("[receiveSms] Action execution error:", err);
      twiml.message("Something went wrong on my end. Please try again or check the app.");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // ── 6. Generate personalized reply via Claude Haiku ────────
    let replyText: string;
    try {
      console.log("[receiveSms] calling Haiku for personalized reply");
      const replyResponse = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 320,
        thinking: {type: "disabled"},
        output_config: {effort: "low"},
        system: `You are Maisie, Jack Notarangelo's personal executive assistant, replying to Jack via SMS.
Be concise and personal — warm with a dry wit, like a trusted colleague who knows Jack well. Use his first name occasionally but not in every message. Never use emojis. Keep replies short (1-2 sentences max) — this is SMS. No markdown.
Today is ${new Date().toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York"})}.`,
        messages: [{
          role: "user",
          content: `Jack texted: "${messageBody}"\n\nResult: ${actionSummary}\n\nWrite a short SMS reply confirming what was done (or listing tasks if that was requested).`,
        }],
      });
      replyText = replyResponse.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      console.log("[receiveSms] reply generated");
    } catch (err) {
      console.error("[receiveSms] Reply generation error:", err);
      // Fall back to plain summary if Haiku fails
      replyText = actionSummary;
    }

    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());
  }
);
