import { Component, inject, signal, effect, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { BriefingService } from '../../services/briefing.service';
import { TaskService } from '../../services/task.service';
import { AlertService } from '../../services/alert.service';
import { ChatService } from '../../services/chat.service';
import { TtsService } from '../../services/tts.service';
import { SttService } from '../../services/stt.service';
import { Briefing } from '../../models/briefing.model';
import { Task } from '../../models/task.model';
import { Alert } from '../../models/alert.model';

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
  ttsService = inject(TtsService);
  sttService = inject(SttService);

  briefing = signal<Briefing | null>(null);
  tasks = signal<Task[]>([]);
  alerts = signal<Alert[]>([]);

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

  ngOnInit(): void {
    this.subs.push(
      this.briefingService.getLatestBriefing().subscribe((b) => this.briefing.set(b)),
      this.taskService.getActiveTasks().subscribe((t) => this.tasks.set(t)),
      this.alertService.getActiveAlerts().subscribe((a) => this.alerts.set(a)),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.ttsService.stop();
  }

  async sendChat(): Promise<void> {
    const text = this.chatInput.trim();
    if (!text) return;
    this.chatInput = '';

    const response = await this.chatService.sendMessage(text);
    // Auto-speak the response
    this.ttsService.primeAudioContext();
    this.ttsService.speak(response, this.voice, `chat-${Date.now()}`);
  }

  startConversation(): void {
    this.ttsService.primeAudioContext();
    this.greetingPlaying.set(true);

    this.greetingAudio = new Audio('/greeting.mp3');
    this.greetingAudio.onended = () => {
      this.greetingPlaying.set(false);
      // Auto-start listening after greeting finishes
      if (this.sttService.isSupported) {
        this.sttService.startListening();
      }
    };
    this.greetingAudio.onerror = () => {
      this.greetingPlaying.set(false);
    };
    this.greetingAudio.play().catch(() => {
      this.greetingPlaying.set(false);
    });
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

  logout(): void {
    this.authService.logout();
  }
}
