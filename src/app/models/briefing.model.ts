export interface Briefing {
  id?: string;
  date: string;
  unbilledHours: number;
  unbilledAmount: number;
  weekHours: number;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
  calendarEvents?: BriefingCalendarEvent[];
  alerts: BriefingAlert[];
  createdAt: Date;
}

export interface BriefingCalendarEvent {
  summary: string;
  startTime: string;
  endTime: string;
  location?: string | null;
}

export interface BriefingAlert {
  type: string;
  message: string;
}
