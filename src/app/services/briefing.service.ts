import { Injectable, inject } from '@angular/core';
import { Firestore, collection, query, orderBy, limit, collectionData } from '@angular/fire/firestore';
import { Observable, map } from 'rxjs';
import { Briefing } from '../models/briefing.model';

@Injectable({ providedIn: 'root' })
export class BriefingService {
  private firestore = inject(Firestore);

  getLatestBriefing(): Observable<Briefing | null> {
    const ref = collection(this.firestore, 'briefings');
    const q = query(ref, orderBy('createdAt', 'desc'), limit(1));
    return collectionData(q, { idField: 'id' }).pipe(
      map((docs) => docs.length > 0 ? docs[0] as Briefing : null)
    );
  }
}
