/**
 * Razorpay payment links, and the Shopify order behind them.
 *
 * One basket, one payment, one order. A shopper who sends four garments sizes
 * each in turn, pays once for the total, and Shopify receives a single order
 * with four lines — not four orders to pack separately.
 *
 * Razorpay itself only takes money. The order, the line items and the money
 * matching what was charged are all createShopifyOrder()'s job, which runs
 * before the confirmation so the shopper is told the real order number.
 *
 * NO SHIPPING ADDRESS is collected — Razorpay payment links cannot capture
 * one — so every order carries an `address-pending` tag and must be chased
 * before fulfilment.
 *
 * Two records per checkout, in the existing STATE namespace:
 *
 *   rzp:<sessionId>   the pending payment — what, for whom, how much
 *   rzpby:<waId>      that shopper's most recent sessionId, so a webhook
 *                     missing our reference can still find the chat
 */

import type { Env, State } from './types';
import { formatINR } from './copy';
import { markCheckoutOpened, markOrdered, sendPurchaseEvent } from './analytics/capture';
import { clearCart } from './cart';
import { createShopifyOrder } from './orders';
import { clearApplied, loadApplied } from './coupons';
import { loadAddress } from './address';
import { sendButtons, sendCtaUrl, sendText } from './whatsapp';

export interface PaymentSession {
  sessionId: string;
  /** The flow session, so a payment can be tied back to the journey. */
  flowSessionId?: string;
  /** Carried from the flow so the purchase can be credited to the ad. */
  ctwaClid?: string;
  orderNumber: string;
  waId: string;
  /** Every garment being bought. One payment, one order, however many lines. */
  lines: { productId: string; title: string; size: string; priceINR: number }[];
  /** What Razorpay charges — the basket less any discount. */
  priceINR: number;
  /** The code applied, carried onto the Shopify order so the totals agree. */
  coupon?: import('./coupons').Coupon;
  paymentLinkId?: string;
  createdAt: string;
  /** Set once a webhook has been acted on — the idempotency guard. */
  settledAt?: string;
  /*
   * The Shopify order behind this payment. `shopifyOrderName` doubles as the
   * "already pushed" flag: settled but unpushed means the money landed and
   * the order did not, which a webhook retry is allowed to fix.
   */
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  orderPushError?: string;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24;
const sessionKey = (id: string) => `rzp:${id}`;
const byShopperKey = (waId: string) => `rzpby:${waId}`;
const linkKey = (linkId: string) => `rzplink:${linkId}`;

const COPY = {
  checkoutHint: 'Tap below to pay. The page opens here in WhatsApp.',
  unavailable: 'Checkout is unavailable right now. Try again in a moment.',
  confirmedTitle: 'Order confirmed',
  tracking: 'Tracking will land in this chat.',
} as const;

/**
 * A stand-in order number, derived from the session id rather than random so
 * a repeated webhook produces the same number instead of a second order.
 */
export function dummyOrderNumber(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return `RS${String(hash % 1_000_000).padStart(6, '0')}`;
}

export async function saveSession(env: Env, session: PaymentSession): Promise<void> {
  await env.STATE.put(sessionKey(session.sessionId), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function loadSession(env: Env, sessionId: string): Promise<PaymentSession | null> {
  const raw = await env.STATE.get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PaymentSession;
  } catch {
    return null;
  }
}

/** WhatsApp ids are `91XXXXXXXXXX`; Razorpay wants them dialable. */
const dialable = (waId: string) => `+${waId.replace(/\D/g, '')}`;

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

/**
 * Creates a Razorpay payment link.
 *
 * Amounts are paise, so rupees are multiplied by 100 — a mistake here charges
 * a hundred times too little or too much, which is why it is done in one place.
 * The session id rides in `notes`, and Razorpay returns notes on the webhook,
 * which is how the payment finds its way back to the right chat.
 */
async function createPaymentLink(
  env: Env,
  session: PaymentSession,
): Promise<{ id: string; url: string } | null> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    console.log('[razorpay] keys unset');
    return null;
  }

  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(session.priceINR * 100),
      currency: 'INR',
      accept_partial: false,
      description:
        session.lines.length === 1
          ? `${session.lines[0].title} — size ${session.lines[0].size}`
          : `${session.lines.length} pieces from Reistor`,
      customer: { contact: dialable(session.waId) },
      // The shopper is already in a WhatsApp thread; a duplicate SMS and email
      // from Razorpay would only muddy it.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        ref: session.sessionId,
        waId: session.waId,
        items: String(session.lines.length),
        orderNumber: session.orderNumber,
      },
    }),
  });

  const body = (await res.json()) as { id?: string; short_url?: string; error?: unknown };
  if (!res.ok || !body.short_url) {
    console.log('[razorpay:link-failed]', res.status, JSON.stringify(body));
    return null;
  }

  return { id: String(body.id), url: body.short_url };
}

