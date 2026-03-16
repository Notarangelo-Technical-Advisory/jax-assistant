import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  Firestore, collection, query, where, orderBy, onSnapshot,
} from '@angular/fire/firestore';
import { AuthService } from './auth.service';
import { firstValueFrom } from 'rxjs';
import { ChatMessage } from '../models/chat-message.model';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private firestore = inject(Firestore);

  messages = signal<ChatMessage[]>([]);
  loading = signal(false);

  private unsubMessages: (() => void) | null = null;

  /** Subscribe to real-time messages for a session. */
  watchSession(sessionId: string): void {
    this.unsubMessages?.();
    this.messages.set([]);

    const q = query(
      collection(this.firestore, 'chatMessages'),
      where('sessionId', '==', sessionId),
      orderBy('sequence', 'asc'),
    );

    this.unsubMessages = onSnapshot(q,
      (snap) => {
        const msgs = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as ChatMessage))
          .sort((a, b) => {
            // Primary: sequence (integer) — deterministic ordering
            const aSeq = (a as any).sequence;
            const bSeq = (b as any).sequence;
            if (aSeq != null && bSeq != null) return aSeq - bSeq;
            if (aSeq != null) return -1;
            if (bSeq != null) return 1;
            // Fallback for legacy messages without sequence
            const aT = (a.createdAt as any)?.toMillis?.() ?? 0;
            const bT = (b.createdAt as any)?.toMillis?.() ?? 0;
            return aT - bT;
          });
        this.messages.set(msgs);
      },
      (err) => {
        console.error('[ChatService] watchSession error:', err);
      }
    );
  }

  stopWatching(): void {
    this.unsubMessages?.();
    this.unsubMessages = null;
    this.messages.set([]);
  }

  async sendMessage(text: string, sessionId: string): Promise<string> {
    const token = await this.authService.getIdToken();
    this.loading.set(true);

    try {
      const response = await firstValueFrom(
        this.http.post<{ response: string }>(
          'https://chat-nxe253ex3a-uc.a.run.app',
          { message: text, sessionId },
          { headers: { Authorization: `Bearer ${token}` } },
        )
      );
      return response?.response || 'No response received.';
    } finally {
      this.loading.set(false);
    }
  }
}
