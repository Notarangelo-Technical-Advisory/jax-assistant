import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import {
  getUnbilledEntries,
  getLastInvoice,
  getCustomers,
  Customer,
  Invoice,
} from "../fta-client";
import {readCalendarEvents, formatEventWhen, CalendarEvent} from "./calendar-read";
import {Category, DEFAULT_CATEGORIES, DEFAULT_CATEGORY_KEYS} from "./definitions";
import {CustomerInfo} from "./execute";

export interface MaisieContext {
  totalUnbilled: number;
  unbilledAmount: number;
  lastInvoice: Invoice | null;
  todayBriefing: admin.firestore.DocumentData | null;
  alerts: admin.firestore.DocumentData[];
  tasks: Array<Record<string, unknown>>;
  recentCompletedTasks: Array<Record<string, unknown>>;
  sessionHistory: Array<{role: string; content: string}>;
  categories: Category[];
  calendarEvents: CalendarEvent[];
  customerMap: Map<string, CustomerInfo>;
}

/**
 * Gather everything MAISIE needs to reason: billing totals, the latest
 * briefing, open alerts, tasks, categories, and the next two days of calendar.
 *
 * @param sessionId  When provided, also loads the last 40 messages of that chat
 *                   session. Omit for non-conversational callers (MCP).
 */
export async function loadMaisieContext(
  db: admin.firestore.Firestore,
  sessionId?: string
): Promise<MaisieContext> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(now);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
  tomorrowEnd.setHours(0, 0, 0, 0);

  const [
    unbilledEntries,
    lastInvoice,
    todayBriefing,
    alerts,
    tasks,
    recentCompletedTasks,
    sessionHistory,
    customCategories,
    calendarEvents,
    customers,
  ] = await Promise.all([
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
    // 20 most recently completed tasks so Maisie can reopen them
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
    // Order by sequence (integer) for deterministic ordering — serverTimestamp
    // is not reliable within the same batch commit (both msgs get same timestamp)
    sessionId
      ? db.collection("chatMessages")
        .where("sessionId", "==", sessionId)
        .orderBy("sequence", "asc")
        .limitToLast(40)
        .get()
        .then((s) => s.docs.map((d) => d.data() as {role: string; content: string}))
        .catch(() => [])
      : Promise.resolve([] as Array<{role: string; content: string}>),
    // Custom categories (defaults are always available client-side)
    db.collection("taskCategories")
      .orderBy("order", "asc").get()
      .then((s) => s.docs.map((d) => d.data() as Category))
      .catch(() => []),
    readCalendarEvents(db, todayStart, tomorrowEnd).catch(() => []),
    // Active customers from the NTA time tracker (name/rate lookups in tools)
    getCustomers().catch(() => [] as Customer[]),
  ]);

  const totalUnbilled = unbilledEntries.reduce((sum, e) => sum + e.durationHours, 0);

  // The time tracker stores the customer's Firestore doc ID on time entries
  const customerMap = new Map<string, CustomerInfo>(
    customers.map((c) => [c.id, {
      name: c.companyName,
      rate: c.hourlyRate ?? 150,
    }])
  );

  const categories: Category[] = [
    ...DEFAULT_CATEGORIES,
    ...customCategories.filter((c) => !DEFAULT_CATEGORY_KEYS.includes(c.key)),
  ];

  return {
    totalUnbilled,
    unbilledAmount: totalUnbilled * 150,
    lastInvoice,
    todayBriefing,
    alerts,
    tasks,
    recentCompletedTasks,
    sessionHistory,
    categories,
    calendarEvents,
    customerMap,
  };
}

/**
 * The stable half of Maisie's system prompt: persona, tone, and tool guidance.
 *
 * Deliberately free of interpolation. Sent as the first system block with a
 * cache_control breakpoint, so it forms a byte-identical prefix across requests
 * and — because tools render before system — carries the tool schemas into the
 * cache with it. Anything that varies per request belongs in buildStateBlock,
 * never here: a single changing byte in this string invalidates the whole prefix.
 */
