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
  clientFor, ticketInBranch, workSessions, summarizeDay, saveJournalItems, summarizeDays, meetingClient, meetingItems,
  recordingItems, reclassifyJournal,
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

  it('gives each product and church repo, and Maisie\'s own repo, its own client, and the rest of the business General', () => {
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/solomon' }), 'solomon');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/dora-tma' }), 'dial');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/Prophet-Priest-King' }), 'ppk');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/Grace-Pres' }), 'church');
    assert.equal(clientFor({ repo: 'jacknota/embassy-book-series' }), 'embassy');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/jax-assistant' }), 'executive_assistant');
    assert.equal(clientFor({ repo: 'Notarangelo-Technical-Advisory/nta-time-tracker' }), 'general');
    assert.equal(clientFor({ repo: null }), 'general');
  });

  it('puts work outside any repo under IHRDC when it names an IHRDC Jira key, Jira, Aishwarya or the QA test agent', async () => {
    const outside = (sourceId, subject) => session({ sourceId, subject, repo: null });
    await save([
      outside('a', 'CNG-7189 QA testing agent'),
      outside('b', 'QA test agent plan'),
      outside('c', "QA testing agent for Aishwarya's manual testing"),
      outside('d', 'Shared Jira token for agents'),
      outside('e', 'Cng-6947 and cng-6948 service account'),
      outside('f', 'UTF-8 cleanup in the budget sheet'),
      outside('g', 'Plan the week'),
      session({ sourceId: 'h', subject: 'Jira token for the work journal', repo: 'Notarangelo-Technical-Advisory/jax-assistant' }),
    ]);

    const clients = Object.fromEntries((await all('journal')).map(i => [i.sourceId, i.client]));
    assert.deepEqual(clients, {
      a: 'ihrdc', b: 'ihrdc', c: 'ihrdc', d: 'ihrdc', e: 'ihrdc', f: 'general', g: 'general', h: 'executive_assistant',
    });
  });

  it('finds the Jira ticket in a branch name, but not a look-alike', () => {
    assert.equal(ticketInBranch('feature/CNG-7183'), 'CNG-7183');
    assert.equal(ticketInBranch('CNG-42-fix-grid'), 'CNG-42');
    assert.equal(ticketInBranch('fix/mcp-certificate-checks'), null);
    assert.equal(ticketInBranch('main'), null);
  });
});

// A meeting as the calendar reader on the Mac returns it: 10:30–11:30 AM on 13 October.
const meeting = (fields = {}) => ({
  uid: 'uid-product-review', title: 'Product Review Meeting', start: '2026-10-13T14:30:00.000Z', end: '2026-10-13T15:30:00.000Z',
  allDay: false, free: false, declined: false, calendar: 'IHRDC', people: ['brad@ihrdc.com', 'gabor@ihrdc.com'], ...fields,
});
const AFTER = new Date('2026-10-14T12:00:00Z');

