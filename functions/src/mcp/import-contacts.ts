/**
 * Import Jack's iCloud contacts into MAISIE from a terminal on Jack's Mac. Also
 * run every morning by bridge/com.notarangelo.contacts-import.plist.
 *
 * Usage (from functions/):
 *   npm run import:contacts -- --dry-run              # show what would change, write nothing
 *   npm run import:contacts                           # import
 *   npm run import:contacts -- --allow-many-removals  # also make removals that were held
 *
 * Reads iCloud cards only (IMPORT_ACCOUNTS in apple-contacts.ts). iCloud is the
 * master copy of each person's details: see src/tools/contacts-import.ts for
 * the rules. The same import is available in VS Code as `import_apple_contacts`.
 *
 * Each real run records its result in metadata/contactImport. It exits with an
 * error when removals were held, so the log shows that Jack needs to look.
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import * as admin from "firebase-admin";
import {IMPORT_ACCOUNTS, readAppleContacts} from "./apple-contacts";
import {importContacts} from "../tools/contacts-import";

const STATE = db.doc("metadata/contactImport");

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const allowManyRemovals = process.argv.includes("--allow-many-removals");
  let s;
  let otherAccounts: Record<string, number>;
  try {
    const read = readAppleContacts();
    otherAccounts = read.otherAccounts;
    s = await importContacts(db, read.people, {dryRun, allowManyRemovals});
  } catch (err) {
    if (!dryRun) {
      await STATE.set({lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastError: String(err instanceof Error ? err.message : err)}, {merge: true});
    }
    throw err;
  }

  console.log(dryRun ? "Dry run: nothing was written.\n" : `Import finished ${new Date().toLocaleString("en-US")}.\n`);
  console.log(`Cards read from Apple Contacts (${IMPORT_ACCOUNTS.join(", ")}): ${s.read}`);
  const left = Object.entries(otherAccounts).map(([a, n]) => `${a} ${n}`).join(", ");
  if (left) console.log(`  Left out, other accounts: ${left}`);
  console.log(`  New contacts:        ${s.created}`);
  console.log(`  Contacts updated:    ${s.updated}`);
  console.log(`  Already up to date:  ${s.unchanged}`);
  console.log(`  Company cards:       ${s.companyCards}`);
  console.log(`  Skipped (no name):   ${s.skipped}`);
  console.log(`New companies: ${s.companiesCreated}`);
  console.log(`No longer in iCloud: ${s.removed} removed, ${s.keptNotInICloud} kept because they have notes or links`);
  if (s.examples.created.length) console.log(`\nNew, for example: ${s.examples.created.join(", ")}`);
  if (s.examples.updated.length) console.log(`Updated, for example: ${s.examples.updated.join(", ")}`);
  if (s.examples.removed.length) console.log(`Removed, for example: ${s.examples.removed.join(", ")}`);
  if (s.examples.keptNotInICloud.length) console.log(`Kept, no longer in iCloud: ${s.examples.keptNotInICloud.join(", ")}`);

  const held = s.removalsHeld > 0
    ? `${s.removalsHeld} contacts are no longer in iCloud, which is more than expected, so none were removed. ` +
      "Check with --dry-run, then run again with --allow-many-removals if that is right."
    : null;
  if (held) console.log(`\n${held}`);
  if (!dryRun) {
    await STATE.set({lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastSummary: s, lastError: held}, {merge: true});
  }
  if (held) throw new Error("Removals held.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
