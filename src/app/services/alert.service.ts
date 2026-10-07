import { Injectable, inject } from '@angular/core';
import {
  collection, doc,
  updateDoc, query, orderBy, where
} from 'firebase/firestore';
import { collectionData } from 'rxfire/firestore';
import { Observable } from 'rxjs';
import { Alert } from '../models/alert.model';
import { FIRESTORE } from '../firebase';

@Injectable({ providedIn: 'root' })
export class AlertService {
  private firestore = inject(FIRESTORE);

  getActiveAlerts(): Observable<Alert[]> {
    const ref = collection(this.firestore, 'alerts');
    const q = query(
      ref,
      where('dismissed', '==', false),
      orderBy('createdAt', 'desc')
    );
    return collectionData(q, { idField: 'id' }) as Observable<Alert[]>;
  }

  async dismissAlert(alertId: string): Promise<void> {
    const ref = doc(this.firestore, 'alerts', alertId);
    await updateDoc(ref, { dismissed: true });
  }
}
