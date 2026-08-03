import { runAppleScript, esc, appleScriptDate, parseAppleDate } from "./run.js";

/**
 * Calendars MAISIE reads, as an explicit allowlist.
 *
 * Apple Calendar records which calendars you have unchecked (in
 * `defaults read com.apple.iCal DisabledCalendars`), but only as UUIDs, and the
 * only way to map those to names is Calendar.sqlitedb, which is TCC-protected.
 * AppleScript has no visibility property, and its calendarIdentifier property
 * errors at runtime. So this list is maintained by hand — hiding a calendar in
 * Calendar.app does not remove it here.
 *
 * `label` is what MAISIE calls the calendar. It exists mainly because Exchange
 * names its default calendar "Calendar", which is meaningless in a sentence.
 *
 * Deliberately excluded: Untitled Calendar, Birthdays (x2), Scheduled
 * Reminders, Siri Suggestions, and the three redundant US holiday calendars.
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

/**
 * The single calendar MAISIE writes to. Creating an event has to pick one
 * calendar, and "Jax" is the personal working calendar.
 */
export const CALENDAR_NAME = "Jax";

export interface ParsedEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  location: string;
  notes: string;
  /** Friendly label of the source calendar, from READ_CALENDARS. */
  calendarName: string;
  /**
   * Apple Calendar's stable identifier for the event, which survives a move.
   * Every instance of a recurring series shares one uid, so it identifies a
   * series rather than an occurrence — see `recurring`.
   *
   * Empty string when Calendar declines to supply one; callers must fall back
   * to content-based identity in that case.
   */
  uid: string;
  /** True when the event belongs to a recurring series (non-empty recurrence rule). */
  recurring: boolean;
}

// ─── Script builders ─────────────────────────────────────────────

export function createEventScript(payload: Record<string, string | null>): string {
  const startStr = appleScriptDate(payload["date"] as string, payload["startTime"] as string);
  const endStr = appleScriptDate(payload["date"] as string, payload["endTime"] as string);
  const title = esc(payload["title"] as string);
  const location = payload["location"] ? `set location of newEvent to "${esc(payload["location"] as string)}"` : "";
  const notes = payload["notes"] ? `set description of newEvent to "${esc(payload["notes"] as string)}"` : "";
  return `
tell application "Calendar"
  set cal to first calendar whose name is "${CALENDAR_NAME}"
  set newEvent to make new event at end of events of cal with properties {summary:"${title}", start date:date "${startStr}", end date:date "${endStr}"}
  ${location}
  ${notes}
  save
end tell
`.trim();
}

export function moveEventScript(payload: Record<string, string | null>): string {
  const title = esc(payload["eventTitle"] as string);
  const originalDateStr = payload["originalDate"] as string;
  const [origYear, origMonth, origDay] = originalDateStr.split("-");
  const newStartStr = appleScriptDate(payload["newDate"] as string, payload["newStartTime"] as string);
  const newEndStr = appleScriptDate(payload["newDate"] as string, payload["newEndTime"] as string);
  return `
tell application "Calendar"
  set cal to first calendar whose name is "${CALENDAR_NAME}"
  set searchStart to date "${origMonth}/${origDay}/${origYear} 00:00:00"
  set searchEnd to date "${origMonth}/${origDay}/${origYear} 23:59:59"
  set matchingEvents to (every event of cal whose summary is "${title}" and start date ≥ searchStart and start date ≤ searchEnd)
  if (count of matchingEvents) > 0 then
    set targetEvent to item 1 of matchingEvents
    set start date of targetEvent to date "${newStartStr}"
    set end date of targetEvent to date "${newEndStr}"
    save
    return "ok"
  else
    return "not_found"
  end if
end tell
`.trim();
}

/** Number of `|||` fields readEventsScript emits per record. */
const FIELD_COUNT = 8;

/**
 * Record delimiter. Must be something no calendar event will contain, and must
 * not be a newline — see the note on readEventsScript.
 */
const RECORD_SEP = "@@@MAISIE_REC@@@";

