import * as admin from "firebase-admin";
import {createHash} from "crypto";
import {ET_ZONE, addDaysToKey, etDateKey} from "../et-time";
import {DEFAULT_CATEGORIES} from "./definitions";

// ─── Work journal ──────────────────────────────────────────────
//
// A record of what Jack did and when, and for which client, so he can account
// for work done a few minutes at a time across a day. The readers live on
// Jack's Mac (src/mcp/collect-journal.ts), because the gh login, the Jira token
// in the Keychain, Claude Code's session files, Apple Calendar and Wispr Flow's
// database are only there. This file decides the client, stores the items and estimates the time,
// so the rules are tested against the emulator.
//
// - Each item has a fixed id made from its source and the source's own id, so
//   a second run finds it and writes nothing.
// - The client comes from where the work happened: the GitHub repo or its
//   owner, the Jira site, or the repo a Claude Code session ran in. A meeting's
//   client comes from the people invited, its calendar or words in its title,
//   and a meeting with no client is left out (see meetingClient). A recording's
//   client comes from the meeting it overlaps or its title (see
//   recordingItems). Clients are the task categories, so the journal and the
//   task list use the same names.
// - Time is an estimate. Items less than GAP_MINUTES apart form one work
//   session, timed from its first item to its last, and a session is never
//   shorter than MIN_SESSION_MINUTES.
// - journalDays holds each day's summary, rebuilt from that day's items
//   whenever one of them is written, so a page or a tool reads one document a day.

export const GAP_MINUTES = 20;
export const MIN_SESSION_MINUTES = 6;
export const DEFAULT_CLIENT = "general";

/** Repos whose client is not their owner's. Keys are lower case "owner/name". */
const REPO_CLIENTS: Record<string, string> = {
  "notarangelo-technical-advisory/jax-assistant": "executive_assistant",
  "notarangelo-technical-advisory/solomon": "solomon",
  "notarangelo-technical-advisory/dora-tma": "dial",
  "notarangelo-technical-advisory/prophet-priest-king": "ppk",
  "notarangelo-technical-advisory/grace-pres": "church",
  "notarangelo-technical-advisory/snep_srt": "church",
  "jacknota/bible-studies": "church",
  "jacknota/embassy-book-series": "embassy",
};

/** Every other repo of these owners belongs to the owner's client. Keys are lower case. */
const OWNER_CLIENTS: Record<string, string> = {
  "ihrdc": "ihrdc",
};

/** Jira sites and their client. */
export const JIRA_SITE_CLIENTS: Record<string, string> = {
  "ihrdcdev.atlassian.net": "ihrdc",
};

/** Calendars whose meetings all belong to one client, by the label in apple-meetings.ts. */
const CALENDAR_CLIENTS: Record<string, string> = {
  "IHRDC": "ihrdc",
};

/** Email domains whose people make a meeting that client's. Keys are lower case. */
const DOMAIN_CLIENTS: Record<string, string> = {
  "ihrdc.com": "ihrdc",
  "coxeng.com": "cox",
};

/**
 * Words in a meeting's title that give it a client, so that work and church
 * meetings on the Jax calendar count and personal events there do not. Each is
 * matched as whole words, ignoring case and punctuation.
 */
const MEETING_WORDS: Array<{words: string; client: string}> = [
  {words: "Cox", client: "cox"},
  {words: "Officer Meeting", client: "church"},
  {words: "Grace Prayer Meeting", client: "church"},
  {words: "Community Group", client: "church"},
  {words: "Praying Avidly", client: "church"},
  {words: "Worship", client: "church"},
];

/**
 * Projects in IHRDC's Jira that Jack works in. A key such as CNG-6882 in a
 * recording's title gives that client. Other keys are ignored, because a title
 * can hold look-alikes such as UTF-8.
 */
const JIRA_PROJECT_CLIENTS: Record<string, string> = {
  "CNG": "ihrdc",
  "THREEX": "ihrdc",
  "ITSP": "ihrdc",
};

