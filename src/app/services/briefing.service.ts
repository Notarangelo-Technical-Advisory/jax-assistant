import { Injectable, inject } from '@angular/core';
import { Firestore, doc, docData } from '@angular/fire/firestore';
import { HttpClient } from '@angular/common/http';
import { Observable, map, firstValueFrom } from 'rxjs';
import { Briefing } from '../models/briefing.model';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class BriefingService {
  private firestore = inject(Firestore);
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  /**
   * The live briefing.
   *
   * `briefings/live` is rewritten whenever the calendar changes or the facts
   * heartbeat runs, so this is always current. It used to be an
   * orderBy(createdAt).limit(1) query over the whole collection, which returned
   * whichever dated snapshot happened to be newest — and those are now an
   * archive that only the 7am/1pm runs write.
   */
  getLatestBriefing(): Observable<Briefing | null> {
    const ref = doc(this.firestore, 'briefings', 'live');
    return docData(ref, { idField: 'id' }).pipe(
      map((d) => (d ? (d as Briefing) : null))
    );
  }

  async triggerRefresh(): Promise<void> {
    const token = await this.authService.getIdToken();
    await firstValueFrom(
      this.http.post(
        'https://refreshbriefing-nxe253ex3a-uc.a.run.app',
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      )
    );
  }
}
