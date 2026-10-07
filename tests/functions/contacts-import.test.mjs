import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { all, card, importApple, read, reset, seed, setUp, tool } from './helpers.mjs';

before(setUp);
beforeEach(reset);

const BRAD = card({ appleId: 'A-BRAD', firstName: 'Brad', lastName: 'Donohue', organization: 'IHRDC', jobTitle: 'President & CEO', emails: ['Brad@IHRDC.com'], phones: ['+1 (617) 555-0100'] });
const TOM = card({ appleId: 'A-TOM', firstName: 'Tom', lastName: 'Ruth', organization: 'Grace Presbyterian', emails: ['pastor@gracepres.org'] });
const IHRDC_CARD = card({ appleId: 'A-ORG', kind: 'organization', organization: 'IHRDC' });
const BLANK_CARD = card({ appleId: 'A-BLANK', phones: ['617-555-0199'] });

/** Counts must account for every card read. */
function assertBalanced(s) {
  assert.equal(s.created + s.updated + s.unchanged + s.companyCards + s.skipped, s.read);
}

describe('first import', () => {
  it('creates people and their companies, adds company cards, and skips cards with no name', async () => {
    const s = await importApple([BRAD, TOM, IHRDC_CARD, BLANK_CARD]);

    assert.deepEqual(
      { created: s.created, companyCards: s.companyCards, skipped: s.skipped, companiesCreated: s.companiesCreated },
      { created: 2, companyCards: 1, skipped: 1, companiesCreated: 2 });
    assertBalanced(s);

    const brad = (await tool('find_contacts', { query: 'donohue' })).contacts[0];
    assert.deepEqual([brad.company, brad.title, brad.emails, brad.phones],
      ['IHRDC', 'President & CEO', ['brad@ihrdc.com'], ['+1 (617) 555-0100']]);
    assert.equal((await read(`contacts/${brad.id}`)).appleContactId, 'A-BRAD');
    assert.deepEqual((await all('companies')).map(c => c.name).sort(), ['Grace Presbyterian', 'IHRDC']);
  });

  it('a dry run reports the same counts and writes nothing', async () => {
    const s = await importApple([BRAD, TOM, IHRDC_CARD], { dryRun: true });

    assert.equal(s.dryRun, true);
    assert.equal(s.created, 2);
    assert.deepEqual(s.examples.created, ['Brad Donohue', 'Tom Ruth']);
    assert.equal((await all('contacts')).length, 0);
    assert.equal((await all('companies')).length, 0);
  });

  it('writes more than one batch for a large address book', async () => {
    const people = Array.from({ length: 450 }, (_, i) =>
      card({ appleId: `A-${i}`, firstName: 'Person', lastName: String(i).padStart(3, '0'), emails: [`p${i}@example.com`] }));

    assert.equal((await importApple(people)).created, 450);
    assert.equal((await all('contacts')).length, 450);
  });
});

describe('running it again', () => {
  it('changes nothing and creates no duplicates', async () => {
    await importApple([BRAD, TOM, IHRDC_CARD]);

    const s = await importApple([BRAD, TOM, IHRDC_CARD]);

    assert.deepEqual([s.created, s.updated, s.unchanged, s.companiesCreated], [0, 0, 2, 0]);
    assert.equal((await all('contacts')).length, 2);
    assert.equal((await all('companies')).length, 2);
  });

  it('brings in an email changed in iCloud, matching by the earlier import even with no shared email', async () => {
    await importApple([BRAD]);

    const s = await importApple([{ ...BRAD, emails: ['brad.donohue@gmail.com'] }]);

    assert.equal(s.updated, 1);
    const [brad] = await all('contacts');
    assert.deepEqual(brad.emails, ['brad.donohue@gmail.com']);
  });
});

