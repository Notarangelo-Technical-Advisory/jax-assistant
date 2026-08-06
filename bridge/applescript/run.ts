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
 * Convert "2026-03-20" + "14:00" into the AppleScript date literal format
 * "03/20/2026 14:00:00".
 */
export function appleScriptDate(dateStr: string, timeStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${month}/${day}/${year} ${timeStr}:00`;
}

/**
 * Parse the ISO 8601 string produced by AppleScript's «class isot» coercion,
 * e.g. "2026-03-17T09:00:00". No timezone suffix — parsed as local time.
 */
export function parseAppleDate(str: string): Date {
  if (!str) return new Date(NaN);
  return new Date(str);
}
