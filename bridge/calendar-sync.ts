/**
 * Calendar Bridge: Reads Apple Calendar events via AppleScript and syncs them to Firestore.
 *
 * Usage:
 *   cd bridge && npm run sync
 *
 * Requires a Firebase service account key at bridge/service-account.json
 * (gitignored — download from Firebase Console > Project Settings > Service Accounts)
 */

// SSL bypass for this machine's certificate issues (same as Firebase CLI)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// gRPC also needs the env var before any imports touch it
process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

import {
  readEvents,
  createEventScript,
  moveEventScript,
  CALENDAR_NAME,
  type ParsedEvent,
} from "./applescript/calendar.js";
import { runAppleScript } from "./applescript/run.js";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Firebase init ──────────────────────────────────────────────
const serviceAccountPath = join(__dirname, "service-account.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

initializeApp({ credential: cert(serviceAccount) });
// Use REST instead of gRPC — gRPC has its own TLS stack that ignores NODE_TLS_REJECT_UNAUTHORIZED
const db = getFirestore();
db.settings({ preferRest: true });

// ─── Configuration ──────────────────────────────────────────────
const SYNC_DAYS_AHEAD = 7;

// ─── Apply pending calendar actions from Firestore ───────────────
interface PendingAction {
  id: string;
  action: "create" | "move" | "delete";
  payload: Record<string, string | null>;
}


async function applyPendingActions(): Promise<void> {
  const snap = await db.collection("pendingCalendarActions")
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .get();

  if (snap.empty) return;

  console.log(`Applying ${snap.docs.length} pending calendar action(s)...`);

  for (const doc of snap.docs) {
    const data = doc.data() as PendingAction & Record<string, unknown>;
    const action = data.action as PendingAction["action"];
    const payload = (data["payload"] ?? {}) as Record<string, string | null>;

    let script: string;
    try {
      if (action === "create") {
        script = createEventScript(payload);
      } else if (action === "move") {
        script = moveEventScript(payload);
      } else {
        // delete not yet implemented — mark failed
        await doc.ref.update({status: "failed", error: `Action "${action}" not implemented`, appliedAt: Timestamp.now()});
        continue;
      }

      const result = runAppleScript(script, 15000);

      if (action === "move" && result === "not_found") {
        await doc.ref.update({status: "failed", error: "Event not found in Apple Calendar", appliedAt: Timestamp.now()});
        console.warn(`[${action}] Event not found: "${payload["eventTitle"]}" on ${payload["originalDate"]}`);
      } else {
        await doc.ref.update({status: "applied", appliedAt: Timestamp.now(), error: null});
        console.log(`[${action}] Applied: ${action === "create" ? payload["title"] : payload["eventTitle"]}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await doc.ref.update({status: "failed", error: errMsg.substring(0, 500), appliedAt: Timestamp.now()});
      console.error(`[${action}] Failed:`, errMsg);
    }
  }
}

// ─── Read Apple Calendar via AppleScript ─────────────────────────
// Script builders and parsing live in applescript/calendar.ts so the desktop
// MCP server and the desktop bridge share exactly one definition.
function readCalendarEvents(): ParsedEvent[] {
  return readEvents(SYNC_DAYS_AHEAD);
}

// ─── Sync to Firestore ──────────────────────────────────────────
async function syncToFirestore(events: ParsedEvent[]): Promise<void> {
  const collRef = db.collection("calendarEvents");
  const now = Timestamp.now();

  // Build a unique key for each event to enable upsert
  const eventKey = (e: ParsedEvent) =>
    `${e.summary}__${e.startTime.toISOString()}`;

  // Get existing synced events
  const existingSnap = await collRef.get();
  const existingByKey = new Map<string, string>(); // key -> docId
  for (const doc of existingSnap.docs) {
    const data = doc.data();
    const start = data.startTime?.toDate?.() ?? new Date(data.startTime);
    const key = `${data.summary}__${start.toISOString()}`;
    existingByKey.set(key, doc.id);
  }

  const incomingKeys = new Set(events.map(eventKey));
  const batch = db.batch();
  let added = 0;
  let updated = 0;
  let deleted = 0;

  // Upsert incoming events
  for (const event of events) {
    const key = eventKey(event);
    const docData = {
      summary: event.summary,
      startTime: Timestamp.fromDate(event.startTime),
      endTime: Timestamp.fromDate(event.endTime),
      location: event.location || null,
      notes: event.notes || null,
      calendarName: CALENDAR_NAME,
      syncedAt: now,
    };

    const existingId = existingByKey.get(key);
    if (existingId) {
      batch.update(collRef.doc(existingId), docData);
      updated++;
    } else {
      batch.create(collRef.doc(), docData);
      added++;
    }
  }

  // Delete stale events (in Firestore but not in Apple Calendar anymore)
  for (const [key, docId] of existingByKey) {
    if (!incomingKeys.has(key)) {
      batch.delete(collRef.doc(docId));
      deleted++;
    }
  }

  await batch.commit();

  // Write sync metadata so the briefing function can detect staleness
  await db.collection("metadata").doc("calendarSync").set({
    lastRun: Timestamp.now(),
    eventCount: events.length,
  });

  const doneTs = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  console.log(
    `[${doneTs}] Sync complete: ${added} added, ${updated} updated, ${deleted} deleted. Total: ${events.length} events.`
  );
}

// ─── Main ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  console.log(`[${ts}] Starting sync...`);

  // Apply any pending calendar write actions before reading
  await applyPendingActions();

  console.log(`[${ts}] Syncing "${CALENDAR_NAME}" calendar (next ${SYNC_DAYS_AHEAD} days)...`);
  const events = readCalendarEvents();
  await syncToFirestore(events);
}

main().catch((err) => {
  console.error("Calendar sync failed:", err);
  process.exit(1);
});
