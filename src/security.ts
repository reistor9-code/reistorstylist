/**
 * Webhook payload authentication.
 *
 * Meta signs every webhook POST with an HMAC-SHA256 of the raw body, keyed on
 * the app secret, in the `X-Hub-Signature-256` header as `sha256=<hex>`.
 *
 * Without this check the endpoint is an open relay: the attacker controls the
 * `from` field, the bot answers whoever `from` says, and every reply is billed
 * to the business. This is the one thing that must be in place before the
 * Worker is pointed at a production number.
 */

import type { Env } from './env';

const encoder = new TextEncoder();

/** Constant-time compare, so a wrong signature leaks nothing through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type VerifyOutcome = 'ok' | 'bad-signature' | 'missing-signature' | 'not-configured';

/**
 * Verifies the signature over `rawBody` — which must be the exact bytes Meta
 * sent. Re-serialising the parsed JSON changes key order and whitespace and
 * will not match, so callers read the body as text once and parse from that.
 */
export async function verifySignature(
  env: Env,
  request: Request,
  rawBody: string,
): Promise<VerifyOutcome> {
  if (!env.APP_SECRET) return 'not-configured';

  const header = request.headers.get('x-hub-signature-256');
  if (!header) return 'missing-signature';

  const [scheme, signature] = header.split('=');
  if (scheme !== 'sha256' || !signature) return 'bad-signature';

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));

  return timingSafeEqual(toHex(digest), signature.toLowerCase()) ? 'ok' : 'bad-signature';
}
