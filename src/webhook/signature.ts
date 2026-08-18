/**
 * Webhook payload authentication.
 *
 * Meta signs every webhook POST with an HMAC-SHA256 of the raw body, keyed on
 * the app secret, in the `X-Hub-Signature-256` header as `sha256=<hex>`.
 *
 * Without this check the endpoint is an open relay. The attacker controls the
 * `from` field, the bot answers whoever `from` names, and every reply is billed
 * to the business. This is the one thing that must be in place before the
 * Worker is pointed at a production number.
 *
 * Uses WebCrypto, which is present on both Cloudflare Workers and Node 18+, so
 * this file needs no change when the bot moves hosts.
 */

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
 * sent. Re-serialising parsed JSON changes key order and whitespace and will
 * never match, so the caller reads the body as text once and parses from that.
 */
export async function verifySignature(
  appSecret: string | undefined,
  signatureHeader: string | null,
  rawBody: string,
): Promise<VerifyOutcome> {
  if (!appSecret) return 'not-configured';
  if (!signatureHeader) return 'missing-signature';

  const [scheme, signature] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !signature) return 'bad-signature';

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));

  return timingSafeEqual(toHex(digest), signature.toLowerCase()) ? 'ok' : 'bad-signature';
}

/**
 * Whether a request should be processed given the verification outcome.
 *
 * `not-configured` is allowed through so an existing deployment does not stop
 * answering the moment this check ships — but it is logged loudly on every
 * request, because running without it in production is the security hole
 * described above.
 */
export function shouldProcess(outcome: VerifyOutcome): boolean {
  if (outcome === 'ok') return true;
  if (outcome === 'not-configured') {
    console.log('[security:unverified] APP_SECRET is not set — webhook payloads are NOT verified');
    return true;
  }
  console.log('[security:rejected]', outcome);
  return false;
}
