/**
 * Every number the dashboard shows, in one place.
 *
 * Each function answers one question a board actually asks, and each is a read
 * against a view defined in supabase/schema.sql. Aggregation across days is
 * done here in JavaScript rather than in SQL: the row counts are small (one
 * per day per dimension), and keeping the views simple means they stay
 * readable to whoever inherits this.
 *
 * Nothing here throws. A dashboard that renders nine tiles and one error is
 * more useful than a dashboard that renders a stack trace.
 */

import { type SupabaseConfig, select, update } from '../platform/supabase.js';

export interface Range {
  /** Inclusive ISO date, e.g. 2026-08-01. */
  from: string;
  /** Exclusive ISO date. */
  to: string;
  /** Restricts to one number, so test traffic never reaches the board. */
  phoneNumberId?: string;
}

export function defaultRange(days = 30, phoneNumberId?: string): Range {
  const now = Date.now();
  return {
    from: new Date(now - days * 86_400_000).toISOString().slice(0, 10),
    to: new Date(now + 86_400_000).toISOString().slice(0, 10),
    phoneNumberId,
  };
}

/** PostgREST filter fragment restricting a view to one phone number. */
function phoneFilter(range: Range): string {
  return range.phoneNumberId ? `&phone_number_id=eq.${encodeURIComponent(range.phoneNumberId)}` : '';
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/* ------------------------------------------------------------------ *
 * Funnel — where conversion is lost
 * ------------------------------------------------------------------ */

export interface FunnelStep {
  step: string;
  label: string;
  sessions: number;
  /** Percentage of the previous step lost here. */
  lostPct: number;
}

export async function funnel(cfg: SupabaseConfig, range: Range): Promise<FunnelStep[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_funnel',
    `day=gte.${range.from}&day=lt.${range.to}${phoneFilter(range)}&select=*`,
  );

  const rows = res.data ?? [];
  const total = (key: string) => rows.reduce((sum, r) => sum + num(r[key]), 0);

  const steps: { step: string; label: string; value: number }[] = [
    { step: 'started', label: 'Started a chat', value: total('started') },
    { step: 'picked_occasion', label: 'Picked an occasion', value: total('picked_occasion') },
    { step: 'picked_category', label: 'Picked a category', value: total('picked_category') },
    { step: 'saw_looks', label: 'Saw looks', value: total('saw_looks') },
    { step: 'opened_product', label: 'Opened a product', value: total('opened_product') },
    { step: 'picked_size', label: 'Picked a size', value: total('picked_size') },
    { step: 'opened_checkout', label: 'Opened checkout', value: total('opened_checkout') },
    { step: 'ordered', label: 'Ordered', value: total('ordered') },
  ];

  return steps.map((s, i) => {
    const previous = i === 0 ? s.value : steps[i - 1].value;
    /*
     * Floored at zero, because these steps are counted independently rather
     * than as a strict funnel and a later one can legitimately outrun an
     * earlier one. A multi-item basket reaches checkout once for the whole
     * bag while picked_size fires per garment, so "Opened checkout" has read
     * higher than "Picked a size" — which produced a "-44.4% lost" on the
     * page. Negative loss means nothing to whoever is reading it.
     */
    const lost = previous > 0 ? ((previous - s.value) / previous) * 100 : 0;
    return {
      step: s.step,
      label: s.label,
      sessions: s.value,
      lostPct: Math.max(0, Math.round(lost * 10) / 10),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Callbacks — the only tile that is a to-do list
 * ------------------------------------------------------------------ */

export interface Callback {
  id: number;
  /** The number to ring. Meta delivers it unmasked; the shopper messaged first. */
  waId: string;
  profileName: string | null;
  occasion: string | null;
  category: string | null;
  productsSeen: string[];
  requestedAt: string;
  hoursWaiting: number;
  /** Past 24h the promise is already broken. */
  overdue: boolean;
  /** False once the free-form WhatsApp window shuts. A phone call is unaffected. */
  windowOpen: boolean;
  /**
   * True when this person has opted out of marketing. They may still be called
   * about the request they made — that is service — but they must never be
   * added to a promotional send.
   */
  marketingOptOut: boolean;
  status: string;
  calledAt: string | null;
  calledBy: string | null;
}

/**
 * The callback queue, oldest first.
 *
 * Oldest first rather than newest: this is a work list, and the person who has
 * been waiting longest is the one at risk of being let down.
 */
export async function callbacks(
  cfg: SupabaseConfig,
  range: Range,
  limit = 50,
): Promise<Callback[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_callbacks',
    `status=eq.pending${phoneFilter(range)}&select=*&order=requested_at.asc&limit=${limit}`,
  );

  return (res.data ?? []).map((r) => ({
    id: num(r.id),
    waId: String(r.wa_id ?? ''),
    profileName: (r.profile_name as string) ?? null,
    occasion: (r.occasion as string) ?? null,
    category: (r.category as string) ?? null,
    productsSeen: Array.isArray(r.products_seen) ? (r.products_seen as string[]) : [],
    requestedAt: String(r.requested_at ?? ''),
    hoursWaiting: num(r.hours_waiting),
    overdue: num(r.hours_waiting) >= 24,
    windowOpen: r.window_open === true,
    marketingOptOut: r.marketing_opt_out === true,
    status: String(r.status ?? 'pending'),
    calledAt: (r.called_at as string) ?? null,
    calledBy: (r.called_by as string) ?? null,
  }));
}

/** Marks one request handled. The only write the dashboard performs. */
export async function markCalled(
  cfg: SupabaseConfig,
  id: number,
  agent: string,
  notes?: string,
): Promise<boolean> {
  const res = await update(cfg, 'callback_requests', `id=eq.${id}&status=eq.pending`, {
    status: 'called',
    called_at: new Date().toISOString(),
    called_by: agent.slice(0, 80),
    ...(notes ? { notes: notes.slice(0, 500) } : {}),
  });
  return res.ok;
}

/* ------------------------------------------------------------------ *
 * Products
 * ------------------------------------------------------------------ */

export interface TopProduct {
  productId: string;
  title: string;
  /** Shopify SKU, resolved from the live catalogue. Null when unknown. */
  sku: string | null;
  unitsSold: number;
  revenueINR: number;
  orders: number;
  lastSoldAt: string | null;
}

export async function topProducts(cfg: SupabaseConfig, limit = 10): Promise<TopProduct[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_top_products',
    `select=*&order=units_sold.desc&limit=${limit}`,
  );

  return (res.data ?? []).map((r) => ({
    productId: String(r.product_id ?? ''),
    title: String(r.title ?? r.product_id ?? 'Unknown'),
    sku: null,
    unitsSold: num(r.units_sold),
    revenueINR: num(r.revenue_inr),
    orders: num(r.orders),
    lastSoldAt: (r.last_sold_at as string) ?? null,
  }));
}

export interface ProductConversion {
  productId: string;
  /** Null only if the product has never been seen by the logger. */
  title: string | null;
  /** Shopify SKU, resolved from the live catalogue. Null when unknown. */
  sku: string | null;
  timesShown: number;
  timesSized: number;
  unitsSold: number;
  conversionPct: number;
}

/**
 * Shown -> sized -> sold, per product.
 *
 * "Shown" counts sessions the product appeared in, not messages, so a product
 * that rides along in three rounds of one conversation is not credited three
 * times.
 */
export async function productConversion(
  cfg: SupabaseConfig,
  limit = 25,
): Promise<ProductConversion[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_product_conversion',
    `select=*&order=times_shown.desc&limit=${limit}`,
  );

  return (res.data ?? []).map((r) => ({
    productId: String(r.product_id ?? ''),
    title: (r.title as string) ?? null,
    sku: null,
    timesShown: num(r.times_shown),
    timesSized: num(r.times_sized),
    unitsSold: num(r.units_sold),
    conversionPct: num(r.conversion_pct),
  }));
}

/* ------------------------------------------------------------------ *
 * Lost demand — the restock list
 * ------------------------------------------------------------------ */

export interface LostDemand {
  productId: string;
  /** Null only if the product has never been seen by the logger. */
  title: string | null;
  /** Shopify SKU, resolved from the live catalogue. Null when unknown. */
  sku: string | null;
  size: string | null;
  times: number;
  lastAt: string | null;
}

/**
 * Shoppers who reached sizing and found nothing.
 *
 * The most directly actionable number the bot produces: interest was already
 * proven by the time this fires, so each row is a sale lost to stock rather
 * than to persuasion.
 */
export async function lostDemand(cfg: SupabaseConfig, range: Range, limit = 20): Promise<LostDemand[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_lost_demand',
    `select=*${phoneFilter(range)}&order=times.desc&limit=${limit}`,
  );

  return (res.data ?? []).map((r) => ({
    productId: String(r.product_id ?? ''),
    title: (r.title as string) ?? null,
    sku: null,
    size: (r.size as string) ?? null,
    times: num(r.times),
    lastAt: (r.last_at as string) ?? null,
  }));
}

