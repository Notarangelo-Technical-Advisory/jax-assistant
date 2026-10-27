// ─── Recurring tasks ───────────────────────────────────────────
//
// This file exists twice, byte for byte: functions/src/recurrence.ts for
// Maisie's tools and src/app/services/recurrence.ts for the dashboard. The two
// are separate packages, so neither can import the other.
// tests/functions/recurrence.test.mjs fails if the copies differ, so change
// both together.
//
// All dates are YYYY-MM-DD strings and all the arithmetic is done in UTC. A
// date string has no time of day, so there is no timezone to get wrong; the
// caller decides what "today" is (Eastern Time, see et-time.ts).

export type RecurrenceType = "daily" | "weekly" | "monthly";

export interface RecurrenceRule {
  type: RecurrenceType;
  /** Every N days, weeks or months. Quarterly is monthly with interval 3. Default 1. */
  interval?: number;
  /** 0–6, Sunday = 0. Weekly only; the due date's weekday when absent. */
  dayOfWeek?: number;
  /** 1–31, clamped to the month's last day. Monthly only; the due date's day when absent. */
  dayOfMonth?: number;
  /** Times left, counting the open one. Completing the last one closes the task. Absent = no end. */
  remaining?: number;
}

const DAY_MS = 86_400_000;

function toUtc(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The first matching date after `key`, then `interval - 1` more steps on. */
function stepAfter(rule: RecurrenceRule, key: string, interval: number): string {
  const d = toUtc(key);
  if (rule.type === "daily") {
    return toKey(new Date(d.getTime() + interval * DAY_MS));
  }
  if (rule.type === "weekly") {
    const target = rule.dayOfWeek ?? d.getUTCDay();
    const ahead = ((target - d.getUTCDay() + 7) % 7) || 7;
    return toKey(new Date(d.getTime() + (ahead + 7 * (interval - 1)) * DAY_MS));
  }
  // Monthly. Clamp, so the 31st means the 30th in November and the 28th in a
  // short February, and a month without that day is never skipped.
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const target = rule.dayOfMonth ?? d.getUTCDate();
  const later = Math.min(target, daysInMonth(year, month)) > d.getUTCDate() ? 0 : 1;
  const total = year * 12 + month + later + (interval - 1);
  const nextYear = Math.floor(total / 12);
  const nextMonth = total % 12;
  return toKey(new Date(Date.UTC(nextYear, nextMonth, Math.min(target, daysInMonth(nextYear, nextMonth)))));
}

function intervalOf(rule: RecurrenceRule): number {
  return Math.max(1, Math.floor(rule.interval ?? 1));
}

/**
 * The due date after completing a task due on `dueDate`, done on `today`.
 *
 * It follows the schedule, not the day of completion: a quarterly task due
 * 1 November and done on the 15th is next due 1 February. Dates already past
 * are skipped, so a task done very late, or done with no due date, always
 * lands after today.
 */
export function nextDueDate(rule: RecurrenceRule, dueDate: string | null | undefined, today: string): string {
  const interval = intervalOf(rule);
  let next = dueDate ? stepAfter(rule, dueDate, interval) : stepAfter(rule, today, 1);
  while (next <= today) next = stepAfter(rule, next, interval);
  return next;
}

/** The first date on or after `today` that the rule falls on. */
export function firstDueDate(rule: RecurrenceRule, today: string): string {
  return stepAfter(rule, toKey(new Date(toUtc(today).getTime() - DAY_MS)), 1);
}

/** Why a rule cannot be stored, or null when it is fine. */
export function recurrenceError(rule: RecurrenceRule): string | null {
  const isInt = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (!["daily", "weekly", "monthly"].includes(rule.type)) return "type must be daily, weekly or monthly.";
  if (rule.interval !== undefined && !isInt(rule.interval, 1, 365)) return "interval must be a whole number from 1 to 365.";
  if (rule.dayOfWeek !== undefined && !isInt(rule.dayOfWeek, 0, 6)) return "dayOfWeek must be 0 (Sunday) to 6 (Saturday).";
  if (rule.dayOfMonth !== undefined && !isInt(rule.dayOfMonth, 1, 31)) return "dayOfMonth must be 1 to 31.";
  if (rule.remaining !== undefined && !isInt(rule.remaining, 1, 1000)) return "remaining must be a whole number from 1 to 1000.";
  return null;
}

/** The rule with only its known fields, ready to store. */
export function cleanRecurrence(rule: RecurrenceRule): RecurrenceRule {
  const clean: RecurrenceRule = {type: rule.type};
  if (rule.interval !== undefined && rule.interval !== 1) clean.interval = rule.interval;
  if (rule.type === "weekly" && rule.dayOfWeek !== undefined) clean.dayOfWeek = rule.dayOfWeek;
  if (rule.type === "monthly" && rule.dayOfMonth !== undefined) clean.dayOfMonth = rule.dayOfMonth;
  if (rule.remaining !== undefined) clean.remaining = rule.remaining;
  return clean;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "every 3 months on the 1st, 2 left", for Maisie's task list and the dashboard. */
export function describeRecurrence(rule: RecurrenceRule): string {
  const n = intervalOf(rule);
  const unit = {daily: "day", weekly: "week", monthly: "month"}[rule.type];
  let text = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  if (rule.type === "weekly" && rule.dayOfWeek !== undefined) text += ` on ${WEEKDAYS[rule.dayOfWeek]}`;
  if (rule.type === "monthly" && rule.dayOfMonth !== undefined) text += ` on the ${ordinal(rule.dayOfMonth)}`;
  if (rule.remaining !== undefined) text += rule.remaining === 1 ? ", last time" : `, ${rule.remaining} left`;
  return text;
}
