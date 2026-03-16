import { Injectable, signal } from '@angular/core';

// Web Speech API types (not fully typed in all TS versions)
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

@Injectable({ providedIn: 'root' })
export class SttService {
  transcript = signal('');
  isListening = signal(false);

  private recognition: SpeechRecognitionInstance | null = null;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    const SpeechRecognitionCtor = win['SpeechRecognition'] || win['webkitSpeechRecognition'];

    if (SpeechRecognitionCtor) {
      this.recognition = new (SpeechRecognitionCtor as new () => SpeechRecognitionInstance)();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript) {
          this.transcript.set(finalTranscript);
        }
      };

      this.recognition.onend = () => {
        this.isListening.set(false);
      };

      this.recognition.onerror = () => {
        this.isListening.set(false);
      };
    }
  }

  get isSupported(): boolean {
    return this.recognition !== null;
  }

  startListening(): void {
    if (!this.recognition) return;
    this.transcript.set('');
    this.isListening.set(true);
    this.recognition.start();
  }

  stopListening(): void {
    if (!this.recognition) return;
    this.recognition.stop();
    this.isListening.set(false);
  }
}