/* ------------------------------------------------------------------ *
 * Demand grid — what shoppers asked for
 * ------------------------------------------------------------------ */

export interface DemandCell {
  occasion: string;
  category: string;
  requests: number;
  hadNothing: number;
  orders: number;
}

export async function demandGrid(cfg: SupabaseConfig, range: Range): Promise<DemandCell[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_demand_grid',
    `select=*${phoneFilter(range)}&order=requests.desc&limit=100`,
  );

  return (res.data ?? []).map((r) => ({
    occasion: String(r.occasion ?? ''),
    category: String(r.category ?? ''),
    requests: num(r.requests),
    hadNothing: num(r.had_nothing),
    orders: num(r.orders),
  }));
}

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

export interface CampaignStat {
  templateName: string;
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  readPct: number;
  clickPct: number;
}

export async function campaigns(cfg: SupabaseConfig, range: Range): Promise<CampaignStat[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'template_stats',
    `date=gte.${range.from}&date=lt.${range.to}&select=*`,
  );

  const byName = new Map<string, CampaignStat>();
  for (const row of res.data ?? []) {
    const name = String(row.template_name ?? row.template_id ?? 'unknown');
    const acc =
      byName.get(name) ??
      { templateName: name, sent: 0, delivered: 0, read: 0, clicked: 0, readPct: 0, clickPct: 0 };
    acc.sent += num(row.sent);
    acc.delivered += num(row.delivered);
    acc.read += num(row.read);
    acc.clicked += num(row.clicked);
    byName.set(name, acc);
  }

  return [...byName.values()]
    .map((c) => ({
      ...c,
      // Against delivered, not sent: a message that never arrived says nothing
      // about the copy.
      readPct: c.delivered ? Math.round((c.read / c.delivered) * 1000) / 10 : 0,
      clickPct: c.delivered ? Math.round((c.clicked / c.delivered) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.sent - a.sent);
}

/* ------------------------------------------------------------------ *
 * Delivery, cost and attrition
 * ------------------------------------------------------------------ */

export interface DeliveryStats {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  deliveredPct: number;
  readPct: number;
}

export async function delivery(cfg: SupabaseConfig, range: Range): Promise<DeliveryStats> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_delivery',
    `day=gte.${range.from}&day=lt.${range.to}${phoneFilter(range)}&select=*`,
  );

  const rows = res.data ?? [];
  const total = (key: string) => rows.reduce((sum, r) => sum + num(r[key]), 0);

  const sent = total('sent');
  const read = total('read');

  /*
   * A message that was read was necessarily delivered, so the read count is a
   * floor under the delivered one. Taking the larger of the two repairs a real
   * gap: delivery receipts were dropped for a while — parseInbound() returned
   * null for status batches — leaving messages with a read row and no
   * delivered row. Without this, read came out at 118.6% of delivered.
   */
  const delivered = Math.max(total('delivered'), read);

  return {
    sent,
    delivered,
    read,
    failed: total('failed'),
    deliveredPct: sent ? Math.round((delivered / sent) * 1000) / 10 : 0,
    // A floor, not a true rate: a shopper with read receipts disabled never
    // produces a read status, however carefully they read the message.
    readPct: delivered ? Math.round((read / delivered) * 1000) / 10 : 0,
  };
}

