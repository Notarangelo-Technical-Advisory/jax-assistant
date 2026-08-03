/**
 * Desktop Bridge: watches Firestore for pendingDesktopActions and executes them
 * on this Mac via AppleScript, writing the result back.
 *
 * This is what lets the cloud MAISIE (web app, SMS) reach the desktop. It
 * replaces coding-bridge.ts, which watched pendingCodingTasks — a collection
 * nothing has written since the code_with_github tool switched to opening
 * GitHub issues.
 *
 * Usage:
 *   cd bridge && npm run desktop
 *
 * Requires a Firebase service account key at bridge/service-account.json and
 * macOS automation permission for Mail and Calendar. Run via launchd
 * (com.notarangelo.desktop-bridge.plist) for automatic execution every 30s.
 *
 * Note on scope: calendar create/move from the cloud still flows through the
 * older pendingCalendarActions queue, which calendar-sync.ts applies on its own
 * schedule. The calendar.* actions here exist so that path can migrate later
 * without another queue; nothing writes them today.
 */

// SSL bypass for this machine's certificate issues (same as calendar-sync)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createEvent, moveEvent } from "./applescript/calendar.js";
import { searchMessages, readMessage, createDraft, sendMessage } from "./applescript/mail.js";
import { speak } from "./speak.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const serviceAccountPath = join(__dirname, "service-account.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
db.settings({ preferRest: true });

// ─── Configuration ───────────────────────────────────────────────
const COLLECTION = "pendingDesktopActions";
/** Actions are seconds-long, so a claimed action stuck this long is dead. */
const STALE_RUNNING_MS = 2 * 60 * 1000;
/** Drain a few per poll — unlike coding tasks these are fast. */
const BATCH_SIZE = 5;

type DesktopAction =
  | "mail.search"
  | "mail.read"
  | "mail.draft"
  | "mail.send"
  | "calendar.create"
  | "calendar.move"
  | "speak";

