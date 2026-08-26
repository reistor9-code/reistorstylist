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
import { COPY, fill, formatINR } from './copy';
import { sendButtons } from './whatsapp';
import { createShopifyOrder, type OrderLine } from './orders';
import { loadAddress } from './address';
import { clearApplied, loadApplied } from './coupons';
import { CART_TTL_SECONDS, clearCart } from './cart';
import { markOrdered } from './analytics/capture';

/**
 * The basket, held between the Confirm Order card and the tap that follows.
 *
 * It lives exactly as long as the cart does. It used to expire after an hour,
 * which meant the card outlived its own hold by twenty-three: a shopper who
 * put their phone down and came back to confirm was told the bag had expired
 * while the garment was still in the cart, priced, sized and waiting. The
 * offer and the basket now die together, or not at all.
 */
const pendingKey = (waId: string) => `cod:${waId}`;
const PENDING_TTL_SECONDS = CART_TTL_SECONDS;

/**
 * What cash on delivery costs to run, passed on.
 *
 * COD is most of Indian fashion ecommerce and it is also where the returns
 * are: a parcel refused at the door is paid for twice and sells nothing. The
 * fee covers part of that, and quoted beside the saving rather than on its own
 * it moves the shoppers who do not mind either way onto the path that actually
 * completes.
 *
 * Configurable because it is a commercial number, not an engineering one.
 * Zero, or anything unparseable, switches it off entirely — card line and all.
 */
export function codFee(env: Env): number {
  const raw = env.COD_FEE_INR?.trim();
  if (raw === undefined || raw === '') return 180;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

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
  const discounted = coupon ? Math.max(1, subtotal - coupon.discountINR) : subtotal;
  const fee = codFee(env);
  const total = discounted + fee;

  await env.STATE.put(pendingKey(to), JSON.stringify(lines), {
    expirationTtl: PENDING_TTL_SECONDS,
  });

  const itemised = lines
    .map((l) => `${l.title}\nSize ${l.size} · ${formatINR(l.priceINR)}`)
    .join('\n\n');

  /*
   * The fee is itemised rather than folded into the total. A number that
   * appears without explanation is where a shopper stops trusting the figure,
   * and this one is far larger than the rounding they might let pass.
   */
  const summary: string[] = [];
  if (coupon) summary.push(`${coupon.code}  −${formatINR(coupon.discountINR)}`);
  if (fee > 0) summary.push(`${COPY.codFeeLabel}  +${formatINR(fee)}`);
  summary.push(`${COPY.codPayable} ${formatINR(total)}`);

  /*
   * The nudge is a line of text, not a fourth button.
   *
   * "Pay online" is already live on the card above this one, and since the
   * parked basket is no longer consumed on the way past it still works after
   * a shopper has looked at COD. Pointing at that button costs nothing. A
   * button here would instead leave a payment link and a Confirm Order card
   * armed at the same time for one basket — two orders, one garment.
   */
  const tail =
    fee > 0 ? `${fill(COPY.codSave, { fee: formatINR(fee) })}\n\n${COPY.codHint}` : COPY.codHint;

  state.step = 'checkout';
  await sendButtons(env, to, `${itemised}\n\n${summary.join('\n')}\n\n${tail}`, [
    { id: 'act:cod_confirm', title: 'Confirm Order' },
    { id: 'act:main_menu', title: 'Main Menu' },
  ]);

  console.log('[cod:offered]', to, `${lines.length} lines`, `₹${total}`, `fee=${fee}`);
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
  /*
   * Read from the same function the card read it from, rather than carried
   * across on the pending record. The two taps are minutes apart, so the worst
   * a changed rate can do is disagree by that much — and the order, the note
   * and the shipping line always agree with each other.
   */
  const fee = codFee(env);
  const total = (coupon ? Math.max(1, subtotal - coupon.discountINR) : subtotal) + fee;
  const shipping = (await loadAddress(env, to)) ?? undefined;

  const push = await createShopifyOrder(env, {
    waId: to,
    sessionId: state.sessionId ?? crypto.randomUUID(),
    lines,
    amountINR: total,
    shipping,
    coupon,
    cod: true,
    codFeeINR: fee,
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

  console.log('[cod:placed]', to, push.orderName ?? '(no name)', `₹${total}`, `fee=${fee}`);
}
