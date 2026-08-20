/**
 * The writes the base analytics module does not cover.
 *
 * Kept separate from log.ts on purpose: that file came from another branch and
 * is still being worked on there, so everything added here goes in a file that
 * will never conflict. Message bodies ride in `meta.body`, which the generated
 * `events.body` column picks up — so no call into log.ts needed changing.
 *
 * Every function is best-effort and swallows its own errors. Analytics must
 * never cost a shopper their reply.
 */

import type { Env } from '../types';
import { insert, supabaseConfigured, update, type SupabaseConfig } from '../platform/supabase';

function cfgOf(env: Env): SupabaseConfig | null {
  const cfg = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY };
  return supabaseConfigured(cfg) ? cfg : null;
}

/* ------------------------------------------------------------------ *
 * Entry source
 * ------------------------------------------------------------------ */

/** The referral object Meta attaches to the first message from a CTWA ad. */
export interface Referral {
  source_type?: string;
  source_id?: string;
  source_url?: string;
  ctwa_clid?: string;
  headline?: string;
}

export interface EntrySource {
  entry_source: string;
  ctwa_clid?: string;
  ad_id?: string;
  source_url?: string;
  referral_headline?: string;
  utm_source?: string;
  utm_campaign?: string;
}

/**
 * A prefilled wa.me link is the only UTM WhatsApp has.
 *
 *   wa.me/91XXXXXXXXXX?text=Hi%20REISTOR-IG
 *   wa.me/91XXXXXXXXXX?text=Hi%20REISTOR-QR-STORE1
 *
 * The code arrives inside the shopper's first message, so it is read from the
 * text and then stripped — otherwise "Hi REISTOR-IG" fails the greeting test
 * and the shopper lands in the fallback branch instead of the flow.
 */
const SOURCE_CODE = /\bREISTOR-([A-Z0-9_-]{1,32})\b/i;

export function readEntrySource(text: string | undefined, referral?: Referral): EntrySource {
  if (referral?.ctwa_clid || referral?.source_id) {
    return {
      entry_source: 'ad',
      ctwa_clid: referral.ctwa_clid,
      ad_id: referral.source_id,
      source_url: referral.source_url,
      referral_headline: referral.headline,
      utm_campaign: referral.source_id,
    };
  }

  const match = text?.match(SOURCE_CODE);
  if (match) {
    const [source, ...rest] = match[1].toUpperCase().split('-');
    return {
      entry_source: 'link',
      utm_source: source,
      utm_campaign: rest.length ? rest.join('-') : undefined,
    };
  }

  return { entry_source: 'organic' };
}

