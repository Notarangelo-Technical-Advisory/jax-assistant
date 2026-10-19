/**
 * Run by the nightly cloud task that records Jack's cloud Claude Code
 * sessions for the work journal (see cloud-sessions.ts). Never run on the Mac.
 *
 * Usage (from functions/):
 *   npx tsx src/mcp/export-cloud-sessions.ts --sessions <dir> --events <dir> \
 *     --days 2026-10-18,2026-10-19 --out <dir>
 *
 *   --sessions  the saved answers of list_sessions, one file per page
 *   --events    the saved answers of list_events, one file per page, each
 *               named after its session: session_01Abc.json, session_01Abc.2.json
 *   --days      the Eastern Time days to write, YYYY-MM-DD, comma-separated
 *   --out       where to write one <day>.json per day
 *
 * A saved answer may be wrapped in text, as the tools return it; the JSON
 * inside is found by its first "{" and last "}".
 */

import {mkdirSync, readFileSync, readdirSync, writeFileSync} from "fs";
import {join} from "path";
import {ListedSession, RecordedEvent, exportCloudDays} from "./cloud-sessions";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    console.error(`--${name} is missing. See the usage at the top of export-cloud-sessions.ts.`);
    process.exit(1);
  }
  return value;
}

/** The `data` list of a saved answer, whatever text surrounds its JSON. */
export function dataOf(text: string): unknown[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return [];
  const json = JSON.parse(text.slice(start, end + 1)) as {ccr?: {data?: unknown[]}; data?: unknown[]};
  return json.ccr?.data ?? json.data ?? [];
}

const files = (dir: string) => readdirSync(dir).filter((f) => !f.startsWith(".")).sort();

function main(): void {
  const days = arg("days").split(",").map((d) => d.trim());
  if (!days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    console.error("--days needs days as YYYY-MM-DD, comma-separated.");
    process.exit(1);
  }
  const sessionsDir = arg("sessions");
  const eventsDir = arg("events");
  const out = arg("out");

  const sessions = files(sessionsDir).flatMap((f) => dataOf(readFileSync(join(sessionsDir, f), "utf-8")) as ListedSession[]);
  const events = new Map<string, RecordedEvent[]>();
  for (const f of files(eventsDir)) {
    const id = f.match(/^(session_[A-Za-z0-9]+)/)?.[1];
    if (!id) continue;
    events.set(id, [...(events.get(id) ?? []), ...(dataOf(readFileSync(join(eventsDir, f), "utf-8")) as RecordedEvent[])]);
  }

  mkdirSync(out, {recursive: true});
  for (const file of exportCloudDays(sessions, events, days)) {
    writeFileSync(join(out, `${file.day}.json`), `${JSON.stringify(file, null, 2)}\n`);
    const prompts = file.sessions.reduce((n, s) => n + s.events.filter(([, p]) => p === 1).length, 0);
    console.log(`${file.day}: ${file.sessions.length} sessions, ${prompts} prompts from Jack`);
  }
}

if (require.main === module) main();
