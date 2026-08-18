/**
 * Event capture.
 *
 * Every number on the dashboard is a query over what this file writes. Two
 * things are worth stating up front, because they explain most of the design:
 *
 *   1. Meta never tells you which step of your funnel a message belongs to.
 *      The webhook carries a button payload and nothing else. `flow_step` is
 *      ours, stamped at each state transition — without it a drop-off report
 *      is impossible, not merely inaccurate.
 *
 *   2. A shopper who ignores a message generates no event whatsoever. There is
 *      no "abandoned" webhook for a carousel nobody tapped. Drop-off is
 *      therefore inferred from silence by sweepAbandoned(), not received.
 *
 * Everything here is best-effort. A logging failure must never cost a shopper
 * their reply, so every method swallows its errors and returns void.
 */

import {
  type SupabaseConfig,
  insert,
  insertIgnore,
  select,
  update,
  upsert,
} from '../platform/supabase.js';

/* ------------------------------------------------------------------ *
 * Funnel
 * ------------------------------------------------------------------ */

/**
 * Journey order. `furthest_step` only ever moves forward through this list, so
 * a shopper who reaches sizing and then wanders back to browsing still counts
 * as having reached sizing.
 */
export const FUNNEL_ORDER = [
  'welcome',
  'occasion',
  'category',
  'top3',
  'pick_look',
  'size',
  'checkout',
  'done',
] as const;

export type FlowStep = string;

export function furthestOf(a: FlowStep | undefined, b: FlowStep | undefined): FlowStep {
  const ia = FUNNEL_ORDER.indexOf((a ?? '') as (typeof FUNNEL_ORDER)[number]);
  const ib = FUNNEL_ORDER.indexOf((b ?? '') as (typeof FUNNEL_ORDER)[number]);
  // A side branch (browse, stylist) is not on the main funnel and must not
  // overwrite real progress, so an unknown step loses to a known one.
  if (ia < 0) return b ?? a ?? 'welcome';
  if (ib < 0) return a ?? 'welcome';
  return ia >= ib ? (a as FlowStep) : (b as FlowStep);
}

/* ------------------------------------------------------------------ *
 * Event shapes
 * ------------------------------------------------------------------ */

export interface BaseEvent {
  waId?: string;
  sessionId?: string;
  wamid?: string;
  flowStep?: FlowStep;
  productIds?: string[];
  size?: string;
  templateName?: string;
  meta?: Record<string, unknown>;
}

export interface StatusEvent {
  wamid: string;
  waId?: string;
  status: string;
  billable?: boolean;
  pricingCategory?: string;
  pricingType?: string;
  errorCode?: number;
  errorTitle?: string;
  timestamp?: string;
}

export interface SessionPatch {
  occasion?: string;
  category?: string;
  lastStep?: FlowStep;
  looksShown?: number;
  productsShown?: string[];
  productPicked?: string;
  sizePicked?: string;
  checkoutOpened?: boolean;
  ordered?: boolean;
  widened?: boolean;
  stylistUsed?: boolean;
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

/**
 * Null-object by default.
 *
 * `getAnalytics()` always returns an instance, so call sites read
 * `analytics.inbound(...)` with no optional chaining and no branching. When
 * Supabase is unconfigured the methods simply do nothing, which is exactly the
 * behaviour wanted on a laptop or in a test.
 */
export class Analytics {
  protected phoneNumberId?: string;

  constructor(phoneNumberId?: string) {
    this.phoneNumberId = phoneNumberId;
  }

  get enabled(): boolean {
    return false;
  }

  async inbound(_e: BaseEvent & { messageType?: string; payloadId?: string; profileName?: string }): Promise<void> {}
  async outbound(_e: BaseEvent & { messageType?: string; ok?: boolean }): Promise<void> {}
  async status(_e: StatusEvent): Promise<void> {}
  async optOut(_waId: string, _value: 'stop' | 'resume', _at?: string): Promise<void> {}
  async templateStatus(_name: string, _event: string, _meta?: Record<string, unknown>): Promise<void> {}
  async accountEvent(_type: string, _meta: Record<string, unknown>): Promise<void> {}
  async milestone(_type: string, _e: BaseEvent): Promise<void> {}
  async openSession(_sessionId: string, _waId: string): Promise<void> {}
  async patchSession(_sessionId: string, _patch: SessionPatch): Promise<void> {}
  async rememberProducts(_products: ProductName[]): Promise<void> {}
}

/** Just enough of a product to name it on the dashboard. */
export interface ProductName {
  id: string;
  title: string;
  priceINR?: number;
}

class SupabaseAnalytics extends Analytics {
  constructor(
    private cfg: SupabaseConfig,
    phoneNumberId?: string,
  ) {
    super(phoneNumberId);
  }

  override get enabled(): boolean {
    return true;
  }

