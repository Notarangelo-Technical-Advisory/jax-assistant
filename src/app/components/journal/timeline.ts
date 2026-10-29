import { JournalDay } from '../../models/journal.model';

/**
 * The journal's timeline: each day as a line from early morning to midnight in
 * Eastern Time, with a block for each work session and the breaks between
 * them. Times are minutes from the start of the day.
 */

const ET_ZONE = 'America/New_York';
const DAY_MINUTES = 24 * 60;
/** The line starts at 6 AM, or earlier on dates with earlier work, and always ends at midnight. */
const DEFAULT_AXIS_START = 6 * 60;
/** A gap of more than this between work for any client is a break. Same as GAP_MINUTES in functions/src/tools/journal.ts. */
export const BREAK_MINUTES = 20;
/** The longest range the timeline shows: one line a day. */
export const MAX_TIMELINE_DAYS = 62;
/** The number of colours in journal.component.scss; client colours repeat after that. */
export const CLIENT_COLOURS = 10;

export interface TimelineBlock {
  client: string;
  label: string;
  start: number;
  end: number;
  /** False when another client is chosen in the filter: the block shows in grey, so it is not taken for a break. */
  chosen: boolean;
}

export interface TimelineBreak {
  start: number;
  end: number;
  minutes: number;
}

export interface TimelineDay {
  day: string;
  /** The day's hours: every client's, or the chosen client's. */
  minutes: number;
  blocks: TimelineBlock[];
  breaks: TimelineBreak[];
  /** The longest break's minutes, whenever it fell; 0 when there was none. */
  longestBreak: number;
}

export interface Timeline {
  axisStart: number;
  axisEnd: number;
  /** Oldest first, every day of the range, with or without work. */
  days: TimelineDay[];
}

const ET_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Minutes from the start of `day` in Eastern Time: 0 for a time on the day before, 1440 for one on the day after. */
export function minuteOfDay(iso: string, day: string): number {
  const parts = Object.fromEntries(ET_PARTS.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
  if (date < day) return 0;
  if (date > day) return DAY_MINUTES;
  return Number(parts['hour']) * 60 + Number(parts['minute']);
}

/** "9:21 AM" from minutes since midnight; 1440 is "12:00 AM", midnight at the end of the day. */
export function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = String(minutes % 60).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The gaps of more than BREAK_MINUTES between one stretch of work and the
 * next, for any client. A session counts for at least its minutes from its
 * start, as it does in the hours.
 */
export function breaksIn(blocks: Array<{ start: number; end: number }>): TimelineBreak[] {
  const breaks: TimelineBreak[] = [];
  let workedTo: number | null = null;
  for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
    if (workedTo !== null && b.start - workedTo > BREAK_MINUTES) {
      breaks.push({ start: workedTo, end: b.start, minutes: b.start - workedTo });
    }
    workedTo = Math.max(workedTo ?? b.end, b.end);
  }
  return breaks;
}

/** Every day from `start` to `end`, oldest first. */
function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = new Date(`${start}T12:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The timeline of the days from `start` to `end`. With a client chosen, the
 * breaks are still those of all work, because a break is time with no work at all.
 */
export function buildTimeline(start: string, end: string, summaries: JournalDay[], client: string | null): Timeline {
  const byDay = new Map(summaries.map((d) => [d.day, d]));
  const days = daysBetween(start, end).map((day): TimelineDay => {
    const summary = byDay.get(day);
    const blocks = (summary?.clients ?? []).flatMap((c) => c.sessions.map((s) => {
      const from = minuteOfDay(s.start, day);
      return {
        client: c.client,
        label: c.label,
        start: from,
        end: Math.min(DAY_MINUTES, Math.max(minuteOfDay(s.end, day), from + s.minutes)),
        chosen: !client || c.client === client,
      };
    })).sort((a, b) => a.start - b.start);
    const minutes = client
      ? summary?.clients.find((c) => c.client === client)?.minutes ?? 0
      : summary?.totalMinutes ?? 0;
    const breaks = breaksIn(blocks);
    return { day, minutes, blocks, breaks, longestBreak: Math.max(0, ...breaks.map((b) => b.minutes)) };
  });
  const earliest = Math.min(DEFAULT_AXIS_START, ...days.flatMap((d) => d.blocks.map((b) => b.start)));
  return { axisStart: Math.floor(earliest / 60) * 60, axisEnd: DAY_MINUTES, days };
}
