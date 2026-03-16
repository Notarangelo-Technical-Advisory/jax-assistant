export interface ChatMessage {
  id?: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sequence: number;
  createdAt: Date;
}
