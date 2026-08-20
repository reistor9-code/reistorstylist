/**
 * The nightly job.
 *
 * Everything the dashboard cannot learn from a live webhook: orders from
 * Shopify, template performance and account health from Meta, the abandoned
 * sweep, and a stock snapshot so lost demand can be told from a shelf that has
 * since been refilled.
 *
 * NONE OF THIS SENDS A MESSAGE. Meta restricts a number for what it sends —
 * unsolicited marketing, a rising block rate — not for reading your own
 * account. The Meta calls here are two authenticated GETs a day against your
 * own WABA, which is well inside any rate limit and is the same data the
 * WhatsApp Manager screen shows. Reading it more often than never is what
 * gives you warning before a rating falls.
 */

import type { Env } from './types';
import { runDailyPull, type PullSummary } from './analytics/pull';
import { getProducts } from './catalog';
import { shopifyFetch } from './catalog';
import { graphCall } from './whatsapp';
import { supabaseConfigured, upsert, type SupabaseConfig } from './platform/supabase';

export interface JobSummary extends PullSummary {
  stockRows: number;
}

/**
 * Snapshots every in-stock size.
 *
 * Lost demand on its own says a size was gone when somebody wanted it. Joined
 * against this it says whether it is STILL gone, which is the difference
 * between a report and a restocking list.
 *
 * Upserted on (product_id, size) so the table stays one row per variant rather
 * than growing a history nobody reads.
 */
async function snapshotStock(env: Env, cfg: SupabaseConfig): Promise<number> {
  const products = await getProducts(env);

  const rows = products.flatMap((p) =>
    p.sizes.map((s) => ({
      product_id: p.id,
      size: s.size,
      stock: s.stock,
      captured_at: new Date().toISOString(),
    })),
  );

  if (!rows.length) return 0;

  // Chunked because a single request carrying every variant of 481 products
  // is large enough to be refused.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await upsert(cfg, 'product_stock', rows.slice(i, i + CHUNK), 'product_id,size');
    if (res.ok) written += rows.slice(i, i + CHUNK).length;
    else console.log('[jobs:stock-failed]', res.status, res.error ?? '');
  }
  return written;
}

/**
 * Runs everything and reports what happened.
 *
 * Each step is caught separately: a Shopify outage must not stop the account
 * health read, which is the one that warns you about the number.
 */
export async function runJobs(env: Env): Promise<JobSummary> {
  const summary = await runDailyPull(env, {
    graphCall: (path: string) => graphCall(env, path),
    shopifyFetch: (path: string) => shopifyFetch(env, path),
  });

  let stockRows = 0;
  const cfg = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY };
  if (supabaseConfigured(cfg)) {
    try {
      stockRows = await snapshotStock(env, cfg);
    } catch (err) {
      summary.errors.push(`stock: ${String(err)}`);
    }
  }

  const full: JobSummary = { ...summary, stockRows };
  console.log('[jobs:done]', JSON.stringify(full));
  return full;
}
