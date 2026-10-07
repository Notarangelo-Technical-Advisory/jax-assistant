import { Injectable, signal, inject } from '@angular/core';
import { signInWithEmailAndPassword, sendPasswordResetEmail, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { AUTH } from '../firebase';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(AUTH);

  currentUser = signal<User | null>(null);
  loading = signal(true);

  constructor() {
    onAuthStateChanged(this.auth, (user) => {
      this.currentUser.set(user);
      this.loading.set(false);
    });
  }

  async login(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, password);
  }

  async sendPasswordReset(email: string): Promise<void> {
    await sendPasswordResetEmail(this.auth, email);
  }

  async logout(): Promise<void> {
    await signOut(this.auth);
  }

  async getIdToken(): Promise<string> {
    const user = this.currentUser();
    if (!user) throw new Error('Not authenticated');
    return user.getIdToken();
  }
}
