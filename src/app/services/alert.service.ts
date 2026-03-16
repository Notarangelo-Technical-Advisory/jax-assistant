import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc,
  updateDoc, query, orderBy, where
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Alert } from '../models/alert.model';

@Injectable({ providedIn: 'root' })
export class AlertService {
  private firestore = inject(Firestore);

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
