import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc,
  addDoc, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Task } from '../models/task.model';

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

  async addTask(title: string, category: string = 'general', dueDate?: string): Promise<void> {
    await addDoc(this.collectionRef, {
      title,
      category,
      completed: false,
      dueDate: dueDate || null,
      createdAt: serverTimestamp(),
    });
  }

  async completeTask(taskId: string): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    await updateDoc(ref, {
      completed: true,
      completedAt: serverTimestamp(),
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    const ref = doc(this.firestore, 'tasks', taskId);
    await deleteDoc(ref);
  }
}
