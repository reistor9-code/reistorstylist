/**
 * Queries for the reports the base dashboard cannot answer.
 *
 * A companion to queries.ts rather than an edit to it — that file came from
 * another branch and is still moving there. Everything here reads the views
 * added by supabase/schema-analytics.sql.
 *
 * One rule throughout: a failed query is NOT silently an empty result. The
 * base loader does `res.data ?? []`, which makes a permission error and a
 * quiet Tuesday look identical — it cost several hours of debugging to learn
 * that the hard way. Every loader here carries an `errors` list so the front
 * end can say "this number is unavailable" instead of printing a confident
 * zero it cannot back up.
 */

import { select, type SupabaseConfig } from '../platform/supabase.js';
import type { Range } from './queries.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown): string => (v == null ? '' : String(v));

const phoneFilter = (range: Range): string =>
  range.phoneNumberId ? `&phone_number_id=eq.${encodeURIComponent(range.phoneNumberId)}` : '';

const dayFilter = (range: Range, column = 'day'): string =>
  `${column}=gte.${range.from}&${column}=lt.${range.to}`;

/** Collects failures so the page can report them rather than imply a zero. */
class Failures {
  readonly list: string[] = [];
  note(view: string, error?: string): void {
    this.list.push(`${view}: ${error ?? 'query failed'}`);
    console.log('[dashboard:query-failed]', view, error ?? '');
  }
}

/* ------------------------------------------------------------------ *
 * Acquisition
 * ------------------------------------------------------------------ */

export interface AcquisitionRow {
  source: string;
  campaign: string;
  sessions: number;
  engaged: number;
  orders: number;
  revenueINR: number;
  conversionPct: number;
}

/**
 * Rolls the per-day view up to one row per source and campaign.
 *
 * Conversion is recomputed from the totals rather than averaged from the
 * daily figures: the mean of daily percentages is not the percentage of the
 * whole, and the gap widens exactly when traffic is uneven.
 */
