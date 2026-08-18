/**
 * Minimal Supabase (PostgREST) client.
 *
 * Deliberately built on bare `fetch` rather than @supabase/supabase-js:
 *
 *   - It has to run unchanged on a Cloudflare Worker today and on Node/Linode
 *     later. `fetch` is the only data path both share natively.
 *   - The Worker bundle stays small; the official client pulls in a websocket
 *     realtime stack this project never uses.
 *   - Every request here is a plain REST call, so a failure is legible in
 *     `wrangler tail` as a status code and a body rather than a wrapped error.
 *
 * Writes use the SERVICE ROLE key, which bypasses row level security. That key
 * lives only in server-side config — never in the dashboard's browser bundle.
 */

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export function supabaseConfigured(cfg: Partial<SupabaseConfig> | undefined): cfg is SupabaseConfig {
  return Boolean(cfg?.url && cfg?.serviceKey);
}

/** Nothing here throws on a bad response — callers log and continue. */
export interface DbResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

function baseHeaders(cfg: SupabaseConfig): Record<string, string> {
  return {
    apikey: cfg.serviceKey,
    Authorization: `Bearer ${cfg.serviceKey}`,
    'Content-Type': 'application/json',
  };
}

async function call<T>(
  cfg: SupabaseConfig,
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<DbResult<T>> {
  const { prefer, ...rest } = init;
  const url = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${path}`;

  try {
    const res = await fetch(url, {
      ...rest,
      headers: {
        ...baseHeaders(cfg),
        ...(prefer ? { Prefer: prefer } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });

    const text = await res.text();
    if (!res.ok) {
      console.log('[db:error]', res.status, path, text.slice(0, 300));
      return { ok: false, status: res.status, data: null, error: text.slice(0, 300) };
    }

    // `return=minimal` and DELETE both answer with an empty body.
    if (!text) return { ok: true, status: res.status, data: null };

    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: true, status: res.status, data: null };
    }
  } catch (err) {
    // A database outage must never take the bot down with it. Analytics is
    // strictly best-effort; the shopper still gets their reply.
    console.log('[db:unreachable]', path, String(err));
    return { ok: false, status: 0, data: null, error: String(err) };
  }
}

export function select<T = unknown[]>(
  cfg: SupabaseConfig,
  table: string,
  query = '',
): Promise<DbResult<T>> {
  return call<T>(cfg, `${table}?${query}`, { method: 'GET' });
}

export function insert(
  cfg: SupabaseConfig,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<DbResult> {
  return call(cfg, table, {
    method: 'POST',
    body: JSON.stringify(rows),
    prefer: 'return=minimal',
  });
}

/**
 * Insert, or update the row that already owns the conflicting key.
 *
 * `onConflict` must name a column set carrying a unique index, otherwise
 * PostgREST answers 400 rather than silently inserting a duplicate.
 */
export function upsert(
  cfg: SupabaseConfig,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string,
): Promise<DbResult> {
  return call(cfg, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    body: JSON.stringify(rows),
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

/**
 * Insert, but ignore the row if the key already exists.
 *
 * This is how webhook retries are absorbed: Meta re-delivers the same message
 * id, the partial unique index on (wamid, status) rejects it, and
 * `resolution=ignore-duplicates` turns that rejection into a no-op instead of
 * an error the caller has to special-case.
 */
export function insertIgnore(
  cfg: SupabaseConfig,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string,
): Promise<DbResult> {
  return call(cfg, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    body: JSON.stringify(rows),
    prefer: 'resolution=ignore-duplicates,return=minimal',
  });
}

export function update(
  cfg: SupabaseConfig,
  table: string,
  filter: string,
  patch: Record<string, unknown>,
): Promise<DbResult> {
  return call(cfg, `${table}?${filter}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    prefer: 'return=minimal',
  });
}

export function remove(cfg: SupabaseConfig, table: string, filter: string): Promise<DbResult> {
  return call(cfg, `${table}?${filter}`, { method: 'DELETE', prefer: 'return=minimal' });
}

/** Calls a Postgres function, e.g. kv_sweep(). */
export function rpc<T = unknown>(
  cfg: SupabaseConfig,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<DbResult<T>> {
  return call<T>(cfg, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
}