/** Removes the tracking code so the rest of the flow sees a plain greeting. */
export function stripSourceCode(text: string): string {
  return text.replace(SOURCE_CODE, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Written once, when the session opens.
 *
 * A CTWA referral is delivered on the first inbound message and never again,
 * so there is no second chance at this.
 */
export async function recordEntrySource(
  env: Env,
  sessionId: string,
  source: EntrySource,
): Promise<void> {
  const cfg = cfgOf(env);
  if (!cfg || source.entry_source === 'organic') return;

  try {
    await update(cfg, 'sessions', `session_id=eq.${sessionId}`, { ...source });
    console.log('[capture:entry]', sessionId, source.entry_source, source.ctwa_clid ?? '');
  } catch (err) {
    console.log('[capture:entry-failed]', String(err));
  }
}

/* ------------------------------------------------------------------ *
 * Session milestones
 * ------------------------------------------------------------------ */

/** A cart arrived. The strongest intent signal the flow produces. */
export async function markCartSent(env: Env, sessionId: string): Promise<void> {
  const cfg = cfgOf(env);
  if (!cfg) return;
  try {
    await update(cfg, 'sessions', `session_id=eq.${sessionId}`, {
      cart_sent_at: new Date().toISOString(),
    });
  } catch (err) {
    console.log('[capture:cart-failed]', String(err));
  }
}

/**
 * Checkout reached, and the size that got them there.
 *
 * The size is written here rather than in the funnel patch because this is
 * the only place it is known — the shopper picks it by tapping a `size:` row,
 * and nothing downstream carries it. Without this the funnel reports zero
 * sizes picked and two checkouts opened, which cannot both be true.
 */
export async function markCheckoutOpened(
  env: Env,
  sessionId: string,
  size?: string,
): Promise<void> {
  const cfg = cfgOf(env);
  if (!cfg) return;
  try {
    await update(cfg, 'sessions', `session_id=eq.${sessionId}`, {
      checkout_opened: true,
      checkout_opened_at: new Date().toISOString(),
      ...(size ? { size_picked: size } : {}),
    });
  } catch (err) {
    console.log('[capture:checkout-failed]', String(err));
  }
}

/** Paid. `ordered_at` is what makes time-to-purchase answerable. */
export async function markOrdered(env: Env, sessionId: string): Promise<void> {
  const cfg = cfgOf(env);
  if (!cfg) return;
  try {
    await update(cfg, 'sessions', `session_id=eq.${sessionId}`, {
      ordered: true,
      ordered_at: new Date().toISOString(),
    });
  } catch (err) {
    console.log('[capture:ordered-failed]', String(err));
  }
}

/* ------------------------------------------------------------------ *
 * Search misses
 * ------------------------------------------------------------------ */

/**
 * Typed text that matched nothing.
 *
 * Recorded only when the flow genuinely had no answer, not on every typed
 * message — a shopper typing "Tops" is a shortcut that worked, and counting it
 * as a miss would bury the real gaps.
 */
export async function recordSearchMiss(
  env: Env,
  args: { waId: string; sessionId?: string; raw: string; flowStep?: string },
): Promise<void> {
  const cfg = cfgOf(env);
  const raw = args.raw.trim();
  if (!cfg || !raw) return;

  try {
    await insert(cfg, 'search_misses', {
      wa_id: args.waId,
      session_id: args.sessionId ?? null,
      normalised: raw.toLowerCase().replace(/\s+/g, ' ').slice(0, 200),
      raw: raw.slice(0, 500),
      flow_step: args.flowStep ?? null,
    });
  } catch (err) {
    console.log('[capture:miss-failed]', String(err));
  }
}

/* ------------------------------------------------------------------ *
 * Conversions API
 * ------------------------------------------------------------------ */

/**
 * Reports a purchase to Meta so the ad that caused it gets the credit.
 *
 * Three details that are easy to get wrong and silently lose attribution:
 *
 *   - `ctwa_clid` is NOT hashed. Everything else in user_data is; this one is
 *     an identifier Meta issued and must arrive as sent.
 *   - `action_source` is 'business_messaging', not 'website'. The wrong value
 *     is accepted and then attributed to nothing.
 *   - `event_id` is our idempotency key. Meta deduplicates on it, and so does
 *     the capi_events table, so a webhook retry cannot double-count revenue.
 */
export async function sendPurchaseEvent(
  env: Env,
  args: {
    eventId: string;
    waId: string;
    sessionId?: string;
    ctwaClid?: string;
    valueINR: number;
    orderId?: string;
  },
): Promise<boolean> {
  if (!env.META_DATASET_ID || !env.META_CAPI_TOKEN) return false;

  // Without a click id there is no ad to credit. Logged rather than sent: a
  // Purchase with no identifier is noise in the ad account.
  if (!args.ctwaClid) {
    console.log('[capi:skipped] no ctwa_clid', args.eventId);
    return false;
  }

  const body = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: args.eventId,
        action_source: 'business_messaging',
        user_data: { ctwa_clid: args.ctwaClid },
        custom_data: { currency: 'INR', value: args.valueINR },
      },
    ],
  };

  let status = 0;
  let error: string | null = null;

  try {
    const version = env.GRAPH_API_VERSION || 'v21.0';
    const res = await fetch(
      `https://graph.facebook.com/${version}/${env.META_DATASET_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    status = res.status;
    if (!res.ok) error = (await res.text()).slice(0, 500);
    console.log('[capi:purchase]', args.eventId, status, error ?? 'ok');
  } catch (err) {
    error = String(err);
    console.log('[capi:error]', args.eventId, error);
  }

  const cfg = cfgOf(env);
  if (cfg) {
    try {
      await insert(cfg, 'capi_events', {
        event_id: args.eventId,
        event_name: 'Purchase',
        wa_id: args.waId,
        session_id: args.sessionId ?? null,
        ctwa_clid: args.ctwaClid,
        value_inr: args.valueINR,
        order_id: args.orderId ?? null,
        response_code: status || null,
        error,
      });
    } catch {
      // A duplicate event_id means the retry guard did its job.
    }
  }

  return status >= 200 && status < 300;
}

/* ------------------------------------------------------------------ *
 * Callback requests
 * ------------------------------------------------------------------ */

/**
 * Queues a "Talk to Stylist" request.
 *
 * Written here rather than through log.ts because that path upserts with
 * `ON CONFLICT (wa_id)`, and the only unique index on that column is partial:
 *
 *   CREATE UNIQUE INDEX ... ON callback_requests (wa_id) WHERE status = 'pending'
 *
 * Postgres will not infer a conflict target from a partial index unless the
 * statement repeats the predicate, which PostgREST cannot emit — so every
 * insert came back 42P10 and the queue stayed empty while the shopper was
 * told someone would ring.
 *
 * A plain insert works, and the partial index still does its job: a second
 * request from a shopper who already has one open is refused with 23505,
 * which is not an error here — they are already in the queue.
 */
export async function recordCallbackRequest(
  env: Env,
  args: {
    waId: string;
    sessionId?: string;
    profileName?: string;
    occasion?: string;
    category?: string;
    productsSeen?: string[];
  },
): Promise<boolean> {
  const cfg = cfgOf(env);
  if (!cfg) return false;

  const now = Date.now();
  const res = await insert(cfg, 'callback_requests', {
    wa_id: args.waId,
    session_id: args.sessionId ?? null,
    phone_number_id: env.PHONE_NUMBER_ID ?? null,
    profile_name: args.profileName ?? null,
    occasion: args.occasion ?? null,
    category: args.category ?? null,
    products_seen: args.productsSeen ?? [],
    requested_at: new Date(now).toISOString(),
    // The free-form WhatsApp window. A phone call is unaffected by it; a
    // WhatsApp reply after it closes needs an approved template.
    window_expires_at: new Date(now + 24 * 3600 * 1000).toISOString(),
    status: 'pending',
  });

  // 23505 is the partial index refusing a second open request. Already queued.
  const alreadyQueued = res.status === 409 || (res.error ?? '').includes('23505');
  if (!res.ok && !alreadyQueued) {
    console.log('[capture:callback-failed]', res.status, res.error ?? '');
    return false;
  }

  // Also an event, so the funnel can count how many people asked for a human
  // without joining across to the queue.
  try {
    await insert(cfg, 'events', {
      wa_id: args.waId,
      session_id: args.sessionId ?? null,
      phone_number_id: env.PHONE_NUMBER_ID ?? null,
      direction: 'system',
      event_type: 'callback_requested',
      flow_step: 'top3',
      meta: { occasion: args.occasion, category: args.category },
    });
  } catch {
    // The queue row is what matters; the event is for counting.
  }

  return true;
}
