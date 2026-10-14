import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FIRESTORE } from '../../firebase';
import { JournalComponent, hours, weekStart } from './journal.component';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, seedDocument, signInAsJack, waitFor
} from '../../../testing/emulator-testing';

// The journal page against the Firestore emulator, signed in as Jack, with the
// real security rules. The journal job on Jack's Mac writes the journal; here
// seedDocument stands in for it.

// Tuesday 13 October 2026, Eastern Time (UTC-4).
const IHRDC_SESSIONS = [
  { start: '2026-10-13T13:21:00.000Z', end: '2026-10-13T13:38:00.000Z', minutes: 17, itemCount: 2 },
  { start: '2026-10-13T16:32:00.000Z', end: '2026-10-13T18:32:00.000Z', minutes: 120, itemCount: 1 },
];

const DAYS = {
  '2026-10-13': {
    day: '2026-10-13', totalMinutes: 143, itemCount: 4,
    clients: [
      { client: 'ihrdc', label: 'IHRDC', minutes: 137, itemCount: 3, sessions: IHRDC_SESSIONS },
      { client: 'general', label: 'General', minutes: 6, itemCount: 1,
        sessions: [{ start: '2026-10-13T19:00:00.000Z', end: '2026-10-13T19:00:00.000Z', minutes: 6, itemCount: 1 }] },
    ],
  },
  '2026-10-12': {
    day: '2026-10-12', totalMinutes: 60, itemCount: 2,
    clients: [{ client: 'solomon', label: 'Solomon', minutes: 60, itemCount: 2, sessions: [] }],
  },
  // The week before: Friday 9 October.
  '2026-10-09': {
    day: '2026-10-09', totalMinutes: 30, itemCount: 1,
    clients: [{ client: 'ihrdc', label: 'IHRDC', minutes: 30, itemCount: 1, sessions: [] }],
  },
};

const item = (fields: Record<string, string | null>) => ({
  source: 'github', sourceId: 'x', client: 'ihrdc', day: '2026-10-13', endAt: null,
  detail: null, url: null, repo: null, ticket: null, ...fields,
});

const ITEMS = {
  'journal/pr-opened': item({
    sourceId: 'e1', at: '2026-10-13T13:21:00.000Z', action: 'Opened PR #674', subject: 'Fix saved grid layout',
    url: 'https://github.com/IHRDC/cmsonline/pull/674', repo: 'IHRDC/cmsonline', ticket: 'CNG-7039',
  }),
  'journal/jira-move': item({
    source: 'jira', sourceId: 'CNG-7039:history:1', at: '2026-10-13T13:38:00.000Z',
    action: 'Moved CNG-7039 to Code Review', subject: 'Saved grid layout drops columns', detail: 'In Progress → Code Review',
    url: 'https://ihrdcdev.atlassian.net/browse/CNG-7039', ticket: 'CNG-7039',
  }),
  'journal/claude': item({
    source: 'claude', sourceId: 's1:2026-10-13T16:32:00.000Z', at: '2026-10-13T16:32:00.000Z', endAt: '2026-10-13T18:32:00.000Z',
    action: 'Claude Code in cmsonline', subject: 'Story agent run ends', detail: 'feature/CNG-7186 · 9 prompts', repo: 'IHRDC/cmsonline',
  }),
  'journal/general': item({
    client: 'general', sourceId: 'e2', at: '2026-10-13T19:00:00.000Z', action: 'Pushed to main', subject: 'Turn certificate checks back on',
    repo: 'Notarangelo-Technical-Advisory/jax-assistant',
  }),
};

