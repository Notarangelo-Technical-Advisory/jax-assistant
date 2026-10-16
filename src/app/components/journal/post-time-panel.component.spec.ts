import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from '../../services/auth.service';
import { TrackerDay } from '../../services/time-tracker.service';
import { JournalClientDay, JournalItem } from '../../models/journal.model';
import { PostTimePanelComponent, entryHours } from './post-time-panel.component';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, nextRequest, provideEmulator, signInAsJack, waitFor
} from '../../../testing/emulator-testing';

// The "Post time" panel on the journal page, signed in as Jack. The timeEntries
// Cloud Function is answered here with HttpTestingController.

const URL = 'https://timeentries-nxe253ex3a-uc.a.run.app';
const DAY = '2026-10-13';

// Tuesday 13 October 2026, Eastern Time (UTC-4): 9:21 for 17 minutes, 12:32 for 2 hours.
const IHRDC: JournalClientDay = {
  client: 'ihrdc', label: 'IHRDC', minutes: 137, itemCount: 3,
  sessions: [
    { start: '2026-10-13T13:21:00.000Z', end: '2026-10-13T13:38:00.000Z', minutes: 17, itemCount: 2 },
    { start: '2026-10-13T16:32:00.000Z', end: '2026-10-13T18:32:00.000Z', minutes: 120, itemCount: 1 },
  ],
};

const item = (fields: Partial<JournalItem>): JournalItem => ({
  source: 'github', sourceId: 'x', client: 'ihrdc', day: DAY, at: '', endAt: null, action: '', subject: '',
  detail: null, url: null, repo: null, ticket: null, ...fields,
});

const ITEMS: JournalItem[] = [
  item({ at: '2026-10-13T13:21:00.000Z', action: 'Opened PR #674', subject: 'Fix saved grid layout', ticket: 'CNG-7039', repo: 'IHRDC/cmsonline' }),
  item({ source: 'jira', at: '2026-10-13T13:38:00.000Z', action: 'Moved CNG-7039 to Code Review', subject: 'Saved grid layout drops columns', ticket: 'CNG-7039' }),
  item({ source: 'claude', at: '2026-10-13T16:32:00.000Z', action: 'Claude Code in cmsonline', subject: 'Story agent run ends' }),
  // Another client's work at the same time is not part of IHRDC's drafts.
  item({ client: 'general', at: '2026-10-13T13:25:00.000Z', action: 'Pushed to main', subject: 'Turn certificate checks back on' }),
];

const CUSTOMERS: TrackerDay['customers'] = [
  { id: 'c-cox', name: 'Cox Engineering', projects: [{ id: 'p-web', name: 'Website' }, { id: 'p-data', name: 'Data Migration' }] },
  { id: 'c-ihrdc', name: 'IHRDC', projects: [{ id: 'p-ai', name: 'AI Enablement' }] },
];

const trackerDay = (entries: TrackerDay['entries'] = []): TrackerDay => ({ success: true, entries, customers: CUSTOMERS });

