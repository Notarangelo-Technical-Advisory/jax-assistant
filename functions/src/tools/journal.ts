import * as admin from "firebase-admin";
import {createHash} from "crypto";
import {ET_ZONE, addDaysToKey, etDateKey} from "../et-time";
import {DEFAULT_CATEGORIES} from "./definitions";

// ─── Work journal ──────────────────────────────────────────────
//
// A record of what Jack did and when, and for which client, so he can account
// for work done a few minutes at a time across a day. The readers live on
// Jack's Mac (src/mcp/collect-journal.ts), because the gh login, the Jira token
// in the Keychain, Claude Code's session files, Apple Calendar, Apple Mail and
// Wispr Flow's database are only there. This file decides the client, stores the items and estimates the time,
// so the rules are tested against the emulator.
//
// - Each item has a fixed id made from its source and the source's own id, so
//   a second run finds it and writes nothing.
// - The client comes from where the work happened: the GitHub repo or its
//   owner, the Jira site, or the repo a Claude Code session ran in. A meeting's
//   client comes from the people invited, its calendar or words in its title,
//   and a meeting with no client is left out (see meetingClient). A recording's
//   client comes from the meeting it overlaps or its title (see
//   recordingItems). An email's client comes from the people it went to or
//   its subject (see emailItems). Clients are the task categories, so the journal and the
//   task list use the same names.
// - Jack can move items to another client on the journal page (see
//   moveJournalItems). A moved item keeps the client he chose: the journal job
//   and reclassifyJournal no longer change it.
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
  // Jack's own business: nta-time-tracker, engineering-standards, fractional-tech-advisory and so on.
  "notarangelo-technical-advisory": "nta",
};

/** Jira sites and their client. */
export const JIRA_SITE_CLIENTS: Record<string, string> = {
  "ihrdcdev.atlassian.net": "ihrdc",
};

/** Calendars whose meetings all belong to one client, by the label in apple-meetings.ts. */
const CALENDAR_CLIENTS: Record<string, string> = {
  "IHRDC": "ihrdc",
};

/** Email domains whose people make a meeting or an email that client's. Keys are lower case. */
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
 * recording's title, or in work that would otherwise be General, gives that
 * client. Other keys are ignored, because a title can hold look-alikes such as UTF-8.
 */
const JIRA_PROJECT_CLIENTS: Record<string, string> = {
  "CNG": "ihrdc",
  "THREEX": "ihrdc",
  "ITSP": "ihrdc",
};

/**
 * Words that give work its client when where it happened gives none, such as
 * a Claude Code session started outside any repo. Matched as whole words,
 * ignoring case and punctuation, in the title, the action and the detail.
 */
const TEXT_CLIENTS: Array<{words: string; client: string}> = [
  {words: "Jira", client: "ihrdc"},
  {words: "Aishwarya", client: "ihrdc"},
  {words: "QA test agent", client: "ihrdc"},
  {words: "QA testing agent", client: "ihrdc"},
  {words: "Bug fixer agent", client: "ihrdc"},
  {words: "Bible study", client: "church"},
  {words: "Bible studies", client: "church"},
  {words: "Ecclesiastes", client: "church"},
];

export type JournalSource = "github" | "jira" | "claude" | "meeting" | "recording" | "email";

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
  /** Meetings, recordings and emails: the client their rules chose. Other sources get theirs from where the work happened. */
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

/**
 * An email Jack sent, as the reader on the Mac finds it. Only the subject and
 * the recipients' domains reach the journal; the body is never read.
 */
export interface SentEmail {
  /** Mail's message id. */
  id: string;
  subject: string;
  /** ISO timestamp. */
  sentAt: string;
  /** Addresses in To and Cc. */
  recipients: string[];
}

