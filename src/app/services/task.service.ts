import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc,
  addDoc, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp, getDoc
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Task, TaskRecurrence } from '../models/task.model';

function getNextOccurrence(recurrence: TaskRecurrence, fromDate: Date): string {
  const next = new Date(fromDate);
  next.setHours(0, 0, 0, 0);

  if (recurrence.type === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurrence.type === 'weekly' && recurrence.dayOfWeek !== undefined) {
    const currentDay = next.getDay();
    let daysUntil = recurrence.dayOfWeek - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    next.setDate(next.getDate() + daysUntil);
  } else if (recurrence.type === 'monthly' && recurrence.dayOfMonth !== undefined) {
    const target = recurrence.dayOfMonth;
    if (target > next.getDate()) {
      next.setDate(target);
    } else {
      next.setMonth(next.getMonth() + 1);
      next.setDate(target);
    }
  }

  return next.toISOString().split('T')[0];
}

@Injectable({ providedIn: 'root' })
export class TaskService {
  private firestore = inject(Firestore);
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

  async updateTask(
    taskId: string,
    updates: Partial<Pick<Task, 'title' | 'dueDate' | 'category' | 'recurrence'>>,
  ): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateDoc(ref, updates as any);
  }

  async completeTask(taskId: string): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    const snap = await getDoc(ref);
    const data = snap.data() as Task | undefined;

    if (data?.recurrence) {
      // Recurring task: advance due date to next occurrence instead of completing
      const nextDue = getNextOccurrence(data.recurrence, new Date());
      await updateDoc(ref, { dueDate: nextDue });
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
