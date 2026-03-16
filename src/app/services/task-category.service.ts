import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, addDoc,
  query, orderBy, serverTimestamp, getDocs
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { TaskCategory } from '../models/task-category.model';

@Injectable({ providedIn: 'root' })
export class TaskCategoryService {
  private firestore = inject(Firestore);
  private collectionRef = collection(this.firestore, 'taskCategories');

  /** Built-in categories that always appear (in order) regardless of Firestore contents. */
  readonly defaultCategories: TaskCategory[] = [
    { key: 'ihrdc',   label: 'IHRDC',   order: 0 },
    { key: 'solomon', label: 'Solomon', order: 1 },
    { key: 'dial',    label: 'DIAL',    order: 2 },
    { key: 'ppk',     label: 'PPK',     order: 3 },
    { key: 'church',  label: 'Church',  order: 4 },
    { key: 'general', label: 'General', order: 5 },
  ];

  /**
   * Returns the full ordered category list: built-in defaults first,
   * followed by any custom categories stored in Firestore.
   */
  getCategories(): Observable<TaskCategory[]> {
    const q = query(this.collectionRef, orderBy('order', 'asc'));
    return (collectionData(q, { idField: 'id' }) as Observable<TaskCategory[]>).pipe(
      map((firestoreCats) => {
        const customCats = firestoreCats.filter(
          (c) => !this.defaultCategories.some((d) => d.key === c.key)
        );
        return [...this.defaultCategories, ...customCats];
      })
    );
  }

  /** Creates a new custom category in Firestore. Throws if the key already exists. */
  async addCategory(key: string, label: string): Promise<void> {
    const snapshot = await getDocs(query(this.collectionRef, orderBy('order', 'desc')));
    const isDefault = this.defaultCategories.some((d) => d.key === key);
    if (isDefault) {
      throw new Error(`Category key "${key}" already exists as a built-in category.`);
    }
    const existsInFirestore = snapshot.docs.some((d) => d.data()['key'] === key);
    if (existsInFirestore) {
      throw new Error(`Category key "${key}" already exists.`);
    }
    const existingOrders = snapshot.docs.map((d) => (d.data()['order'] as number) ?? 0);
    const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) + 1 : 100;
    await addDoc(this.collectionRef, {
      key,
      label,
      order: maxOrder,
      createdAt: serverTimestamp(),
    });
  }
}
