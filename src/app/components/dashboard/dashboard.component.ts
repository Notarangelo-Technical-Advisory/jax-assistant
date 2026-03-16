import { Component, inject, signal, effect, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { BriefingService } from '../../services/briefing.service';
import { TaskService } from '../../services/task.service';
import { AlertService } from '../../services/alert.service';
import { ChatService } from '../../services/chat.service';
import { ChatSessionService } from '../../services/chat-session.service';
import { TtsService } from '../../services/tts.service';
import { SttService } from '../../services/stt.service';
import { Briefing } from '../../models/briefing.model';
import { Task } from '../../models/task.model';
import { Alert } from '../../models/alert.model';
import { ChatSession } from '../../models/chat-session.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  authService = inject(AuthService);
  private briefingService = inject(BriefingService);
  taskService = inject(TaskService);
  alertService = inject(AlertService);
  chatService = inject(ChatService);
  chatSessionService = inject(ChatSessionService);
  ttsService = inject(TtsService);
  sttService = inject(SttService);

  briefing = signal<Briefing | null>(null);
  tasks = signal<Task[]>([]);
  alerts = signal<Alert[]>([]);
  sessions = signal<ChatSession[]>([]);
  activeSession = signal<ChatSession | null>(null);
  sessionsOpen = signal(false);

  renamingSessionId: string | null = null;
  renameValue = '';

  chatInput = '';
  newTaskTitle = '';
  newTaskCategory: Task['category'] = 'general';
  newTaskDueDate = '';
  voice = localStorage.getItem('maisie-voice') || 'female-british';
  greetingPlaying = signal(false);

  expandedCategories = signal<Set<string>>(new Set(['ihrdc', 'solomon', 'dial', 'ppk', 'church', 'general']));

  readonly categoryLabels: Record<string, string> = {
    ihrdc: 'IHRDC',
    solomon: 'Solomon',
    dial: 'DIAL',
    ppk: 'PPK',
    church: 'Church',
    general: 'General',
  };

  readonly categoryOrder: string[] = ['ihrdc', 'solomon', 'dial', 'ppk', 'church', 'general'];

  groupedTasks = computed(() => {
    const all = this.tasks();
    const groups: { category: string; label: string; tasks: Task[] }[] = [];
    for (const cat of this.categoryOrder) {
      const catTasks = all.filter((t) => t.category === cat);
      if (catTasks.length > 0) {
        groups.push({ category: cat, label: this.categoryLabels[cat], tasks: catTasks });
      }
    }
    return groups;
  });

  conversationMode = signal(false);
  private wasSpeaking = false;
  private greetingAudio: HTMLAudioElement | null = null;
  private subs: Subscription[] = [];

  // When STT transcript updates, auto-send as chat
  private sttEffect = effect(() => {
    const transcript = this.sttService.transcript();
    if (transcript && !this.sttService.isListening()) {
      this.chatInput = transcript;
      this.sendChat();
    }
  });

  // After TTS finishes a response, auto-restart the mic in conversation mode
  private conversationEffect = effect(() => {
    const speakingId = this.ttsService.speakingId();
    const inConversation = this.conversationMode();

    if (speakingId !== null) {
      this.wasSpeaking = true;
    } else if (this.wasSpeaking && inConversation) {
      this.wasSpeaking = false;
      setTimeout(() => {
        if (this.conversationMode() && !this.chatService.loading() && !this.sttService.isListening()) {
          this.sttService.startListening();
        }
      }, 600);
    }
  });

  ngOnInit(): void {
    this.subs.push(
      this.briefingService.getLatestBriefing().subscribe((b) => this.briefing.set(b)),
      this.taskService.getActiveTasks().subscribe((t) => this.tasks.set(t)),
      this.alertService.getActiveAlerts().subscribe((a) => this.alerts.set(a)),
      this.chatSessionService.getSessions().subscribe((s) => {
        this.sessions.set(s);
        // Auto-select the most recent session on first load
        if (!this.activeSession() && s.length > 0) {
          this.selectSession(s[0]);
        }
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.ttsService.stop();
    this.chatService.stopWatching();
  }

  // ── Session management ─────────────────────────────────────

  selectSession(session: ChatSession): void {
    this.activeSession.set(session);
    this.sessionsOpen.set(false);
    this.chatService.watchSession(session.id!);
  }

  async newSession(): Promise<void> {
    const id = await this.chatSessionService.createSession('New conversation');
    // The sessions stream will update; find the new session and select it
    const newSession: ChatSession = {
      id,
      title: 'New conversation',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.activeSession.set(newSession);
    this.sessionsOpen.set(false);
    this.chatService.watchSession(id);
  }

  toggleSessions(): void {
    this.sessionsOpen.update((v) => !v);
  }

  startRenaming(session: ChatSession): void {
    this.renamingSessionId = session.id!;
    this.renameValue = session.title;
  }

  async saveRename(session: ChatSession): Promise<void> {
    const trimmed = this.renameValue.trim();
    if (trimmed && trimmed !== session.title) {
      await this.chatSessionService.renameSession(session.id!, trimmed);
      if (this.activeSession()?.id === session.id) {
        this.activeSession.update((s) => s ? { ...s, title: trimmed } : s);
      }
    }
    this.renamingSessionId = null;
  }

  cancelRename(): void {
    this.renamingSessionId = null;
  }

  async deleteSession(session: ChatSession, event: Event): Promise<void> {
    event.stopPropagation();
    await this.chatSessionService.deleteSession(session.id!);
    if (this.activeSession()?.id === session.id) {
      const remaining = this.sessions().filter((s) => s.id !== session.id);
      if (remaining.length > 0) {
        this.selectSession(remaining[0]);
      } else {
        this.activeSession.set(null);
        this.chatService.stopWatching();
      }
    }
  }

  // ── Chat ───────────────────────────────────────────────────

  async sendChat(): Promise<void> {
    const text = this.chatInput.trim();
    const session = this.activeSession();
    if (!text) return;
    if (!session?.id) {
      // Auto-create a session if none exists
      const id = await this.chatSessionService.createSession(
        text.length > 40 ? text.substring(0, 40) + '…' : text,
      );
      const newSession: ChatSession = { id, title: text.substring(0, 40), createdAt: new Date(), updatedAt: new Date() };
      this.activeSession.set(newSession);
      this.chatService.watchSession(id);
      this.chatInput = '';
      const response = await this.chatService.sendMessage(text, id);
      this.ttsService.primeAudioContext();
      this.ttsService.speak(response, this.voice, `chat-${Date.now()}`);
      return;
    }

    this.chatInput = '';
    const response = await this.chatService.sendMessage(text, session.id);
    this.ttsService.primeAudioContext();
    this.ttsService.speak(response, this.voice, `chat-${Date.now()}`);
  }

  // ── Conversation mode ──────────────────────────────────────

  startConversation(): void {
    if (this.conversationMode()) {
      this.stopConversation();
      return;
    }

    this.conversationMode.set(true);
    this.ttsService.primeAudioContext();
    this.greetingPlaying.set(true);

    this.greetingAudio = new Audio('/greeting.mp3');
    const afterGreeting = () => {
      this.greetingPlaying.set(false);
      if (this.sttService.isSupported && this.conversationMode()) {
        this.sttService.startListening();
      }
    };
    this.greetingAudio.onended = afterGreeting;
    this.greetingAudio.onerror = afterGreeting;
    this.greetingAudio.play().catch(afterGreeting);
  }

  stopConversation(): void {
    this.conversationMode.set(false);
    this.wasSpeaking = false;
    this.sttService.stopListening();
    this.ttsService.stop();
  }

  toggleMic(): void {
    if (this.sttService.isListening()) {
      this.sttService.stopListening();
    } else {
      this.ttsService.primeAudioContext();
      this.sttService.startListening();
    }
  }

  speakBriefing(): void {
    const b = this.briefing();
    if (!b) return;

    const text = `Good morning. You have ${b.unbilledHours} unbilled hours, worth $${b.unbilledAmount}. This week you've logged ${b.weekHours} hours. ${b.alerts.map((a) => a.message).join('. ')}`;
    this.ttsService.primeAudioContext();
    this.ttsService.speak(text, this.voice, `briefing-${b.date}`);
  }

  stopSpeaking(): void {
    this.ttsService.stop();
  }

  // ── Tasks ──────────────────────────────────────────────────

  async addTask(): Promise<void> {
    if (!this.newTaskTitle.trim()) return;
    await this.taskService.addTask(
      this.newTaskTitle.trim(),
      this.newTaskCategory,
      this.newTaskDueDate || undefined,
    );
    this.newTaskTitle = '';
    this.newTaskDueDate = '';
  }

  isOverdue(dueDate: string): boolean {
    return new Date(dueDate + 'T23:59:59') < new Date();
  }

  isDueToday(dueDate: string): boolean {
    const today = new Date().toISOString().split('T')[0];
    return dueDate === today;
  }

  async completeTask(task: Task): Promise<void> {
    if (task.id) await this.taskService.completeTask(task.id);
  }

  async dismissAlert(alert: Alert): Promise<void> {
    if (alert.id) await this.alertService.dismissAlert(alert.id);
  }

  onVoiceChange(voice: string): void {
    localStorage.setItem('maisie-voice', voice);
  }

  toggleCategory(category: string): void {
    const current = this.expandedCategories();
    const next = new Set(current);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    this.expandedCategories.set(next);
  }

  isCategoryExpanded(category: string): boolean {
    return this.expandedCategories().has(category);
  }

  formatSessionDate(session: ChatSession): string {
    const d = (session.updatedAt as any)?.toDate
      ? (session.updatedAt as any).toDate()
      : new Date(session.updatedAt);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  logout(): void {
    this.authService.logout();
  }
}
