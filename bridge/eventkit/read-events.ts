/**
 * Calendar reads, via EventKit.
 *
 * Why not AppleScript, like the writes in `applescript/calendar.ts`?
 *
 * Calendar.app's scripting dictionary has no concept of a recurring
 * *occurrence*. A weekly meeting is one event object whose `start date` is the
 * date of the FIRST occurrence, so the obvious query —
 *
 *     every event of cal whose start date ≥ windowStart and start date < windowEnd
 *
 * — compares this week's window against a start date that may be months in the
 * past, and the entire series vanishes from the read. That is not an edge case:
 * it silently hid every standing meeting on every calendar, which is most of
 * them. A whole week came back with four events and read as a quiet week.
 *
 * EventKit's `predicateForEvents(withStart:end:calendars:)` expands series into
 * real occurrences, honouring EXDATEs and detached overrides, which is exactly
 * the primitive AppleScript lacks. It also hands back `occurrenceDate` (the
 * iCalendar RECURRENCE-ID), so a single dragged occurrence can be recognised as
 * a reschedule rather than a delete plus a create.
 *
 * The cost is a second TCC bucket. AppleScript needs Automation permission to
 * drive Calendar.app; EventKit needs Full Access to Calendars for the
 * responsible process. The two are granted separately, and a process holding
 * only write-only access sees exactly one calendar and no error — the same
 * silent under-report we are fixing. So `readEvents` throws when access is not
 * full. An empty array must only ever mean "nothing is scheduled".
 */

import { runJxa } from "../applescript/run.js";

/**
 * Calendars MAISIE reads, as an explicit allowlist.
 *
 * This list is editorial, not a visibility workaround. EventKit does expose
 * `calendarIdentifier`, so the UUIDs in `defaults read com.apple.iCal
 * DisabledCalendars` could now be resolved to names and the unchecked
 * calendars filtered automatically — but "unchecked in Calendar.app" is not the
 * distinction that matters here. Birthdays, Siri Suggestions, Scheduled
 * Reminders and the three redundant US holiday calendars are all enabled and
 * all noise in a briefing. Naming what MAISIE reads keeps that judgement in one
 * reviewable place.
 *
 * `label` is what MAISIE calls the calendar. It exists mainly because Exchange
 * names its default calendar "Calendar", which is meaningless in a sentence.
 *
 * A name here that matches no calendar drops that calendar's entire contents,
 * so the reader reports unmatched names as `missingCalendars` rather than
 * skipping them quietly — see the note on `CalendarRead`.
 */
export const READ_CALENDARS: Array<{name: string; label: string}> = [
  {name: "Jax", label: "Jax"},
  {name: "Calendar", label: "IHRDC"},
  {name: "Home", label: "Home"},
  {name: "Family", label: "Family"},
  {name: "Grace Presbyterian Church: Jack Notarangelo", label: "Grace Pres"},
  {name: "jack@gracesouthshore.org", label: "Grace Pres (email)"},
  {name: "jacknota1964@gmail.com", label: "Gmail"},
];

export interface ParsedEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  location: string;
  notes: string;
  /** Friendly label of the source calendar, from READ_CALENDARS. */
  calendarName: string;
  /**
   * The iCalendar UID (EventKit's `calendarItemExternalIdentifier`). Survives a
   * reschedule. Series-level: every occurrence of a recurring event shares one,
   * so pair it with `occurrenceTime` to identify a single occurrence.
   *
   * Empty string when EventKit declines to supply one; callers must fall back
   * to content-based identity in that case.
   */
  uid: string;
  /** True when this occurrence belongs to a recurring series. */
  recurring: boolean;
  /**
   * True for an all-day event. `startTime` is local midnight and `endTime` is
   * the end of the last day — the clock times carry no meaning, so present the
   * event as "all day" rather than as a midnight appointment.
   */
  allDay: boolean;
  /**
   * The RECURRENCE-ID: the slot in the series this occurrence occupies. It does
   * NOT move when the occurrence is dragged elsewhere, which is what makes it
   * usable as stable per-occurrence identity. Null for a single event.
   */
  occurrenceTime: Date | null;
  /** EventKit's own identifier for this occurrence. Diagnostic. */
  eventId: string;
  /** Stable UUID of the source calendar. Diagnostic. */
  calendarId: string;
  /**
   * EventKit's EKEventStatus: 0 none, 1 confirmed, 2 tentative, 3 cancelled.
   * Deliberately not filtered — under-reporting is the failure mode this module
   * exists to prevent, so a cancelled-but-still-present event is surfaced and
   * the caller decides.
   */
  status: number;
}

export interface CalendarRead {
  /** Occurrences inside the window, sorted by start time across calendars. */
  events: ParsedEvent[];
  /**
   * Allowlisted names that matched no calendar on this Mac — a renamed or
   * removed calendar silently drops everything on it, so callers should surface
   * this rather than swallow it.
   */
  missingCalendars: string[];
  /** Inclusive start of the window actually read (local midnight). */
  windowStart: Date;
  /** Exclusive end of the window actually read (local midnight). */
  windowEnd: Date;
}

