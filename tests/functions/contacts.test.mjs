import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { all, read, reset, seed, setUp, tick, tool } from './helpers.mjs';

before(setUp);
beforeEach(reset);

/** Brad and Amy at IHRDC, as MAISIE would create them when Jack asks. */
async function ihrdcSetup() {
  const brad = await tool('save_contact', {
    first_name: 'Brad', last_name: 'Donohue', emails: ['Brad@IHRDC.com'],
    title: 'President & CEO', company: 'IHRDC', tags: ['client'],
  });
  const amy = await tool('save_contact', {
    first_name: 'Amy', last_name: 'Lee', emails: ['amy@ihrdc.com'], company: 'ihrdc',
  });
  return { brad, amy };
}

describe('save_contact', () => {
  it('creates a contact and its company, and stores emails in lower case without repeats', async () => {
    const result = await tool('save_contact', {
      first_name: ' Brad ', last_name: 'Donohue', emails: ['Brad@IHRDC.com', 'brad@ihrdc.com', ' '],
      phones: ['617-555-0100', '617-555-0100'], company: 'IHRDC',
    });

    assert.equal(result.success, true);
    assert.equal(result.companyCreated, true);
    const brad = await read(`contacts/${result.contactId}`);
    assert.equal(brad.firstName, 'Brad');
    assert.deepEqual(brad.emails, ['brad@ihrdc.com']);
    assert.deepEqual(brad.phones, ['617-555-0100']);
    assert.equal((await read(`companies/${brad.companyId}`)).name, 'IHRDC');
  });

  it('matches an existing company whatever its capitals, instead of creating a second one', async () => {
    const { brad, amy } = await ihrdcSetup();

    assert.equal(amy.companyCreated, false);
    assert.equal((await all('companies')).length, 1);
    assert.equal((await read(`contacts/${amy.contactId}`)).companyId, (await read(`contacts/${brad.contactId}`)).companyId);
  });

  it('refuses a second contact with an email address already on file, and names the existing one', async () => {
    const { brad } = await ihrdcSetup();

    const result = await tool('save_contact', { first_name: 'Bradley', emails: ['BRAD@ihrdc.com'] });

    assert.equal(result.success, false);
    assert.equal(result.existingContactId, brad.contactId);
    assert.match(result.error, /Brad Donohue/);
    assert.equal((await all('contacts')).length, 2);
  });

  it('refuses a new contact with no name', async () => {
    const result = await tool('save_contact', { emails: ['someone@example.com'] });
    assert.equal(result.success, false);
    assert.equal((await all('contacts')).length, 0);
  });

  it('on update, changes only the fields given', async () => {
    const { amy } = await ihrdcSetup();

    assert.equal((await tool('save_contact', { contact_id: amy.contactId, title: 'Director' })).success, true);

    const updated = await read(`contacts/${amy.contactId}`);
    assert.equal(updated.title, 'Director');
    assert.equal(updated.firstName, 'Amy');
    assert.deepEqual(updated.emails, ['amy@ihrdc.com']);
  });

  it('removes the company when given an empty company name', async () => {
    const { amy } = await ihrdcSetup();
    await tool('save_contact', { contact_id: amy.contactId, company: '' });
    assert.equal((await read(`contacts/${amy.contactId}`)).companyId, null);
  });

  it('does not create a company when the contact to update does not exist', async () => {
    const result = await tool('save_contact', { contact_id: 'no-such-contact', company: 'Ghost Ltd' });

    assert.equal(result.success, false);
    assert.equal((await all('companies')).length, 0);
  });
});

