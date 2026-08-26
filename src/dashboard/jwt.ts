/**
 * Signed session tokens for the dashboard.
 *
 * The shared secret used to travel on every request — in the URL, then in a
 * cookie. Either way, one long-lived value that opens everything and can only
 * be revoked by changing it for everybody.
 *
 * A JWT separates the two jobs. The shared secret is presented once, at
 * /dashboard/auth, and exchanged for a token that expires on its own. That
 * token is what rides on subsequent requests, so a copy taken from a browser
 * or a proxy log is worth hours rather than forever.
 *
 * HS256 over Web Crypto, which both the Workers runtime and Node 18 provide,
 * so this file behaves identically on Cloudflare and on the Linode.
 */

const encoder = new TextEncoder();

/** base64url — JWT's alphabet, with the padding removed. */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** admin sees everything; viewer sees aggregates and no personal data. */
export type Role = 'admin' | 'viewer';

export interface Claims {
  /** Who the token is for — an email once somebody has signed in with Google. */
  sub: string;
  /**
   * What they may do.
   *
   * Carried in the token rather than looked up per request, so authorisation
   * costs nothing and cannot fail open when the database is unreachable. The
   * cost is that a revoked role survives until the token expires, which is why
   * the TTL is a working day and not a week.
   */
  role?: Role;
  /** Display only. */
  name?: string;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
}

/** Twelve hours: a working day, so nobody re-authenticates mid-shift. */
export const DEFAULT_TTL_SECONDS = 60 * 60 * 12;

export async function sign(
  secret: string,
  sub: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  extra: { role?: Role; name?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(
    encoder.encode(
      JSON.stringify({ sub, ...extra, iat: now, exp: now + ttlSeconds } satisfies Claims),
    ),
  );
  const body = `${header}.${payload}`;
  const mac = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(mac))}`;
}

export type VerifyResult =
  | { ok: true; claims: Claims }
  | { ok: false; reason: 'malformed' | 'badSignature' | 'expired' | 'notYet' };

/**
 * Checks a token and returns why it failed, not just that it did.
 *
 * `expired` and `badSignature` mean different things operationally — one is a
 * session that ran out, the other is someone presenting a token this server
 * did not issue — and a log that cannot tell them apart is no use during an
 * incident.
 */
export async function verify(secret: string, token: string): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [header, payload, signature] = parts;

  let valid: boolean;
  try {
    /*
     * crypto.subtle.verify rather than re-signing and comparing strings: it
     * compares in constant time, so a forged token cannot be refined one
     * character at a time by watching how long the answer takes.
     */
    valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      fromB64url(signature),
      encoder.encode(`${header}.${payload}`),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // The signature is checked before the claims are read, so nothing an
  // attacker controls is parsed until the token is known to be ours.
  if (!valid) return { ok: false, reason: 'badSignature' };

  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Claims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const now = Math.floor(Date.now() / 1000);
  // Thirty seconds of slack for clocks that disagree.
  if (typeof claims.exp !== 'number' || claims.exp + 30 < now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.iat === 'number' && claims.iat - 30 > now) {
    return { ok: false, reason: 'notYet' };
  }

  return { ok: true, claims };
}
