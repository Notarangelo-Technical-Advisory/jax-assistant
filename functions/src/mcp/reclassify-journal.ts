/**
 * Re-apply the work journal's repo rules (REPO_CLIENTS and OWNER_CLIENTS in
 * src/tools/journal.ts) to the GitHub and Claude Code items already in the
 * journal, and rebuild the days that changed. Run it after changing those
 * rules; the journal job applies them only to what it reads from then on.
 * It also reads Claude Code's session files again, so a session's work in a
 * folder with no repo gets the repo the session was started in.
 *
 * Usage (from functions/):
 *   npm run journal:reclassify -- --dry-run   # show what would change, write nothing
 *   npm run journal:reclassify                # change it
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import {clientLabel, journalId, loadClientLabels, reclassifyJournal} from "../tools/journal";
import {readClaudeSessions} from "./claude-sessions";

// Claude Code keeps its session files for about a month; this reaches past that.
const SESSION_DAYS = 90;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const labels = await loadClientLabels(db);
  const sessions = readClaudeSessions(new Date(Date.now() - SESSION_DAYS * 86_400_000));
  const claudeRepos = new Map<string, {repo: string; action: string}>();
  for (const i of sessions.items) if (i.repo) claudeRepos.set(journalId("claude", i.sourceId), {repo: i.repo, action: i.action});
  const s = await reclassifyJournal(db, {dryRun, claudeRepos});

  if (dryRun) console.log("Dry run: nothing was written.\n");
  console.log(`${s.checked} GitHub and Claude Code items checked; ${s.changed} ${dryRun ? "would move" : "moved"} to another client.`);
  if (s.reposFilled) console.log(`${s.reposFilled} Claude Code items ${dryRun ? "would get" : "got"} the repo their session was started in.`);
  if (s.keptByHand) console.log(`${s.keptByHand} items Jack moved by hand keep the client he chose.`);
  for (const c of s.changes) console.log(`  ${clientLabel(c.from, labels)} → ${clientLabel(c.to, labels)}: ${c.count}`);
  if (s.days.length) console.log(`Days ${dryRun ? "to rebuild" : "rebuilt"}: ${s.days.length}, from ${s.days[0]} to ${s.days[s.days.length - 1]}.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