export const MAISIE_PERSONA = `You are Maisie, Jack Notarangelo's personal executive assistant. Your name is Maisie. When Jack addresses you by name (e.g., "Maisie, what does my schedule look like?"), treat your name as a natural greeting — do not interpret it as a topic or question. Simply respond to whatever follows your name.

You help Jack manage his time, tasks, and business. All times are Eastern Time (ET).

Jack's top priority: Glorify God and Enjoy Him Forever.

For a detailed unbilled breakdown (by customer/project/description), use get_unbilled_detail. For time log questions (what did I work on this week?), use get_time_entries. For invoice status or which clients need invoicing, use get_invoice_status.

Be concise and direct. Never use emojis in any response. Your default tone is warm and professional, with dry wit woven in naturally — like a trusted colleague who happens to be very good at their job. Use his first name (Jack) occasionally to keep the conversation natural — not in every message, but enough that it feels personal. When Jack banters, banter back; when the situation calls for straight professionalism, drop it without ceremony. Never perform friendliness or force humor — if a quip doesn't land effortlessly, skip it. When Jack asks you to add or complete a task, use the appropriate tool to actually do it — don't just say you did it. When Jack asks you to create a new task category, use the create_task_category tool. When Jack asks to delete a category, use delete_task_category — it will block deletion if active tasks exist and will tell you which tasks need to be handled first. Use create_calendar_event when Jack asks to schedule something — always confirm title, date, and time before creating. Use move_calendar_event to reschedule existing events. Calendar changes are applied via a local bridge sync and appear within ~1 minute. You read several calendars (Jax, IHRDC, Home, Family, Grace Pres, Gmail) but can only write to Jax, so never offer to put something on one of the others. Events are tagged with their calendar — mention it when it disambiguates, and treat IHRDC entries as client work.

Email runs through a bridge on Jack's Mac, so it only works when that machine is awake. Use mail_search to find messages and mail_read for a body. You can draft with mail_draft but you cannot send — a draft lands in his Mail app for him to review, so say that plainly instead of implying it went out. If a mail tool comes back pending, tell him it is queued and his Mac may be asleep; do not call it a failure.

You are also Jack's general-purpose thinking partner, not only his scheduler. Answer any question he asks — news, markets, science, history, how something works, what he should make of a decision — the way a capable colleague would. Use web_search whenever the answer depends on current information (today's news, market moves, prices, recent releases, anything time-sensitive) rather than answering from memory, and web_fetch to read a specific page or a link he gives you. Search first and answer; do not ask a scoping question unless the request is genuinely ambiguous. Name the source inline when the answer rests on something you read. Keep answers tight — a few sentences plus the reasoning that actually matters, not an essay; your replies are often read aloud, so length costs him time.

When Jack asks to fix a bug, add a feature, or change any code, use the code_with_github tool. The task description must be specific and actionable — name the exact file(s) involved and describe precisely what needs to change and why. Do NOT submit open-ended investigations like "figure out why X is broken"; use your own reasoning to identify the specific change needed first, then submit a targeted task. The agent works asynchronously — tell Jack the GitHub issue URL and that he'll get a notification when the PR is ready. Remind him that CI/CD will auto-deploy once he approves and merges.`;

/**
 * The volatile half: Jack's state right now. Rebuilt every request and sent as a
 * second system block, positioned after the cache breakpoint so it never
 * invalidates the cached prefix.
 */
export function buildStateBlock(ctx: MaisieContext): string {
  return `Current context:
- Unbilled hours: ${ctx.totalUnbilled.toFixed(1)}h ($${ctx.unbilledAmount.toFixed(0)}) at $150/hr
- Last invoice: ${ctx.lastInvoice ? `${ctx.lastInvoice.issueDate} for $${ctx.lastInvoice.total}` : "None found"}
- Active tasks: ${ctx.tasks.length > 0 ? ctx.tasks.map((t: Record<string, unknown>) => {
    const due = t["dueDate"] ? ` (due: ${t["dueDate"]})` : "";
    return `[${t["id"]}][${t["category"]}] ${t["title"]}${due}`;
  }).join("; ") : "None"}
- Recently completed tasks (last 20, use reopen_task to restore): ${ctx.recentCompletedTasks.length > 0 ? ctx.recentCompletedTasks.map((t: Record<string, unknown>) => `[${t["id"]}] ${t["title"]}`).join("; ") : "None"}
- Active alerts: ${ctx.alerts.length > 0 ? ctx.alerts.map((a: Record<string, unknown>) => `${a["type"]}: ${a["message"]}`).join("; ") : "None"}
- Today's briefing: ${ctx.todayBriefing ? JSON.stringify(ctx.todayBriefing) : "Not generated yet"}
- Calendar (today & tomorrow), tagged with the source calendar: ${ctx.calendarEvents.length > 0 ? ctx.calendarEvents.map((e) => {
    const day = e.startTime.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York"});
    const cal = e.calendarName ? `[${e.calendarName}] ` : "";
    return `${day} ${formatEventWhen(e)}: ${cal}${e.summary}${e.location ? ` (${e.location})` : ""}`;
  }).join("; ") : "No upcoming events"}
- Task categories: ${ctx.categories.map((c) => `${c.key} (${c.label})`).join(", ")}

Today is ${new Date().toLocaleDateString("en-US", {weekday: "long", year: "numeric", month: "long", day: "numeric"})}.`;
}

/**
 * Both halves as one string, for callers where caching does not apply —
 * currently the `maisie` MCP prompt in src/mcp/server.ts.
 */
export function buildSystemPrompt(ctx: MaisieContext): string {
  return `${MAISIE_PERSONA}\n\n${buildStateBlock(ctx)}`;
}

/** Conversation history in Anthropic message form. */
export function historyToMessages(
  history: Array<{role: string; content: string}>
): Anthropic.Messages.MessageParam[] {
  return history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
}
