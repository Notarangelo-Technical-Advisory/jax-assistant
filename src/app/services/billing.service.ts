import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';
import { firstValueFrom } from 'rxjs';

export interface BillingSummary {
  totalHours: number;
  totalAmount: number;
  entryCount: number;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
}

@Injectable({ providedIn: 'root' })
export class BillingService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  async getSummary(): Promise<BillingSummary> {
    const token = await this.authService.getIdToken();
    const data = await firstValueFrom(
      this.http.get<{
        totalHours: number;
        totalAmount: number;
        entryCount: number;
        lastInvoice: { issueDate: string; total: number } | null;
      }>(
        'https://getunbilledsummary-nxe253ex3a-uc.a.run.app',
        { headers: { Authorization: `Bearer ${token}` } },
      )
    );
    return {
      totalHours: data.totalHours,
      totalAmount: data.totalAmount,
      entryCount: data.entryCount,
      lastInvoiceDate: data.lastInvoice?.issueDate ?? null,
      lastInvoiceAmount: data.lastInvoice?.total ?? null,
    };
  }
}