/** Sent emails read, and how many were left out. */
export interface EmailItems {
  items: JournalItemInput[];
  read: number;
  noClient: number;
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
  /** True when Jack moved the item to its client himself; nothing changes that client again. */
  clientByHand?: boolean;
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

/** The first key in `text` from a project in JIRA_PROJECT_CLIENTS, such as CNG-6882, with its client. */
export function jiraKeyIn(text: string): {key: string; client: string} | null {
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d+)(?![A-Za-z0-9])/g)) {
    const project = m[1].toUpperCase();
    if (JIRA_PROJECT_CLIENTS[project]) return {key: `${project}-${m[2]}`, client: JIRA_PROJECT_CLIENTS[project]};
  }
  return null;
}

/**
 * The client an item's own words give it: a Jira key from JIRA_PROJECT_CLIENTS,
 * then a word from TEXT_CLIENTS. Null when they give none.
 */
export function clientFromText(...texts: Array<string | null | undefined>): string | null {
  const text = texts.filter(Boolean).join(" ");
  const key = jiraKeyIn(text);
  if (key) return key.client;
  const words = wordsOf(text);
  return TEXT_CLIENTS.find((t) => words.includes(wordsOf(t.words)))?.client ?? null;
}

/**
 * The client of a GitHub, Jira or Claude Code item: from where the work
 * happened, and when that gives only General, from the item's own words.
 */
