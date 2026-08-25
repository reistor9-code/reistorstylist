/**
 * Proving an inbound webhook really came from Meta.
 *
 * Without this the endpoint accepts anything. Anyone who learns the URL can
 * post a fabricated message and drive the whole flow: make the bot send
 * WhatsApp messages on your bill, mint Razorpay payment links, place cash-on-
 * delivery orders against a stranger's address, and write junk through the
 * funnel you make decisions from. None of that needs a token, because nothing
 * was ever checked.
 *
 * Meta signs every POST with HMAC-SHA256 of the raw body, keyed on the app
 * secret, in an `X-Hub-Signature-256: sha256=…` header. The raw bytes matter:
 * anything that parses and re-serialises the JSON first changes the whitespace
 * and the signature stops matching for a body that is perfectly genuine.
 */

import type { Env } from './types';

const encoder = new TextEncoder();

export type SignatureVerdict = 'ok' | 'bad' | 'missing' | 'unconfigured';

/**
 * Checks the signature on a Meta webhook.
 *
 * Returns `unconfigured` rather than throwing when APP_SECRET is unset, so a
 * deployment that has not been given one keeps answering shoppers instead of
 * going dark — but the caller logs it every single time, because a webhook
 * nobody is checking should never become quiet background noise.
 */
export async function verifyMetaSignature(
  env: Env,
  request: Request,
  rawBody: string,
): Promise<SignatureVerdict> {
  const secret = env.APP_SECRET?.trim();
  if (!secret) return 'unconfigured';

  const header = request.headers.get('x-hub-signature-256');
  if (!header) return 'missing';

  const expected = header.replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return 'bad';

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const actual = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(actual, expected) ? 'ok' : 'bad';
}

/**
 * Constant time, so a forged signature cannot be refined one character at a
 * time by measuring how long the answer takes.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
