/**
 * Work journal: collects what Jack did on GitHub, in Jira, in Claude Code, in
 * meetings on his Jax and IHRDC calendars, in meetings he recorded in Wispr
 * Flow and in emails he sent from Apple Mail into MAISIE's journal, with each
 * day's estimated time per client. Runs on Jack's Mac every 15 minutes, from
 * bridge/com.notarangelo.work-journal.plist.
 *
 * Usage (from functions/):
 *   npm run journal:collect -- --dry-run   # show what would be added, write nothing
 *   npm run journal:collect                # collect
 *   npm run journal:collect -- --from 2026-10-18   # also read again from that day
 *
 * - The first run looks back BACKFILL_DAYS (GitHub keeps at most 300 events,
 *   so its first run may reach back less far). Each later run starts an hour
 *   before the previous one finished (GitHub: 8 hours, because its feed can
 *   show an event hours late); the fixed item ids make the overlap harmless.
 * - --from YYYY-MM-DD reads every source again from the start of that day, to
 *   pick up work a run missed. Work already in the journal is not added twice.
 * - GitHub, Jira, Claude Code, the calendars, Wispr Flow and Mail are read
 *   separately. If one fails, the others are still collected, and the failed
 *   one starts from the same place next time.
 * - A meeting or a recording is journaled once it has ended, so one still
 *   going on is read again by a later run.
 *
 * The readers are github-activity.ts, jira-activity.ts, claude-sessions.ts,
 * apple-meetings.ts, wispr-recordings.ts and apple-mail.ts beside this file. The rules for clients and time, and for
 * which meetings count, are in src/tools/journal.ts.
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import * as admin from "firebase-admin";
import {
  JournalItemInput, SaveSummary, clientLabel, emailItems, loadClientLabels, meetingItems, recordingItems, saveJournalItems,
  summarizeDays,
} from "../tools/journal";
import {readGitHubActivity} from "./github-activity";
import {readJiraActivity} from "./jira-activity";
import {readClaudeSessions} from "./claude-sessions";
import {readCalendarMeetings} from "./apple-meetings";
import {readWisprRecordings} from "./wispr-recordings";
import {readSentMail} from "./apple-mail";
import {etDayStart} from "../et-time";

const BACKFILL_DAYS = 30;
const OVERLAP_MS = 60 * 60 * 1000;
/**
 * GitHub adds an event to the feed from 30 seconds to 6 hours after it
 * happened, by its own documentation. An event that arrived after a run had
 * already read past its time was never read: two pushes Jack made from his
 * phone on 2026-10-18 were lost this way. Items are saved by their event id,
 * so reading the same events again adds nothing.
 */
const GITHUB_OVERLAP_MS = 8 * 60 * 60 * 1000;
const STATE = db.doc("metadata/journal");

function startFrom(checkedThrough: unknown, now: Date, overlapMs = OVERLAP_MS, from: Date | null = null): Date {
  const last = checkedThrough instanceof admin.firestore.Timestamp ? checkedThrough.toMillis() : null;
  const start = last ? last - overlapMs : now.getTime() - BACKFILL_DAYS * 86_400_000;
  return new Date(from ? Math.min(start, from.getTime()) : start);
}

function report(label: string, s: SaveSummary, extra: string, labels: ReadonlyMap<string, string>): void {
  console.log(`${label}: ${s.read} read, ${s.added} new, ${s.updated} changed, ${s.unchanged} already in the journal${extra}`);
  const clients = Object.entries(s.byClient).map(([c, n]) => `${clientLabel(c, labels)} ${n}`).join(", ");
  if (clients) console.log(`  By client: ${clients}`);
}

interface Source {
  name: string;
  stateKey: string;
  read: (since: Date, now: Date) => Promise<{items: JournalItemInput[]; note: string}>;
  /** How far before the last run to start reading; an hour unless the source is slow to show new work. */
  overlapMs?: number;
}

