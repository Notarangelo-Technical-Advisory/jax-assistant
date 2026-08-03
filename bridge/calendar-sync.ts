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
  READ_CALENDARS,
  type ParsedEvent,
} from "./applescript/calendar.js";
import { runAppleScript } from "./applescript/run.js";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createHash } from "crypto";
import { readFileSync, unlinkSync, openSync, writeSync, closeSync, statSync } from "fs";
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

/**
 * Schema version of the calendarEvents keying scheme. Bumping this makes the
 * next run re-key every document without reporting the churn as real change.
 *
 * 1 → doc id was `calendarName__summary__startISO` (a move looked like
 *     delete + create, so nothing downstream could recognise a reschedule)
 * 2 → doc id is a hash of the Apple Calendar uid, which survives a move
 */
const SCHEMA_VERSION = 2;

/**
 * A change is "material" — worth re-narrating the briefing for — only when it
 * lands inside this window. A meeting moving six days out does not need to
 * interrupt today's briefing.
 */
const MATERIAL_WINDOW_MS = 48 * 60 * 60 * 1000;

const LOCK_PATH = "/tmp/calendar-sync.lock";
/** Treat a lock older than this as abandoned (osascript hung, process killed). */
const LOCK_STALE_MS = 5 * 60 * 1000;

// ─── Event identity ─────────────────────────────────────────────

/** Local YYYY-MM-DD, used to pin a recurring occurrence to its day. */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Stable Firestore document id for an event.
 *
 * Keyed on the Apple Calendar uid so that rescheduling an event updates its
 * document in place instead of deleting one and creating another — that is what
 * lets the briefing say "your 2pm moved to 4pm" rather than "one event was
 * cancelled and another appeared". Hashed because uids contain `/` and `.`,
 * which Firestore forbids in document ids.
 *
 * The calendar name is part of the key because the same invitation sitting on
 * two allowlisted calendars shares one uid, and both copies should survive.
 *
 * Recurring series: every occurrence shares a single uid, so the occurrence's
 * own date is folded in. The consequence is that dragging one occurrence to a
 * different day still reads as delete + create. Expanding series properly would
 * mean tracking RECURRENCE-ID, which AppleScript does not expose.
 *
 * Events with no uid fall back to content-based identity under a separate
 * prefix, so they cannot collide with the uid-keyed space.
 */
function eventDocId(e: ParsedEvent): string {
  const key = e.uid
    ? e.recurring
      ? `uid|${e.calendarName}|${e.uid}|${localDateKey(e.startTime)}`
      : `uid|${e.calendarName}|${e.uid}`
    : `content|${e.calendarName}|${e.summary}|${e.startTime.toISOString()}`;
  return createHash("sha1").update(key).digest("hex");
}

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

type ChangeKind = "added" | "moved" | "updated" | "deleted";

interface ChangeEntry {
  summary: string;
  kind: ChangeKind;
  startISO: string;
  calendarName: string;
}

/** How many changed events to name in the beacon — enough for prose, bounded. */
const MAX_CHANGE_ENTRIES = 10;

