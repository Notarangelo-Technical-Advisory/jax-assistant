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

const functionsDir = fileURLToPath(new URL('../../functions/', import.meta.url));
const fromFunctions = createRequire(`${functionsDir}package.json`);
const { Client } = fromFunctions('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = fromFunctions('@modelcontextprotocol/sdk/client/stdio.js');

const PROJECT_ID = 'demo-jax-mcp';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

const CONTACT_TOOLS = ['find_contacts', 'get_contact', 'get_company', 'save_contact', 'save_company', 'add_contact_note', 'link_to_contact', 'remove_contact_link'];

let client;

before(async () => {
  client = new Client({ name: 'maisie-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: `${functionsDir}node_modules/.bin/tsx`,
    args: ['src/mcp/server.ts'],
    cwd: functionsDir,
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT_ID },
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
