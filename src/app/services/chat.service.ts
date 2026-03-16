import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';
import { firstValueFrom } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  messages = signal<ChatMessage[]>([]);
  loading = signal(false);

  async sendMessage(text: string): Promise<string> {
    const token = await this.authService.getIdToken();

    this.messages.update((msgs) => [
      ...msgs,
      { role: 'user', content: text, timestamp: new Date() }
    ]);

    this.loading.set(true);

    try {
      const response = await firstValueFrom(
        this.http.post<{ response: string }>(
          'https://chat-r3e3oqky6a-uc.a.run.app',
          { message: text },
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );

      const assistantMessage = response?.response || 'No response received.';

      this.messages.update((msgs) => [
        ...msgs,
        { role: 'assistant', content: assistantMessage, timestamp: new Date() }
      ]);

      return assistantMessage;
    } finally {
      this.loading.set(false);
    }
  }

  clearMessages(): void {
    this.messages.set([]);
  }
}