describe("merging into Jack's existing contacts", () => {
  it("matches a contact made in MAISIE by email, takes iCloud's details, and keeps its tags, notes and links", async () => {
    const { contactId } = await tool('save_contact', { first_name: 'Brad', last_name: 'Donohue', emails: ['brad@ihrdc.com'], title: 'CEO', tags: ['client'] });
    await tool('add_contact_note', { contact_id: contactId, body: 'Prefers Teams to email.' });
    await tool('link_to_contact', { contact_id: contactId, type: 'url', title: 'Site', url: 'https://ihrdc.com' });

    const s = await importApple([{ ...BRAD, emails: ['brad@ihrdc.com', 'brad.donohue@gmail.com'] }]);

    assert.deepEqual([s.created, s.updated], [0, 1]);
    const brad = await read(`contacts/${contactId}`);
    assert.equal(brad.title, 'President & CEO', "iCloud's title replaces MAISIE's");
    assert.deepEqual(brad.tags, ['client'], 'tags are kept only in MAISIE');
    assert.deepEqual(brad.emails, ['brad@ihrdc.com', 'brad.donohue@gmail.com']);
    assert.deepEqual(brad.phones, ['+1 (617) 555-0100']);
    assert.equal((await read(`companies/${brad.companyId}`)).name, 'IHRDC');
    assert.equal(brad.appleContactId, 'A-BRAD');
    const full = await tool('get_contact', { contact_id: contactId });
    assert.equal(full.notes.length, 1);
    assert.equal(full.links.length, 1);
  });

  it('matches by name when exactly one contact has that name', async () => {
    const { contactId } = await tool('save_contact', { first_name: 'Tom', last_name: 'Ruth' });

    const s = await importApple([TOM]);

    assert.equal(s.updated, 1);
    assert.deepEqual((await read(`contacts/${contactId}`)).emails, ['pastor@gracepres.org']);
    assert.equal((await all('contacts')).length, 1);
  });

  it('does not guess when two contacts share the name: it creates a new one', async () => {
    await tool('save_contact', { first_name: 'John', last_name: 'Smith', emails: ['john@one.com'] });
    await tool('save_contact', { first_name: 'John', last_name: 'Smith', emails: ['john@two.com'] });

    const s = await importApple([card({ appleId: 'A-JS', firstName: 'John', lastName: 'Smith' })]);

    assert.equal(s.created, 1);
    assert.equal((await all('contacts')).length, 3);
  });

  it('leaves an email with the contact who already has it', async () => {
    const { contactId: amyId } = await tool('save_contact', { first_name: 'Amy', last_name: 'Lee', emails: ['shared@ihrdc.com'] });
    const { contactId: bradId } = await tool('save_contact', { first_name: 'Brad', last_name: 'Donohue', emails: ['brad@ihrdc.com'] });

    await importApple([{ ...BRAD, emails: ['brad@ihrdc.com', 'shared@ihrdc.com'] }]);

    assert.deepEqual((await read(`contacts/${amyId}`)).emails, ['shared@ihrdc.com']);
    assert.deepEqual((await read(`contacts/${bradId}`)).emails, ['brad@ihrdc.com']);
  });

  it('treats the same phone number written differently as one number', async () => {
    await importApple([{ ...BRAD, phones: ['+1 (617) 555-0100', '617.555.0100', '(617) 555-0101'] }]);

    assert.deepEqual((await all('contacts'))[0].phones, ['+1 (617) 555-0100', '(617) 555-0101']);
  });

  it('merges two Apple cards for the same person into one contact', async () => {
    const s = await importApple([
      BRAD,
      card({ appleId: 'A-BRAD-2', firstName: 'Brad', lastName: 'Donohue', emails: ['brad@ihrdc.com'], phones: ['617-555-0102'] }),
    ]);

    assert.deepEqual([s.created, s.updated], [1, 1]);
    assertBalanced(s);
    const [brad] = await all('contacts');
    assert.deepEqual(brad.phones, ['+1 (617) 555-0100', '617-555-0102']);
  });

  it('reuses an existing company whatever its capitals', async () => {
    await tool('save_company', { name: 'Ihrdc' });
    const s = await importApple([BRAD]);
    assert.equal(s.companiesCreated, 0);
    assert.equal((await all('companies')).length, 1);
  });
});

describe('iCloud is the master copy', () => {
  it('a correction in iCloud replaces the old name, title, company and phone', async () => {
    await importApple([BRAD]);

    await importApple([{ ...BRAD, firstName: 'Bradley', jobTitle: 'Chair', organization: 'IHRDC Inc', phones: ['617-555-0199'] }]);

    const [brad] = await all('contacts');
    assert.deepEqual([brad.firstName, brad.title, brad.phones], ['Bradley', 'Chair', ['617-555-0199']]);
    assert.equal((await read(`companies/${brad.companyId}`)).name, 'IHRDC Inc');
  });

  it('a field cleared in iCloud is cleared in MAISIE', async () => {
    await importApple([BRAD]);

    await importApple([{ ...BRAD, jobTitle: '', organization: '', phones: [] }]);

    const [brad] = await all('contacts');
    assert.deepEqual([brad.title, brad.companyId, brad.phones], [null, null, []]);
  });

  it('MAISIE changes only the tags of a contact from iCloud', async () => {
    await importApple([BRAD]);
    const [brad] = await all('contacts');

    const refused = await tool('save_contact', { contact_id: brad.id, title: 'CEO' });
    assert.equal(refused.success, false);
    assert.match(refused.error, /come from iCloud/);
    assert.equal(refused.fromICloud, true);
    assert.equal((await tool('save_contact', { contact_id: brad.id, company: 'Acme' })).success, false);

    assert.equal((await tool('save_contact', { contact_id: brad.id, tags: ['client'] })).success, true);
    const after = await read(`contacts/${brad.id}`);
    assert.deepEqual([after.title, after.tags], ['President & CEO', ['client']]);
    assert.equal((await tool('find_contacts', { query: 'donohue' })).contacts[0].fromICloud, true);
  });
});

