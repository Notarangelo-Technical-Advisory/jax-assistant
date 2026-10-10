/**
 * Read recent text messages (iMessage and SMS) from the Messages database on
 * Jack's Mac, for automatic contact linking. Messages in iCloud keeps the Mac's
 * copy the same as the iPhone's.
 *
 * Apple offers no supported way to read message history, so this reads
 * ~/Library/Messages/chat.db with the sqlite3 tool that comes with macOS, opened
 * read-only. Each conversation's messages are grouped by day; only the day, the
 * number of messages, the first line and the people in the conversation are
 * passed on (see src/tools/contact-autolink.ts).
 *
 * Permission: Full Disk Access for the process running this, under
 * System Settings > Privacy & Security > Full Disk Access.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {homedir} from "os";
import {join} from "path";
import {TextDayItem} from "../tools/contact-autolink";

export class AppleMessagesError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AppleMessagesError";
  }
}

/** Messages counts time in seconds (older Macs) or nanoseconds from 1 January 2001. */
const APPLE_EPOCH_SECONDS = 978_307_200;

export function readMessagesSql(since: Date): string {
  const sinceSeconds = Math.floor(since.getTime() / 1000) - APPLE_EPOCH_SECONDS;
  const seconds = "(CASE WHEN m.date > 100000000000 THEN m.date / 1000000000 ELSE m.date END)";
  // associated_message_type 0 leaves out tapbacks; item_type 0 leaves out
  // events such as "renamed the conversation".
  return `
SELECT ${seconds} AS seconds,
       m.text AS text,
       hex(m.attributedBody) AS body,
       c.ROWID AS chatId,
       (SELECT group_concat(h.id, char(31)) FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
        WHERE j.chat_id = c.ROWID) AS handles
FROM message m
JOIN chat_message_join cm ON cm.message_id = m.ROWID
JOIN chat c ON c.ROWID = cm.chat_id
WHERE ${seconds} > ${sinceSeconds}
  AND m.associated_message_type = 0
  AND m.item_type = 0
ORDER BY ${seconds};
`.trim();
}

interface RawRow {
  seconds: number;
  text: string | null;
  body: string | null;
  chatId: number;
  handles: string | null;
}

/**
 * The words of a message that newer versions of macOS keep only in
 * attributedBody, an archived NSAttributedString: the string follows the
 * "NSString" class name, after five bytes, with its length in front of it.
 */
export function decodeAttributedBody(hex: string | null): string {
  if (!hex) return "";
  const bytes = Buffer.from(hex, "hex");
  const at = bytes.indexOf("NSString");
  if (at < 0) return "";
  let i = at + "NSString".length + 5;
  let length = bytes[i];
  if (length === 0x81) {
    length = bytes.readUInt16LE(i + 1);
    i += 3;
  } else if (length === 0x82) {
    length = bytes.readUInt32LE(i + 1);
    i += 5;
  } else {
    i += 1;
  }
  if (!length || i + length > bytes.length) return "";
  // U+FFFC stands for an attachment inside the text.
  return bytes.subarray(i, i + length).toString("utf-8").replace(/￼/g, "").trim();
}

/** YYYY-MM-DD in this computer's time zone, which on Jack's Mac is his own. */
function localDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {year: "numeric", month: "2-digit", day: "2-digit"}).format(date);
}

/** Turn sqlite3's JSON rows into one item per conversation per day. */
export function parseMessageRows(raw: string): TextDayItem[] {
  // sqlite3 prints nothing at all when no message matches.
  if (!raw.trim()) return [];
  let rows: RawRow[];
  try {
    rows = JSON.parse(raw) as RawRow[];
  } catch {
    throw new AppleMessagesError(`Messages returned unreadable output: ${raw.slice(0, 300)}`, "bad_output");
  }
  const days = new Map<string, TextDayItem>();
  for (const row of rows) {
    if (!Number.isFinite(row.seconds) || row.chatId == null) continue;
    const at = new Date((row.seconds + APPLE_EPOCH_SECONDS) * 1000);
    const day = localDay(at);
    const key = `${row.chatId}|${day}`;
    const words = (row.text ?? "").replace(/￼/g, "").trim() || decodeAttributedBody(row.body);
    let item = days.get(key);
    if (!item) {
      item = {
        chatId: String(row.chatId), day, firstAt: at.toISOString(), count: 0, firstLine: "",
        handles: (row.handles ?? "").split("\u001f").map((h) => h.trim()).filter(Boolean),
      };
      days.set(key, item);
    }
    item.count++;
    if (!item.firstLine && words) item.firstLine = words;
  }
  return [...days.values()];
}

/**
 * Text messages sent or received after `since`, grouped by conversation and
 * day. When MAISIE_MESSAGES_FIXTURE names a file, its contents stand in for
 * sqlite3's output (tests).
 */
export function readAppleMessages(since: Date): TextDayItem[] {
  const fixture = process.env.MAISIE_MESSAGES_FIXTURE;
  if (fixture) return parseMessageRows(readFileSync(fixture, "utf-8"));
  const database = join(homedir(), "Library", "Messages", "chat.db");
  let raw: string;
  try {
    raw = execFileSync("sqlite3", ["-readonly", "-json", database, readMessagesSql(since)], {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/authorization denied|unable to open/i.test(message)) {
      throw new AppleMessagesError(
        "Cannot open the Messages database. Give the process running this Full Disk Access in " +
        "System Settings > Privacy & Security > Full Disk Access.", "no_access");
    }
    throw new AppleMessagesError(`sqlite3 failed: ${message}`, "sqlite_failed");
  }
  return parseMessageRows(raw);
}
