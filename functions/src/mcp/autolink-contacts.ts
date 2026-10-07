/**
 * Automatic contact linking (CRM Phase 4): ties recent emails and meetings to
 * the contacts taking part in them. Runs on Jack's Mac every 15 minutes, from
 * bridge/com.notarangelo.contact-autolink.plist.
 *
 * Usage (from functions/):
 *   npm run autolink:contacts -- --dry-run   # show what would be linked, write nothing
 *   npm run autolink:contacts                # link
 *
 * - Emails: the combined Inbox and Sent mailbox of every Mail account.
 * - Meetings: the Jax and IHRDC calendars, once a meeting has started, so a
 *   meeting cancelled beforehand is never linked.
 * - The first run looks back BACKFILL_DAYS. Each later run starts an hour
 *   before the previous one finished, in case Mail files a message late; the
 *   fixed link ids make the overlap harmless.
 * - Mail and Calendar are read separately. If one fails, the other is still
 *   linked, and the failed one starts from the same place next time.
 *
 * The rules for what is linked are in src/tools/contact-autolink.ts.
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import * as admin from "firebase-admin";
import {readAppleMail} from "./apple-mail";
import {readAppleMeetings} from "./apple-meetings";
import {AutoLinkSummary, autoLinkItems} from "../tools/contact-autolink";

const BACKFILL_DAYS = 30;
const OVERLAP_MS = 60 * 60 * 1000;
const STATE = db.doc("metadata/contactAutoLink");

function startFrom(checkedThrough: unknown, now: Date): Date {
  const last = checkedThrough instanceof admin.firestore.Timestamp ? checkedThrough.toMillis() : null;
  return new Date(last ? last - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * 86_400_000);
}

function report(label: string, s: AutoLinkSummary): void {
  console.log(`${label}: ${s.items} read, ${s.linked} links to write for ${s.itemsLinked} of them`);
  console.log(`  Already linked: ${s.alreadyLinked}  Removed by Jack before: ${s.dismissed}  ` +
    `No contact: ${s.noContact}  More than 15 people: ${s.tooManyPeople}`);
  if (s.examples.length) console.log(`  For example: ${s.examples.join("; ")}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();
  const state = (await STATE.get()).data() ?? {};
  const update: Record<string, unknown> = {lastRunAt: admin.firestore.FieldValue.serverTimestamp()};
  const failures: string[] = [];

  // Mail first: it also gives Jack's own addresses, which meetings need too.
  let ownAddresses: string[] = (state["ownAddresses"] as string[] | undefined) ?? [];
  const mailFrom = startFrom(state["mailCheckedThrough"], now);
  let mail;
  try {
    mail = readAppleMail(mailFrom);
    if (mail.ownAddresses.length) ownAddresses = mail.ownAddresses;
  } catch (err) {
    failures.push(`Mail: ${err instanceof Error ? err.message : err}`);
  }

  if (dryRun) console.log("Dry run: nothing was written.\n");
  const meetingsFrom = startFrom(state["meetingsCheckedThrough"], now);
  try {
    const meetings = await autoLinkItems(db, readAppleMeetings(meetingsFrom, now), {ownAddresses, dryRun});
    report(`Meetings since ${meetingsFrom.toLocaleString("en-US")}`, meetings);
    update["meetingsCheckedThrough"] = admin.firestore.Timestamp.fromDate(now);
    update["lastMeetings"] = meetings;
  } catch (err) {
    failures.push(`Calendar: ${err instanceof Error ? err.message : err}`);
  }

  if (mail) {
    const emails = await autoLinkItems(db, mail.items, {ownAddresses, dryRun});
    report(`Emails since ${mailFrom.toLocaleString("en-US")}`, emails);
    update["mailCheckedThrough"] = admin.firestore.Timestamp.fromDate(now);
    update["ownAddresses"] = ownAddresses;
    update["lastEmails"] = emails;
  }

  update["lastErrors"] = failures;
  if (!dryRun) await STATE.set(update, {merge: true});
  if (failures.length) throw new Error(failures.join("\n"));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
