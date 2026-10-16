// Posting time to the NTA time tracker from the chat. The tracker's database
// (Firestore project fta-invoice-tracking) is emulated alongside Maisie's, so
// these tests write real documents in the shape the tracker's own form writes.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setUp, tool } from './helpers.mjs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { getFtaFirestore } = fromFunctions('./lib/fta-client.js');

const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const DAY = '2026-10-13';

let fta;

before(() => {
  setUp();
  fta = getFtaFirestore();
});

beforeEach(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/fta-invoice-tracking/databases/(default)/documents`, { method: 'DELETE' });
  await Promise.all([
    fta.doc('customers/c-ihrdc').set({ customerId: 'CUST-001', companyName: 'IHRDC', hourlyRate: 150, isActive: true }),
    fta.doc('customers/c-cox').set({ customerId: 'CUST-002', companyName: 'Cox Engineering', isActive: true }),
    fta.doc('customers/c-old').set({ customerId: 'CUST-003', companyName: 'Old Client', isActive: false }),
    fta.doc('projects/p-ai').set({ projectId: 'PROJ-001', customerId: 'c-ihrdc', projectName: 'AI Enablement', status: 'active' }),
    fta.doc('projects/p-cox1').set({ projectId: 'PROJ-002', customerId: 'c-cox', projectName: 'Website', status: 'active' }),
    fta.doc('projects/p-cox2').set({ projectId: 'PROJ-003', customerId: 'c-cox', projectName: 'Data Migration', status: 'active' }),
    fta.doc('projects/p-done').set({ projectId: 'PROJ-004', customerId: 'c-cox', projectName: 'Old Site', status: 'completed' }),
  ]);
});

const entry = (fields = {}) => ({
  date: DAY, customer: 'IHRDC', start_time: '09:00', end_time: '10:30', description: 'CNG-7039: Fixed saved grid layout', ...fields,
});

const entriesInTracker = async () =>
  (await fta.collection('timeEntries').get()).docs.map(d => ({ id: d.id, ...d.data() }));

describe('add_time_entries', () => {
  it('only previews unless told to post, and writes nothing', async () => {
    const preview = await tool('add_time_entries', { entries: [entry()] });

    assert.equal(preview.success, true);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.entries, [{
      date: DAY, start: '09:00', end: '10:30', hours: 1.5, customer: 'IHRDC', project: 'AI Enablement',
      description: 'CNG-7039: Fixed saved grid layout',
    }]);
    assert.deepEqual(await entriesInTracker(), []);
  });

  it('posts unbilled entries in the shape the time tracker writes, with the client\'s only project chosen for it', async () => {
    const posted = await tool('add_time_entries', { dry_run: false, entries: [entry(), entry({ start_time: '13:00', end_time: '14:00', description: 'Friday demo' })] });

    assert.equal(posted.posted, 2);
    assert.equal(posted.totalHours, 2.5);
    const saved = (await entriesInTracker()).find(e => e.id === posted.entries[0].entryId);
    assert.deepEqual(
      { ...saved, id: undefined, createdAt: undefined, updatedAt: undefined },
      { id: undefined, createdAt: undefined, updatedAt: undefined, date: DAY, startTime: '09:00', endTime: '10:30', customerId: 'c-ihrdc',
        projectId: 'p-ai', durationHours: 1.5, description: 'CNG-7039: Fixed saved grid layout', status: 'unbilled', source: 'maisie' },
    );
    assert.ok(saved.createdAt.toDate() instanceof Date);
  });

  it('finds the customer and project by name, code or ID, whatever the capitals', async () => {
    const preview = await tool('add_time_entries', { entries: [
      entry({ customer: 'cox engineering', project: 'data migration' }),
      entry({ customer: 'CUST-002', project: 'PROJ-002', start_time: '11:00', end_time: '11:30' }),
      entry({ customer: 'c-ihrdc', start_time: '12:00', end_time: '12:30' }),
    ] });

    assert.deepEqual(preview.entries.map(e => [e.customer, e.project]),
      [['Cox Engineering', 'Data Migration'], ['Cox Engineering', 'Website'], ['IHRDC', 'AI Enablement']]);
  });

  it('asks which project when a client has more than one, and names the active ones', async () => {
    const result = await tool('add_time_entries', { entries: [entry({ customer: 'Cox Engineering' })] });

    assert.equal(result.success, false);
    assert.match(result.error, /has 2 active projects, so name one: (Website, Data Migration|Data Migration, Website)/);
    assert.doesNotMatch(result.error, /Old Site/);
  });

  it('refuses an inactive customer or a finished project', async () => {
    const old = await tool('add_time_entries', { entries: [entry({ customer: 'Old Client' })] });
    assert.match(old.error, /no active customer "Old Client"/);

    const done = await tool('add_time_entries', { entries: [entry({ customer: 'Cox Engineering', project: 'Old Site' })] });
    assert.match(done.error, /no active project "Old Site"/);
  });

  it('refuses times off the half hour, an end before the start, a future date and an empty description', async () => {
    for (const [bad, why] of [
      [{ start_time: '09:15' }, /hour or half hour/],
      [{ end_time: '9:30' }, /hour or half hour/],
      [{ start_time: '10:00', end_time: '10:00' }, /after the start time/],
      [{ date: '2099-01-05' }, /in the future/],
      [{ date: '10/13/2026' }, /YYYY-MM-DD/],
      [{ description: '  ' }, /description is empty/],
    ]) {
      const result = await tool('add_time_entries', { dry_run: false, entries: [entry(bad)] });
      assert.equal(result.success, false, JSON.stringify(bad));
      assert.match(result.error, why);
    }
    assert.deepEqual(await entriesInTracker(), []);
  });

  it('refuses time that overlaps an entry already in the tracker, and names that entry', async () => {
    await fta.doc('timeEntries/mine').set({ date: DAY, startTime: '10:00', endTime: '11:00', customerId: 'c-cox', projectId: 'p-cox1',
      durationHours: 1, description: 'Homepage review', status: 'unbilled' });

    const result = await tool('add_time_entries', { dry_run: false, entries: [entry()] });

    assert.equal(result.success, false);
    assert.match(result.error, /overlaps the entry already in the time tracker at 10:00-11:00 \("Homepage review"\)/);
    assert.equal((await entriesInTracker()).length, 1);
  });

  it('allows an entry that starts when the last one ends', async () => {
    await fta.doc('timeEntries/mine').set({ date: DAY, startTime: '08:00', endTime: '09:00', customerId: 'c-ihrdc', projectId: 'p-ai',
      durationHours: 1, description: 'Standup', status: 'billed' });

    assert.equal((await tool('add_time_entries', { entries: [entry()] })).success, true);
  });

  it('posts nothing at all when one entry of several is wrong, so a day is never half posted', async () => {
    const result = await tool('add_time_entries', { dry_run: false, entries: [
      entry(),
      entry({ start_time: '10:00', end_time: '11:00' }),
      entry({ start_time: '14:00', end_time: '15:00', customer: 'Nobody' }),
    ] });

    assert.equal(result.success, false);
    assert.equal(result.posted, 0);
    assert.match(result.error, /overlaps 09:00-10:30 in this same request/);
    assert.match(result.error, /no active customer "Nobody"/);
    assert.deepEqual(await entriesInTracker(), []);
  });
});

describe('delete_time_entry', () => {
  it('removes an unbilled entry that Maisie posted', async () => {
    const { entries } = await tool('add_time_entries', { dry_run: false, entries: [entry()] });

    const result = await tool('delete_time_entry', { entry_id: entries[0].entryId });

    assert.equal(result.success, true);
    assert.equal(result.deleted.description, 'CNG-7039: Fixed saved grid layout');
    assert.deepEqual(await entriesInTracker(), []);
  });

  it('refuses an entry Jack made himself, or one already on an invoice', async () => {
    await fta.doc('timeEntries/jacks').set({ date: DAY, startTime: '08:00', endTime: '09:00', status: 'unbilled' });
    await fta.doc('timeEntries/billed').set({ date: DAY, startTime: '13:00', endTime: '14:00', status: 'billed', source: 'maisie' });

    assert.match((await tool('delete_time_entry', { entry_id: 'jacks' })).error, /did not post this entry/);
    assert.match((await tool('delete_time_entry', { entry_id: 'billed' })).error, /already billed/);
    assert.equal((await entriesInTracker()).length, 2);
  });
});

describe('get_time_entries', () => {
  it('shows each entry\'s ID, times and whether Maisie posted it, so she can check a day and undo her own', async () => {
    const { entries } = await tool('add_time_entries', { dry_run: false, entries: [entry()] });

    const result = await tool('get_time_entries', { start_date: DAY, end_date: DAY });

    const listed = result.customers['c-ihrdc'].projects['p-ai'].entries[0];
    assert.deepEqual({ ...listed }, { entryId: entries[0].entryId, date: DAY, start: '09:00', end: '10:30', hours: 1.5,
      description: 'CNG-7039: Fixed saved grid layout', status: 'unbilled', postedByMaisie: true });
  });
});