/** Thrown when the read could not be completed. Never confuse this with "no events". */
export class CalendarReadError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CalendarReadError";
  }
}

// ─── Window ──────────────────────────────────────────────────────

/** Local midnight of the day `d` falls in. */
function localMidnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}

/**
 * Add whole local days. Uses setDate rather than millisecond arithmetic so a
 * DST boundary inside the window does not shift the far end by an hour and
 * clip or duplicate a day.
 */
function addLocalDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * The window a `daysAhead` read covers: local midnight today through local
 * midnight `daysAhead` days later. So 1 is today, 2 is today and tomorrow.
 *
 * It starts at midnight, not at `current date`. The old reader started at the
 * moment of the call, which meant a 9am meeting disappeared from "today" at
 * 9:01 and an all-day event today — start time local midnight — was never
 * returned at all.
 */
export function readWindow(daysAhead: number, now = new Date()): { start: Date; end: Date } {
  const start = localMidnight(now);
  return { start, end: addLocalDays(start, Math.max(1, Math.floor(daysAhead))) };
}

// ─── Script ──────────────────────────────────────────────────────

interface JxaConfig {
  startEpoch: number;
  endEpoch: number;
  calendars: string[];
}

/**
 * Embed a value as a JS literal inside generated source. JSON.stringify leaves
 * U+2028/U+2029 raw, and those are not legal inside a JavaScript string.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * JXA, not AppleScript — EventKit is reachable from the ObjC bridge, and
 * `osascript -l JavaScript` is already the shape of every other desktop call
 * here.
 *
 * Config is interpolated rather than passed as argv so there is one text blob
 * to hand to osascript and no argument-splitting semantics to depend on.
 *
 * Output is JSON on stdout. The previous reader packed fields into a `|||`
 * delimited string with a sentinel record separator, because event notes are
 * routinely ten-line Teams invites and splitting on linefeed shredded them.
 * JSON removes that whole class of problem.
 */
export function readEventsScript(daysAhead: number, calendars = READ_CALENDARS, now = new Date()): string {
  const { start, end } = readWindow(daysAhead, now);
  const config: JxaConfig = {
    startEpoch: Math.floor(start.getTime() / 1000),
    endEpoch: Math.floor(end.getTime() / 1000),
    calendars: calendars.map((c) => c.name),
  };

  return `
ObjC.import('EventKit');
ObjC.import('Foundation');

var CONFIG = ${jsLiteral(config)};

var EK_ENTITY_EVENT = 0;
var EK_FULL_ACCESS = 3;

/** ObjC string or nil to a plain JS string. */
function str(v) {
  if (v === undefined || v === null) return '';
  var s = ObjC.unwrap(v);
  return (s === undefined || s === null) ? '' : String(s);
}

/** NSDate or nil to epoch seconds or null. */
function epoch(d) {
  if (d === undefined || d === null) return null;
  var t = Number(d.timeIntervalSince1970);
  return isFinite(t) ? t : null;
}

/**
 * Bridged ObjC scalars are not strictly equal to JS primitives — an
 * authorization status that prints as 3 still fails \`=== 3\`. Coerce before
 * every comparison.
 */
function num(v) {
  return Number(v);
}

/**
 * Reach full access, or report what we are stuck at.
 *
 * The completion handler passed to requestFullAccessToEventsWithCompletion does
 * not fire under osascript — the block never gets called back into JXA. The
 * request itself does take effect, so the authorization status is polled
 * instead of waiting on the callback. Spinning the run loop between polls is
 * what lets the grant land.
 */
function ensureAccess() {
  var status = num($.EKEventStore.authorizationStatusForEntityType(EK_ENTITY_EVENT));
  if (status === EK_FULL_ACCESS) return status;

  var store = $.EKEventStore.alloc.init;
  try {
    // macOS 14+.
    store.requestFullAccessToEventsWithCompletion(function () {});
  } catch (e) {
    try {
      store.requestAccessToEntityTypeCompletion(EK_ENTITY_EVENT, function () {});
    } catch (e2) { /* nothing else to try — the status poll below reports it */ }
  }

  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(20);
  while (num($.NSDate.date.timeIntervalSinceDate(deadline)) < 0) {
    status = num($.EKEventStore.authorizationStatusForEntityType(EK_ENTITY_EVENT));
    if (status === EK_FULL_ACCESS) return status;
    $.NSRunLoop.currentRunLoop.runModeBeforeDate(
      $.NSDefaultRunLoopMode,
      $.NSDate.dateWithTimeIntervalSinceNow(0.2)
    );
  }
  return status;
}

function run() {
  var status = ensureAccess();
  if (status !== EK_FULL_ACCESS) {
    return JSON.stringify({ ok: false, error: 'no_calendar_access', status: status });
  }

  var store = $.EKEventStore.alloc.init;
  var all = ObjC.unwrap(store.calendarsForEntityType(EK_ENTITY_EVENT)) || [];

  // Two accounts can expose calendars with the same title; keep both.
  var byTitle = {};
  all.forEach(function (c) {
    var t = str(c.title);
    if (!byTitle[t]) byTitle[t] = [];
    byTitle[t].push(c);
  });

  var picked = $.NSMutableArray.alloc.init;
  var missing = [];
  CONFIG.calendars.forEach(function (name) {
    var hits = byTitle[name];
    if (!hits || hits.length === 0) { missing.push(name); return; }
    hits.forEach(function (c) { picked.addObject(c); });
  });

  if (num(picked.count) === 0) {
    return JSON.stringify({
      ok: false,
      error: 'no_calendars_matched',
      missing: missing,
      available: Object.keys(byTitle)
    });
  }

  var predicate = store.predicateForEventsWithStartDateEndDateCalendars(
    $.NSDate.dateWithTimeIntervalSince1970(CONFIG.startEpoch),
    $.NSDate.dateWithTimeIntervalSince1970(CONFIG.endEpoch),
    picked
  );

  var events = (ObjC.unwrap(store.eventsMatchingPredicate(predicate)) || []).map(function (e) {
    return {
      calendar: str(e.calendar.title),
      calendarId: str(e.calendar.calendarIdentifier),
      summary: str(e.title),
      start: epoch(e.startDate),
      end: epoch(e.endDate),
      allDay: e.isAllDay ? true : false,
      location: str(e.location),
      notes: str(e.notes),
      uid: str(e.calendarItemExternalIdentifier),
      eventId: str(e.eventIdentifier),
      recurring: e.hasRecurrenceRules ? true : false,
      occurrence: epoch(e.occurrenceDate),
      status: num(e.status) || 0
    };
  });

  return JSON.stringify({ ok: true, missing: missing, events: events });
}
`.trim();
}

