import { Injectable, inject } from '@angular/core';
import { Firestore, collection, query, where, orderBy, collectionData, Timestamp } from '@angular/fire/firestore';
import { Observable, map } from 'rxjs';
import { CalendarEvent } from '../models/calendar-event.model';

@Injectable({ providedIn: 'root' })
export class CalendarService {
  private firestore = inject(Firestore);

  getTodayEvents(): Observable<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const ref = collection(this.firestore, 'calendarEvents');
    const q = query(
      ref,
      where('startTime', '>=', Timestamp.fromDate(startOfDay)),
      where('startTime', '<=', Timestamp.fromDate(endOfDay)),
      orderBy('startTime', 'asc'),
    );

    return collectionData(q, { idField: 'id' }).pipe(
      map((docs) => docs.map((d: any) => ({
        ...d,
        startTime: d.startTime?.toDate?.() ? d.startTime.toDate() : new Date(d.startTime),
        endTime: d.endTime?.toDate?.() ? d.endTime.toDate() : new Date(d.endTime),
        syncedAt: d.syncedAt?.toDate?.() ? d.syncedAt.toDate() : new Date(d.syncedAt),
      } as CalendarEvent)))
    );
  }
}
