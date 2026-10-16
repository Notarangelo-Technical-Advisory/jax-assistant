// The journal page's "Post time" panel, through the same entry point the
// timeEntries HTTP function uses. Claude is replaced by a fake that records the
// request and returns a fixed reply, so no test calls the API.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setUp, tool } from './helpers.mjs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = fromFunctions('firebase-admin');
const { getFtaFirestore } = fromFunctions('./lib/fta-client.js');
const { runTimeEntriesAction } = fromFunctions('./lib/time-entries-action.js');
const { buildDraftRequest, readDrafts } = fromFunctions('./lib/time-descriptions.js');

const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const DAY = '2026-10-13';

let db;
let fta;

before(() => {
  setUp();
  db = admin.firestore();
  fta = getFtaFirestore();
});

beforeEach(async () => {
  for (const project of ['demo-jax-test', 'fta-invoice-tracking']) {
    await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
  }
  await Promise.all([
    fta.doc('customers/c-ihrdc').set({ customerId: 'CUST-001', companyName: 'IHRDC', isActive: true }),
    fta.doc('customers/c-cox').set({ customerId: 'CUST-002', companyName: 'Cox Engineering', isActive: true }),
    fta.doc('projects/p-ai').set({ projectId: 'PROJ-001', customerId: 'c-ihrdc', projectName: 'AI Enablement', status: 'active' }),
    fta.doc('projects/p-web').set({ projectId: 'PROJ-002', customerId: 'c-cox', projectName: 'Website', status: 'active' }),
    fta.doc('projects/p-old').set({ projectId: 'PROJ-003', customerId: 'c-cox', projectName: 'Old Site', status: 'completed' }),
  ]);
});

/** A stand-in for the Anthropic client that answers with `text` and keeps the request it was sent. */
function fakeClaude(text, extra = {}) {
  const sent = [];
  const client = { beta: { messages: { create: async (request) => {
    sent.push(request);
    return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], ...extra };
  } } } };
  return { client, sent };
}

const run = (body, claude = fakeClaude('{}').client) => runTimeEntriesAction(db, body, () => claude);

const ROW = { client: 'IHRDC', date: DAY, start: '09:12', end: '10:05', items: [
  { source: 'github', action: 'Opened PR #674', subject: 'Fix saved grid layout', ticket: 'CNG-7039', repo: 'IHRDC/cmsonline' },
] };

describe('timeEntries: day', () => {
  it("returns the day's tracker entries in time order, and the active customers with their active projects", async () => {
    await tool('add_time_entries', { dry_run: false, entries: [
      { date: DAY, customer: 'IHRDC', start_time: '13:00', end_time: '13:45', description: 'Friday demo' },
    ] });
    await fta.doc('timeEntries/jacks').set({ date: DAY, startTime: '08:30', endTime: '09:00', durationHours: 0.5,
      customerId: 'c-cox', projectId: 'p-web', description: 'Homepage call', status: 'billed' });

    const { status, body } = await run({ action: 'day', day: DAY });

    assert.equal(status, 200);
    assert.deepEqual(body.entries.map(e => [e.start, e.end, e.customer, e.project, e.status, e.postedByMaisie]), [
      ['08:30', '09:00', 'Cox Engineering', 'Website', 'billed', false],
      ['13:00', '13:45', 'IHRDC', 'AI Enablement', 'unbilled', true],
    ]);
    assert.deepEqual(body.customers, [
      { id: 'c-cox', name: 'Cox Engineering', projects: [{ id: 'p-web', name: 'Website' }] },
      { id: 'c-ihrdc', name: 'IHRDC', projects: [{ id: 'p-ai', name: 'AI Enablement' }] },
    ]);
  });

  it('refuses a malformed day', async () => {
    assert.equal((await run({ action: 'day', day: '13/10/2026' })).body.success, false);
  });
});

describe('timeEntries: post', () => {
  it('posts for real, with the same checks as the chat', async () => {
    const { body } = await run({ action: 'post', entries: [
      { date: DAY, customer: 'c-ihrdc', project: 'p-ai', start_time: '09:12', end_time: '10:05', description: 'CNG-7039: Fixed saved grid layout' },
    ] });

    assert.equal(body.posted, 1);
    const saved = (await fta.collection('timeEntries').get()).docs.map(d => d.data());
    assert.deepEqual(saved.map(e => [e.startTime, e.endTime, e.durationHours, e.source]), [['09:12', '10:05', 0.88, 'maisie']]);
  });

  it('refuses an overlap and posts nothing', async () => {
    await fta.doc('timeEntries/jacks').set({ date: DAY, startTime: '09:00', endTime: '09:30', status: 'unbilled', description: 'Standup' });

    const { body } = await run({ action: 'post', entries: [
      { date: DAY, customer: 'c-ihrdc', start_time: '09:12', end_time: '10:05', description: 'Work' },
    ] });

    assert.equal(body.success, false);
    assert.match(body.error, /overlaps/);
    assert.equal((await fta.collection('timeEntries').get()).size, 1);
  });
});

describe('timeEntries: draft', () => {
  it("drafts one description per row, sending Jack's saved style with the journal items", async () => {
    await tool('save_memory', { topic: 'Invoice descriptions', instruction: 'Start each line with the Jira key.' });
    const claude = fakeClaude('{"descriptions":["CNG-7039: Fixed the saved grid layout. "]}');

    const { status, body } = await run({ action: 'draft', rows: [ROW] }, claude.client);

    assert.equal(status, 200);
    assert.deepEqual(body.descriptions, ['CNG-7039: Fixed the saved grid layout.']);
    const [request] = claude.sent;
    assert.match(request.system, /### Invoice descriptions\nStart each line with the Jira key\./);
    assert.match(request.messages[0].content, /Opened PR #674/);
    assert.equal(request.output_config.format.type, 'json_schema');
  });

  it('says drafting failed, without posting anything, when the reply has the wrong number of lines', async () => {
    const { status, body } = await run({ action: 'draft', rows: [ROW, ROW] }, fakeClaude('{"descriptions":["Only one"]}').client);

    assert.equal(status, 502);
    assert.match(body.error, /could not draft/);
    assert.equal((await fta.collection('timeEntries').get()).size, 0);
  });

  it('says drafting failed when the model declines', async () => {
    const { status } = await run({ action: 'draft', rows: [ROW] },
      fakeClaude('', { stop_reason: 'refusal', stop_details: { category: 'cyber' } }).client);
    assert.equal(status, 502);
  });

  it('refuses no rows, or an unknown action', async () => {
    assert.equal((await run({ action: 'draft', rows: [] })).status, 400);
    assert.equal((await run({ action: 'delete' })).status, 400);
  });
});

describe('draft request', () => {
  it('leaves out standing instructions when there are none, and keeps the rows in order', () => {
    const { system, user } = buildDraftRequest([ROW, { ...ROW, client: 'Cox Engineering', start: '11:00', end: '11:20' }], []);
    assert.doesNotMatch(system, /standing instructions \(saved/);
    assert.deepEqual(JSON.parse(user.slice(user.indexOf('['))).map(e => [e.entry, e.client, e.time]),
      [[1, 'IHRDC', '09:12-10:05'], [2, 'Cox Engineering', '11:00-11:20']]);
  });

  it('reads the descriptions only when there is one per row', () => {
    assert.deepEqual(readDrafts('{"descriptions":["a"," b "]}', 2), ['a', 'b']);
    assert.throws(() => readDrafts('{"descriptions":["a"]}', 2), /Expected 2/);
  });
});
