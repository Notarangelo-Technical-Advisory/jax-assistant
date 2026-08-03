import * as admin from "firebase-admin";

export interface CalendarEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  location?: string;
}

/**
 * Read calendar events from the Firestore mirror populated by
 * bridge/calendar-sync.ts. Takes `db` explicitly so both the Cloud Functions
 * runtime and the local MCP server can call it.
 */
export async function readCalendarEvents(
  db: admin.firestore.Firestore,
  startOfDay: Date,
  endOfDay: Date
): Promise<CalendarEvent[]> {
  const snap = await db.collection("calendarEvents")
    .where("startTime", ">=", admin.firestore.Timestamp.fromDate(startOfDay))
    .where("startTime", "<", admin.firestore.Timestamp.fromDate(endOfDay))
    .orderBy("startTime", "asc")
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      summary: data.summary,
      startTime: data.startTime.toDate(),
      endTime: data.endTime.toDate(),
      location: data.location || undefined,
    };
  });
}

export function formatEventTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
}
