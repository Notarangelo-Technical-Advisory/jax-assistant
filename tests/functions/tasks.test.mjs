// Maisie's task tools with repeating tasks: the geraniums every month for three
// months, the furnace filters every quarter with no end.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { read, reset, seed, setUp, tool } from './helpers.mjs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { buildStateBlock } = fromFunctions('./lib/tools/context.js');
const { etDateKey } = fromFunctions('./lib/et-time.js');

before(setUp);
beforeEach(reset);

const GERANIUMS = { type: 'monthly', dayOfMonth: 1, remaining: 3 };
const FILTERS = { type: 'monthly', interval: 3, dayOfMonth: 1 };

/** A due date safely in the future, so completing it never skips a date. */
const FAR = '2099-01-01';

describe('add_task', () => {
  it('stores the rule with the task', async () => {
    const added = await tool('add_task', { title: 'Feed the geraniums', category: 'general', dueDate: FAR, recurrence: GERANIUMS });

    assert.equal(added.success, true);
    const task = await read(`tasks/${added.taskId}`);
    assert.deepEqual(task.recurrence, GERANIUMS);
    assert.equal(task.dueDate, FAR);
  });

  it('gives a repeating task with no due date the first date its rule falls on', async () => {
    const added = await tool('add_task', { title: 'Check the smoke alarms', category: 'general', recurrence: { type: 'daily' } });

    assert.equal(added.dueDate, etDateKey(new Date()));
    assert.equal((await read(`tasks/${added.taskId}`)).dueDate, etDateKey(new Date()));
  });

  it('still stores no rule and no date for a one-off task', async () => {
    const added = await tool('add_task', { title: 'Book flights', category: 'general' });

    const task = await read(`tasks/${added.taskId}`);
    assert.equal(task.recurrence, null);
    assert.equal(task.dueDate, null);
  });

  it('refuses a rule it cannot store, and adds nothing', async () => {
    const added = await tool('add_task', { title: 'Bad', category: 'general', recurrence: { type: 'monthly', interval: 0 } });

    assert.equal(added.success, false);
    assert.match(added.error, /interval/);
  });
});

describe('complete_task on a repeating task', () => {
  it('keeps a quarterly task open and moves it three months on', async () => {
    const { taskId } = await tool('add_task', { title: 'Change the furnace filters', category: 'general', dueDate: FAR, recurrence: FILTERS });

    const done = await tool('complete_task', { taskId });

    assert.deepEqual(done, { success: true, repeats: true, previousDueDate: FAR, nextDueDate: '2099-04-01', remaining: null });
    const task = await read(`tasks/${taskId}`);
    assert.equal(task.completed, false);
    assert.equal(task.dueDate, '2099-04-01');
    assert.deepEqual(task.recurrence, FILTERS);
  });

  it('counts down the times left, and closes the task after the last one', async () => {
    const { taskId } = await tool('add_task', { title: 'Feed the geraniums', category: 'general', dueDate: FAR, recurrence: GERANIUMS });

    assert.equal((await tool('complete_task', { taskId })).remaining, 2);
    assert.equal((await tool('complete_task', { taskId })).remaining, 1);
    let task = await read(`tasks/${taskId}`);
    assert.equal(task.dueDate, '2099-03-01');
    assert.equal(task.completed, false);

    assert.deepEqual(await tool('complete_task', { taskId }), { success: true, repeats: false, lastTime: true });
    task = await read(`tasks/${taskId}`);
    assert.equal(task.completed, true);
    assert.ok(task.completedAt);
  });

  it('still closes a one-off task', async () => {
    const { taskId } = await tool('add_task', { title: 'Book flights', category: 'general' });

    assert.deepEqual(await tool('complete_task', { taskId }), { success: true });
    assert.equal((await read(`tasks/${taskId}`)).completed, true);
  });

  it('says so when the task does not exist', async () => {
    const done = await tool('complete_task', { taskId: 'no-such-task' });
    assert.equal(done.success, false);
  });
});

describe('update_task', () => {
  it('makes an existing task repeat, and null stops it repeating', async () => {
    await seed('tasks/filters', { title: 'Change the furnace filters', category: 'general', completed: false, dueDate: FAR, createdAt: new Date() });

    assert.equal((await tool('update_task', { taskId: 'filters', recurrence: FILTERS })).success, true);
    assert.deepEqual((await read('tasks/filters')).recurrence, FILTERS);

    await tool('update_task', { taskId: 'filters', recurrence: null });
    assert.equal((await read('tasks/filters')).recurrence, null);
    assert.equal((await read('tasks/filters')).dueDate, FAR);
  });

  it('refuses a rule it cannot store, and leaves the task alone', async () => {
    await seed('tasks/filters', { title: 'Change the furnace filters', category: 'general', completed: false, dueDate: FAR, createdAt: new Date() });

    const updated = await tool('update_task', { taskId: 'filters', title: 'Changed', recurrence: { type: 'weekly', dayOfWeek: 9 } });

    assert.equal(updated.success, false);
    assert.equal((await read('tasks/filters')).title, 'Change the furnace filters');
  });
});

describe('Maisie\'s task list', () => {
  it('shows how each repeating task repeats', () => {
    const block = buildStateBlock({
      totalUnbilled: 0, unbilledAmount: 0, lastInvoice: null, todayBriefing: null, alerts: [],
      tasks: [
        { id: 'g', category: 'general', title: 'Feed the geraniums', dueDate: '2026-11-01', recurrence: GERANIUMS },
        { id: 'b', category: 'general', title: 'Book flights', dueDate: null, recurrence: null },
      ],
      recentCompletedTasks: [], sessionHistory: [], categories: [], calendarEvents: [], customerMap: new Map(), memories: [],
    });

    assert.match(block, /\[g\]\[general\] Feed the geraniums \(due: 2026-11-01\) \(repeats every month on the 1st, 3 left\)/);
    assert.match(block, /\[b\]\[general\] Book flights\n/);
  });
});
