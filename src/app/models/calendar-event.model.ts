export interface CalendarEvent {
  id?: string;
  summary: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  notes?: string;
  calendarName: string;
  syncedAt: Date;
}
