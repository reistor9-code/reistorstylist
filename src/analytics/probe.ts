/**
 * Analytics self-test.
 *
 * Every write in the pipeline is best-effort and swallows its errors, which is
 * right for a shopper mid-conversation and useless when you are trying to work
 * out why a table is empty. A failed insert and a quiet afternoon look exactly
 * the same from outside.
 *
 * This does the same writes on purpose and reports what actually came back —
 * status codes, error text, and which Supabase key is in use.
 *
 *   GET /admin/analytics?token=<VERIFY_TOKEN>
 */

import type { Env } from '../types';
import { insert, remove, select, supabaseConfigured, type SupabaseConfig } from '../platform/supabase';

/**
 * Reads the `role` claim from a Supabase key.
 *
 * Supabase keys are JWTs whose payload names the role. `anon` is the single
 * most common cause of an empty analytics table: it is the key on the first
 * page of the dashboard, it looks identical, and under row-level security it
 * fails every read and every write in silence. `service_role` is required.
 *
 * Only the role is decoded — the signature is never touched and nothing
 * secret is returned.
 */
function keyRole(key?: string): string {
  if (!key) return 'unset';
  const parts = key.split('.');
  if (parts.length !== 3) return 'not a JWT — check you copied the whole key';
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return String(payload.role ?? 'unknown');
  } catch {
    return 'undecodable';
  }
}

export async function analyticsProbe(env: Env): Promise<Record<string, unknown>> {
  const cfg = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY };
  const role = keyRole(env.SUPABASE_SERVICE_KEY);

  const report: Record<string, unknown> = {
    supabaseUrl: env.SUPABASE_URL ? `${env.SUPABASE_URL.slice(0, 34)}…` : 'unset',
    keyRole: role,
    keyIsCorrect: role === 'service_role',
    dashboardToken: env.DASHBOARD_TOKEN ? 'set' : 'unset',
    capi: env.META_DATASET_ID && env.META_CAPI_TOKEN ? 'configured' : 'not configured',
  };

  if (!supabaseConfigured(cfg)) {
    report.verdict = 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set — every write is a no-op.';
    return report;
  }

  const db = cfg as SupabaseConfig;
  const sessionId = crypto.randomUUID();

  // A real insert, not a dry run: row-level security only bites on the real
  // thing, so anything less would pass here and fail in production.
  const written = await insert(db, 'sessions', {
    session_id: sessionId,
    wa_id: 'probe',
    last_step: 'welcome',
    furthest_step: 'welcome',
    entry_source: 'probe',
  });

  report.insert = { ok: written.ok, status: written.status, error: written.error ?? null };

  const read = await select(db, 'sessions', `session_id=eq.${sessionId}&select=session_id`);
  report.readBack = { ok: read.ok, status: read.status, rows: Array.isArray(read.data) ? read.data.length : 0 };

  // Tidy up, so a probe never shows up as a shopper in the funnel.
  const cleaned = await remove(db, 'sessions', `session_id=eq.${sessionId}`);
  report.cleanup = { ok: cleaned.ok, status: cleaned.status };

  const counts = await select(db, 'sessions', 'select=session_id&limit=1');
  report.tableReachable = counts.ok;

  report.verdict = written.ok
    ? 'Writes work. An empty table means no traffic has reached this build — deploy and send a message.'
    : role !== 'service_role'
      ? `Writes are refused and the key is "${role}". Use the service_role key from Supabase → Settings → API.`
      : `Writes are refused: ${written.error ?? 'see status above'}`;

  return report;
}
