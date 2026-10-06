import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { all, reset, setUp, tool } from './helpers.mjs';

before(setUp);
beforeEach(reset);

/** Brad at IHRDC, and IHRDC's company id. */
async function bradSetup() {
  const { contactId } = await tool('save_contact', { first_name: 'Brad', last_name: 'Donohue', emails: ['brad@ihrdc.com'], company: 'IHRDC' });
  const { companies } = await tool('find_contacts', { query: 'ihrdc' });
  return { bradId: contactId, ihrdcId: companies[0].id };
}

/** An email as mail_search returns it: the message id comes without angle brackets. */
const DEMO_EMAIL = {
  type: 'email', title: 'Friday demo agenda', source_id: 'CAF7x9=abc@mail.ihrdc.com',
  detail: 'Brad Donohue <brad@ihrdc.com>', date: '2026-09-30T14:05:00Z',
};

describe('link_to_contact', () => {
  it('links an email, a meeting and a web page, and get_contact lists them newest first', async () => {
    const { bradId } = await bradSetup();

    assert.equal((await tool('link_to_contact', { contact_id: bradId, ...DEMO_EMAIL })).success, true);
    assert.equal((await tool('link_to_contact', {
      contact_id: bradId, type: 'meeting', title: 'IHRDC AI demo', date: '2026-09-25', detail: 'IHRDC',
      source_id: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F', url: 'https://teams.microsoft.com/l/meetup-join/abc',
    })).success, true);
    assert.equal((await tool('link_to_contact', {
      contact_id: bradId, type: 'url', title: 'Brad on LinkedIn', url: 'https://www.linkedin.com/in/example', note: 'For the intro post',
    })).success, true);

    // The web page has no date of its own, so it sorts by when it was linked: now.
    const { links } = await tool('get_contact', { contact_id: bradId });
    assert.deepEqual(links.map(l => l.type), ['url', 'email', 'meeting']);
    assert.equal(links[0].note, 'For the intro post');
    assert.equal(links[1].sourceId, 'CAF7x9=abc@mail.ihrdc.com');
    assert.equal(links[1].date, '2026-09-30T14:05:00.000Z');
    assert.equal(links[2].date, '2026-09-25');
  });

  it('accepts a message id with angle brackets and stores it without them', async () => {
    const { bradId } = await bradSetup();
    await tool('link_to_contact', { contact_id: bradId, ...DEMO_EMAIL, source_id: '<CAF7x9=abc@mail.ihrdc.com>' });
    const [link] = await all('contactLinks');
    assert.equal(link.sourceId, 'CAF7x9=abc@mail.ihrdc.com');
  });

  it('refuses the same email twice, even written with angle brackets', async () => {
    const { bradId } = await bradSetup();
    const first = await tool('link_to_contact', { contact_id: bradId, ...DEMO_EMAIL });

    const again = await tool('link_to_contact', { contact_id: bradId, ...DEMO_EMAIL, source_id: `<${DEMO_EMAIL.source_id}>`, title: 'Re: Friday demo agenda' });

    assert.equal(again.success, false);
    assert.equal(again.existingLinkId, first.linkId);
    assert.equal((await all('contactLinks')).length, 1);
  });

  it('treats each date of a recurring meeting as its own link', async () => {
    const { bradId } = await bradSetup();
    const weekly = { contact_id: bradId, type: 'meeting', title: 'IHRDC AI demo', source_id: 'SERIES-UID' };

    assert.equal((await tool('link_to_contact', { ...weekly, date: '2026-10-09' })).success, true);
    assert.equal((await tool('link_to_contact', { ...weekly, date: '2026-10-16' })).success, true);
    assert.equal((await tool('link_to_contact', { ...weekly, date: '2026-10-16T15:00:00Z' })).success, false);
  });

  it('can link the same email to a person and to their company', async () => {
    const { bradId, ihrdcId } = await bradSetup();
    assert.equal((await tool('link_to_contact', { contact_id: bradId, ...DEMO_EMAIL })).success, true);
    assert.equal((await tool('link_to_contact', { company_id: ihrdcId, ...DEMO_EMAIL })).success, true);

    const company = await tool('get_company', { company_id: ihrdcId });
    assert.deepEqual(company.links.map(l => l.title), ['Friday demo agenda']);
  });

  it('refuses anything that is not a safe, complete link', async () => {
    const { bradId, ihrdcId } = await bradSetup();
    const cases = {
      'no target': { ...DEMO_EMAIL },
      'two targets': { contact_id: bradId, company_id: ihrdcId, ...DEMO_EMAIL },
      'unknown contact': { contact_id: 'missing', ...DEMO_EMAIL },
      'unknown type': { contact_id: bradId, type: 'file', title: 'Report' },
      'no title': { contact_id: bradId, ...DEMO_EMAIL, title: '  ' },
      'email without a message id': { contact_id: bradId, type: 'email', title: 'Hello' },
      'meeting without a date': { contact_id: bradId, type: 'meeting', title: 'Lunch' },
      'meeting with a bad date': { contact_id: bradId, type: 'meeting', title: 'Lunch', date: 'next Tuesday' },
      'web page without a url': { contact_id: bradId, type: 'url', title: 'Site' },
      'javascript: url': { contact_id: bradId, type: 'url', title: 'Click me', url: 'javascript:alert(1)' },
      'file: url': { contact_id: bradId, type: 'url', title: 'Local', url: 'file:///etc/passwd' },
      'meeting with an unsafe join link': { contact_id: bradId, type: 'meeting', title: 'Call', date: '2026-10-09', url: 'data:text/html,hi' },
    };
    for (const [label, input] of Object.entries(cases)) {
      assert.equal((await tool('link_to_contact', input)).success, false, label);
    }
    assert.equal((await all('contactLinks')).length, 0);
  });
});

describe('remove_contact_link', () => {
  it('removes one link and leaves the rest', async () => {
    const { bradId } = await bradSetup();
    const email = await tool('link_to_contact', { contact_id: bradId, ...DEMO_EMAIL });
    await tool('link_to_contact', { contact_id: bradId, type: 'url', title: 'Site', url: 'https://ihrdc.com' });

    const result = await tool('remove_contact_link', { link_id: email.linkId });

    assert.deepEqual(result, { success: true, removed: { type: 'email', title: 'Friday demo agenda' } });
    assert.deepEqual((await tool('get_contact', { contact_id: bradId })).links.map(l => l.title), ['Site']);
  });

  it('reports a link that does not exist', async () => {
    assert.equal((await tool('remove_contact_link', { link_id: 'missing' })).success, false);
  });
});
