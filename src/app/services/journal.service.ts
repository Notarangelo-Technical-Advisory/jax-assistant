import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { collectionData } from 'rxfire/firestore';
import { Observable, firstValueFrom } from 'rxjs';
import { JournalDay, JournalItem } from '../models/journal.model';
import { FIRESTORE } from '../firebase';
import { AuthService } from './auth.service';

export interface MoveResult {
  success: boolean;
  moved?: number;
  /** The client's name, such as "IHRDC". */
  label?: string;
  error?: string;
}

const URL = 'https://journalitems-nxe253ex3a-uc.a.run.app';
const RETRY_DELAY_MS = 1500;

/**
 * The work journal. The journal job on Jack's Mac writes it
 * (functions/src/mcp/collect-journal.ts); the security rules refuse writes
 * from the page. Moving items to another client goes through the
 * journalItems Cloud Function, which also rebuilds their days.
 */
@Injectable({ providedIn: 'root' })
export class JournalService {
  private firestore = inject(FIRESTORE);
  private http = inject(HttpClient);
  private auth = inject(AuthService);
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

  /**
   * Move items to another client. Tried a second time when the function could
   * not be reached, because a new or idle Cloud Function can fail its first
   * request; moving the same items twice changes nothing.
   */
  async moveItems(ids: string[], client: string): Promise<MoveResult> {
    const token = await this.auth.getIdToken();
    const send = () => firstValueFrom(
      this.http.post<MoveResult>(URL, { action: 'move', ids, client }, { headers: { Authorization: `Bearer ${token}` } })
    );
    try {
      return await send();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        return await send();
      } catch {
        return { success: false, error: 'Could not reach Maisie to move the items. Try again in a moment.' };
      }
    }
  }
}