describe('JournalComponent', () => {
  let emulator: EmulatorApp;
  let page: JournalComponent;
  let fixture: ComponentFixture<JournalComponent>;

  async function openPage(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [JournalComponent],
      providers: [provideRouter([]), { provide: FIRESTORE, useValue: emulator.firestore }],
    }).compileComponents();
    fixture = TestBed.createComponent(JournalComponent);
    fixture.detectChanges();
    page = fixture.componentInstance;
  }

  const text = (): string => {
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
  };

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
  });

  afterEach(() => emulator.dispose());

  it('says the journal is empty until the job on the Mac has run', async () => {
    await openPage();
    await waitFor(() => page.loaded());
    expect(text()).toContain('Nothing in the journal yet');
  });

  describe('with a journal', () => {
    beforeEach(async () => {
      for (const [day, summary] of Object.entries(DAYS)) await seedDocument(`journalDays/${day}`, summary);
      for (const [path, fields] of Object.entries(ITEMS)) await seedDocument(path, fields);
      await openPage();
      await waitFor(() => page.days().length === 3);
    });

    it('shows each week, newest first, with its estimated hours per client', () => {
      const weeks = page.weeks();
      expect(weeks.map((w) => w.start)).toEqual(['2026-10-12', '2026-10-05']);
      expect(weeks[0].days.map((d) => d.day)).toEqual(['2026-10-13', '2026-10-12']);
      expect(weeks[0].clients).toEqual([
        { client: 'ihrdc', label: 'IHRDC', minutes: 137 },
        { client: 'solomon', label: 'Solomon', minutes: 60 },
        { client: 'general', label: 'General', minutes: 6 },
      ]);
      const shown = text();
      expect(shown).toContain('Week of October 12');
      expect(shown).toContain('Tuesday, October 13');
      const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.client-row')]
        .map((row) => [...row.querySelectorAll('span')].map((span) => span.textContent?.trim()));
      expect(rows).toEqual([['IHRDC', '3 items', '2.3 h'], ['General', '1 item', '0.1 h'], ['Solomon', '2 items', '1.0 h'], ['IHRDC', '1 item', '0.5 h']]);
      expect(shown).toContain('Week of October 5');
    });

    it('opens one client\'s day as its work sessions, each with the items behind it', async () => {
      page.select('2026-10-13', 'ihrdc');
      await waitFor(() => page.dayItems().length === 4);

      const groups = page.groups();
      expect(groups.map((g) => [page.time(g.start!), page.time(g.end!), g.minutes])).toEqual([
        ['9:21 AM', '9:38 AM', 17],
        ['12:32 PM', '2:32 PM', 120],
      ]);
      expect(groups.map((g) => g.items.map((i) => i.action))).toEqual([
        ['Opened PR #674', 'Moved CNG-7039 to Code Review'],
        ['Claude Code in cmsonline'],
      ]);
      const shown = text();
      expect(shown).toContain('IHRDC · Tuesday, October 13');
      expect(shown).toContain('About 2.3 h from 3 items');
      expect(shown).toContain('12:32 PM–2:32 PM');
      expect(shown).not.toContain('Turn certificate checks back on');
    });

    it('links each item to GitHub or Jira, opening in a new tab', async () => {
      page.select('2026-10-13', 'ihrdc');
      await waitFor(() => page.dayItems().length === 4);
      fixture.detectChanges();

      const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a.subject');
      expect(link?.textContent?.trim()).toBe('Fix saved grid layout');
      expect(link?.href).toBe('https://github.com/IHRDC/cmsonline/pull/674');
      expect(link?.target).toBe('_blank');
    });

    it('opens the whole day as every item in time order, each marked with its client', async () => {
      page.select('2026-10-13', null);
      await waitFor(() => page.dayItems().length === 4);

      const [group] = page.groups();
      expect(group.items.map((i) => i.subject)).toEqual([
        'Fix saved grid layout', 'Saved grid layout drops columns', 'Story agent run ends', 'Turn certificate checks back on',
      ]);
      const shown = text();
      expect(shown).toContain('All clients · Tuesday, October 13');
      expect(shown).toContain('About 2.4 h from 4 items');
      expect(shown).toContain('Pushed to main General');
    });
  });
});

describe('journal helpers', () => {
  it('counts weeks from Monday', () => {
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
  });

  it('shows minutes as hours to one decimal place', () => {
    expect(hours(137)).toBe('2.3 h');
    expect(hours(6)).toBe('0.1 h');
    expect(hours(0)).toBe('0.0 h');
  });
});
