import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import {addTimeEntries, getTrackerDay, TimeEntryInput} from "./tools/time-entries";
import {loadMemories} from "./tools/memories";
import {draftDescriptions, DraftRow, MAX_DRAFT_ROWS} from "./time-descriptions";

/**
 * The journal page's "Post time" panel, behind the timeEntries HTTP function:
 *   day   — the tracker's entries for a day, and its customers and projects
 *   draft — Maisie's description for each entry, in Jack's saved style
 *   post  — post the entries Jack approved on the page
 *
 * Posting uses the same addTimeEntries as the chat, so the page and the chat
 * apply the same checks. The page is the review step, so it posts for real.
 */
export async function runTimeEntriesAction(
  db: admin.firestore.Firestore,
  body: unknown,
  makeAnthropic: () => Anthropic
): Promise<{status: number; body: Record<string, unknown>}> {
  const input = (body ?? {}) as {action?: string; day?: string; rows?: DraftRow[]; entries?: TimeEntryInput[]};

  switch (input.action) {
  case "day":
    return reply(await getTrackerDay(input.day ?? ""));

  case "draft": {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (rows.length === 0) return {status: 400, body: {success: false, error: "Give at least one row to draft."}};
    if (rows.length > MAX_DRAFT_ROWS) {
      return {status: 400, body: {success: false, error: `Draft at most ${MAX_DRAFT_ROWS} rows at a time.`}};
    }
    const memories = await loadMemories(db).catch(() => []);
    try {
      const descriptions = await draftDescriptions(makeAnthropic(), rows, memories);
      return {status: 200, body: {success: true, descriptions}};
    } catch (err) {
      console.error("[timeEntries] draft failed:", err);
      return {status: 502, body: {success: false, error: "Maisie could not draft the descriptions. Try again, or write them yourself."}};
    }
  }

  case "post":
    return reply(await addTimeEntries({entries: input.entries, dry_run: false}));

  default:
    return {status: 400, body: {success: false, error: "action must be day, draft or post."}};
  }
}

/** A refused request is still an answer the page shows, so it is a 200 unless the input was malformed. */
const reply = (result: Record<string, unknown>) => ({status: 200, body: result});
