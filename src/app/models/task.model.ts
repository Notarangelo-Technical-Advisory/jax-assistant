export type RecurrenceType = 'daily' | 'weekly' | 'monthly';

export interface TaskRecurrence {
  type: RecurrenceType;
  dayOfWeek?: number;   // 0–6 (Sun=0) — required when type === 'weekly'
  dayOfMonth?: number;  // 1–31        — required when type === 'monthly'
}

export interface Task {
  id?: string;
  title: string;
  category: string;
  completed: boolean;
  dueDate?: string;
  recurrence?: TaskRecurrence;
  createdAt: Date;
  completedAt?: Date;
}