export interface CostStats {
  billableMessages: number;
  freeMessages: number;
  byCategory: { category: string; messages: number }[];
}

export async function cost(cfg: SupabaseConfig, range: Range): Promise<CostStats> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_message_cost',
    `day=gte.${range.from}&day=lt.${range.to}${phoneFilter(range)}&select=*`,
  );

  const rows = res.data ?? [];
  const byCategory = new Map<string, number>();
  let billable = 0;
  let free = 0;

  for (const r of rows) {
    billable += num(r.billable_messages);
    free += num(r.free_messages);
    const cat = String(r.pricing_category ?? 'unknown');
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + num(r.total_messages));
  }

  return {
    billableMessages: billable,
    freeMessages: free,
    byCategory: [...byCategory.entries()]
      .map(([category, messages]) => ({ category, messages }))
      .sort((a, b) => b.messages - a.messages),
  };
}

export interface Attrition {
  optedOut: number;
  abandoned: number;
  /** Sessions that dropped, grouped by the step they died at. */
  droppedByStep: { step: string; sessions: number }[];
}

export async function attrition(cfg: SupabaseConfig, range: Range): Promise<Attrition> {
  const [optOuts, drops] = await Promise.all([
    select<Record<string, unknown>[]>(
      cfg,
      'shoppers',
      `marketing_opt_out=eq.true&select=wa_id`,
    ),
    select<Record<string, unknown>[]>(
      cfg,
      'v_dropoff',
      `select=*${phoneFilter(range)}&order=sessions.desc`,
    ),
  ]);

  const droppedByStep = (drops.data ?? []).map((r) => ({
    step: String(r.step ?? 'unknown'),
    sessions: num(r.sessions),
  }));

  return {
    optedOut: (optOuts.data ?? []).length,
    abandoned: droppedByStep.reduce((sum, d) => sum + d.sessions, 0),
    droppedByStep,
  };
}

