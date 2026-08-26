/**
 * Email and password accounts, and the team list that manages them.
 *
 * Google sign-in is the better door and still exists beside this one. This is
 * here because a password is what people expect a sign-in page to have, and a
 * dashboard nobody can get into is worth nothing.
 *
 * Everything routes through the same dashboard_users table Google writes to,
 * so a person is one row however they got in, and one role decides what they
 * see either way. Signing up is a request for access, never a grant of it:
 * unless the address is on DASHBOARD_ADMINS, a new account is `pending` and
 * refused until somebody active says otherwise.
 */

import { select, upsert, update, type SupabaseConfig } from '../platform/supabase.js';
import { sign, DEFAULT_TTL_SECONDS, type Role } from './jwt.js';
import { hashPassword, looksLikeEmail, passwordProblem, verifyPassword } from './password.js';
import { USERS_TABLE, type DashboardUser } from './auth-google.js';

export interface AccountsEnv {
  DASHBOARD_ADMINS?: string;
  DASHBOARD_JWT_SECRET?: string;
  DASHBOARD_TOKEN?: string;
  /** Used only to rate-limit sign-in attempts. Absent means no limiting. */
  STATE?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

interface StoredUser extends DashboardUser {
  password_hash?: string | null;
}

function secretOf(env: AccountsEnv): string {
  return env.DASHBOARD_JWT_SECRET?.trim() || env.DASHBOARD_TOKEN || '';
}

function isAdminEmail(env: AccountsEnv, email: string): boolean {
  return (env.DASHBOARD_ADMINS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

function json(body: unknown, status = 200, cookie?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(cookie ? { 'set-cookie': cookie } : {}),
    },
  });
}

function sessionCookie(token: string): string {
  return `rdash=${encodeURIComponent(token)}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEFAULT_TTL_SECONDS}`;
}