// ─── Helpers ─────────────────────────────────────────────────────
async function writeWithRetry(
  ref: FirebaseFirestore.DocumentReference,
  data: Record<string, unknown>,
  retries = 3,
  delayMs = 2000
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await ref.update(data);
      return;
    } catch (err) {
      if (i < retries - 1) {
        console.warn(`[desktop-bridge] Firestore write failed (attempt ${i + 1}/${retries}), retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Fetch queued actions by status, oldest first.
 *
 * The composite index (status, createdAt) is declared in firestore.indexes.json
 * but only goes live when CI deploys on a push to main. Until then the ordered
 * query fails, so fall back to an unordered read and sort in memory — the batch
 * is at most BATCH_SIZE. Same pattern as the completedAt fallback in
 * functions/src/tools/context.ts.
 */
async function fetchByStatus(
  status: string,
  limit: number
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const coll = db.collection(COLLECTION);
  try {
    const snap = await coll
      .where("status", "==", status)
      .orderBy("createdAt", "asc")
      .limit(limit)
      .get();
    return snap.docs;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/requires an index/i.test(message)) throw err;
    console.warn(`[desktop-bridge] (status, createdAt) index not deployed yet — sorting in memory.`);
    const snap = await coll.where("status", "==", status).get();
    return snap.docs
      .sort((a, b) => (a.data()["createdAt"]?.toMillis?.() ?? 0) - (b.data()["createdAt"]?.toMillis?.() ?? 0))
      .slice(0, limit);
  }
}

/** Execute one action. Throws on failure; the caller records it. */
function execute(action: DesktopAction, payload: Record<string, unknown>): Record<string, unknown> {
  switch (action) {
  case "mail.search": {
    const messages = searchMessages({
      sender: payload["sender"] as string | undefined,
      subject: payload["subject"] as string | undefined,
      daysBack: payload["daysBack"] as number | undefined,
      mailbox: payload["mailbox"] as string | undefined,
      limit: payload["limit"] as number | undefined,
    });
    return {
      count: messages.length,
      messages: messages.map((m) => ({
        messageId: m.messageId,
        subject: m.subject,
        sender: m.sender,
        received: m.dateReceived.toISOString(),
        read: m.wasRead,
      })),
    };
  }

  case "mail.read": {
    const result = readMessage(
      payload["messageId"] as string,
      payload["mailbox"] as string | undefined
    );
    if (!result.found) return { found: false };
    return {
      found: true,
      subject: result.subject,
      sender: result.sender,
      // Cap the body — this round-trips through a chat context window.
      content: (result.content ?? "").substring(0, 4000),
    };
  }

  case "mail.draft": {
    createDraft({
      to: payload["to"] as string[],
      subject: payload["subject"] as string,
      body: payload["body"] as string,
      cc: payload["cc"] as string[] | undefined,
    });
    return { success: true, sent: false };
  }

  case "mail.send": {
    // Not reachable from the cloud by design — the chat function never enqueues
    // mail.send. Kept so a locally-enqueued action can still use it.
    sendMessage({
      to: payload["to"] as string[],
      subject: payload["subject"] as string,
      body: payload["body"] as string,
      cc: payload["cc"] as string[] | undefined,
    });
    return { success: true, sent: true };
  }

  case "calendar.create": {
    createEvent({
      title: payload["title"] as string,
      date: payload["date"] as string,
      startTime: payload["startTime"] as string,
      endTime: payload["endTime"] as string,
      location: (payload["location"] as string) ?? null,
      notes: (payload["notes"] as string) ?? null,
    });
    return { success: true };
  }

  case "calendar.move": {
    const result = moveEvent({
      eventTitle: payload["eventTitle"] as string,
      originalDate: payload["originalDate"] as string,
      newDate: payload["newDate"] as string,
      newStartTime: payload["newStartTime"] as string,
      newEndTime: payload["newEndTime"] as string,
    });
    if (result === "not_found") return { success: false, error: "Event not found in Apple Calendar" };
    return { success: true };
  }

  case "speak": {
    const text = (payload["text"] as string) ?? "";
    const audio = payload["audioBase64"] as string | undefined;
    const outcome = speak(text, audio);
    if (!outcome.spoken) throw new Error("Could not produce audio via afplay or say");
    return { spoken: true, via: outcome.via, text };
  }

  default:
    throw new Error(`Unknown action "${action}"`);
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function run(): Promise<void> {
  // Recover actions claimed by a run that died before writing a result.
  const staleDocs = await fetchByStatus("running", 5).catch(() => null);

  if (staleDocs) {
    const cutoff = Date.now() - STALE_RUNNING_MS;
    for (const staleDoc of staleDocs) {
      const startedMs = staleDoc.data()["startedAt"]?.toMillis?.() ?? 0;
      if (startedMs < cutoff) {
        console.warn(`[desktop-bridge] Recovering stale action ${staleDoc.id}`);
        await writeWithRetry(staleDoc.ref, {
          status: "failed",
          appliedAt: FieldValue.serverTimestamp(),
          result: null,
          error: "Action timed out — the bridge never recorded a result.",
        }).catch(() => {/* best-effort */});
      }
    }
  }

  const docs = await fetchByStatus("pending", BATCH_SIZE);

  if (docs.length === 0) {
    console.log("[desktop-bridge] No pending actions.");
    return;
  }

  for (const doc of docs) {
    const data = doc.data();
    const action = data["action"] as DesktopAction;
    const payload = (data["payload"] ?? {}) as Record<string, unknown>;

    // Spoken alerts can carry a schedule. `notBefore` is how "stay quiet during
    // meetings" is honoured — the cloud sets it to the end of whatever is in
    // progress and the action simply waits here, still pending, until a later
    // poll. Leave it unclaimed so nothing else has to know about deferral.
    const notBeforeMs = data["notBefore"]?.toMillis?.() ?? 0;
    if (notBeforeMs > Date.now()) {
      const waitMin = Math.ceil((notBeforeMs - Date.now()) / 60000);
      console.log(`[desktop-bridge] Deferring ${doc.id} (${action}) for ~${waitMin} min`);
      continue;
    }

    // An alert about a meeting that has already begun is worse than silence —
    // it invites acting on stale information. Drop it rather than speak it.
    const expiresMs = data["expiresAt"]?.toMillis?.() ?? 0;
    if (expiresMs && expiresMs < Date.now()) {
      console.warn(`[desktop-bridge] Expired ${doc.id} (${action}) — dropping unspoken`);
      await writeWithRetry(doc.ref, {
        status: "failed",
        appliedAt: FieldValue.serverTimestamp(),
        result: null,
        error: "Expired before it could be delivered (Mac asleep, or deferred past the event).",
      }).catch(() => {/* best-effort */});
      continue;
    }

    // Claim first so a concurrent run cannot double-execute.
    try {
      await doc.ref.update({ status: "running", startedAt: FieldValue.serverTimestamp() });
    } catch (claimErr) {
      console.error(`[desktop-bridge] Could not claim ${doc.id} (will retry next poll):`, claimErr);
      continue;
    }

    try {
      const result = execute(action, payload);
      await writeWithRetry(doc.ref, {
        status: "applied",
        appliedAt: FieldValue.serverTimestamp(),
        result,
        error: null,
      });
      console.log(`[desktop-bridge] [${action}] applied ${doc.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeWithRetry(doc.ref, {
        status: "failed",
        appliedAt: FieldValue.serverTimestamp(),
        result: null,
        error: message.substring(0, 500),
      }).catch(() => {/* best-effort */});
      console.error(`[desktop-bridge] [${action}] failed ${doc.id}:`, message.substring(0, 300));
    }
  }
}

run().catch((err) => {
  console.error("[desktop-bridge] Fatal error:", err);
  // Exit 0 so launchd does not treat this as a crash loop.
  process.exit(0);
});
