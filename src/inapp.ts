/**
 * In-app checkout — WhatsApp's own payment sheet, via Meta's India Payments API.
 *
 * This is the only route where the shopper never leaves the thread. Every other
 * checkout the bot has had — Razorpay links, GoKwik, Fastrr — opens a page in
 * WhatsApp's in-app browser. An `order_details` message opens a drawer inside
 * the conversation instead, and Meta settles it through Razorpay.
 *
 * The bot does not talk to Razorpay here. Meta does, using the payment
 * configuration created in WhatsApp Manager, so RAZORPAY_KEY_SECRET plays no
 * part in this path.
 *
 * ---------------------------------------------------------------------------
 * PREREQUISITES, all outside this file. Without them the send is rejected:
 *
 *   1. A payment configuration in WhatsApp Manager → Payment configurations →
 *      India, with Razorpay authorised. Its name goes in
 *      WHATSAPP_PAYMENT_CONFIG.
 *   2. A verified business and an approved display name.
 *   3. Live Razorpay credentials — Meta will not accept test keys.
 *
 * A rejected send is not fatal: the caller falls back to the Razorpay payment
 * link, so a shopper mid-flow still gets a working checkout.
 * ---------------------------------------------------------------------------
 */

import type { Env, State } from './types';
import { graph, sendButtons } from './whatsapp';
import { createShopifyOrder } from './orders';
import { loadAddress } from './address';
import {
  dummyOrderNumber,
  loadSession,
  saveSession,
  sendConfirmation,
  type PaymentSession,
} from './razorpay';
import { markOrdered } from './analytics/capture';
import { clearCart } from './cart';

export interface CheckoutLine {
  productId: string;
  title: string;
  size: string;
  priceINR: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24;

/**
 * reference_id → sessionId.
 *
 * Meta caps reference_id at 35 characters, and our session ids are 36-character
 * UUIDs. Stripping the dashes fits in 32 and stays within the allowed charset,
 * but the payment webhook returns only that reference, so the mapping back has
 * to be stored.
 */
const refKey = (reference: string) => `inapp:${reference}`;

const referenceFor = (sessionId: string) => sessionId.replace(/-/g, '');

/** Rupees to the paise integer Meta expects alongside `offset: 100`. */
const paise = (inr: number) => Math.round(inr * 100);

/**
 * Sends the payment sheet.
 *
 * Returns false when Meta rejects it — an unset payment configuration, an
 * unverified business, a number without the entitlement — so the caller can
 * fall back rather than leaving the shopper with nothing.
 */
export async function sendOrderDetails(
  env: Env,
  to: string,
  state: State,
  lines: CheckoutLine[],
): Promise<boolean> {
  const configuration = env.WHATSAPP_PAYMENT_CONFIG?.trim();
  if (!configuration) {
    console.log('[inapp:skipped] WHATSAPP_PAYMENT_CONFIG unset');
    return false;
  }
  if (!lines.length) return false;

  const sessionId = crypto.randomUUID();
  const reference = referenceFor(sessionId);
  const totalINR = lines.reduce((sum, l) => sum + l.priceINR, 0);

  /*
   * Meta validates the arithmetic: total_amount must equal
   * subtotal + tax + shipping - discount, and subtotal must equal the sum of
   * each item's amount times its quantity. Prices here are inclusive and
   * shipping is free, so tax, shipping and discount are omitted entirely and
   * the total is the subtotal. Sending them as zero objects is not the same
   * thing — an empty description fails validation.
   */
  const items = lines.map((l) => ({
    retailer_id: l.productId,
    name: `${l.title} · ${l.size}`.slice(0, 60),
    amount: { value: paise(l.priceINR), offset: 100 },
    quantity: 1,
  }));
  const subtotal = items.reduce((sum, i) => sum + i.amount.value * i.quantity, 0);

  const session: PaymentSession = {
    sessionId,
    flowSessionId: state.sessionId,
    orderNumber: dummyOrderNumber(sessionId),
    waId: to,
    lines,
    priceINR: totalINR,
    createdAt: new Date().toISOString(),
  };

  // Stored before the send: a shopper can pay inside the drawer in seconds,
  // and a webhook that arrives before the session exists has nothing to settle.
  await saveSession(env, session);
  await env.STATE.put(refKey(reference), sessionId, { expirationTtl: SESSION_TTL_SECONDS });

  const sent = await graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'order_details',
      body: { text: `Your bag — ${lines.length === 1 ? 'one piece' : `${lines.length} pieces`}. Pay here and the order is placed.` },
      footer: { text: 'Payment is handled inside WhatsApp.' },
      action: {
        name: 'review_and_pay',
        parameters: {
          reference_id: reference,
          // Clothing ships, so this is physical-goods. digital-goods would be
          // accepted by the API and wrong on the shopper's receipt.
          type: 'physical-goods',
          /*
           * An array, and the current shape. The older payment_type plus
           * payment_configuration pair is superseded — Meta's guidance is to
           * use payment_settings, which is also what carries notes and udf.
           */
          payment_settings: [
            {
              type: 'payment_gateway',
              payment_gateway: {
                type: 'razorpay',
                configuration_name: configuration,
              },
            },
          ],
          currency: 'INR',
          total_amount: { value: subtotal, offset: 100 },
          order: {
            // The only value accepted in an order_details message.
            status: 'pending',
            ...(env.CATALOG_ID ? { catalog_id: env.CATALOG_ID } : {}),
            expiration: {
              timestamp: String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS),
              description: 'This bag is held for 24 hours.',
            },
            items,
            subtotal: { value: subtotal, offset: 100 },
          },
        },
      },
    },
  });

  if (!sent) {
    console.log('[inapp:rejected]', reference, `config=${configuration}`);
    return false;
  }

  state.step = 'checkout';
  console.log('[inapp:sent]', reference, `${lines.length} lines`, `₹${totalINR}`);
  return true;
}

