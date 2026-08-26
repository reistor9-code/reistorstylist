/**
 * Signing in to the dashboard with Google.
 *
 * The dashboard used to be one shared secret pasted into a link. That is fine
 * while one person reads it from one laptop, and it stops being fine the
 * moment the URL is public: the secret identifies nobody, cannot be revoked
 * for one person without revoking it for everyone, and leaves no record of who
 * read what. This page shows every shopper's phone number and their whole
 * conversation, so it needs accounts.
 *
 * The flow is the ordinary OAuth authorization code exchange, run entirely on
 * the server:
 *
 *   GET /dashboard/auth/google           → redirect to Google
 *   GET /dashboard/auth/google/callback  → code in, session cookie out
 *
 * No Google credential ever reaches the browser, and no Supabase key does
 * either. What comes back is the same HS256 session the dashboard already
 * used, now carrying who signed in and what they may do.
 *
 * DENY BY DEFAULT. A Google account is proof of identity, not proof of
 * authorisation — anybody can make one. An email that is not already known is
 * recorded as `pending` and refused. Access is granted by a human, in the
 * database, on purpose.
 */

import { select, upsert, update, type SupabaseConfig } from '../platform/supabase.js';
import { sign, verify, DEFAULT_TTL_SECONDS, type Role } from './jwt.js';

export const USERS_TABLE = 'dashboard_users';

/** Google hands the browser back here; it must match the console exactly. */
export const CALLBACK_PATH = '/dashboard/auth/google/callback';

export interface GoogleAuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Origin the callback is registered under, e.g. https://stylist.reistor.life */
  PUBLIC_BASE_URL?: string;
  /** Comma-separated emails that are admins from their first sign-in. */
  DASHBOARD_ADMINS?: string;
  DASHBOARD_JWT_SECRET?: string;
  DASHBOARD_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

export interface DashboardUser {
  email: string;
  name: string | null;
  picture: string | null;
  role: Role;
  status: 'pending' | 'active' | 'blocked';
}

