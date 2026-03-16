export interface Alert {
  id?: string;
  type: string;
  message: string;
  dismissed: boolean;
  briefingDate: string;
  createdAt: Date;
}
