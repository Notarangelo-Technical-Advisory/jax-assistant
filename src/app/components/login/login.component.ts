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
        <p class="subtitle">Executive Assistant Dashboard</p>

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
  `]
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  email = '';
  password = '';
  loading = signal(false);
  error = signal('');

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
}
