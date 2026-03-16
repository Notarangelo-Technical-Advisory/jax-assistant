import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc,
  addDoc, updateDoc, deleteDoc, query, orderBy,
  serverTimestamp, getDocs, where, writeBatch,
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { ChatSession } from '../models/chat-session.model';

@Injectable({ providedIn: 'root' })
export class ChatSessionService {
  private firestore = inject(Firestore);
  private sessionsRef = collection(this.firestore, 'chatSessions');
  private messagesRef = collection(this.firestore, 'chatMessages');

  getSessions(): Observable<ChatSession[]> {
    const q = query(this.sessionsRef, orderBy('updatedAt', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<ChatSession[]>;
  }

  async createSession(title = 'New conversation'): Promise<string> {
    const ref = await addDoc(this.sessionsRef, {
      title,
      lastMessage: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await updateDoc(doc(this.firestore, 'chatSessions', sessionId), { title });
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Delete all messages for the session first
    const q = query(this.messagesRef, where('sessionId', '==', sessionId));
    const snap = await getDocs(q);
    const batch = writeBatch(this.firestore);
    snap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(this.firestore, 'chatSessions', sessionId));
    await batch.commit();
  }
}
