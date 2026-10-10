// Tests for the automatic contact linking job that runs on Jack's Mac
// (functions/src/mcp/autolink-contacts.ts). Mail, Calendar and Messages cannot
// run on Linux, so fixture files stand in for what their scripts and sqlite3
// print; the job then runs exactly as launchd runs it, against the Firestore
// emulator, in Jack's time zone.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const functionsDir = fileURLToPath(new URL('../../functions/', import.meta.url));
const admin = createRequire(`${functionsDir}package.json`)('firebase-admin');

const PROJECT_ID = 'demo-jax-mcp';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

const dir = mkdtempSync(join(tmpdir(), 'maisie-autolink-'));
const MAIL_FIXTURE = join(dir, 'mail.json');
const MEETINGS_FIXTURE = join(dir, 'meetings.json');
const MESSAGES_FIXTURE = join(dir, 'messages.json');
const write = (file, result) => writeFileSync(file, typeof result === 'string' ? result : JSON.stringify(result));

// The exact shapes the JXA scripts in apple-mail.ts and apple-meetings.ts print.
const MAIL = {
  ok: true,
  accounts: ['jack@example.com'],
  received: [
    { id: 'CAF7x9=abc@mail.ihrdc.com', subject: 'Friday demo agenda', sender: 'Brad Donohue <brad@ihrdc.com>', date: Date.UTC(2020, 2, 6, 14, 5), to: ['jack@example.com'], cc: [] },
    { id: 'alert@thoropass.com', subject: 'Weekly Monitor Remediation Digest', sender: 'Thoropass | Alerts <no-reply@thoropass.com>', date: Date.UTC(2020, 2, 6, 8, 0), to: ['brad@ihrdc.com', 'jack@example.com'], cc: [] },
  ],
  sent: [{ id: 'sent-1@example.com', subject: 'Re: Board deck', sender: 'Jack Notarangelo <jack@example.com>', date: Date.UTC(2020, 2, 7, 9, 0), to: ['amy@ihrdc.com'], cc: ['newsletter@shop.example.com'] }],
};
const MEETINGS = {
  ok: true,
  missing: [],
  events: [{ uid: 'uid-product-review', title: 'Product Review Meeting', start: Date.UTC(2020, 2, 9, 14, 0) / 1000, calendar: 'Calendar', people: ['Brad@IHRDC.com'] }],
};


// Rows as sqlite3 -json prints them for the query in apple-messages.ts. Times
// are seconds from 1 January 2001, as the Messages database counts them.
const appleSeconds = (iso) => Date.parse(iso) / 1000 - 978307200;
/** An archived NSAttributedString, the only place newer Macs keep a message's words. */
const attributedBody = (text) => Buffer.concat([
  Buffer.from('040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484', 'hex'),
  Buffer.from('NSString'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, Buffer.byteLength(text)]), Buffer.from(text), Buffer.from('8692', 'hex'),
]).toString('hex').toUpperCase();
const MESSAGES = [
  // 10:30pm on 5 March in Boston; the words only in attributedBody.
  { seconds: appleSeconds('2020-03-06T03:30:00Z'), text: null, body: attributedBody('Running late, be there at 8'), chatId: 7, handles: '+16175550100' },
  { seconds: appleSeconds('2020-03-06T14:00:00Z'), text: 'On my way\nParking now', body: null, chatId: 7, handles: '+16175550100' },
  // A photo with no words.
  { seconds: appleSeconds('2020-03-06T14:05:00Z'), text: '\uFFFC', body: null, chatId: 7, handles: '+16175550100' },
  { seconds: appleSeconds('2020-03-06T15:00:00Z'), text: 'Who is this?', body: null, chatId: 8, handles: '+442079460000' },
];

let db;

before(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
});

beforeEach(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' });
  await db.doc('contacts/brad').set({ firstName: 'Brad', lastName: 'Donohue', emails: ['brad@ihrdc.com'], phones: [], tags: [], companyId: null });
  await db.doc('contacts/amy').set({ firstName: 'Amy', lastName: 'Lee', emails: ['amy@ihrdc.com'], phones: [], tags: [], companyId: null });
  write(MAIL_FIXTURE, MAIL);
  write(MEETINGS_FIXTURE, MEETINGS);
  // sqlite3 prints nothing when no message matches.
  write(MESSAGES_FIXTURE, '');
});

/** Runs the job as launchd does. Returns its output and exit code. */
function runJob(...args) {
  try {
    const output = execFileSync(`${functionsDir}node_modules/.bin/tsx`, ['src/mcp/autolink-contacts.ts', ...args], {
      cwd: functionsDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT_ID,
        MAISIE_MAIL_FIXTURE: MAIL_FIXTURE, MAISIE_MEETINGS_FIXTURE: MEETINGS_FIXTURE,
        MAISIE_MESSAGES_FIXTURE: MESSAGES_FIXTURE, TZ: 'America/New_York',
      },
    });
    return { output, code: 0 };
  } catch (err) {
    return { output: `${err.stdout}${err.stderr}`, code: err.status };
  }
}

