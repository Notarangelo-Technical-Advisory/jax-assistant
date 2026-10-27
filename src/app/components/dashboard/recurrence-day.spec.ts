import { dueDateDay, followDueDate } from './recurrence-day';

// The repeat day in the task forms follows the due date while it is the due
// date's own day, so a moved task is next due where Jack expects.

describe('followDueDate', () => {
  it('moves a monthly task on the 1st to the 27th when its due date moves from 1 November to 27 October', () => {
    expect(followDueDate('monthly', 1, '2026-11-01', '2026-10-27')).toBe(27);
  });

  it('moves a weekly task with its due date, from Sunday to Tuesday', () => {
    expect(followDueDate('weekly', 0, '2026-11-01', '2026-10-27')).toBe(2);
  });

  it('keeps a repeat day Jack set apart from the due date', () => {
    expect(followDueDate('monthly', 15, '2026-11-01', '2026-10-27')).toBe(15);
    expect(followDueDate('weekly', 5, '2026-11-01', '2026-10-27')).toBe(5);
  });

  it('fills a blank repeat day from the due date', () => {
    expect(followDueDate('monthly', null, '', '2026-10-27')).toBe(27);
    expect(followDueDate('weekly', '', '', '2026-10-27')).toBe(2);
  });

  it('reads the day the form hands back as text', () => {
    expect(followDueDate('monthly', '1', '2026-11-01', '2026-10-27')).toBe(27);
  });

  it('leaves the day alone when the due date is cleared, or the task does not repeat by day', () => {
    expect(followDueDate('monthly', 1, '2026-11-01', '')).toBe(1);
    expect(followDueDate('daily', null, '2026-11-01', '2026-10-27')).toBeNull();
    expect(followDueDate('', 3, '2026-11-01', '2026-10-27')).toBe(3);
  });
});

describe('dueDateDay', () => {
  it('gives the day of the month for monthly and the weekday for weekly, the same in every time zone', () => {
    expect(dueDateDay('monthly', '2026-10-31')).toBe(31);
    expect(dueDateDay('weekly', '2026-10-31')).toBe(6);
    expect(dueDateDay('monthly', 'not a date')).toBeNull();
  });
});