export async function acquisition(
  cfg: SupabaseConfig,
  range: Range,
  fail: Failures,
): Promise<AcquisitionRow[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_acquisition',
    `${dayFilter(range)}${phoneFilter(range)}&select=*`,
  );
  if (!res.ok) {
    fail.note('v_acquisition', res.error);
    return [];
  }

  const byKey = new Map<string, AcquisitionRow>();
  for (const r of res.data ?? []) {
    const key = `${str(r.source)}|${str(r.campaign)}`;
    const row =
      byKey.get(key) ??
      {
        source: str(r.source),
        campaign: str(r.campaign),
        sessions: 0,
        engaged: 0,
        orders: 0,
        revenueINR: 0,
        conversionPct: 0,
      };
    row.sessions += num(r.sessions);
    row.engaged += num(r.engaged);
    row.orders += num(r.orders);
    row.revenueINR += num(r.revenue_inr);
    byKey.set(key, row);
  }

  return [...byKey.values()]
    .map((r) => ({
      ...r,
      conversionPct: r.sessions ? Math.round((r.orders / r.sessions) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.revenueINR - a.revenueINR || b.sessions - a.sessions);
}

/* ------------------------------------------------------------------ *
 * Risk — the blocking early warning
 * ------------------------------------------------------------------ */

export interface QualityPoint {
  day: string;
  rating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  messagingTier: string | null;
}

export interface OptOutRow {
  templateName: string;
  optOuts: number;
}

export interface RiskReport {
  quality: QualityPoint[];
  optOuts: OptOutRow[];
  /** Worst rating seen in the window — the thing to act on, not today's. */
  worstRating: QualityPoint['rating'] | null;
  /** True when the rating fell at any point, even if it recovered. */
  declined: boolean;
}

const RANK: Record<number, QualityPoint['rating']> = {
  1: 'RED',
  2: 'YELLOW',
  3: 'GREEN',
  4: 'UNKNOWN',
};

export async function risk(
  cfg: SupabaseConfig,
  range: Range,
  fail: Failures,
): Promise<RiskReport> {
  const [trend, outs] = await Promise.all([
    select<Record<string, unknown>[]>(
      cfg,
      'v_quality_trend',
      `${dayFilter(range)}${phoneFilter(range)}&select=*&order=day.asc`,
    ),
    select<Record<string, unknown>[]>(
      cfg,
      'v_optout_by_campaign',
      `${dayFilter(range)}&select=*`,
    ),
  ]);

  if (!trend.ok) fail.note('v_quality_trend', trend.error);
  if (!outs.ok) fail.note('v_optout_by_campaign', outs.error);

  const quality: QualityPoint[] = (trend.data ?? []).map((r) => ({
    day: str(r.day),
    rating: RANK[num(r.worst_rank)] ?? 'UNKNOWN',
    messagingTier: (r.messaging_tier as string) ?? null,
  }));

  const byTemplate = new Map<string, number>();
  for (const r of outs.data ?? []) {
    const name = str(r.template_name);
    byTemplate.set(name, (byTemplate.get(name) ?? 0) + num(r.opt_outs));
  }

  const ranks = quality.map((q) => Object.values(RANK).indexOf(q.rating));
  const worst = quality.length
    ? quality.reduce((a, b) => (rankOf(b.rating) < rankOf(a.rating) ? b : a)).rating
    : null;

  return {
    quality,
    optOuts: [...byTemplate.entries()]
      .map(([templateName, optOuts]) => ({ templateName, optOuts }))
      .sort((a, b) => b.optOuts - a.optOuts),
    worstRating: worst,
    // A dip that recovered still happened, and is what predicts the next one.
    declined: ranks.length > 1 && Math.min(...ranks) < ranks[0],
  };
}

const rankOf = (r: QualityPoint['rating']): number =>
  r === 'RED' ? 1 : r === 'YELLOW' ? 2 : r === 'GREEN' ? 3 : 4;

/* ------------------------------------------------------------------ *
 * Search misses
 * ------------------------------------------------------------------ */

export interface SearchMiss {
  normalised: string;
  example: string;
  times: number;
  shoppers: number;
  lastStep: string | null;
  lastAt: string | null;
}

export async function searchMisses(
  cfg: SupabaseConfig,
  fail: Failures,
  limit = 30,
): Promise<SearchMiss[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_search_misses',
    `select=*&order=times.desc&limit=${limit}`,
  );
  if (!res.ok) {
    fail.note('v_search_misses', res.error);
    return [];
  }
  return (res.data ?? []).map((r) => ({
    normalised: str(r.normalised),
    example: str(r.example),
    times: num(r.times),
    shoppers: num(r.shoppers),
    lastStep: (r.last_step as string) ?? null,
    lastAt: (r.last_at as string) ?? null,
  }));
}

/* ------------------------------------------------------------------ *
 * Timing — how long, how often
 * ------------------------------------------------------------------ */

export interface TimingReport {
  medianMinutes: number | null;
  p90Minutes: number | null;
  orders: number;
  buyers: number;
  repeatBuyers: number;
  repeatPct: number;
  aovINR: number;
}

export async function timing(
  cfg: SupabaseConfig,
  range: Range,
  fail: Failures,
): Promise<TimingReport> {
  const [ttp, rep] = await Promise.all([
    select<Record<string, unknown>[]>(cfg, 'v_time_to_purchase', `${dayFilter(range)}&select=*`),
    select<Record<string, unknown>[]>(cfg, 'v_repeat_rate', 'select=*'),
  ]);

  if (!ttp.ok) fail.note('v_time_to_purchase', ttp.error);
  if (!rep.ok) fail.note('v_repeat_rate', rep.error);

  const rows = ttp.data ?? [];
  const orders = rows.reduce((s, r) => s + num(r.orders), 0);

  /*
   * A median of medians is not a median. With per-day rows and no raw
   * durations this is the closest honest figure: each day's median weighted
   * by the orders behind it. Named "typical" on the page rather than
   * "median" for that reason.
   */
  const weighted = orders
    ? rows.reduce((s, r) => s + num(r.median_minutes) * num(r.orders), 0) / orders
    : null;

  const r0 = (rep.data ?? [])[0] ?? {};

  return {
    medianMinutes: weighted === null ? null : Math.round(weighted * 10) / 10,
    p90Minutes: rows.length ? Math.max(...rows.map((r) => num(r.p90_minutes))) : null,
    orders,
    buyers: num(r0.buyers),
    repeatBuyers: num(r0.repeat_buyers),
    repeatPct: num(r0.repeat_pct),
    aovINR: num(r0.aov_inr),
  };
}

/* ------------------------------------------------------------------ *
 * When people message
 * ------------------------------------------------------------------ */

export interface HeatCell {
  dow: number;
  hour: number;
  messages: number;
}

/**
 * Times arrive as UTC and are shifted to IST here.
 *
 * Doing it in the view would bake a timezone into the data; doing it in the
 * browser would depend on the reader's laptop. The audience is one team in
 * one country, so it is done once, on the server, and labelled.
 */
const IST_OFFSET_HOURS = 5.5;

export async function hourHeatmap(cfg: SupabaseConfig, fail: Failures): Promise<HeatCell[]> {
  const res = await select<Record<string, unknown>[]>(cfg, 'v_hour_heatmap', 'select=*');
  if (!res.ok) {
    fail.note('v_hour_heatmap', res.error);
    return [];
  }

  const cells = new Map<string, HeatCell>();
  for (const r of res.data ?? []) {
    const shifted = num(r.hour) + IST_OFFSET_HOURS;
    const hour = Math.floor((shifted + 24) % 24);
    // Crossing midnight moves the day as well as the hour.
    const dow = (num(r.dow) + (shifted >= 24 ? 1 : 0)) % 7;
    const key = `${dow}|${hour}`;
    const cell = cells.get(key) ?? { dow, hour, messages: 0 };
    cell.messages += num(r.messages);
    cells.set(key, cell);
  }
  return [...cells.values()];
}

/* ------------------------------------------------------------------ *
 * Abandoned carts
 * ------------------------------------------------------------------ */

export interface AbandonedCart {
  sessionId: string;
  waId: string;
  profileName: string | null;
  productPicked: string | null;
  sizePicked: string | null;
  hoursSince: number;
  /** False once the free window shuts — recovery then costs a template. */
  windowOpen: boolean;
  marketingOptOut: boolean;
}

export async function abandonedCarts(
  cfg: SupabaseConfig,
  fail: Failures,
  limit = 50,
): Promise<AbandonedCart[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_abandoned_carts',
    `select=*&limit=${limit}`,
  );
  if (!res.ok) {
    fail.note('v_abandoned_carts', res.error);
    return [];
  }
  return (res.data ?? []).map((r) => ({
    sessionId: str(r.session_id),
    waId: str(r.wa_id),
    profileName: (r.profile_name as string) ?? null,
    productPicked: (r.product_picked as string) ?? null,
    sizePicked: (r.size_picked as string) ?? null,
    hoursSince: num(r.hours_since),
    windowOpen: Boolean(r.window_open),
    marketingOptOut: Boolean(r.marketing_opt_out),
  }));
}

