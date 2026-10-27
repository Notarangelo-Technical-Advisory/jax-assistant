// ─── Twilio webhook signature ──────────────────────────────────
//
// Twilio signs every webhook request with the account's auth token, over the
// exact URL set in the Twilio console plus the POST parameters. Checking that
// signature is the only proof a request came from Twilio: the From number is
// plain text inside the request, so anyone who finds the public URL can claim
// to be Jack's phone.
//
// A 2nd-gen function has two public URLs, and the Host header the function
// sees does not always name the one Twilio signed. That mismatch is why the
// check was switched off in March 2026 (70989a9). So the signature is accepted
// when it is valid for any of this function's own URLs. That stays safe: a
// valid signature still needs the auth token, and every URL tried is ours.

import twilio from "twilio";

export const RECEIVE_SMS_URLS = [
  "https://us-central1-jax-assistant-cb47f.cloudfunctions.net/receiveSms",
  "https://receivesms-nxe253ex3a-uc.a.run.app",
];

/**
 * The URLs a genuine Twilio request may have been signed for: the URL rebuilt
 * from the request, and each known public URL with and without a trailing slash.
 */
export function candidateUrls(host: string | undefined, originalUrl: string): string[] {
  const urls = new Set<string>();
  if (host) urls.add(`https://${host}${originalUrl}`);
  for (const base of RECEIVE_SMS_URLS) {
    urls.add(base);
    urls.add(`${base}/`);
  }
  return [...urls];
}

/** True when the signature proves the request came from Twilio. */
export function isTwilioRequest(
  authToken: string,
  signature: string | undefined,
  urls: string[],
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  return urls.some((url) => twilio.validateRequest(authToken, signature, url, params));
}
