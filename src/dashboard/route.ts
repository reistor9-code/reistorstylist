/**
 * The dashboard API.
 *
 *   POST /dashboard/auth             shared secret in, session token out
 *   GET  /dashboard/api?token=…      the data as JSON
 *   GET  /dashboard/api/transcript   one shopper's messages
 *   POST /dashboard/api/callback     mark a callback handled — the ONLY write
 *
 * This file no longer renders anything. It used to serve a server-rendered
 * report as well, which meant two dashboards existed side by side and the
 * older one won because it owned the /dashboard route. The interface is now
 * the React app in dashboard/, served as static files by Nginx; this process
 * answers only the paths above.
 *
 * The data is fetched here rather than in the browser on purpose. A page
 * holding a Supabase key and querying directly would put a credential that
 * reads every shopper's phone number into anything that can open DevTools.
 * Here the service key never leaves the process, and the browser receives
 * only the aggregate numbers it is meant to display.
 *
 * Query parameters:
 *   days=30       window, default 30
 *   phone=<id>    restrict to one phone number id, so test traffic can be
 *                 excluded from the figures a board is shown
 */

import { type SupabaseConfig } from '../platform/supabase.js';
import { defaultRange, loadDashboard, markCalled, type DashboardData } from './queries.js';
import { loadAnalytics, transcript, type AnalyticsData } from './queries-analytics.js';
import { humaniseTranscript } from './transcript-text.js';
import { DEFAULT_TTL_SECONDS, sign, verify } from './jwt.js';

export interface DashboardEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  DASHBOARD_TOKEN?: string;
  /** Signs dashboard sessions. Falls back to DASHBOARD_TOKEN when unset. */
  DASHBOARD_JWT_SECRET?: string;
  PHONE_NUMBER_ID?: string;
}

/** JSON, with caching off — every one of these carries account data. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** The remembered token, if this browser has been here before. */
function cookieToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'rdash') return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
function tokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * The shape this file needs from the catalogue, and nothing more.
 *
 * Passed in as a function rather than imported so the dashboard keeps no
 * dependency on Shopify or on the KV binding the catalogue is cached in.
 */
export interface CatalogEntry {
  id: string;
  title: string;
  sku?: string;
}

/**
 * Puts a name and a SKU on every product id the report mentions.
 *
 * The database can only name a product it has already recorded a sale for, so
 * before the first order every row read "Product 8557998965013". The live
 * catalogue knows all of them, so it answers first and the stored title stays
 * as the fallback for anything since deleted from Shopify.
 */
function nameProducts(data: DashboardData, catalog: CatalogEntry[]): DashboardData {
  if (!catalog.length) return data;
  const byId = new Map(catalog.map((c) => [c.id, c]));

  const named = <T extends { productId: string; title: string | null; sku: string | null }>(row: T): T => {
    const hit = byId.get(row.productId);
    if (!hit) return row;
    return { ...row, title: row.title ?? hit.title, sku: row.sku ?? hit.sku ?? null };
  };

  return {
    ...data,
    topProducts: data.topProducts.map((r) => {
      const hit = byId.get(r.productId);
      return hit ? { ...r, title: r.title || hit.title, sku: r.sku ?? hit.sku ?? null } : r;
    }),
    productConversion: data.productConversion.map(named),
    lostDemand: data.lostDemand.map(named),
  };
}

