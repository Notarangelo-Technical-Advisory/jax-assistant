import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AlertService } from './alert.service';
import { AuthService } from './auth.service';
import { BillingService } from './billing.service';
import { BriefingService } from './briefing.service';
import { CalendarService } from './calendar.service';
import { LinkedInService } from './linkedin.service';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, listDocuments, nextRequest, provideEmulator, seedDocument, signInAsJack, waitFor, watch
} from '../../testing/emulator-testing';

// The read-only dashboard feeds. Cloud Functions and the Mac calendar bridge
// write these documents, so the tests seed them past the security rules.

describe('Dashboard data services', () => {
  let emulator: EmulatorApp;
  let http: HttpTestingController;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    TestBed.configureTestingModule({
      providers: [...provideEmulator(emulator), provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    const auth = TestBed.inject(AuthService);
    await waitFor(() => auth.currentUser() !== null);
  });

  afterEach(async () => {
    http.verify();
    await emulator.dispose();
  });

  /** Waits for the request to go out, then checks it carries Jack's sign-in token. */
  async function expectAuthorisedPost(url: string) {
    const request = await nextRequest(http, url);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Authorization')).toMatch(/^Bearer .+/);
    return request;
  }

  describe('AlertService', () => {
    it('lists alerts not yet dismissed, newest first, and dismisses one', async () => {
      const service = TestBed.inject(AlertService);
      await seedDocument('alerts/old', { type: 'invoice', message: 'Invoice IHRDC', dismissed: false, briefingDate: '2026-10-01', createdAt: new Date('2026-10-01T11:00:00Z') });
      await seedDocument('alerts/new', { type: 'early', message: 'Meeting at 8am', dismissed: false, briefingDate: '2026-10-06', createdAt: new Date('2026-10-06T11:00:00Z') });
      await seedDocument('alerts/done', { type: 'early', message: 'Already seen', dismissed: true, briefingDate: '2026-10-05', createdAt: new Date('2026-10-05T11:00:00Z') });
      const alerts = watch(service.getActiveAlerts());
      await waitFor(() => alerts.latest()?.length === 2);
      expect(alerts.latest()!.map((a) => a.id)).toEqual(['new', 'old']);

      await service.dismissAlert('new');

      await waitFor(() => alerts.latest()?.length === 1);
      expect(alerts.latest()![0].id).toBe('old');
      alerts.stop();
    });
  });

  describe('BriefingService', () => {
    it('shows nothing until the live briefing exists, then shows it with its id', async () => {
      const briefing = watch(TestBed.inject(BriefingService).getLatestBriefing());
      await waitFor(() => briefing.latest() !== undefined);
      expect(briefing.latest()).toBeNull();

      await seedDocument('briefings/live', { date: '2026-10-06', unbilledHours: 12.5, narrativeSummary: 'A quiet day.' });

      await waitFor(() => briefing.latest() !== null);
      expect(briefing.latest()).toEqual(jasmine.objectContaining({ id: 'live', unbilledHours: 12.5, narrativeSummary: 'A quiet day.' }));
      briefing.stop();
    });

    it('reads the headlines from their own document', async () => {
      await seedDocument('briefings/headlines', { stories: [{ title: 'Rates held' }] });
      const headlines = watch(TestBed.inject(BriefingService).getHeadlines());
      await waitFor(() => !!headlines.latest());
      expect(headlines.latest() as unknown).toEqual({ stories: [{ title: 'Rates held' }] });
      headlines.stop();
    });

    it('asks the server to refresh the briefing', async () => {
      const done = TestBed.inject(BriefingService).triggerRefresh();
      (await expectAuthorisedPost('https://refreshbriefing-nxe253ex3a-uc.a.run.app')).flush({});
      await expectAsync(done).toBeResolved();
    });
  });

  describe('LinkedInService', () => {
    it('reads the coming Tuesday\'s post', async () => {
      await seedDocument('linkedin/week', { tuesday: '2026-10-13', title: 'Fractional CTOs', status: 'drafted', stage: 'needs-approval' });
      const week = watch(TestBed.inject(LinkedInService).getWeek());
      await waitFor(() => !!week.latest());
      expect(week.latest()).toEqual(jasmine.objectContaining({ tuesday: '2026-10-13', stage: 'needs-approval' }));
      week.stop();
    });

    it('sends an action with its date and details, and passes on a refusal', async () => {
      const service = TestBed.inject(LinkedInService);
      const approved = service.act('posted', '2026-10-13', { url: 'https://linkedin.com/posts/1' });
      const request = await expectAuthorisedPost('https://linkedinaction-nxe253ex3a-uc.a.run.app');
      expect(request.request.body).toEqual({ action: 'posted', date: '2026-10-13', url: 'https://linkedin.com/posts/1' });
      request.flush({});
      await expectAsync(approved).toBeResolved();

      const refused = service.act('approve', '2026-10-13');
      (await expectAuthorisedPost('https://linkedinaction-nxe253ex3a-uc.a.run.app'))
        .flush({ error: 'Draft has placeholders' }, { status: 400, statusText: 'Bad Request' });
      await expectAsync(refused).toBeRejected();
    });
  });

  describe('CalendarService', () => {
    const today = (hour: number) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d; };
    const dayOffset = (days: number) => { const d = today(10); d.setDate(d.getDate() + days); return d; };

    it('lists only today\'s events, in time order, with real dates', async () => {
      const synced = new Date('2026-10-06T05:00:00Z');
      await seedDocument('calendarEvents/afternoon', { summary: 'IHRDC demo', startTime: today(15), endTime: today(16), calendarName: 'Work', syncedAt: synced, changedAt: synced });
      await seedDocument('calendarEvents/morning', { summary: 'Standup', startTime: today(9), endTime: today(9), calendarName: 'Work', syncedAt: synced });
      await seedDocument('calendarEvents/yesterday', { summary: 'Old', startTime: dayOffset(-1), endTime: dayOffset(-1), calendarName: 'Work', syncedAt: synced });
      await seedDocument('calendarEvents/tomorrow', { summary: 'Later', startTime: dayOffset(1), endTime: dayOffset(1), calendarName: 'Work', syncedAt: synced });

      const events = watch(TestBed.inject(CalendarService).getTodayEvents());
      await waitFor(() => events.latest()?.length === 2);

      const [morning, afternoon] = events.latest()!;
      expect([morning.summary, afternoon.summary]).toEqual(['Standup', 'IHRDC demo']);
      expect(morning.startTime).toEqual(today(9));
      expect(afternoon.endTime).toEqual(today(16));
      expect(morning.syncedAt).toEqual(synced);
      expect(afternoon.changedAt).toEqual(synced);
      expect(morning.changedAt).toBeNull();
      events.stop();
    });
  });

  describe('BillingService', () => {
    const url = 'https://getunbilledsummary-nxe253ex3a-uc.a.run.app';

    it('summarises unbilled time and the last invoice', async () => {
      const summary = TestBed.inject(BillingService).getSummary();
      const request = await nextRequest(http, url);
      expect(request.request.headers.get('Authorization')).toMatch(/^Bearer .+/);
      const entry = { customerId: 'ihrdc', customerName: 'IHRDC', projectId: 'p', date: '2026-10-05', hours: 3, description: 'Demo', status: 'unbilled' };
      request.flush({ totalHours: 3, totalAmount: 675, entryCount: 1, lastInvoice: { issueDate: '2026-10-01', total: 9000 }, entries: [entry] });

      expect(await summary).toEqual({
        totalHours: 3, totalAmount: 675, entryCount: 1,
        lastInvoiceDate: '2026-10-01', lastInvoiceAmount: 9000, entries: [entry] as never,
      });
    });

    it('reports no last invoice and no entries when there are none', async () => {
      const summary = TestBed.inject(BillingService).getSummary();
      (await nextRequest(http, url)).flush({ totalHours: 0, totalAmount: 0, entryCount: 0, lastInvoice: null });

      expect(await summary).toEqual(jasmine.objectContaining({ lastInvoiceDate: null, lastInvoiceAmount: null, entries: [] }));
    });
  });

  it('a visitor who is not signed in cannot dismiss an alert', async () => {
    await seedDocument('alerts/a1', { type: 'early', message: 'Meeting at 8am', dismissed: false });
    const visitor = createEmulatorApp();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: provideEmulator(visitor) });

    const error = await TestBed.inject(AlertService).dismissAlert('a1').catch((e) => e);

    expect(error.code).toBe('permission-denied');
    expect((await listDocuments('alerts'))[0]['dismissed']).toEqual({ booleanValue: false });
    await visitor.dispose();
  });
});
