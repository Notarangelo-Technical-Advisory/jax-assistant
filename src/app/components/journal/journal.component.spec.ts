import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FIRESTORE } from '../../firebase';
import { JOURNAL_NOW, JournalComponent, addDays, hours, presetRange, weekStart } from './journal.component';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, seedDocument, signInAsJack, waitFor
} from '../../../testing/emulator-testing';

// The journal page against the Firestore emulator, signed in as Jack, with the
// real security rules. The journal job on Jack's Mac writes the journal; here
// seedDocument stands in for it.

// The page opens on Wednesday 14 October 2026, at noon in Eastern Time (UTC-4),
// so its first 14 days are 1 to 14 October.
const NOW = new Date('2026-10-14T16:00:00Z');

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
      providers: [
        provideRouter([]),
        { provide: FIRESTORE, useValue: emulator.firestore },
        { provide: JOURNAL_NOW, useValue: () => NOW },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(JournalComponent);
    fixture.detectChanges();
    page = fixture.componentInstance;
  }

  const text = (selector?: string): string => {
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const element = selector ? root.querySelector(selector) : root;
    return element?.textContent?.replace(/\s+/g, ' ') ?? '';
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
    expect(text()).toContain('Nothing in the journal between these dates');
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

    it('shows a meeting from the calendar with its start and end, marked Calendar', async () => {
      await seedDocument('journal/meeting', item({
        source: 'meeting', sourceId: 'uid-review:2026-10-09T14:30:00.000Z', day: '2026-10-09',
        at: '2026-10-09T14:30:00.000Z', endAt: '2026-10-09T15:00:00.000Z',
        action: 'Meeting with 11 others', subject: 'Product Review Meeting', detail: 'IHRDC calendar',
      }));
      page.select('2026-10-09', null);
      await waitFor(() => page.dayItems().length === 1);

      const shown = text();
      expect(shown).toContain('10:30 AM–11:00 AM');
      expect(shown).toContain('Calendar Meeting with 11 others');
      expect(shown).toContain('Product Review Meeting');
      expect(shown).toContain('IHRDC calendar');
      const badge = (fixture.nativeElement as HTMLElement).querySelector('.source[data-source="meeting"]');
      expect(badge?.textContent?.trim()).toBe('Calendar');
    });

    it('opens on the last 14 days, with their total hours per client', () => {
      expect([page.rangeStart(), page.rangeEnd()]).toEqual(['2026-10-01', '2026-10-14']);
      expect(page.clientFilter()).toBeNull();
      expect(page.rangeTotals()).toEqual({
        totalMinutes: 233, itemCount: 7,
        clients: [
          { client: 'ihrdc', label: 'IHRDC', minutes: 167 },
          { client: 'solomon', label: 'Solomon', minutes: 60 },
          { client: 'general', label: 'General', minutes: 6 },
        ],
      });
      expect(text('.range-total .week-head span')).toBe('All clients, October 1, 2026 to October 14, 2026');
      expect(text('.range-total .hours')).toBe('3.9 h');
      expect(text('.range-total .week-clients')).toContain('IHRDC 2.8 h · Solomon 1.0 h · General 0.1 h');
    });

    it('shows only the days between the dates typed in', async () => {
      const root = fixture.nativeElement as HTMLElement;
      const from = root.querySelector<HTMLInputElement>('input[name="rangeStart"]')!;
      from.value = '2026-10-12';
      from.dispatchEvent(new Event('input'));
      await waitFor(() => page.loaded() && page.days().length === 2);

      expect(page.rangeStart()).toBe('2026-10-12');
      expect(page.weeks().map((w) => w.days.map((d) => d.day))).toEqual([['2026-10-13', '2026-10-12']]);
      expect(text('.range-total .week-head span')).toBe('All clients, October 12, 2026 to October 14, 2026');
      expect(text('.range-total .hours')).toBe('3.4 h');
    });

    it('shows one client\'s days and hours only when chosen, and every client again with All clients', async () => {
      await waitFor(() => page.categories().length > 0);
      fixture.detectChanges();
      const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('select[name="client"]')!;
      const options = [...select.options].map((o) => o.textContent?.trim());
      expect(options[0]).toBe('All clients');
      expect(options).toContain('IHRDC');
      expect(options).toContain('Cox Engineering');

      select.value = 'ihrdc';
      select.dispatchEvent(new Event('change'));
      expect(page.clientFilter()).toBe('ihrdc');
      expect(page.weeks().flatMap((w) => w.days.map((d) => [d.day, d.totalMinutes]))).toEqual([['2026-10-13', 137], ['2026-10-09', 30]]);
      expect(text('.range-total .week-head span')).toBe('IHRDC, October 1, 2026 to October 14, 2026');
      expect(text('.range-total .hours')).toBe('2.8 h');
      expect(text('.range-total .week-clients')).toBe('4 items');
      const list = text('.list');
      expect(list).not.toContain('Solomon');
      expect(list).not.toContain('General');
      expect((fixture.nativeElement as HTMLElement).querySelectorAll('.client-row').length).toBe(0);

      select.value = '';
      select.dispatchEvent(new Event('change'));
      expect(page.clientFilter()).toBeNull();
      expect(page.weeks().flatMap((w) => w.days).length).toBe(3);
      expect(text('.list')).toContain('Solomon');
    });

    it('opens the chosen client\'s work sessions when a day is clicked', async () => {
      page.setClient('ihrdc');
      fixture.detectChanges();
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.day-head')!.click();
      await waitFor(() => page.dayItems().length === 4);

      expect(page.selection()).toEqual({ day: '2026-10-13', client: 'ihrdc' });
      expect(page.groups().map((g) => g.items.length)).toEqual([2, 1]);
      expect(text()).toContain('IHRDC · Tuesday, October 13');
    });

    it('picks a range from the buttons, and marks the one in use', async () => {
      page.applyPreset('last-week');
      await waitFor(() => page.loaded() && page.days().length === 1);

      expect([page.rangeStart(), page.rangeEnd()]).toEqual(['2026-10-05', '2026-10-11']);
      expect(page.days().map((d) => d.day)).toEqual(['2026-10-09']);
      expect(text('.preset.active')).toBe('Last week');
    });

    it('says when the start date is after the end date, and shows no days', async () => {
      page.setRange('2026-10-14', '2026-10-01');

      expect(page.days()).toEqual([]);
      expect(text('.list')).toContain('The start date is after the end date.');
      expect(text('.list')).not.toContain('Week of');
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

  it('counts days across the end of a month', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('works out each range button from today', () => {
    // Wednesday 4 March 2026.
    expect(presetRange('last-14-days', '2026-03-04')).toEqual({ start: '2026-02-19', end: '2026-03-04' });
    expect(presetRange('this-week', '2026-03-04')).toEqual({ start: '2026-03-02', end: '2026-03-04' });
    expect(presetRange('last-week', '2026-03-04')).toEqual({ start: '2026-02-23', end: '2026-03-01' });
    expect(presetRange('this-month', '2026-03-04')).toEqual({ start: '2026-03-01', end: '2026-03-04' });
    expect(presetRange('last-month', '2026-03-04')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(presetRange('last-month', '2026-01-15')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
  });

  it('shows minutes as hours to one decimal place', () => {
    expect(hours(137)).toBe('2.3 h');
    expect(hours(6)).toBe('0.1 h');
    expect(hours(0)).toBe('0.0 h');
  });
});