const SOURCES: Source[] = [
  {
    name: "GitHub",
    stateKey: "github",
    overlapMs: GITHUB_OVERLAP_MS,
    read: async (since) => {
      const a = readGitHubActivity(since);
      const failures = a.lookupFailures ? `; titles not found: ${a.lookupFailures}` : "";
      return {items: a.items, note: ` (as ${a.login}; events left out: ${a.skipped}${failures})`};
    },
  },
  {
    name: "Jira",
    stateKey: "jira",
    read: async (since) => {
      const a = await readJiraActivity(since);
      return {items: a.items, note: ` (from ${a.issues} issues)`};
    },
  },
  {
    name: "Claude Code",
    stateKey: "claude",
    read: async (since) => {
      const a = readClaudeSessions(since);
      return {items: a.items, note: ` (session files: ${a.files}; spans with no prompt in their stretch of work left out: ${a.skipped})`};
    },
  },
  {
    name: "Calendar",
    stateKey: "meetings",
    read: async (since, now) => {
      const m = meetingItems(readCalendarMeetings(since, now), now);
      return {
        items: m.items,
        note: ` (meetings on the calendars: ${m.read}; left out: ${m.noClient} with no client, ` +
          `${m.allDay} all-day, ${m.free} marked Free, ${m.declined} declined, ${m.notEnded} not ended yet)`,
      };
    },
  },
  {
    name: "Wispr Flow",
    stateKey: "recordings",
    read: async (since, now) => {
      const recordings = readWisprRecordings(since);
      // The calendar meetings the recordings may overlap, to give them a client.
      const earliest = Math.min(...recordings.map((r) => Date.parse(r.start)));
      const meetings = recordings.length ? readCalendarMeetings(new Date(earliest), now) : [];
      const r = recordingItems(recordings, meetings, now);
      return {
        items: r.items,
        note: ` (recordings: ${r.read}; left out: ${r.noClient} with no client, ${r.notEnded} not ended yet)`,
      };
    },
  },
  {
    name: "Sent email",
    stateKey: "email",
    read: async (since) => {
      const {ownAddresses, sent} = readSentMail(since);
      const e = emailItems(sent, ownAddresses);
      return {items: e.items, note: ` (emails sent: ${e.read}; left out: ${e.noClient} with no client)`};
    },
  },
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const fromArg = process.argv[process.argv.indexOf("--from") + 1];
  // Noon UTC is the same date in Eastern Time, so etDayStart gives that day's midnight ET.
  const from = process.argv.includes("--from") && /^\d{4}-\d{2}-\d{2}$/.test(fromArg ?? "") ?
    etDayStart(new Date(`${fromArg}T12:00:00Z`)) : null;
  if (process.argv.includes("--from") && !from) {
    console.error("--from needs a day as YYYY-MM-DD, such as --from 2026-10-18.");
    process.exit(1);
  }
  const now = new Date();
  const state = (await STATE.get()).data() ?? {};
  const labels = await loadClientLabels(db);
  const update: Record<string, unknown> = {lastRunAt: admin.firestore.FieldValue.serverTimestamp()};
  const failures: string[] = [];
  const days = new Set<string>();

  if (dryRun) console.log("Dry run: nothing was written.\n");
  for (const source of SOURCES) {
    const since = startFrom(state[`${source.stateKey}CheckedThrough`], now, source.overlapMs, from);
    try {
      const {items, note} = await source.read(since, now);
      const saved = await saveJournalItems(db, items, {dryRun});
      report(`${source.name} since ${since.toLocaleString("en-US")}`, saved, note, labels);
      saved.days.forEach((d) => days.add(d));
      update[`${source.stateKey}CheckedThrough`] = admin.firestore.Timestamp.fromDate(now);
      update[`last_${source.stateKey}`] = {read: saved.read, added: saved.added, updated: saved.updated};
    } catch (err) {
      failures.push(`${source.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!dryRun && days.size) {
    const summaries = await summarizeDays(db, [...days]);
    for (const s of summaries) {
      const clients = s.clients.map((c) => `${c.label} ${(c.minutes / 60).toFixed(1)} h`).join(", ");
      console.log(`${s.day}: about ${(s.totalMinutes / 60).toFixed(1)} h (${clients})`);
    }
  }

  update["lastErrors"] = failures;
  if (!dryRun) await STATE.set(update, {merge: true});
  if (failures.length) throw new Error(failures.join("\n"));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
