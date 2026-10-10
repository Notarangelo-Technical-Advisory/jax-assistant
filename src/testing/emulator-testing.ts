import { Provider } from '@angular/core';
import { Observable } from 'rxjs';
import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { FirebaseApp, deleteApp, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import { Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { AUTH, FIRESTORE } from '../app/firebase';

// Helpers for browser tests that need real sign-in and the real security rules.
// `npm test` and `npm run test:ci` run Karma inside the Auth and Firestore
// emulators under the demo project below, so nothing touches live data.

// [DIAG] temporary: longer limit and a log of slow tests
jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
jasmine.getEnv().addReporter({
  specStarted: (r) => { (r as unknown as { t0: number }).t0 = Date.now(); },
  specDone: (r) => {
    const ms = Date.now() - (r as unknown as { t0: number }).t0;
    if (ms > 2000) console.log('[SLOW]', ms, r.fullName, r.status);
  },
});

export const EMULATOR_PROJECT = 'demo-jax-browser';
const AUTH_URL      = 'http://127.0.0.1:9099';
const FIRESTORE_URL = 'http://127.0.0.1:8080';
const DOCUMENTS_URL = `${FIRESTORE_URL}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;

export interface EmulatorApp {
  auth: Auth;
  firestore: Firestore;
  dispose: () => Promise<void>;
}

let appCount = 0;

/** A Firebase app connected to the emulators, as the real app is connected to Firebase. */
export function createEmulatorApp(): EmulatorApp {
  const app: FirebaseApp = initializeApp(
    { projectId: EMULATOR_PROJECT, apiKey: 'test-key', appId: 'test-app' },
    `emulator-app-${++appCount}`
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, AUTH_URL, { disableWarnings: true });
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  return { auth, firestore, dispose: () => deleteApp(app) };
}

/** Provides the emulator's Auth and Firestore in place of the live ones. */
export function provideEmulator(app: EmulatorApp): Provider[] {
  return [
    { provide: AUTH, useValue: app.auth },
    { provide: FIRESTORE, useValue: app.firestore },
  ];
}

/** Signs in as Jack, the app's only user. */
export async function signInAsJack(app: EmulatorApp): Promise<void> {
  await createUserWithEmailAndPassword(app.auth, `jack-${appCount}@example.com`, 'password123');
}

/** Deletes every account and document in the emulators. */
export async function clearEmulators(): Promise<void> {
  await fetch(`${FIRESTORE_URL}/emulator/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH_URL}/emulator/v1/projects/${EMULATOR_PROJECT}/accounts`, { method: 'DELETE' });
}

/** Reads every document in a collection, bypassing the security rules. */
export async function listDocuments(collection: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${DOCUMENTS_URL}/${collection}`, { headers: { Authorization: 'Bearer owner' } });
  const body = await response.json() as { documents?: Array<{ name: string; fields: Record<string, unknown> }> };
  return (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop(), ...d.fields }));
}

type SeedValue = string | number | boolean | null | Date | SeedValue[] | { [field: string]: SeedValue };

/** A value in the Firestore REST format. */
function toRestValue(value: SeedValue): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toRestValue) } };
  switch (typeof value) {
    case 'string':  return { stringValue: value };
    case 'boolean': return { booleanValue: value };
    case 'number':  return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    default:        return { mapValue: { fields: toRestFields(value) } };
  }
}

function toRestFields(fields: { [field: string]: SeedValue }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, toRestValue(value)]));
}

/**
 * Writes a document as a Cloud Function or the Mac bridge would, bypassing the
 * security rules. Use it for collections the browser may only read.
 */
export async function seedDocument(path: string, fields: { [field: string]: SeedValue }): Promise<void> {
  const response = await fetch(`${DOCUMENTS_URL}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toRestFields(fields) }),
  });
  if (!response.ok) throw new Error(`Could not seed ${path}: ${response.status}`);
}

/** Waits until `check` returns true, failing after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the page to update');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Subscribes to a live query and keeps its latest value, as a page would. */
export function watch<T>(stream: Observable<T>): { latest: () => T | undefined; stop: () => void } {
  let latest: T | undefined;
  const subscription = stream.subscribe((value) => { latest = value; });
  return { latest: () => latest, stop: () => subscription.unsubscribe() };
}

/**
 * Waits for the page to send a request to `url` and returns it. Services fetch
 * Jack's sign-in token first, so the request goes out a moment after the call.
 */
export async function nextRequest(http: HttpTestingController, url: string): Promise<TestRequest> {
  let found: TestRequest[] = [];
  await waitFor(() => (found = http.match(url)).length > 0);
  expect(found.length).withContext(`requests to ${url}`).toBe(1);
  return found[0];
}
