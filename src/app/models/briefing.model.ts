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
