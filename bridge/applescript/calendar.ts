import { runAppleScript, esc, appleScriptDateVar, assertEndAfterStart } from "./run.js";

/**
 * Calendar READS live in `eventkit/read-events.ts`, not here.
 *
 * Writes stay on AppleScript — creating and moving an event through
 * Calendar.app is exactly what its scripting dictionary is good at, and it
 * needs only the Automation permission this repo has always used. Reads had to
 * move to EventKit because AppleScript cannot expand a recurring series, so
 * every standing meeting was invisible to a windowed query. That module's
 * header has the full account.
 *
 * Re-exported so both callers keep importing the whole calendar surface from
 * one place.
 */
export {
  READ_CALENDARS,
  readEvents,
  readEventsScript,
  readWindow,
  CalendarReadError,
  type ParsedEvent,
  type CalendarRead,
} from "../eventkit/read-events.js";

/**
 * The single calendar MAISIE writes to. Creating an event has to pick one
 * calendar, and "Jax" is the personal working calendar.
 */
export const CALENDAR_NAME = "Jax";

// ─── Script builders ─────────────────────────────────────────────

export function createEventScript(payload: Record<string, string | null>): string {
  assertEndAfterStart(payload["startTime"] as string, payload["endTime"] as string);
  const title = esc(payload["title"] as string);
  const location = payload["location"] ? `set location of newEvent to "${esc(payload["location"] as string)}"` : "";
  const notes = payload["notes"] ? `set description of newEvent to "${esc(payload["notes"] as string)}"` : "";
  return `
${appleScriptDateVar("startDate", payload["date"] as string, payload["startTime"] as string)}
${appleScriptDateVar("endDate", payload["date"] as string, payload["endTime"] as string)}
tell application "Calendar"
  set cal to first calendar whose name is "${CALENDAR_NAME}"
  set newEvent to make new event at end of events of cal with properties {summary:"${title}", start date:startDate, end date:endDate}
  ${location}
  ${notes}
  save
end tell
`.trim();
}

export function moveEventScript(payload: Record<string, string | null>): string {
  assertEndAfterStart(payload["newStartTime"] as string, payload["newEndTime"] as string);
  const title = esc(payload["eventTitle"] as string);
  const originalDate = payload["originalDate"] as string;
  const newDate = payload["newDate"] as string;
  return `
${appleScriptDateVar("searchStart", originalDate, "00:00:00")}
${appleScriptDateVar("searchEnd", originalDate, "23:59:59")}
${appleScriptDateVar("newStart", newDate, payload["newStartTime"] as string)}
${appleScriptDateVar("newEnd", newDate, payload["newEndTime"] as string)}
tell application "Calendar"
  set cal to first calendar whose name is "${CALENDAR_NAME}"
  set matchingEvents to (every event of cal whose summary is "${title}" and start date ≥ searchStart and start date ≤ searchEnd)
  if (count of matchingEvents) > 0 then
    set targetEvent to item 1 of matchingEvents
    -- End is set before and after start: Calendar adjusts an end that falls
    -- before the start, and the event may be moving earlier or later.
    set end date of targetEvent to newEnd
    set start date of targetEvent to newStart
    set end date of targetEvent to newEnd
    save
    return "ok"
  else
    return "not_found"
  end if
end tell
`.trim();
}

/** Create an event. Applies immediately — no queue, no sync delay. */
export function createEvent(payload: Record<string, string | null>): string {
  return runAppleScript(createEventScript(payload), 15000);
}

/** Move an event. Returns "ok" or "not_found". */
export function moveEvent(payload: Record<string, string | null>): string {
  return runAppleScript(moveEventScript(payload), 15000);
}