export type JournalSource = "github" | "jira" | "claude" | "meeting" | "recording";

/** One piece of work, as a reader on the Mac finds it. */
export interface JournalItemInput {
  source: JournalSource;
  /** The source's own id for this piece of work, unique within the source. */
  sourceId: string;
  /** ISO timestamp: when the work happened, or when a Claude Code session, a meeting or a recording began. */
  at: string;
  /** Claude Code, meetings and recordings: the ISO timestamp of the session's last activity, or the end. */
  endAt?: string | null;
  /** What Jack did: "Opened PR #674", "Moved CNG-7183 to Code Review". */
  action: string;
  /** What it was about: the pull request title, the Jira summary, the session title. */
  subject: string;
  /** More detail, such as "In Progress → Code Review" or "3 commits". */
  detail?: string | null;
  /** http(s) only; anything else is dropped. */
  url?: string | null;
  /** "IHRDC/cmsonline". GitHub and Claude Code. */
  repo?: string | null;
  /** "CNG-7183": the Jira issue, or a key found in a branch name or title. */
  ticket?: string | null;
  /** Jira only: the site, which decides the client. */
  site?: string | null;
  /** Meetings and recordings: the client their rules chose. Other sources get theirs from where the work happened. */
  client?: string | null;
}

/** A meeting on the Jax or IHRDC calendar, as the reader on the Mac finds it. */
export interface CalendarMeeting {
  /** The calendar's id for the event. Every occurrence of a repeating meeting has the same one. */
  uid: string;
  title: string;
  /** ISO timestamps. */
  start: string;
  end: string;
  allDay: boolean;
  /** Marked Free (not Busy), as a reminder usually is. */
  free: boolean;
  /** Jack was invited and declined. */
  declined: boolean;
  /** "Jax" or "IHRDC". */
  calendar: string;
  /** Email addresses of the other people invited, without Jack, rooms or resources. */
  people: string[];
}

/** A meeting Jack recorded in Wispr Flow, as the reader on the Mac finds it. */
export interface Recording {
  /** Wispr Flow's id for the recording. */
  id: string;
  title: string;
  /** ISO timestamps. `end` is null while it is still being recorded. */
  start: string;
  end: string | null;
  /** The recording's notes page in Wispr Flow, or null. */
  url: string | null;
}

/** Recordings read, and why the ones not journaled were left out. */
export interface RecordingItems {
  items: JournalItemInput[];
  read: number;
  notEnded: number;
  noClient: number;
}

/** Meetings read, and why the ones not journaled were left out. */
export interface MeetingItems {
  items: JournalItemInput[];
  read: number;
  notEnded: number;
  allDay: number;
  free: number;
  declined: number;
  noClient: number;
}

/** An item as it is stored in the journal collection. */
export interface JournalItem {
  source: JournalSource;
  sourceId: string;
  client: string;
  /** YYYY-MM-DD in Eastern Time. */
  day: string;
  at: string;
  endAt: string | null;
  action: string;
  subject: string;
  detail: string | null;
  url: string | null;
  repo: string | null;
  ticket: string | null;
}

export interface WorkSession {
  start: string;
  end: string;
  minutes: number;
  itemCount: number;
}

export interface ClientDay {
  client: string;
  label: string;
  minutes: number;
  itemCount: number;
  sessions: WorkSession[];
}

/** A journalDays document. */
export interface JournalDay {
  day: string;
  /** Time across all clients, counting overlapping work once. */
  totalMinutes: number;
  itemCount: number;
  /** Most time first. */
  clients: ClientDay[];
}

export interface SaveSummary {
  dryRun: boolean;
  read: number;
  /** New items, written or that would be written. */
  added: number;
  /** Items already stored that changed, such as a Claude Code session that went on longer. */
  updated: number;
  unchanged: number;
  /** Items with no usable time or id. */
  skipped: number;
  /** The days with a new or changed item, whose summaries need rebuilding. */
  days: string[];
  /** Items per client. */
  byClient: Record<string, number>;
}

