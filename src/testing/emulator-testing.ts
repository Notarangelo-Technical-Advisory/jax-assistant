import { FirebaseApp, deleteApp, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import { Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

// Helpers for browser tests that need real sign-in and the real security rules.
// `npm test` and `npm run test:ci` run Karma inside the Auth and Firestore
// emulators under the demo project below, so nothing touches live data.

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

/** Waits until `check` returns true, failing after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the page to update');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
