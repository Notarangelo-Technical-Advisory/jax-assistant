import { TestBed } from '@angular/core/testing';
import { TaskCategoryService } from './task-category.service';
import { TaskService } from './task.service';
import { TaskCategory } from '../models/task-category.model';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, provideEmulator, signInAsJack, waitFor, watch
} from '../../testing/emulator-testing';

describe('TaskCategoryService', () => {
  let emulator: EmulatorApp;
  let service: TaskCategoryService;
  let categories: ReturnType<typeof watch<TaskCategory[]>>;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    TestBed.configureTestingModule({ providers: provideEmulator(emulator) });
    service = TestBed.inject(TaskCategoryService);
    categories = watch(service.getCategories());
  });

  afterEach(async () => {
    categories.stop();
    await emulator.dispose();
  });

  const keys = (): string[] => (categories.latest() ?? []).map((c) => c.key);
  const builtIn = ['ihrdc', 'solomon', 'dial', 'ppk', 'church', 'embassy', 'cox', 'general'];

  it('lists the built-in categories when none are stored', async () => {
    await waitFor(() => categories.latest() !== undefined);
    expect(keys()).toEqual(builtIn);
  });

  it('adds custom categories after the built-in ones, in the order they were added', async () => {
    await service.addCategory('garden', 'Garden');
    await service.addCategory('house', 'House');
    await waitFor(() => keys().length === builtIn.length + 2);

    expect(keys()).toEqual([...builtIn, 'garden', 'house']);
    expect(categories.latest()!.slice(-2).map((c) => c.order)).toEqual([100, 101]);
  });

  it('refuses a key that is built in or already stored', async () => {
    await expectAsync(service.addCategory('ihrdc', 'IHRDC again')).toBeRejectedWithError(/built-in/);
    await service.addCategory('garden', 'Garden');
    await expectAsync(service.addCategory('garden', 'Garden again')).toBeRejectedWithError(/already exists/);
  });

  it('deletes a custom category', async () => {
    await service.addCategory('garden', 'Garden');
    await waitFor(() => keys().includes('garden'));

    await service.deleteCategory(categories.latest()!.find((c) => c.key === 'garden')!.id!);
    await waitFor(() => !keys().includes('garden'));
    expect(keys()).toEqual(builtIn);
  });

  it('counts only the open tasks in a category', async () => {
    const tasks = TestBed.inject(TaskService);
    const open = watch(tasks.getActiveTasks());
    await tasks.addTask('Prune roses', 'garden');
    await tasks.addTask('Mow', 'garden');
    await tasks.addTask('Weed', 'garden');
    await tasks.addTask('Status report', 'ihrdc');
    await waitFor(() => open.latest()?.length === 4);
    await tasks.completeTask(open.latest()!.find((t) => t.title === 'Weed')!.id!);
    open.stop();

    expect(await service.getActiveTaskCount('garden')).toBe(2);
  });
});