describe('cards deleted in iCloud', () => {
  it('removes the contact and its automatic links', async () => {
    await importApple([BRAD, TOM]);
    const tom = (await all('contacts')).find(c => c.lastName === 'Ruth');
    await seed('contactLinks/auto_tom', { contactId: tom.id, companyId: null, type: 'email', title: 'Sermon notes', sourceId: 'm1@gracepres.org', url: null, date: '2020-03-01', detail: null, note: null, origin: 'auto' });

    const s = await importApple([BRAD]);

    assert.deepEqual([s.removed, s.keptNotInICloud, s.removalsHeld], [1, 0, 0]);
    assert.deepEqual(s.examples.removed, ['Tom Ruth']);
    assert.deepEqual((await all('contacts')).map(c => c.firstName), ['Brad']);
    assert.equal(await read('contactLinks/auto_tom'), undefined);
  });

  it('keeps a contact with a note as a MAISIE contact, marked no longer in iCloud', async () => {
    await importApple([BRAD, TOM]);
    const tom = (await all('contacts')).find(c => c.lastName === 'Ruth');
    await tool('add_contact_note', { contact_id: tom.id, body: 'Officer meeting on Wednesdays.' });

    const s = await importApple([BRAD]);

    assert.deepEqual([s.removed, s.keptNotInICloud], [0, 1]);
    const kept = await read(`contacts/${tom.id}`);
    assert.equal(kept.appleContactId, null);
    assert.ok(kept.leftICloudAt, 'marked as no longer in iCloud');
    assert.equal((await tool('get_contact', { contact_id: tom.id })).notes.length, 1);
    assert.equal((await tool('save_contact', { contact_id: tom.id, title: 'Pastor' })).success, true, 'now MAISIE owns its details');
  });

  it('keeps a contact with a hand-made link, but not one with only automatic links', async () => {
    await importApple([BRAD, TOM]);
    const tom = (await all('contacts')).find(c => c.lastName === 'Ruth');
    await tool('link_to_contact', { contact_id: tom.id, type: 'url', title: 'Grace Pres', url: 'https://gracepres.org' });

    const s = await importApple([BRAD]);

    assert.deepEqual([s.removed, s.keptNotInICloud], [0, 1]);
  });

  it('when the person comes back to iCloud, ties them to the new card and clears the mark', async () => {
    await importApple([BRAD, TOM]);
    const tom = (await all('contacts')).find(c => c.lastName === 'Ruth');
    await tool('add_contact_note', { contact_id: tom.id, body: 'Officer meeting on Wednesdays.' });
    await importApple([BRAD]);

    await importApple([BRAD, { ...TOM, appleId: 'A-TOM-NEW' }]);

    const back = await read(`contacts/${tom.id}`);
    assert.equal(back.appleContactId, 'A-TOM-NEW');
    assert.equal(back.leftICloudAt, null);
    assert.equal((await all('contacts')).length, 2);
  });

  it('never removes a contact made in MAISIE', async () => {
    await importApple([BRAD]);
    await tool('save_contact', { first_name: 'Amy', last_name: 'Lee', emails: ['amy@example.org'] });

    const s = await importApple([BRAD]);

    assert.equal(s.removed, 0);
    assert.equal((await all('contacts')).length, 2);
  });

  it('a dry run reports removals and removes nothing', async () => {
    await importApple([BRAD, TOM]);

    const s = await importApple([BRAD], { dryRun: true });

    assert.deepEqual([s.removed, s.examples.removed], [1, ['Tom Ruth']]);
    assert.equal((await all('contacts')).length, 2);
  });

  it('holds removals when more than expected would go, and makes them when Jack allows it', async () => {
    const people = Array.from({ length: 20 }, (_, i) =>
      card({ appleId: `A-${i}`, firstName: 'Person', lastName: String(i), emails: [`p${i}@example.com`] }));
    await importApple(people);

    const held = await importApple(people.slice(0, 5));
    assert.deepEqual([held.removalsHeld, held.removed], [15, 0]);
    assert.equal((await all('contacts')).length, 20);

    const allowed = await importApple(people.slice(0, 5), { allowManyRemovals: true });
    assert.deepEqual([allowed.removalsHeld, allowed.removed], [0, 15]);
    assert.equal((await all('contacts')).length, 5);
  });

  it('removes nothing when the read finds no cards at all', async () => {
    await importApple([BRAD, TOM]);

    const s = await importApple([]);

    assert.deepEqual([s.removalsHeld, s.removed], [2, 0]);
    assert.equal((await all('contacts')).length, 2);
  });
});