describe('meetings', () => {
  it('puts meetings on the IHRDC calendar, and meetings with IHRDC people anywhere, under IHRDC', () => {
    assert.equal(meetingClient(meeting()), 'ihrdc');
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Lunch', people: ['Brad@IHRDC.com'] })), 'ihrdc');
  });

  it('leaves out an event on the IHRDC calendar with nobody else invited, such as a doctor\'s appointment', () => {
    assert.equal(meetingClient(meeting({ title: 'Norma Dr Appt', people: [] })), null);
  });

  it('puts Cox meetings under Cox Engineering, by a coxeng.com invitee or by the word Cox in the title', () => {
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Jack Notarangelo Introduction - Development Advisor',
      people: ['someone@c-port.com', 'joe@CoxEng.com'] })), 'cox');
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Cox discovery', people: [] })), 'cox');
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Send Cox Roadmap', people: [] })), 'cox');
  });

  it('puts the church meetings Jack chose under Church', () => {
    for (const title of ['Officer Meeting', 'Grace Prayer Meeting', 'Community Group', 'Praying Avidly', 'Worship Almighty God']) {
      assert.equal(meetingClient(meeting({ calendar: 'Jax', title, people: [] })), 'church', title);
    }
  });

  it('leaves out personal events on the Jax calendar, even with people invited, and matches whole words only', () => {
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Edge the driveway', people: [] })), null);
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Furnace: Scott Gallagher', people: ['scott@example.com'] })), null);
    assert.equal(meetingClient(meeting({ calendar: 'Jax', title: 'Coxswain practice', people: [] })), null);
  });

  it('journals each ended meeting for its scheduled length, with how many others were invited', () => {
    const { items } = meetingItems([meeting()], AFTER);

    assert.deepEqual(items, [{
      source: 'meeting', sourceId: 'uid-product-review:2026-10-13T14:30:00.000Z',
      at: '2026-10-13T14:30:00.000Z', endAt: '2026-10-13T15:30:00.000Z',
      action: 'Meeting with 2 others', subject: 'Product Review Meeting', detail: 'IHRDC calendar', client: 'ihrdc',
    }]);
    const solo = meetingItems([meeting({ calendar: 'Jax', title: 'Cox discovery', people: [] })], AFTER).items[0];
    assert.equal(solo.action, 'Meeting');
  });

  it('leaves out all-day events, events marked Free, meetings Jack declined, meetings not over yet and meetings with no client', () => {
    const r = meetingItems([
      meeting({ uid: 'all-day', allDay: true }),
      meeting({ uid: 'reminder', title: 'Request demo for Friday', free: true, people: [] }),
      meeting({ uid: 'declined', declined: true }),
      meeting({ uid: 'running', end: '2026-10-14T12:30:00.000Z' }),
      meeting({ uid: 'personal', calendar: 'Jax', title: 'Start the chicken cook', people: [] }),
      meeting(),
    ], AFTER);

    assert.deepEqual(r.items.map(i => i.sourceId.split(':')[0]), ['uid-product-review']);
    assert.deepEqual([r.read, r.allDay, r.free, r.declined, r.notEnded, r.noClient], [6, 1, 1, 1, 1, 1]);
  });

  it('journals each occurrence of a repeating meeting as its own item', async () => {
    const { items } = meetingItems([
      meeting(),
      meeting({ start: '2026-10-06T14:30:00.000Z', end: '2026-10-06T15:30:00.000Z' }),
    ], AFTER);
    const s = await save(items);

    assert.equal(s.added, 2);
    assert.deepEqual(s.days, ['2026-10-06', '2026-10-13']);
  });

  it("counts a meeting for its whole length in the day's time, and once where it overlaps other work", async () => {
    // A pull request opened during the meeting adds no time.
    await save([...meetingItems([meeting()], AFTER).items, pr({ at: '2026-10-13T14:45:00Z' })]);
    await summarizeDays(admin.firestore(), ['2026-10-13']);

    const day = await read('journalDays/2026-10-13');
    assert.deepEqual(day.clients.map(c => [c.label, c.minutes, c.itemCount]), [['IHRDC', 60, 2]]);
    const stored = (await all('journal')).find(i => i.source === 'meeting');
    assert.deepEqual([stored.client, stored.day, stored.url, stored.repo], ['ihrdc', '2026-10-13', null, null]);
  });
});

// A Wispr Flow recording, 11:05–11:23 AM on 13 October, during the Product Review meeting.
const recording = (fields = {}) => ({
  id: 'rec-1', title: 'Phase Two Improvements Plan', start: '2026-10-13T15:05:00.000Z', end: '2026-10-13T15:23:00.000Z',
  url: 'https://notes.wisprflow.ai/shared/abc', ...fields,
});

