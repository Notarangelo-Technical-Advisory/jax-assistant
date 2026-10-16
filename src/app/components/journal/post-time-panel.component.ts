import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JournalClientDay, JournalItem } from '../../models/journal.model';
import { DraftRow, TimeTrackerService, TrackerCustomer, TrackerEntry } from '../../services/time-tracker.service';

const ET_ZONE = 'America/New_York';
const LAST_MINUTE = 23 * 60 + 59;

/** One work session from the journal, as a time entry Jack can edit before posting. */
export interface PostRow {
  /** The session's start and end, as the journal recorded them (ISO). */
  sessionStart: string;
  sessionEnd: string;
  /** HH:MM in Eastern Time, to the minute. */
  start: string;
  end: string;
  description: string;
  include: boolean;
  /** The tracker entry this session overlaps, when the time is already logged. */
  logged: TrackerEntry | null;
}

/** "09:21" in Eastern Time, the time zone the journal's days and the tracker's times are in. */
export function etClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: ET_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function toMinutes(clock: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

export function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Hours from start to end, to two decimals, as the tracker works them out; 0 when the end is not after the start. */
export function entryHours(start: string, end: string): number {
  const diff = toMinutes(end) - toMinutes(start);
  return Number.isFinite(diff) && diff > 0 ? Math.round((diff / 60) * 100) / 100 : 0;
}

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }): boolean =>
  toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);

/**
 * Post one client's day from the journal to the NTA time tracker. Each work
 * session becomes an entry with its exact times, which Jack can change. Maisie
 * drafts the descriptions in his saved style; nothing is posted until he
 * presses Post. Sessions that overlap time already in the tracker start
 * unticked, so the same minutes are not billed twice. It starts closed;
 * clicking its heading opens and closes it.
 */
@Component({
  selector: 'app-post-time-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './post-time-panel.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './post-time-panel.component.scss',
})
export class PostTimePanelComponent {
  readonly day = input.required<string>();
  readonly client = input.required<JournalClientDay>();
  /** Every journal item of the day, for the drafts. */
  readonly items = input.required<JournalItem[]>();

  private tracker = inject(TimeTrackerService);
  /** Guards against a slow answer for a day Jack has already left. */
  private loadCount = 0;

  /** Closed until Jack opens it, so reading a day makes no call to the tracker. */
  expanded = signal(false);
  state = signal<'loading' | 'ready' | 'error'>('loading');
  loadError = signal('');
  entries = signal<TrackerEntry[]>([]);
  customers = signal<TrackerCustomer[]>([]);
  customerId = signal('');
  projectId = signal('');
  rows = signal<PostRow[]>([]);
  busy = signal<'draft' | 'post' | null>(null);
  message = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);

  readonly entryHours = entryHours;

  constructor() {
    effect(() => {
      const day = this.day();
      const client = this.client();
      if (!this.expanded()) return;
      untracked(() => this.load(day, client));
    });
  }

  projects = computed(() => this.customers().find((c) => c.id === this.customerId())?.projects ?? []);

  /** The rows ticked for posting. Read on every check, because the rows are edited in place. */
  included(): PostRow[] {
    return this.rows().filter((r) => r.include);
  }

  totalHours(): number {
    return Math.round(this.included().reduce((n, r) => n + entryHours(r.start, r.end), 0) * 100) / 100;
  }

  /** Why Post is not available yet, or null when it is. */
  postBlocker(): string | null {
    const rows = this.included();
    if (rows.length === 0) return 'Tick at least one session.';
    if (!this.customerId()) return 'Choose the customer.';
    if (!this.projectId()) return 'Choose the project.';
    if (rows.some((r) => entryHours(r.start, r.end) <= 0)) return 'Each end time must be after its start time.';
    if (rows.some((r) => !r.description.trim())) return 'Each entry needs a description.';
    return null;
  }

  async load(day: string, client: JournalClientDay): Promise<void> {
    const count = ++this.loadCount;
    this.state.set('loading');
    this.message.set(null);
    this.rows.set(client.sessions.map((s) => {
      const start = etClock(s.start);
      const end = fromMinutes(Math.min(toMinutes(start) + Math.max(1, Math.round(s.minutes)), LAST_MINUTE));
      return { sessionStart: s.start, sessionEnd: s.end, start, end, description: '', include: true, logged: null };
    }));
    try {
      const result = await this.tracker.getDay(day);
      if (count !== this.loadCount) return;
      if (!result.success) throw new Error(result.error ?? 'The time tracker refused the request.');
      this.customers.set(result.customers);
      this.showEntries(result.entries);
      const match = result.customers.find((c) => c.name.toLowerCase() === client.label.toLowerCase());
      this.setCustomer(match?.id ?? '');
      this.state.set('ready');
    } catch (err) {
      if (count !== this.loadCount) return;
      this.loadError.set(err instanceof Error ? err.message : String(err));
      this.state.set('error');
    }
  }

  toggle(): void {
    this.expanded.set(!this.expanded());
  }

  retry(): void {
    void this.load(this.day(), this.client());
  }

  setCustomer(id: string): void {
    this.customerId.set(id);
    const projects = this.customers().find((c) => c.id === id)?.projects ?? [];
    this.projectId.set(projects.length === 1 ? projects[0].id : '');
  }

  async draft(): Promise<void> {
    const rows = this.included();
    if (rows.length === 0) return;
    const client = this.client();
    const request: DraftRow[] = rows.map((r) => ({
      client: this.customers().find((c) => c.id === this.customerId())?.name ?? client.label,
      date: this.day(),
      start: r.start,
      end: r.end,
      items: this.items()
        .filter((i) => i.client === client.client && r.sessionStart <= i.at && i.at <= r.sessionEnd)
        .map((i) => ({ source: i.source, action: i.action, subject: i.subject, ticket: i.ticket, repo: i.repo })),
    }));
    this.busy.set('draft');
    this.message.set(null);
    try {
      const descriptions = await this.tracker.draft(request);
      rows.forEach((r, i) => (r.description = descriptions[i]));
      this.rows.set([...this.rows()]);
    } catch (err) {
      this.message.set({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(null);
    }
  }

  async post(): Promise<void> {
    if (this.postBlocker()) return;
    const rows = this.included();
    this.busy.set('post');
    this.message.set(null);
    try {
      const result = await this.tracker.post(rows.map((r) => ({
        date: this.day(), customer: this.customerId(), project: this.projectId(),
        start_time: r.start, end_time: r.end, description: r.description.trim(),
      })));
      if (!result.success) {
        this.message.set({ kind: 'error', text: result.error ?? 'The time tracker refused the entries.' });
        return;
      }
      const customer = this.customers().find((c) => c.id === this.customerId())?.name ?? '';
      this.message.set({ kind: 'ok', text: `Posted ${result.posted} ${result.posted === 1 ? 'entry' : 'entries'}, ${result.totalHours} h, to ${customer}.` });
      const day = await this.tracker.getDay(this.day());
      if (day.success) this.showEntries(day.entries);
    } catch (err) {
      this.message.set({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.set(null);
    }
  }

  /** Show the tracker's entries, and untick each session whose time is already in them. */
  private showEntries(entries: TrackerEntry[]): void {
    this.entries.set(entries);
    this.rows.set(this.rows().map((r) => {
      const logged = entries.find((e) => overlaps(r, e)) ?? null;
      return { ...r, logged, include: logged ? false : r.include };
    }));
  }

  /** "9:21 AM" from "09:21". */
  clock(hhmm: string): string {
    const minutes = toMinutes(hhmm);
    if (!Number.isFinite(minutes)) return hhmm;
    const h = Math.floor(minutes / 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
}