// ─── Read ────────────────────────────────────────────────────────

interface JxaEvent {
  calendar: string;
  calendarId: string;
  summary: string;
  start: number | null;
  end: number | null;
  allDay: boolean;
  location: string;
  notes: string;
  uid: string;
  eventId: string;
  recurring: boolean;
  occurrence: number | null;
  status: number;
}

type JxaResult =
  | { ok: true; missing: string[]; events: JxaEvent[] }
  | { ok: false; error: string; status?: number; missing?: string[]; available?: string[] };

/**
 * Read every occurrence on the allowlisted calendars from local midnight today
 * through `daysAhead` days out. Reads the live calendar database, so it does
 * not depend on the Firestore mirror being fresh.
 *
 * Throws CalendarReadError rather than returning an empty result when the read
 * fails. Callers rely on that distinction: `calendar-sync` deletes every
 * Firestore document that a read does not return, so a silent empty read would
 * wipe the mirror.
 */
export function readEvents(daysAhead: number): CalendarRead {
  const { start, end } = readWindow(daysAhead);

  let raw: string;
  try {
    // Seven calendars, and Exchange can be slow to answer — give it room.
    raw = runJxa(readEventsScript(daysAhead), 120000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CalendarReadError(`osascript failed: ${message}`, "osascript_failed");
  }

  if (!raw) throw new CalendarReadError("Calendar read returned no output.", "empty_output");

  let result: JxaResult;
  try {
    result = JSON.parse(raw) as JxaResult;
  } catch {
    throw new CalendarReadError(`Calendar read returned unparseable output: ${raw.slice(0, 400)}`, "bad_output");
  }

  if (!result.ok) {
    if (result.error === "no_calendar_access") {
      throw new CalendarReadError(
        `EventKit calendar access is not granted (EKAuthorizationStatus ${result.status}; ` +
          "0 undetermined, 1 restricted, 2 denied, 4 write-only). Grant Full Access under " +
          "System Settings > Privacy & Security > Calendars for the app running this process, " +
          "then run `npm run desktop` once from a terminal.",
        "no_calendar_access"
      );
    }
    if (result.error === "no_calendars_matched") {
      throw new CalendarReadError(
        `None of the allowlisted calendars exist. Looked for: ${(result.missing ?? []).join(", ")}. ` +
          `Available: ${(result.available ?? []).join(", ")}.`,
        "no_calendars_matched"
      );
    }
    throw new CalendarReadError(`Calendar read failed: ${result.error}`, result.error);
  }

  const labelFor = new Map(READ_CALENDARS.map((c) => [c.name, c.label]));

  const events = result.events
    .map((e): ParsedEvent => ({
      calendarName: labelFor.get(e.calendar) ?? e.calendar,
      calendarId: e.calendarId,
      summary: e.summary.trim() || "Untitled",
      startTime: e.start === null ? new Date(NaN) : new Date(e.start * 1000),
      endTime: e.end === null ? new Date(NaN) : new Date(e.end * 1000),
      allDay: e.allDay,
      location: e.location.trim(),
      notes: e.notes.replace(/\r\n?/g, "\n").trim(),
      uid: e.uid.trim(),
      eventId: e.eventId.trim(),
      recurring: e.recurring,
      occurrenceTime: e.occurrence === null ? null : new Date(e.occurrence * 1000),
      status: e.status,
    }))
    .filter((e) => !isNaN(e.startTime.getTime()))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return { events, missingCalendars: result.missing ?? [], windowStart: start, windowEnd: end };
}
