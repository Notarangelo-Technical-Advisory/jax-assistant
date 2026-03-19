import { Component, inject, signal, effect, computed, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { marked } from 'marked';
import { AuthService } from '../../services/auth.service';
import { BriefingService } from '../../services/briefing.service';
import { BillingService, BillingSummary, BillingEntry } from '../../services/billing.service';
import { TaskService } from '../../services/task.service';
import { TaskCategoryService } from '../../services/task-category.service';
import { AlertService } from '../../services/alert.service';
import { ChatService } from '../../services/chat.service';
import { ChatSessionService } from '../../services/chat-session.service';
import { CalendarService } from '../../services/calendar.service';
import { TtsService } from '../../services/tts.service';
import { SttService } from '../../services/stt.service';
import { Briefing } from '../../models/briefing.model';
import { Task, TaskRecurrence } from '../../models/task.model';
import { TaskCategory } from '../../models/task-category.model';
import { Alert } from '../../models/alert.model';
import { ChatSession } from '../../models/chat-session.model';
import { CalendarEvent } from '../../models/calendar-event.model';

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
  private billingService = inject(BillingService);
  taskService = inject(TaskService);
  taskCategoryService = inject(TaskCategoryService);
  alertService = inject(AlertService);
  chatService = inject(ChatService);
  chatSessionService = inject(ChatSessionService);
  calendarService = inject(CalendarService);
  ttsService = inject(TtsService);
  sttService = inject(SttService);
  private sanitizer = inject(DomSanitizer);

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef;

  briefing = signal<Briefing | null>(null);
  billingSummary = signal<BillingSummary | null>(null);
  billingEntriesOpen = signal(false);
  calendarEvents = signal<CalendarEvent[]>([]);
  tasks = signal<Task[]>([]);
  categories = signal<TaskCategory[]>([]);
  alerts = signal<Alert[]>([]);
  sessions = signal<ChatSession[]>([]);
  activeSession = signal<ChatSession | null>(null);
  sessionsOpen = signal(false);
  inConversation = signal(false);
  chatOpen = signal(false);
  private audioContextPrimed = false;

  renamingSessionId: string | null = null;
  renameValue = '';

  editingTaskId: string | null = null;
  editingTaskTitle = '';
  editingTaskDueDate = '';
  editingTaskRecurrenceType = '';
  editingTaskRecurrenceDay: number | null = null;

  chatInput = '';
  newTaskTitle = '';
  newTaskCategory = 'general';
  newTaskDueDate = '';
  newTaskRecurrenceType = '';
  newTaskRecurrenceDay: number | null = null;
  voice = localStorage.getItem('maisie-voice') || 'female-british';
  ttsMuted = signal(localStorage.getItem('maisie-muted') === 'true');

  expandedCategories = signal<Set<string>>(new Set());
  refreshing = signal(false);

  groupedTasks = computed(() => {
    const all = this.tasks();
    const cats = this.categories();
    const knownKeys = new Set(cats.map((c) => c.key));
    const groups: { category: string; label: string; categoryId?: string; tasks: Task[] }[] = [];

    // Known categories in order
    for (const cat of cats) {
      const catTasks = all.filter((t) => t.category === cat.key);
      if (catTasks.length > 0) {
        groups.push({ category: cat.key, label: cat.label, categoryId: cat.id, tasks: catTasks });
      }
    }

    // Unknown categories (tasks with a category not in the loaded list)
    const unknownKeys = [...new Set(all.map((t) => t.category))].filter(
      (k) => !knownKeys.has(k)
    );
    for (const key of unknownKeys) {
      const catTasks = all.filter((t) => t.category === key);
      groups.push({ category: key, label: key, tasks: catTasks });
    }

    return groups;
  });

  groupedAndExpandedTasks = computed(() => {
    const groups = this.groupedTasks();
    const expanded = this.expandedCategories();
    return groups.map((g) => ({ ...g, expanded: expanded.has(g.category) }));
  });

  liveDueTodayTasks = computed(() => {
    const b = this.briefing();
    if (!b?.dueTodayTasks?.length) return [];
    const activeTitleSet = new Set(this.tasks().map((t) => t.title));
    return b.dueTodayTasks.filter((t) => activeTitleSet.has(t.title));
  });

  private subs: Subscription[] = [];

  // When STT transcript updates (mic stopped naturally), auto-send as chat
  private sttEffect = effect(() => {
    const transcript = this.sttService.transcript();
    if (transcript && !this.sttService.isListening()) {
      this.chatInput = transcript;
      this.sendChat();
    }
  });

  // Track whether the current sendMessage HTTP call is expected to deliver TTS.
  // Set to true before the HTTP call fires; cleared after TTS runs or on error.
  // Prevents double-speaking when Firestore listener also detects the same new message.
  private httpWillSpeak = false;

  // Speak new assistant messages that arrive via Firestore — covers long coding tasks
  // where the HTTP connection times out before the Cloud Function responds.
  private latestAssistantEffect = effect(() => {
    const msg = this.chatService.latestAssistantMessage();
    if (!msg) return;
    if (this.httpWillSpeak) return; // HTTP response will handle TTS — skip
    if (this.ttsMuted()) return;
    if (!this.audioContextPrimed) {
      this.ttsService.primeAudioContext();
      this.audioContextPrimed = true;
    }
    this.ttsService.speak(msg, this.voice, `chat-${Date.now()}`);
  });

  private billingLoaded = false;
  private billingEffect = effect(() => {
    // Wait for Firebase Auth to restore session before calling the authenticated endpoint
    if (!this.authService.loading() && this.authService.currentUser() && !this.billingLoaded) {
      this.billingLoaded = true;
      this.billingService.getSummary()
        .then((s) => this.billingSummary.set(s))
        .catch((err) => console.error('[billing] getSummary error:', err));
    }
  });

  private setupSubscriptions(): void {
    this.subs.push(
      this.briefingService.getLatestBriefing().subscribe((b) => this.briefing.set(b)),
      this.calendarService.getTodayEvents().subscribe((e) => this.calendarEvents.set(e)),
      this.taskService.getActiveTasks().subscribe((t) => this.tasks.set(t)),
      this.taskCategoryService.getCategories().subscribe((c) => this.categories.set(c)),
      this.alertService.getActiveAlerts().subscribe((a) => this.alerts.set(a)),
      this.chatSessionService.getSessions().subscribe((s) => {
        this.sessions.set(s);
        // Auto-select the most recent session on first load only.
        // Skip if activeSession is already set (including the __pending__ placeholder
        // used while a new session is being created).
        if (!this.activeSession() && s.length > 0) {
          this.selectSession(s[0]);
        }
      }),
    );
  }

  ngOnInit(): void {
    this.setupSubscriptions();
  }

  async refresh(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    try {
      this.subs.forEach((s) => s.unsubscribe());
      this.subs = [];
      this.setupSubscriptions();
      const summary = await this.billingService.getSummary();
      this.billingSummary.set(summary);
    } catch (err) {
      console.error('[refresh] error:', err);
    } finally {
      this.refreshing.set(false);
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.ttsService.stop();
    this.sttService.stopListening();
    this.chatService.stopWatching();
  }

  // ── Session management ─────────────────────────────────────

  selectSession(session: ChatSession): void {
    if (session.id === '__pending__') return;
    this.activeSession.set(session);
    this.sessionsOpen.set(false);
    this.chatService.watchSession(session.id!);
  }

  async newSession(): Promise<void> {
    // Stop watching and clear messages immediately.
    // Keep a non-null placeholder in activeSession so the getSessions() subscriber
    // guard (!this.activeSession()) doesn't fire and re-load the previous session.
    this.chatService.stopWatching();
    const placeholder: ChatSession = { id: '__pending__', title: 'New conversation', createdAt: new Date(), updatedAt: new Date() };
    this.activeSession.set(placeholder);
    this.sessionsOpen.set(false);
    const id = await this.chatSessionService.createSession('New conversation');
    const newSession: ChatSession = { id, title: 'New conversation', createdAt: new Date(), updatedAt: new Date() };
    this.activeSession.set(newSession);
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
    // Stop mic immediately when sending so it doesn't pick up Maisie's response
    this.sttService.stopListening();
    if (!session?.id) {
      // Auto-create a session if none exists
      this.chatService.stopWatching();
      const id = await this.chatSessionService.createSession(
        text.length > 40 ? text.substring(0, 40) + '…' : text,
      );
      const newSession: ChatSession = { id, title: text.substring(0, 40), createdAt: new Date(), updatedAt: new Date() };
      this.activeSession.set(newSession);
      this.chatService.watchSession(id);
      this.chatInput = '';
      setTimeout(() => this.scrollToBottom(), 0);
      try {
        this.httpWillSpeak = true;
        const response = await this.chatService.sendMessage(text, id);
        if (!this.ttsMuted()) {
          if (!this.audioContextPrimed) {
            this.ttsService.primeAudioContext();
            this.audioContextPrimed = true;
          }
          this.ttsService.speak(response, this.voice, `chat-${Date.now()}`);
        }
        setTimeout(() => this.scrollToBottom(), 0);
      } catch (err) {
        console.error('[sendChat] error:', err);
      } finally {
        this.httpWillSpeak = false;
      }
      return;
    }

    this.chatInput = '';
    setTimeout(() => this.scrollToBottom(), 0);
    try {
      this.httpWillSpeak = true;
      const response = await this.chatService.sendMessage(text, session.id);
      if (!this.ttsMuted()) {
        if (!this.audioContextPrimed) {
          this.ttsService.primeAudioContext();
          this.audioContextPrimed = true;
        }
        this.ttsService.speak(response, this.voice, `chat-${Date.now()}`);
      }
      setTimeout(() => this.scrollToBottom(), 0);
    } catch (err) {
      console.error('[sendChat] error:', err);
    } finally {
      this.httpWillSpeak = false;
    }
  }

  private scrollToBottom(): void {
    try {
      this.messagesContainer.nativeElement.scrollTop =
        this.messagesContainer.nativeElement.scrollHeight;
    } catch {}
  }

  // ── Voice conversation ────────────────────────────────────

  callMaisie(): void {
    if (!this.audioContextPrimed) {
      this.ttsService.primeAudioContext();
      this.audioContextPrimed = true;
    }
    this.ttsService.stop();
    this.chatOpen.set(true);
    this.inConversation.set(true);
    const greetingAudio = new Audio('/greeting.mp3');
    const startListening = () => this.sttService.startListening();
    greetingAudio.onended = startListening;
    greetingAudio.onerror = startListening;
    greetingAudio.play().catch(startListening);
  }

  endCall(): void {
    this.sttService.stopListening();
    this.ttsService.stop();
    this.inConversation.set(false);
    this.chatOpen.set(false);
  }

  openChat(): void {
    this.chatOpen.set(true);
  }

  toggleMic(): void {
    if (this.sttService.isListening()) {
      this.sttService.stopListening();
    } else {
      this.ttsService.stop();
      this.sttService.startListening();
    }
  }

  formatEventTime(date: Date): string {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  isEarlyEvent(event: CalendarEvent): boolean {
    return event.startTime.getHours() < 9;
  }

  speakBriefing(): void {
    const b = this.briefing();
    if (!b) return;

    // Use AI narrative if available, fall back to hardcoded template
    let text: string;
    if (b.narrativeSummary) {
      text = b.narrativeSummary;
    } else {
      const calPart = this.calendarEvents().length > 0
        ? ` You have ${this.calendarEvents().length} event${this.calendarEvents().length > 1 ? 's' : ''} today: ${this.calendarEvents().map((e) => `${this.formatEventTime(e.startTime)}, ${e.summary}`).join('. ')}.`
        : ' No calendar events today.';
      text = `Good morning. You have ${b.unbilledHours} unbilled hours, worth $${b.unbilledAmount}. This week you've logged ${b.weekHours} hours.${calPart} ${b.alerts.map((a) => a.message).join('. ')}`;
    }
    this.ttsService.primeAudioContext();
    // Use createdAt timestamp as cache key so regenerated briefings on the same
    // day don't replay stale audio. Fall back to date if createdAt is absent.
    const createdAt = (b.createdAt as any)?.toDate?.() ?? new Date(b.createdAt as any);
    const briefingKey = `briefing-${createdAt.getTime() || b.date}`;
    this.ttsService.speak(text, this.voice, briefingKey);
  }

  stopSpeaking(): void {
    this.ttsService.stop();
  }

  // ── Tasks ──────────────────────────────────────────────────

  buildRecurrence(type: string, day: number | null): TaskRecurrence | undefined {
    if (type === 'daily') return { type: 'daily' };
    if (type === 'weekly' && day !== null) return { type: 'weekly', dayOfWeek: day };
    if (type === 'monthly' && day !== null) return { type: 'monthly', dayOfMonth: day };
    return undefined;
  }

  async addTask(): Promise<void> {
    if (!this.newTaskTitle.trim()) return;
    const recurrence = this.buildRecurrence(this.newTaskRecurrenceType, this.newTaskRecurrenceDay);
    await this.taskService.addTask(
      this.newTaskTitle.trim(),
      this.newTaskCategory,
      this.newTaskDueDate || undefined,
      recurrence,
    );
    this.newTaskTitle = '';
    this.newTaskDueDate = '';
    this.newTaskRecurrenceType = '';
    this.newTaskRecurrenceDay = null;
  }

  toggleBillingEntries(): void {
    this.billingEntriesOpen.update((v) => !v);
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

  startEditingTask(task: Task): void {
    this.editingTaskId = task.id!;
    this.editingTaskTitle = task.title;
    this.editingTaskDueDate = task.dueDate || '';
    this.editingTaskRecurrenceType = task.recurrence?.type || '';
    this.editingTaskRecurrenceDay = task.recurrence?.dayOfWeek ?? task.recurrence?.dayOfMonth ?? null;
  }

  async saveTask(task: Task): Promise<void> {
    if (task.id) {
      const recurrence = this.buildRecurrence(this.editingTaskRecurrenceType, this.editingTaskRecurrenceDay);
      const updates: Partial<Task> = {
        dueDate: this.editingTaskDueDate || undefined,
        recurrence,
      };
      if (this.editingTaskTitle.trim()) {
        updates.title = this.editingTaskTitle.trim();
      }
      await this.taskService.updateTask(task.id, updates);
    }
    this.editingTaskId = null;
  }

  cancelEditTask(): void {
    this.editingTaskId = null;
  }

  recurrenceLabel(task: Task): string {
    const r = task.recurrence;
    if (!r) return '';
    if (r.type === 'daily') return 'daily';
    if (r.type === 'weekly' && r.dayOfWeek !== undefined) {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `wkly ${days[r.dayOfWeek]}`;
    }
    if (r.type === 'monthly' && r.dayOfMonth !== undefined) return `mthly ${r.dayOfMonth}`;
    return '';
  }

  async dismissAlert(alert: Alert): Promise<void> {
    if (alert.id) await this.alertService.dismissAlert(alert.id);
  }

  onVoiceChange(voice: string): void {
    localStorage.setItem('maisie-voice', voice);
  }

  toggleMute(): void {
    const next = !this.ttsMuted();
    this.ttsMuted.set(next);
    localStorage.setItem('maisie-muted', String(next));
    if (next) this.ttsService.stop();
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

  async deleteCategory(categoryKey: string, categoryId: string, categoryLabel: string, event: Event): Promise<void> {
    event.stopPropagation();
    const activeTasks = this.tasks().filter((t) => t.category === categoryKey);
    if (activeTasks.length > 0) {
      alert(`"${categoryLabel}" has ${activeTasks.length} active task${activeTasks.length !== 1 ? 's' : ''}. Complete or reassign those tasks before deleting this category.`);
      return;
    }
    const confirmed = confirm(`Delete category "${categoryLabel}"? This cannot be undone.`);
    if (!confirmed) return;
    await this.taskCategoryService.deleteCategory(categoryId);
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

  renderMarkdown(content: string): SafeHtml {
    const html = marked.parse(content) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
