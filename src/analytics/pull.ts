/**
 * The nightly pull.
 *
 * Most of the dashboard runs on webhook data, which arrives on its own. Three
 * things do not, and this is where they come from:
 *
 *   1. Orders. A Worker cannot observe a shopper returning from GoKwik, so
 *      revenue is never learned from WhatsApp. It is read from Shopify and
 *      matched on the UTMs checkoutUrl() stamps onto every checkout link.
 *   2. Template performance. Meta keeps read and click counts for only SEVEN
 *      DAYS. Without copying them daily, a month of campaign history simply
 *      cannot be shown — no query can recover data Meta has deleted.
 *   3. Drop-off. Abandonment produces no webhook at all, so silent sessions
 *      are swept into `dropped_at_step` here.
 *
 * Dependencies are injected rather than imported, because the Graph and
 * Shopify clients live in index.ts and importing them back would make the
 * module graph circular.
 */

import {
  type SupabaseConfig,
  insert,
  upsert,
} from '../platform/supabase.js';
import { sweepAbandoned } from './log.js';
import { SupabaseStore } from '../platform/store.js';

export interface PullDeps {
  /** Graph API GET, already authenticated. Mirrors graphCall() in index.ts. */
  graphCall: (path: string) => Promise<{ status: number; body: unknown }>;
  /** Shopify Admin API GET, already authenticated and token-refreshing. */
  shopifyFetch: (path: string) => Promise<Response>;
}

export interface PullEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  PHONE_NUMBER_ID?: string;
  WABA_ID?: string;
  IND_SHOPIFY_STORE?: string;
}

export interface PullSummary {
  ranAt: string;
  orders: number;
  orderItems: number;
  templates: number;
  quality: string | null;
  abandoned: number;
  swept: number;
  errors: string[];
}

const DAY_MS = 24 * 3600 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Shopify — orders and revenue
 * ------------------------------------------------------------------ */

interface ShopifyLineItem {
  product_id: number | null;
  variant_id: number | null;
  sku: string | null;
  title: string;
  variant_title: string | null;
  quantity: number;
  price: string;
}

interface ShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  total_price: string;
  currency: string;
  landing_site: string | null;
  referring_site: string | null;
  financial_status: string | null;
  line_items?: ShopifyLineItem[];
  /** Comma-separated. createShopifyOrder() stamps 'whatsapp-bot' on every order. */
  tags?: string | null;
}

/** The tag createShopifyOrder() puts on everything it creates. */
const BOT_TAG = 'whatsapp-bot';

/**
 * Whether this order came from the bot.
 *
 * Two routes, because the bot has had two checkouts. The old one sent the
 * shopper to reistor.in with utm_source on the URL, which Shopify recorded as
 * `landing_site`. The Razorpay flow creates the order through the Admin API
 * instead — nobody browses the store, so there is no landing site at all and
 * the UTM test rejected every single order. That is why revenue read zero
 * while the funnel counted sales.
 */
function isBotOrder(order: ShopifyOrder): boolean {
  if (utmOf(order).source === 'whatsapp') return true;
  return (order.tags ?? '')
    .split(',')
    .some((t) => t.trim().toLowerCase() === BOT_TAG);
}

/** Reads the UTM values the bot wrote, from wherever Shopify recorded them. */
function utmOf(order: ShopifyOrder): { source?: string; medium?: string } {
  const site = order.landing_site ?? '';
  const match = (key: string): string | undefined => {
    const hit = new RegExp(`[?&]${key}=([^&]+)`).exec(site);
    return hit ? decodeURIComponent(hit[1]) : undefined;
  };
  return { source: match('utm_source'), medium: match('utm_medium') };
}

/**
 * Pulls recent orders and keeps the ones the bot sent.
 *
 * `days` overlaps deliberately — a re-run covering the same window upserts
 * rather than duplicating, so a missed night is fixed by simply running again.
 */