  private row(extra: Record<string, unknown>): Record<string, unknown> {
    return { phone_number_id: this.phoneNumberId ?? null, ...extra };
  }

  /** Never let a logging failure escape into the message path. */
  private async safe(fn: () => Promise<unknown>, label: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.log(`[analytics:${label}]`, String(err));
    }
  }

  override async inbound(
    e: BaseEvent & { messageType?: string; payloadId?: string; profileName?: string },
  ): Promise<void> {
    await this.safe(async () => {
      await insertIgnore(
        this.cfg,
        'events',
        this.row({
          wamid: e.wamid ?? null,
          wa_id: e.waId ?? null,
          session_id: e.sessionId ?? null,
          direction: 'in',
          event_type: 'message',
          flow_step: e.flowStep ?? null,
          message_type: e.messageType ?? null,
          payload_id: e.payloadId ?? null,
          product_ids: e.productIds ?? null,
          meta: e.meta ?? null,
        }),
        'wamid,status',
      );

      if (e.waId) {
        await upsert(
          this.cfg,
          'shoppers',
          this.row({
            wa_id: e.waId,
            profile_name: e.profileName ?? null,
            last_seen: new Date().toISOString(),
          }),
          'wa_id',
        );
      }
    }, 'inbound');
  }

  override async outbound(e: BaseEvent & { messageType?: string; ok?: boolean }): Promise<void> {
    await this.safe(
      () =>
        insert(
          this.cfg,
          'events',
          this.row({
            wamid: e.wamid ?? null,
            wa_id: e.waId ?? null,
            session_id: e.sessionId ?? null,
            direction: 'out',
            event_type: 'message',
            flow_step: e.flowStep ?? null,
            message_type: e.messageType ?? null,
            product_ids: e.productIds ?? null,
            template_name: e.templateName ?? null,
            meta: e.ok === false ? { ...(e.meta ?? {}), rejected: true } : (e.meta ?? null),
          }),
        ),
      'outbound',
    );
  }

  /**
   * Delivery receipts. The pricing object rides along on these, which is the
   * only way to attribute spend per message without waiting for the monthly
   * invoice — and the reason this webhook must not be discarded.
   */
  override async status(e: StatusEvent): Promise<void> {
    await this.safe(
      () =>
        insertIgnore(
          this.cfg,
          'events',
          this.row({
            wamid: e.wamid,
            wa_id: e.waId ?? null,
            direction: 'out',
            event_type: 'status',
            status: e.status,
            billable: e.billable ?? null,
            pricing_category: e.pricingCategory ?? null,
            pricing_type: e.pricingType ?? null,
            error_code: e.errorCode ?? null,
            error_title: e.errorTitle ?? null,
            ts: e.timestamp ?? new Date().toISOString(),
          }),
          'wamid,status',
        ),
      'status',
    );
  }

  /**
   * Marketing opt-out.
   *
   * Meta's policy requires honouring this, and the flag written here is what
   * any future template send must check. `resume` clears it, since a shopper
   * who opts back in has to be reachable again.
   */
  override async optOut(waId: string, value: 'stop' | 'resume', at?: string): Promise<void> {
    const stopped = value === 'stop';
    await this.safe(async () => {
      await upsert(
        this.cfg,
        'shoppers',
        this.row({
          wa_id: waId,
          marketing_opt_out: stopped,
          opt_out_at: stopped ? (at ?? new Date().toISOString()) : null,
        }),
        'wa_id',
      );
      await insert(
        this.cfg,
        'events',
        this.row({
          wa_id: waId,
          direction: 'system',
          event_type: 'opt_out',
          meta: { value },
        }),
      );
    }, 'optOut');
  }

  override async templateStatus(
    name: string,
    event: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.safe(
      () =>
        insert(
          this.cfg,
          'events',
          this.row({
            direction: 'system',
            event_type: 'template_status',
            template_name: name,
            meta: { event, ...(meta ?? {}) },
          }),
        ),
      'templateStatus',
    );
  }

  override async accountEvent(type: string, meta: Record<string, unknown>): Promise<void> {
    await this.safe(
      () =>
        insert(
          this.cfg,
          'events',
          this.row({ direction: 'system', event_type: type, meta }),
        ),
      'accountEvent',
    );
  }

  /** size_sold_out, widened, looks_shown, fallback — the non-message signals. */
  override async milestone(type: string, e: BaseEvent): Promise<void> {
    await this.safe(
      () =>
        insert(
          this.cfg,
          'events',
          this.row({
            wa_id: e.waId ?? null,
            session_id: e.sessionId ?? null,
            direction: 'system',
            event_type: type,
            flow_step: e.flowStep ?? null,
            product_ids: e.productIds ?? null,
            size: e.size ?? null,
            meta: e.meta ?? null,
          }),
        ),
      'milestone',
    );
  }

