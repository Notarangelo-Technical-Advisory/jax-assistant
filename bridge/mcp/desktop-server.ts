/**
 * Desktop MCP server — gives Claude Code in VS Code native access to Apple
 * Mail and Apple Calendar via AppleScript.
 *
 * Usage (from bridge/):
 *   npx tsx mcp/desktop-server.ts
 *
 * Requires macOS automation permission for the terminal/VS Code host to control
 * Mail and Calendar (System Settings > Privacy & Security > Automation). Mail
 * must be running for the mail tools to work.
 *
 * Calendar reads and writes here are live — they do not go through the
 * Firestore mirror, so they are fresher than MAISIE's get_calendar and apply
 * instantly instead of queueing. The tradeoff is that the mirror stays stale
 * until the next launchd sync, so the web dashboard can lag behind.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readEvents, createEvent, moveEvent, CALENDAR_NAME, READ_CALENDARS } from "../applescript/calendar.js";
import { searchMessages, readMessage, createDraft, sendMessage } from "../applescript/mail.js";

const server = new Server(
  { name: "desktop", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "calendar_read",
    description: `Read events across all of Jack's tracked Apple Calendars, live: ${READ_CALENDARS.map((c) => c.label).join(", ")}. Every event carries the calendar it came from, so say which one when it matters — "IHRDC" is client work, "Grace Pres" is church. Prefer this over MAISIE's get_calendar: it reflects the calendars right now, whereas the Firestore mirror can be up to a minute stale (or much staler if the launchd sync is not running).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        days_ahead: {
          type: "number",
          description: "How many days forward from now to read. Default 7.",
        },
      },
      required: [],
    },
  },
  {
    name: "calendar_create",
    description: `Create an event. Always lands on the "${CALENDAR_NAME}" calendar — reads span several calendars but writes only go here, so do not offer to put something on IHRDC or a shared calendar. Applies immediately. The Firestore mirror will not reflect it until the next bridge sync, so the MAISIE web dashboard may lag — say so rather than claiming it is everywhere.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        start_time: { type: "string", description: "Start time HH:MM (24-hour, local)" },
        end_time: { type: "string", description: "End time HH:MM (24-hour, local)" },
        location: { type: "string", description: "Optional location" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["title", "date", "start_time", "end_time"],
    },
  },
  {
    name: "calendar_move",
    description: "Reschedule an existing event. Matches on exact title within the original date. Applies immediately; returns not_found if no event matches.",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_title: { type: "string", description: "Exact title of the event to move" },
        original_date: { type: "string", description: "Current date in YYYY-MM-DD format" },
        new_date: { type: "string", description: "New date in YYYY-MM-DD format" },
        new_start_time: { type: "string", description: "New start time HH:MM (24-hour)" },
        new_end_time: { type: "string", description: "New end time HH:MM (24-hour)" },
      },
      required: ["event_title", "original_date", "new_date", "new_start_time", "new_end_time"],
    },
  },
  {
    name: "mail_search",
    description: "Search Apple Mail by sender and/or subject within a recent time window. Returns message IDs, subjects, senders, dates, and read status — not bodies. Use mail_read for a body. Mail.app must be running.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sender: { type: "string", description: "Substring matched against the sender name or address, e.g. 'Donohue'" },
        subject: { type: "string", description: "Substring matched against the subject" },
        days_back: { type: "number", description: "How many days back to search. Default 7." },
        mailbox: { type: "string", description: "Mailbox name to search. Defaults to the inbox." },
        limit: { type: "number", description: "Maximum messages to return. Default 25." },
      },
      required: [],
    },
  },
  {
    name: "mail_read",
    description: "Read the full body of one message, located by the message_id returned from mail_search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: { type: "string", description: "RFC Message-ID from mail_search" },
        mailbox: { type: "string", description: "Mailbox to look in. Defaults to the inbox." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "mail_draft",
    description: "Compose an UNSENT draft in Mail and open it for review. Nothing is transmitted. This is the default way to write email — use mail_send only when Jack has explicitly approved sending.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body, plain text" },
        cc: { type: "array", items: { type: "string" }, description: "Optional CC addresses" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "mail_send",
    description: "Send an email immediately. This transmits to real recipients and cannot be undone — only use it after Jack has explicitly confirmed the recipients and the body. When in doubt use mail_draft instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body, plain text" },
        cc: { type: "array", items: { type: "string" }, description: "Optional CC addresses" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  const ok = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });
  const fail = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });

  try {
    switch (name) {
    case "calendar_read": {
      const events = readEvents((args["days_ahead"] as number) ?? 7);
      return ok({
        calendars: READ_CALENDARS.map((c) => c.label),
        source: "Apple Calendar (live)",
        count: events.length,
        events: events.map((e) => ({
          calendar: e.calendarName,
          summary: e.summary,
          start: e.startTime.toISOString(),
          end: e.endTime.toISOString(),
          location: e.location || null,
          notes: e.notes || null,
        })),
      });
    }

    case "calendar_create": {
      createEvent({
        title: args["title"] as string,
        date: args["date"] as string,
        startTime: args["start_time"] as string,
        endTime: args["end_time"] as string,
        location: (args["location"] as string) ?? null,
        notes: (args["notes"] as string) ?? null,
      });
      return ok({
        success: true,
        message: `Created "${args["title"] as string}" on ${args["date"] as string}. Live in Apple Calendar now; the MAISIE dashboard will catch up on the next bridge sync.`,
      });
    }

    case "calendar_move": {
      const result = moveEvent({
        eventTitle: args["event_title"] as string,
        originalDate: args["original_date"] as string,
        newDate: args["new_date"] as string,
        newStartTime: args["new_start_time"] as string,
        newEndTime: args["new_end_time"] as string,
      });
      if (result === "not_found") {
        return ok({
          success: false,
          error: `No event titled "${args["event_title"] as string}" found on ${args["original_date"] as string}.`,
        });
      }
      return ok({
        success: true,
        message: `Moved "${args["event_title"] as string}" to ${args["new_date"] as string}. Live in Apple Calendar now; the dashboard catches up on the next sync.`,
      });
    }

    case "mail_search": {
      const messages = searchMessages({
        sender: args["sender"] as string | undefined,
        subject: args["subject"] as string | undefined,
        daysBack: args["days_back"] as number | undefined,
        mailbox: args["mailbox"] as string | undefined,
        limit: args["limit"] as number | undefined,
      });
      return ok({
        count: messages.length,
        messages: messages.map((m) => ({
          message_id: m.messageId,
          subject: m.subject,
          sender: m.sender,
          received: m.dateReceived.toISOString(),
          read: m.wasRead,
        })),
      });
    }

    case "mail_read": {
      const result = readMessage(
        args["message_id"] as string,
        args["mailbox"] as string | undefined
      );
      if (!result.found) {
        return ok({ found: false, error: `No message with ID ${args["message_id"] as string}.` });
      }
      return ok(result);
    }

    case "mail_draft": {
      createDraft({
        to: args["to"] as string[],
        subject: args["subject"] as string,
        body: args["body"] as string,
        cc: args["cc"] as string[] | undefined,
      });
      return ok({
        success: true,
        sent: false,
        message: "Draft created and opened in Mail. Nothing was sent.",
      });
    }

    case "mail_send": {
      sendMessage({
        to: args["to"] as string[],
        subject: args["subject"] as string,
        body: args["body"] as string,
        cc: args["cc"] as string[] | undefined,
      });
      return ok({
        success: true,
        sent: true,
        recipients: args["to"] as string[],
        message: "Message sent.",
      });
    }

    default:
      return fail(`Unknown tool "${name}".`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // osascript exits non-zero when automation permission is missing.
    const hint = /not authori[sz]ed|not allowed assistive|-1743/i.test(message)
      ? " — this usually means macOS automation permission is missing. Grant it in System Settings > Privacy & Security > Automation for your terminal or VS Code."
      : "";
    return fail(`Tool "${name}" failed: ${message}${hint}`);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol — log to stderr only.
  console.error("[desktop-mcp] ready");
}

main().catch((err) => {
  console.error("[desktop-mcp] fatal:", err);
  process.exit(1);
});