const BATCH_LIMIT = 400;

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({length: Math.ceil(list.length / size)}, (_, i) => list.slice(i * size, i * size + size));

const CLIENT_LABELS: ReadonlyMap<string, string> = new Map(DEFAULT_CATEGORIES.map((c) => [c.key, c.label]));

/**
 * "IHRDC" for "ihrdc"; the key itself for a client with no task category.
 * Without `labels`, only the built-in task categories are known.
 */
export function clientLabel(client: string, labels: ReadonlyMap<string, string> = CLIENT_LABELS): string {
  return labels.get(client) ?? client;
}

/** Every client's name: the built-in task categories, then the ones Jack added (taskCategories). */
export async function loadClientLabels(db: admin.firestore.Firestore): Promise<Map<string, string>> {
  const labels = new Map(CLIENT_LABELS);
  const snap = await db.collection("taskCategories").get();
  for (const doc of snap.docs) {
    const key = doc.get("key");
    const label = doc.get("label");
    if (typeof key === "string" && typeof label === "string" && !labels.has(key)) labels.set(key, label);
  }
  return labels;
}

/** The client of a GitHub repo ("owner/name"), a Jira site, or neither. */
export function clientFor(where: {repo?: string | null; site?: string | null}): string {
  const site = where.site?.trim().toLowerCase();
  if (site && JIRA_SITE_CLIENTS[site]) return JIRA_SITE_CLIENTS[site];
  const repo = where.repo?.trim().toLowerCase();
  if (repo) {
    if (REPO_CLIENTS[repo]) return REPO_CLIENTS[repo];
    const owner = repo.split("/")[0];
    if (OWNER_CLIENTS[owner]) return OWNER_CLIENTS[owner];
  }
  return DEFAULT_CLIENT;
}

/** Lower case words with single spaces between them, and one at each end, for matching whole words. */
const wordsOf = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** The first entry of MEETING_WORDS in a title, or undefined. */
const titleWords = (title: string) => {
  const words = wordsOf(title);
  return MEETING_WORDS.find((w) => words.includes(wordsOf(w.words)));
};

/** A calendar meeting the journal can count: not all-day, not marked Free, not declined. */
const countable = (m: CalendarMeeting): boolean => !m.allDay && !m.free && !m.declined;

/**
 * The client of a meeting, or null when it has none and is left out of the
 * journal. In order: someone invited from a client's email domain; a client's
 * own calendar, when someone else is invited (a meeting with no one else
 * invited there is a personal block, such as a doctor's appointment); a word
 * in the title.
 */
export function meetingClient(meeting: Pick<CalendarMeeting, "title" | "calendar" | "people">): string | null {
  for (const address of meeting.people) {
    const client = DOMAIN_CLIENTS[address.split("@")[1]?.trim().toLowerCase() ?? ""];
    if (client) return client;
  }
  const calendarClient = CALENDAR_CLIENTS[meeting.calendar];
  if (calendarClient && meeting.people.length > 0) return calendarClient;
  return titleWords(meeting.title)?.client ?? null;
}

/**
 * The journal items for meetings that had ended by `now`. All-day events,
 * events marked Free, meetings Jack declined and meetings with no client are
 * left out. Each occurrence of a repeating meeting is its own item.
 */
export function meetingItems(meetings: CalendarMeeting[], now = new Date()): MeetingItems {
  const result: MeetingItems = {items: [], read: meetings.length, notEnded: 0, allDay: 0, free: 0, declined: 0, noClient: 0};
  for (const m of meetings) {
    if (m.allDay) {
      result.allDay++;
      continue;
    }
    if (Date.parse(m.end) > now.getTime()) {
      result.notEnded++;
      continue;
    }
    if (m.free) {
      result.free++;
      continue;
    }
    if (m.declined) {
      result.declined++;
      continue;
    }
    const client = meetingClient(m);
    if (!client) {
      result.noClient++;
      continue;
    }
    const others = m.people.length;
    result.items.push({
      source: "meeting",
      sourceId: `${m.uid}:${new Date(m.start).toISOString()}`,
      at: m.start,
      endAt: m.end,
      action: others ? `Meeting with ${others} ${others === 1 ? "other person" : "others"}` : "Meeting",
      subject: m.title,
      detail: `${m.calendar} calendar`,
      client,
    });
  }
  return result;
}

