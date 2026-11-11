// How Maisie says when a meeting is, and which join link and passcode she
// gives for it. These helpers are pure, so no emulator data is needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const {
  formatEventTime, formatEventWhen, extractMeetingLink, extractPasscode,
} = fromFunctions('./lib/tools/calendar-read.js');

// Node puts a narrow no-break space before AM and PM, so match any space.
const WINTER_9_05 = new Date('2026-11-11T14:05:00Z'); // 9:05 AM EST
const SUMMER_2_30 = new Date('2026-07-01T18:30:00Z'); // 2:30 PM EDT

describe('Event time', () => {
  it('is in Eastern Standard Time in winter', () => {
    assert.match(formatEventTime(WINTER_9_05), /^9:05\sAM$/);
  });

  it('is in Eastern Daylight Time in summer', () => {
    assert.match(formatEventTime(SUMMER_2_30), /^2:30\sPM$/);
  });

  it('says "all day" for an all-day event', () => {
    const when = formatEventWhen({
      startTime: new Date('2026-11-11T05:00:00Z'),
      endTime: new Date('2026-11-12T04:59:59Z'),
      allDay: true,
    });
    assert.equal(when, 'all day');
  });

  it('joins the start and end of a timed event with an en dash', () => {
    const when = formatEventWhen({
      startTime: WINTER_9_05,
      endTime: new Date('2026-11-11T15:00:00Z'),
      allDay: false,
    });
    assert.match(when, /^9:05\sAM–10:00\sAM$/);
  });
});

describe('Meeting link', () => {
  it('prefers the Teams /meet/ link over the /l/meetup-join/ link in the same invite', () => {
    const notes = [
      'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x',
      'Short link: https://teams.microsoft.com/meet/123456789?p=abc',
    ].join('\n');
    assert.equal(extractMeetingLink(notes), 'https://teams.microsoft.com/meet/123456789?p=abc');
  });

  it('finds a Teams /l/meetup-join/ link when it is the only one', () => {
    const notes = 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0';
    assert.equal(extractMeetingLink(notes), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0');
  });

  it('finds a Zoom link', () => {
    assert.equal(
      extractMeetingLink('Zoom: https://us02web.zoom.us/j/81234567890'),
      'https://us02web.zoom.us/j/81234567890',
    );
  });

  it('finds a Google Meet link', () => {
    assert.equal(
      extractMeetingLink('Meet: https://meet.google.com/abc-defg-hij'),
      'https://meet.google.com/abc-defg-hij',
    );
  });

  it('finds a Webex link', () => {
    assert.equal(
      extractMeetingLink('Webex: https://acme.webex.com/acme/j.php?MTID=m123'),
      'https://acme.webex.com/acme/j.php?MTID=m123',
    );
  });

  it('drops the ">" that Outlook wraps around a link', () => {
    assert.equal(
      extractMeetingLink('<https://us02web.zoom.us/j/81234567890>'),
      'https://us02web.zoom.us/j/81234567890',
    );
  });

  it('drops a full stop at the end of a sentence', () => {
    assert.equal(
      extractMeetingLink('Join at https://meet.google.com/abc-defg-hij.'),
      'https://meet.google.com/abc-defg-hij',
    );
  });

  it('gives no link when the notes are missing, empty or have no link', () => {
    assert.equal(extractMeetingLink(undefined), undefined);
    assert.equal(extractMeetingLink(''), undefined);
    assert.equal(extractMeetingLink('Bring the budget. See you there.'), undefined);
  });
});

describe('Passcode', () => {
  it('reads the passcode after "Passcode:"', () => {
    assert.equal(extractPasscode('Meeting ID: 123\nPasscode: Ab12Cd'), 'Ab12Cd');
  });

  it('reads a lower-case "passcode:" with no space after the colon', () => {
    assert.equal(extractPasscode('passcode:Ab12Cd'), 'Ab12Cd');
  });

  it('gives no passcode when the invite has none', () => {
    assert.equal(extractPasscode('Meeting ID: 123'), undefined);
    assert.equal(extractPasscode(undefined), undefined);
  });
});
