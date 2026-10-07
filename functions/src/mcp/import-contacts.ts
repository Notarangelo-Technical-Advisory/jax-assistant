/**
 * Import Apple Contacts into MAISIE from a terminal on Jack's Mac.
 *
 * Usage (from functions/):
 *   npm run import:contacts -- --dry-run   # show what would change, write nothing
 *   npm run import:contacts                # import
 *
 * Reads iCloud cards only (IMPORT_ACCOUNTS in apple-contacts.ts).
 * One-way and additive: see src/tools/contacts-import.ts for the rules. The
 * same import is available in VS Code as the `import_apple_contacts` tool.
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import {IMPORT_ACCOUNTS, readAppleContacts} from "./apple-contacts";
import {importContacts} from "../tools/contacts-import";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const {people, otherAccounts} = readAppleContacts();
  const s = await importContacts(db, people, {dryRun});

  console.log(dryRun ? "Dry run: nothing was written.\n" : "Import finished.\n");
  console.log(`Cards read from Apple Contacts (${IMPORT_ACCOUNTS.join(", ")}): ${s.read}`);
  const left = Object.entries(otherAccounts).map(([a, n]) => `${a} ${n}`).join(", ");
  if (left) console.log(`  Left out, other accounts: ${left}`);
  console.log(`  New contacts:        ${s.created}`);
  console.log(`  Contacts updated:    ${s.updated}`);
  console.log(`  Already up to date:  ${s.unchanged}`);
  console.log(`  Company cards:       ${s.companyCards}`);
  console.log(`  Skipped (no name):   ${s.skipped}`);
  console.log(`New companies: ${s.companiesCreated}`);
  if (s.examples.created.length) console.log(`\nNew, for example: ${s.examples.created.join(", ")}`);
  if (s.examples.updated.length) console.log(`Updated, for example: ${s.examples.updated.join(", ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
