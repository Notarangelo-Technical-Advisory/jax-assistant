import { TestBed } from '@angular/core/testing';
import { ChatSessionService } from './chat-session.service';
import { ChatSession } from '../models/chat-session.model';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, listDocuments, provideEmulator, seedDocument, signInAsJack, waitFor, watch
} from '../../testing/emulator-testing';

describe('ChatSessionService', () => {
  let emulator: EmulatorApp;
  let service: ChatSessionService;
  let sessions: ReturnType<typeof watch<ChatSession[]>>;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await signInAsJack(emulator);
    TestBed.configureTestingModule({ providers: provideEmulator(emulator) });
    service = TestBed.inject(ChatSessionService);
    sessions = watch(service.getSessions());
  });

  afterEach(async () => {
    sessions.stop();
    await emulator.dispose();
  });

  const titles = (): string[] => (sessions.latest() ?? []).map((s) => s.title);

  it('lists conversations with the most recently used first', async () => {
    await service.createSession('Monday planning');
    await service.createSession();
    await waitFor(() => (sessions.latest() ?? []).filter((s) => s.updatedAt).length === 2);

    expect(titles()).toEqual(['New conversation', 'Monday planning']);
    expect(sessions.latest()![0].lastMessage).toBe('');
  });

  it('renames a conversation', async () => {
    const id = await service.createSession();
    await service.renameSession(id, 'Invoice questions');
    await waitFor(() => titles()[0] === 'Invoice questions');
    expect(titles()).toEqual(['Invoice questions']);
  });

  it('deletes a conversation with its messages, and leaves other conversations alone', async () => {
    const doomed = await service.createSession('Doomed');
    const kept = await service.createSession('Kept');
    // Messages are written by the chat Cloud Function, never by the browser.
    await seedDocument('chatMessages/m1', { sessionId: doomed, role: 'user', content: 'Hello', sequence: 1 });
    await seedDocument('chatMessages/m2', { sessionId: doomed, role: 'assistant', content: 'Hi Jack', sequence: 2 });
    await seedDocument('chatMessages/m3', { sessionId: kept, role: 'user', content: 'Keep me', sequence: 1 });

    await service.deleteSession(doomed);
    await waitFor(() => titles().length === 1);

    expect(titles()).toEqual(['Kept']);
    expect((await listDocuments('chatMessages')).map((m) => m['id'])).toEqual(['m3']);
  });
});