describe('PostTimePanelComponent', () => {
  let emulator: EmulatorApp;
  let http: HttpTestingController;
  let fixture: ComponentFixture<PostTimePanelComponent>;
  let panel: PostTimePanelComponent;

  const text = (): string => {
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
  };

  /** Answers the next call to the timeEntries function, after checking its action and sign-in. */
  async function answer(action: string, body: object) {
    const request = await nextRequest(http, URL);
    expect(request.request.body.action).toBe(action);
    expect(request.request.headers.get('Authorization')).toMatch(/^Bearer .+/);
    const sent = request.request.body;
    request.flush(body);
    return sent;
  }

  async function open(entries: TrackerDay['entries'] = []): Promise<void> {
    fixture = TestBed.createComponent(PostTimePanelComponent);
    fixture.componentRef.setInput('day', DAY);
    fixture.componentRef.setInput('client', IHRDC);
    fixture.componentRef.setInput('items', ITEMS);
    panel = fixture.componentInstance;
    fixture.detectChanges();
    const sent = await answer('day', trackerDay(entries));
    expect(sent.day).toBe(DAY);
    await waitFor(() => panel.state() === 'ready');
  }

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    TestBed.configureTestingModule({
      imports: [PostTimePanelComponent],
      providers: [...provideEmulator(emulator), provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    const auth = TestBed.inject(AuthService);
    await waitFor(() => auth.currentUser() !== null);
  });

  afterEach(async () => {
    fixture?.destroy();
    http.verify();
    await emulator.dispose();
  });

  it("offers each work session with its exact times, and picks the client's customer and only project", async () => {
    await open();

    expect(panel.rows().map((r) => [r.start, r.end, r.include])).toEqual([['09:21', '09:38', true], ['12:32', '14:32', true]]);
    expect(panel.customerId()).toBe('c-ihrdc');
    expect(panel.projectId()).toBe('p-ai');
    expect(text()).toContain('Post 2 entries · 2.28 h');
  });

  it('unticks a session whose time is already in the tracker, and says so', async () => {
    await open([{ entryId: 'e1', start: '12:00', end: '13:00', hours: 1, customer: 'IHRDC', project: 'AI Enablement',
      description: 'Friday demo', status: 'billed', postedByMaisie: false }]);

    expect(panel.rows().map((r) => r.include)).toEqual([true, false]);
    const shown = text();
    expect(shown).toContain('Already in the tracker for this day');
    const logged = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.logged li')]
      .map((li) => [...li.querySelectorAll('span')].map((span) => span.textContent?.trim()));
    expect(logged).toEqual([['12:00 PM–1:00 PM', '1 h', 'IHRDC', 'Friday demo', 'billed']]);
    expect(shown).toContain('Already logged 12:00 PM–1:00 PM');
    expect(shown).toContain('Post 1 entry · 0.28 h');
  });

  it('will not post until every ticked entry has a description, and says why', async () => {
    await open();

    expect(panel.postBlocker()).toBe('Each entry needs a description.');
    expect(text()).toContain('Each entry needs a description.');
    panel.rows()[0].description = 'CNG-7039: Fixed saved grid layout';
    panel.rows()[1].include = false;
    expect(panel.postBlocker()).toBeNull();
  });

  it("asks which project when the customer has more than one", async () => {
    await open();

    panel.setCustomer('c-cox');
    expect(panel.projectId()).toBe('');
    panel.rows().forEach((r) => (r.description = 'Work'));
    expect(panel.postBlocker()).toBe('Choose the project.');
  });

  it("drafts descriptions from each session's own items, and fills them in for Jack to edit", async () => {
    await open();

    const drafting = panel.draft();
    const sent = await answer('draft', { success: true, descriptions: ['CNG-7039: Fixed the saved grid layout.', 'Story agent run in CMS Online.'] });
    await drafting;

    expect(sent.rows.map((r: { start: string; end: string; client: string; items: Array<{ action: string }> }) =>
      [r.client, r.start, r.end, r.items.map((i) => i.action)])).toEqual([
      ['IHRDC', '09:21', '09:38', ['Opened PR #674', 'Moved CNG-7039 to Code Review']],
      ['IHRDC', '12:32', '14:32', ['Claude Code in cmsonline']],
    ]);
    expect(panel.rows().map((r) => r.description)).toEqual(['CNG-7039: Fixed the saved grid layout.', 'Story agent run in CMS Online.']);
  });

  it('shows why drafting failed, and keeps what Jack had written', async () => {
    await open();
    panel.rows()[0].description = 'Mine';

    const drafting = panel.draft();
    (await nextRequest(http, URL)).flush({ success: false, error: 'Maisie could not draft the descriptions.' }, { status: 502, statusText: 'Bad Gateway' });
    await drafting;

    expect(text()).toContain('Maisie could not draft the descriptions.');
    expect(panel.rows()[0].description).toBe('Mine');
  });

  it('posts the ticked entries with the times as edited, then shows them as logged', async () => {
    await open();
    panel.rows()[0].description = 'CNG-7039: Fixed saved grid layout';
    panel.rows()[0].end = '09:45';
    panel.rows()[1].include = false;

    const posting = panel.post();
    const sent = await answer('post', { success: true, posted: 1, totalHours: 0.4 });
    await answer('day', trackerDay([{ entryId: 'new', start: '09:21', end: '09:45', hours: 0.4, customer: 'IHRDC',
      project: 'AI Enablement', description: 'CNG-7039: Fixed saved grid layout', status: 'unbilled', postedByMaisie: true }]));
    await posting;

    expect(sent.entries).toEqual([{ date: DAY, customer: 'c-ihrdc', project: 'p-ai', start_time: '09:21', end_time: '09:45',
      description: 'CNG-7039: Fixed saved grid layout' }]);
    expect(text()).toContain('Posted 1 entry, 0.4 h, to IHRDC.');
    expect(panel.rows()[0].logged?.entryId).toBe('new');
    expect(panel.rows()[0].include).toBeFalse();
  });

  it("shows the tracker's reason when it refuses the entries", async () => {
    await open();
    panel.rows().forEach((r) => (r.description = 'Work'));

    const posting = panel.post();
    await answer('post', { success: false, posted: 0, error: 'Nothing was posted. 2026-10-13 09:21-09:38: overlaps the entry already in the time tracker.' });
    await posting;

    expect(text()).toContain('Nothing was posted.');
  });

  it('tries once more by itself when the function cannot be reached, as when it is starting up', async () => {
    await open();
    panel.rows().forEach((r) => (r.description = ''));

    const drafting = panel.draft();
    (await nextRequest(http, URL)).error(new ProgressEvent('error'));
    await answer('draft', { success: true, descriptions: ['First', 'Second'] });
    await drafting;

    expect(panel.rows().map((r) => r.description)).toEqual(['First', 'Second']);
    expect(panel.message()).toBeNull();
  });

  it('does not try again when Maisie answered with a reason', async () => {
    await open();

    const drafting = panel.draft();
    (await nextRequest(http, URL)).flush({ success: false, error: 'Maisie could not draft the descriptions.' }, { status: 502, statusText: 'Bad Gateway' });
    await drafting;

    http.expectNone(URL);
    expect(text()).toContain('Maisie could not draft the descriptions.');
  });

  it('says when the tracker cannot be reached twice in a row, and Jack can try again', async () => {
    fixture = TestBed.createComponent(PostTimePanelComponent);
    fixture.componentRef.setInput('day', DAY);
    fixture.componentRef.setInput('client', IHRDC);
    fixture.componentRef.setInput('items', ITEMS);
    panel = fixture.componentInstance;
    fixture.detectChanges();
    (await nextRequest(http, URL)).error(new ProgressEvent('error'));
    (await nextRequest(http, URL)).error(new ProgressEvent('error'));
    await waitFor(() => panel.state() === 'error');
    expect(text()).toContain('Could not load the time tracker for this day.');

    panel.retry();
    await answer('day', trackerDay());
    await waitFor(() => panel.state() === 'ready');
  });

  it('works out hours to two decimals, as the tracker does', () => {
    expect(entryHours('09:12', '10:05')).toBe(0.88);
    expect(entryHours('10:00', '10:00')).toBe(0);
    expect(entryHours('', '10:00')).toBe(0);
  });
});
