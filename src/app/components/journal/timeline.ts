import { JournalDay } from '../../models/journal.model';

/**
 * The journal's timeline: each day as a line from early morning to midnight in
 * Eastern Time, with a block for each work session and the breaks between
 * them. Times are minutes from the start of the day.
 *
 * Jack's rhythm: weekday mornings, until noon, are his work time. The rest of
 * a weekday, and all of a weekend, he means to keep free. Work in that free
 * time is counted in pieces, because many short pieces make a day feel like
 * work all day even when there are breaks between them.
 */

const ET_ZONE = 'America/New_York';
const DAY_MINUTES = 24 * 60;
/** The line starts at 6 AM, or earlier on dates with earlier work, and always ends at midnight. */
const DEFAULT_AXIS_START = 6 * 60;
/** A gap of more than this between work for any client is a break. Same as GAP_MINUTES in functions/src/tools/journal.ts. */
export const BREAK_MINUTES = 20;
/** Weekday work time ends at noon. Same as WORK_TIME_END in functions/src/tools/journal.ts. */
export const WORK_TIME_END = 12 * 60;
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
  weekend: boolean;
  /** Where the day's free time starts: noon on a weekday, the start of the day at the weekend. */
  freeFrom: number;
  /** Work in the free time, for any client, counting overlapping work once. */
  freeMinutes: number;
  /** The separate stretches of work in the free time. */
  freePieces: number;
  /** Work before noon on a weekday, for any client. */
  morningMinutes: number;
}

/** The chosen dates against Jack's rhythm, for any client. */
export interface RhythmTotals {
  morningMinutes: number;
  weekdays: number;
  /** Weekday work after noon. */
  afternoonMinutes: number;
  afternoonPieces: number;
  /** Weekdays with any work after noon. */
  afternoonDays: number;
  weekendDays: number;
  weekendMinutes: number;
  weekendPieces: number;
  /** Weekend days with any work. */
  weekendDaysWorked: number;
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

type Span = { start: number; end: number };

/** Blocks no more than `gap` minutes apart, joined. With a gap of 0, overlapping work counts once. */
function joined(blocks: Span[], gap: number): Span[] {
  const spans: Span[] = [];
  for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
    const last = spans[spans.length - 1];
    if (last && b.start - last.end <= gap) last.end = Math.max(last.end, b.end);
    else spans.push({ start: b.start, end: b.end });
  }
  return spans;
}

/** The stretches of work, for any client: blocks no more than BREAK_MINUTES apart, joined. */
export function stretchesIn(blocks: Span[]): Span[] {
  return joined(blocks, BREAK_MINUTES);
}

/** The minutes worked from `from` to `to`, for any client, counting overlapping work once. */
export function workedBetween(blocks: Span[], from: number, to: number): number {
  return joined(blocks, 0).reduce((n, s) => n + Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)), 0);
}

/**
 * The gaps of more than BREAK_MINUTES between one stretch of work and the
 * next, for any client. A session counts for at least its minutes from its
 * start, as it does in the hours.
 */
export function breaksIn(blocks: Span[]): TimelineBreak[] {
  const stretches = stretchesIn(blocks);
  return stretches.slice(1).map((s, i) => ({ start: stretches[i].end, end: s.start, minutes: s.start - stretches[i].end }));
}

/**
 * The work at or after `freeFrom`, and the number of pieces it came in. A
 * piece is a stretch of work: a gap of 20 minutes or less is not time off,
 * so it does not start a new piece.
 */
export function freeTimeWork(blocks: Span[], freeFrom: number): { minutes: number; pieces: number } {
  return {
    minutes: workedBetween(blocks, freeFrom, DAY_MINUTES),
    pieces: stretchesIn(blocks).filter((s) => s.end > freeFrom).length,
  };
}

/** The chosen dates against Jack's rhythm. */
export function rhythmTotals(days: TimelineDay[]): RhythmTotals {
  const totals: RhythmTotals = {
    morningMinutes: 0, weekdays: 0, afternoonMinutes: 0, afternoonPieces: 0, afternoonDays: 0,
    weekendDays: 0, weekendMinutes: 0, weekendPieces: 0, weekendDaysWorked: 0,
  };
  for (const d of days) {
    if (d.weekend) {
      totals.weekendDays++;
      totals.weekendMinutes += d.freeMinutes;
      totals.weekendPieces += d.freePieces;
      if (d.freePieces) totals.weekendDaysWorked++;
    } else {
      totals.weekdays++;
      totals.morningMinutes += d.morningMinutes;
      totals.afternoonMinutes += d.freeMinutes;
      totals.afternoonPieces += d.freePieces;
      if (d.freePieces) totals.afternoonDays++;
    }
  }
  return totals;
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
 * breaks and the free time are still those of all work, because a break is
 * time with no work at all.
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
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
    const freeFrom = weekend ? 0 : WORK_TIME_END;
    const free = freeTimeWork(blocks, freeFrom);
    return {
      day, minutes, blocks, breaks, longestBreak: Math.max(0, ...breaks.map((b) => b.minutes)),
      weekend, freeFrom, freeMinutes: free.minutes, freePieces: free.pieces,
      morningMinutes: weekend ? 0 : workedBetween(blocks, 0, WORK_TIME_END),
    };
  });
  const earliest = Math.min(DEFAULT_AXIS_START, ...days.flatMap((d) => d.blocks.map((b) => b.start)));
  return { axisStart: Math.floor(earliest / 60) * 60, axisEnd: DAY_MINUTES, days };
}
