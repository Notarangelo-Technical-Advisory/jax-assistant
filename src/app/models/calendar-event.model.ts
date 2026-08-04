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
  /**
   * All-day event. startTime is local midnight and the clock times carry no
   * meaning — render it as "all day", not as a midnight appointment.
   */
  allDay?: boolean;
  /** When this event last actually changed — not when it was last synced. */
  changedAt?: Date | null;
  /** What the last real change was, used to badge the row. */
  changeKind?: 'added' | 'moved' | 'updated' | null;
}
