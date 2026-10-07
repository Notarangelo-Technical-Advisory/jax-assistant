// End-to-end test of the `maisie` MCP server. Run with `npm run test:mcp`,
// which starts the Firestore emulator under a demo project.
//
// The server is started exactly as VS Code starts it (tsx over stdio) and
// driven by the official MCP client, so this covers the tool list a client
// sees, argument passing, and how success and failure come back.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const functionsDir = fileURLToPath(new URL('../../functions/', import.meta.url));
const fromFunctions = createRequire(`${functionsDir}package.json`);
const { Client } = fromFunctions('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = fromFunctions('@modelcontextprotocol/sdk/client/stdio.js');
const { buildTools } = fromFunctions('./lib/tools/definitions.js');

const PROJECT_ID = 'demo-jax-mcp';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

const CONTACT_TOOLS = ['find_contacts', 'get_contact', 'get_company', 'save_contact', 'save_company', 'add_contact_note', 'link_to_contact', 'remove_contact_link'];

// Stands in for the macOS Contacts read, which cannot run on Linux. Each test
// writes the script output it wants here; the server reads it on every call.
const APPLE_FIXTURE = join(mkdtempSync(join(tmpdir(), 'maisie-mcp-')), 'apple-contacts.json');
const appleSays = (result) => writeFileSync(APPLE_FIXTURE, typeof result === 'string' ? result : JSON.stringify(result));

let client;

before(async () => {
  client = new Client({ name: 'maisie-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: `${functionsDir}node_modules/.bin/tsx`,
    args: ['src/mcp/server.ts'],
    cwd: functionsDir,
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT_ID, MAISIE_APPLE_CONTACTS_FIXTURE: APPLE_FIXTURE },
    stderr: 'ignore',
  }));
});

after(() => client?.close());

beforeEach(() =>
  fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' }));

/** Calls a tool and returns its parsed JSON result, plus whether MCP flagged it as an error. */
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return { ...JSON.parse(response.content[0].text), isError: response.isError === true };
}

describe('maisie MCP server', () => {
  it('lists every contact tool, with a description and an input schema', async () => {
    const { tools } = await client.listTools();
    for (const name of CONTACT_TOOLS) {
      const found = tools.find(t => t.name === name);
      assert.ok(found, `${name} is missing from the MCP tool list`);
      assert.ok(found.description.length > 20, `${name} has no useful description`);
      assert.equal(found.inputSchema.type, 'object');
    }
  });

  it('still keeps the cloud-only tools out of VS Code', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const hidden of ['code_with_github', 'get_calendar', 'mail_draft']) {
      assert.ok(!names.includes(hidden), `${hidden} should not be exposed over MCP`);
    }
  });

  it('adds a contact, finds them, takes a note and reads it back', async () => {
    const saved = await call('save_contact', {
      first_name: 'Brad', last_name: 'Donohue', emails: ['brad@ihrdc.com'], company: 'IHRDC',
    });
    assert.equal(saved.success, true);
    assert.equal(saved.isError, false);

    const found = await call('find_contacts', { query: 'donohue' });
    assert.deepEqual(found.contacts.map(c => [c.id, c.company]), [[saved.contactId, 'IHRDC']]);

    await call('add_contact_note', { contact_id: saved.contactId, body: 'Prefers Teams to email.' });

    const contact = await call('get_contact', { contact_id: saved.contactId });
    assert.deepEqual(contact.notes.map(n => n.body), ['Prefers Teams to email.']);
  });

  it('links an email found with the desktop mail_search to a contact, and removes it', async () => {
    const { contactId } = await call('save_contact', { first_name: 'Brad', emails: ['brad@ihrdc.com'] });

    // The fields the desktop server's mail_search returns for one message.
    const linked = await call('link_to_contact', {
      contact_id: contactId, type: 'email', title: 'Friday demo agenda',
      source_id: 'CAF7x9=abc@mail.ihrdc.com', detail: 'Brad Donohue', date: '2026-10-02T14:05:00Z',
    });
    assert.equal(linked.success, true);
    assert.deepEqual((await call('get_contact', { contact_id: contactId })).links.map(l => l.sourceId), ['CAF7x9=abc@mail.ihrdc.com']);

    assert.equal((await call('remove_contact_link', { link_id: linked.linkId })).success, true);
    assert.deepEqual((await call('get_contact', { contact_id: contactId })).links, []);
  });

  it('flags a refused request as an MCP error, with the reason', async () => {
    await call('save_contact', { first_name: 'Brad', emails: ['brad@ihrdc.com'] });

    const duplicate = await call('save_contact', { first_name: 'Brad', emails: ['brad@ihrdc.com'] });

    assert.equal(duplicate.isError, true);
    assert.match(duplicate.error, /already exists/);
  });
});