/**
 * The journal items for recordings that had ended by `now`. A recording gets
 * its client from the first of these that applies, and is left out when none
 * does:
 *
 * - the meeting in `meetings` it overlaps most, among those the journal counts;
 * - a word from MEETING_WORDS in its title;
 * - a Jira key from one of JIRA_PROJECT_CLIENTS in its title.
 *
 * A recording is an item of its own, beside the calendar meeting: time
 * recorded before or after the scheduled meeting is added, the overlap is
 * counted once, and a call that was never on the calendar still counts.
 */
export function recordingItems(recordings: Recording[], meetings: CalendarMeeting[], now = new Date()): RecordingItems {
  const result: RecordingItems = {items: [], read: recordings.length, notEnded: 0, noClient: 0};
  for (const r of recordings) {
    const start = Date.parse(r.start);
    const end = r.end ? Date.parse(r.end) : NaN;
    if (!Number.isFinite(end) || end > now.getTime()) {
      result.notEnded++;
      continue;
    }

    let during: {client: string; title: string; overlap: number} | null = null;
    for (const m of meetings) {
      if (!countable(m)) continue;
      const overlap = Math.min(end, Date.parse(m.end)) - Math.max(start, Date.parse(m.start));
      if (!(overlap > 0) || (during && overlap <= during.overlap)) continue;
      const client = meetingClient(m);
      if (client) during = {client, title: m.title, overlap};
    }
    const word = titleWords(r.title);
    const ticket = [...r.title.matchAll(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d+)(?![A-Za-z0-9])/g)]
      .map((x) => ({key: `${x[1]}-${x[2]}`, client: JIRA_PROJECT_CLIENTS[x[1]]}))
      .find((x) => x.client);

    const chosen = during ? {client: during.client, detail: `During ${during.title}`} :
      word ? {client: word.client, detail: `${word.words} in the title`} :
        ticket ? {client: ticket.client, detail: `${ticket.key} in the title`} : null;
    if (!chosen) {
      result.noClient++;
      continue;
    }
    result.items.push({
      source: "recording",
      sourceId: r.id,
      at: r.start,
      endAt: r.end,
      action: "Recorded meeting",
      subject: r.title.trim() || "Untitled recording",
      detail: chosen.detail,
      url: r.url,
      ticket: ticket?.key ?? null,
      client: chosen.client,
    });
  }
  return result;
}

/**
 * The Jira key ("CNG-7183") in a branch name such as feature/CNG-7183, or null.
 * Only branch names: a title can hold look-alikes such as "UTF-8".
 */
export function ticketInBranch(branch: string | null | undefined): string | null {
  return branch?.match(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?![A-Za-z0-9])/)?.[1] ?? null;
}

/** The fixed id of one item. */
export function journalId(source: JournalSource, sourceId: string): string {
  return `${source}_` + createHash("sha1").update(sourceId).digest("hex").slice(0, 32);
}

function webUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The stored form of an item, or null when it has no usable time or id. */
export function toJournalItem(input: JournalItemInput): JournalItem | null {
  const at = isoOrNull(input.at);
  const sourceId = input.sourceId?.trim();
  if (!at || !sourceId) return null;
  const endAt = isoOrNull(input.endAt);
  const repo = input.repo?.trim() || null;
  const subject = input.subject?.trim() || "(no title)";
  return {
    source: input.source,
    sourceId,
    client: input.client?.trim().toLowerCase() || clientFor({repo, site: input.site}),
    day: etDateKey(new Date(at)),
    at,
    endAt: endAt && endAt > at ? endAt : null,
    action: input.action.trim(),
    subject,
    detail: input.detail?.trim() || null,
    url: webUrl(input.url),
    repo,
    ticket: input.ticket?.trim().toUpperCase() || null,
  };
}