/**
 * The one message sent once every piece in the basket has a size.
 *
 * Takes the whole basket rather than a garment: a shopper who sent four items
 * pays once, and Shopify receives one order with four lines rather than four
 * orders to pack and ship separately.
 */
export async function sendRazorpayCheckout(
  env: Env,
  to: string,
  state: State,
  lines: { productId: string; title: string; size: string; priceINR: number }[],
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const subtotal = lines.reduce((sum, l) => sum + l.priceINR, 0);

  /*
   * The link charges what the shopper was quoted.
   *
   * The coupon is read here rather than passed in, so the discount lives in
   * one place and the same value reaches Razorpay and Shopify. Floored at one
   * rupee: a link for zero is refused with an error nobody can act on.
   */
  const coupon = (await loadApplied(env, to)) ?? undefined;
  const total = coupon ? Math.max(1, subtotal - coupon.discountINR) : subtotal;

  const session: PaymentSession = {
    sessionId,
    flowSessionId: state.sessionId,
    orderNumber: dummyOrderNumber(sessionId),
    waId: to,
    lines,
    priceINR: total,
    coupon,
    createdAt: new Date().toISOString(),
  };

  const link = await createPaymentLink(env, session);
  if (!link) {
    await sendButtons(env, to, COPY.unavailable, [{ id: 'act:main_menu', title: 'Main Menu' }]);
    return;
  }

  session.paymentLinkId = link.id;
  await saveSession(env, session);
  await env.STATE.put(byShopperKey(to), sessionId, { expirationTtl: SESSION_TTL_SECONDS });
  await env.STATE.put(linkKey(link.id), sessionId, { expirationTtl: SESSION_TTL_SECONDS });

  state.step = 'checkout';
  state.currentLookId = lines[0]?.productId;

  // The basket now belongs to a payment session. Leaving it in place would
  // have the next size tap reopen a cart that has already been charged.
  await clearCart(env, to);

  console.log(
    '[razorpay:checkout]',
    sessionId,
    session.orderNumber,
    link.id,
    `${lines.length} line${lines.length === 1 ? '' : 's'}`,
  );
  if (state.sessionId) await markCheckoutOpened(env, state.sessionId, lines[0]?.size);

  /*
   * Every line is itemised, with a total only when there is more than one.
   * A basket total with no breakdown is the point at which a shopper stops
   * trusting the figure and closes the chat.
   */
  const itemised = lines
    .map((l) => `${l.title}\nSize ${l.size} · ${formatINR(l.priceINR)}`)
    .join('\n\n');
  const totalLine = lines.length > 1 ? `\n\nTotal ${formatINR(total)}` : '';

  await sendCtaUrl(
    env,
    to,
    `${itemised}${totalLine}\n\n${COPY.checkoutHint}`,
    'Buy Now',
    link.url,
  );

  // Nothing else goes out. The chat stays quiet until Razorpay says otherwise.
}

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

