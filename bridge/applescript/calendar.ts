import { runAppleScript, esc, appleScriptDate, parseAppleDate } from "./run.js";

/** The Apple Calendar that MAISIE reads and writes. */
export const CALENDAR_NAME = "Jax";

export interface ParsedEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  location: string;
  notes: string;
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

export function readEventsScript(daysAhead: number): string {
  return `
set startDate to (current date)
set endDate to startDate + ${daysAhead} * days
set output to ""
tell application "Calendar"
    set cal to first calendar whose name is "${CALENDAR_NAME}"
    set evts to (every event of cal whose start date ≥ startDate and start date < endDate)
    repeat with e in evts
        set evtStart to start date of e
        set evtEnd to end date of e
        set evtSummary to summary of e
        set evtLocation to ""
        set evtNotes to ""
        try
            set evtLocation to location of e
        end try
        try
            set evtNotes to description of e
        end try
        if evtLocation is missing value then set evtLocation to ""
        if evtNotes is missing value then set evtNotes to ""
        set output to output & evtSummary & "|||" & (evtStart as «class isot» as string) & "|||" & (evtEnd as «class isot» as string) & "|||" & evtLocation & "|||" & evtNotes & linefeed
    end repeat
end tell
return output
`.trim();
}

/**
 * Read events starting from now through `daysAhead` days out. Reads Apple
 * Calendar live, so it does not depend on the Firestore mirror being fresh.
 */
export function readEvents(daysAhead: number): ParsedEvent[] {
  let raw: string;
  try {
    raw = runAppleScript(readEventsScript(daysAhead));
  } catch (err) {
    console.error("AppleScript failed:", err);
    return [];
  }
  if (!raw) return [];

  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [summary, startStr, endStr, location, notes] = line.split("|||");
      return {
        summary: summary?.trim() || "Untitled",
        startTime: parseAppleDate(startStr?.trim()),
        endTime: parseAppleDate(endStr?.trim()),
        location: location?.trim() || "",
        notes: notes?.trim() || "",
      };
    })
    .filter((e) => !isNaN(e.startTime.getTime()));
}

/** Create an event. Applies immediately — no queue, no sync delay. */
export function createEvent(payload: Record<string, string | null>): string {
  return runAppleScript(createEventScript(payload), 15000);
}

/** Move an event. Returns "ok" or "not_found". */
export function moveEvent(payload: Record<string, string | null>): string {
  return runAppleScript(moveEventScript(payload), 15000);
}
