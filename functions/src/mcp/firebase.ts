/**
 * Firebase Admin setup shared by the local-only scripts in src/mcp: the
 * `maisie` MCP server and the Apple Contacts import command. Never deployed.
 *
 * Requires a Firebase service account key at bridge/service-account.json
 * (gitignored — download from Firebase Console > Project Settings > Service
 * Accounts). The same key is exported as GOOGLE_APPLICATION_CREDENTIALS so
 * fta-client's applicationDefault() call resolves to it for the cross-project
 * read of the NTA time tracker (fta-invoice-tracking).
 */

// SSL bypass for this machine's certificate issues (same as bridge/calendar-sync.ts).
// Must precede any import that touches the network stack.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

import * as path from "path";
import {readFileSync} from "fs";
import * as admin from "firebase-admin";

// Resolves to <repo>/bridge/service-account.json from either src/mcp (tsx) or
// lib/mcp (compiled) — both are two levels below the repo root.
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "..", "..", "..", "bridge", "service-account.json");

// Under the Firestore emulator (tests/mcp) there is no key and no live data:
// the Admin SDK reads FIRESTORE_EMULATOR_HOST itself and only needs a project ID.
const usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

if (usingEmulator) {
  admin.initializeApp({projectId: process.env.GCLOUD_PROJECT ?? "demo-jax-test"});
} else {
  // fta-client.ts reaches the NTA time tracker with applicationDefault(); locally
  // that resolves via GOOGLE_APPLICATION_CREDENTIALS. The secondary app is built
  // lazily on first billing call, by which point this is set.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_PATH;
  const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf-8"));
  admin.initializeApp({credential: admin.credential.cert(serviceAccount)});
}

export const db = admin.firestore();
// REST instead of gRPC — gRPC has its own TLS stack that ignores NODE_TLS_REJECT_UNAUTHORIZED.
// Not under the emulator: it is plain HTTP, and the REST transport ignores the
// emulator's credential bypass and demands real Google credentials.
if (!usingEmulator) db.settings({preferRest: true});
