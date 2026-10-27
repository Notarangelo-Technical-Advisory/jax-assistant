// The repeat day in the task forms ("on day" for monthly, the weekday for
// weekly) and the due date can disagree, and then completing the task follows
// the repeat day: a monthly task on the 1st, moved to 27 October, came back
// due 1 November. So the repeat day follows the due date while it is the due
// date's own day. A day Jack set apart from the due date stays as he set it.

/** The day `date` (YYYY-MM-DD) gives a rule of `type`: its day of the month, or its weekday (Sunday = 0). */
export function dueDateDay(type: string, date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (type === 'monthly') return d.getUTCDate();
  if (type === 'weekly') return d.getUTCDay();
  return null;
}

/**
 * The repeat day once the due date changes from `before` to `after`: the new
 * due date's day when the repeat day was blank or was the old due date's day,
 * otherwise the repeat day unchanged.
 */
export function followDueDate(
  type: string,
  day: number | string | null,
  before: string,
  after: string,
): number | string | null {
  const next = dueDateDay(type, after);
  if (next === null) return day;
  if (day === null || day === '') return next;
  return Number(day) === dueDateDay(type, before) ? next : day;
}
