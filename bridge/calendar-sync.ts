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

import { execSync } from "child_process";
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
const CALENDAR_NAME = "Jax";
const SYNC_DAYS_AHEAD = 7;

interface ParsedEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  location: string;
  notes: string;
}

// ─── Apply pending calendar actions from Firestore ───────────────
interface PendingAction {
  id: string;
  action: "create" | "move" | "delete";
  payload: Record<string, string | null>;
}

function appleScriptDate(dateStr: string, timeStr: string): string {
  // Converts "2026-03-20" + "14:00" into AppleScript date: "03/20/2026 14:00:00"
  const [year, month, day] = dateStr.split("-");
  return `${month}/${day}/${year} ${timeStr}:00`;
}

function createEventScript(payload: Record<string, string | null>): string {
  const startStr = appleScriptDate(payload["date"] as string, payload["startTime"] as string);
  const endStr = appleScriptDate(payload["date"] as string, payload["endTime"] as string);
  const title = (payload["title"] as string).replace(/"/g, '\\"');
  const location = payload["location"] ? `set location of newEvent to "${(payload["location"] as string).replace(/"/g, '\\"')}"` : "";
  const notes = payload["notes"] ? `set description of newEvent to "${(payload["notes"] as string).replace(/"/g, '\\"')}"` : "";
  return `
tell application "Calendar"
  set cal to first calendar whose name is "${CALENDAR_NAME}"
  set newEvent to make new event at end of events of cal with properties {summary:"${title}", start date:date "${startStr}", end date:date "${endStr}"}
  ${location}
  ${notes}
  save
end tell
`.trim();
}

function moveEventScript(payload: Record<string, string | null>): string {
  const title = (payload["eventTitle"] as string).replace(/"/g, '\\"');
  const originalDateStr = payload["originalDate"] as string;
  const [origYear, origMonth, origDay] = originalDateStr.split("-");
  const newStartStr = appleScriptDate(payload["newDate"] as string, payload["newStartTime"] as string);
  const newEndStr = appleScriptDate(payload["newDate"] as string, payload["newEndTime"] as string);
  return `
tell application "Calendar"
  set cal to first calendar whose name is "${CALENDAR_NAME}"
  set searchStart to date "${origMonth}/${origDay}/${origYear} 00:00:00"
  set searchEnd to date "${origMonth}/${origDay}/${origYear} 23:59:59"
  set matchingEvents to (every event of cal whose summary is "${title}" and start date ≥ searchStart and start date ≤ searchEnd)
  if (count of matchingEvents) > 0 then
    set targetEvent to item 1 of matchingEvents
    set start date of targetEvent to date "${newStartStr}"
    set end date of targetEvent to date "${newEndStr}"
    save
    return "ok"
  else
    return "not_found"
  end if
end tell
`.trim();
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

      const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: "utf-8",
        timeout: 15000,
      }).trim();

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
function readCalendarEvents(): ParsedEvent[] {
  const script = `
set startDate to (current date)
set endDate to startDate + ${SYNC_DAYS_AHEAD} * days
set output to ""
tell application "Calendar"
    set cal to first calendar whose name is "${CALENDAR_NAME}"
    set evts to (every event of cal whose start date ≥ startDate and start date < endDate)
    repeat with e in evts
        set evtStart to start date of e
        set evtEnd to end date of e
        set evtSummary to summary of e
        set evtLocation to ""
        set evtNotes to ""
        try
            set evtLocation to location of e
        end try
        try
            set evtNotes to description of e
        end try
        if evtLocation is missing value then set evtLocation to ""
        if evtNotes is missing value then set evtNotes to ""
        set output to output & evtSummary & "|||" & (evtStart as «class isot» as string) & "|||" & (evtEnd as «class isot» as string) & "|||" & evtLocation & "|||" & evtNotes & linefeed
    end repeat
end tell
return output
  `.trim();

  let raw: string;
  try {
    raw = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
  } catch (err) {
    console.error("AppleScript failed:", err);
    return [];
  }

  if (!raw) {
    console.log("No events found in the next", SYNC_DAYS_AHEAD, "days.");
    return [];
  }

  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [summary, startStr, endStr, location, notes] = line.split("|||");
      return {
        summary: summary?.trim() || "Untitled",
        startTime: parseAppleDate(startStr?.trim()),
        endTime: parseAppleDate(endStr?.trim()),
        location: location?.trim() || "",
        notes: notes?.trim() || "",
      };
    })
    .filter((e) => !isNaN(e.startTime.getTime()));
}

/**
 * Parse ISO 8601 date string from AppleScript's «class isot» coercion.
 * Format: "2026-03-17T09:00:00"
 */
function parseAppleDate(str: string): Date {
  if (!str) return new Date(NaN);
  // AppleScript isot gives local time without timezone — parse as local
  return new Date(str);
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