const links = async () => (await db.collection('contactLinks').get()).docs.map(d => d.data());
const state = async () => (await db.doc('metadata/contactAutoLink').get()).data();

describe('automatic linking job', () => {
  it('links received and sent emails and meetings, and records how far it read', async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const found = (await links()).map(l => [l.contactId, l.type, l.title, l.detail]).sort();
    assert.deepEqual(found, [
      ['amy', 'email', 'Re: Board deck', 'Sent by Jack'],
      ['brad', 'email', 'Friday demo agenda', 'Brad Donohue <brad@ihrdc.com>'],
      ['brad', 'meeting', 'Product Review Meeting', 'IHRDC'],
    ]);
    const s = await state();
    assert.ok(s.mailCheckedThrough.toMillis() > Date.UTC(2026, 0, 1));
    assert.ok(s.meetingsCheckedThrough.toMillis() > Date.UTC(2026, 0, 1));
    assert.deepEqual(s.ownAddresses, ['jack@example.com']);
    assert.deepEqual(s.lastErrors, []);
  });

  it('a dry run prints what it would link and writes nothing, not even its progress', async () => {
    const { output, code } = await runJob('--dry-run');

    assert.equal(code, 0, output);
    assert.match(output, /Dry run: nothing was written/);
    assert.match(output, /Emails since .*: 3 read, 2 links to write/);
    assert.match(output, /Automated sender: 1/);
    assert.match(output, /Meetings since .*: 1 read, 1 links to write/);
    assert.deepEqual(await links(), []);
    assert.equal(await state(), undefined);
  });

  it('when Calendar refuses access, still links emails, and retries meetings next time', async () => {
    write(MEETINGS_FIXTURE, { ok: false, error: 'no_calendar_access', status: 2 });

    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /Privacy & Security > Calendars/);
    assert.deepEqual((await links()).map(l => l.type).sort(), ['email', 'email']);
    const s = await state();
    assert.ok(s.mailCheckedThrough);
    assert.equal(s.meetingsCheckedThrough, undefined, 'meetings must start from the same place next time');
    assert.match(s.lastErrors[0], /^Calendar:/);
  });

  it('when Mail output is unreadable, still links meetings, using Jack\'s addresses from the last run', async () => {
    await db.doc('contacts/jack').set({ firstName: 'Jack', lastName: 'Notarangelo', emails: ['jack@example.com'], phones: [], tags: [], companyId: null });
    await db.doc('metadata/contactAutoLink').set({ ownAddresses: ['jack@example.com'] });
    write(MEETINGS_FIXTURE, { ...MEETINGS, events: [{ ...MEETINGS.events[0], people: ['brad@ihrdc.com', 'jack@example.com'] }] });
    write(MAIL_FIXTURE, 'execution error: Mail got an error: AppleEvent timed out. (-1712)');

    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /unreadable output/);
    assert.deepEqual((await links()).map(l => [l.contactId, l.type]), [['brad', 'meeting']]);
    const s = await state();
    assert.equal(s.mailCheckedThrough, undefined, 'emails must start from the same place next time');
    assert.ok(s.meetingsCheckedThrough);
  });
  it('links a day of texts per contact, with the first line and the count, in Jack\'s time zone', async () => {
    await db.doc('contacts/brad').update({ phones: ['617-555-0100'] });
    write(MESSAGES_FIXTURE, MESSAGES);

    const { output, code } = await runJob();

    assert.equal(code, 0, output);
    const texts = (await links()).filter(l => l.type === 'text').map(l => [l.contactId, l.date, l.title, l.detail]).sort();
    assert.deepEqual(texts, [
      ['brad', '2020-03-05', 'Running late, be there at 8', '1 message'],
      ['brad', '2020-03-06', 'On my way', '2 messages'],
    ]);
    const s = await state();
    assert.ok(s.textsCheckedThrough.toMillis() > Date.UTC(2026, 0, 1));
    assert.deepEqual([s.lastTexts.linked, s.lastTexts.noContact], [2, 1]);
  });

  it('when Messages cannot be read, still links emails and meetings, and retries texts next time', async () => {
    write(MESSAGES_FIXTURE, 'Error: unable to open database "chat.db": authorization denied');

    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /Messages: Messages returned unreadable output/);
    assert.deepEqual((await links()).map(l => l.type).sort(), ['email', 'email', 'meeting']);
    const s = await state();
    assert.equal(s.textsCheckedThrough, undefined, 'texts must start from the same place next time');
    assert.ok(s.mailCheckedThrough && s.meetingsCheckedThrough);
  });
});
