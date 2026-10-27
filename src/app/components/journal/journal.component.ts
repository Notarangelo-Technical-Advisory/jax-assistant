import { Component, InjectionToken, OnDestroy, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { JournalService } from '../../services/journal.service';
import { TaskCategoryService } from '../../services/task-category.service';
import { JournalDay, JournalItem, JournalSource } from '../../models/journal.model';
import { PostTimePanelComponent } from './post-time-panel.component';

const ET_ZONE = 'America/New_York';
/** The page opens on the last 14 days, today included. */
const DEFAULT_DAYS = 14;

/** The time now. Tests give a fixed time, so "today" does not move. */
export const JOURNAL_NOW = new InjectionToken<() => Date>('JOURNAL_NOW', {
  providedIn: 'root',
  factory: () => () => new Date(),
});

/** A day's key at noon UTC, so no time zone can move it to another date. */
const noon = (day: string): Date => new Date(`${day}T12:00:00Z`);

/** Today in Eastern Time, the time zone the journal's days are counted in, as YYYY-MM-DD. */
export function etToday(now: Date): string {
  return now.toLocaleDateString('en-CA', { timeZone: ET_ZONE });
}

/** The day `count` days after `day` (or before, when `count` is negative), as YYYY-MM-DD. */
export function addDays(day: string, count: number): string {
  const d = noon(day);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week a day falls in, as YYYY-MM-DD. */
export function weekStart(day: string): string {
  return addDays(day, -((noon(day).getUTCDay() + 6) % 7));
}

export type RangePreset = 'last-14-days' | 'this-week' | 'last-week' | 'this-month' | 'last-month';

export const RANGE_PRESETS: Array<{ key: RangePreset; label: string }> = [
  { key: 'last-14-days', label: 'Last 14 days' },
  { key: 'this-week', label: 'This week' },
  { key: 'last-week', label: 'Last week' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
];

/** The first and last day of a preset range, counted from `today`. Weeks start on Monday. */
export function presetRange(preset: RangePreset, today: string): { start: string; end: string } {
  const monthStart = `${today.slice(0, 8)}01`;
  switch (preset) {
    case 'last-14-days': return { start: addDays(today, -(DEFAULT_DAYS - 1)), end: today };
    case 'this-week': return { start: weekStart(today), end: today };
    case 'last-week': return { start: addDays(weekStart(today), -7), end: addDays(weekStart(today), -1) };
    case 'this-month': return { start: monthStart, end: today };
    case 'last-month': {
      const end = addDays(monthStart, -1);
      return { start: `${end.slice(0, 8)}01`, end };
    }
  }
}

/** Minutes as hours to one decimal place, as time is billed: "3.4 h". */
export function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

export interface JournalWeek {
  start: string;
  totalMinutes: number;
  clients: Array<{ client: string; label: string; minutes: number }>;
  days: JournalDay[];
}

/** The chosen dates' time, in total and per client. */
export interface RangeTotals {
  totalMinutes: number;
  itemCount: number;
  clients: Array<{ client: string; label: string; minutes: number }>;
}

/** Items under one heading of the details: a work session, or the whole day. */
export interface ItemGroup {
  key: string;
  start: string | null;
  end: string | null;
  minutes: number | null;
  items: JournalItem[];
}

type Selection = { day: string; client: string | null } | null;

const SOURCE_LABELS: Record<JournalSource, string> = {
  github: 'GitHub', jira: 'Jira', claude: 'Claude Code', meeting: 'Calendar', recording: 'Wispr Flow', email: 'Mail',
};

@Component({
  selector: 'app-journal',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PostTimePanelComponent],
  templateUrl: './journal.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './journal.component.scss',
})
export class JournalComponent implements OnDestroy {
  private journal = inject(JournalService);
  private categoriesSub: Subscription | null = null;
  private daysSub: Subscription | null = null;
  private itemsSub: Subscription | null = null;
  private readonly today = etToday(inject(JOURNAL_NOW)());

  /** Every day with work between the chosen dates, for every client. */
  days = signal<JournalDay[]>([]);
  loaded = signal(false);
  rangeStart = signal(presetRange('last-14-days', this.today).start);
  rangeEnd = signal(this.today);
  /** The client chosen in the filter; null for all clients. */
  clientFilter = signal<string | null>(null);
  categories = signal<Array<{ key: string; label: string }>>([]);
  selection = signal<Selection>(null);
  /** Every item of the selected day. */
  dayItems = signal<JournalItem[]>([]);
  /** The ids of the items ticked to move to another client. */
  checked = signal<ReadonlySet<string>>(new Set());
  /** The client to move the ticked items to; '' until one is chosen. */
  moveTo = signal('');
  moving = signal(false);
  moveMessage = signal('');
  moveError = signal('');

  readonly hours = hours;
  readonly presets = RANGE_PRESETS;

  constructor() {
    this.categoriesSub = inject(TaskCategoryService).getCategories().subscribe((list) => this.categories.set(list));
    this.loadDays();
  }

  ngOnDestroy(): void {
    this.categoriesSub?.unsubscribe();
    this.daysSub?.unsubscribe();
    this.itemsSub?.unsubscribe();
  }

  /** Why the chosen dates cannot be shown, or null when they can. */
  rangeError = computed<string | null>(() => {
    const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!isDay(this.rangeStart()) || !isDay(this.rangeEnd())) return 'Choose a start date and an end date.';
    if (this.rangeStart() > this.rangeEnd()) return 'The start date is after the end date.';
    return null;
  });

  private loadDays(): void {
    this.daysSub?.unsubscribe();
    this.daysSub = null;
    this.loaded.set(false);
    this.days.set([]);
    if (this.rangeError()) return;
    this.daysSub = this.journal.getDays(this.rangeStart(), this.rangeEnd()).subscribe((days) => {
      this.days.set(days);
      this.loaded.set(true);
    });
  }

  setRange(start: string, end: string): void {
    if (start === this.rangeStart() && end === this.rangeEnd()) return;
    this.rangeStart.set(start ?? '');
    this.rangeEnd.set(end ?? '');
    this.selection.set(null);
    this.loadDays();
  }

  applyPreset(preset: RangePreset): void {
    const { start, end } = presetRange(preset, this.today);
    this.setRange(start, end);
  }

  isPreset(preset: RangePreset): boolean {
    const { start, end } = presetRange(preset, this.today);
    return start === this.rangeStart() && end === this.rangeEnd();
  }

  /** Choose one client, or every client with '' or null. */
  setClient(client: string | null): void {
    this.clientFilter.set(client || null);
    this.selection.set(null);
  }

  /** The clients the filter offers: the task categories, then any other client with work in the chosen dates. */
  clientOptions = computed(() => {
    const options = [...this.categories()];
    for (const day of this.days()) {
      for (const c of day.clients) {
        if (!options.some((o) => o.key === c.client)) options.push({ key: c.client, label: c.label });
      }
    }
    return options;
  });

  /** The chosen client's name, or null for all clients. */
  clientFilterLabel = computed(() => {
    const key = this.clientFilter();
    return key ? this.clientOptions().find((o) => o.key === key)?.label ?? key : null;
  });

  /** The days shown: with a client chosen, only that client's days, each with that client's time only. */
  shownDays = computed<JournalDay[]>(() => {
    const client = this.clientFilter();
    if (!client) return this.days();
    return this.days().flatMap((d) => {
      const c = d.clients.find((x) => x.client === client);
      return c ? [{ ...d, totalMinutes: c.minutes, itemCount: c.itemCount, clients: [c] }] : [];
    });
  });

  /** The time across the chosen dates, counting overlapping work once a day. */
  rangeTotals = computed<RangeTotals>(() => {
    const totals: RangeTotals = { totalMinutes: 0, itemCount: 0, clients: [] };
    for (const day of this.shownDays()) {
      totals.totalMinutes += day.totalMinutes;
      totals.itemCount += day.itemCount;
      for (const c of day.clients) {
        const total = totals.clients.find((x) => x.client === c.client);
        if (total) total.minutes += c.minutes;
        else totals.clients.push({ client: c.client, label: c.label, minutes: c.minutes });
      }
    }
    totals.clients.sort((a, b) => b.minutes - a.minutes);
    return totals;
  });

  /** The days shown, by week, newest first, with each week's time per client. */
  weeks = computed<JournalWeek[]>(() => {
    const weeks = new Map<string, JournalWeek>();
    for (const day of [...this.shownDays()].sort((a, b) => b.day.localeCompare(a.day))) {
      const start = weekStart(day.day);
      const week = weeks.get(start) ?? { start, totalMinutes: 0, clients: [], days: [] };
      week.days.push(day);
      week.totalMinutes += day.totalMinutes;
      for (const c of day.clients) {
        const total = week.clients.find((x) => x.client === c.client);
        if (total) total.minutes += c.minutes;
        else week.clients.push({ client: c.client, label: c.label, minutes: c.minutes });
      }
      weeks.set(start, week);
    }
    for (const week of weeks.values()) week.clients.sort((a, b) => b.minutes - a.minutes);
    return [...weeks.values()];
  });

  /** The selected day's summary. */
  selectedDay = computed(() => {
    const s = this.selection();
    return s ? this.days().find((d) => d.day === s.day) ?? null : null;
  });

  /** The selected client's summary for that day, or null for every client. */
  selectedClient = computed(() => {
    const s = this.selection();
    return s?.client ? this.selectedDay()?.clients.find((c) => c.client === s.client) ?? null : null;
  });

  /**
   * The details. For one client, the items under each of its work sessions;
   * for the whole day, every item in time order.
   */
  groups = computed<ItemGroup[]>(() => {
    const s = this.selection();
    if (!s) return [];
    const items = this.dayItems().filter((i) => !s.client || i.client === s.client);
    const client = this.selectedClient();
    if (!client) return items.length ? [{ key: 'all', start: null, end: null, minutes: null, items }] : [];

    const groups: ItemGroup[] = client.sessions.map((session) => ({
      key: session.start, start: session.start, end: session.end, minutes: session.minutes, items: [],
    }));
    const other: JournalItem[] = [];
    for (const item of items) {
      const group = groups.find((g) => g.start! <= item.at && item.at <= g.end!);
      if (group) group.items.push(item);
      else other.push(item);
    }
    // An item collected after the summary was built still shows.
    if (other.length) groups.push({ key: 'other', start: null, end: null, minutes: null, items: other });
    return groups.filter((g) => g.items.length);
  });

  /** Every item shown in the details. */
  shownItems = computed<JournalItem[]>(() => this.groups().flatMap((g) => g.items));

  /** The ticked items that are still shown: one moved out of a client's day leaves it. */
  checkedIds = computed<string[]>(() =>
    this.shownItems().filter((i) => i.id && this.checked().has(i.id)).map((i) => i.id!));

  /** The clients the ticked items can move to: every task category but the one open. */
  moveTargets = computed(() => this.categories().filter((c) => c.key !== this.selection()?.client));

  isChecked(item: JournalItem): boolean {
    return !!item.id && this.checked().has(item.id);
  }

  allChecked(items: JournalItem[]): boolean {
    return items.length > 0 && items.every((i) => this.isChecked(i));
  }

  toggleItem(item: JournalItem): void {
    if (!item.id) return;
    const next = new Set(this.checked());
    if (!next.delete(item.id)) next.add(item.id);
    this.checked.set(next);
  }

  /** Tick every one of `items`, or untick them all when they are all ticked already. */
  toggleAll(items: JournalItem[]): void {
    const tick = !this.allChecked(items);
    const next = new Set(this.checked());
    for (const i of items) if (i.id) tick ? next.add(i.id) : next.delete(i.id);
    this.checked.set(next);
  }

  /**
   * Move the ticked items to the chosen client. When that empties the
   * client's day that is open, the whole day opens instead, so Jack sees where
   * the items went.
   */
  async moveChecked(): Promise<void> {
    const ids = this.checkedIds();
    const client = this.moveTo();
    const sel = this.selection();
    if (!ids.length || !client || !sel || this.moving()) return;
    const emptiesClient = !!sel.client && ids.length === this.shownItems().length;
    this.moving.set(true);
    this.moveMessage.set('');
    this.moveError.set('');
    const result = await this.journal.moveItems(ids, client);
    this.moving.set(false);
    if (!result.success) {
      this.moveError.set(result.error ?? 'The items could not be moved. Try again in a moment.');
      return;
    }
    if (emptiesClient) this.select(sel.day, null);
    this.checked.set(new Set());
    const label = result.label ?? this.categories().find((c) => c.key === client)?.label ?? client;
    this.moveMessage.set(`Moved ${ids.length} ${ids.length === 1 ? 'item' : 'items'} to ${label}.`);
  }

  select(day: string, client: string | null): void {
    const before = this.selection();
    this.selection.set({ day, client });
    this.checked.set(new Set());
    this.moveMessage.set('');
    this.moveError.set('');
    if (before?.day === day) return;
    this.dayItems.set([]);
    this.itemsSub?.unsubscribe();
    this.itemsSub = this.journal.getItems(day).subscribe((items) => this.dayItems.set(items));
  }

  isSelected(day: string, client: string | null): boolean {
    const s = this.selection();
    return !!s && s.day === day && s.client === client;
  }

  /** On a phone: back from the details to the list of days. */
  closeDetail(): void {
    this.selection.set(null);
  }

  /** "Tuesday, October 13". */
  dayLabel(day: string): string {
    return noon(day).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  }

  /** "October 1, 2026". */
  dateLabel(day: string): string {
    return noon(day).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  }

  /** "October 12". */
  weekLabel(start: string): string {
    return noon(start).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
  }

  /** "9:21 AM" in Eastern Time, the time zone the journal's days are counted in. */
  time(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', { timeZone: ET_ZONE, hour: 'numeric', minute: '2-digit' });
  }

  sourceLabel(source: JournalSource): string {
    return SOURCE_LABELS[source] ?? source;
  }

  clientLabel(client: string): string {
    return this.selectedDay()?.clients.find((c) => c.client === client)?.label ?? client;
  }
}
