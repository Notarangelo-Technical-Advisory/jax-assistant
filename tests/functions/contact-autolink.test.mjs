// Tests for automatic contact linking (CRM Phase 4): which emails, meetings and
// text messages are tied to which contacts. The Mac-side readers are covered in
// tests/mcp/autolink.test.mjs.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { all, read, reset, seed, setUp, tool } from './helpers.mjs';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = fromFunctions('firebase-admin');
const { autoLinkItems, autoLinkTexts, isAutomatedSender } = fromFunctions('./lib/tools/contact-autolink.js');

before(setUp);
beforeEach(async () => {
  await reset();
  await seed('contacts/brad', { firstName: 'Brad', lastName: 'Donohue', emails: ['brad@ihrdc.com'], phones: [], tags: [], companyId: null });
  await seed('contacts/amy', { firstName: 'Amy', lastName: 'Lee', emails: ['amy@ihrdc.com'], phones: [], tags: [], companyId: null });
  await seed('contacts/jack', { firstName: 'Jack', lastName: 'Notarangelo', emails: ['jack@example.com'], phones: [], tags: [], companyId: null });
});

const OWN = ['Jack@Example.com'];
const link = (items, options = {}) => autoLinkItems(admin.firestore(), items, { ownAddresses: OWN, ...options });

const email = (fields = {}) => ({
  type: 'email', sourceId: '<CAF7x9=abc@mail.ihrdc.com>', title: 'Friday demo agenda',
  date: '2020-03-06T14:05:00.000Z', detail: 'Brad Donohue <brad@ihrdc.com>',
  addresses: ['Brad@IHRDC.com', 'amy@ihrdc.com', 'jack@example.com', 'stranger@example.org'],
  ...fields,
});
const meeting = (fields = {}) => ({
  type: 'meeting', sourceId: 'uid-product-review', title: 'Product Review Meeting',
  date: '2020-03-09T14:00:00.000Z', detail: 'IHRDC', addresses: ['brad@ihrdc.com'],
  ...fields,
});

const linksOf = async (contactId) => (await all('contactLinks')).filter(l => l.contactId === contactId);

describe('emails', () => {
  it('links an email to its sender and everyone copied, but never to Jack', async () => {
    const s = await link([email()]);

    assert.deepEqual([s.linked, s.itemsLinked], [2, 1]);
    assert.equal((await linksOf('jack')).length, 0);
    const [brad] = await linksOf('brad');
    assert.deepEqual(
      [brad.type, brad.title, brad.sourceId, brad.date, brad.detail, brad.origin],
      ['email', 'Friday demo agenda', 'CAF7x9=abc@mail.ihrdc.com', '2020-03-06T14:05:00.000Z', 'Brad Donohue <brad@ihrdc.com>', 'auto']);
    assert.equal((await linksOf('amy')).length, 1);
  });

  it('a second run of the same emails writes nothing new', async () => {
    await link([email()]);
    const again = await link([email()]);

    assert.deepEqual([again.linked, again.alreadyLinked], [0, 2]);
    assert.equal((await all('contactLinks')).length, 2);
  });

  it('does not repeat an email Jack already linked by hand', async () => {
    await tool('link_to_contact', { contact_id: 'brad', type: 'email', title: 'Agenda', source_id: 'CAF7x9=abc@mail.ihrdc.com', date: '2020-03-06' });

    const s = await link([email()]);

    assert.equal(s.alreadyLinked, 1);
    const brad = await linksOf('brad');
    assert.deepEqual(brad.map(l => [l.title, l.origin]), [['Agenda', undefined]]);
  });

  it('skips alerts from automated senders, even when a contact is copied', async () => {
    const s = await link([
      email({ sourceId: 'alert-1', title: '[Action Required] Weekly Monitor Remediation Digest', sender: 'no-reply@thoropass.com',
        addresses: ['no-reply@thoropass.com', 'brad@ihrdc.com', 'jack@example.com'] }),
      email({ sourceId: 'real-1', sender: 'brad@ihrdc.com', addresses: ['brad@ihrdc.com', 'jack@example.com'] }),
    ]);

    assert.deepEqual([s.automated, s.linked], [1, 1]);
    assert.deepEqual((await linksOf('brad')).map(l => l.sourceId), ['real-1']);
  });

  it('knows automated senders from people', () => {
    for (const a of ['no-reply@thoropass.com', 'NoReply@github.com', 'do-not-reply@bank.example', 'donotreply@x.org',
      'notifications@github.com', 'notification+abc@slack.com', 'alerts@example.com', 'MAILER-DAEMON@ihrdc.com', 'bounces+123@sendgrid.net']) {
      assert.equal(isAutomatedSender(a), true, a);
    }
    for (const a of ['brad@ihrdc.com', 'noreen@example.com', 'alerton@example.com', 'replyall@example.com', '']) {
      assert.equal(isAutomatedSender(a), false, a);
    }
  });

  it('counts an email where nobody is a contact, and links nothing', async () => {
    const s = await link([email({ addresses: ['news@shop.example.com', 'jack@example.com'] })]);

    assert.deepEqual([s.noContact, s.linked], [1, 0]);
    assert.equal((await all('contactLinks')).length, 0);
  });
});