const SAME_FIELDS: Array<keyof JournalItem> =
  ["client", "day", "at", "endAt", "action", "subject", "detail", "url", "repo", "ticket"];

/** Store items, skipping ones already stored unchanged. */
export async function saveJournalItems(
  db: admin.firestore.Firestore,
  inputs: JournalItemInput[],
  options: {dryRun?: boolean} = {}
): Promise<SaveSummary> {
  const summary: SaveSummary = {
    dryRun: !!options.dryRun, read: inputs.length, added: 0, updated: 0, unchanged: 0, skipped: 0, days: [], byClient: {},
  };
  const items = new Map<string, JournalItem>();
  for (const input of inputs) {
    const item = toJournalItem(input);
    if (!item) {
      summary.skipped++;
      continue;
    }
    // A later reading of the same item (a longer session) replaces an earlier one.
    items.set(journalId(item.source, item.sourceId), item);
  }

  const col = db.collection("journal");
  const writes: Array<{id: string; item: JournalItem; isNew: boolean}> = [];
  const days = new Set<string>();
  for (const part of chunks([...items.keys()], 100)) {
    const snaps = await db.getAll(...part.map((id) => col.doc(id)));
    for (const snap of snaps) {
      const item = items.get(snap.id)!;
      summary.byClient[item.client] = (summary.byClient[item.client] ?? 0) + 1;
      const old = snap.data();
      if (old && SAME_FIELDS.every((f) => (old[f] ?? null) === item[f])) {
        summary.unchanged++;
        continue;
      }
      if (old) {
        summary.updated++;
        // A changed time can move an item to another day; both need rebuilding.
        if (typeof old["day"] === "string") days.add(old["day"]);
      } else {
        summary.added++;
      }
      days.add(item.day);
      writes.push({id: snap.id, item, isNew: !old});
    }
  }
  summary.days = [...days].sort();

  if (!options.dryRun) {
    for (const part of chunks(writes, BATCH_LIMIT)) {
      const batch = db.batch();
      for (const w of part) {
        batch.set(col.doc(w.id), {
          ...w.item,
          ...(w.isNew ? {createdAt: admin.firestore.FieldValue.serverTimestamp()} : {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }
      await batch.commit();
    }
  }
  return summary;
}

/**
 * Join items into work sessions: items less than GAP_MINUTES apart are one
 * session, from the first to the last, and no session is shorter than
 * MIN_SESSION_MINUTES. A Claude Code item, a meeting or a recording covers its own start to end.
 */
export function workSessions(items: Array<{at: string; endAt?: string | null}>): WorkSession[] {
  const spans = items
    .map((i) => {
      const start = Date.parse(i.at);
      const end = i.endAt ? Date.parse(i.endAt) : start;
      return {start, end: Number.isFinite(end) ? Math.max(start, end) : start};
    })
    .filter((s) => Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);

  const sessions: Array<{start: number; end: number; itemCount: number}> = [];
  for (const span of spans) {
    const last = sessions[sessions.length - 1];
    if (last && span.start - last.end <= GAP_MINUTES * 60_000) {
      last.end = Math.max(last.end, span.end);
      last.itemCount++;
    } else {
      sessions.push({...span, itemCount: 1});
    }
  }
  return sessions.map((s) => ({
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    minutes: Math.max(MIN_SESSION_MINUTES, Math.round((s.end - s.start) / 60_000)),
    itemCount: s.itemCount,
  }));
}

const sumMinutes = (sessions: WorkSession[]): number => sessions.reduce((n, s) => n + s.minutes, 0);

/** One day's summary from that day's items. */
export function summarizeDay(
  day: string,
  items: Array<Pick<JournalItem, "client" | "at" | "endAt">>,
  labels: ReadonlyMap<string, string> = CLIENT_LABELS
): JournalDay {
  const byClient = new Map<string, typeof items>();
  for (const item of items) {
    const list = byClient.get(item.client) ?? [];
    list.push(item);
    byClient.set(item.client, list);
  }
  const clients = [...byClient.entries()]
    .map(([client, list]) => {
      const sessions = workSessions(list);
      return {client, label: clientLabel(client, labels), minutes: sumMinutes(sessions), itemCount: list.length, sessions};
    })
    .sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
  return {day, totalMinutes: sumMinutes(workSessions(items)), itemCount: items.length, clients};
}

/** Rebuild the journalDays summary of each day; a day with no items left loses its summary. */
export async function summarizeDays(db: admin.firestore.Firestore, days: string[]): Promise<JournalDay[]> {
  const result: JournalDay[] = [];
  const labels = days.length ? await loadClientLabels(db) : CLIENT_LABELS;
  for (const day of [...new Set(days)]) {
    const snap = await db.collection("journal").where("day", "==", day).get();
    const ref = db.collection("journalDays").doc(day);
    if (snap.empty) {
      await ref.delete();
      continue;
    }
    const summary = summarizeDay(day, snap.docs.map((d) => d.data() as JournalItem), labels);
    await ref.set({...summary, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    result.push(summary);
  }
  return result;
}

export interface ReclassifySummary {
  dryRun: boolean;
  /** GitHub and Claude Code items looked at. */
  checked: number;
  /** Items whose client changed, or would change in a dry run. */
  changed: number;
  /** How many items moved from each client to each other client. */
  changes: Array<{from: string; to: string; count: number}>;
  /** The days whose summaries were rebuilt, or would be. */
  days: string[];
}

/**
 * Apply the current repo rules (REPO_CLIENTS, OWNER_CLIENTS) to the GitHub and
 * Claude Code items already in the journal, and rebuild the days that changed.
 * Run it after changing those rules: the job reads GitHub's last 300 events
 * only, so older items would otherwise keep their old client. Jira items,
 * meetings and recordings keep their client, because their rules need what
 * the job read at the time.
 */
export async function reclassifyJournal(
  db: admin.firestore.Firestore,
  options: {dryRun?: boolean} = {}
): Promise<ReclassifySummary> {
  const snap = await db.collection("journal").where("source", "in", ["github", "claude"]).get();
  const summary: ReclassifySummary = {dryRun: !!options.dryRun, checked: snap.size, changed: 0, changes: [], days: []};
  const writes: Array<{ref: admin.firestore.DocumentReference; client: string}> = [];
  const days = new Set<string>();
  for (const doc of snap.docs) {
    const item = doc.data() as JournalItem;
    const client = clientFor({repo: item.repo});
    if (client === item.client) continue;
    summary.changed++;
    const change = summary.changes.find((c) => c.from === item.client && c.to === client);
    if (change) change.count++;
    else summary.changes.push({from: item.client, to: client, count: 1});
    days.add(item.day);
    writes.push({ref: doc.ref, client});
  }
  summary.days = [...days].sort();

  if (!options.dryRun) {
    for (const part of chunks(writes, BATCH_LIMIT)) {
      const batch = db.batch();
      for (const w of part) batch.update(w.ref, {client: w.client, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      await batch.commit();
    }
    await summarizeDays(db, summary.days);
  }
  return summary;
}

// ─── get_journal ───────────────────────────────────────────────

const MAX_DAYS = 31;
const MAX_ITEMS = 300;

const hours = (minutes: number): number => Math.round(minutes / 6) / 10;

/** "9:21 AM", as it reads in Norwell. */
const etTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-US", {timeZone: ET_ZONE, hour: "numeric", minute: "2-digit"});

export interface GetJournalInput {
  start_date?: string;
  end_date?: string;
  days_back?: number;
  client?: string;
}

/** The journal for a range of days: estimated hours per client and day, and each item. */
export async function getJournal(
  db: admin.firestore.Firestore,
  input: GetJournalInput,
  now = new Date()
): Promise<Record<string, unknown>> {
  const today = etDateKey(now);
  const isDay = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if ((input.start_date && !isDay(input.start_date)) || (input.end_date && !isDay(input.end_date))) {
    return {success: false, error: "Dates must be YYYY-MM-DD."};
  }
  // A start date on its own means that one day: "what did I do on Monday?"
  const endDate = input.end_date ?? input.start_date ?? today;
  const startDate = input.start_date ?? addDaysToKey(endDate, -Math.max(0, Math.floor(input.days_back ?? 0)));
  if (startDate > endDate) return {success: false, error: "start_date is after end_date."};
  if (startDate < addDaysToKey(endDate, -(MAX_DAYS - 1))) {
    return {success: false, error: `Ask for ${MAX_DAYS} days or fewer at a time.`};
  }
  const client = input.client?.trim().toLowerCase() || null;

  const [daySnap, itemSnap, labels] = await Promise.all([
    db.collection("journalDays").where("day", ">=", startDate).where("day", "<=", endDate).get(),
    db.collection("journal").where("day", ">=", startDate).where("day", "<=", endDate).get(),
    loadClientLabels(db),
  ]);

  const days = daySnap.docs
    .map((d) => d.data() as JournalDay)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => {
      const clients = d.clients.filter((c) => !client || c.client === client);
      return {
        day: d.day,
        estimatedHours: client ? hours(clients.reduce((n, c) => n + c.minutes, 0)) : hours(d.totalMinutes),
        clients: clients.map((c) => ({
          client: c.client,
          label: c.label,
          estimatedHours: hours(c.minutes),
          itemCount: c.itemCount,
          sessions: c.sessions.map((s) =>
            `${etTime(s.start)}–${etTime(s.end)} (${hours(s.minutes)} h, ${s.itemCount} item${s.itemCount === 1 ? "" : "s"})`),
        })),
      };
    })
    .filter((d) => d.clients.length > 0);

  const totals = new Map<string, {label: string; minutes: number; itemCount: number}>();
  for (const d of daySnap.docs.map((x) => x.data() as JournalDay)) {
    for (const c of d.clients) {
      if (client && c.client !== client) continue;
      const t = totals.get(c.client) ?? {label: c.label, minutes: 0, itemCount: 0};
      t.minutes += c.minutes;
      t.itemCount += c.itemCount;
      totals.set(c.client, t);
    }
  }

  const items = itemSnap.docs
    .map((d) => d.data() as JournalItem)
    .filter((i) => !client || i.client === client)
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    dateRange: {startDate, endDate},
    note: "Hours are estimates: items less than 20 minutes apart count as one work session, " +
      "from the first item to the last, and a session counts for at least 6 minutes. " +
      "The journal is collected on Jack's Mac every 15 minutes from GitHub, Jira, Claude Code, the " +
      "meetings on his Jax and IHRDC calendars and the meetings he recorded in Wispr Flow; a meeting " +
      "counts for its scheduled length, and a recording for the time it was recording.",
    clients: [...totals.entries()]
      .map(([key, t]) => ({client: key, label: t.label, estimatedHours: hours(t.minutes), itemCount: t.itemCount}))
      .sort((a, b) => b.estimatedHours - a.estimatedHours),
    days,
    itemCount: items.length,
    items: items.slice(0, MAX_ITEMS).map((i) => ({
      day: i.day,
      time: i.endAt ? `${etTime(i.at)}–${etTime(i.endAt)}` : etTime(i.at),
      client: clientLabel(i.client, labels),
      source: i.source,
      action: i.action,
      subject: i.subject,
      detail: i.detail,
      ticket: i.ticket,
      repo: i.repo,
      url: i.url,
    })),
    ...(items.length > MAX_ITEMS ? {itemsLeftOut: items.length - MAX_ITEMS} : {}),
  };
}