async function findUser(cfg: SupabaseConfig, email: string): Promise<StoredUser | null> {
  const res = await select<StoredUser[]>(
    cfg,
    USERS_TABLE,
    `email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
  );
  return res.data?.[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Sign up
 * ------------------------------------------------------------------ */

export async function signUp(
  env: AccountsEnv,
  cfg: SupabaseConfig,
  request: Request,
): Promise<Response> {
  let body: { name?: string; email?: string; password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  if (!name) return json({ error: 'Enter your name.' }, 400);
  if (!looksLikeEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);

  const weak = passwordProblem(password);
  if (weak) return json({ error: weak }, 400);

  const existing = await findUser(cfg, email);

  /*
   * An address that already exists is not told so.
   *
   * "That email is taken" turns this form into a way of asking whether a given
   * person has an account here, which is worth knowing to somebody deciding
   * where to point a password list. The answer is the same either way, and the
   * real owner is unaffected because their password is not overwritten.
   */
  if (existing?.password_hash) {
    console.log('[accounts:signup-duplicate]', email);
    return json({ ok: true, status: existing.status });
  }

  const hash = await hashPassword(password);
  const admin = isAdminEmail(env, email);

  /*
   * Signing up is a request. The only accounts that come out active are the
   * ones already named in the environment, which is a decision made on the
   * server by somebody with shell access rather than by the person signing up.
   */
  const row = {
    email,
    name,
    picture: existing?.picture ?? null,
    password_hash: hash,
    role: (admin ? 'admin' : (existing?.role ?? 'viewer')) as Role,
    status: admin ? 'active' : (existing?.status ?? 'pending'),
    created_at: new Date().toISOString(),
  };

  const wrote = await upsert(cfg, USERS_TABLE, row, 'email');
  if (!wrote.ok) {
    console.log('[accounts:signup-failed]', email, wrote.error ?? '');
    return json({ error: 'The account could not be created.' }, 502);
  }

  console.log('[accounts:signed-up]', email, row.status);

  if (row.status !== 'active') {
    return json({ ok: true, status: row.status });
  }

  const token = await sign(secretOf(env), email, DEFAULT_TTL_SECONDS, {
    role: row.role,
    name,
  });
  return json({ ok: true, status: 'active' }, 200, sessionCookie(token));
}

/* ------------------------------------------------------------------ *
 * Sign in
 * ------------------------------------------------------------------ */

/** Attempts allowed per email before it is locked out, and for how long. */
const MAX_ATTEMPTS = 8;
const LOCKOUT_SECONDS = 15 * 60;

/**
 * Counted per email rather than per IP.
 *
 * An attacker with a password list rotates addresses and keeps one target;
 * rotating IPs is cheaper than rotating the account they want. Per-IP limits
 * belong in Nginx, where they cost nothing — this one protects the specific
 * account being guessed at.
 */
async function tooManyAttempts(env: AccountsEnv, email: string): Promise<boolean> {
  if (!env.STATE) return false;
  const raw = await env.STATE.get(`login:${email}`);
  return Number(raw ?? 0) >= MAX_ATTEMPTS;
}

async function recordFailure(env: AccountsEnv, email: string): Promise<void> {
  if (!env.STATE) return;
  const raw = await env.STATE.get(`login:${email}`);
  const next = Number(raw ?? 0) + 1;
  await env.STATE.put(`login:${email}`, String(next), { expirationTtl: LOCKOUT_SECONDS });
}

export async function signIn(
  env: AccountsEnv,
  cfg: SupabaseConfig,
  request: Request,
): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return json({ error: 'Enter your email and password.' }, 400);

  if (await tooManyAttempts(env, email)) {
    console.log('[accounts:locked-out]', email);
    return json({ error: 'Too many attempts. Try again in fifteen minutes.' }, 429);
  }

  const user = await findUser(cfg, email);

  /*
   * One message for "no such account" and for "wrong password", because
   * telling them apart is how a stranger learns which addresses are real.
   * The password is still verified against a dummy hash when the account does
   * not exist, so the two paths take the same time — an unknown email
   * answering instantly is the same disclosure by another route.
   */
  const stored =
    user?.password_hash ??
    'pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, stored);

  if (!user || !user.password_hash || !ok) {
    await recordFailure(env, email);
    console.log('[accounts:refused]', email);
    return json({ error: 'That email and password do not match.' }, 401);
  }

  if (user.status !== 'active') {
    console.log('[accounts:not-active]', email, user.status);
    return json(
      {
        error:
          user.status === 'blocked'
            ? 'This account has been blocked.'
            : 'Your account is waiting for approval. Ask an admin to enable it.',
        status: user.status,
      },
      403,
    );
  }

  if (env.STATE) await env.STATE.delete(`login:${email}`);

  await update(cfg, USERS_TABLE, `email=eq.${encodeURIComponent(email)}`, {
    last_login_at: new Date().toISOString(),
  });

  const token = await sign(secretOf(env), email, DEFAULT_TTL_SECONDS, {
    role: user.role,
    name: user.name ?? undefined,
  });

  console.log('[accounts:signed-in]', email, user.role);
  return json({ ok: true, role: user.role }, 200, sessionCookie(token));
}

/* ------------------------------------------------------------------ *
 * The team list
 * ------------------------------------------------------------------ */

export async function listTeam(cfg: SupabaseConfig): Promise<Response> {
  const res = await select<StoredUser[]>(
    cfg,
    USERS_TABLE,
    'select=email,name,picture,role,status,created_at,last_login_at&order=created_at.desc',
  );
  if (!res.ok) return json({ error: 'The team list could not be read.' }, 502);

  // Never send the hashes to a browser, whoever is asking.
  const users = (res.data ?? []).map(({ password_hash: _ignored, ...rest }) => rest);
  return json({ users });
}

/**
 * Approve, block or change a role.
 *
 * Admin-only, checked by the caller. The one rule enforced here is that an
 * admin cannot demote or block themselves — an account that locks the last
 * person out of the room is a support call, not a security feature.
 */
export async function updateTeamMember(
  cfg: SupabaseConfig,
  actorEmail: string,
  request: Request,
): Promise<Response> {
  let body: { email?: string; status?: string; role?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) return json({ error: 'Which account?' }, 400);

  const patch: Record<string, string> = {};
  if (body.status) {
    if (!['pending', 'active', 'blocked'].includes(body.status)) {
      return json({ error: 'Unknown status.' }, 400);
    }
    patch.status = body.status;
  }
  if (body.role) {
    if (!['admin', 'viewer'].includes(body.role)) return json({ error: 'Unknown role.' }, 400);
    patch.role = body.role;
  }
  if (!Object.keys(patch).length) return json({ error: 'Nothing to change.' }, 400);

  if (email === actorEmail && (patch.status === 'blocked' || patch.role === 'viewer')) {
    return json({ error: 'You cannot remove your own access.' }, 400);
  }

  const res = await update(cfg, USERS_TABLE, `email=eq.${encodeURIComponent(email)}`, patch);
  if (!res.ok) return json({ error: 'That change could not be saved.' }, 502);

  console.log('[team:updated]', actorEmail, '→', email, JSON.stringify(patch));
  return json({ ok: true });
}
