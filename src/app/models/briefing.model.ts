export interface Briefing {
  id?: string;
  date: string;
  unbilledHours: number;
  unbilledAmount: number;
  weekHours: number;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
  alerts: BriefingAlert[];
  createdAt: Date;
}

export interface BriefingAlert {
  type: string;
  message: string;
}
