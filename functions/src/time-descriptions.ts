import Anthropic from "@anthropic-ai/sdk";
import {MODEL} from "./model";
import {Memory, formatMemories} from "./tools/memories";

/**
 * Drafts the invoice description for each time entry Jack is about to post
 * from the journal page. The page sends one row per entry with the journal
 * items behind it; the reply is one description per row, in the same order.
 *
 * Runs on MODEL, not LIGHT_MODEL: these lines go on a client's invoice, so a
 * vague or invented line costs Jack time to fix and could mislead a client.
 * Jack's standing instructions (memories) are sent in full, because his style
 * for invoice descriptions is one of them.
 */

export interface DraftItem {
  source: string;
  action: string;
  subject: string;
  ticket?: string | null;
  repo?: string | null;
}

export interface DraftRow {
  /** The client's name, such as "IHRDC". */
  client: string;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM, Eastern Time. */
  start: string;
  end: string;
  items: DraftItem[];
}

export const MAX_DRAFT_ROWS = 50;
const MAX_ITEMS_PER_ROW = 60;

const SYSTEM = `You write the description lines on Jack Notarangelo's consulting invoices. Each line describes one time entry, from the work journal items recorded during it: pull requests, Jira changes, Claude Code sessions, meetings and recordings.

Follow Jack's standing instructions below wherever they say how invoice descriptions should be written; they take priority over the defaults here. Default style when they say nothing: one plain-English line, past tense, naming the ticket keys and the work done, at most 20 words.

Describe only what the items show. Never invent work, outcomes, people or ticket numbers. Write for the client, who reads English as a second language: no jargon, no internal tool names unless the client would know them.`;

/** The system prompt and the user message for one request. Pure, so it can be tested. */
export function buildDraftRequest(rows: DraftRow[], memories: Memory[]): {system: string; user: string} {
  const standing = formatMemories(memories);
  const system = standing ? `${SYSTEM}\n\n${standing}` : SYSTEM;
  const entries = rows.map((r, i) => ({
    entry: i + 1,
    client: r.client,
    date: r.date,
    time: `${r.start}-${r.end}`,
    items: r.items.slice(0, MAX_ITEMS_PER_ROW).map((it) => ({
      source: it.source,
      action: it.action,
      subject: it.subject,
      ...(it.ticket ? {ticket: it.ticket} : {}),
      ...(it.repo ? {repo: it.repo} : {}),
    })),
  }));
  const user = `Write one invoice description for each of these ${rows.length} time entries, in the same order.\n\n${JSON.stringify(entries)}`;
  return {system, user};
}

/** The JSON the reply must match: one description per entry. */
export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    descriptions: {type: "array", items: {type: "string"}},
  },
  required: ["descriptions"],
  additionalProperties: false,
};

/** The descriptions from a reply's text, checked against the number of rows asked for. */
export function readDrafts(text: string, count: number): string[] {
  const parsed = JSON.parse(text) as {descriptions?: unknown};
  const list = Array.isArray(parsed.descriptions) ? parsed.descriptions : [];
  if (list.length !== count || list.some((d) => typeof d !== "string")) {
    throw new Error(`Expected ${count} descriptions, got ${list.length}.`);
  }
  return (list as string[]).map((d) => d.trim());
}

export async function draftDescriptions(
  anthropic: Anthropic,
  rows: DraftRow[],
  memories: Memory[]
): Promise<string[]> {
  const {system, user} = buildDraftRequest(rows, memories);
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: {type: "adaptive"},
    // Short lines from a list of facts: medium is plenty.
    output_config: {effort: "medium", format: {type: "json_schema", schema: DRAFT_SCHEMA}},
    // If a safety check declines the request, let the API retry it on a
    // suitable model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{role: "user", content: user}],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`The model declined to draft the descriptions (${response.stop_details?.category ?? "no category"}).`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("The descriptions reply reached max_tokens.");
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  if (!text) throw new Error("The reply had no text.");
  return readDrafts(text.text, rows.length);
}