export async function pullOrders(
  cfg: SupabaseConfig,
  deps: PullDeps,
  days = 3,
): Promise<{ orders: number; items: number; error?: string }> {
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const query =
    `orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}` +
    `&fields=id,name,created_at,total_price,currency,landing_site,referring_site,financial_status,line_items,tags`;

  const res = await deps.shopifyFetch(query);
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    console.log('[pull:shopify-error]', res.status, text);
    return { orders: 0, items: 0, error: `shopify ${res.status}: ${text}` };
  }

  const body = (await res.json()) as { orders?: ShopifyOrder[] };
  const all = body.orders ?? [];

  // Only WhatsApp-attributed orders. Everything else is somebody else's channel
  // and would inflate the bot's conversion rate if counted.
  const attributed = all.filter(isBotOrder);

  for (const order of attributed) {
    const utm = utmOf(order);
    await upsert(
      cfg,
      'orders',
      {
        order_id: String(order.id),
        order_number: order.name,
        total_inr: Number(order.total_price) || 0,
        currency: order.currency || 'INR',
        landing_site: order.landing_site,
        // Stamped rather than passed through. Every consumer — v_shopper_value,
        // v_product_conversion, revenue() — filters on utm_source = 'whatsapp',
        // and an Admin-API order has no landing site to read it from.
        utm_source: utm.source ?? 'whatsapp',
        utm_medium: utm.medium ?? null,
        financial_status: order.financial_status,
        created_at: order.created_at,
        synced_at: new Date().toISOString(),
      },
      'order_id',
    );

    const items = order.line_items ?? [];
    if (items.length) {
      await upsert(
        cfg,
        'order_items',
        items.map((li) => ({
          order_id: String(order.id),
          // Shopify's product id is what the bot uses as Product.id, so this
          // joins straight onto products_shown without a lookup table.
          product_id: li.product_id ? String(li.product_id) : null,
          variant_sku: li.sku,
          title: li.title,
          size: li.variant_title,
          quantity: li.quantity,
          price_inr: Number(li.price) || 0,
        })),
        'order_id,product_id,size',
      );
    }
  }

  console.log('[pull:orders]', `fetched=${all.length}`, `whatsapp=${attributed.length}`);
  return {
    orders: attributed.length,
    items: attributed.reduce((n, o) => n + (o.line_items?.length ?? 0), 0),
  };
}

/* ------------------------------------------------------------------ *
 * Meta — template performance
 * ------------------------------------------------------------------ */

interface TemplateRow {
  id: string;
  name: string;
  status?: string;
  quality_score?: { score?: string };
}

/**
 * Copies template analytics into Postgres before Meta drops them.
 *
 * Read and click counts survive only 7 days on Meta's side, so this is not an
 * optimisation — it is the only way a month of campaign performance can exist.
 */
export async function pullTemplateStats(
  cfg: SupabaseConfig,
  deps: PullDeps,
  wabaId: string,
  days = 2,
): Promise<{ templates: number; error?: string }> {
  const listed = await deps.graphCall(
    `${wabaId}/message_templates?fields=id,name,status,quality_score&limit=100`,
  );
  const templates = (listed.body as { data?: TemplateRow[] })?.data ?? [];
  if (!templates.length) return { templates: 0, error: 'no templates on this WABA' };

  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 3600;
  const ids = templates.map((t) => t.id);

  const analytics = await deps.graphCall(
    `${wabaId}/template_analytics` +
      `?start=${start}&end=${end}&granularity=DAILY` +
      `&metric_types=${encodeURIComponent(JSON.stringify(['SENT', 'DELIVERED', 'READ', 'CLICKED']))}` +
      `&template_ids=${encodeURIComponent(JSON.stringify(ids))}`,
  );

  if (analytics.status !== 200) {
    const msg = JSON.stringify(analytics.body).slice(0, 300);
    console.log('[pull:template-analytics-error]', analytics.status, msg);
    // Not fatal, and common: analytics has to be enabled per WABA, and is
    // unavailable to EU and Japan accounts entirely.
    return { templates: 0, error: `template_analytics ${analytics.status}: ${msg}` };
  }

  const nameById = new Map(templates.map((t) => [t.id, t.name]));
  const blocks = (analytics.body as { data?: { data_points?: any[] }[] })?.data ?? [];

  let written = 0;
  for (const block of blocks) {
    for (const point of block.data_points ?? []) {
      const templateId = String(point.template_id ?? '');
      if (!templateId) continue;

      // `clicked` comes back as an array of per-button objects, not a number.
      const clicked = Array.isArray(point.clicked)
        ? point.clicked.reduce((sum: number, c: any) => sum + (Number(c?.count) || 0), 0)
        : Number(point.clicked) || 0;

      await upsert(
        cfg,
        'template_stats',
        {
          date: isoDate(new Date((Number(point.start) || start) * 1000)),
          template_id: templateId,
          template_name: nameById.get(templateId) ?? null,
          sent: Number(point.sent) || 0,
          delivered: Number(point.delivered) || 0,
          read: Number(point.read) || 0,
          clicked,
          synced_at: new Date().toISOString(),
        },
        'date,template_id',
      );
      written++;
    }
  }

  console.log('[pull:templates]', written, 'rows');
  return { templates: written };
}

