import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

const DB_NAME = 'tts-audio-cache';
const DB_VERSION = 1;
const STORE_NAME = 'audio-blobs';
const MAX_ENTRIES = 200; // prune oldest entries beyond this count

@Injectable({ providedIn: 'root' })
export class TtsService {
  private authService = inject(AuthService);

  speakingId = signal<string | null>(null);

  private videoEl: HTMLVideoElement | null = null;
  private memCache = new Map<string, Blob>();
  private sentences: string[] = [];
  private currentIndex = 0;
  private abortController: AbortController | null = null;
  private prefetchAhead = 2;
  private currentId: string | null = null;
  private currentVoice = 'female-american';
  private blobUrls: string[] = [];
  private db: IDBDatabase | null = null;

  /**
   * Bumped by every stop() (and therefore every speak(), which stops first).
   *
   * Playback is a chain of async steps that all share one <video> element and
   * one currentIndex. Aborting a fetch does not unwind the step awaiting it —
   * it resolves null and the chain marches on. So a chain started by an earlier
   * speak() would wake up inside the *new* utterance, bump currentIndex past
   * sentence 0, and swap videoEl.src out from under the audio already playing.
   * Each step carries the generation it started in and bails if it is stale.
   */
  private generation = 0;

  /**
   * Synthesis requests still in flight, keyed by generation + sentence. The
   * initial prefetch and playNext() both ask for sentence 0; without this they
   * each issue their own ElevenLabs call for identical text.
   */
  private inFlight = new Map<string, Promise<Blob | null>>();

  constructor() {
    this.openDb();
  }

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

    const gen = this.generation; // stop() just bumped it — this chain owns it
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
      this.fetchSentence(i, gen);
    }

    this.playNext(gen);
  }

  stop(): void {
    this.generation++;
    this.inFlight.clear();
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

  private openDb(): void {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = (e) => {
        this.db = (e.target as IDBOpenDBRequest).result;
      };

      request.onerror = () => {
        // IndexedDB unavailable; fall back to memory-only cache
      };
    } catch {
      // Private browsing or other restriction; ignore
    }
  }

  private dbGet(key: string): Promise<Blob | null> {
    if (!this.db) return Promise.resolve(null);
    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => resolve(null);
    });
  }

  private dbSet(key: string, blob: Blob): Promise<void> {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(blob, key);
      tx.oncomplete = () => {
        resolve();
        this.pruneDb();
      };
      tx.onerror = () => resolve();
    });
  }

  private pruneDb(): void {
    if (!this.db) return;
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const excess = countReq.result - MAX_ENTRIES;
      if (excess <= 0) return;
      // Delete the oldest `excess` entries via cursor
      const cursorReq = store.openCursor();
      let deleted = 0;
      cursorReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && deleted < excess) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
    };
  }

  private fetchSentence(index: number, gen: number): Promise<Blob | null> {
    if (index >= this.sentences.length) return Promise.resolve(null);

    const cacheKey = `${this.currentId}|${this.currentVoice}|${index}`;

    // 1. Check in-memory cache first (fastest)
    const cached = this.memCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    // 2. Join a request already in flight rather than starting a second one
    const flightKey = `${gen}|${cacheKey}`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;

    const request = this.loadSentence(index, cacheKey)
      .finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, request);
    return request;
  }

  /** Resolve one sentence's audio from IndexedDB, else synthesize it. */
  private async loadSentence(index: number, cacheKey: string): Promise<Blob | null> {
    // 1. Check IndexedDB (persists across page refreshes)
    const persisted = await this.dbGet(cacheKey);
    if (persisted) {
      this.memCache.set(cacheKey, persisted);
      return persisted;
    }

    // 2. Fetch from ElevenLabs via Cloud Function
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

      if (!response.ok) {
        console.error('[TtsService] synthesis failed, status:', response.status, 'sentence:', index);
        return null;
      }

      const blob = await response.blob();
      this.memCache.set(cacheKey, blob);
      this.dbSet(cacheKey, blob); // fire-and-forget persist
      return blob;
    } catch (err: any) {
      // An abort is a deliberate stop(), not a failure worth reporting.
      if (err?.name !== 'AbortError') {
        console.error('[TtsService] synthesis error, sentence:', index, err);
      }
      return null;
    }
  }

  private async playNext(gen: number): Promise<void> {
    if (gen !== this.generation) return;

    if (this.currentIndex >= this.sentences.length || !this.videoEl) {
      this.speakingId.set(null);
      this.currentId = null;
      return;
    }

    const index = this.currentIndex;
    const blob = await this.fetchSentence(index, gen);

    // A newer speak() took over while this sentence was being synthesized —
    // leave its currentIndex and its audio alone.
    if (gen !== this.generation) return;

    if (!blob) {
      this.currentIndex = index + 1;
      this.playNext(gen);
      return;
    }

    // Prefetch next sentence
    const nextPrefetch = index + this.prefetchAhead;
    if (nextPrefetch < this.sentences.length) {
      this.fetchSentence(nextPrefetch, gen);
    }

    const url = URL.createObjectURL(blob);
    this.blobUrls.push(url);
    this.videoEl.src = url;

    this.videoEl.onended = () => {
      if (gen !== this.generation) return;
      this.currentIndex = index + 1;
      this.playNext(gen);
    };

    this.videoEl.play().catch(() => {
      if (gen !== this.generation) return;
      this.currentIndex = index + 1;
      this.playNext(gen);
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
