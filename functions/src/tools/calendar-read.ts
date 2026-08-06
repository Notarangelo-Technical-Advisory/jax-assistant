import * as admin from "firebase-admin";

export interface CalendarEvent {
  summary: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  /**
   * Which calendar the event came from ("Jax", "IHRDC", "Grace Pres", ...).
   * Undefined for docs written before multi-calendar sync landed.
   */
  calendarName?: string;
  /**
   * The event's notes. For an Exchange invite this is the whole invite body,
   * which is where the Teams join link lives — see extractMeetingLink.
   */
  notes?: string;
  /**
   * All-day event. startTime is local midnight and endTime is 23:59:59, so the
   * clock times are an artefact — never format them as a time range, and never
   * treat the midnight start as an early meeting. Use formatEventWhen.
   *
   * Undefined for docs written before the EventKit reader landed.
   */
  allDay?: boolean;
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
      calendarName: data.calendarName || undefined,
      notes: data.notes || undefined,
      allDay: data.allDay || undefined,
    };
  });
}

export function formatEventTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
}

/**
 * How to say *when* an event is. Prefer this over two formatEventTime calls
 * joined by a dash: an all-day event runs local midnight to 23:59:59, so the
 * naive version renders it "12:00 AM–11:59 PM" and reads like an overnight
 * ordeal.
 */
export function formatEventWhen(e: Pick<CalendarEvent, "startTime" | "endTime" | "allDay">): string {
  if (e.allDay) return "all day";
  return `${formatEventTime(e.startTime)}–${formatEventTime(e.endTime)}`;
}

/**
 * Pull the join URL out of an invite body.
 *
 * "How do I get into my 1:45?" is one of the most common things asked of a
 * calendar, and the answer is buried in ~900 characters of invite boilerplate.
 * Returning the whole body instead would spend most of a tool result on legal
 * footers and tenant GUIDs, so extract just the link.
 *
 * Ordered most specific first: the Teams `/meet/` short link is the one a human
 * can actually use, whereas the `/l/meetup-join/` variant that also appears in
 * the same body is a deep link wrapped in URL-encoded context.
 */
export function extractMeetingLink(notes?: string): string | undefined {
  if (!notes) return undefined;
  const patterns = [
    /https:\/\/teams\.microsoft\.com\/meet\/\S+/,
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/\S+/,
    /https:\/\/\S*zoom\.us\/j\/\S+/,
    /https:\/\/meet\.google\.com\/\S+/,
    /https:\/\/\S*webex\.com\/\S*\/j\.php\?\S+/,
  ];
  for (const re of patterns) {
    const m = notes.match(re);
    // Trailing punctuation and the '>' that Outlook wraps bare URLs in are not
    // part of the URL.
    if (m) return m[0].replace(/[>).,;]+$/, "");
  }
  return undefined;
}

/** Passcode, when the invite carries one alongside the link. */
export function extractPasscode(notes?: string): string | undefined {
  return notes?.match(/Passcode:\s*(\S+)/i)?.[1];
}
