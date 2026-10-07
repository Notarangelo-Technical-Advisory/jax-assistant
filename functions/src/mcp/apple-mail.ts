/**
 * Read recent emails from Apple Mail on Jack's Mac, with their sender and
 * recipients, for automatic contact linking (CRM Phase 4).
 *
 * JXA through osascript, JSON on stdout. Mail returns each property for a whole
 * list of messages in one call (`msgs.subject()`), which is far faster than
 * AppleScript's message-by-message loop: 30 days of Jack's Inbox (650
 * messages) took 80 seconds, and 15 minutes' worth takes about 3.
 *
 * Reads the combined Inbox and the combined Sent mailbox of every account, and
 * the addresses of every account, which are Jack's own and are never matched.
 *
 * Permission: Automation access to Mail for the process running this, under
 * System Settings > Privacy & Security > Automation.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {AutoLinkItem} from "../tools/contact-autolink";

export class AppleMailError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AppleMailError";
  }
}

export function readMailScript(since: Date): string {
  return `
function run() {
  var Mail = Application('Mail');
  var since = new Date(${since.getTime()});
  var accounts = [];
  Mail.accounts().forEach(function (a) { accounts = accounts.concat(a.emailAddresses()); });

  function read(box, dateField, filter) {
    var msgs = box.messages.whose(filter);
    var ids = msgs.messageId();
    var subjects = msgs.subject();
    var senders = msgs.sender();
    var dates = msgs[dateField]();
    var to = msgs.toRecipients.address();
    var cc = msgs.ccRecipients.address();
    return ids.map(function (id, i) {
      return { id: id, subject: subjects[i], sender: senders[i], date: dates[i].getTime(), to: to[i], cc: cc[i] };
    });
  }

  return JSON.stringify({
    ok: true,
    accounts: accounts,
    received: read(Mail.inbox, 'dateReceived', { dateReceived: { _greaterThan: since } }),
    sent: read(Mail.sentMailbox, 'dateSent', { dateSent: { _greaterThan: since } })
  });
}
`.trim();
}

interface RawMessage {
  id: string;
  subject: string;
  sender: string;
  date: number;
  to: string[];
  cc: string[];
}

type RawResult =
  | {ok: true; accounts: string[]; received: RawMessage[]; sent: RawMessage[]}
  | {ok: false; error: string};

export interface MailRead {
  /** Jack's own addresses, from his Mail accounts. */
  ownAddresses: string[];
  items: AutoLinkItem[];
}

/** "Brad Donohue <brad@ihrdc.com>" or "brad@ihrdc.com" to the address alone. */
export function senderAddress(sender: string): string {
  const angle = sender.match(/<([^>]+)>/);
  return (angle ? angle[1] : sender).trim();
}

/** Turn the script's JSON output into items to link, or throw a clear error. */
export function parseAppleMail(raw: string): MailRead {
  if (!raw.trim()) throw new AppleMailError("Mail returned no output.", "empty_output");
  let result: RawResult;
  try {
    result = JSON.parse(raw) as RawResult;
  } catch {
    throw new AppleMailError(`Mail returned unreadable output: ${raw.slice(0, 300)}`, "bad_output");
  }
  if (!result.ok) throw new AppleMailError(`Mail read failed: ${result.error}`, result.error);

  const item = (m: RawMessage, sent: boolean): AutoLinkItem => ({
    type: "email",
    sourceId: m.id ?? "",
    title: m.subject ?? "",
    date: new Date(m.date).toISOString(),
    detail: sent ? "Sent by Jack" : (m.sender ?? "").trim(),
    addresses: [senderAddress(m.sender ?? ""), ...(m.to ?? []), ...(m.cc ?? [])],
    sender: senderAddress(m.sender ?? ""),
  });
  return {
    ownAddresses: result.accounts ?? [],
    items: [
      ...(result.received ?? []).filter((m) => m.id && Number.isFinite(m.date)).map((m) => item(m, false)),
      ...(result.sent ?? []).filter((m) => m.id && Number.isFinite(m.date)).map((m) => item(m, true)),
    ],
  };
}

/**
 * Emails received or sent after `since`. When MAISIE_MAIL_FIXTURE names a
 * file, its contents stand in for the script's output (tests).
 */
export function readAppleMail(since: Date): MailRead {
  const fixture = process.env.MAISIE_MAIL_FIXTURE;
  if (fixture) return parseAppleMail(readFileSync(fixture, "utf-8"));
  let raw: string;
  try {
    raw = execFileSync("osascript", ["-l", "JavaScript", "-e", readMailScript(since)], {
      encoding: "utf-8",
      // The first run reads 30 days of the Inbox, which took 80 seconds.
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new AppleMailError(`osascript failed: ${err instanceof Error ? err.message : err}`, "osascript_failed");
  }
  return parseAppleMail(raw);
}
