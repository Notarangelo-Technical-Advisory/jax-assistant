import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { LoginComponent } from './login.component';
import { AuthService } from '../../services/auth.service';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, provideEmulator, waitFor
} from '../../../testing/emulator-testing';

// Signing in and resetting a password against the Auth emulator.

describe('LoginComponent', () => {
  let emulator: EmulatorApp;
  let page: LoginComponent;
  let auth: AuthService;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
    await createUserWithEmailAndPassword(emulator.auth, 'jack@example.com', 'correct-horse');
    await signOut(emulator.auth);
    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [provideRouter([]), ...provideEmulator(emulator)],
    }).compileComponents();
    page = TestBed.createComponent(LoginComponent).componentInstance;
    auth = TestBed.inject(AuthService);
    await waitFor(() => !auth.loading());
  });

  afterEach(() => emulator.dispose());

  it('starts signed out', () => {
    expect(auth.currentUser()).toBeNull();
  });

  it('signs Jack in and opens the dashboard', async () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate');
    page.email = 'jack@example.com';
    page.password = 'correct-horse';

    await page.login();

    await waitFor(() => auth.currentUser() !== null);
    expect(auth.currentUser()!.email).toBe('jack@example.com');
    expect(await auth.getIdToken()).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith(['/']);
    expect(page.error()).toBe('');
    expect(page.loading()).toBeFalse();
  });

  it('refuses a wrong password without saying which part was wrong', async () => {
    page.email = 'jack@example.com';
    page.password = 'wrong';

    await page.login();

    expect(page.error()).toBe('Invalid email or password.');
    expect(auth.currentUser()).toBeNull();
    expect(page.loading()).toBeFalse();
  });

  it('signs out', async () => {
    await auth.login('jack@example.com', 'correct-horse');
    await waitFor(() => auth.currentUser() !== null);

    await auth.logout();

    await waitFor(() => auth.currentUser() === null);
    await expectAsync(auth.getIdToken()).toBeRejectedWithError('Not authenticated');
  });

  it('sends a reset link, and gives the same answer for an unknown email', async () => {
    page.showReset();
    page.email = 'jack@example.com';
    await page.sendReset();
    expect(page.notice()).toContain('reset link is on its way');

    page.showReset();
    page.email = 'nobody@example.com';
    await page.sendReset();
    expect(page.error()).toBe('');
    expect(page.notice()).toContain('reset link is on its way');
  });

  it('asks for a valid address when the email is malformed', async () => {
    // Live Firebase answers a malformed address with auth/invalid-email; the
    // emulator answers EMAIL_NOT_FOUND, so give the page the live answer.
    spyOn(auth, 'sendPasswordReset').and.rejectWith({ code: 'auth/invalid-email' });
    page.showReset();
    page.email = 'not-an-email';

    await page.sendReset();

    expect(page.error()).toBe('Enter a valid email address.');
    expect(page.notice()).toBe('');
  });
});