/** HMAC-SHA256 of the raw body, compared to `X-Razorpay-Signature`. */
export async function verifySignature(
  secret: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/**
 * Razorpay's payment webhook.
 *
 * Always answers 200 once the signature checks out — Razorpay retries on any
 * other status, and a retry storm helps nobody. A failed or abandoned payment
 * is met with silence; they may still be trying.
 */
export async function handleRazorpayWebhook(env: Env, request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') ?? '';
  const secret = env.RAZORPAY_WEBHOOK_SECRET?.trim();

  if (!secret) {
    console.log('[razorpay:webhook] refused — RAZORPAY_WEBHOOK_SECRET unset');
    return new Response('Forbidden', { status: 403 });
  }
  if (!signature || !(await verifySignature(secret, rawBody, signature))) {
    console.log('[razorpay:webhook] bad signature');
    return new Response('Forbidden', { status: 403 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('OK', { status: 200 });
  }

  const event = String(body?.event ?? '');
  const link = body?.payload?.payment_link?.entity ?? {};
  const payment = body?.payload?.payment?.entity ?? {};
  const entity = link.id ? link : payment;

  /*
   * Notes are read from both entities. `payment_link.paid` carries them on the
   * link; `payment.captured` fires on its own for the same payment and may not
   * copy them across, which would otherwise leave the payment unmatchable.
   */
  const notes = { ...(payment.notes ?? {}), ...(link.notes ?? {}) };
  console.log('[razorpay:webhook]', event, notes.ref ?? 'no-ref', link.id ?? payment.id ?? '');

  if (event !== 'payment_link.paid' && event !== 'payment.captured') {
    return new Response('OK', { status: 200 });
  }

  /*
   * Razorpay fires BOTH events for one payment, within milliseconds of each
   * other. Two Worker invocations then read the session before either writes
   * to it, and both go on to create a Shopify order and send a confirmation —
   * which is how one payment became orders #26069 and #26070.
   *
   * Every checkout here is a payment link, so `payment_link.paid` always
   * fires and is the authoritative one. `payment.captured` is acted on only
   * when the payload carries no link entity at all.
   */
  if (event === 'payment.captured' && link.id) {
    console.log('[razorpay:ignored] payment.captured alongside payment_link.paid', link.id);
    return new Response('OK', { status: 200 });
  }

  const session = await resolve(env, notes.ref, notes.waId, link.id, payment.contact);
  if (!session) {
    // Everything that could have identified the shopper, so a miss can be
    // diagnosed from one line rather than by guessing at the payload.
    console.log(
      '[razorpay:unresolved]',
      JSON.stringify({
        notes,
        linkId: link.id ?? null,
        contact: payment.contact ?? null,
        payloadKeys: Object.keys(body?.payload ?? {}),
      }),
    );
    return new Response('OK', { status: 200 });
  }

  /*
   * The session id is the idempotency key: `payment_link.paid` and
   * `payment.captured` both fire for one payment, and Razorpay retries.
   *
   * A settled session whose Shopify order never landed is the exception. That
   * is the expensive failure — money taken, nothing to pack — so a retry is
   * let through to push the order, while the analytics and the confirmation,
   * which already ran, are skipped below.
   */
  const alreadySettled = Boolean(session.settledAt);
  if (alreadySettled && session.shopifyOrderName) {
    console.log('[razorpay:duplicate]', session.sessionId);
    return new Response('OK', { status: 200 });
  }
  if (alreadySettled) {
    console.log('[razorpay:retry-order-push]', session.sessionId, session.orderPushError ?? '');
  }

  const paid = Number(entity.amount_paid ?? entity.amount);
  const amountINR = Number.isFinite(paid) ? paid / 100 : session.priceINR;

  /*
   * Claim the session BEFORE any of the work, not after.
   *
   * Ignoring the second event closes the common case; this closes the rest —
   * a Razorpay retry, or the same event delivered twice. Writing the claim
   * first means a concurrent invocation that reads after this point sees a
   * settled session and stops, instead of creating a second order. The window
   * is not zero without compare-and-set, but it shrinks from the length of a
   * Shopify write to the length of a KV write.
   */
  if (!alreadySettled) {
    await saveSession(env, { ...session, settledAt: new Date().toISOString() });
  }

  /*
   * The order goes in before the confirmation, so the shopper is told the
   * real Shopify number rather than the stand-in. A failure here is logged
   * and kept on the session, never thrown: the money is already taken, and
   * answering Razorpay with anything but 200 only buys a duplicate webhook.
   */
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
    paymentId: String(payment.id ?? entity.id ?? ''),
    paymentLinkId: session.paymentLinkId,
    coupon: session.coupon,
    // Razorpay fills `void@razorpay.com` in when no email was collected.
    // Passing it on would create a Shopify customer for a fake address.
    email: /^void@razorpay/i.test(payment.email ?? '') ? undefined : payment.email || undefined,
    contact: payment.contact || undefined,
    test: !env.RAZORPAY_KEY_ID?.startsWith('rzp_live'),
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
  if (alreadySettled) return new Response('OK', { status: 200 });

  // The discount belonged to this basket; the next one starts at full price.
  await clearApplied(env, session.waId);

  if (session.flowSessionId) await markOrdered(env, session.flowSessionId);

  /*
   * Report the purchase to Meta so the ad that produced it gets the credit.
   * Keyed on the payment session id, which Meta and capi_events both
   * deduplicate on — a webhook retry cannot count the revenue twice.
   */
  await sendPurchaseEvent(env, {
    eventId: session.sessionId,
    waId: session.waId,
    sessionId: session.flowSessionId,
    ctwaClid: session.ctwaClid,
    valueINR: amountINR,
    orderId: session.shopifyOrderName ?? session.orderNumber,
  });

  await sendConfirmation(env, session, amountINR);

  return new Response('OK', { status: 200 });
}

/**
 * Finds the chat a payment belongs to, trying every identifier the payload
 * might carry — in order of how specific each one is.
 *
 * The last of them, the payer's phone number, is the one that holds when
 * Razorpay sends nothing else useful: it is the same number the shopper is
 * chatting from.
 */
async function resolve(
  env: Env,
  ref?: string,
  waId?: string,
  linkId?: string,
  contact?: string,
): Promise<PaymentSession | null> {
  const bySession = async (id?: string | null) => (id ? loadSession(env, id) : null);

  const direct = await bySession(ref);
  if (direct) return direct;

  const viaLink = await bySession(linkId ? await env.STATE.get(linkKey(linkId)) : null);
  if (viaLink) return viaLink;

  for (const phone of [waId, contact]) {
    const normalised = phone?.replace(/\D/g, '');
    if (!normalised) continue;
    const viaPhone = await bySession(await env.STATE.get(byShopperKey(normalised)));
    if (viaPhone) return viaPhone;
  }

  return null;
}

/** The only message that tells the shopper the payment worked. */
export async function sendConfirmation(
  env: Env,
  session: PaymentSession,
  amountINR: number,
): Promise<void> {
  const body = [
    COPY.confirmedTitle,
    // The real Shopify number once the order landed; the stand-in only when
    // the push failed, so the shopper always has something to quote.
    session.shopifyOrderName ?? session.orderNumber,
    ...session.lines.map((l) => `${l.title} · size ${l.size}`),
    `${formatINR(amountINR)} paid`,
    COPY.tracking,
  ].join('\n');

  await sendButtons(env, session.waId, body, [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);
}

/** Reports config without exposing the secret — /admin/razorpay. */
export async function razorpayStatus(env: Env): Promise<Record<string, unknown>> {
  const keyId = env.RAZORPAY_KEY_ID ?? '';
  return {
    keyId: keyId ? `${keyId.slice(0, 12)}…` : 'unset',
    mode: keyId.startsWith('rzp_live') ? 'LIVE' : keyId.startsWith('rzp_test') ? 'test' : 'unknown',
    keySecret: env.RAZORPAY_KEY_SECRET ? 'set' : 'unset',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ? 'set' : 'unset',
    webhookUrl: '/webhooks/razorpay',
  };
}

export { sendText };
