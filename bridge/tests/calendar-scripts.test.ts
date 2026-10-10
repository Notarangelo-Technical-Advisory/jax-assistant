import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createEventScript, moveEventScript } from "../applescript/calendar.js";

const onMac = process.platform === "darwin";

/**
 * Run only the date-building lines of a calendar script (everything before
 * `tell application "Calendar"`), so the test never touches Jack's calendar,
 * and return each named date as "YYYY-M-D H:M".
 */
function evaluateDates(script: string, names: string[]): Record<string, string> {
  const preamble = script.slice(0, script.indexOf('tell application "Calendar"'));
  const parts = names.map(
    (n) => `"" & (year of ${n} as integer) & "-" & (month of ${n} as integer) & "-" & (day of ${n}) & " " & (hours of ${n}) & ":" & (minutes of ${n})`,
  );
  const out = execFileSync("osascript", ["-e", `${preamble}\nreturn ${parts.join(' & "|" & ')}`], { encoding: "utf-8" }).trim();
  return Object.fromEntries(out.split("|").map((value, i) => [names[i], value]));
}

const flowerbeds = { title: "Clean up flowerbeds", date: "2026-10-12", startTime: "13:00", endTime: "14:00", location: null, notes: null };

test("a 1 PM to 2 PM event is created at 1 PM to 2 PM, not at midnight", { skip: !onMac && "needs osascript" }, () => {
  const dates = evaluateDates(createEventScript(flowerbeds), ["startDate", "endDate"]);
  assert.deepEqual(dates, { startDate: "2026-10-12 13:0", endDate: "2026-10-12 14:0" });
});

test("an event on the last day of a short month keeps its date", { skip: !onMac && "needs osascript" }, () => {
  const dates = evaluateDates(createEventScript({ ...flowerbeds, date: "2026-02-28", startTime: "09:30", endTime: "10:15" }), ["startDate", "endDate"]);
  assert.deepEqual(dates, { startDate: "2026-2-28 9:30", endDate: "2026-2-28 10:15" });
});

test("a move searches the whole original day and lands at the new afternoon time", { skip: !onMac && "needs osascript" }, () => {
  const script = moveEventScript({ eventTitle: "Clean up flowerbeds", originalDate: "2026-10-12", newDate: "2026-10-13", newStartTime: "13:00", newEndTime: "14:00" });
  const dates = evaluateDates(script, ["searchStart", "searchEnd", "newStart", "newEnd"]);
  assert.deepEqual(dates, {
    searchStart: "2026-10-12 0:0",
    searchEnd: "2026-10-12 23:59",
    newStart: "2026-10-13 13:0",
    newEnd: "2026-10-13 14:0",
  });
});

test("an event whose end is not after its start is refused", () => {
  assert.throws(() => createEventScript({ ...flowerbeds, endTime: "13:00" }), /must be after start/);
  assert.throws(() => createEventScript({ ...flowerbeds, startTime: "14:00", endTime: "13:00" }), /must be after start/);
  assert.throws(
    () => moveEventScript({ eventTitle: "x", originalDate: "2026-10-12", newDate: "2026-10-12", newStartTime: "13:00", newEndTime: "12:00" }),
    /must be after start/,
  );
});

test("a malformed date or time is refused rather than placed at midnight", () => {
  assert.throws(() => createEventScript({ ...flowerbeds, startTime: "1 PM" }), /Invalid time/);
  assert.throws(() => createEventScript({ ...flowerbeds, endTime: "25:00" }), /Invalid time/);
  assert.throws(() => createEventScript({ ...flowerbeds, date: "10/12/2026" }), /Invalid date/);
});

test("no calendar script writes a date as text", () => {
  const scripts = [
    createEventScript(flowerbeds),
    moveEventScript({ eventTitle: "x", originalDate: "2026-10-12", newDate: "2026-10-12", newStartTime: "13:00", newEndTime: "14:00" }),
  ];
  for (const script of scripts) assert.doesNotMatch(script, /date "/);
});
