import { Injectable, inject } from '@angular/core';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { collectionData } from 'rxfire/firestore';
import { Observable } from 'rxjs';
import { JournalDay, JournalItem } from '../models/journal.model';
import { FIRESTORE } from '../firebase';

/**
 * The work journal, read-only. The journal job on Jack's Mac writes it
 * (functions/src/mcp/collect-journal.ts); the security rules refuse writes
 * from the page.
 */
@Injectable({ providedIn: 'root' })
export class JournalService {
  private firestore = inject(FIRESTORE);
  private daysRef = collection(this.firestore, 'journalDays');
  private itemsRef = collection(this.firestore, 'journal');

  /** The days from `start` to `end` (YYYY-MM-DD, both included) that have any work, newest first. */
  getDays(start: string, end: string): Observable<JournalDay[]> {
    const q = query(this.daysRef, where('day', '>=', start), where('day', '<=', end), orderBy('day', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<JournalDay[]>;
  }

  /** Every item of one day, in time order. */
  getItems(day: string): Observable<JournalItem[]> {
    const q = query(this.itemsRef, where('day', '==', day), orderBy('at'));
    return collectionData(q, { idField: 'id' }) as Observable<JournalItem[]>;
  }
}
