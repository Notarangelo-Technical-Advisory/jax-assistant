import { EnvironmentProviders, InjectionToken, inject, makeEnvironmentProviders } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import { Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { RemoteConfig, getRemoteConfig } from 'firebase/remote-config';
import { environment } from '../environments/environment';

// The Firebase SDK objects the app injects, for example `inject(FIRESTORE)`.
// Tests provide their own (see src/testing/), so they never touch live data.
export const FIREBASE_APP  = new InjectionToken<FirebaseApp>('FIREBASE_APP');
export const AUTH          = new InjectionToken<Auth>('AUTH');
export const FIRESTORE     = new InjectionToken<Firestore>('FIRESTORE');
export const REMOTE_CONFIG = new InjectionToken<RemoteConfig>('REMOTE_CONFIG');

/** Each object is created the first time something injects it. */
export function provideFirebase(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: FIREBASE_APP, useFactory: () => initializeApp(environment.firebase) },
    {
      provide: AUTH,
      useFactory: () => {
        const auth = getAuth(inject(FIREBASE_APP));
        if (environment.useEmulators) {
          connectAuthEmulator(auth, 'http://localhost:9099');
        }
        return auth;
      }
    },
    {
      provide: FIRESTORE,
      useFactory: () => {
        const firestore = getFirestore(inject(FIREBASE_APP));
        if (environment.useEmulators) {
          connectFirestoreEmulator(firestore, 'localhost', 8080);
        }
        return firestore;
      }
    },
    { provide: REMOTE_CONFIG, useFactory: () => getRemoteConfig(inject(FIREBASE_APP)) },
  ]);
}
