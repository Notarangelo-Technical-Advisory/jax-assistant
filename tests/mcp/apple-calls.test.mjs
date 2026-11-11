// The call history helpers turn the Mac's call history into the calls Maisie
// links to contacts (functions/src/mcp/apple-calls.ts). Run with
// `npm run test:mcp`. The rows are written here; no test reads the real clock
// or the real call history.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// src/mcp is run with tsx and never compiled, so tsx loads it here too.
const functionsDir = new URL('../../functions/', import.meta.url).pathname;
const { require: tsxRequire } = createRequire(`${functionsDir}package.json`)('tsx/cjs/api');
const { readCallsSql, parseCallRows, AppleCallsError } = tsxRequire(`${functionsDir}src/mcp/apple-calls.ts`, import.meta.url);

/** One row as sqlite3 prints it, with any field replaced. */
const row = (over = {}) => ({
  id: 'call-1', seconds: 0, duration: 60, outgoing: 0, answered: 1, callType: 1, address: '+15551230000', ...over,
});

/** Parse one row and return the single call. */
const parseOne = (over) => parseCallRows(JSON.stringify([row(over)]))[0];

describe('readCallsSql', () => {
  it('asks for calls that ended after the given time, counted from 2001', () => {
    const sql = readCallsSql(new Date('2001-01-01T00:01:40Z'));
    assert.match(sql, /WHERE ZDATE \+ ZDURATION > 100\b/);
  });
});

describe('parseCallRows', () => {
  it('finds no calls when sqlite3 prints nothing or only blanks', () => {
    assert.deepEqual(parseCallRows(''), []);
    assert.deepEqual(parseCallRows('  \n '), []);
  });

  it('refuses output that is not JSON, with the code bad_output', () => {
    assert.throws(
      () => parseCallRows('Error: database is locked'),
      (err) => err instanceof AppleCallsError && err.code === 'bad_output',
    );
  });

  it('turns second 0 of the call history into 1 January 2001', () => {
    assert.equal(parseOne({ seconds: 0 }).at, '2001-01-01T00:00:00.000Z');
  });

  it('tells outgoing, incoming and missed calls apart', () => {
    assert.equal(parseOne({ outgoing: 1, answered: 0 }).direction, 'outgoing');
    assert.equal(parseOne({ outgoing: 1, answered: 1 }).direction, 'outgoing');
    assert.equal(parseOne({ outgoing: 0, answered: 1 }).direction, 'incoming');
    assert.equal(parseOne({ outgoing: 0, answered: 0 }).direction, 'missed');
  });

  it('tells FaceTime video, FaceTime audio and phone calls apart', () => {
    assert.equal(parseOne({ callType: 8 }).kind, 'facetime-video');
    assert.equal(parseOne({ callType: 16 }).kind, 'facetime-audio');
    assert.equal(parseOne({ callType: 1 }).kind, 'phone');
    assert.equal(parseOne({ callType: null }).kind, 'phone');
  });

  it('rounds the length of a call to whole seconds', () => {
    assert.equal(parseOne({ duration: 59.6 }).seconds, 60);
    assert.equal(parseOne({ duration: 59.4 }).seconds, 59);
  });

  it('shows a negative or missing length as 0 seconds', () => {
    assert.equal(parseOne({ duration: -5 }).seconds, 0);
    assert.equal(parseOne({ duration: null }).seconds, 0);
  });

  it('trims the address, and gives no handles for a blank one', () => {
    assert.deepEqual(parseOne({ address: '  +15551230000 ' }).handles, ['+15551230000']);
    assert.deepEqual(parseOne({ address: '   ' }).handles, []);
    assert.deepEqual(parseOne({ address: null }).handles, []);
  });

  it('drops a call that has no id and keeps the others', () => {
    const calls = parseCallRows(JSON.stringify([row({ id: null }), row({ id: '' }), row({ id: 'call-2' })]));
    assert.deepEqual(calls.map((call) => call.callId), ['call-2']);
  });
});