describe('meetings', () => {
  it('links each occurrence of a recurring meeting separately', async () => {
    const s = await link([meeting(), meeting({ date: '2020-03-16T14:00:00.000Z' })]);

    assert.equal(s.linked, 2);
    const dates = (await linksOf('brad')).map(l => [l.type, l.date, l.detail]).sort();
    assert.deepEqual(dates, [
      ['meeting', '2020-03-09T14:00:00.000Z', 'IHRDC'],
      ['meeting', '2020-03-16T14:00:00.000Z', 'IHRDC'],
    ]);
  });

  it('skips a meeting or email with more than 15 other people, and links one with 15', async () => {
    const people = n => Array.from({ length: n }, (_, i) => `person${i}@example.org`);
    const s = await link([
      meeting({ sourceId: 'all-hands', addresses: ['brad@ihrdc.com', ...people(15), 'jack@example.com'] }),
      meeting({ sourceId: 'team', addresses: ['brad@ihrdc.com', ...people(14), 'jack@example.com'] }),
    ]);

    assert.deepEqual([s.tooManyPeople, s.linked], [1, 1]);
    assert.deepEqual((await linksOf('brad')).map(l => l.sourceId), ['team']);
  });
});

describe('removing an automatic link', () => {
  it('stays removed: the next run does not link it again', async () => {
    await link([email()]);
    const [brad] = await linksOf('brad');

    const removed = await tool('remove_contact_link', { link_id: brad.id });
    assert.equal(removed.notLinkedAgain, true);
    assert.equal((await read(`contactLinkDismissals/${brad.id}`)).contactId, 'brad');

    const again = await link([email()]);
    assert.deepEqual([again.dismissed, again.linked], [1, 0]);
    assert.equal((await linksOf('brad')).length, 0);
  });

  it('removing a link made by hand records no dismissal', async () => {
    const made = await tool('link_to_contact', { contact_id: 'brad', type: 'url', title: 'Site', url: 'https://ihrdc.com' });
    await tool('remove_contact_link', { link_id: made.linkId });

    assert.equal((await all('contactLinkDismissals')).length, 0);
  });
});

describe('dry run', () => {
  it('reports the same counts and writes nothing', async () => {
    const s = await link([email(), meeting()], { dryRun: true });

    assert.deepEqual([s.dryRun, s.linked, s.itemsLinked], [true, 3, 2]);
    assert.deepEqual(s.examples.sort(), ['Amy Lee: Friday demo agenda', 'Brad Donohue: Friday demo agenda', 'Brad Donohue: Product Review Meeting']);
    assert.equal((await all('contactLinks')).length, 0);
  });
});

describe('get_contact with many links', () => {
  it('returns the 100 newest dated links and every web page, newest first', async () => {
    const items = Array.from({ length: 105 }, (_, i) =>
      email({ sourceId: `msg${i}@ihrdc.com`, title: `Email ${i}`, date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(), addresses: ['brad@ihrdc.com'] }));
    await link(items);
    await tool('link_to_contact', { contact_id: 'brad', type: 'url', title: 'IHRDC website', url: 'https://ihrdc.com' });

    const { links } = await tool('get_contact', { contact_id: 'brad' });

    assert.equal(links.length, 101);
    const emails = links.filter(l => l.type === 'email');
    assert.equal(emails[0].title, 'Email 104');
    assert.equal(emails[0].automatic, true);
    assert.ok(!links.some(l => l.title === 'Email 4'), 'the oldest emails are left out');
    assert.ok(links.some(l => l.title === 'IHRDC website' && l.automatic === false));
  });
});