export interface PaymentUpdate {
  reference: string;
  status: string;
  /** The gateway's own verdict — success, failed or pending. */
  transactionStatus?: string;
  amountINR?: number;
  paymentId?: string;
}

/**
 * Reads a payment update out of a Meta webhook.
 *
 * These arrive on the same /webhook endpoint as messages, not on a route of
 * their own, so this is called from parseInbound. The exact envelope is not
 * something the bot has received yet, so every plausible position is checked
 * and the raw value is logged — the first real delivery is the specification.
 */
export function parsePaymentUpdate(value: Record<string, any>): PaymentUpdate | null {
  const candidates: any[] = [];
  if (Array.isArray(value.payments)) candidates.push(...value.payments);
  for (const s of (value.statuses ?? []) as any[]) {
    if (s?.payment) candidates.push(s.payment);
  }

  for (const p of candidates) {
    const reference = p?.reference_id ?? p?.referenceId ?? p?.reference;
    if (!reference) continue;

    const transaction = p.transaction ?? p.transactions?.[0] ?? {};
    const rawAmount = Number(
      transaction.amount?.value ?? p.amount?.value ?? transaction.amount ?? p.amount,
    );

    return {
      reference: String(reference),
      status: String(p.status ?? transaction.status ?? '').toLowerCase(),
      transactionStatus: transaction.status ? String(transaction.status).toLowerCase() : undefined,
      // Values arrive in paise alongside offset 100.
      amountINR: Number.isFinite(rawAmount) ? rawAmount / 100 : undefined,
      paymentId: transaction.id ? String(transaction.id) : undefined,
    };
  }

  return null;
}

/**
 * Acts on a payment update: pushes the order to Shopify, confirms in the chat.
 *
 * The idempotency is the same as the Razorpay path's, and deliberately so —
 * `captured` can arrive more than once, and Meta retries anything that is not
 * answered 200. A settled session whose Shopify order never landed is the one
 * case a repeat is allowed through, because money taken with nothing to pack
 * is the expensive failure.
 */
export async function settlePayment(env: Env, update: PaymentUpdate): Promise<void> {
  const captured = /captured|success|paid/.test(update.status) ||
    (update.transactionStatus ? /success/.test(update.transactionStatus) : false);

  if (!captured) {
    console.log('[inapp:not-captured]', update.reference, update.status, update.transactionStatus ?? '');
    return;
  }

  const sessionId = await env.STATE.get(refKey(update.reference));
  if (!sessionId) {
    console.log('[inapp:no-session]', update.reference, '— paid, but no checkout on record');
    return;
  }

  const session = await loadSession(env, sessionId);
  if (!session) {
    console.log('[inapp:session-expired]', sessionId);
    return;
  }

  const alreadySettled = Boolean(session.settledAt);
  if (alreadySettled && session.shopifyOrderName) {
    console.log('[inapp:duplicate]', sessionId);
    return;
  }

  // Claimed before the work, so a concurrent retry finds it taken.
  if (!alreadySettled) {
    await saveSession(env, { ...session, settledAt: new Date().toISOString() });
  }

  const amountINR = update.amountINR ?? session.priceINR;

  /*
   * Read here rather than threaded through the checkout, because the
   * address is stored per shopper and the send functions never needed to
   * know about it. Absent when address_message was unavailable or the
   * capture is switched off — the order is then tagged address-pending as
   * it always was.
   */
  const shipping = (await loadAddress(env, session.waId)) ?? undefined;

  const push = await createShopifyOrder(env, {
    waId: session.waId,
    shipping,
    sessionId: session.sessionId,
    lines: session.lines,
    amountINR,
    paymentId: update.paymentId,
    test: false,
  });

  await saveSession(env, {
    ...session,
    settledAt: session.settledAt ?? new Date().toISOString(),
    shopifyOrderId: push.orderId,
    shopifyOrderName: push.orderName,
    orderPushError: push.ok ? undefined : push.error,
  });

  if (push.orderName) session.shopifyOrderName = push.orderName;

  // Everything past here ran on the first webhook already.
  if (alreadySettled) return;

  if (session.flowSessionId) await markOrdered(env, session.flowSessionId);
  await clearCart(env, session.waId);
  await sendConfirmation(env, session, amountINR);

  console.log('[inapp:settled]', sessionId, session.shopifyOrderName ?? '(no shopify order)');
}

/** Reports what is configured, without printing anything secret. */
export function inAppStatus(env: Env): Record<string, unknown> {
  return {
    configurationSet: Boolean(env.WHATSAPP_PAYMENT_CONFIG?.trim()),
    provider: env.CHECKOUT_PROVIDER ?? '(default)',
    catalogId: env.CATALOG_ID ?? null,
    note:
      'order_details also needs a verified business, an approved display name ' +
      'and live Razorpay credentials on the Meta payment configuration.',
  };
}

/** Only reachable when the send is rejected and there is no fallback left. */
export async function reportUnavailable(env: Env, to: string): Promise<void> {
  await sendButtons(env, to, 'Checkout is unavailable right now. Try again in a moment.', [
    { id: 'act:callback', title: 'Talk to Stylist' },
    { id: 'act:main_menu', title: 'Main Menu' },
  ]);
}
