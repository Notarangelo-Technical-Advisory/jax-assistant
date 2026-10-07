import { TestBed } from '@angular/core/testing';
import { TaskService } from './task.service';
import { Task, TaskRecurrence } from '../models/task.model';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, listDocuments, provideEmulator, signInAsJack, waitFor, watch
} from '../../testing/emulator-testing';

// The task list against the Firestore emulator, signed in as Jack.

/** A date as YYYY-MM-DD, `days` from today. */
function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('TaskService', () => {
  let emulator: EmulatorApp;
  let service: TaskService;
  let tasks: ReturnType<typeof watch<Task[]>>;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    TestBed.configureTestingModule({ providers: provideEmulator(emulator) });
    service = TestBed.inject(TaskService);
    tasks = watch(service.getActiveTasks());
  });

  afterEach(async () => {
    tasks.stop();
    await emulator.dispose();
  });

  /** Adds a task and waits for the live list to show it. */
  async function add(title: string, category?: string, dueDate?: string, recurrence?: TaskRecurrence): Promise<Task> {
    await service.addTask(title, category, dueDate, recurrence);
    await waitFor(() => (tasks.latest() ?? []).some((t) => t.title === title && t.createdAt));
    return tasks.latest()!.find((t) => t.title === title)!;
  }

  it('adds a task to the live list, newest first, in General unless told otherwise', async () => {
    await add('Send Brad the status report', 'ihrdc', '2026-10-09');
    await add('Renew the domain');

    expect(tasks.latest()!.map((t) => t.title)).toEqual(['Renew the domain', 'Send Brad the status report']);
    const [domain, report] = tasks.latest()!;
    expect(domain.category).toBe('general');
    expect(domain.dueDate).toBeNull();
    expect(domain.recurrence).toBeNull();
    expect(report.category).toBe('ihrdc');
    expect(report.dueDate).toBe('2026-10-09');
  });

  it('saves an inline edit with blank fields, and clears a field set to null', async () => {
    const task = await add('Draft the invoice', 'ihrdc', '2026-10-09', { type: 'monthly', dayOfMonth: 1 });

    // As the inline editor sends it: blank fields come through as undefined.
    await service.updateTask(task.id!, { title: 'Draft the IHRDC invoice', category: undefined, dueDate: null, recurrence: undefined });
    await waitFor(() => tasks.latest()![0].title === 'Draft the IHRDC invoice');

    const [saved] = tasks.latest()!;
    expect(saved.category).toBe('ihrdc');
    expect(saved.dueDate).toBeNull();
    expect(saved.recurrence).toEqual({ type: 'monthly', dayOfMonth: 1 });
  });

  it('writes nothing when an edit changes nothing', async () => {
    await expectAsync(service.updateTask('no-such-task', { title: undefined })).toBeResolved();
  });

  it('completes a one-off task and takes it off the list', async () => {
    const task = await add('Book flights');

    await service.completeTask(task.id!);
    await waitFor(() => tasks.latest()!.length === 0);

    const [stored] = await listDocuments('tasks');
    expect(stored['completed']).toEqual({ booleanValue: true });
    expect(stored['completedAt']).toBeDefined();
  });

  it('moves a daily task to tomorrow instead of completing it', async () => {
    const task = await add('Check email', 'general', daysFromToday(0), { type: 'daily' });

    await service.completeTask(task.id!);
    await waitFor(() => tasks.latest()![0].dueDate !== daysFromToday(0));
    expect(tasks.latest()![0].dueDate).toBe(daysFromToday(1));
    expect(tasks.latest()![0].completed).toBeFalse();
  });

  it('moves a weekly task to the next matching weekday', async () => {
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).getDay();
    const task = await add('Friday demo', 'ihrdc', undefined, { type: 'weekly', dayOfWeek: inTwoDays });

    await service.completeTask(task.id!);
    await waitFor(() => tasks.latest()![0].dueDate !== null);
    expect(tasks.latest()![0].dueDate).toBe(daysFromToday(2));
  });

  it('moves a weekly task due today to the same weekday next week', async () => {
    const task = await add('Status report', 'ihrdc', undefined, { type: 'weekly', dayOfWeek: new Date().getDay() });

    await service.completeTask(task.id!);
    await waitFor(() => tasks.latest()![0].dueDate !== null);
    expect(tasks.latest()![0].dueDate).toBe(daysFromToday(7));
  });

  it('deletes a task', async () => {
    const task = await add('Old idea');

    await service.deleteTask(task.id!);
    await waitFor(() => tasks.latest()!.length === 0);
    expect((await listDocuments('tasks')).length).toBe(0);
  });
});