describe('text messages', () => {
  // One conversation on one day, as the reader on Jack's Mac groups them.
  const textDay = (fields = {}) => ({
    chatId: '7', day: '2020-03-06', firstAt: '2020-03-06T13:00:00.000Z', count: 6,
    firstLine: 'See you at the demo on Friday', handles: ['+1 (617) 555-0100'], ...fields,
  });
  const texts = (items, options = {}) => autoLinkTexts(admin.firestore(), items, options);

  beforeEach(async () => {
    await seed('contacts/brad', { firstName: 'Brad', lastName: 'Donohue', emails: ['brad@ihrdc.com'], phones: ['617.555.0100'], tags: [], companyId: null });
  });

  it('links a day of texts to the contact with that phone number, however it is written', async () => {
    const s = await texts([textDay(), textDay({ chatId: '8', handles: ['+44 20 7946 0000'] })]);

    assert.deepEqual([s.linked, s.noContact], [1, 1]);
    const [brad] = await linksOf('brad');
    assert.equal(brad.type, 'text');
    assert.equal(brad.date, '2020-03-06');
    assert.equal(brad.title, 'See you at the demo on Friday');
    assert.equal(brad.detail, '6 messages');
    assert.equal(brad.origin, 'auto');
    assert.equal((await all('contactLinks')).length, 1);
  });

  it('matches the email address someone uses for iMessage', async () => {
    await texts([textDay({ handles: ['Brad@IHRDC.com'], count: 1 })]);

    const [brad] = await linksOf('brad');
    assert.equal(brad.detail, '1 message');
  });

  it('gives a contact one link a day, counting every conversation they were in', async () => {
    await texts([
      textDay({ chatId: '7', firstAt: '2020-03-06T15:00:00.000Z', count: 2, firstLine: 'Later chat' }),
      textDay({ chatId: '9', firstAt: '2020-03-06T09:00:00.000Z', count: 3, firstLine: 'Morning group chat', handles: ['6175550100', 'amy@ihrdc.com'] }),
      textDay({ day: '2020-03-07', firstAt: '2020-03-07T09:00:00.000Z', count: 1, firstLine: 'Next day' }),
    ]);

    const brad = (await linksOf('brad')).sort((a, b) => a.date.localeCompare(b.date));
    assert.deepEqual(brad.map(l => [l.date, l.title, l.detail]), [
      ['2020-03-06', 'Morning group chat', '5 messages'],
      ['2020-03-07', 'Next day', '1 message'],
    ]);
    const [amy] = await linksOf('amy');
    assert.deepEqual([amy.title, amy.detail], ['Morning group chat', '3 messages']);
  });

  it('updates the day as more texts arrive, without adding a second link', async () => {
    await texts([textDay({ count: 2 })]);
    const again = await texts([textDay({ count: 5 })]);
    const unchanged = await texts([textDay({ count: 5 })]);

    assert.deepEqual([again.linked, again.updated], [0, 1]);
    assert.deepEqual([unchanged.updated, unchanged.alreadyLinked], [0, 1]);
    const links = await linksOf('brad');
    assert.equal(links.length, 1);
    assert.equal(links[0].detail, '5 messages');
    assert.ok(links[0].createdAt, 'the update keeps the original link');
  });

  it('stays removed when Jack removes a day of texts', async () => {
    await texts([textDay()]);
    const [brad] = await linksOf('brad');
    await tool('remove_contact_link', { link_id: brad.id });

    const again = await texts([textDay({ count: 9 })]);

    assert.deepEqual([again.dismissed, again.linked, again.updated], [1, 0, 0]);
    assert.equal((await linksOf('brad')).length, 0);
  });

  it('skips a group chat of more than 15 other people', async () => {
    const crowd = Array.from({ length: 16 }, (_, i) => `+1 617 555 01${String(i).padStart(2, '0')}`);
    const s = await texts([textDay({ handles: crowd })]);

    assert.deepEqual([s.tooManyPeople, s.linked], [1, 0]);
  });

  it('keeps only the first line, cut to 80 characters, and names a day with no words', async () => {
    const long = 'Thank you for leading the session today. ' + 'It helped the whole team understand the plan. '.repeat(3);
    await texts([
      textDay({ firstLine: `${long}\nSecond line, never stored` }),
      textDay({ day: '2020-03-08', firstLine: '' }),
    ]);

    const brad = (await linksOf('brad')).sort((a, b) => a.date.localeCompare(b.date));
    assert.equal(brad[0].title.length, 80);
    assert.ok(brad[0].title.endsWith('…'));
    assert.ok(!brad[0].title.includes('Second line'));
    assert.equal(brad[1].title, '(photo or attachment)');
  });

  it('writes nothing in a dry run', async () => {
    const s = await texts([textDay()], { dryRun: true });

    assert.deepEqual([s.dryRun, s.linked], [true, 1]);
    assert.deepEqual(s.examples, ['Brad Donohue: 2020-03-06, 6 messages']);
    assert.equal((await all('contactLinks')).length, 0);
  });

  it('shows text links in get_contact, and MAISIE cannot add one by hand', async () => {
    await texts([textDay()]);

    const { links } = await tool('get_contact', { contact_id: 'brad' });
    assert.ok(links.some(l => l.type === 'text' && l.automatic === true && l.detail === '6 messages'));
    const refused = await tool('link_to_contact', { contact_id: 'brad', type: 'text', title: 'Hi', date: '2020-03-06' });
    assert.equal(refused.success, false);
  });
});
