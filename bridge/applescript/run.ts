import { execSync, execFileSync } from "child_process";

/**
 * Run an AppleScript via osascript and return trimmed stdout.
 *
 * Single quotes in the script are escaped for the surrounding shell quoting —
 * same approach used by the original calendar sync.
 */
export function runAppleScript(script: string, timeoutMs = 30000): string {
  return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
    encoding: "utf-8",
    timeout: timeoutMs,
  }).trim();
}

/**
 * Run a JXA (JavaScript for Automation) script via osascript and return trimmed
 * stdout. Used for the EventKit calendar reader, which needs an ObjC bridge
 * that AppleScript does not have — see `eventkit/read-events.ts`.
 *
 * execFileSync, not execSync: there is no shell in the middle, so the script
 * needs no quote escaping at all. maxBuffer is raised because a week of Teams
 * invites is a lot of JSON — the default 1MB is within reach.
 */
export function runJxa(script: string, timeoutMs = 60000): string {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Escape a value for interpolation inside an AppleScript double-quoted string. */
export function esc(value: string): string {
  return value.replace(/"/g, '\\"');
}

/**
 * Seconds after midnight for "HH:MM" or "HH:MM:SS" (24-hour). Throws on
 * anything else, so a bad time fails the action instead of landing at midnight.
 */
export function secondsAfterMidnight(timeStr: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr ?? "");
  const [hours, minutes, seconds] = match ? match.slice(1).map((part) => Number(part ?? 0)) : [];
  if (!match || hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`Invalid time "${timeStr}" — expected HH:MM (24-hour)`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * AppleScript statements that set `varName` to "2026-03-20" at "14:00".
 *
 * Never write a date as text, such as `date "03/20/2026 14:00:00"`.
 * AppleScript reads that text in the Mac's own date format, and on a Mac set
 * to a 12-hour clock it reads "14:00:00" as midnight without any error. That
 * bug put every event MAISIE created at 12:00–12:00 AM. Setting each part of
 * the date gives the same result on every Mac.
 */
export function appleScriptDateVar(varName: string, dateStr: string, timeStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr ?? "");
  if (!match) throw new Error(`Invalid date "${dateStr}" — expected YYYY-MM-DD`);
  const [year, month, day] = match.slice(1).map(Number);
  // Day 1 first: moving 31 January to February would otherwise roll into March.
  return [
    `set ${varName} to current date`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${year}`,
    `set month of ${varName} to ${month}`,
    `set day of ${varName} to ${day}`,
    `set time of ${varName} to ${secondsAfterMidnight(timeStr)}`,
  ].join("\n");
}

/** Throw unless `endTime` is later than `startTime` on the same day. */
export function assertEndAfterStart(startTime: string, endTime: string): void {
  if (secondsAfterMidnight(endTime) <= secondsAfterMidnight(startTime)) {
    throw new Error(`End time ${endTime} must be after start time ${startTime}`);
  }
}

/**
 * Parse the ISO 8601 string produced by AppleScript's «class isot» coercion,
 * e.g. "2026-03-17T09:00:00". No timezone suffix — parsed as local time.
 */
export function parseAppleDate(str: string): Date {
  if (!str) return new Date(NaN);
  return new Date(str);
}
