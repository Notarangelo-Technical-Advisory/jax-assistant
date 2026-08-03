export interface CalendarEvent {
  id?: string;
  summary: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  notes?: string;
  calendarName: string;
  syncedAt: Date;
  /** Apple Calendar's stable identifier, which survives a reschedule. */
  uid?: string | null;
  recurring?: boolean;
  /** When this event last actually changed — not when it was last synced. */
  changedAt?: Date | null;
  /** What the last real change was, used to badge the row. */
  changeKind?: 'added' | 'moved' | 'updated' | null;
}
