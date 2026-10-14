/**
 * Read recent phone and FaceTime calls from the call history on Jack's Mac,
 * for automatic contact linking. The iPhone shares its call history with the
 * Mac through iCloud, so the Mac's copy has the iPhone's calls too.
 *
 * Apple offers no supported way to read call history, so this reads
 * ~/Library/Application Support/CallHistoryDB/CallHistory.storedata with the
 * sqlite3 tool that comes with macOS, opened read-only. Only each call's id,
 * start, length, direction, kind and the other person's number or FaceTime
 * address are passed on (see src/tools/contact-autolink.ts).
 *
 * Permission: Full Disk Access for the process running this, the same grant
 * that reading Messages needs.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {homedir} from "os";
import {join} from "path";
import {CallItem} from "../tools/contact-autolink";

export class AppleCallsError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AppleCallsError";
  }
}

/** The call history counts time in seconds from 1 January 2001. */
const APPLE_EPOCH_SECONDS = 978_307_200;

/** ZCALLTYPE values for FaceTime. Every other value is a phone call. */
const FACETIME_VIDEO = 8;
const FACETIME_AUDIO = 16;

/**
 * Calls that ended after `since`. A call is written to the history when it
 * ends, with the time it started, so a long call is found by its end.
 */
export function readCallsSql(since: Date): string {
  const sinceSeconds = Math.floor(since.getTime() / 1000) - APPLE_EPOCH_SECONDS;
  return `
SELECT ZUNIQUE_ID AS id,
       ZDATE AS seconds,
       ZDURATION AS duration,
       ZORIGINATED AS outgoing,
       ZANSWERED AS answered,
       ZCALLTYPE AS callType,
       ZADDRESS AS address
FROM ZCALLRECORD
WHERE ZDATE + ZDURATION > ${sinceSeconds}
ORDER BY ZDATE;
`.trim();
}

interface RawRow {
  id: string | null;
  seconds: number;
  duration: number | null;
  outgoing: number | null;
  answered: number | null;
  callType: number | null;
  address: string | null;
}

/** Turn sqlite3's JSON rows into one item per call. */
export function parseCallRows(raw: string): CallItem[] {
  // sqlite3 prints nothing at all when no call matches.
  if (!raw.trim()) return [];
  let rows: RawRow[];
  try {
    rows = JSON.parse(raw) as RawRow[];
  } catch {
    throw new AppleCallsError(`Call history returned unreadable output: ${raw.slice(0, 300)}`, "bad_output");
  }
  return rows.filter((row) => row.id && Number.isFinite(row.seconds)).map((row) => ({
    callId: String(row.id),
    at: new Date((row.seconds + APPLE_EPOCH_SECONDS) * 1000).toISOString(),
    direction: row.outgoing === 1 ? "outgoing" : row.answered === 1 ? "incoming" : "missed",
    kind: row.callType === FACETIME_VIDEO ? "facetime-video" : row.callType === FACETIME_AUDIO ? "facetime-audio" : "phone",
    seconds: Math.max(0, Math.round(row.duration ?? 0)),
    // A group FaceTime call keeps one person here; the others are not matched.
    handles: row.address?.trim() ? [row.address.trim()] : [],
  }));
}

/**
 * Calls that ended after `since`. When MAISIE_CALLS_FIXTURE names a file, its
 * contents stand in for sqlite3's output (tests).
 */
export function readAppleCalls(since: Date): CallItem[] {
  const fixture = process.env.MAISIE_CALLS_FIXTURE;
  if (fixture) return parseCallRows(readFileSync(fixture, "utf-8"));
  const database = join(homedir(), "Library", "Application Support", "CallHistoryDB", "CallHistory.storedata");
  let raw: string;
  try {
    raw = execFileSync("sqlite3", ["-readonly", "-json", database, readCallsSql(since)], {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/authorization denied|unable to open/i.test(message)) {
      throw new AppleCallsError(
        "Cannot open the call history. Give the process running this Full Disk Access in " +
        "System Settings > Privacy & Security > Full Disk Access.", "no_access");
    }
    throw new AppleCallsError(`sqlite3 failed: ${message}`, "sqlite_failed");
  }
  return parseCallRows(raw);
}
