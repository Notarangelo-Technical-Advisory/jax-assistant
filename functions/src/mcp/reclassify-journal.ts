/**
 * Re-apply the work journal's repo rules (REPO_CLIENTS and OWNER_CLIENTS in
 * src/tools/journal.ts) to the GitHub and Claude Code items already in the
 * journal, and rebuild the days that changed. Run it after changing those
 * rules; the journal job applies them only to what it reads from then on.
 *
 * Usage (from functions/):
 *   npm run journal:reclassify -- --dry-run   # show what would change, write nothing
 *   npm run journal:reclassify                # change it
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import {clientLabel, loadClientLabels, reclassifyJournal} from "../tools/journal";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const labels = await loadClientLabels(db);
  const s = await reclassifyJournal(db, {dryRun});

  if (dryRun) console.log("Dry run: nothing was written.\n");
  console.log(`${s.checked} GitHub and Claude Code items checked; ${s.changed} ${dryRun ? "would move" : "moved"} to another client.`);
  for (const c of s.changes) console.log(`  ${clientLabel(c.from, labels)} → ${clientLabel(c.to, labels)}: ${c.count}`);
  if (s.days.length) console.log(`Days ${dryRun ? "to rebuild" : "rebuilt"}: ${s.days.length}, from ${s.days[0]} to ${s.days[s.days.length - 1]}.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
