// Eastern-time day boundaries on ordinary days: the UTC offset at a moment,
// and the start of the Eastern day that contains it and of the day after.
// It also covers the two daylight-saving change days of 2026, when an Eastern
// day is 23 or 25 hours long.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { etOffsetAt, etDayStart, etNextDayStart } = fromFunctions('./lib/et-time.js');

describe('Eastern Time offset', () => {
  it('is -05:00 in winter', () => {
    assert.equal(etOffsetAt(new Date('2026-01-15T12:00:00Z')), '-05:00');
  });

  it('is -04:00 in summer', () => {
    assert.equal(etOffsetAt(new Date('2026-07-15T12:00:00Z')), '-04:00');
  });
});

describe('Eastern Time day boundaries', () => {
  // 03:30 UTC on 15 January is 10:30 PM on 14 January in Eastern time.
  const lateEvening = new Date('2026-01-15T03:30:00Z');

  it('starts the day at midnight Eastern, which is still 14 January at 03:30 UTC', () => {
    assert.equal(etDayStart(lateEvening).toISOString(), '2026-01-14T05:00:00.000Z');
  });

  it('starts the next day at the following Eastern midnight', () => {
    assert.equal(etNextDayStart(lateEvening).toISOString(), '2026-01-15T05:00:00.000Z');
  });
});

describe('Eastern Time day boundaries on daylight-saving days', () => {
  const hour = 60 * 60 * 1000;

  it('starts 8 March 2026 (clocks go forward) at 05:00 UTC', () => {
    const noon = new Date('2026-03-08T17:00:00Z');
    assert.equal(etDayStart(noon).toISOString(), '2026-03-08T05:00:00.000Z');
  });

  it('starts the day after 8 March 2026 at 04:00 UTC', () => {
    const noon = new Date('2026-03-08T17:00:00Z');
    assert.equal(etNextDayStart(noon).toISOString(), '2026-03-09T04:00:00.000Z');
  });

  it('makes 8 March 2026 23 hours long', () => {
    const noon = new Date('2026-03-08T17:00:00Z');
    assert.equal((etNextDayStart(noon) - etDayStart(noon)) / hour, 23);
  });

  it('starts 1 November 2026 (clocks go back) at 04:00 UTC', () => {
    const noon = new Date('2026-11-01T17:00:00Z');
    assert.equal(etDayStart(noon).toISOString(), '2026-11-01T04:00:00.000Z');
  });

  it('starts the day after 1 November 2026 at 05:00 UTC', () => {
    const noon = new Date('2026-11-01T17:00:00Z');
    assert.equal(etNextDayStart(noon).toISOString(), '2026-11-02T05:00:00.000Z');
  });

  it('makes 1 November 2026 25 hours long', () => {
    const noon = new Date('2026-11-01T17:00:00Z');
    assert.equal((etNextDayStart(noon) - etDayStart(noon)) / hour, 25);
  });
});
