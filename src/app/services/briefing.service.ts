import { Injectable, inject } from '@angular/core';
import { Firestore, collection, query, orderBy, limit, collectionData } from '@angular/fire/firestore';
import { HttpClient } from '@angular/common/http';
import { Observable, map, firstValueFrom } from 'rxjs';
import { Briefing } from '../models/briefing.model';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class BriefingService {
  private firestore = inject(Firestore);
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  getLatestBriefing(): Observable<Briefing | null> {
    const ref = collection(this.firestore, 'briefings');
    const q = query(ref, orderBy('createdAt', 'desc'), limit(1));
    return collectionData(q, { idField: 'id' }).pipe(
      map((docs) => docs.length > 0 ? docs[0] as Briefing : null)
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