describe('import_apple_contacts', () => {
  // The exact shape the JXA script in functions/src/mcp/apple-contacts.ts prints.
  const ADDRESS_BOOK = {
    ok: true,
    contacts: [
      { id: 'A-BRAD', account: 'iCloud', type: 'person', given: 'Brad', family: 'Donohue', org: 'IHRDC', job: 'President & CEO', emails: ['Brad@IHRDC.com'], phones: ['+1 (617) 555-0100'] },
      { id: 'A-ORG', account: 'iCloud', type: 'organization', given: '', family: '', org: 'Grace Presbyterian', job: '', emails: [], phones: [] },
    ],
  };

  it('is offered in VS Code only, and the cloud chat never sees it', async () => {
    assert.ok((await client.listTools()).tools.some(t => t.name === 'import_apple_contacts'));
    assert.ok(!buildTools([]).some(t => t.name === 'import_apple_contacts'), 'the cloud chat cannot reach a Mac');
  });

  it('can be run from a terminal, and a dry run writes nothing', async () => {
    appleSays(ADDRESS_BOOK);

    const output = execFileSync(`${functionsDir}node_modules/.bin/tsx`, ['src/mcp/import-contacts.ts', '--dry-run'], {
      cwd: functionsDir,
      encoding: 'utf-8',
      env: { ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT_ID, MAISIE_APPLE_CONTACTS_FIXTURE: APPLE_FIXTURE },
    });

    assert.match(output, /Dry run: nothing was written/);
    assert.match(output, /New contacts:\s+1/);
    assert.match(output, /New, for example: Brad Donohue/);
    assert.deepEqual((await call('find_contacts')).contacts, []);
  });

  it('does a dry run unless told otherwise, then imports when asked', async () => {
    appleSays(ADDRESS_BOOK);

    const preview = await call('import_apple_contacts');
    assert.deepEqual([preview.dryRun, preview.read, preview.created, preview.companiesCreated], [true, 2, 1, 2]);
    assert.deepEqual((await call('find_contacts')).contacts, []);

    const real = await call('import_apple_contacts', { dry_run: false });
    assert.equal(real.dryRun, false);
    const found = await call('find_contacts', { query: 'donohue' });
    assert.deepEqual(found.contacts.map(c => [c.name, c.company, c.emails[0]]), [['Brad Donohue', 'IHRDC', 'brad@ihrdc.com']]);
  });

  it('imports iCloud cards only, and counts the cards from other accounts it leaves out', async () => {
    // Jack's Mac also syncs 976 Google cards; a Google copy of Brad came in
    // beside his iCloud card before this rule (2026-10-06).
    appleSays({ ok: true, contacts: [
      ...ADDRESS_BOOK.contacts,
      { id: 'G-BRAD', account: 'Google', type: 'person', given: 'Brad', family: 'Donohue', org: '', job: '', emails: [], phones: ['(617) 555-0100'] },
      { id: 'G-ANN', account: 'Google', type: 'person', given: 'Ann', family: 'Other', org: '', job: '', emails: ['ann@example.org'], phones: [] },
      { id: 'M-1', account: 'On My Mac', type: 'person', given: 'Local', family: 'Card', org: '', job: '', emails: [], phones: [] },
    ] });

    const preview = await call('import_apple_contacts');

    assert.deepEqual([preview.read, preview.created, preview.companyCards], [2, 1, 1]);
    assert.deepEqual(preview.otherAccountsLeftOut, { Google: 2, 'On My Mac': 1 });
  });

  it('reads each card on its own, not merged across accounts, so its account is known', () => {
    // Linux cannot run the script; check the two settings that matter. On macOS 26
    // listing the accounts returns none, so the script must not depend on it.
    const script = readFileSync(`${functionsDir}src/mcp/apple-contacts.ts`, 'utf-8');
    assert.match(script, /request\.unifyResults = false;/);
    assert.match(script, /predicateForContainerOfContactWithIdentifier/);
    assert.doesNotMatch(script, /containersMatchingPredicateError\(null/);
  });

  it('explains how to grant access when macOS refuses it', async () => {
    appleSays({ ok: false, error: 'no_contacts_access', status: 2 });

    const response = await client.callTool({ name: 'import_apple_contacts', arguments: { dry_run: false } });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Privacy & Security > Contacts/);
    assert.deepEqual((await call('find_contacts')).contacts, []);
  });

  it('reports unreadable output as an error, never as an empty address book', async () => {
    appleSays('execution error: Error: something broke (-2700)');

    const response = await client.callTool({ name: 'import_apple_contacts', arguments: {} });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /unreadable output/);
  });
});

