import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { AppComponent } from './app.component';
import { AuthService } from './services/auth.service';
import {
  EmulatorApp, clearEmulators, createEmulatorApp, provideEmulator, signInAsJack, waitFor
} from '../testing/emulator-testing';

@Component({ template: 'page' })
class StubPage {}

// The app shell against the Auth emulator: it sends anyone not signed in to
// the sign-in page once Firebase has said who is signed in.

describe('AppComponent', () => {
  let emulator: EmulatorApp;

  beforeEach(async () => {
    await clearEmulators();
    emulator = createEmulatorApp();
  });

  afterEach(() => emulator.dispose());

  async function start(): Promise<Router> {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([{ path: 'login', component: StubPage }, { path: '**', component: StubPage }]),
        ...provideEmulator(emulator),
      ],
    }).compileComponents();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    // Run change detection after every async callback, as the running app does.
    TestBed.createComponent(AppComponent).autoDetectChanges();
    const auth = TestBed.inject(AuthService);
    await waitFor(() => !auth.loading());
    return router;
  }

  it('sends a visitor who is not signed in to the sign-in page', async () => {
    const router = await start();
    await waitFor(() => router.url === '/login');
    expect(router.url).toBe('/login');
  });

  it('leaves Jack on the dashboard when he is signed in', async () => {
    await signInAsJack(emulator);
    const router = await start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(TestBed.inject(AuthService).currentUser()).not.toBeNull();
    expect(router.url).toBe('/');
  });
});
