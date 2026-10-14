// Tests for the work journal: which client each piece of work belongs to, how
// time is estimated, that a second run adds nothing, and the get_journal tool.
// The readers on Jack's Mac and the job itself are covered in
// tests/mcp/journal.test.mjs.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { all, read, reset, setUp, tool } from './helpers.mjs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = fromFunctions('firebase-admin');
const {
  clientFor, ticketInBranch, workSessions, summarizeDay, saveJournalItems, summarizeDays,
} = fromFunctions('./lib/tools/journal.js');

before(setUp);
beforeEach(reset);

const save = (items, options) => saveJournalItems(admin.firestore(), items, options);

// Tuesday 13 October 2026; Eastern Time is UTC-4.
const pr = (fields = {}) => ({
  source: 'github', sourceId: 'e1', at: '2026-10-13T13:21:00Z', action: 'Opened PR #674', subject: 'Fix saved grid layout',
  url: 'https://github.com/IHRDC/cmsonline/pull/674', repo: 'IHRDC/cmsonline', ticket: 'CNG-7039', ...fields,
});
const jira = (fields = {}) => ({
  source: 'jira', sourceId: 'CNG-7039:history:1', at: '2026-10-13T13:38:00Z', action: 'Moved CNG-7039 to Code Review',
  subject: 'Saved grid layout drops columns', site: 'ihrdcdev.atlassian.net', ticket: 'CNG-7039',
  url: 'https://ihrdcdev.atlassian.net/browse/CNG-7039', ...fields,
});
const session = (fields = {}) => ({
  source: 'claude', sourceId: 's1:2026-10-13T16:32:00.000Z', at: '2026-10-13T16:32:00Z', endAt: '2026-10-13T17:02:00Z',
  action: 'Claude Code in cmsonline', subject: 'Story agent run ends', repo: 'IHRDC/cmsonline', ...fields,
});

describe('clients', () => {
  it('puts IHRDC repos and the IHRDC Jira site under IHRDC', () => {
    assert.equal(clientFor({ repo: 'IHRDC/cmsonline' }), 'ihrdc');
    assert.equal(clientFor({ repo: 'ihrdc/ai-toolkit' }), 'ihrdc');
    assert.equal(clientFor({ site: 'ihrdcdev.atlassian.net' }), 'ihrdc');
  });

  it('gives each product and church repo its own client, and the rest of the business General', () => {
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/solomon' }), 'solomon');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/dora-tma' }), 'dial');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/Prophet-Priest-King' }), 'ppk');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/Grace-Pres' }), 'church');
    assert.equal(clientFor({ repo: 'jacknota/embassy-book-series' }), 'embassy');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/jax-assistant' }), 'general');
    assert.equal(clientFor({ repo: null }), 'general');
  });

  it('finds the Jira ticket in a branch name, but not a look-alike', () => {
    assert.equal(ticketInBranch('feature/CNG-7183'), 'CNG-7183');
    assert.equal(ticketInBranch('CNG-42-fix-grid'), 'CNG-42');
    assert.equal(ticketInBranch('fix/mcp-certificate-checks'), null);
    assert.equal(ticketInBranch('main'), null);
  });
});

describe('estimated time', () => {
  it('counts items less than 20 minutes apart as one session, from the first to the last', () => {
    const sessions = workSessions([{ at: '2026-10-13T13:21:00Z' }, { at: '2026-10-13T13:38:00Z' }, { at: '2026-10-13T13:50:00Z' }]);
    assert.deepEqual(sessions.map(s => [s.minutes, s.itemCount]), [[29, 3]]);
  });

  it('starts a new session after a gap of more than 20 minutes', () => {
    const sessions = workSessions([{ at: '2026-10-13T13:00:00Z' }, { at: '2026-10-13T13:21:00Z' }]);
    assert.deepEqual(sessions.map(s => s.minutes), [6, 6]);
  });

  it('counts a single item as 6 minutes, and a Claude Code session for its whole length', () => {
    assert.deepEqual(workSessions([{ at: '2026-10-13T13:00:00Z' }]).map(s => s.minutes), [6]);
    assert.deepEqual(workSessions([{ at: '2026-10-13T13:00:00Z', endAt: '2026-10-13T13:45:00Z' }]).map(s => s.minutes), [45]);
  });

  it('gives each client its own time, and counts overlapping work once in the day total', () => {
    const day = summarizeDay('2026-10-13', [
      { client: 'ihrdc', at: '2026-10-13T13:00:00Z', endAt: '2026-10-13T14:00:00Z' },
      { client: 'general', at: '2026-10-13T13:30:00Z', endAt: null },
      { client: 'solomon', at: '2026-10-13T18:00:00Z', endAt: null },
    ]);
    assert.deepEqual(day.clients.map(c => [c.label, c.minutes]), [['IHRDC', 60], ['General', 6], ['Solomon', 6]]);
    assert.equal(day.totalMinutes, 66);
  });
});