  /**
   * Records product names as they are seen.
   *
   * The restock list and the conversion table are read by people who buy
   * stock, and a bare Shopify id is useless to them. Titles cannot be taken
   * from `order_items`, because the products worth restocking are exactly the
   * ones that never sold — so the name is captured here, the moment a product
   * is shown to somebody, whether or not it ever converts.
   */
  override async rememberProducts(products: ProductName[]): Promise<void> {
    if (!products.length) return;

    await this.safe(
      () =>
        upsert(
          this.cfg,
          'product_names',
          products.map((p) => ({
            product_id: p.id,
            title: p.title,
            price_inr: p.priceINR ?? null,
            updated_at: new Date().toISOString(),
          })),
          'product_id',
        ),
      'rememberProducts',
    );
  }

  override async openSession(sessionId: string, waId: string): Promise<void> {
    await this.safe(
      () =>
        upsert(
          this.cfg,
          'sessions',
          this.row({
            session_id: sessionId,
            wa_id: waId,
            started_at: new Date().toISOString(),
            last_at: new Date().toISOString(),
          }),
          'session_id',
        ),
      'openSession',
    );
  }

  /**
   * Merges a patch into the session row.
   *
   * `products_shown` and `furthest_step` are accumulated rather than
   * overwritten, so a second round of looks adds to the list and a shopper who
   * goes back to browsing does not erase the fact they reached sizing.
   */
  override async patchSession(sessionId: string, patch: SessionPatch): Promise<void> {
    await this.safe(async () => {
      const current = await select<
        { products_shown: string[] | null; furthest_step: string | null; looks_shown: number }[]
      >(
        this.cfg,
        'sessions',
        `session_id=eq.${sessionId}&select=products_shown,furthest_step,looks_shown&limit=1`,
      );
      const row = current.data?.[0];

      const merged: Record<string, unknown> = { last_at: new Date().toISOString() };

      if (patch.occasion !== undefined) merged.occasion = patch.occasion;
      if (patch.category !== undefined) merged.category = patch.category;
      if (patch.productPicked !== undefined) merged.product_picked = patch.productPicked;
      if (patch.sizePicked !== undefined) merged.size_picked = patch.sizePicked;
      if (patch.checkoutOpened !== undefined) merged.checkout_opened = patch.checkoutOpened;
      if (patch.ordered !== undefined) merged.ordered = patch.ordered;
      if (patch.widened !== undefined) merged.widened = patch.widened;
      if (patch.stylistUsed !== undefined) merged.stylist_used = patch.stylistUsed;

      if (patch.lastStep !== undefined) {
        merged.last_step = patch.lastStep;
        merged.furthest_step = furthestOf(row?.furthest_step ?? undefined, patch.lastStep);
      }

      if (patch.productsShown?.length) {
        const seen = new Set([...(row?.products_shown ?? []), ...patch.productsShown]);
        merged.products_shown = [...seen];
      }
      if (patch.looksShown !== undefined) {
        merged.looks_shown = (row?.looks_shown ?? 0) + patch.looksShown;
      }

      await update(this.cfg, 'sessions', `session_id=eq.${sessionId}`, merged);
    }, 'patchSession');
  }
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export interface AnalyticsEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  PHONE_NUMBER_ID?: string;
}

export function getAnalytics(env: AnalyticsEnv): Analytics {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    return new SupabaseAnalytics(
      { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY },
      env.PHONE_NUMBER_ID,
    );
  }
  return new Analytics(env.PHONE_NUMBER_ID);
}

/** Fresh session id. Available on both Workers and Node 19+. */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ *
 * Drop-off inference
 * ------------------------------------------------------------------ */

/**
 * Marks silent sessions as dropped.
 *
 * This exists because abandonment produces no webhook — not a missing one, but
 * none at all. A shopper who is shown three looks and never taps is
 * indistinguishable from one still deciding, so "dropped" is defined as
 * silence past a cutoff and computed here rather than received from Meta.
 *
 * Runs from the daily cron. The 24-hour default matches the service window: a
 * shopper who has not replied by then cannot be answered free-form anyway.
 */
export async function sweepAbandoned(
  cfg: SupabaseConfig,
  hours = 24,
): Promise<number> {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const open = await select<{ session_id: string; furthest_step: string }[]>(
    cfg,
    'sessions',
    `dropped_at=is.null&ordered=eq.false&last_at=lt.${cutoff}` +
      `&select=session_id,furthest_step&limit=1000`,
  );

  const rows = open.data ?? [];
  for (const row of rows) {
    await update(cfg, 'sessions', `session_id=eq.${row.session_id}`, {
      dropped_at: new Date().toISOString(),
      dropped_at_step: row.furthest_step,
    });
  }

  if (rows.length) console.log('[analytics:swept]', rows.length, 'abandoned sessions');
  return rows.length;
}
