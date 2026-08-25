import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="login-container">
      <div class="login-card">
        <h1>Jax Assistant</h1>
        <p class="subtitle">
          {{ mode() === 'signin' ? 'Executive Assistant Dashboard' : 'Reset your password' }}
        </p>

        @if (mode() === 'signin') {
          <form (ngSubmit)="login()">
            <input
              type="email"
              [(ngModel)]="email"
              name="email"
              placeholder="Email"
              required
            />
            <input
              type="password"
              [(ngModel)]="password"
              name="password"
              placeholder="Password"
              required
            />
            @if (error()) {
              <p class="error">{{ error() }}</p>
            }
            <button type="submit" [disabled]="loading()">
              {{ loading() ? 'Signing in...' : 'Sign In' }}
            </button>
          </form>
          <button type="button" class="link" (click)="showReset()">
            Forgot password?
          </button>
        } @else {
          <form (ngSubmit)="sendReset()">
            <input
              type="email"
              [(ngModel)]="email"
              name="email"
              placeholder="Email"
              required
            />
            @if (error()) {
              <p class="error">{{ error() }}</p>
            }
            @if (notice()) {
              <p class="notice">{{ notice() }}</p>
            }
            <button type="submit" [disabled]="loading()">
              {{ loading() ? 'Sending...' : 'Send reset link' }}
            </button>
          </form>
          <button type="button" class="link" (click)="showSignIn()">
            Back to sign in
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    .login-container {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #0f172a;
    }
    .login-card {
      background: #1e293b;
      border-radius: 12px;
      padding: 2.5rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    }
    h1 {
      color: #f8fafc;
      margin: 0 0 0.25rem;
      font-size: 1.75rem;
    }
    .subtitle {
      color: #94a3b8;
      margin: 0 0 1.5rem;
      font-size: 0.875rem;
    }
    input {
      display: block;
      width: 100%;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      border: 1px solid #334155;
      border-radius: 8px;
      background: #0f172a;
      color: #f8fafc;
      font-size: 1rem;
      box-sizing: border-box;
    }
    input:focus {
      outline: none;
      border-color: #3b82f6;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      border: none;
      border-radius: 8px;
      background: #3b82f6;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #2563eb; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .error {
      color: #f87171;
      font-size: 0.875rem;
      margin: 0 0 1rem;
    }
    .notice {
      color: #4ade80;
      font-size: 0.875rem;
      margin: 0 0 1rem;
    }
    button.link {
      width: auto;
      margin-top: 1rem;
      padding: 0;
      background: none;
      color: #94a3b8;
      font-size: 0.875rem;
      font-weight: 400;
      text-decoration: underline;
    }
    button.link:hover { background: none; color: #f8fafc; }
  `]
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  email = '';
  password = '';
  mode = signal<'signin' | 'reset'>('signin');
  loading = signal(false);
  error = signal('');
  notice = signal('');

  async login(): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    try {
      await this.authService.login(this.email, this.password);
      this.router.navigate(['/']);
    } catch (err: unknown) {
      this.error.set('Invalid email or password.');
    } finally {
      this.loading.set(false);
    }
  }

  async sendReset(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');

    try {
      await this.authService.sendPasswordReset(this.email);
    } catch (err: unknown) {
      // Deliberately swallowed: reporting auth/user-not-found would let
      // anyone probe which emails have accounts. Only a malformed address
      // is worth surfacing, since the user can act on it.
      if ((err as { code?: string }).code === 'auth/invalid-email') {
        this.error.set('Enter a valid email address.');
        this.loading.set(false);
        return;
      }
    }

    this.notice.set('If that email has an account, a reset link is on its way.');
    this.loading.set(false);
  }

  showReset(): void {
    this.mode.set('reset');
    this.password = '';
    this.error.set('');
    this.notice.set('');
  }

  showSignIn(): void {
    this.mode.set('signin');
    this.error.set('');
    this.notice.set('');
  }
}