/* ------------------------------------------------------------------ *
 * Does the stylist close?
 * ------------------------------------------------------------------ */

export interface CallbackOutcome {
  requests: number;
  called: number;
  ordersAfter: number;
  revenueINR: number;
}

export async function callbackOutcome(
  cfg: SupabaseConfig,
  range: Range,
  fail: Failures,
): Promise<CallbackOutcome> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_callback_conversion',
    `${dayFilter(range)}&select=*`,
  );
  if (!res.ok) {
    fail.note('v_callback_conversion', res.error);
    return { requests: 0, called: 0, ordersAfter: 0, revenueINR: 0 };
  }
  const rows = res.data ?? [];
  return {
    requests: rows.reduce((s, r) => s + num(r.requests), 0),
    called: rows.reduce((s, r) => s + num(r.called), 0),
    ordersAfter: rows.reduce((s, r) => s + num(r.orders_after), 0),
    revenueINR: rows.reduce((s, r) => s + num(r.revenue_inr), 0),
  };
}

/* ------------------------------------------------------------------ *
 * Demand against the shelf
 * ------------------------------------------------------------------ */

export interface StockGap {
  productId: string;
  title: string | null;
  size: string | null;
  turnedAway: number;
  stockNow: number;
  stillGone: boolean;
}

export async function sizeVsStock(
  cfg: SupabaseConfig,
  fail: Failures,
  limit = 30,
): Promise<StockGap[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'v_size_vs_stock',
    `select=*&limit=${limit}`,
  );
  if (!res.ok) {
    fail.note('v_size_vs_stock', res.error);
    return [];
  }
  return (res.data ?? []).map((r) => ({
    productId: str(r.product_id),
    title: (r.title as string) ?? null,
    size: (r.size as string) ?? null,
    turnedAway: num(r.turned_away),
    stockNow: num(r.stock_now),
    stillGone: Boolean(r.still_gone),
  }));
}