/* ------------------------------------------------------------------ *
 * Meta — account health
 * ------------------------------------------------------------------ */

/**
 * Snapshots quality rating and messaging tier.
 *
 * Both also arrive by webhook (phone_number_quality_update, account_alerts),
 * so this is a safety net rather than the primary source — it guarantees the
 * dashboard has a current value even if a webhook was missed while the service
 * was down.
 */
export async function pullAccountHealth(
  cfg: SupabaseConfig,
  deps: PullDeps,
  phoneNumberId: string,
  wabaId?: string,
): Promise<{ quality: string | null; error?: string }> {
  const res = await deps.graphCall(
    `${phoneNumberId}?fields=quality_rating,messaging_limit_tier,display_phone_number`,
  );

  if (res.status !== 200) {
    const msg = JSON.stringify(res.body).slice(0, 200);
    console.log('[pull:health-error]', res.status, msg);
    return { quality: null, error: `phone number fields ${res.status}: ${msg}` };
  }

  const body = res.body as {
    quality_rating?: string;
    messaging_limit_tier?: string;
    display_phone_number?: string;
  };

  let templates: unknown = null;
  if (wabaId) {
    const listed = await deps.graphCall(
      `${wabaId}/message_templates?fields=name,status,quality_score&limit=100`,
    );
    templates = (listed.body as { data?: unknown[] })?.data ?? null;
  }

  await insert(cfg, 'account_health', {
    captured_at: new Date().toISOString(),
    phone_number_id: phoneNumberId,
    quality_rating: body.quality_rating ?? null,
    messaging_tier: body.messaging_limit_tier ?? null,
    templates,
  });

  return { quality: body.quality_rating ?? null };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * One nightly run.
 *
 * Every step is independent and every failure is collected rather than thrown,
 * so a Shopify outage does not also cost you the template stats that expire in
 * seven days. The summary is returned for the /admin/pull route to display.
 */
export async function runDailyPull(env: PullEnv, deps: PullDeps): Promise<PullSummary> {
  const summary: PullSummary = {
    ranAt: new Date().toISOString(),
    orders: 0,
    orderItems: 0,
    templates: 0,
    quality: null,
    abandoned: 0,
    swept: 0,
    errors: [],
  };

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    summary.errors.push('SUPABASE_URL / SUPABASE_SERVICE_KEY unset — nothing to pull into');
    return summary;
  }

  const cfg: SupabaseConfig = {
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  };

  if (env.IND_SHOPIFY_STORE) {
    try {
      const res = await pullOrders(cfg, deps);
      summary.orders = res.orders;
      summary.orderItems = res.items;
      if (res.error) summary.errors.push(res.error);
    } catch (err) {
      summary.errors.push(`orders: ${String(err)}`);
    }
  }

  if (env.WABA_ID) {
    try {
      const res = await pullTemplateStats(cfg, deps, env.WABA_ID);
      summary.templates = res.templates;
      if (res.error) summary.errors.push(res.error);
    } catch (err) {
      summary.errors.push(`templates: ${String(err)}`);
    }
  } else {
    summary.errors.push('WABA_ID unset — template performance cannot be pulled');
  }

  if (env.PHONE_NUMBER_ID) {
    try {
      const res = await pullAccountHealth(cfg, deps, env.PHONE_NUMBER_ID, env.WABA_ID);
      summary.quality = res.quality;
      if (res.error) summary.errors.push(res.error);
    } catch (err) {
      summary.errors.push(`health: ${String(err)}`);
    }
  }

  try {
    summary.abandoned = await sweepAbandoned(cfg);
  } catch (err) {
    summary.errors.push(`sweep: ${String(err)}`);
  }

  try {
    summary.swept = await new SupabaseStore(cfg).sweep();
  } catch (err) {
    summary.errors.push(`kv sweep: ${String(err)}`);
  }

  console.log('[pull:done]', JSON.stringify(summary));
  return summary;
}
