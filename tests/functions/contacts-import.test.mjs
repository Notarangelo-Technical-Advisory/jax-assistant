import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { all, card, importApple, read, reset, setUp, tool } from './helpers.mjs';

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

  it('picks up a new email added in Apple Contacts, matching by the earlier import even with no shared email', async () => {
    await importApple([BRAD]);

    const s = await importApple([{ ...BRAD, emails: ['brad.donohue@gmail.com'] }]);

    assert.equal(s.updated, 1);
    const [brad] = await all('contacts');
    assert.deepEqual(brad.emails, ['brad@ihrdc.com', 'brad.donohue@gmail.com']);
  });
});

describe("merging into Jack's existing contacts", () => {
  it("matches by email, fills blanks, adds new numbers, and never overwrites Jack's edits or touches notes and links", async () => {
    const { contactId } = await tool('save_contact', { first_name: 'Brad', last_name: 'Donohue', emails: ['brad@ihrdc.com'], title: 'CEO', tags: ['client'] });
    await tool('add_contact_note', { contact_id: contactId, body: 'Prefers Teams to email.' });
    await tool('link_to_contact', { contact_id: contactId, type: 'url', title: 'Site', url: 'https://ihrdc.com' });

    const s = await importApple([{ ...BRAD, emails: ['brad@ihrdc.com', 'brad.donohue@gmail.com'] }]);

    assert.deepEqual([s.created, s.updated], [0, 1]);
    const brad = await read(`contacts/${contactId}`);
    assert.equal(brad.title, 'CEO', "Jack's title is kept");
    assert.deepEqual(brad.tags, ['client']);
    assert.deepEqual(brad.emails, ['brad@ihrdc.com', 'brad.donohue@gmail.com']);
    assert.deepEqual(brad.phones, ['+1 (617) 555-0100']);
    assert.equal((await read(`companies/${brad.companyId}`)).name, 'IHRDC', 'a blank company is filled');
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
    const { contactId } = await tool('save_contact', { first_name: 'Brad', last_name: 'Donohue', emails: ['brad@ihrdc.com'], phones: ['617.555.0100'] });

    await importApple([{ ...BRAD, phones: ['+1 (617) 555-0100', '(617) 555-0101'] }]);

    assert.deepEqual((await read(`contacts/${contactId}`)).phones, ['617.555.0100', '(617) 555-0101']);
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