export function itemClient(item: {
  repo?: string | null; site?: string | null; subject?: string | null; action?: string | null;
  detail?: string | null; ticket?: string | null;
}): string {
  const client = clientFor(item);
  if (client !== DEFAULT_CLIENT) return client;
  return clientFromText(item.ticket, item.subject, item.action, item.detail) ?? client;
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
    const ticket = jiraKeyIn(r.title);

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

const domainOf = (address: string): string => address.split("@")[1]?.trim().toLowerCase() ?? "";

/**
 * The journal items for emails Jack sent. An email gets its client from the
 * first of these that applies, and is left out when none does, so personal
 * email is not counted:
 *
 * - someone it went to has a domain in DOMAIN_CLIENTS (Jack's own addresses
 *   are ignored);
 * - a Jira key from one of JIRA_PROJECT_CLIENTS in its subject;
 * - a word from MEETING_WORDS or TEXT_CLIENTS in its subject.
 *
 * An email is a moment, not a span: it counts for MIN_SESSION_MINUTES on its
 * own, and joins the work around it into one session when it is near.
 */
export function emailItems(emails: SentEmail[], ownAddresses: string[] = []): EmailItems {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  const result: EmailItems = {items: [], read: emails.length, noClient: 0};
  for (const e of emails) {
    const others = [...new Set(e.recipients.map((a) => a.trim().toLowerCase()).filter((a) => a && !own.has(a)))];
    const domain = others.map(domainOf).find((d) => DOMAIN_CLIENTS[d]);
    const ticket = jiraKeyIn(e.subject);
    const word = titleWords(e.subject) ?? TEXT_CLIENTS.find((t) => wordsOf(e.subject).includes(wordsOf(t.words)));

    const chosen = domain ? {client: DOMAIN_CLIENTS[domain], detail: `To ${domain}`} :
      ticket ? {client: ticket.client, detail: `${ticket.key} in the subject`} :
        word ? {client: word.client, detail: `${word.words} in the subject`} : null;
    if (!chosen) {
      result.noClient++;
      continue;
    }
    result.items.push({
      source: "email",
      sourceId: e.id,
      at: e.sentAt,
      action: others.length ? `Sent email to ${others.length} ${others.length === 1 ? "person" : "people"}` : "Sent email",
      subject: e.subject.trim() || "(no subject)",
      detail: chosen.detail,
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
    client: input.client?.trim().toLowerCase() ||
      itemClient({repo, site: input.site, subject, action: input.action, detail: input.detail, ticket: input.ticket}),
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
      const old = snap.data();
      // Jack moved it himself: his client stands, whatever the rules now say.
      if (old?.["clientByHand"] === true && typeof old["client"] === "string") item.client = old["client"];
      summary.byClient[item.client] = (summary.byClient[item.client] ?? 0) + 1;
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

export interface WorkBreak {
  start: string;
  end: string;
  minutes: number;
}

/**
 * The breaks in a day: each gap of more than GAP_MINUTES between one stretch
 * of work, for any client, and the next. A session counts for at least
 * MIN_SESSION_MINUTES from its start, as it does in the hours.
 */
export function dayBreaks(day: Pick<JournalDay, "clients">): WorkBreak[] {
  const spans = day.clients
    .flatMap((c) => c.sessions)
    .map((s) => {
      const start = Date.parse(s.start);
      return {start, end: Math.max(Date.parse(s.end), start + s.minutes * 60_000)};
    })
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);

  const breaks: WorkBreak[] = [];
  let workedTo: number | null = null;
  for (const span of spans) {
    if (workedTo !== null && span.start - workedTo > GAP_MINUTES * 60_000) {
      breaks.push({
        start: new Date(workedTo).toISOString(),
        end: new Date(span.start).toISOString(),
        minutes: Math.round((span.start - workedTo) / 60_000),
      });
    }
    workedTo = Math.max(workedTo ?? span.end, span.end);
  }
  return breaks;
}

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
  /** Claude Code items that were given a repo they had none of, or would be in a dry run. */
  reposFilled: number;
  /** Items Jack moved himself whose client the rules would change; they keep his client. */
  keptByHand: number;
  /** How many items moved from each client to each other client. */
  changes: Array<{from: string; to: string; count: number}>;
  /** The days whose summaries were rebuilt, or would be. */
  days: string[];
}

/**
 * Apply the current rules for where work happened and for its words
 * (REPO_CLIENTS, OWNER_CLIENTS, JIRA_PROJECT_CLIENTS, TEXT_CLIENTS) to the
 * GitHub and Claude Code items already in the journal, and rebuild the days
 * that changed. Run it after changing those rules: the job reads GitHub's last
 * 300 events only, so older items would otherwise keep their old client. Jira items,
 * meetings and recordings keep their client, because their rules need what
 * the job read at the time. Items Jack moved himself keep his client.
 */
export async function reclassifyJournal(
  db: admin.firestore.Firestore,
  options: {dryRun?: boolean; claudeRepos?: ReadonlyMap<string, {repo: string; action: string}>} = {}
): Promise<ReclassifySummary> {
  const snap = await db.collection("journal").where("source", "in", ["github", "claude"]).get();
  const summary: ReclassifySummary = {
    dryRun: !!options.dryRun, checked: snap.size, changed: 0, reposFilled: 0, keptByHand: 0, changes: [], days: [],
  };
  const writes: Array<{ref: admin.firestore.DocumentReference; fields: Partial<JournalItem>}> = [];
  const days = new Set<string>();
  for (const doc of snap.docs) {
    const stored = doc.data() as JournalItem;
    const found = stored.source === "claude" ? options.claudeRepos?.get(doc.id) : undefined;
    const item = found && found.repo !== stored.repo ? {...stored, repo: found.repo, action: found.action} : stored;
    let client = itemClient(item);
    if (stored.clientByHand && client !== stored.client) {
      summary.keptByHand++;
      client = stored.client;
    }
    if (client === stored.client && item === stored) continue;
    const fields: Partial<JournalItem> = {};
    if (item !== stored) {
      summary.reposFilled++;
      fields.repo = item.repo;
      fields.action = item.action;
    }
    if (client !== stored.client) {
      summary.changed++;
      const change = summary.changes.find((c) => c.from === stored.client && c.to === client);
      if (change) change.count++;
      else summary.changes.push({from: stored.client, to: client, count: 1});
      fields.client = client;
    }
    days.add(stored.day);
    writes.push({ref: doc.ref, fields});
  }
  summary.days = [...days].sort();

  if (!options.dryRun) {
    for (const part of chunks(writes, BATCH_LIMIT)) {
      const batch = db.batch();
      for (const w of part) batch.update(w.ref, {...w.fields, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      await batch.commit();
    }
    await summarizeDays(db, summary.days);
  }
  return summary;
}

// ─── Moving items to another client ────────────────────────────

/** The most items one move takes: more than a busy day holds. */
export const MAX_MOVE_ITEMS = 500;

export interface MoveJournalItemsInput {
  /** Journal item ids, as the page reads them. */
  ids?: unknown;
  /** The task category key to move them to, such as "ihrdc". */
  client?: unknown;
}

/**
 * Move items to another client, because the rules chose the wrong one: work
 * in the NTA repo that was for IHRDC, for example. Each item is marked as moved
 * by hand, so the journal job and reclassifyJournal keep Jack's choice, and the
 * days the items are on are rebuilt so their hours follow. The journal page
 * (the journalItems function) and the move_journal_items tool both use it.
 */
export async function moveJournalItems(
  db: admin.firestore.Firestore,
  input: MoveJournalItemsInput
): Promise<Record<string, unknown>> {
  const ids = Array.isArray(input.ids) ?
    [...new Set(input.ids.filter((id): id is string => typeof id === "string" && id.trim() !== ""))] : [];
  if (ids.length === 0) return {success: false, error: "Choose at least one item to move."};
  if (ids.length > MAX_MOVE_ITEMS) return {success: false, error: `Move at most ${MAX_MOVE_ITEMS} items at a time.`};
  const client = typeof input.client === "string" ? input.client.trim().toLowerCase() : "";
  const labels = await loadClientLabels(db);
  if (!labels.has(client)) return {success: false, error: "Choose a client from the task categories."};

  const col = db.collection("journal");
  const snaps = await db.getAll(...ids.map((id) => col.doc(id)));
  const missing = snaps.filter((s) => !s.exists).length;
  if (missing) {
    return {success: false, error: `${missing} of these items ${missing === 1 ? "is" : "are"} no longer in the journal. Reload the page and try again.`};
  }

  const toMove = snaps.filter((s) => s.get("client") !== client || s.get("clientByHand") !== true);
  const days = new Set<string>();
  for (const part of chunks(toMove, BATCH_LIMIT)) {
    const batch = db.batch();
    for (const snap of part) {
      batch.update(snap.ref, {client, clientByHand: true, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      days.add(snap.get("day"));
    }
    await batch.commit();
  }
  await summarizeDays(db, [...days]);
  return {success: true, moved: toMove.length, client, label: clientLabel(client, labels), days: [...days].sort()};
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
      const sessions = d.clients.flatMap((c) => c.sessions);
      const starts = sessions.map((s) => s.start).sort();
      const ends = sessions.map((s) => s.end).sort();
      const breaks = dayBreaks(d);
      return {
        day: d.day,
        // When Jack was working, for any client, even when one client is asked for.
        ...(starts.length ? {workedFrom: etTime(starts[0]), workedTo: etTime(ends[ends.length - 1])} : {}),
        breaks: breaks.map((b) => `${etTime(b.start)}–${etTime(b.end)} (${hours(b.minutes)} h)`),
        longestBreakHours: hours(Math.max(0, ...breaks.map((b) => b.minutes))),
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
    .map((d) => ({id: d.id, ...(d.data() as JournalItem)}))
    .filter((i) => !client || i.client === client)
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    dateRange: {startDate, endDate},
    note: "Hours are estimates: items less than 20 minutes apart count as one work session, " +
      "from the first item to the last, and a session counts for at least 6 minutes. " +
      "The journal is collected on Jack's Mac every 15 minutes from GitHub, Jira, Claude Code, the " +
      "meetings on his Jax and IHRDC calendars, the meetings he recorded in Wispr Flow and the emails he " +
      "sent from Apple Mail to a client; a meeting counts for its scheduled length, a recording for the " +
      "time it was recording, and an email for the moment it was sent.",
    clients: [...totals.entries()]
      .map(([key, t]) => ({client: key, label: t.label, estimatedHours: hours(t.minutes), itemCount: t.itemCount}))
      .sort((a, b) => b.estimatedHours - a.estimatedHours),
    days,
    itemCount: items.length,
    items: items.slice(0, MAX_ITEMS).map((i) => ({
      id: i.id,
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
      ...(i.clientByHand ? {movedByHand: true} : {}),
    })),
    ...(items.length > MAX_ITEMS ? {itemsLeftOut: items.length - MAX_ITEMS} : {}),
  };
}
