/**
 * Password hashing.
 *
 * PBKDF2-HMAC-SHA256 over Web Crypto, which both Node and the Workers runtime
 * provide — so this file behaves identically wherever the dashboard runs and
 * pulls in no native dependency that has to be compiled per platform.
 *
 * bcrypt or argon2 would be stronger per unit of work. Neither exists in Web
 * Crypto, and adding a native module to a deployment that has been kept to one
 * runtime dependency is a real cost for a login used by a handful of people.
 * PBKDF2 at a high iteration count is what the platform offers and is far
 * beyond what an attacker gets from an unsalted or fast hash.
 *
 * A stolen database of these is expensive to attack. It is not free. Google
 * sign-in remains the better door, and this one exists because it was asked
 * for.
 */

const encoder = new TextEncoder();

/**
 * OWASP's current floor for PBKDF2-HMAC-SHA256.
 *
 * Costs a few hundred milliseconds per verify, which is the point: it is the
 * same few hundred milliseconds for every guess an attacker makes. Stored in
 * the hash string rather than read from here at verify time, so raising it
 * later does not invalidate every existing password.
 */
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return b64(new Uint8Array(bits));
}

/**
 * `pbkdf2$<iterations>$<salt>$<hash>`.
 *
 * Self-describing on purpose: the iteration count and salt travel with the
 * hash, so the cost can be raised for new passwords without stranding old
 * ones, and nothing has to be looked up to verify a login.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000) return false;

  let expected: string;
  try {
    expected = await derive(password, fromB64(parts[2]), iterations);
  } catch {
    return false;
  }

  return timingSafeEqual(expected, parts[3]);
}

/** Constant time, so a hash cannot be recovered by measuring the comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What a password has to be before it is worth hashing.
 *
 * Length only. Composition rules — a digit, a symbol, a capital — push people
 * toward Password1! and buy nothing an attacker notices, which is why NIST
 * dropped them. Twelve characters is the floor; the account this protects can
 * read every customer's phone number.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'That password is too long.';
  // Catches the pasted-twice and held-down-a-key cases, nothing more.
  if (/^(.)\1+$/.test(password)) return 'That password is one repeated character.';
  return null;
}

/** Rough shape check. Real validation is whether a sign-in ever arrives. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
