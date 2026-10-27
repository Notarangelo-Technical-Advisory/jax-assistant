// The SMS webhook's proof that a request came from Twilio. The From number is
// plain text that any caller can set, so only a valid signature may let a
// text through to Jack's tasks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const twilio = fromFunctions('twilio');
const { candidateUrls, isTwilioRequest, RECEIVE_SMS_URLS } = fromFunctions('./lib/twilio-signature.js');

const AUTH_TOKEN = 'test-auth-token-0123456789abcdef';
const PARAMS = { From: '+15555550100', Body: 'add task call the plumber', MessageSid: 'SM0000000000' };
const [CLOUD_FUNCTIONS_URL, RUN_APP_URL] = RECEIVE_SMS_URLS;

const signFor = (url, params = PARAMS, token = AUTH_TOKEN) =>
  twilio.getExpectedTwilioSignature(token, url, params);

describe('Twilio signature on the SMS webhook', () => {
  it('accepts a text that Twilio signed for the cloudfunctions.net address', () => {
    const urls = candidateUrls('receivesms-nxe253ex3a-uc.a.run.app', '/');
    assert.equal(isTwilioRequest(AUTH_TOKEN, signFor(CLOUD_FUNCTIONS_URL), urls, PARAMS), true);
  });

  it('accepts a text that Twilio signed for the run.app address', () => {
    // The run.app address has no path, so Twilio signs it with a trailing slash.
    const urls = candidateUrls('us-central1-jax-assistant-cb47f.cloudfunctions.net', '/receiveSms');
    assert.equal(isTwilioRequest(AUTH_TOKEN, signFor(`${RUN_APP_URL}/`), urls, PARAMS), true);
  });

  it('accepts a text signed for the cloudfunctions.net address with a trailing slash', () => {
    const urls = candidateUrls(undefined, '/');
    assert.equal(isTwilioRequest(AUTH_TOKEN, signFor(`${CLOUD_FUNCTIONS_URL}/`), urls, PARAMS), true);
  });

  it('refuses a request with no signature, even when it claims to be from Jack', () => {
    const urls = candidateUrls('receivesms-nxe253ex3a-uc.a.run.app', '/');
    assert.equal(isTwilioRequest(AUTH_TOKEN, undefined, urls, PARAMS), false);
    assert.equal(isTwilioRequest(AUTH_TOKEN, '', urls, PARAMS), false);
  });

  it('refuses a signature made with a different auth token', () => {
    const urls = candidateUrls('receivesms-nxe253ex3a-uc.a.run.app', '/');
    const forged = signFor(RUN_APP_URL, PARAMS, 'someone-elses-token');
    assert.equal(isTwilioRequest(AUTH_TOKEN, forged, urls, PARAMS), false);
  });

  it('refuses a genuine signature when the text was changed afterwards', () => {
    const urls = candidateUrls('receivesms-nxe253ex3a-uc.a.run.app', '/');
    const signature = signFor(RUN_APP_URL);
    const changed = { ...PARAMS, Body: 'complete task pay the invoice' };
    assert.equal(isTwilioRequest(AUTH_TOKEN, signature, urls, changed), false);
  });

  it('refuses a signature made for an address that is not this function', () => {
    const urls = candidateUrls('receivesms-nxe253ex3a-uc.a.run.app', '/');
    const signature = signFor('https://example.com/receiveSms');
    assert.equal(isTwilioRequest(AUTH_TOKEN, signature, urls, PARAMS), false);
  });

  it("does not trust a Host header that names someone else's address", () => {
    // The rebuilt URL is tried, but a signature for it still needs the auth token.
    const urls = candidateUrls('attacker.example.com', '/hook');
    const forged = signFor('https://attacker.example.com/hook', PARAMS, 'someone-elses-token');
    assert.equal(isTwilioRequest(AUTH_TOKEN, forged, urls, PARAMS), false);
  });
});
