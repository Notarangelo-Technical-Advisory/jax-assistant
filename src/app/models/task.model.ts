import { RecurrenceRule } from '../services/recurrence';

export type { RecurrenceType } from '../services/recurrence';
export type TaskRecurrence = RecurrenceRule;

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