export async function handleDashboard(
  request: Request,
  env: DashboardEnv,
  path: string,
  catalog?: () => Promise<CatalogEntry[]>,
): Promise<Response> {
  /*
   * POST is allowed on exactly one path: marking a callback handled. Every
   * other route is a read, and keeping the write surface to a single endpoint
   * is what makes that easy to reason about.
   */
  const isCallbackWrite = path === '/dashboard/api/callback' && request.method === 'POST';
  // Exchanging the shared secret for a session token is the other POST. It is
  // named here rather than inside the check below so the write surface stays
  // readable: two paths accept anything but GET, and they are both listed.
  const isAuth = path === '/dashboard/auth' && request.method === 'POST';
  if (request.method !== 'GET' && !isCallbackWrite && !isAuth) {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!env.DASHBOARD_TOKEN) {
    return new Response(
      'DASHBOARD_TOKEN is not set. Set it before exposing this route.',
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const signingSecret = env.DASHBOARD_JWT_SECRET?.trim() || env.DASHBOARD_TOKEN;

  /*
   * Exchange the shared secret for a session token.
   *
   *   POST /dashboard/auth  { "token": "<DASHBOARD_TOKEN>" }
   *   → { "token": "<jwt>", "expiresIn": 43200 }
   *
   * The only place the shared secret is accepted as a credential. Everything
   * else takes the JWT, so a token lifted from a browser or a proxy log is
   * worth hours rather than forever.
   */
  if (path === '/dashboard/auth') {
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }
    let body: { token?: string };
    try {
      body = (await request.json()) as { token?: string };
    } catch {
      return json({ error: 'Expected a JSON body with a token field.' }, 400);
    }
    if (!body.token || !tokenMatches(body.token, env.DASHBOARD_TOKEN)) {
      console.log('[dashboard:auth-refused]');
      return json({ error: 'Forbidden' }, 403);
    }
    const issued = await sign(signingSecret, 'dashboard');
    console.log('[dashboard:auth-issued]');
    return json({ token: issued, tokenType: 'Bearer', expiresIn: DEFAULT_TTL_SECONDS });
  }

  /*
   * An empty `token=` counts as absent, not as a token.
   *
   * The app always sends the parameter, and sends it empty once the cookie
   * has taken over. searchParams.get returns '' for that, and ?? passes '' on
   * happily because it is not null — so the cookie was never consulted and
   * every call after the first visit was refused.
   */
  const fromQuery = url.searchParams.get('token') || null;
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
  const supplied = fromQuery ?? bearer ?? cookieToken(request);

  if (!supplied) return new Response('Forbidden', { status: 403 });

  /*
   * Two credentials are accepted, and they are not equivalent.
   *
   * A JWT is the normal one — issued by /dashboard/auth, expiring on its own.
   * The shared secret is accepted too, because it is what someone pastes into
   * a link the first time; that path immediately swaps it for a JWT below,
   * so the long-lived value never becomes what rides on every request.
   */
  let authorised = false;
  if (supplied.split('.').length === 3) {
    const result = await verify(signingSecret, supplied);
    authorised = result.ok;
    if (!result.ok) console.log('[dashboard:jwt-refused]', result.reason);
  } else {
    authorised = tokenMatches(supplied, env.DASHBOARD_TOKEN);
  }

  if (!authorised) return new Response('Forbidden', { status: 403 });

  /*
   * The cookie is issued further down, on the API response itself.
   *
   * It used to be issued here, as a 302 to a URL with the token stripped off.
   * That worked for a server-rendered page and is wrong for this one: the
   * caller is the app's own fetch(), which follows the redirect silently and
   * gets JSON from a URL it did not ask for, and the address bar never
   * changes anyway. See the /dashboard/api branch.
   */

  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));

  /*
   * The page itself needs no database.
   *
   * It is a shell that fetches /dashboard/api once loaded, which means a
   * Supabase outage renders a dashboard explaining the outage rather than a
   * bare 503 with no context. The token is carried through so the page's own
   * request authenticates without asking the reader for it twice.
   */
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(
      'SUPABASE_URL / SUPABASE_SERVICE_KEY are not set, so there is no data to show.',
      { status: 503 },
    );
  }

  const cfg: SupabaseConfig = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY };

  /*
   * Mark a callback handled.
   *
   * Guarded by the same token as the rest of the dashboard. The filter in
   * markCalled() includes `status=eq.pending`, so a double submit updates
   * nothing rather than overwriting who called and when.
   */
  if (isCallbackWrite) {
    let body: { id?: number; agent?: string; notes?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'bad json' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return new Response(JSON.stringify({ ok: false, error: 'id required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const ok = await markCalled(cfg, id, String(body?.agent ?? 'dashboard'), body?.notes);
    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  /*
   * Defaults to the number this instance is configured with, so the figures
   * shown match the bot that is running. `phone=all` opts into everything,
   * which is how test and live traffic get compared side by side.
   */
  const phoneParam = url.searchParams.get('phone');
  const phoneNumberId =
    phoneParam === 'all' ? undefined : (phoneParam ?? env.PHONE_NUMBER_ID ?? undefined);

  const range = defaultRange(days, phoneNumberId);

  /*
   * All three run together; none depends on another's numbers. The catalogue
   * is allowed to fail on its own — a Shopify outage should cost the report
   * its product names, not the whole page.
   */
  const [loaded, analytics, products]: [DashboardData, AnalyticsData, CatalogEntry[]] =
    await Promise.all([
      loadDashboard(cfg, range),
      loadAnalytics(cfg, range),
      catalog ? catalog().catch(() => [] as CatalogEntry[]) : Promise.resolve([] as CatalogEntry[]),
    ]);

  const data = nameProducts(loaded, products);

  /*
   * One shopper's messages, fetched on demand rather than shipped with the
   * report. Sending every transcript to the browser to render one of them
   * would push far more personal data than the reader asked for.
   */
  if (path === '/dashboard/api/transcript') {
    const waId = (url.searchParams.get('wa') ?? '').replace(/\D/g, '');
    if (!waId) {
      return new Response(JSON.stringify({ error: 'wa required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    /*
     * Product names come from the live catalogue for the same reason they do
     * on the product tables: the database can only name a product it has
     * recorded a sale for, and a transcript reading "tapped look:9296863461653"
     * tells whoever is reading it nothing at all.
     */
    const names = new Map(products.map((p) => [p.id, p.title]));
    const rows = humaniseTranscript(await transcript(cfg, waId), names);

    return new Response(JSON.stringify(rows, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (path === '/dashboard/api') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Aggregates over a shared inbox: never let a proxy cache them.
      'cache-control': 'no-store',
    };

    /*
     * The token arrived in the URL, so remember it.
     *
     * The app reads its token from the query string, which puts it in browser
     * history and in Nginx's access log on every visit. Handing back a session
     * cookie here means the next visit can be a bare /dashboard link: the app
     * sends no token and this cookie authorises the call instead.
     *
     * A session token rather than the shared secret, so a copy taken from a
     * browser expires by itself and cannot be used to mint more.
     */
    if (fromQuery) {
      const session = await sign(signingSecret, 'dashboard');
      headers['set-cookie'] =
        `rdash=${encodeURIComponent(session)}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEFAULT_TTL_SECONDS}`;
    }

    return new Response(JSON.stringify({ ...data, analytics }, null, 2), { status: 200, headers });
  }

  /*
   * Everything else under /dashboard is the app itself — index.html and the
   * hashed assets beside it — which Nginx serves straight from dashboard/dist
   * and never proxies here. A path that reaches this line is one the API does
   * not have.
   */
  return new Response('Not found', { status: 404 });
}
