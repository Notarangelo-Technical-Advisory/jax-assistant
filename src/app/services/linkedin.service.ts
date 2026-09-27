import { Injectable, inject } from '@angular/core';
import { Firestore, doc, docData } from '@angular/fire/firestore';
import { HttpClient } from '@angular/common/http';
import { Observable, map, firstValueFrom } from 'rxjs';
import { LinkedInWeek } from '../models/linkedin.model';
import { AuthService } from './auth.service';

export type LinkedInAction = 'refresh' | 'approve' | 'posted' | 'draft';

@Injectable({ providedIn: 'root' })
export class LinkedInService {
  private firestore = inject(Firestore);
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  /** The coming Tuesday's post. The queue itself lives in GitHub. */
  getWeek(): Observable<LinkedInWeek | null> {
    return docData(doc(this.firestore, 'linkedin', 'week')).pipe(
      map((d) => (d ? (d as LinkedInWeek) : null))
    );
  }

  /**
   * Approve, mark posted, draft or refresh. The function re-reads the queue in
   * GitHub and enforces the rules, so a refused action comes back as an error
   * with the reason.
   */
  async act(action: LinkedInAction, date?: string, extra: { url?: string; instructions?: string } = {}): Promise<void> {
    const token = await this.authService.getIdToken();
    await firstValueFrom(
      this.http.post(
        'https://linkedinaction-nxe253ex3a-uc.a.run.app',
        { action, date, ...extra },
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
  }
}
