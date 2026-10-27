import { Injectable, inject } from '@angular/core';
import {
  collection, doc,
  addDoc, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp, getDoc
} from 'firebase/firestore';
import { collectionData } from 'rxfire/firestore';
import { Observable } from 'rxjs';
import { Task, TaskRecurrence } from '../models/task.model';
import { FIRESTORE } from '../firebase';
import { nextDueDate } from './recurrence';

/**
 * Fields an inline task edit may change. `null` clears the field; leaving a key
 * off leaves the stored value alone. Firestore has no `undefined`, so the two
 * cases have to be distinct — see updateTask().
 */
export interface TaskUpdates {
  title?: string;
  category?: string;
  dueDate?: string | null;
  recurrence?: TaskRecurrence | null;
}

@Injectable({ providedIn: 'root' })
export class TaskService {
  private firestore = inject(FIRESTORE);
  private collectionRef = collection(this.firestore, 'tasks');

  getActiveTasks(): Observable<Task[]> {
    const q = query(
      this.collectionRef,
      where('completed', '==', false),
      orderBy('createdAt', 'desc')
    );
    return collectionData(q, { idField: 'id' }) as Observable<Task[]>;
  }

  async addTask(
    title: string,
    category: string = 'general',
    dueDate?: string,
    recurrence?: TaskRecurrence,
  ): Promise<void> {
    await addDoc(this.collectionRef, {
      title,
      category,
      completed: false,
      dueDate: dueDate || null,
      recurrence: recurrence || null,
      createdAt: serverTimestamp(),
    });
  }

  async updateTask(taskId: string, updates: TaskUpdates): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    // Firestore rejects `undefined` as a field value outright, and the inline
    // task editor sends it for every field the user left blank — so a plain
    // pass-through threw before writing anything, and the edit silently died.
    // Absent keys are dropped here; an explicit null is the "clear this field"
    // signal, which is what addTask() already writes.
    const fields = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(fields).length === 0) return;
    await updateDoc(ref, fields);
  }

  async completeTask(taskId: string): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    const snap = await getDoc(ref);
    const data = snap.data() as Task | undefined;

    const recurrence = data?.recurrence;
    if (recurrence && (recurrence.remaining === undefined || recurrence.remaining > 1)) {
      // A repeating task stays open with its next due date, until its last time.
      // Same rule as Maisie's complete_task tool (see recurrence.ts).
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const updates: Record<string, unknown> = { dueDate: nextDueDate(recurrence, data.dueDate, today) };
      if (recurrence.remaining !== undefined) updates['recurrence.remaining'] = recurrence.remaining - 1;
      await updateDoc(ref, updates);
    } else {
      await updateDoc(ref, {
        completed: true,
        completedAt: serverTimestamp(),
      });
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    await deleteDoc(ref);
  }
}