export function googleConfigured(env: GoogleAuthEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

function signingSecret(env: GoogleAuthEnv): string {
  return env.DASHBOARD_JWT_SECRET?.trim() || env.DASHBOARD_TOKEN || '';
}

function baseUrl(env: GoogleAuthEnv, request: Request): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  // Behind Nginx the scheme the caller used is only knowable from the header.
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function admins(env: GoogleAuthEnv): Set<string> {
  return new Set(
    (env.DASHBOARD_ADMINS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/* ------------------------------------------------------------------ *
 * Step one — send them to Google
 * ------------------------------------------------------------------ */

/**
 * The `state` parameter is a short-lived signed token, not a random string in
 * a session store.
 *
 * It has to survive a round trip through Google and come back proving this
 * server started the exchange — otherwise an attacker can hand a victim a
 * crafted callback URL and log them into an account that is not theirs. A JWT
 * signed with the dashboard secret does that with nothing to store and nothing
 * to clean up, and a five-minute expiry makes a captured one worthless.
 */
const STATE_TTL_SECONDS = 300;

export async function startGoogleSignIn(
  env: GoogleAuthEnv,
  request: Request,
): Promise<Response> {
  if (!googleConfigured(env)) {
    return new Response('Google sign-in is not configured on this server.', { status: 503 });
  }

  const state = await sign(signingSecret(env), 'oauth-state', STATE_TTL_SECONDS);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!.trim());
  url.searchParams.set('redirect_uri', `${baseUrl(env, request)}${CALLBACK_PATH}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // Ask every time rather than silently reusing whichever account the browser
  // happens to be signed into — shared laptops are the norm in a small team.
  url.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ *
 * Step two — they come back
 * ------------------------------------------------------------------ */

interface GoogleProfile {
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/**
 * Code for profile.
 *
 * The access token is used against Google's userinfo endpoint rather than
 * decoding the id_token here. Both arrive over the same TLS connection from
 * the same exchange, and asking Google who the token belongs to needs no JWKS
 * fetching, no key rotation handling and no signature code of our own.
 */
async function exchangeCode(
  env: GoogleAuthEnv,
  request: Request,
  code: string,
): Promise<GoogleProfile | null> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
      redirect_uri: `${baseUrl(env, request)}${CALLBACK_PATH}`,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    console.log('[auth:google-token]', tokenRes.status, (await tokenRes.text()).slice(0, 200));
    return null;
  }

  const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
  if (!accessToken) return null;

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) {
    console.log('[auth:google-userinfo]', infoRes.status);
    return null;
  }

  const info = (await infoRes.json()) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!info.email) return null;

  return {
    email: info.email.toLowerCase(),
    emailVerified: info.email_verified === true,
    name: info.name ?? null,
    picture: info.picture ?? null,
  };
}

/**
 * Finds or records the person, and decides whether they get in.
 *
 * Everyone who signs in is written down, including the ones turned away. A
 * refused stranger is worth more as a row than as a 403 in a log nobody reads:
 * it is how you notice that somebody is trying, and it is how a colleague you
 * meant to add becomes one click of approval rather than a support request.
 */
export async function resolveUser(
  cfg: SupabaseConfig,
  env: GoogleAuthEnv,
  profile: GoogleProfile,
): Promise<DashboardUser> {
  const isAdmin = admins(env).has(profile.email);

  const existing = await select<DashboardUser[]>(
    cfg,
    USERS_TABLE,
    `email=eq.${encodeURIComponent(profile.email)}&select=*&limit=1`,
  );
  const found = existing.data?.[0];

  if (found) {
    // Names and avatars change; role and status are ours and are never
    // overwritten from Google.
    await update(
      cfg,
      USERS_TABLE,
      `email=eq.${encodeURIComponent(profile.email)}`,
      {
        name: profile.name,
        picture: profile.picture,
        last_login_at: new Date().toISOString(),
        // An admin added to the env after the fact is promoted on next sign-in.
        ...(isAdmin && found.role !== 'admin' ? { role: 'admin', status: 'active' } : {}),
      },
    );
    return isAdmin ? { ...found, role: 'admin', status: 'active' } : found;
  }

  const created: DashboardUser = {
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    role: isAdmin ? 'admin' : 'viewer',
    // The important line in this file.
    status: isAdmin ? 'active' : 'pending',
  };

  await upsert(
    cfg,
    USERS_TABLE,
    { ...created, created_at: new Date().toISOString(), last_login_at: new Date().toISOString() },
    'email',
  );

  console.log('[auth:new-user]', profile.email, created.status);
  return created;
}

/** Where the browser lands, with a reason it can render. */
function bounce(base: string, reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${base}/dashboard/?error=${encodeURIComponent(reason)}`,
      'cache-control': 'no-store',
    },
  });
}

export async function completeGoogleSignIn(
  env: GoogleAuthEnv,
  request: Request,
  cfg: SupabaseConfig,
): Promise<Response> {
  const base = baseUrl(env, request);
  const url = new URL(request.url);

  // Google reports a declined consent screen this way, not as an error page.
  if (url.searchParams.get('error')) return bounce(base, 'cancelled');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return bounce(base, 'incomplete');

  const stateOk = await verify(signingSecret(env), state);
  if (!stateOk.ok || stateOk.claims.sub !== 'oauth-state') {
    console.log('[auth:bad-state]', stateOk.ok ? 'wrong subject' : stateOk.reason);
    return bounce(base, 'expired');
  }

  const profile = await exchangeCode(env, request, code);
  if (!profile) return bounce(base, 'google-failed');

  /*
   * An unverified address is not an identity. Google will hand one over for a
   * domain it has not confirmed the person controls, and treating it as proof
   * would let somebody claim a colleague's email.
   */
  if (!profile.emailVerified) return bounce(base, 'unverified');

  const user = await resolveUser(cfg, env, profile);

  if (user.status !== 'active') {
    console.log('[auth:refused]', profile.email, user.status);
    return bounce(base, user.status === 'blocked' ? 'blocked' : 'pending');
  }

  const session = await sign(signingSecret(env), user.email, DEFAULT_TTL_SECONDS, {
    role: user.role,
    name: user.name ?? undefined,
  });

  console.log('[auth:signed-in]', user.email, user.role);

  return new Response(null, {
    status: 302,
    headers: {
      location: `${base}/dashboard/`,
      'set-cookie': `rdash=${encodeURIComponent(session)}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEFAULT_TTL_SECONDS}`,
      'cache-control': 'no-store',
    },
  });
}

/** Ends the session. The cookie is the session, so clearing it is enough. */
export function signOut(env: GoogleAuthEnv, request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${baseUrl(env, request)}/dashboard/`,
      'set-cookie': 'rdash=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'cache-control': 'no-store',
    },
  });
}
