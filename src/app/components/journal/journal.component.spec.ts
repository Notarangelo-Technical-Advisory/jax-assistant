import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { JOURNAL_NOW, JournalComponent, addDays, hours, presetRange, weekStart } from './journal.component';
import { breaksIn, buildTimeline, clock, freeTimeWork, minuteOfDay, rhythmTotals } from './timeline';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, nextRequest, provideEmulator, seedDocument, signInAsJack, waitFor
} from '../../../testing/emulator-testing';
import { AuthService } from '../../services/auth.service';

const MOVE_URL = 'https://journalitems-nxe253ex3a-uc.a.run.app';

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
        ...provideEmulator(emulator),
        // A client's day shows the "Post time" panel, which calls the timeEntries function.
        provideHttpClient(withXhr()), provideHttpClientTesting(),
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

    it('shows a sent email at the time it was sent, marked Mail, with why it counts', async () => {
      await seedDocument('journal/email', item({
        source: 'email', sourceId: '<m1@ihrdc.com>', day: '2026-10-09', at: '2026-10-09T14:05:00.000Z', endAt: null,
        action: 'Sent email to 2 people', subject: 'Re: Phase two plan', detail: 'To ihrdc.com', url: null, repo: null, ticket: null,
      }));
      page.select('2026-10-09', null);
      await waitFor(() => page.dayItems().length === 1);

      const shown = text();
      expect(shown).toContain('10:05 AM');
      expect(shown).toContain('Mail Sent email to 2 people');
      expect(shown).toContain('Re: Phase two plan');
      expect(shown).toContain('To ihrdc.com');
      expect(text('.source[data-source="email"]').trim()).toBe('Mail');
    });

    it('shows a Wispr Flow recording with its notes link, marked Wispr Flow', async () => {
      await seedDocument('journal/recording', item({
        source: 'recording', sourceId: 'rec-1', day: '2026-10-09',
        at: '2026-10-09T15:05:00.000Z', endAt: '2026-10-09T15:23:00.000Z',
        action: 'Recorded meeting', subject: 'Phase Two Improvements Plan', detail: 'During Product Review Meeting',
        url: 'https://notes.wisprflow.ai/shared/abc',
      }));
      page.select('2026-10-09', null);
      await waitFor(() => page.dayItems().length === 1);

      const shown = text();
      expect(shown).toContain('11:05 AM–11:23 AM');
      expect(shown).toContain('During Product Review Meeting');
      expect(text('.source[data-source="recording"]').trim()).toBe('Wispr Flow');
      const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a.subject');
      expect(link?.href).toBe('https://notes.wisprflow.ai/shared/abc');
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

    describe('the timeline', () => {
      const root = () => fixture.nativeElement as HTMLElement;
      const rows = () => [...root().querySelectorAll<HTMLElement>('.timeline-row')];
      const row = (label: string) => rows().find((r) => r.querySelector('.row-day')?.textContent?.trim() === label)!;
      const openTimeline = () => {
        [...root().querySelectorAll<HTMLButtonElement>('.views button')].find((b) => b.textContent?.trim() === 'Timeline')!.click();
        fixture.detectChanges();
      };

      it('shows every day of the dates chosen as one line, oldest first, including the days with no work', () => {
        openTimeline();

        expect(rows().length).toBe(14);
        expect(rows()[0].querySelector('.row-day')?.textContent?.trim()).toBe('Thu, Oct 1');
        expect(row('Wed, Oct 14').querySelector('.row-hours')?.textContent?.trim()).toBe('No work');
        expect(row('Tue, Oct 13').querySelector('.row-hours')?.textContent?.trim()).toBe('2.4 h');
        expect(text('.timeline-key')).toContain('IHRDC');
        expect(text('.timeline-key')).toContain('General');
      });

      it("shows each work session in its client's colour at its time of day, and the breaks between them", () => {
        openTimeline();

        const day = row('Tue, Oct 13');
        const blocks = [...day.querySelectorAll<HTMLElement>('.block')].map((b) => b.title);
        expect(blocks).toEqual(['IHRDC, 9:21 AM–9:38 AM', 'IHRDC, 12:32 PM–2:32 PM', 'General, 3:00 PM–3:06 PM']);
        const colours = [...day.querySelectorAll<HTMLElement>('.block')].map((b) => b.dataset['colour']);
        expect(colours[0]).toBe(colours[1]);
        expect(colours[2]).not.toBe(colours[0]);
        const breaks = [...day.querySelectorAll<HTMLElement>('.break')];
        expect(breaks.map((b) => b.title)).toEqual(['Break, 9:38 AM–12:32 PM, 2.9 h', 'Break, 2:32 PM–3:00 PM, 0.5 h']);
        // Only a break of an hour or more is long enough to carry its length.
        expect(breaks.map((b) => b.textContent?.trim())).toEqual(['2.9 h', '']);
        // The longest break of the day, whenever it fell, beside the hours worked.
        expect(day.querySelector('.row-break')?.textContent?.trim()).toBe('2.9 h');
        expect(row('Wed, Oct 14').querySelector('.row-break')?.textContent?.trim()).toBe('');
        // The line runs from 6 AM to midnight, so 9:21 AM is 3 h 21 min into 18 hours.
        expect(parseFloat(day.querySelector<HTMLElement>('.block')!.style.left)).toBeCloseTo((201 / 1080) * 100, 3);
      });

      it('shades the time kept free, marks the work in it, and counts that work in pieces', () => {
        openTimeline();

        const day = row('Tue, Oct 13');
        // Noon is 6 hours into the 18-hour line.
        expect(parseFloat(day.querySelector<HTMLElement>('.free-zone')!.style.left)).toBeCloseTo((6 / 18) * 100, 3);
        expect(parseFloat(row('Sat, Oct 10').querySelector<HTMLElement>('.free-zone')!.style.left)).toBe(0);
        // The 9:21 AM work is in the morning; the 12:32 PM and 3:00 PM work is in free time.
        const marks = [...day.querySelectorAll<HTMLElement>('.free-mark')];
        expect(marks.length).toBe(2);
        // The mark starts where the 12:32 PM work starts, 6 h 32 min into the line.
        expect(parseFloat(marks[0].style.left)).toBeCloseTo((392 / 1080) * 100, 3);
        expect(day.querySelector('.row-free')?.textContent?.trim()).toBe('2.1 h · 2');
        expect(row('Wed, Oct 14').querySelector('.row-free')?.textContent?.trim()).toBe('');
      });

      it('sums the dates against the rhythm: weekday mornings, weekday afternoons and evenings in pieces, and weekends', () => {
        openTimeline();

        const stats = [...root().querySelectorAll('.rhythm .stat')].map((stat) =>
          [...stat.querySelectorAll(':scope > span')].map((span) => span.textContent?.replace(/\s+/g, ' ').trim()));
        expect(stats).toEqual([
          ['0.3 h (12%)', 'Weekday mornings, until noon'],
          ['2.1 h (88%) in 2 pieces', 'Weekday afternoons and evenings, on 1 of 10 weekdays'],
          ['0.0 h (0%) in 0 pieces', 'Weekends, on 0 of 4 days'],
        ]);
      });

      it("greys out other clients' work when one client is chosen, and keeps the same breaks", () => {
        page.setClient('ihrdc');
        openTimeline();

        const day = row('Tue, Oct 13');
        expect(day.querySelectorAll('.block.other').length).toBe(1);
        expect(day.querySelectorAll('.break').length).toBe(2);
        expect(day.querySelector('.row-hours')?.textContent?.trim()).toBe('2.3 h');
        expect(text('.timeline-key')).toContain('Other clients');
      });

      it("counts only the chosen client's work in the summary and the In free time column", () => {
        page.setClient('ihrdc');
        openTimeline();

        // IHRDC: 9:21–9:38 AM, and 12:32–2:32 PM. The General work at 3:00 PM is left out.
        const day = row('Tue, Oct 13');
        expect(day.querySelector('.row-free')?.textContent?.trim()).toBe('2.0 h · 1');
        expect(day.querySelectorAll('.free-mark').length).toBe(1);
        expect(text('.rhythm-head')).toBe('IHRDC');
        const stats = [...root().querySelectorAll('.rhythm .stat')].map((stat) =>
          [...stat.querySelectorAll(':scope > span')].map((span) => span.textContent?.replace(/\s+/g, ' ').trim()));
        expect(stats.slice(0, 2)).toEqual([
          ['0.3 h (12%)', 'Weekday mornings, until noon'],
          ['2.0 h (88%) in 1 piece', 'Weekday afternoons and evenings, on 1 of 10 weekdays'],
        ]);

        page.setClient(null);
        fixture.detectChanges();
        expect(text('.rhythm-head')).toBe('All clients');
        expect(row('Tue, Oct 13').querySelector('.row-free')?.textContent?.trim()).toBe('2.1 h · 2');
      });

      it("opens a day's details in the list when its line is clicked", () => {
        openTimeline();
        row('Tue, Oct 13').click();
        fixture.detectChanges();

        expect(page.view()).toBe('list');
        expect(page.selection()).toEqual({ day: '2026-10-13', client: null });
        expect(text('.detail-head')).toContain('All clients · Tuesday, October 13');
      });

      it('asks for a shorter range when more than 62 days are chosen', () => {
        page.setRange('2026-08-01', '2026-10-14');
        openTimeline();

        expect(rows().length).toBe(0);
        expect(text('.timeline')).toContain('The timeline shows 62 days or fewer');
      });
    });

    describe('moving items to another client', () => {
      let http: HttpTestingController;
      const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
      const click = (selector: string, index = 0): void => {
        fixture.detectChanges();
        root().querySelectorAll<HTMLElement>(selector)[index].click();
        fixture.detectChanges();
      };
      const chooseClient = (key: string): void => {
        const select = root().querySelector<HTMLSelectElement>('select[name="moveTo"]')!;
        select.value = key;
        select.dispatchEvent(new Event('change'));
        fixture.detectChanges();
      };

      beforeEach(async () => {
        http = TestBed.inject(HttpTestingController);
        const auth = TestBed.inject(AuthService);
        await waitFor(() => auth.currentUser() !== null);
      });

      afterEach(() => http.verify());

      it("ticks one session's items from its heading, and every item shown with Select all", async () => {
        page.select('2026-10-13', 'ihrdc');
        await waitFor(() => page.dayItems().length === 4);

        click('.group-check input');
        expect(page.checkedIds()).toEqual(['pr-opened', 'jira-move']);
        expect(text('.move-bar')).toContain('2 selected');

        click('.check-all input');
        expect(page.checkedIds()).toEqual(['pr-opened', 'jira-move', 'claude']);
        click('.check-all input');
        expect(page.checkedIds()).toEqual([]);
      });

      it('offers every task category but the client open, and moves nothing until one is chosen', async () => {
        page.select('2026-10-13', 'ihrdc');
        await waitFor(() => page.dayItems().length === 4 && page.categories().length > 0);
        click('.item-check');

        const options = [...root().querySelectorAll<HTMLOptionElement>('select[name="moveTo"] option')].map((o) => o.textContent?.trim());
        expect(options).toContain('NTA Business');
        expect(options).not.toContain('IHRDC');
        expect(root().querySelector<HTMLButtonElement>('.btn-move')!.disabled).toBeTrue();
      });

      it('moves the ticked items through the journalItems function, and opens the whole day when the client has none left', async () => {
        page.select('2026-10-13', 'general');
        await waitFor(() => page.dayItems().length === 4 && page.categories().length > 0);
        click('.item-check');
        chooseClient('ihrdc');
        click('.btn-move');

        const request = await nextRequest(http, MOVE_URL);
        expect(request.request.body).toEqual({ action: 'move', ids: ['general'], client: 'ihrdc' });
        expect(request.request.headers.get('Authorization')).toMatch(/^Bearer .+/);
        request.flush({ success: true, moved: 1, client: 'ihrdc', label: 'IHRDC', days: ['2026-10-13'] });
        await waitFor(() => !page.moving());

        expect(page.selection()).toEqual({ day: '2026-10-13', client: null });
        expect(page.checkedIds()).toEqual([]);
        expect(text()).toContain('Moved 1 item to IHRDC.');
      });

      it('shows why a move was refused, and keeps the items ticked to try again', async () => {
        page.select('2026-10-13', 'ihrdc');
        await waitFor(() => page.dayItems().length === 4 && page.categories().length > 0);
        click('.item-check');
        chooseClient('nta');
        click('.btn-move');

        (await nextRequest(http, MOVE_URL)).flush({ success: false, error: '1 of these items is no longer in the journal. Reload the page and try again.' });
        await waitFor(() => !page.moving());

        expect(text('.move-error')).toContain('no longer in the journal');
        expect(page.checkedIds()).toEqual(['pr-opened']);
        expect(page.selection()).toEqual({ day: '2026-10-13', client: 'ihrdc' });
      });

      it('marks an item Jack moved himself', async () => {
        await seedDocument('journal/general', { ...ITEMS['journal/general'], client: 'ihrdc', clientByHand: true });
        page.select('2026-10-13', null);
        await waitFor(() => page.dayItems().some((i) => i.clientByHand));

        expect(text()).toContain('Turn certificate checks back on');
        expect(text('.by-hand')).toContain('Moved by you');
      });
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

  it('places a time on its day in Eastern Time, through the change back from daylight saving time', () => {
    // Sunday 1 November 2026: Eastern Time changes from UTC-4 to UTC-5 at 2 AM.
    expect(minuteOfDay('2026-11-01T13:30:00Z', '2026-11-01')).toBe(8 * 60 + 30);
    expect(minuteOfDay('2026-11-02T03:30:00Z', '2026-11-01')).toBe(22 * 60 + 30);
    // Work running past midnight stops at the end of its day, and work from the day before starts at its beginning.
    expect(minuteOfDay('2026-11-02T05:30:00Z', '2026-11-01')).toBe(24 * 60);
    expect(minuteOfDay('2026-11-01T03:30:00Z', '2026-11-01')).toBe(0);
  });

  it('shows a time of day on a 12-hour clock, with midnight at both ends of the day', () => {
    expect(clock(0)).toBe('12:00 AM');
    expect(clock(9 * 60 + 5)).toBe('9:05 AM');
    expect(clock(13 * 60 + 30)).toBe('1:30 PM');
    expect(clock(24 * 60)).toBe('12:00 AM');
  });

  it('counts a break only after more than 20 minutes with no work for any client', () => {
    expect(breaksIn([
      { start: 540, end: 600 },
      { start: 590, end: 620 }, // Overlaps: no break.
      { start: 640, end: 650 }, // 20 minutes later: no break.
      { start: 700, end: 760 },
    ])).toEqual([{ start: 650, end: 700, minutes: 50 }]);
    expect(breaksIn([])).toEqual([]);
  });

  it('counts free-time work once where clients overlap, and splits it into pieces only at breaks of more than 20 minutes', () => {
    expect(freeTimeWork([
      { start: 660, end: 750 }, // 11:00 AM–12:30 PM: 30 minutes after noon.
      { start: 900, end: 915 }, // 3:00–3:15 PM
      { start: 905, end: 925 }, // Overlaps: the same piece, counted once.
      { start: 940, end: 950 }, // 15 minutes later: still the same piece.
      { start: 1200, end: 1230 }, // 8:00 PM
    ], 720)).toEqual({ minutes: 30 + 25 + 10 + 30, pieces: 3 });
    expect(freeTimeWork([{ start: 540, end: 600 }], 720)).toEqual({ minutes: 0, pieces: 0 });
  });

  it('counts all of a weekend as free time, and only weekday mornings as work time', () => {
    const day = (date: string, start: string, minutes: number) => ({
      day: date, totalMinutes: minutes, itemCount: 1,
      clients: [{ client: 'ihrdc', label: 'IHRDC', minutes, itemCount: 1, sessions: [{ start, end: start, minutes, itemCount: 1 }] }],
    });
    // Friday 9 October 9:00 AM for an hour; Saturday 10 October 10:00 AM for half an hour.
    const t = buildTimeline('2026-10-09', '2026-10-11', [
      day('2026-10-09', '2026-10-09T13:00:00.000Z', 60), day('2026-10-10', '2026-10-10T14:00:00.000Z', 30),
    ], null);
    expect(t.days.map((d) => [d.weekend, d.freeFrom, d.morningMinutes, d.freeMinutes, d.freePieces])).toEqual([
      [false, 720, 60, 0, 0], [true, 0, 0, 30, 1], [true, 0, 0, 0, 0],
    ]);
    expect(rhythmTotals(t.days)).toEqual({
      morningMinutes: 60, weekdays: 1, afternoonMinutes: 0, afternoonPieces: 0, afternoonDays: 0,
      weekendDays: 2, weekendMinutes: 30, weekendPieces: 1, weekendDaysWorked: 1,
    });
  });

  it('starts the timeline before 6 AM only when there was work before 6 AM', () => {
    const day = (start: string) => ({
      day: '2026-10-13', totalMinutes: 30, itemCount: 1,
      clients: [{ client: 'ihrdc', label: 'IHRDC', minutes: 30, itemCount: 1,
        sessions: [{ start, end: start, minutes: 30, itemCount: 1 }] }],
    });
    expect(buildTimeline('2026-10-13', '2026-10-13', [day('2026-10-13T13:00:00.000Z')], null).axisStart).toBe(6 * 60);
    // 4:40 AM Eastern Time: the line starts at 4 AM.
    const early = buildTimeline('2026-10-12', '2026-10-13', [day('2026-10-13T08:40:00.000Z')], null);
    expect(early.axisStart).toBe(4 * 60);
    expect(early.days.map((d) => d.day)).toEqual(['2026-10-12', '2026-10-13']);
    // A single item counts for its minutes from its start, as in the hours.
    expect(early.days[1].blocks.map((b) => [b.start, b.end])).toEqual([[280, 310]]);
    // One stretch of work and no break: the longest break is 0, shown as None.
    expect(early.days[1].longestBreak).toBe(0);
  });

  it('shows minutes as hours to one decimal place', () => {
    expect(hours(137)).toBe('2.3 h');
    expect(hours(6)).toBe('0.1 h');
    expect(hours(0)).toBe('0.0 h');
  });
});