describe('recordings', () => {
  it('gives a recording the client of the calendar meeting it overlaps, and links its notes', () => {
    const { items } = recordingItems([recording()], [meeting()], AFTER);

    assert.deepEqual(items, [{
      source: 'recording', sourceId: 'rec-1', at: '2026-10-13T15:05:00.000Z', endAt: '2026-10-13T15:23:00.000Z',
      action: 'Recorded meeting', subject: 'Phase Two Improvements Plan', detail: 'During Product Review Meeting',
      url: 'https://notes.wisprflow.ai/shared/abc', ticket: null, client: 'ihrdc',
    }]);
  });

  it('chooses the meeting it overlaps most', () => {
    const officers = meeting({ uid: 'officers', calendar: 'Jax', title: 'Officer Meeting', people: [],
      start: '2026-10-13T15:00:00.000Z', end: '2026-10-13T15:10:00.000Z' });
    const sync = meeting({ uid: 'sync', title: 'Claude Code - Weekly Sync', start: '2026-10-13T15:10:00.000Z', end: '2026-10-13T16:00:00.000Z' });
    const longer = recording({ start: '2026-10-13T15:05:00.000Z', end: '2026-10-13T15:30:00.000Z' });
    const shorter = recording({ start: '2026-10-13T14:55:00.000Z', end: '2026-10-13T15:12:00.000Z' });

    // In either order: 20 minutes of the Sync beats 5 of Officer Meeting, and 10 of Officer Meeting beats 2 of the Sync.
    for (const meetings of [[sync, officers], [officers, sync]]) {
      assert.deepEqual(recordingItems([longer], meetings, AFTER).items.map(i => i.detail), ['During Claude Code - Weekly Sync']);
      assert.deepEqual(recordingItems([shorter], meetings, AFTER).items.map(i => i.detail), ['During Officer Meeting']);
    }
  });

  it('does not take a client from a meeting the journal leaves out, such as a personal block or a reminder', () => {
    const r = recordingItems([recording()], [
      meeting({ title: 'Norma Dr Appt', people: [] }),
      meeting({ title: 'Request demo for Friday', free: true }),
      meeting({ title: 'Bug tickets - Product management', declined: true }),
    ], AFTER);

    assert.deepEqual([r.items.length, r.noClient], [0, 1]);
  });

  it('uses a word or an IHRDC Jira key in the title when it overlaps no meeting', () => {
    const r = recordingItems([
      recording({ id: 'cox', title: 'Cox Engineering: Discovery Roadmap Review' }),
      recording({ id: 'cng', title: 'Approving CNG-6882 Map' }),
      recording({ id: 'look-alike', title: 'UTF-8 encoding check' }),
      recording({ id: 'no-key', title: 'Subtask Placement for Ticket 6834' }),
    ], [], AFTER);

    assert.deepEqual(r.items.map(i => [i.sourceId, i.client, i.detail, i.ticket]), [
      ['cox', 'cox', 'Cox in the title', null],
      ['cng', 'ihrdc', 'CNG-6882 in the title', 'CNG-6882'],
    ]);
    assert.equal(r.noClient, 2);
  });

  it('leaves out a recording that is still going on', () => {
    const r = recordingItems([
      recording({ id: 'live', end: null }),
      recording({ id: 'later', end: '2026-10-14T12:30:00.000Z' }),
    ], [meeting()], AFTER);

    assert.deepEqual([r.read, r.items.length, r.notEnded], [2, 0, 2]);
  });

  it('adds the time recorded beyond the scheduled meeting, and counts the overlap once', async () => {
    // Product Review is 10:30–11:30 AM; the recording runs on to 11:45 AM.
    const late = recording({ end: '2026-10-13T15:45:00.000Z' });
    await save([...meetingItems([meeting()], AFTER).items, ...recordingItems([late], [meeting()], AFTER).items]);
    await summarizeDays(admin.firestore(), ['2026-10-13']);

    const day = await read('journalDays/2026-10-13');
    assert.deepEqual(day.clients.map(c => [c.label, c.minutes, c.itemCount]), [['IHRDC', 75, 2]]);
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
    await save([pr(), jira(), session(), pr({ sourceId: 'e3', at: '2026-10-13T19:00:00Z', repo: 'Notarangelo-Technical-Advisory/engineering-standards', action: 'Pushed to main', subject: 'Turn certificate checks back on', ticket: null })]);
    await summarizeDays(admin.firestore(), ['2026-10-13']);
  });

  it('shows a meeting with its start and end in Eastern Time', async () => {
    await save(meetingItems([meeting({ start: '2026-10-13T20:00:00.000Z', end: '2026-10-13T20:30:00.000Z' })], AFTER).items);
    await summarizeDays(admin.firestore(), ['2026-10-13']);
    const r = await tool('get_journal', { start_date: '2026-10-13' });

    const shown = r.items.find(i => i.source === 'meeting');
    assert.deepEqual([shown.time, shown.client, shown.action, shown.subject, shown.detail],
      ['4:00 PM–4:30 PM', 'IHRDC', 'Meeting with 2 others', 'Product Review Meeting', 'IHRDC calendar']);
    assert.match(r.note, /calendars/);
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

  it('names a client Jack added as a task category, such as Executive Assistant', async () => {
    await admin.firestore().collection('taskCategories').add({ key: 'executive_assistant', label: 'Executive Assistant', order: 101 });
    await save([pr({ sourceId: 'e9', at: '2026-10-13T20:00:00Z', repo: 'Notarangelo-Technical-Advisory/jax-assistant' })]);
    await summarizeDays(admin.firestore(), ['2026-10-13']);
    const r = await tool('get_journal', { start_date: '2026-10-13', client: 'executive_assistant' });

    assert.deepEqual(r.clients.map(c => [c.client, c.label]), [['executive_assistant', 'Executive Assistant']]);
    assert.deepEqual(r.items.map(i => i.client), ['Executive Assistant']);
  });

  it('returns an empty journal for days with no work, and refuses a bad range', async () => {
    const empty = await tool('get_journal', { start_date: '2026-10-01', end_date: '2026-10-02' });
    assert.deepEqual([empty.itemCount, empty.days, empty.clients], [0, [], []]);

    assert.equal((await tool('get_journal', { start_date: '13/10/2026' })).success, false);
    assert.equal((await tool('get_journal', { start_date: '2026-10-14', end_date: '2026-10-13' })).success, false);
    assert.equal((await tool('get_journal', { start_date: '2026-08-01', end_date: '2026-10-13' })).success, false);
  });
});

describe('moving stored items after a rule change', () => {
  // A push to Maisie's repo, stored as General before the repo had its own client.
  const push = pr({ sourceId: 'e9', repo: 'Notarangelo-Technical-Advisory/jax-assistant', action: 'Pushed to main', subject: 'Keep a work journal' });

  beforeEach(async () => {
    const db = admin.firestore();
    await db.collection('taskCategories').add({ key: 'executive_assistant', label: 'Executive Assistant', order: 101 });
    await save([push, jira(), ...meetingItems([meeting()], AFTER).items]);
    for (const doc of (await db.collection('journal').where('source', '==', 'github').get()).docs) {
      await doc.ref.update({ client: 'general' });
    }
    await summarizeDays(db, ['2026-10-13']);
  });

  it('a dry run says what would move, and writes nothing', async () => {
    const s = await reclassifyJournal(admin.firestore(), { dryRun: true });

    assert.deepEqual([s.checked, s.changed, s.changes, s.days], [1, 1, [{ from: 'general', to: 'executive_assistant', count: 1 }], ['2026-10-13']]);
    assert.equal((await all('journal')).find(i => i.source === 'github').client, 'general');
  });

  it('moves work outside any repo that names IHRDC to IHRDC', async () => {
    await save([session({ sourceId: 's9', repo: null, subject: 'QA test agent plan' })]);
    const [stored] = (await admin.firestore().collection('journal').where('source', '==', 'claude').get()).docs;
    await stored.ref.update({ client: 'general' });

    const s = await reclassifyJournal(admin.firestore());

    assert.deepEqual(s.changes.sort((x, y) => x.to.localeCompare(y.to)), [
      { from: 'general', to: 'executive_assistant', count: 1 },
      { from: 'general', to: 'ihrdc', count: 1 },
    ]);
    assert.equal((await stored.ref.get()).get('client'), 'ihrdc');
  });

  it("moves Maisie's repo to Executive Assistant, rebuilds the day with its name, and leaves Jira and meetings alone", async () => {
    await reclassifyJournal(admin.firestore());

    const items = (await all('journal')).map(i => [i.source, i.client]).sort();
    assert.deepEqual(items, [['github', 'executive_assistant'], ['jira', 'ihrdc'], ['meeting', 'ihrdc']]);
    const day = await read('journalDays/2026-10-13');
    assert.deepEqual(day.clients.map(c => c.label).sort(), ['Executive Assistant', 'IHRDC']);
    assert.equal((await reclassifyJournal(admin.firestore())).changed, 0, 'a second run moves nothing');
  });
});
