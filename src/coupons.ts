/**
 * Discount codes, validated against Shopify.
 *
 * Shopify owns the discounts — the codes, the percentages, the expiry dates,
 * the minimum spends. So the bot asks Shopify rather than keeping a list of
 * its own: a code that works on reistor.in works here, one that has expired
 * fails here too, and nobody has to remember to update two places.
 *
 * The consequence that matters is reconciliation. The Razorpay link charges
 * the discounted total, and the Shopify order carries the same code, so the
 * money on the order and the money in the gateway agree. A discount invented
 * in this Worker would produce orders whose totals Shopify could not explain.
 *
 * Needs `read_discounts` on the Shopify app. Without it every code is refused,
 * which is the safe direction to fail in.
 */

import type { Env } from './types';
import { shopifyGraphql } from './catalog';
import { formatINR } from './copy';

const APPLIED_TTL_SECONDS = 60 * 60 * 2;
const appliedKey = (waId: string) => `coupon:${waId}`;

export interface Coupon {
  /** As Shopify spells it, which is what the order must carry. */
  code: string;
  kind: 'percentage' | 'fixed';
  /** 20 for 20%, or 500 for ₹500 off. */
  value: number;
  /** Rupees taken off this basket, after the minimum spend is checked. */
  discountINR: number;
  title?: string;
}

const QUERY = `
  query coupon($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          title
          status
          startsAt
          endsAt
          customerGets {
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount } }
            }
          }
          minimumRequirement {
            __typename
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
          }
        }
      }
    }
  }
`;

export type CouponResult =
  | { ok: true; coupon: Coupon }
  | { ok: false; reason: string };

/**
 * Looks a code up and works out what it is worth on this basket.
 *
 * Every rejection carries a reason the shopper can act on — expired, not
 * started, below the minimum — rather than a flat "invalid", because "invalid"
 * for a code that simply needs one more item is the kind of message that ends
 * a sale.
 */
export async function validateCoupon(
  env: Env,
  rawCode: string,
  subtotalINR: number,
  itemCount: number,
): Promise<CouponResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code || code.length > 40) return { ok: false, reason: 'notFound' };

  let body: any;
  try {
    const res = await shopifyGraphql(env, QUERY, { code });
    body = res;
  } catch (err) {
    console.log('[coupon:error]', code, String(err));
    return { ok: false, reason: 'unavailable' };
  }

  const node = body?.data?.codeDiscountNodeByCode;
  const d = node?.codeDiscount;

  if (!node || !d) {
    console.log('[coupon:not-found]', code);
    return { ok: false, reason: 'notFound' };
  }

  /*
   * Only DiscountCodeBasic is handled. BXGY and free-shipping codes need the
   * cart contents to price, which is more than this flow knows, so they are
   * refused rather than applied wrongly.
   */
  if (d.__typename !== 'DiscountCodeBasic') {
    console.log('[coupon:unsupported]', code, d.__typename);
    return { ok: false, reason: 'unsupported' };
  }

  if (d.status && String(d.status).toUpperCase() !== 'ACTIVE') {
    console.log('[coupon:inactive]', code, d.status);
    return { ok: false, reason: String(d.status).toUpperCase() === 'EXPIRED' ? 'expired' : 'inactive' };
  }

  // Belt and braces: status can lag the dates.
  const now = Date.now();
  if (d.startsAt && Date.parse(d.startsAt) > now) return { ok: false, reason: 'notStarted' };
  if (d.endsAt && Date.parse(d.endsAt) < now) return { ok: false, reason: 'expired' };

  const min = d.minimumRequirement;
  if (min?.__typename === 'DiscountMinimumSubtotal') {
    const need = Number(min.greaterThanOrEqualToSubtotal?.amount ?? 0);
    if (subtotalINR < need) {
      return { ok: false, reason: `minSpend:${Math.ceil(need)}` };
    }
  }
  if (min?.__typename === 'DiscountMinimumQuantity') {
    const need = Number(min.greaterThanOrEqualToQuantity ?? 0);
    if (itemCount < need) return { ok: false, reason: `minItems:${need}` };
  }

  const value = d.customerGets?.value;
  if (value?.__typename === 'DiscountPercentage') {
    const percentage = Number(value.percentage);
    if (!Number.isFinite(percentage) || percentage <= 0) return { ok: false, reason: 'unsupported' };
    // Shopify gives 0.2 for 20% on some shapes and 20 on others.
    const pct = percentage <= 1 ? percentage * 100 : percentage;
    return {
      ok: true,
      coupon: {
        code,
        kind: 'percentage',
        value: pct,
        discountINR: Math.round((subtotalINR * pct) / 100),
        title: d.title ?? undefined,
      },
    };
  }

  if (value?.__typename === 'DiscountAmount') {
    const amount = Number(value.amount?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'unsupported' };
    return {
      ok: true,
      coupon: {
        code,
        kind: 'fixed',
        value: amount,
        // Never more than the basket, or the total goes negative and Razorpay
        // refuses the link with an error nobody can read.
        discountINR: Math.min(Math.round(amount), subtotalINR),
        title: d.title ?? undefined,
      },
    };
  }

  console.log('[coupon:unpriceable]', code, value?.__typename);
  return { ok: false, reason: 'unsupported' };
}

/** What to tell the shopper when a code will not apply. */
export function refusal(reason: string): string {
  if (reason.startsWith('minSpend:')) {
    const need = Number(reason.split(':')[1]);
    return `That code needs a basket of ${formatINR(need)} or more.`;
  }
  if (reason.startsWith('minItems:')) {
    const need = Number(reason.split(':')[1]);
    return `That code needs ${need} pieces or more in the bag.`;
  }
  switch (reason) {
    case 'expired':
      return 'That code has expired.';
    case 'notStarted':
      return 'That code is not live yet.';
    case 'inactive':
      return 'That code is not active.';
    case 'unsupported':
      return 'That code cannot be used here. Talk to our stylist and we will sort it.';
    case 'unavailable':
      return 'Codes cannot be checked right now. Carry on and we will apply it to your order.';
    default:
      return 'That code was not recognised.';
  }
}

/**
 * The discount, as Shopify's orderCreate wants it.
 *
 * Verified against OrderCreateOrderInput: `discountCode` takes one of
 * itemPercentageDiscountCode, itemFixedDiscountCode or
 * freeShippingDiscountCode — not a bare string.
 */
export function toOrderDiscount(c: Coupon): Record<string, unknown> {
  if (c.kind === 'percentage') {
    return { itemPercentageDiscountCode: { code: c.code, percentage: c.value } };
  }
  return {
    itemFixedDiscountCode: {
      code: c.code,
      amountSet: {
        shopMoney: { amount: c.discountINR.toFixed(2), currencyCode: 'INR' },
      },
    },
  };
}


/**
 * The code this shopper has applied, held for two hours.
 *
 * Its own record, like the address, so the settle path can read it without it
 * being threaded through every send function. Two hours rather than the
 * address's six months: a discount belongs to the basket in front of them,
 * not to the person.
 */
export async function saveApplied(env: Env, waId: string, coupon: Coupon): Promise<void> {
  await env.STATE.put(appliedKey(waId), JSON.stringify(coupon), {
    expirationTtl: APPLIED_TTL_SECONDS,
  });
}

export async function loadApplied(env: Env, waId: string): Promise<Coupon | null> {
  const raw = await env.STATE.get(appliedKey(waId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Coupon;
  } catch {
    return null;
  }
}

/** Cleared once the order is placed, so the next basket starts at full price. */
export async function clearApplied(env: Env, waId: string): Promise<void> {
  await env.STATE.delete(appliedKey(waId));
}
