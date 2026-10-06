/**
 * Read every card in Apple Contacts on Jack's Mac, via the Contacts framework.
 *
 * Same shape as bridge/eventkit/read-events.ts: JXA through osascript (the ObjC
 * bridge reaches CNContactStore, which AppleScript cannot), JSON on stdout, and
 * an explicit error instead of an empty list when access is missing. An empty
 * result must only ever mean "the address book is empty".
 *
 * Lives here rather than in bridge/ because its only callers are the local
 * `maisie` MCP server and the import command beside it, and the bridge is an
 * ES module package that this CommonJS code cannot import.
 *
 * Permission: macOS asks once, for the app running the process (Terminal, or
 * VS Code for the MCP server), under System Settings > Privacy & Security >
 * Contacts.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {ApplePerson} from "../tools/contacts-import";

export class AppleContactsError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AppleContactsError";
  }
}

/**
 * JXA source. Contacts are fetched container by container with plain
 * predicate queries rather than enumerateContacts(usingBlock:), because a JS
 * function passed as an ObjC block is not reliably called back under osascript
 * (the EventKit reader hit the same thing with its completion handler).
 * A contact linked across iCloud and Exchange comes back once per container as
 * the same unified contact, so results are de-duplicated by identifier.
 */
export const READ_CONTACTS_SCRIPT = `
ObjC.import('Contacts');
ObjC.import('Foundation');

var CN_ENTITY_CONTACTS = 0;
var CN_AUTHORIZED = 3;

function str(v) {
  if (v === undefined || v === null) return '';
  var s = ObjC.unwrap(v);
  return (s === undefined || s === null) ? '' : String(s);
}

function num(v) { return Number(v); }

/** Ask once, then poll: the completion handler does not fire under osascript. */
function ensureAccess() {
  var status = num($.CNContactStore.authorizationStatusForEntityType(CN_ENTITY_CONTACTS));
  if (status === CN_AUTHORIZED) return status;
  var store = $.CNContactStore.alloc.init;
  try { store.requestAccessForEntityTypeCompletionHandler(CN_ENTITY_CONTACTS, function () {}); } catch (e) {}
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(20);
  while (num($.NSDate.date.timeIntervalSinceDate(deadline)) < 0) {
    status = num($.CNContactStore.authorizationStatusForEntityType(CN_ENTITY_CONTACTS));
    if (status === CN_AUTHORIZED) return status;
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
  return status;
}

function run() {
  var status = ensureAccess();
  if (status !== CN_AUTHORIZED) return JSON.stringify({ ok: false, error: 'no_contacts_access', status: status });

  var store = $.CNContactStore.alloc.init;
  var keys = $(['identifier', 'contactType', 'givenName', 'familyName', 'organizationName', 'jobTitle', 'emailAddresses', 'phoneNumbers']);
  var containers = ObjC.unwrap(store.containersMatchingPredicateError(null, null)) || [];
  var seen = {};
  var contacts = [];

  containers.forEach(function (container) {
    var predicate = $.CNContact.predicateForContactsInContainerWithIdentifier(container.identifier);
    var found = ObjC.unwrap(store.unifiedContactsMatchingPredicateKeysToFetchError(predicate, keys, null)) || [];
    found.forEach(function (c) {
      var id = str(c.identifier);
      if (seen[id]) return;
      seen[id] = true;
      contacts.push({
        id: id,
        type: num(c.contactType) === 1 ? 'organization' : 'person',
        given: str(c.givenName),
        family: str(c.familyName),
        org: str(c.organizationName),
        job: str(c.jobTitle),
        emails: (ObjC.unwrap(c.emailAddresses) || []).map(function (lv) { return str(lv.value); }),
        phones: (ObjC.unwrap(c.phoneNumbers) || []).map(function (lv) { return str(lv.value.stringValue); })
      });
    });
  });

  return JSON.stringify({ ok: true, containers: containers.length, contacts: contacts });
}
`.trim();

interface RawContact {
  id: string;
  type: "person" | "organization";
  given: string;
  family: string;
  org: string;
  job: string;
  emails: string[];
  phones: string[];
}

type RawResult =
  | {ok: true; containers: number; contacts: RawContact[]}
  | {ok: false; error: string; status?: number};

/** Turn the script's JSON output into import records, or throw a clear error. */
export function parseAppleContacts(raw: string): ApplePerson[] {
  if (!raw.trim()) throw new AppleContactsError("Apple Contacts returned no output.", "empty_output");
  let result: RawResult;
  try {
    result = JSON.parse(raw) as RawResult;
  } catch {
    throw new AppleContactsError(`Apple Contacts returned unreadable output: ${raw.slice(0, 300)}`, "bad_output");
  }
  if (!result.ok) {
    if (result.error === "no_contacts_access") {
      throw new AppleContactsError(
        `MAISIE is not allowed to read Contacts (CNAuthorizationStatus ${result.status}; ` +
          "0 not yet asked, 1 restricted, 2 denied). Allow it under System Settings > Privacy & Security > " +
          "Contacts for the app running this (Terminal or VS Code), then run the import again.",
        "no_contacts_access"
      );
    }
    throw new AppleContactsError(`Apple Contacts read failed: ${result.error}`, result.error);
  }
  return result.contacts.map((c) => ({
    appleId: String(c.id ?? ""),
    kind: c.type === "organization" ? "organization" : "person",
    firstName: String(c.given ?? ""),
    lastName: String(c.family ?? ""),
    organization: String(c.org ?? ""),
    jobTitle: String(c.job ?? ""),
    emails: (c.emails ?? []).map(String),
    phones: (c.phones ?? []).map(String),
  }));
}

/**
 * Read Apple Contacts. When MAISIE_APPLE_CONTACTS_FIXTURE names a file, its
 * contents stand in for the script's output — this is how tests/mcp exercises
 * the whole import on Linux, where there is no Contacts framework.
 */
export function readAppleContacts(): ApplePerson[] {
  const fixture = process.env.MAISIE_APPLE_CONTACTS_FIXTURE;
  if (fixture) return parseAppleContacts(readFileSync(fixture, "utf-8"));

  let raw: string;
  try {
    raw = execFileSync("osascript", ["-l", "JavaScript", "-e", READ_CONTACTS_SCRIPT], {
      encoding: "utf-8",
      // The permission prompt can wait up to 20 s, and a large address book takes a while.
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppleContactsError(`osascript failed: ${message}`, "osascript_failed");
  }
  return parseAppleContacts(raw);
}