/* ------------------------------------------------------------------ *
 * One call for all of it
 * ------------------------------------------------------------------ */

export interface AnalyticsData {
  acquisition: AcquisitionRow[];
  conversations: Conversation[];
  risk: RiskReport;
  searchMisses: SearchMiss[];
  timing: TimingReport;
  hourHeatmap: HeatCell[];
  abandonedCarts: AbandonedCart[];
  callbackOutcome: CallbackOutcome;
  stockGaps: StockGap[];
  /**
   * Views that failed, with the reason. Empty is the healthy case. Anything
   * here means the numbers above are incomplete and the page must say so
   * rather than render a zero.
   */
  errors: string[];
}

export async function loadAnalytics(cfg: SupabaseConfig, range: Range): Promise<AnalyticsData> {
  const fail = new Failures();

  const [acq, riskReport, misses, timingReport, heat, carts, callbacks, gaps, chats] = await Promise.all([
    acquisition(cfg, range, fail),
    risk(cfg, range, fail),
    searchMisses(cfg, fail),
    timing(cfg, range, fail),
    hourHeatmap(cfg, fail),
    abandonedCarts(cfg, fail),
    callbackOutcome(cfg, range, fail),
    sizeVsStock(cfg, fail),
    conversations(cfg, range, fail),
  ]);

  return {
    acquisition: acq,
    conversations: chats,
    risk: riskReport,
    searchMisses: misses,
    timing: timingReport,
    hourHeatmap: heat,
    abandonedCarts: carts,
    callbackOutcome: callbacks,
    stockGaps: gaps,
    errors: fail.list,
  };
}

/* ------------------------------------------------------------------ *
 * Conversations
 * ------------------------------------------------------------------ */

export interface Message {
  direction: string;
  body: string | null;
  messageType: string | null;
  payloadId: string | null;
  flowStep: string | null;
  ts: string;
}

export interface Conversation {
  waId: string;
  messages: number;
  lastAt: string;
  lastStep: string | null;
}

/**
 * Who has talked to the bot, most recent first.
 *
 * A list rather than a search box: with the volume this runs at, scanning is
 * faster than typing, and a search over phone numbers is a feature worth
 * adding only once there are too many to scan.
 */
export async function conversations(
  cfg: SupabaseConfig,
  range: Range,
  fail: Failures,
  limit = 50,
): Promise<Conversation[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'sessions',
    `started_at=gte.${range.from}&started_at=lt.${range.to}${phoneFilter(range)}` +
      `&select=wa_id,last_step,last_at&order=last_at.desc&limit=${limit}`,
  );
  if (!res.ok) {
    fail.note('sessions (conversations)', res.error);
    return [];
  }

  // One entry per shopper, not per session: the reader wants a person.
  const byShopper = new Map<string, Conversation>();
  for (const r of res.data ?? []) {
    const waId = str(r.wa_id);
    const existing = byShopper.get(waId);
    if (existing) {
      existing.messages += 1;
      continue;
    }
    byShopper.set(waId, {
      waId,
      messages: 1,
      lastAt: str(r.last_at),
      lastStep: (r.last_step as string) ?? null,
    });
  }
  return [...byShopper.values()];
}

/**
 * One shopper's transcript.
 *
 * `body` is null on anything older than the retention window — the sweep
 * strips the text and leaves the event, so the shape of a conversation
 * survives after its words are gone.
 */
export async function transcript(
  cfg: SupabaseConfig,
  waId: string,
  limit = 200,
): Promise<Message[]> {
  const res = await select<Record<string, unknown>[]>(
    cfg,
    'events',
    `wa_id=eq.${encodeURIComponent(waId)}&event_type=eq.message` +
      `&select=direction,body,message_type,payload_id,flow_step,ts&order=ts.asc&limit=${limit}`,
  );
  return (res.data ?? []).map((r) => ({
    direction: str(r.direction),
    body: (r.body as string) ?? null,
    messageType: (r.message_type as string) ?? null,
    payloadId: (r.payload_id as string) ?? null,
    flowStep: (r.flow_step as string) ?? null,
    ts: str(r.ts),
  }));
}
