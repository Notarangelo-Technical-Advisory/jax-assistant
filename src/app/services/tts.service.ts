import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class TtsService {
  private authService = inject(AuthService);

  speakingId = signal<string | null>(null);

  private videoEl: HTMLVideoElement | null = null;
  private cache = new Map<string, Blob>();
  private sentences: string[] = [];
  private currentIndex = 0;
  private abortController: AbortController | null = null;
  private prefetchAhead = 2;
  private currentId: string | null = null;
  private currentVoice = 'female-american';
  private blobUrls: string[] = [];

  primeAudioContext(): void {
    if (!this.videoEl) {
      this.videoEl = document.createElement('video');
      this.videoEl.setAttribute('playsinline', '');
      this.videoEl.style.display = 'none';
      document.body.appendChild(this.videoEl);
    }
    // iOS audio unlock: play tiny silent data URL within user gesture
    this.videoEl.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwVHAAAAAAD/+1DEAAAB8AFeAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UMQfAADSAV+AAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
    this.videoEl.play().catch(() => {});
  }

  async speak(text: string, voice: string = 'female-american', id?: string): Promise<void> {
    this.stop();

    if (!text?.trim()) return;

    this.currentId = id || null;
    this.currentVoice = voice;
    this.speakingId.set(this.currentId);
    this.abortController = new AbortController();

    // Strip markdown before TTS
    const clean = this.stripMarkdown(text);
    this.sentences = this.splitSentences(clean);
    this.currentIndex = 0;

    // Prefetch first sentences
    const prefetchCount = Math.min(this.prefetchAhead, this.sentences.length);
    for (let i = 0; i < prefetchCount; i++) {
      this.fetchSentence(i);
    }

    this.playNext();
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;

    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.src = '';
    }

    this.blobUrls.forEach((url) => URL.revokeObjectURL(url));
    this.blobUrls = [];
    this.sentences = [];
    this.currentIndex = 0;
    this.speakingId.set(null);
    this.currentId = null;
  }

  private async fetchSentence(index: number): Promise<Blob | null> {
    if (index >= this.sentences.length) return null;

    const cacheKey = `${this.currentId}|${this.currentVoice}|${index}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    try {
      const token = await this.authService.getIdToken();
      const response = await fetch(
        'https://synthesizespeech-nxe253ex3a-uc.a.run.app',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            text: this.sentences[index],
            voice: this.currentVoice,
          }),
          signal: this.abortController?.signal,
        }
      );

      if (!response.ok) return null;

      const blob = await response.blob();
      this.cache.set(cacheKey, blob);
      return blob;
    } catch {
      return null;
    }
  }

  private async playNext(): Promise<void> {
    if (this.currentIndex >= this.sentences.length || !this.videoEl) {
      this.speakingId.set(null);
      this.currentId = null;
      return;
    }

    const blob = await this.fetchSentence(this.currentIndex);
    if (!blob) {
      this.currentIndex++;
      this.playNext();
      return;
    }

    // Prefetch next sentence
    const nextPrefetch = this.currentIndex + this.prefetchAhead;
    if (nextPrefetch < this.sentences.length) {
      this.fetchSentence(nextPrefetch);
    }

    const url = URL.createObjectURL(blob);
    this.blobUrls.push(url);
    this.videoEl.src = url;

    this.videoEl.onended = () => {
      this.currentIndex++;
      this.playNext();
    };

    this.videoEl.play().catch(() => {
      this.currentIndex++;
      this.playNext();
    });
  }

  private splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/^#{1,6}\s+/gm, '')           // headings
      .replace(/\*\*(.+?)\*\*/g, '$1')        // bold
      .replace(/\*(.+?)\*/g, '$1')            // italic
      .replace(/`{1,3}[^`]*`{1,3}/g, '')      // code
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')     // links
      .replace(/^>\s+/gm, '')                 // blockquotes
      .replace(/^[-*+]\s+/gm, '')             // list items
      .replace(/^\d+\.\s+/gm, '')             // numbered lists
      .trim();
  }
}
