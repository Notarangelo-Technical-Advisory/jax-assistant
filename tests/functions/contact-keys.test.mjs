// The keys that match calls and messages to contacts: addresses, phone
// numbers, the first line of a text, and the title and length of a call.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { normAddress, phoneKey, handleKey, firstLineOf, callTitle, callLength } =
  fromFunctions('./lib/tools/contact-autolink.js');

describe('email address key', () => {
  it('drops the mailto: prefix, the angle brackets and the capitals', () => {
    assert.equal(normAddress(' mailto:<Jack@Example.COM> '), 'jack@example.com');
  });

  it('is empty when the text is not an address', () => {
    assert.equal(normAddress('not an email'), '');
  });
});

describe('phone number key', () => {
  it('keeps the last 10 digits', () => {
    assert.equal(phoneKey('+1 (555) 123-4567'), '5551234567');
  });

  it('is empty when there are fewer than 7 digits', () => {
    assert.equal(phoneKey('12345'), '');
  });
});

describe('handle key', () => {
  it('gives the address for a handle with @', () => {
    assert.equal(handleKey('Jack@Example.com'), 'jack@example.com');
  });

  it('gives the phone key for any other handle', () => {
    assert.equal(handleKey('+1 (555) 123-4567'), '5551234567');
  });
});

describe('first line of a text', () => {
  it('skips blank lines and trims the line', () => {
    assert.equal(firstLineOf('\n  first line  \nsecond'), 'first line');
  });

  it('cuts a 200-character line to 80 characters ending in an ellipsis', () => {
    const line = firstLineOf('a'.repeat(200));
    assert.equal(line.length, 80);
    assert.ok(line.endsWith('…'));
  });
});

describe('call title', () => {
  it('names an incoming FaceTime video call', () => {
    assert.equal(callTitle({ direction: 'incoming', kind: 'facetime-video' }), 'Incoming FaceTime video call');
  });

  it('names an outgoing phone call', () => {
    assert.equal(callTitle({ direction: 'outgoing', kind: 'phone' }), 'Outgoing call');
  });
});

describe('call length', () => {
  it('says an outgoing call of 0 seconds was not answered', () => {
    assert.equal(callLength({ direction: 'outgoing', seconds: 0 }), 'not answered');
  });

  it('has no length for an incoming call of 0 seconds', () => {
    assert.equal(callLength({ direction: 'incoming', seconds: 0 }), null);
  });

  it('says under 1 min for 45 seconds', () => {
    assert.equal(callLength({ direction: 'incoming', seconds: 45 }), 'under 1 min');
  });

  it('rounds 150 seconds to 3 min', () => {
    assert.equal(callLength({ direction: 'incoming', seconds: 150 }), '3 min');
  });
});
