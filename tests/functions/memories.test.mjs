// Maisie's memory: standing instructions Jack gives once, such as how to write
// invoice descriptions, which she must follow in every later conversation.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { all, reset, seed, setUp, tick, tool } from './helpers.mjs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { buildStateBlock } = fromFunctions('./lib/tools/context.js');

before(setUp);
beforeEach(reset);

const INVOICE_STYLE = 'One line per ticket. Start with the Jira key, then a past-tense verb. No more than 12 words.';

const contextWith = (memories) => ({
  totalUnbilled: 0, unbilledAmount: 0, lastInvoice: null, todayBriefing: null,
  alerts: [], tasks: [], recentCompletedTasks: [], sessionHistory: [],
  categories: [], calendarEvents: [], customerMap: new Map(), memories,
});

describe('save_memory', () => {
  it('saves an instruction under its topic, and get_memories returns it', async () => {
    const saved = await tool('save_memory', { topic: ' Invoice descriptions ', instruction: INVOICE_STYLE });

    assert.deepEqual(saved, { success: true, replaced: false, topic: 'Invoice descriptions' });
    assert.deepEqual((await tool('get_memories')).memories, [{ topic: 'Invoice descriptions', instruction: INVOICE_STYLE }]);
  });

  it('replaces the instruction when the same topic is saved again, whatever its capitals, and returns the old one', async () => {
    await tool('save_memory', { topic: 'Invoice descriptions', instruction: INVOICE_STYLE });

    const again = await tool('save_memory', { topic: 'invoice  DESCRIPTIONS', instruction: 'No more than 8 words.' });

    assert.equal(again.replaced, true);
    assert.equal(again.previousInstruction, INVOICE_STYLE);
    const memories = (await tool('get_memories')).memories;
    assert.deepEqual(memories.map(m => m.instruction), ['No more than 8 words.']);
  });

  it('lists memories in the order they were first saved, not the order they were changed', async () => {
    await tool('save_memory', { topic: 'Invoice descriptions', instruction: INVOICE_STYLE });
    await tick();
    await tool('save_memory', { topic: 'Status reports', instruction: 'Bullets only.' });
    await tick();
    await tool('save_memory', { topic: 'Invoice descriptions', instruction: 'Changed.' });

    assert.deepEqual((await tool('get_memories')).memories.map(m => m.topic), ['Invoice descriptions', 'Status reports']);
  });

  it('refuses a memory with no topic or no instruction, and saves nothing', async () => {
    assert.equal((await tool('save_memory', { topic: ' -- ', instruction: INVOICE_STYLE })).success, false);
    const empty = await tool('save_memory', { topic: 'Invoice descriptions', instruction: '  ' });
    assert.equal(empty.success, false);
    assert.match(empty.error, /forget_memory/);
    assert.deepEqual(await all('memories'), []);
  });

  it('refuses a topic or an instruction that is too long, because every memory goes into every chat', async () => {
    assert.equal((await tool('save_memory', { topic: 'x'.repeat(81), instruction: 'Short.' })).success, false);
    const long = await tool('save_memory', { topic: 'Invoice descriptions', instruction: 'x'.repeat(4001) });
    assert.equal(long.success, false);
    assert.match(long.error, /4000/);
    assert.deepEqual(await all('memories'), []);
  });

  it('refuses a 51st topic, but still lets an existing topic be changed', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      seed(`memories/topic-${i}`, { topic: `Topic ${i}`, instruction: 'x', createdAt: new Date(), updatedAt: new Date() })));

    const extra = await tool('save_memory', { topic: 'One more', instruction: 'x' });
    assert.equal(extra.success, false);
    assert.match(extra.error, /Forget one/);

    assert.equal((await tool('save_memory', { topic: 'Topic 3', instruction: 'changed' })).success, true);
    assert.equal((await all('memories')).length, 50);
  });
});

describe('forget_memory', () => {
  it('removes the memory for a topic and returns what it said', async () => {
    await tool('save_memory', { topic: 'Invoice descriptions', instruction: INVOICE_STYLE });

    const forgotten = await tool('forget_memory', { topic: 'invoice descriptions' });

    assert.deepEqual(forgotten, { success: true, topic: 'Invoice descriptions', forgottenInstruction: INVOICE_STYLE });
    assert.deepEqual(await all('memories'), []);
  });

  it('refuses a topic it does not hold, and names the topics it does', async () => {
    await tool('save_memory', { topic: 'Invoice descriptions', instruction: INVOICE_STYLE });

    const missing = await tool('forget_memory', { topic: 'Status reports' });

    assert.equal(missing.success, false);
    assert.match(missing.error, /Saved topics: Invoice descriptions/);
    assert.equal((await all('memories')).length, 1);
  });
});

describe("Maisie's context", () => {
  it('carries every memory into each chat, so she follows it without being reminded', () => {
    const block = buildStateBlock(contextWith([{ topic: 'Invoice descriptions', instruction: INVOICE_STYLE }]));

    assert.match(block, /Jack's standing instructions/);
    assert.ok(block.includes(`### Invoice descriptions\n${INVOICE_STYLE}`));
  });

  it('says nothing about standing instructions when there are none', () => {
    assert.doesNotMatch(buildStateBlock(contextWith([])), /standing instructions/);
  });
});
