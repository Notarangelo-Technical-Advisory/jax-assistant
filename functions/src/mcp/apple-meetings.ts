/**
 * Read meetings and their attendees from the Jax and IHRDC calendars on Jack's
 * Mac, via EventKit, for automatic contact linking (CRM Phase 4).
 *
 * Same approach as bridge/eventkit/read-events.ts, which feeds the calendar
 * mirror: JXA through osascript, JSON on stdout, and an explicit error instead
 * of an empty list when access is missing. That reader does not return
 * attendees, and the bridge is an ES module package this CommonJS code cannot
 * import, so this is a separate, smaller reader.
 *
 * Permission: Full Access to Calendars for the process running this, under
 * System Settings > Privacy & Security > Calendars.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {AutoLinkItem} from "../tools/contact-autolink";

/** Jack chose work calendars only. `name` is EventKit's title; Exchange calls IHRDC's "Calendar". */
export const MEETING_CALENDARS: Array<{name: string; label: string}> = [
  {name: "Jax", label: "Jax"},
  {name: "Calendar", label: "IHRDC"},
];

export class AppleMeetingsError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AppleMeetingsError";
  }
}

export function readMeetingsScript(start: Date, end: Date): string {
  const config = JSON.stringify({
    calendars: MEETING_CALENDARS.map((c) => c.name),
    startEpoch: start.getTime() / 1000,
    endEpoch: end.getTime() / 1000,
  });
  return `
ObjC.import('EventKit');
ObjC.import('Foundation');

var CONFIG = ${config};
var EK_ENTITY_EVENT = 0;
var EK_FULL_ACCESS = 3;
var EK_STATUS_CANCELED = 3;
var EK_PARTICIPANT_ROOM = 2;
var EK_PARTICIPANT_RESOURCE = 3;

function str(v) {
  if (v === undefined || v === null) return '';
  var s = ObjC.unwrap(v);
  return (s === undefined || s === null) ? '' : String(s);
}
function num(v) { return Number(v); }

/** Ask once, then poll: the completion handler does not fire under osascript. */
function ensureAccess() {
  var status = num($.EKEventStore.authorizationStatusForEntityType(EK_ENTITY_EVENT));
  if (status === EK_FULL_ACCESS) return status;
  var store = $.EKEventStore.alloc.init;
  try { store.requestFullAccessToEventsWithCompletion(function () {}); } catch (e) {}
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(20);
  while (num($.NSDate.date.timeIntervalSinceDate(deadline)) < 0) {
    status = num($.EKEventStore.authorizationStatusForEntityType(EK_ENTITY_EVENT));
    if (status === EK_FULL_ACCESS) return status;
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
  return status;
}

/** A person's address, or '' for Jack himself, a room, a resource or a non-mailto URL. */
function address(p) {
  if (!p || p.isNil()) return '';
  if (p.isCurrentUser) return '';
  var type = num(p.participantType);
  if (type === EK_PARTICIPANT_ROOM || type === EK_PARTICIPANT_RESOURCE) return '';
  var url = str(p.URL.absoluteString);
  return /^mailto:/i.test(url) ? decodeURIComponent(url.slice(7)) : '';
}

function run() {
  var status = ensureAccess();
  if (status !== EK_FULL_ACCESS) return JSON.stringify({ ok: false, error: 'no_calendar_access', status: status });

  var store = $.EKEventStore.alloc.init;
  var picked = $.NSMutableArray.alloc.init;
  var found = {};
  (ObjC.unwrap(store.calendarsForEntityType(EK_ENTITY_EVENT)) || []).forEach(function (c) {
    var title = str(c.title);
    if (CONFIG.calendars.indexOf(title) >= 0) { picked.addObject(c); found[title] = true; }
  });
  var missing = CONFIG.calendars.filter(function (n) { return !found[n]; });
  if (num(picked.count) === 0) return JSON.stringify({ ok: false, error: 'no_calendars_matched', missing: missing });

  var predicate = store.predicateForEventsWithStartDateEndDateCalendars(
    $.NSDate.dateWithTimeIntervalSince1970(CONFIG.startEpoch),
    $.NSDate.dateWithTimeIntervalSince1970(CONFIG.endEpoch),
    picked
  );
  var events = (ObjC.unwrap(store.eventsMatchingPredicate(predicate)) || [])
    .filter(function (e) { return num(e.status) !== EK_STATUS_CANCELED; })
    .map(function (e) {
      var people = (ObjC.unwrap(e.attendees) || []).map(address);
      people.push(address(e.organizer));
      return {
        uid: str(e.calendarItemExternalIdentifier),
        title: str(e.title),
        start: Number(e.startDate.timeIntervalSince1970),
        calendar: str(e.calendar.title),
        people: people.filter(function (a) { return a; })
      };
    });
  return JSON.stringify({ ok: true, missing: missing, events: events });
}
`.trim();
}

interface RawMeeting {
  uid: string;
  title: string;
  start: number;
  calendar: string;
  people: string[];
}

type RawResult =
  | {ok: true; missing: string[]; events: RawMeeting[]}
  | {ok: false; error: string; status?: number; missing?: string[]};

/** Turn the script's JSON output into items to link, or throw a clear error. */
export function parseAppleMeetings(raw: string): AutoLinkItem[] {
  if (!raw.trim()) throw new AppleMeetingsError("Calendar returned no output.", "empty_output");
  let result: RawResult;
  try {
    result = JSON.parse(raw) as RawResult;
  } catch {
    throw new AppleMeetingsError(`Calendar returned unreadable output: ${raw.slice(0, 300)}`, "bad_output");
  }
  if (!result.ok) {
    if (result.error === "no_calendar_access") {
      throw new AppleMeetingsError(
        `Not allowed to read Calendars (EKAuthorizationStatus ${result.status}; full access is 3). ` +
          "Grant Full Access under System Settings > Privacy & Security > Calendars for the app running this.",
        "no_calendar_access"
      );
    }
    if (result.error === "no_calendars_matched") {
      throw new AppleMeetingsError(`None of the calendars ${result.missing?.join(", ")} was found.`, "no_calendars_matched");
    }
    throw new AppleMeetingsError(`Calendar read failed: ${result.error}`, result.error);
  }
  const label = (name: string) => MEETING_CALENDARS.find((c) => c.name === name)?.label ?? name;
  return result.events
    .filter((e) => e.uid && Number.isFinite(e.start))
    .map((e) => ({
      type: "meeting" as const,
      sourceId: e.uid,
      title: e.title,
      date: new Date(e.start * 1000).toISOString(),
      detail: label(e.calendar),
      addresses: e.people,
    }));
}

/**
 * Meetings that start between `start` and `end`. When MAISIE_MEETINGS_FIXTURE
 * names a file, its contents stand in for the script's output (tests).
 */
export function readAppleMeetings(start: Date, end: Date): AutoLinkItem[] {
  const fixture = process.env.MAISIE_MEETINGS_FIXTURE;
  if (fixture) return parseAppleMeetings(readFileSync(fixture, "utf-8"));
  let raw: string;
  try {
    raw = execFileSync("osascript", ["-l", "JavaScript", "-e", readMeetingsScript(start, end)], {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new AppleMeetingsError(`osascript failed: ${err instanceof Error ? err.message : err}`, "osascript_failed");
  }
  return parseAppleMeetings(raw);
}
