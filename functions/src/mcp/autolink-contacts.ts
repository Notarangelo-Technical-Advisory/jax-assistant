/**
 * Automatic contact linking (CRM Phase 4): ties recent emails, meetings, text
 * messages and calls to the contacts taking part in them. Runs on Jack's Mac
 * every 15 minutes, from bridge/com.notarangelo.contact-autolink.plist.
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
 * - Texts: iMessage and SMS from the Messages database, one link per contact
 *   per day. Each run re-reads whole days, from the start of the day before
 *   its overlap, so a day's message count is always complete.
 * - Calls: phone and FaceTime calls from the call history, one link per call.
 *   Missed calls are never linked.
 *   Each run reads at least the last CALL_SYNC_DAYS, because the iPhone's calls
 *   can reach the Mac hours late, for example after the Mac has been asleep.
 * - Mail, Calendar, Messages and the call history are read separately. If one
 *   fails, the others are still linked, and the failed one starts from the
 *   same place next time.
 *
 * The rules for what is linked are in src/tools/contact-autolink.ts.
 */

// First: sets the TLS environment before anything touches the network stack.
import {db} from "./firebase";
import * as admin from "firebase-admin";
import {readAppleMail} from "./apple-mail";
import {readAppleMeetings} from "./apple-meetings";
import {readAppleMessages} from "./apple-messages";
import {readAppleCalls} from "./apple-calls";
import {
  AutoLinkSummary, CallLinkSummary, ContactsByHandle, TextLinkSummary,
  autoLinkCalls, autoLinkItems, autoLinkTexts, loadContactsByHandle,
} from "../tools/contact-autolink";

const BACKFILL_DAYS = 30;
const OVERLAP_MS = 60 * 60 * 1000;
const CALL_SYNC_DAYS = 2;
const STATE = db.doc("metadata/contactAutoLink");

function startFrom(checkedThrough: unknown, now: Date): Date {
  const last = checkedThrough instanceof admin.firestore.Timestamp ? checkedThrough.toMillis() : null;
  return new Date(last ? last - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * 86_400_000);
}

/** Midnight, in this computer's time zone, at the start of the day `date` falls in. */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function reportTexts(label: string, s: TextLinkSummary): void {
  console.log(`${label}: ${s.items} conversation-days read, ${s.linked} links to write, ${s.updated} to update`);
  console.log(`  Already up to date: ${s.alreadyLinked}  Removed by Jack before: ${s.dismissed}  ` +
    `No contact: ${s.noContact}  More than 15 people: ${s.tooManyPeople}`);
  if (s.examples.length) console.log(`  For example: ${s.examples.join("; ")}`);
}

function reportCalls(label: string, s: CallLinkSummary): void {
  console.log(`${label}: ${s.items} read, ${s.linked} links to write`);
  console.log(`  Already linked: ${s.alreadyLinked}  Removed by Jack before: ${s.dismissed}  ` +
    `No contact: ${s.noContact}  Missed, not linked: ${s.missed}`);
  if (s.examples.length) console.log(`  For example: ${s.examples.join("; ")}`);
}

function report(label: string, s: AutoLinkSummary): void {
  console.log(`${label}: ${s.items} read, ${s.linked} links to write for ${s.itemsLinked} of them`);
  console.log(`  Already linked: ${s.alreadyLinked}  Removed by Jack before: ${s.dismissed}  ` +
    `No contact: ${s.noContact}  More than 15 people: ${s.tooManyPeople}  Automated sender: ${s.automated}`);
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

  // Texts and calls are matched on phone numbers, so they share one read of the contacts.
  let contacts: Promise<ContactsByHandle> | undefined;
  const loadContacts = () => (contacts ??= loadContactsByHandle(db));

  const textsFrom = startOfDay(startFrom(state["textsCheckedThrough"], now));
  try {
    const texts = await autoLinkTexts(db, readAppleMessages(textsFrom), {dryRun, loadContacts});
    reportTexts(`Texts since ${textsFrom.toLocaleString("en-US")}`, texts);
    update["textsCheckedThrough"] = admin.firestore.Timestamp.fromDate(now);
    update["lastTexts"] = texts;
  } catch (err) {
    failures.push(`Messages: ${err instanceof Error ? err.message : err}`);
  }

  const callsFrom = new Date(Math.min(
    startFrom(state["callsCheckedThrough"], now).getTime(),
    now.getTime() - CALL_SYNC_DAYS * 86_400_000,
  ));
  try {
    const calls = await autoLinkCalls(db, readAppleCalls(callsFrom), {dryRun, loadContacts});
    reportCalls(`Calls since ${callsFrom.toLocaleString("en-US")}`, calls);
    update["callsCheckedThrough"] = admin.firestore.Timestamp.fromDate(now);
    update["lastCalls"] = calls;
  } catch (err) {
    failures.push(`Calls: ${err instanceof Error ? err.message : err}`);
  }

  update["lastErrors"] = failures;
  if (!dryRun) await STATE.set(update, {merge: true});
  if (failures.length) throw new Error(failures.join("\n"));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