describe('storing items', () => {
  it('stores each item under its client and its day in Eastern Time', async () => {
    // 9:30 PM on 12 October in Boston is already 13 October in UTC.
    const s = await save([pr(), jira(), session(), pr({ sourceId: 'e2', at: '2026-10-13T01:30:00Z', repo: 'Notarangelo-Technical-Advisory/solomon' })]);

    assert.deepEqual([s.added, s.updated, s.unchanged], [4, 0, 0]);
    assert.deepEqual(s.days, ['2026-10-12', '2026-10-13']);
    const items = await all('journal');
    const late = items.find(i => i.sourceId === 'e2');
    assert.deepEqual([late.client, late.day], ['solomon', '2026-10-12']);
    const move = items.find(i => i.source === 'jira');
    assert.deepEqual([move.client, move.ticket, move.subject], ['ihrdc', 'CNG-7039', 'Saved grid layout drops columns']);
  });

  it('a second run of the same items adds nothing', async () => {
    await save([pr(), jira()]);
    const again = await save([pr(), jira()]);

    assert.deepEqual([again.added, again.updated, again.unchanged], [0, 0, 2]);
    assert.deepEqual(again.days, []);
    assert.equal((await all('journal')).length, 2);
  });

  it('updates a Claude Code session that went on longer, rather than adding it twice', async () => {
    await save([session()]);
    const later = await save([session({ endAt: '2026-10-13T17:40:00Z' })]);

    assert.deepEqual([later.added, later.updated], [0, 1]);
    const [stored] = await all('journal');
    assert.equal(stored.endAt, '2026-10-13T17:40:00.000Z');
  });

  it('a dry run writes nothing', async () => {
    const s = await save([pr(), jira()], { dryRun: true });
    assert.equal(s.added, 2);
    assert.equal((await all('journal')).length, 0);
  });

  it('keeps only web links, and skips an item with no time', async () => {
    const s = await save([pr({ url: 'javascript:alert(1)' }), jira({ at: 'not a date' })]);

    assert.deepEqual([s.added, s.skipped], [1, 1]);
    const [stored] = await all('journal');
    assert.equal(stored.url, null);
  });

  it("rebuilds each day's summary from that day's items", async () => {
    await save([pr(), jira(), session()]);
    await summarizeDays(admin.firestore(), ['2026-10-13']);

    const day = await read('journalDays/2026-10-13');
    assert.equal(day.itemCount, 3);
    assert.deepEqual(day.clients.map(c => [c.label, c.minutes, c.itemCount, c.sessions.length]), [['IHRDC', 47, 3, 2]]);
    assert.equal(day.totalMinutes, 47);
  });
});

describe('get_journal', () => {
  beforeEach(async () => {
    await save([pr(), jira(), session(), pr({ sourceId: 'e3', at: '2026-10-13T19:00:00Z', repo: 'Notarangelo-Technical-Advisory/jax-assistant', action: 'Pushed to main', subject: 'Turn certificate checks back on' })]);
    await summarizeDays(admin.firestore(), ['2026-10-13']);
  });

  it("gives a day's estimated hours per client, its work sessions, and each item in Eastern Time", async () => {
    const r = await tool('get_journal', { start_date: '2026-10-13' });

    assert.deepEqual(r.dateRange, { startDate: '2026-10-13', endDate: '2026-10-13' });
    assert.deepEqual(r.clients.map(c => [c.label, c.estimatedHours, c.itemCount]), [['IHRDC', 0.8, 3], ['General', 0.1, 1]]);
    assert.deepEqual(r.days[0].clients[0].sessions, ['9:21 AM–9:38 AM (0.3 h, 2 items)', '12:32 PM–1:02 PM (0.5 h, 1 item)']);
    assert.deepEqual(r.items.map(i => [i.time, i.client, i.action]), [
      ['9:21 AM', 'IHRDC', 'Opened PR #674'],
      ['9:38 AM', 'IHRDC', 'Moved CNG-7039 to Code Review'],
      ['12:32 PM–1:02 PM', 'IHRDC', 'Claude Code in cmsonline'],
      ['3:00 PM', 'General', 'Pushed to main'],
    ]);
    assert.match(r.note, /estimates/);
  });

  it("can show one client's work only", async () => {
    const r = await tool('get_journal', { start_date: '2026-10-13', client: 'general' });

    assert.deepEqual(r.clients.map(c => c.label), ['General']);
    assert.deepEqual(r.items.map(i => i.subject), ['Turn certificate checks back on']);
    assert.equal(r.days[0].estimatedHours, 0.1);
  });

  it('returns an empty journal for days with no work, and refuses a bad range', async () => {
    const empty = await tool('get_journal', { start_date: '2026-10-01', end_date: '2026-10-02' });
    assert.deepEqual([empty.itemCount, empty.days, empty.clients], [0, [], []]);

    assert.equal((await tool('get_journal', { start_date: '13/10/2026' })).success, false);
    assert.equal((await tool('get_journal', { start_date: '2026-10-14', end_date: '2026-10-13' })).success, false);
    assert.equal((await tool('get_journal', { start_date: '2026-08-01', end_date: '2026-10-13' })).success, false);
  });
});
