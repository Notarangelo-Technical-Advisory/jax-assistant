export interface Task {
  id?: string;
  title: string;
  category: 'ihrdc' | 'solomon' | 'dial' | 'ppk' | 'church' | 'general';
  completed: boolean;
  dueDate?: string;
  createdAt: Date;
  completedAt?: Date;
}