/* ------------------------------------------------------------------ *
 * Health and revenue
 * ------------------------------------------------------------------ */

export interface Health {
  qualityRating: string | null;
  messagingTier: string | null;
  capturedAt: string | null;
  templates: { name: string; status: string; quality?: string }[];
}

export async function health(cfg: SupabaseConfig, phoneNumberId?: string): Promise<Health> {
  const filter = phoneNumberId
    ? `phone_number_id=eq.${encodeURIComponent(phoneNumberId)}&`
    : '';
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'account_health',
    `${filter}select=*&order=captured_at.desc&limit=1`,
  );

  const row = res.data?.[0];
  const rawTemplates = Array.isArray(row?.templates) ? (row!.templates as any[]) : [];

  return {
    qualityRating: (row?.quality_rating as string) ?? null,
    messagingTier: (row?.messaging_tier as string) ?? null,
    capturedAt: (row?.captured_at as string) ?? null,
    templates: rawTemplates.map((t) => ({
      name: String(t?.name ?? ''),
      status: String(t?.status ?? ''),
      quality: t?.quality_score?.score ? String(t.quality_score.score) : undefined,
    })),
  };
}

export interface Revenue {
  orders: number;
  revenueINR: number;
  averageOrderINR: number;
  costPerOrder: number | null;
}

export async function revenue(
  cfg: SupabaseConfig,
  range: Range,
  billableMessages: number,
): Promise<Revenue> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'orders',
    `created_at=gte.${range.from}&created_at=lt.${range.to}` +
      `&utm_source=eq.whatsapp&select=order_id,total_inr`,
  );

  const rows = res.data ?? [];
  const total = rows.reduce((sum, r) => sum + num(r.total_inr), 0);

  return {
    orders: rows.length,
    revenueINR: total,
    averageOrderINR: rows.length ? Math.round(total / rows.length) : 0,
    /*
     * Messages per order, not rupees per order. Meta's rate varies by category
     * and country, and inventing a rupee figure from a rate that is not in the
     * webhook would be a number nobody could reconcile against the invoice.
     */
    costPerOrder: rows.length ? Math.round((billableMessages / rows.length) * 10) / 10 : null,
  };
}

/* ------------------------------------------------------------------ *
 * The whole dashboard
 * ------------------------------------------------------------------ */

export interface DashboardData {
  range: Range;
  generatedAt: string;
  /** Pending callback requests — a work list, not a report. */
  callbacks: Callback[];
  funnel: FunnelStep[];
  topProducts: TopProduct[];
  productConversion: ProductConversion[];
  lostDemand: LostDemand[];
  demandGrid: DemandCell[];
  campaigns: CampaignStat[];
  delivery: DeliveryStats;
  cost: CostStats;
  attrition: Attrition;
  health: Health;
  revenue: Revenue;
}

/**
 * Collects everything for one render.
 *
 * The tiles are independent, so they are fetched concurrently — the page is
 * only as slow as its slowest query rather than the sum of eleven.
 */
export async function loadDashboard(cfg: SupabaseConfig, range: Range): Promise<DashboardData> {
  const [
    callbackRows,
    funnelRows,
    top,
    conversion,
    lost,
    grid,
    campaignRows,
    deliveryStats,
    costStats,
    attritionStats,
    healthRow,
  ] = await Promise.all([
    callbacks(cfg, range),
    funnel(cfg, range),
    topProducts(cfg),
    productConversion(cfg),
    lostDemand(cfg, range),
    demandGrid(cfg, range),
    campaigns(cfg, range),
    delivery(cfg, range),
    cost(cfg, range),
    attrition(cfg, range),
    health(cfg, range.phoneNumberId),
  ]);

  // Depends on the cost figure, so it waits for it rather than joining the
  // batch above.
  const revenueStats = await revenue(cfg, range, costStats.billableMessages);

  return {
    range,
    generatedAt: new Date().toISOString(),
    callbacks: callbackRows,
    funnel: funnelRows,
    topProducts: top,
    productConversion: conversion,
    lostDemand: lost,
    demandGrid: grid,
    campaigns: campaignRows,
    delivery: deliveryStats,
    cost: costStats,
    attrition: attritionStats,
    health: healthRow,
    revenue: revenueStats,
  };
}
