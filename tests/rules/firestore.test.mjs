// Firestore security rules tests for the CRM collections. Run with
// `npm run test:rules`, which starts the Firestore emulator under a demo
// project (no live data).
//
// The queries below copy the ones the contacts page makes (see
// src/app/services/contact.service.ts), so a rule change that would break the
// page fails here as well.

import { after, before, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assertFails, assertSucceeds, initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, where
} from 'firebase/firestore';

const NOW = new Date('2026-10-06T12:00:00Z');

// MAISIE has a single user, Jack. "jack" is signed in; anonymous is a visitor
// who is not signed in.
const SEED = {
  'companies/ihrdc':  { name: 'IHRDC', website: 'ihrdc.com', tags: ['client'], createdAt: NOW, updatedAt: NOW },
  'contacts/brad':    { firstName: 'Brad', lastName: 'Donohue', emails: ['brad@ihrdc.com'], phones: [], title: 'President & CEO', companyId: 'ihrdc', tags: ['client'], createdAt: NOW, updatedAt: NOW },
  'contactNotes/n1':  { contactId: 'brad', companyId: null, body: 'Prefers Teams to email.', createdAt: NOW },
  'contactNotes/n2':  { contactId: null, companyId: 'ihrdc', body: 'Contract renews in January.', createdAt: NOW },
};

let testEnv;

const db = uid => (uid ? testEnv.authenticatedContext(uid) : testEnv.unauthenticatedContext()).firestore();

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-jax-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

after(() => testEnv.cleanup());

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async context => {
    const admin = context.firestore();
    await Promise.all(Object.entries(SEED).map(([path, data]) => setDoc(doc(admin, path), data)));
  });
});

describe('contacts', () => {
  it('Jack can list, read, add, edit and delete contacts', async () => {
    const jack = db('jack');
    await assertSucceeds(getDocs(collection(jack, 'contacts')));
    await assertSucceeds(getDoc(doc(jack, 'contacts/brad')));
    await assertSucceeds(addDoc(collection(jack, 'contacts'), {
      firstName: 'Amy', lastName: 'Lee', emails: ['amy@ihrdc.com'], phones: [], title: null, companyId: 'ihrdc', tags: [],
    }));
    await assertSucceeds(updateDoc(doc(jack, 'contacts/brad'), { title: 'CEO' }));
    await assertSucceeds(deleteDoc(doc(jack, 'contacts/brad')));
  });

  it('a visitor who is not signed in can neither read nor write contacts', async () => {
    const visitor = db(null);
    await assertFails(getDocs(collection(visitor, 'contacts')));
    await assertFails(getDoc(doc(visitor, 'contacts/brad')));
    await assertFails(addDoc(collection(visitor, 'contacts'), { firstName: 'Mallory' }));
    await assertFails(updateDoc(doc(visitor, 'contacts/brad'), { title: 'Changed' }));
    await assertFails(deleteDoc(doc(visitor, 'contacts/brad')));
  });
});

describe('companies', () => {
  it('Jack can list, add and edit companies', async () => {
    const jack = db('jack');
    await assertSucceeds(getDocs(collection(jack, 'companies')));
    await assertSucceeds(addDoc(collection(jack, 'companies'), { name: 'Grace Pres', website: null, tags: [] }));
    await assertSucceeds(updateDoc(doc(jack, 'companies/ihrdc'), { website: 'https://ihrdc.com' }));
  });

  it('a visitor who is not signed in cannot read or change companies', async () => {
    const visitor = db(null);
    await assertFails(getDocs(collection(visitor, 'companies')));
    await assertFails(updateDoc(doc(visitor, 'companies/ihrdc'), { name: 'Changed' }));
  });
});

describe('contactNotes', () => {
  it("Jack can load a contact's notes and a company's notes, newest first", async () => {
    const jack = db('jack');
    await assertSucceeds(getDocs(query(collection(jack, 'contactNotes'), where('contactId', '==', 'brad'), orderBy('createdAt', 'desc'))));
    await assertSucceeds(getDocs(query(collection(jack, 'contactNotes'), where('companyId', '==', 'ihrdc'), orderBy('createdAt', 'desc'))));
  });

  it('Jack can add and delete notes', async () => {
    const jack = db('jack');
    await assertSucceeds(addDoc(collection(jack, 'contactNotes'), { contactId: 'brad', companyId: null, body: 'Lunch on Friday.', createdAt: NOW }));
    await assertSucceeds(deleteDoc(doc(jack, 'contactNotes/n1')));
  });

  it('a visitor who is not signed in cannot read, add or delete notes', async () => {
    const visitor = db(null);
    await assertFails(getDocs(query(collection(visitor, 'contactNotes'), where('contactId', '==', 'brad'))));
    await assertFails(addDoc(collection(visitor, 'contactNotes'), { contactId: 'brad', body: 'Spam' }));
    await assertFails(deleteDoc(doc(visitor, 'contactNotes/n1')));
  });
});

describe('everything else', () => {
  it('a collection with no rule stays closed, even to Jack', async () => {
    await assertFails(getDocs(collection(db('jack'), 'addressBookExport')));
    await assertFails(setDoc(doc(db('jack'), 'addressBookExport/x'), { any: 'thing' }));
  });
});
