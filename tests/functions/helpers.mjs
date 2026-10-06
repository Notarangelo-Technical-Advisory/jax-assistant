// Helpers for the MAISIE tool tests. Run them with `npm run test:functions`,
// which builds the functions and starts the Firestore emulator under a demo
// project, so nothing touches live data.
//
// The tests call executeTool() from the compiled functions — the same entry
// point the cloud chat function and the MCP server use — with the Admin SDK
// pointed at the emulator, as it is in production.

import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = fromFunctions('firebase-admin');
const { executeTool } = fromFunctions('./lib/tools/execute.js');
const { importContacts } = fromFunctions('./lib/tools/contacts-import.js');

export const PROJECT_ID = 'demo-jax-test';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

let db;

export function setUp() {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
}

/** Empties the emulator's Firestore between tests. */
export async function reset() {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' });
}

/** Runs one MAISIE tool and returns its result object. */
export const tool = (name, input = {}) =>
  executeTool(name, input, { db, customerMap: new Map(), categories: [] });

/** Runs the Apple Contacts import with cards shaped as the Mac reader returns them. */
export const importApple = (people, options) => importContacts(db, people, options);

/** One Apple Contacts card, with blanks for anything not given. */
export const card = (fields) => ({
  appleId: '', kind: 'person', firstName: '', lastName: '', organization: '', jobTitle: '', emails: [], phones: [],
  ...fields,
});

/** Reads a document directly; undefined when it does not exist. */
export async function read(path) {
  const snap = await db.doc(path).get();
  return snap.exists ? snap.data() : undefined;
}

/** All documents in a collection, with their IDs. */
export async function all(collection) {
  const snap = await db.collection(collection).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Writes a document directly, as the contacts page would. */
export const seed = (path, data) => db.doc(path).set(data);

/** Waits long enough that the next server timestamp is later than the last. */
export const tick = () => new Promise(resolve => setTimeout(resolve, 15));