async function syncToFirestore(events: ParsedEvent[]): Promise<void> {
  const collRef = db.collection("calendarEvents");
  const now = Timestamp.now();
  const nowMs = Date.now();

  // A re-key run rewrites every document because the id scheme changed, not
  // because the calendar changed. Report it as churn-free so the briefing does
  // not announce the entire week as new.
  const metaRef = db.collection("metadata").doc("calendarSync");
  const metaSnap = await metaRef.get().catch(() => null);
  const storedVersion = (metaSnap?.data()?.["schemaVersion"] as number | undefined) ?? 1;
  const isRekey = storedVersion !== SCHEMA_VERSION;

  const existingSnap = await collRef.get();
  const existingById = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));
  const seenIds = new Set<string>();

  const batch = db.batch();
  const changes: ChangeEntry[] = [];
  let added = 0;
  let moved = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  const record = (kind: ChangeKind, summary: string, startISO: string, calendarName: string) => {
    if (changes.length < MAX_CHANGE_ENTRIES) {
      changes.push({ kind, summary, startISO, calendarName });
    }
  };

  for (const event of events) {
    const docId = eventDocId(event);
    seenIds.add(docId);

    const startTs = Timestamp.fromDate(event.startTime);
    const endTs = Timestamp.fromDate(event.endTime);
    const fields = {
      summary: event.summary,
      startTime: startTs,
      endTime: endTs,
      location: event.location || null,
      notes: event.notes || null,
      calendarName: event.calendarName,
      uid: event.uid || null,
      recurring: event.recurring,
    };

    const prev = existingById.get(docId);

    if (!prev) {
      batch.set(collRef.doc(docId), {
        ...fields,
        syncedAt: now,
        changedAt: now,
        changeKind: "added" as const,
      });
      added++;
      record("added", event.summary, event.startTime.toISOString(), event.calendarName);
      continue;
    }

    // Only write when something a reader would notice actually differs. The old
    // code updated every document on every run, which meant 96 pointless writes
    // a day and no way to tell a real change from a heartbeat.
    const prevStart = prev["startTime"]?.toDate?.()?.getTime();
    const prevEnd = prev["endTime"]?.toDate?.()?.getTime();
    const timeChanged =
      prevStart !== event.startTime.getTime() || prevEnd !== event.endTime.getTime();
    const detailChanged =
      prev["summary"] !== fields.summary ||
      (prev["location"] ?? null) !== fields.location ||
      (prev["notes"] ?? null) !== fields.notes ||
      (prev["uid"] ?? null) !== fields.uid ||
      Boolean(prev["recurring"]) !== fields.recurring;

    if (!timeChanged && !detailChanged) {
      unchanged++;
      continue;
    }

    const kind: ChangeKind = timeChanged ? "moved" : "updated";
    batch.update(collRef.doc(docId), {
      ...fields,
      syncedAt: now,
      changedAt: now,
      changeKind: kind,
    });
    if (timeChanged) moved++; else updated++;
    record(kind, event.summary, event.startTime.toISOString(), event.calendarName);
  }

  // Delete events that are gone from Apple Calendar
  for (const [docId, data] of existingById) {
    if (seenIds.has(docId)) continue;
    batch.delete(collRef.doc(docId));
    deleted++;
    const start = data["startTime"]?.toDate?.() ?? new Date(0);
    record("deleted", (data["summary"] as string) ?? "Untitled", start.toISOString(),
      (data["calendarName"] as string) ?? "");
  }

  await batch.commit();

  // A change matters to the briefing when it lands inside the material window.
  // Detail-only edits (a tweaked note, a room change) are recorded but do not
  // justify re-narrating.
  const materialChange =
    !isRekey &&
    changes.some(
      (c) =>
        c.kind !== "updated" &&
        (() => {
          const t = new Date(c.startISO).getTime();
          return t >= nowMs - MATERIAL_WINDOW_MS && t <= nowMs + MATERIAL_WINDOW_MS;
        })()
    );

  // Two beacons, deliberately separate:
  //
  //  metadata/calendarSync   — heartbeat, written every run. runBriefing reads
  //                            lastRun to raise its "calendar data may be stale"
  //                            alert, so it must keep ticking even when nothing
  //                            changed.
  //  metadata/calendarChange — written ONLY when something actually changed.
  //                            onCalendarSync triggers off this one, so the
  //                            function fires a handful of times a day instead of
  //                            once per sync tick.
  await metaRef.set({
    lastRun: now,
    eventCount: events.length,
    schemaVersion: SCHEMA_VERSION,
  });

  const changed = added + moved + updated + deleted;
  if (changed > 0 && !isRekey) {
    await db.collection("metadata").doc("calendarChange").set({
      changedAt: now,
      added,
      moved,
      updated,
      deleted,
      materialChange,
      changes,
    });
  }

  const doneTs = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const suffix = isRekey ? " (re-key to schema v2, change reporting suppressed)" : "";
  console.log(
    `[${doneTs}] Sync complete: ${added} added, ${moved} moved, ${updated} updated, ` +
    `${deleted} deleted, ${unchanged} unchanged. Total: ${events.length} events.` +
    `${changed > 0 && !isRekey ? ` material=${materialChange}` : ""}${suffix}`
  );
}

// ─── Single-instance lock ────────────────────────────────────────
/**
 * Now that the sync runs every couple of minutes, two runs can in principle
 * overlap — the AppleScript read is allowed up to 120s if Calendar is wedged,
 * and a manual `npm run sync` can land on top of a scheduled one. Two
 * concurrent runs would race on the same delete-stale pass.
 *
 * Returns false when another live run holds the lock.
 */
function acquireLock(): boolean {
  const claim = (): boolean => {
    try {
      const fd = openSync(LOCK_PATH, "wx"); // wx fails if the file already exists
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (claim()) return true;

  // Lock exists — decide whether its owner is still alive.
  let holderAlive = false;
  try {
    const holder = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
    if (Number.isInteger(holder) && holder > 0) {
      process.kill(holder, 0); // signal 0 only tests for existence
      holderAlive = true;
    }
  } catch {
    holderAlive = false; // unreadable lock, or no such process
  }

  let ageMs = Infinity;
  try {
    ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
  } catch { /* vanished between checks — fall through and re-claim */ }

  if (holderAlive && ageMs < LOCK_STALE_MS) return false;

  // Abandoned lock: a crashed run, or one wedged past the stale threshold.
  try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  return claim();
}

function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

// ─── Main ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  if (!acquireLock()) {
    console.log(`[${ts}] Another sync is still running — skipping this tick.`);
    return;
  }

  try {
    console.log(`[${ts}] Starting sync...`);

    // Apply any pending calendar write actions before reading
    await applyPendingActions();

    console.log(`[${ts}] Syncing ${READ_CALENDARS.length} calendars (${READ_CALENDARS.map((c) => c.label).join(", ")}) for the next ${SYNC_DAYS_AHEAD} days...`);
    const events = readCalendarEvents();
    await syncToFirestore(events);
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  console.error("Calendar sync failed:", err);
  releaseLock();
  process.exit(1);
});