/**
 * One script that walks every allowlisted calendar, so a read is a single
 * osascript invocation rather than one per calendar.
 *
 * Each record is:
 *   calendarName ||| uid ||| recurrence ||| start ||| end ||| summary ||| location ||| notes
 *
 * Records are separated by RECORD_SEP, not by a newline. Event notes routinely
 * contain newlines — every Teams invite is a ten-line block — and splitting on
 * linefeed silently shredded them: the event parsed from its first line and the
 * remaining lines were dropped by the NaN-date filter, so the Teams join link
 * never reached Firestore at all.
 *
 * The two free-text fields are last on purpose. A `|||` typed into an event's
 * notes can then only corrupt notes itself, and the parser rejoins the overflow.
 *
 * A missing calendar is skipped rather than failing the whole read.
 */
export function readEventsScript(daysAhead: number, calendars = READ_CALENDARS): string {
  const nameList = calendars.map((c) => `"${esc(c.name)}"`).join(", ");
  return `
set calNames to {${nameList}}
set startDate to (current date)
set endDate to startDate + ${daysAhead} * days
set output to ""
tell application "Calendar"
    repeat with cn in calNames
        set calName to cn as string
        try
            set cal to first calendar whose name is calName
            set evts to (every event of cal whose start date ≥ startDate and start date < endDate)
            repeat with e in evts
                set evtStart to start date of e
                set evtEnd to end date of e
                set evtSummary to summary of e
                set evtLocation to ""
                set evtNotes to ""
                set evtUid to ""
                set evtRecur to ""
                try
                    set evtLocation to location of e
                end try
                try
                    set evtNotes to description of e
                end try
                try
                    set evtUid to uid of e
                end try
                try
                    set evtRecur to recurrence of e
                end try
                if evtLocation is missing value then set evtLocation to ""
                if evtNotes is missing value then set evtNotes to ""
                if evtUid is missing value then set evtUid to ""
                if evtRecur is missing value then set evtRecur to ""
                set output to output & calName & "|||" & evtUid & "|||" & evtRecur & "|||" & (evtStart as «class isot» as string) & "|||" & (evtEnd as «class isot» as string) & "|||" & evtSummary & "|||" & evtLocation & "|||" & evtNotes & "${RECORD_SEP}"
            end repeat
        end try
    end repeat
end tell
return output
`.trim();
}

/**
 * Read events across every allowlisted calendar, from now through `daysAhead`
 * days out. Reads Apple Calendar live, so it does not depend on the Firestore
 * mirror being fresh. Results are sorted by start time across calendars.
 */
export function readEvents(daysAhead: number): ParsedEvent[] {
  let raw: string;
  try {
    // 7 calendars over a week is meaningfully more work than one — give it room.
    raw = runAppleScript(readEventsScript(daysAhead), 120000);
  } catch (err) {
    console.error("AppleScript failed:", err);
    return [];
  }
  if (!raw) return [];

  const labelFor = new Map(READ_CALENDARS.map((c) => [c.name, c.label]));

  return raw
    .split(RECORD_SEP)
    .filter((record) => record.trim())
    .map((record) => {
      // Notes is the last field, so a `|||` inside it produces extra parts.
      // Rejoin the overflow rather than silently truncating the note.
      const parts = record.split("|||");
      if (parts.length > FIELD_COUNT) {
        parts.splice(
          FIELD_COUNT - 1,
          parts.length - FIELD_COUNT + 1,
          parts.slice(FIELD_COUNT - 1).join("|||")
        );
      }
      const [calName, uid, recur, startStr, endStr, summary, location, notes] = parts;
      const rawName = calName?.trim() ?? "";
      return {
        calendarName: labelFor.get(rawName) ?? rawName,
        summary: summary?.trim() || "Untitled",
        startTime: parseAppleDate(startStr?.trim()),
        endTime: parseAppleDate(endStr?.trim()),
        location: location?.trim() || "",
        // AppleScript hands back CR line endings inside notes; normalise so the
        // stored text is ordinary multi-line content.
        notes: notes?.replace(/\r\n?/g, "\n").trim() || "",
        uid: uid?.trim() || "",
        recurring: Boolean(recur?.trim()),
      };
    })
    .filter((e) => !isNaN(e.startTime.getTime()))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

/** Create an event. Applies immediately — no queue, no sync delay. */
export function createEvent(payload: Record<string, string | null>): string {
  return runAppleScript(createEventScript(payload), 15000);
}

/** Move an event. Returns "ok" or "not_found". */
export function moveEvent(payload: Record<string, string | null>): string {
  return runAppleScript(moveEventScript(payload), 15000);
}
