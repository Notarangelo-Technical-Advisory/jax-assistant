// The date rule for repeating tasks: when a task comes due again after Jack
// completes it. Maisie's tools and the dashboard each keep a copy of the rule,
// and both must give the same answer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { nextDueDate, firstDueDate, describeRecurrence, recurrenceError, cleanRecurrence } = fromFunctions('./lib/recurrence.js');

describe('the two copies of the rule', () => {
  it('are identical, so the dashboard and Maisie agree on every next due date', () => {
    const functionsCopy = readFileSync(new URL('../../functions/src/recurrence.ts', import.meta.url), 'utf8');
    const appCopy = readFileSync(new URL('../../src/app/services/recurrence.ts', import.meta.url), 'utf8');
    assert.equal(appCopy, functionsCopy, 'functions/src/recurrence.ts and src/app/services/recurrence.ts have drifted apart');
  });
});

describe('nextDueDate', () => {
  const quarterly = { type: 'monthly', interval: 3, dayOfMonth: 1 };

  it('moves a quarterly task due 1 November to 1 February, done on the day', () => {
    assert.equal(nextDueDate(quarterly, '2026-11-01', '2026-11-01'), '2027-02-01');
  });

  it('keeps a quarterly task on its schedule when it is done two weeks late', () => {
    assert.equal(nextDueDate(quarterly, '2026-11-01', '2026-11-15'), '2027-02-01');
  });

  it('skips the dates already past when a task is done very late', () => {
    assert.equal(nextDueDate(quarterly, '2026-11-01', '2027-03-15'), '2027-05-01');
  });

  it('moves a task done early to the next date after its due date, not back to the same one', () => {
    assert.equal(nextDueDate({ type: 'monthly', dayOfMonth: 1 }, '2026-11-01', '2026-10-27'), '2026-12-01');
    assert.equal(nextDueDate({ type: 'weekly', dayOfWeek: 5 }, '2026-10-30', '2026-10-26'), '2026-11-06');
  });

  it('does not skip February for a task set for the 31st', () => {
    const rule = { type: 'monthly', dayOfMonth: 31 };
    assert.equal(nextDueDate(rule, '2027-01-31', '2027-01-31'), '2027-02-28');
    assert.equal(nextDueDate(rule, '2027-02-28', '2027-02-28'), '2027-03-31');
    assert.equal(nextDueDate(rule, '2028-01-31', '2028-01-31'), '2028-02-29');
  });

  it('crosses a year end', () => {
    assert.equal(nextDueDate(quarterly, '2026-12-01', '2026-12-01'), '2027-03-01');
    assert.equal(nextDueDate({ type: 'daily' }, '2026-12-31', '2026-12-31'), '2027-01-01');
  });

  it('uses the due date\'s own day when the rule names none', () => {
    assert.equal(nextDueDate({ type: 'monthly' }, '2026-11-15', '2026-11-15'), '2026-12-15');
    assert.equal(nextDueDate({ type: 'weekly' }, '2026-10-27', '2026-10-27'), '2026-11-03');
  });

  it('repeats every other week', () => {
    assert.equal(nextDueDate({ type: 'weekly', interval: 2, dayOfWeek: 2 }, '2026-10-27', '2026-10-27'), '2026-11-10');
  });

  it('goes to the first matching day after today when the task has no due date', () => {
    assert.equal(nextDueDate({ type: 'monthly', interval: 3, dayOfMonth: 1 }, null, '2026-10-27'), '2026-11-01');
    assert.equal(nextDueDate({ type: 'daily' }, undefined, '2026-10-27'), '2026-10-28');
  });
});

describe('firstDueDate', () => {
  it('is today when the rule falls on today, otherwise the next day it falls on', () => {
    assert.equal(firstDueDate({ type: 'monthly', dayOfMonth: 1 }, '2026-11-01'), '2026-11-01');
    assert.equal(firstDueDate({ type: 'monthly', dayOfMonth: 1 }, '2026-10-27'), '2026-11-01');
    assert.equal(firstDueDate({ type: 'weekly', dayOfWeek: 2 }, '2026-10-27'), '2026-10-27');
    assert.equal(firstDueDate({ type: 'daily' }, '2026-10-27'), '2026-10-27');
  });
});

describe('describeRecurrence', () => {
  it('says how often, on which day, and how many times are left', () => {
    assert.equal(describeRecurrence({ type: 'monthly', interval: 3, dayOfMonth: 1 }), 'every 3 months on the 1st');
    assert.equal(describeRecurrence({ type: 'monthly', dayOfMonth: 1, remaining: 3 }), 'every month on the 1st, 3 left');
    assert.equal(describeRecurrence({ type: 'monthly', dayOfMonth: 22, remaining: 1 }), 'every month on the 22nd, last time');
    assert.equal(describeRecurrence({ type: 'monthly', dayOfMonth: 11 }), 'every month on the 11th');
    assert.equal(describeRecurrence({ type: 'weekly', dayOfWeek: 5 }), 'every week on Friday');
    assert.equal(describeRecurrence({ type: 'daily' }), 'every day');
  });
});

describe('recurrenceError and cleanRecurrence', () => {
  it('refuses a rule that cannot be stored', () => {
    assert.match(recurrenceError({ type: 'yearly' }), /type/);
    assert.match(recurrenceError({ type: 'monthly', interval: 0 }), /interval/);
    assert.match(recurrenceError({ type: 'monthly', dayOfMonth: 32 }), /dayOfMonth/);
    assert.match(recurrenceError({ type: 'weekly', dayOfWeek: 7 }), /dayOfWeek/);
    assert.match(recurrenceError({ type: 'monthly', remaining: 1.5 }), /remaining/);
    assert.equal(recurrenceError({ type: 'monthly', interval: 3, dayOfMonth: 1, remaining: 4 }), null);
  });

  it('keeps only the fields that belong to the rule\'s type', () => {
    assert.deepEqual(
      cleanRecurrence({ type: 'monthly', interval: 1, dayOfMonth: 1, dayOfWeek: 3, remaining: 3, note: 'x' }),
      { type: 'monthly', dayOfMonth: 1, remaining: 3 },
    );
  });
});
