/**
 * Read the meetings Jack recorded in Wispr Flow, for the work journal, from the
 * app's own database on his Mac (~/Library/Application Support/Wispr Flow/
 * flow.sqlite), opened read-only with the sqlite3 tool that comes with macOS.
 *
 * Only each recording's id, title, start, end and notes link are passed on.
 * Its notes, summary and transcript are not read.
 *
 * Wispr Flow has no calendar connected, so a recording carries no attendees;
 * the client comes from the calendar meeting it overlaps or its title (see
 * recordingItems in src/tools/journal.ts).
 */

import {execFileSync} from "child_process";
import {existsSync, readFileSync} from "fs";
import {homedir} from "os";
import {join} from "path";
import {Recording} from "../tools/journal";

export const WISPR_DATABASE = join(homedir(), "Library", "Application Support", "Wispr Flow", "flow.sqlite");
const SHARE_LINK = "https://notes.wisprflow.ai/shared/";

export class WisprRecordingsError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WisprRecordingsError";
  }
}

/**
 * Recordings started from the day before `since`. Reading a day back picks up
 * the title, which Wispr Flow adds a few minutes after a recording ends. Wispr
 * Flow stores the start as text in UTC, "2026-10-07 13:01:30.177 +00:00", so
 * the day compares as text. Not the time a recording last changed: Wispr Flow
 * changes old recordings too, and the journal's other sources start 30 days back.
 */
export function readRecordingsSql(since: Date): string {
  const day = new Date(since.getTime() - 86_400_000).toISOString().slice(0, 10);
  return "SELECT id, title, createdAt, endedAt, shareSlug FROM Meetings " +
    `WHERE isDeleted = 0 AND createdAt >= '${day}' ORDER BY createdAt`;
}

interface RawRow {
  id: string;
  title: string | null;
  createdAt: string;
  /** Milliseconds since 1970; null while it is still recording. */
  endedAt: number | null;
  shareSlug: string | null;
}

/** "2026-10-07 13:01:30.177 +00:00" (or an ISO time) as an ISO time, or null. */
function isoTime(value: string): string | null {
  const ms = Date.parse(value.trim().replace(" ", "T").replace(" ", ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Turn sqlite3's JSON rows into recordings. */
export function parseRecordingRows(raw: string): Recording[] {
  // sqlite3 prints nothing at all when no row matches.
  if (!raw.trim()) return [];
  let rows: RawRow[];
  try {
    rows = JSON.parse(raw) as RawRow[];
  } catch {
    throw new WisprRecordingsError(`Wispr Flow returned unreadable output: ${raw.slice(0, 300)}`, "bad_output");
  }
  return rows.flatMap((row) => {
    const start = isoTime(row.createdAt ?? "");
    if (!row.id || !start) return [];
    const end = Number.isFinite(row.endedAt) ? new Date(row.endedAt!).toISOString() : null;
    const slug = row.shareSlug && /^[A-Za-z0-9_-]+$/.test(row.shareSlug) ? row.shareSlug : null;
    return [{id: row.id, title: row.title ?? "", start, end, url: slug ? SHARE_LINK + slug : null}];
  });
}

/**
 * Recordings started from the day before `since`. When
 * MAISIE_WISPR_FIXTURE names a file, its contents stand in for sqlite3's
 * output (tests).
 */
export function readWisprRecordings(since: Date): Recording[] {
  const fixture = process.env.MAISIE_WISPR_FIXTURE;
  if (fixture) return parseRecordingRows(readFileSync(fixture, "utf-8"));
  if (!existsSync(WISPR_DATABASE)) {
    throw new WisprRecordingsError(`Wispr Flow's database is not at ${WISPR_DATABASE}. Is Wispr Flow installed?`, "no_database");
  }
  let raw: string;
  try {
    raw = execFileSync("sqlite3", ["-readonly", "-json", `file:${WISPR_DATABASE}?mode=ro`, readRecordingsSql(since)], {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new WisprRecordingsError(`sqlite3 could not read Wispr Flow's database: ${err instanceof Error ? err.message : err}`, "sqlite_failed");
  }
  return parseRecordingRows(raw);
}
