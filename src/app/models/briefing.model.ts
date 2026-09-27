export interface Briefing {
  id?: string;
  date: string;
  dayOfWeek?: string;
  timeOfDay?: string;
  unbilledHours: number;
  unbilledAmount: number;
  weekHours: number;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
  calendarEvents?: BriefingCalendarEvent[];
  alerts: BriefingAlert[];
  narrativeSummary?: string | null;
  overdueTasks?: BriefingTask[];
  dueTodayTasks?: BriefingTask[];
  totalActiveTasks?: number;
  nextWeekEvents?: BriefingCalendarEvent[];
  calendarSyncAge?: number | null;
  createdAt: Date;
  /** Last time any fact on the briefing was refreshed. Moves on every sync change. */
  updatedAt?: Date;
  /** Last time the prose was regenerated. Moves only when narrativeSummary changes. */
  narrativeAt?: Date | null;
  lastChangeSummary?: BriefingChangeSummary | null;
}

/** What the calendar sync last saw change, as recorded on the live briefing. */
export interface BriefingChangeSummary {
  added: number;
  moved: number;
  updated: number;
  deleted: number;
  changes?: Array<{
    summary: string;
    kind: 'added' | 'moved' | 'updated' | 'deleted';
    startISO: string;
    calendarName: string;
  }>;
}

export interface BriefingCalendarEvent {
  summary: string;
  startTime: string;
  endTime: string;
  date?: string;
  location?: string | null;
}

export interface BriefingTask {
  title: string;
  category: string;
  dueDate: string;
}

export interface BriefingAlert {
  type: string;
  message: string;
}

/** `briefings/headlines` — written by the headlinesBriefing function. */
export interface Headlines {
  date?: string;
  sections?: HeadlineSection[];
  generatedAt?: Date | null;
  lastError?: string | null;
}

export interface HeadlineSection {
  key: string;
  title: string;
  items: HeadlineItem[];
}

export interface HeadlineItem {
  headline: string;
  summary: string;
  whyItMatters: string;
  sourceName: string;
  url: string;
  publishedAt: string | null;
}
