/**
 * Cash on delivery.
 *
 * The order is placed the moment the shopper confirms; the money arrives at
 * the door days later. So nothing here touches Razorpay, and the Shopify order
 * is created PENDING with no transaction on it — see createShopifyOrder. An
 * order marked PAID with nothing behind it corrupts the day's takings and puts
 * "nothing owed" on a packing slip for a parcel someone has to pay for.
 *
 * COD is most of Indian fashion ecommerce, and it is also where the returns
 * are. Every order created here carries a `cod` tag so it can be told apart in
 * Shopify without reading notes.
 */

import type { Env, State } from './types';
import { COPY, formatINR } from './copy';
import { sendButtons } from './whatsapp';
import { createShopifyOrder, type OrderLine } from './orders';
import { loadAddress } from './address';
import { clearApplied, loadApplied } from './coupons';
import { clearCart } from './cart';
import { markOrdered } from './analytics/capture';

/** The basket, held between the Confirm Order card and the tap that follows. */
const pendingKey = (waId: string) => `cod:${waId}`;
const PENDING_TTL_SECONDS = 60 * 60;

/**
 * The same card the online path sends, with a button instead of a link.
 *
 * Itemised for the same reason: a total with no breakdown is where a shopper
 * stops trusting the figure. The difference is only what the button does.
 */
export async function sendCodConfirm(
  env: Env,
  to: string,
  state: State,
  lines: OrderLine[],
): Promise<void> {
  const subtotal = lines.reduce((sum, l) => sum + l.priceINR, 0);
  const coupon = await loadApplied(env, to);
  const total = coupon ? Math.max(1, subtotal - coupon.discountINR) : subtotal;

  await env.STATE.put(pendingKey(to), JSON.stringify(lines), {
    expirationTtl: PENDING_TTL_SECONDS,
  });

  const itemised = lines
    .map((l) => `${l.title}\nSize ${l.size} · ${formatINR(l.priceINR)}`)
    .join('\n\n');

  const summary: string[] = [];
  if (coupon) summary.push(`${coupon.code}  −${formatINR(coupon.discountINR)}`);
  summary.push(`${COPY.codPayable} ${formatINR(total)}`);

  state.step = 'checkout';
  await sendButtons(env, to, `${itemised}\n\n${summary.join('\n')}\n\n${COPY.codHint}`, [
    { id: 'act:cod_confirm', title: 'Confirm Order' },
    { id: 'act:main_menu', title: 'Main Menu' },
  ]);

  console.log('[cod:offered]', to, `${lines.length} lines`, `₹${total}`);
}

/**
 * Places the order.
 *
 * No payment webhook will ever arrive for this, so this tap is the only
 * moment the order can be created — which makes the idempotency guard matter
 * more than usual. A double tap on a slow connection would otherwise ship two
 * parcels for one basket.
 */
export async function placeCodOrder(env: Env, to: string, state: State): Promise<void> {
  const raw = await env.STATE.get(pendingKey(to));
  if (!raw) {
    console.log('[cod:no-pending]', to);
    await sendButtons(env, to, COPY.codExpired, [{ id: 'act:main_menu', title: 'Main Menu' }]);
    return;
  }

  // Claimed before the work, so a second tap finds nothing to place.
  await env.STATE.delete(pendingKey(to));

  const lines = JSON.parse(raw) as OrderLine[];
  const subtotal = lines.reduce((sum, l) => sum + l.priceINR, 0);
  const coupon = (await loadApplied(env, to)) ?? undefined;
  const total = coupon ? Math.max(1, subtotal - coupon.discountINR) : subtotal;
  const shipping = (await loadAddress(env, to)) ?? undefined;

  const push = await createShopifyOrder(env, {
    waId: to,
    sessionId: state.sessionId ?? crypto.randomUUID(),
    lines,
    amountINR: total,
    shipping,
    coupon,
    cod: true,
    // Same rule as the online path: a test-mode deployment must not move
    // real stock, whichever way the shopper chose to pay.
    test: !env.RAZORPAY_KEY_ID?.startsWith('rzp_live'),
  });

  if (!push.ok) {
    /*
     * Nothing was taken, so this is recoverable — unlike a failed push after a
     * payment. The shopper is told plainly rather than left with a confirmed
     * order that does not exist.
     */
    console.log('[cod:order-failed]', to, push.error ?? '');
    await sendButtons(env, to, COPY.codFailed, [
      { id: 'act:callback', title: 'Talk to Stylist' },
      { id: 'act:main_menu', title: 'Main Menu' },
    ]);
    return;
  }

  if (state.sessionId) await markOrdered(env, state.sessionId);
  await clearApplied(env, to);
  await clearCart(env, to);
  state.step = 'done';

  const body = [
    COPY.codPlaced,
    push.orderName ?? '',
    ...lines.map((l) => `${l.title} · size ${l.size}`),
    `${COPY.codPayable} ${formatINR(total)}`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendButtons(env, to, body, [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);

  console.log('[cod:placed]', to, push.orderName ?? '(no name)', `₹${total}`);
}
