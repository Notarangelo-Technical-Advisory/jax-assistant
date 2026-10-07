import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChatService } from './chat.service';
import { AuthService } from './auth.service';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, nextRequest, provideEmulator, seedDocument, signInAsJack, waitFor
} from '../../testing/emulator-testing';

// Messages and tool steps are written by the chat Cloud Function, so the tests
// seed them past the security rules and watch the service pick them up live.

const CHAT_URL = 'https://chat-nxe253ex3a-uc.a.run.app';

describe('ChatService', () => {
  let emulator: EmulatorApp;
  let service: ChatService;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    TestBed.configureTestingModule({
      providers: [...provideEmulator(emulator), provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ChatService);
  });

  afterEach(async () => {
    service.stopWatching();
    await emulator.dispose();
  });

  function message(id: string, fields: { sessionId: string; role: string; content: string; sequence?: number; createdAt?: Date }) {
    return seedDocument(`chatMessages/${id}`, { createdAt: new Date('2026-10-06T12:00:00Z'), ...fields });
  }

  const contents = (): string[] => service.messages().map((m) => m.content);

  it('shows a conversation in sequence order, with older messages that have no sequence last', async () => {
    await message('a', { sessionId: 's1', role: 'assistant', content: 'second', sequence: 2 });
    await message('b', { sessionId: 's1', role: 'user', content: 'first', sequence: 1 });
    await message('c', { sessionId: 's1', role: 'user', content: 'legacy', createdAt: new Date('2026-01-01T00:00:00Z') });
    await message('d', { sessionId: 's2', role: 'user', content: 'other conversation', sequence: 1 });

    service.watchSession('s1');
    await waitFor(() => service.messages().length === 3);

    expect(contents()).toEqual(['first', 'second', 'legacy']);
  });

  it('reports a new answer from MAISIE, but not the ones already on screen', async () => {
    await message('a', { sessionId: 's1', role: 'assistant', content: 'Earlier answer', sequence: 2 });
    service.watchSession('s1');
    await waitFor(() => service.messages().length === 1);
    expect(service.latestAssistantMessage()).toBeNull();

    await message('b', { sessionId: 's1', role: 'user', content: 'What is next?', sequence: 3 });
    await message('c', { sessionId: 's1', role: 'assistant', content: 'The IHRDC demo at 10.', sequence: 4 });

    await waitFor(() => service.latestAssistantMessage() !== null);
    expect(service.latestAssistantMessage()).toBe('The IHRDC demo at 10.');
  });

  it('shows the step MAISIE is working on, live', async () => {
    service.watchSession('s1');
    expect(service.thinkingStep()).toBeNull();

    await seedDocument('chatThinking/s1', { step: 'Reading the calendar...' });
    await waitFor(() => service.thinkingStep() !== null);
    expect(service.thinkingStep()).toBe('Reading the calendar...');
  });

  it('switching conversations shows only the new one, and stopping clears the screen', async () => {
    await message('a', { sessionId: 's1', role: 'user', content: 'in s1', sequence: 1 });
    await message('b', { sessionId: 's2', role: 'user', content: 'in s2', sequence: 1 });

    service.watchSession('s1');
    await waitFor(() => contents()[0] === 'in s1');
    service.watchSession('s2');
    await waitFor(() => contents()[0] === 'in s2');

    await message('c', { sessionId: 's1', role: 'user', content: 'late s1 message', sequence: 2 });
    await message('d', { sessionId: 's2', role: 'user', content: 'second s2 message', sequence: 2 });
    await waitFor(() => service.messages().length === 2);
    expect(contents()).toEqual(['in s2', 'second s2 message']);

    service.stopWatching();
    expect(service.messages()).toEqual([]);
    expect(service.thinkingStep()).toBeNull();
  });

  it('sends a message with Jack\'s sign-in token and returns the reply', async () => {
    const http = TestBed.inject(HttpTestingController);
    const auth = TestBed.inject(AuthService);
    await waitFor(() => auth.currentUser() !== null);

    const reply = service.sendMessage('What is on today?', 's1');
    const request = await nextRequest(http, CHAT_URL);
    expect(service.loading()).toBeTrue();
    expect(request.request.body).toEqual({ message: 'What is on today?', sessionId: 's1' });
    expect(request.request.headers.get('Authorization')).toMatch(/^Bearer .+/);
    request.flush({ response: 'Two meetings.' });

    expect(await reply).toBe('Two meetings.');
    expect(service.loading()).toBeFalse();
  });

  it('says so when the reply is empty, and stops loading when the request fails', async () => {
    const http = TestBed.inject(HttpTestingController);
    const auth = TestBed.inject(AuthService);
    await waitFor(() => auth.currentUser() !== null);

    const empty = service.sendMessage('Hello', 's1');
    (await nextRequest(http, CHAT_URL)).flush({});
    expect(await empty).toBe('No response received.');

    const failed = service.sendMessage('Hello', 's1');
    (await nextRequest(http, CHAT_URL)).flush('timeout', { status: 504, statusText: 'Gateway Timeout' });
    await expectAsync(failed).toBeRejected();
    expect(service.loading()).toBeFalse();
  });
});
