import { Component, OnDestroy, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { JournalService } from '../../services/journal.service';
import { JournalDay, JournalItem, JournalSource } from '../../models/journal.model';

const ET_ZONE = 'America/New_York';
const PAGE_DAYS = 14;

/** A day's key at noon UTC, so no time zone can move it to another date. */
const noon = (day: string): Date => new Date(`${day}T12:00:00Z`);

/** The Monday of the week a day falls in, as YYYY-MM-DD. */
export function weekStart(day: string): string {
  const d = noon(day);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
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

/** Items under one heading of the details: a work session, or the whole day. */
export interface ItemGroup {
  key: string;
  start: string | null;
  end: string | null;
  minutes: number | null;
  items: JournalItem[];
}

type Selection = { day: string; client: string | null } | null;

const SOURCE_LABELS: Record<JournalSource, string> = { github: 'GitHub', jira: 'Jira', claude: 'Claude Code', meeting: 'Calendar' };

@Component({
  selector: 'app-journal',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './journal.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './journal.component.scss',
})
export class JournalComponent implements OnDestroy {
  private journal = inject(JournalService);
  private daysSub: Subscription | null = null;
  private itemsSub: Subscription | null = null;

  days = signal<JournalDay[]>([]);
  loaded = signal(false);
  dayLimit = signal(PAGE_DAYS);
  selection = signal<Selection>(null);
  /** Every item of the selected day. */
  dayItems = signal<JournalItem[]>([]);

  readonly hours = hours;

  constructor() {
    this.loadDays();
  }

  ngOnDestroy(): void {
    this.daysSub?.unsubscribe();
    this.itemsSub?.unsubscribe();
  }

  private loadDays(): void {
    this.daysSub?.unsubscribe();
    this.daysSub = this.journal.getDays(this.dayLimit()).subscribe((days) => {
      this.days.set(days);
      this.loaded.set(true);
    });
  }

  /** True when there may be older days than the ones shown. */
  hasMore = computed(() => this.days().length >= this.dayLimit());

  showMore(): void {
    this.dayLimit.update((n) => n + PAGE_DAYS);
    this.loadDays();
  }

  /** The days shown, by week, newest first, with each week's time per client. */
  weeks = computed<JournalWeek[]>(() => {
    const weeks = new Map<string, JournalWeek>();
    for (const day of [...this.days()].sort((a, b) => b.day.localeCompare(a.day))) {
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

  select(day: string, client: string | null): void {
    const before = this.selection();
    this.selection.set({ day, client });
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
