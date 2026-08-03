import { execSync } from "child_process";

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
