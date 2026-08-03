import { runAppleScript, esc, parseAppleDate } from "./run.js";

export interface MailMessage {
  messageId: string;
  subject: string;
  sender: string;
  dateReceived: Date;
  wasRead: boolean;
}

export interface MailSearchOptions {
  /** Substring matched against the sender (name or address). */
  sender?: string;
  /** Substring matched against the subject. */
  subject?: string;
  /** How many days back to look. Defaults to 7. */
  daysBack?: number;
  /** Mailbox to search. Defaults to the inbox. */
  mailbox?: string;
  /** Cap on results. Defaults to 25. */
  limit?: number;
}

/**
 * Search Apple Mail. Grown from the AppleScript in
 * .claude/skills/brad-alert/SKILL.md, generalized to any sender/subject.
 *
 * Requires Mail.app to be running and configured. The body is deliberately not
 * returned here — newlines would break the line-delimited output — use
 * readMessage for that.
 */
export function searchMessages(opts: MailSearchOptions = {}): MailMessage[] {
  const daysBack = opts.daysBack ?? 7;
  const limit = opts.limit ?? 25;
  const mailboxRef = opts.mailbox
    ? `mailbox "${esc(opts.mailbox)}" of account 1`
    : "inbox";

  const clauses: string[] = [`date received > ((current date) - ${daysBack} * days)`];
  if (opts.sender) clauses.push(`sender contains "${esc(opts.sender)}"`);
  if (opts.subject) clauses.push(`subject contains "${esc(opts.subject)}"`);

  const script = `
set output to ""
set counter to 0
tell application "Mail"
    set msgs to (every message of ${mailboxRef} whose ${clauses.join(" and ")})
    repeat with m in msgs
        if counter ≥ ${limit} then exit repeat
        set msgId to ""
        try
            set msgId to message id of m
        end try
        set output to output & msgId & "|||" & (subject of m) & "|||" & (sender of m) & "|||" & ((date received of m) as «class isot» as string) & "|||" & (read status of m) & linefeed
        set counter to counter + 1
    end repeat
end tell
return output
`.trim();

  let raw: string;
  try {
    raw = runAppleScript(script);
  } catch (err) {
    console.error("Mail search failed:", err);
    return [];
  }
  if (!raw) return [];

  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [messageId, subject, sender, dateStr, readStatus] = line.split("|||");
      return {
        messageId: messageId?.trim() || "",
        subject: subject?.trim() || "(no subject)",
        sender: sender?.trim() || "(unknown)",
        dateReceived: parseAppleDate(dateStr?.trim()),
        wasRead: readStatus?.trim() === "true",
      };
    });
}

/**
 * Read the full body of one message, located by its RFC Message-ID (as returned
 * by searchMessages).
 */
export function readMessage(messageId: string, mailbox?: string): {found: boolean; subject?: string; sender?: string; content?: string} {
  const mailboxRef = mailbox
    ? `mailbox "${esc(mailbox)}" of account 1`
    : "inbox";

  const script = `
tell application "Mail"
    set matches to (every message of ${mailboxRef} whose message id is "${esc(messageId)}")
    if (count of matches) is 0 then
        return "NOT_FOUND"
    end if
    set m to item 1 of matches
    return (subject of m) & "|||" & (sender of m) & "|||" & (content of m)
end tell
`.trim();

  const raw = runAppleScript(script);
  if (raw === "NOT_FOUND") return {found: false};
  const sep1 = raw.indexOf("|||");
  const sep2 = raw.indexOf("|||", sep1 + 3);
  return {
    found: true,
    subject: raw.slice(0, sep1),
    sender: raw.slice(sep1 + 3, sep2),
    content: raw.slice(sep2 + 3),
  };
}

export interface DraftOptions {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}

function outgoingMessageScript(opts: DraftOptions, send: boolean): string {
  const recipients = opts.to
    .map((addr) => `        make new to recipient at end of to recipients with properties {address:"${esc(addr)}"}`)
    .join("\n");
  const ccRecipients = (opts.cc ?? [])
    .map((addr) => `        make new cc recipient at end of cc recipients with properties {address:"${esc(addr)}"}`)
    .join("\n");

  return `
tell application "Mail"
    set newMsg to make new outgoing message with properties {subject:"${esc(opts.subject)}", content:"${esc(opts.body)}", visible:true}
    tell newMsg
${recipients}
${ccRecipients}
    end tell
    ${send ? "send newMsg" : ""}
    return "ok"
end tell
`.trim();
}

/**
 * Create an unsent draft in Mail. Nothing leaves the machine — the draft opens
 * visibly so it can be reviewed.
 */
export function createDraft(opts: DraftOptions): string {
  return runAppleScript(outgoingMessageScript(opts, false), 20000);
}

/** Send a message immediately. Deliberately separate from createDraft. */
export function sendMessage(opts: DraftOptions): string {
  return runAppleScript(outgoingMessageScript(opts, true), 20000);
}
