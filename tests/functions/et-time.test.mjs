// Maisie's "what day is it" answers. Cloud Functions run in UTC, which is
// already tomorrow from 8 PM ET (7 PM in winter); every answer below must
// follow the clock in Norwell instead.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { etDateKey, etDateLabel, etDaysWindow, etDayParts, addDaysToKey } = fromFunctions('./lib/et-time.js');
const { buildStateBlock } = fromFunctions('./lib/tools/context.js');

// Saturday 10 October 2026, 9:30 PM EDT — already Sunday in UTC.
const SATURDAY_NIGHT = new Date('2026-10-11T01:30:00Z');
// Saturday 5 December 2026, 7:30 PM EST — already Sunday in UTC.
const WINTER_SATURDAY_NIGHT = new Date('2026-12-06T00:30:00Z');

const emptyContext = {
  totalUnbilled: 0, unbilledAmount: 0, lastInvoice: null, todayBriefing: null,
  alerts: [], tasks: [], recentCompletedTasks: [], sessionHistory: [],
  categories: [], calendarEvents: [], customerMap: new Map(), memories: [],
};

describe('Eastern Time day', () => {
  it('is still Saturday on a Saturday evening, though UTC has reached Sunday', () => {
    assert.equal(etDateKey(SATURDAY_NIGHT), '2026-10-10');
    assert.equal(etDateLabel(SATURDAY_NIGHT), 'Saturday, October 10, 2026');
    assert.equal(etDayParts(SATURDAY_NIGHT).dayOfWeek, 6);
  });

  it('is still Saturday on a winter Saturday evening, when ET is five hours behind', () => {
    assert.equal(etDateLabel(WINTER_SATURDAY_NIGHT), 'Saturday, December 5, 2026');
  });

  it('turns over at midnight in Norwell, not at midnight UTC', () => {
    assert.equal(etDateKey(new Date('2026-10-11T03:59:00Z')), '2026-10-10');
    assert.equal(etDateKey(new Date('2026-10-11T04:00:00Z')), '2026-10-11');
  });

  it('adds days to a date without a time zone moving it', () => {
    assert.equal(addDaysToKey('2026-10-10', -7), '2026-10-03');
    assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');
  });
});

describe('Maisie\'s calendar window', () => {
  it('reads today as midnight to midnight ET on a Saturday evening', () => {
    const { start, end } = etDaysWindow(SATURDAY_NIGHT, 1);
    assert.equal(start.toISOString(), '2026-10-10T04:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-11T04:00:00.000Z');
  });

  it('reads today and tomorrow as two whole ET days', () => {
    const { start, end } = etDaysWindow(SATURDAY_NIGHT, 2);
    assert.equal(start.toISOString(), '2026-10-10T04:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-12T04:00:00.000Z');
  });

  it('keeps whole days across the November clock change', () => {
    // Saturday 31 October 2026, 9 PM EDT; the clocks go back on Sunday 1 November.
    const { start, end } = etDaysWindow(new Date('2026-11-01T01:00:00Z'), 2);
    assert.equal(start.toISOString(), '2026-10-31T04:00:00.000Z');
    assert.equal(end.toISOString(), '2026-11-02T05:00:00.000Z');
  });
});

describe('Maisie\'s chat context', () => {
  it('tells Maisie it is Saturday on a Saturday evening', () => {
    const block = buildStateBlock(emptyContext, SATURDAY_NIGHT);
    assert.match(block, /Today is Saturday, October 10, 2026 \(2026-10-10\), Eastern Time\./);
    assert.doesNotMatch(block, /Sunday/);
  });
});
