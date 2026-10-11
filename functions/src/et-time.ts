// ─── Eastern Time day math ─────────────────────────────────────
//
// The Cloud Functions runtime sets no TZ, so it is UTC. Every "what day is it"
// question Maisie answers is really "what day is it in Norwell", and the two
// disagree from 8 PM ET onward (7 PM in winter): getDate/getDay/setHours and
// toISOString all roll into tomorrow four hours early. That is what stamped the
// 8 PM refresh with the next day's date, called a task due today overdue, told
// Jack on a Saturday evening that it was Sunday, and pointed "today's" calendar
// window at [8 PM yesterday → 8 PM today].
//
// Everything here derives the day from the ET wall clock instead. Use these
// over the Date accessors anywhere a calendar day or a due date is at stake.
export const ET_ZONE = "America/New_York";

/** YYYY-MM-DD as it reads on a clock in Norwell. */
export function etDateKey(d: Date): string {
  return d.toLocaleDateString("en-CA", {timeZone: ET_ZONE});
}

/** "Saturday, October 10, 2026" as it reads in Norwell. */
export function etDateLabel(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: ET_ZONE, weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

/** ET's UTC offset at a given instant, as "-04:00" / "-05:00". */
export function etOffsetAt(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE, timeZoneName: "longOffset",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value
    ?.replace("GMT", "") || "+00:00";
}

/**
 * The instant ET midnight begins on `d`'s ET date.
 *
 * Read off the zone's own offset rather than assuming -05:00 or -04:00 — and
 * read twice, because on a DST-change day the offset at `d` is not the offset
 * that was in force at midnight. Resolving once from a 10 PM instant on
 * spring-forward Sunday lands on 11 PM the previous day; the second pass, using
 * the first guess, corrects it.
 */
export function etDayStart(d: Date): Date {
  const key = etDateKey(d);
  const guess = new Date(`${key}T00:00:00${etOffsetAt(d)}`);
  return new Date(`${key}T00:00:00${etOffsetAt(guess)}`);
}

/**
 * The instant the *next* ET day begins.
 *
 * Snapping forward from midnight + 26h rather than adding 24h: a spring-forward
 * ET day is 23 hours long and a fall-back day is 25, and 26 lands inside the
 * following day either way.
 */
export function etNextDayStart(d: Date): Date {
  return etDayStart(new Date(etDayStart(d).getTime() + 26 * 60 * 60 * 1000));
}

/**
 * ET midnight today through ET midnight `days` days later. `days` counts
 * today, so 1 is today only and 2 is today and tomorrow.
 */
export function etDaysWindow(d: Date, days: number): {start: Date; end: Date} {
  const start = etDayStart(d);
  let end = start;
  for (let i = 0; i < Math.max(1, days); i++) end = etNextDayStart(end);
  return {start, end};
}

/** Day of week (0 = Sunday) and day of month, on the ET calendar. */
export function etDayParts(d: Date): {dayOfWeek: number; dayOfMonth: number} {
  const key = etDateKey(d);
  // Noon UTC on the ET date — far enough from either midnight that no offset
  // can shift which date this lands on.
  const noon = new Date(`${key}T12:00:00Z`);
  return {dayOfWeek: noon.getUTCDay(), dayOfMonth: Number(key.slice(8, 10))};
}

/** YYYY-MM-DD plus n days, done in UTC so no time zone can shift the date. */
export function addDaysToKey(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