describe('find_contacts', () => {
  it('finds people by company name, email or tag, and returns the matching company', async () => {
    await ihrdcSetup();
    await tool('save_contact', { first_name: 'Tom', last_name: 'Ruth', emails: ['pastor@gracepres.org'], tags: ['church'] });

    const byCompany = await tool('find_contacts', { query: 'ihrdc' });
    assert.deepEqual(byCompany.contacts.map(c => c.name), ['Amy Lee', 'Brad Donohue']);
    assert.equal(byCompany.contacts[1].company, 'IHRDC');
    assert.deepEqual(byCompany.companies.map(c => c.name), ['IHRDC']);

    assert.deepEqual((await tool('find_contacts', { query: 'gracepres' })).contacts.map(c => c.name), ['Tom Ruth']);
    assert.deepEqual((await tool('find_contacts', { tag: 'CLIENT' })).contacts.map(c => c.name), ['Brad Donohue']);
  });

  it('lists everyone when there is no query, and says when the list was cut short', async () => {
    await ihrdcSetup();
    const result = await tool('find_contacts', { limit: 1 });
    assert.equal(result.contacts.length, 1);
    assert.equal(result.contactCount, 2);
    assert.equal(result.truncated, true);
  });

  it('shows the current company name after a rename', async () => {
    const { brad } = await ihrdcSetup();
    const { companyId } = await read(`contacts/${brad.contactId}`);

    await tool('save_company', { company_id: companyId, name: 'IHRDC Inc.' });

    const result = await tool('find_contacts', { query: 'donohue' });
    assert.equal(result.contacts[0].company, 'IHRDC Inc.');
  });

  it('copes with a contact written by the contacts page with fields missing', async () => {
    await seed('contacts/partial', { firstName: 'Pat', lastName: '' });
    const result = await tool('find_contacts', { query: 'pat' });
    assert.deepEqual(result.contacts.map(c => c.name), ['Pat']);
  });
});

describe('notes', () => {
  it('adds notes to a contact and returns them newest first with the contact', async () => {
    const { brad } = await ihrdcSetup();

    await tool('add_contact_note', { contact_id: brad.contactId, body: 'Wants the Friday demos kept to 30 minutes.' });
    await tick();
    await tool('add_contact_note', { contact_id: brad.contactId, body: '  Invoice goes to accounts payable.  ' });

    const result = await tool('get_contact', { contact_id: brad.contactId });
    assert.equal(result.contact.name, 'Brad Donohue');
    assert.equal(result.contact.company, 'IHRDC');
    assert.deepEqual(result.notes.map(n => n.body), [
      'Invoice goes to accounts payable.',
      'Wants the Friday demos kept to 30 minutes.',
    ]);
  });

  it('adds a note to a company, and the company shows its people and notes', async () => {
    const { brad } = await ihrdcSetup();
    const { companyId } = await read(`contacts/${brad.contactId}`);

    await tool('add_contact_note', { company_id: companyId, body: 'Contract renews in January.' });

    const result = await tool('get_company', { company_id: companyId });
    assert.deepEqual(result.contacts.map(c => c.name), ['Amy Lee', 'Brad Donohue']);
    assert.deepEqual(result.notes.map(n => n.body), ['Contract renews in January.']);
  });

  it('refuses a note with no target, two targets, an unknown target or no text', async () => {
    const { brad } = await ihrdcSetup();
    const { companyId } = await read(`contacts/${brad.contactId}`);

    for (const input of [
      { body: 'Nowhere to go' },
      { contact_id: brad.contactId, company_id: companyId, body: 'Both' },
      { contact_id: 'no-such-contact', body: 'Unknown' },
      { contact_id: brad.contactId, body: '   ' },
    ]) {
      assert.equal((await tool('add_contact_note', input)).success, false, JSON.stringify(input));
    }
    assert.equal((await all('contactNotes')).length, 0);
  });

  it('reports a contact or company that does not exist', async () => {
    assert.equal((await tool('get_contact', { contact_id: 'missing' })).success, false);
    assert.equal((await tool('get_company', { company_id: 'missing' })).success, false);
  });
});

describe('save_company', () => {
  it('creates a company with its website and tags', async () => {
    const result = await tool('save_company', { name: 'Grace Pres', website: 'gracepres.org', tags: ['church'] });

    assert.equal(result.created, true);
    const { name, website, tags } = await read(`companies/${result.companyId}`);
    assert.deepEqual({ name, website, tags }, { name: 'Grace Pres', website: 'gracepres.org', tags: ['church'] });
  });

  it('refuses a second company with the same name, whatever its capitals', async () => {
    await ihrdcSetup();
    const result = await tool('save_company', { name: 'Ihrdc' });
    assert.equal(result.success, false);
    assert.ok(result.existingCompanyId);
    assert.equal((await all('companies')).length, 1);
  });
});
