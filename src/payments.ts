/**
 * GoKwik hosted checkout.
 *
 * The chat hands the shopper to a web page and then goes quiet. Nothing is
 * sent while they are in the browser typing card details, and nothing is sent
 * on a timer afterwards — the only thing that speaks again is GoKwik's
 * payment webhook. A confirmation we cannot prove is worse than a late one.
 *
 * Two records are written per checkout, both in the existing STATE namespace:
 *
 *   pay:<sessionId>   the pending checkout — what was bought, by whom
 *   payby:<waId>      that shopper's most recent sessionId
 *
 * The second exists because attribution through a hosted checkout is not
 * guaranteed. `?ref=` is attached to the URL, but whether GoKwik carries a
 * query parameter onto the Shopify order is not publicly documented, so the
 * webhook resolves the chat by `ref` when it is there and falls back to the
 * customer's phone number when it is not. Phone is mandatory at an Indian
 * checkout, so the fallback is the more dependable of the two.
 */

import type { Env, State } from './types';
import type { Product } from './catalog';
import { checkoutUrl } from './catalog';
import { formatINR } from './copy';
import { sendButtons, sendCtaUrl } from './whatsapp';

/** Pending checkout, keyed by the session id carried in the checkout URL. */
export interface CheckoutSession {
  sessionId: string;
  waId: string;
  productId: string;
  variantId?: string;
  size: string;
  title: string;
  priceINR: number;
  createdAt: string;
  /** Set once a payment webhook has been acted on — the idempotency guard. */
  settledAt?: string;
}

/** A checkout is worth remembering for a day; nobody pays later than that. */
const SESSION_TTL_SECONDS = 60 * 60 * 24;

const sessionKey = (sessionId: string) => `pay:${sessionId}`;
const byShopperKey = (waId: string) => `payby:${waId}`;

const COPY = {
  checkoutHint:
    'Checkout opens in your browser. Address and payment on the next screen.',
  confirmedTitle: 'Order confirmed',
  tracking: 'Tracking will land in this chat.',
  soldOut:
    'That size went out of stock before checkout finished. Nothing was charged. Pick another size:',
} as const;

/**
 * Meta rejects a second message to the same person inside six seconds with
 * error 131056. Only used where two messages genuinely have to go out.
 */
export const space = (ms = 6100) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loadSession(env: Env, sessionId: string): Promise<CheckoutSession | null> {
  const raw = await env.STATE.get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CheckoutSession;
  } catch {
    return null;
  }
}

async function saveSession(env: Env, session: CheckoutSession): Promise<void> {
  await env.STATE.put(sessionKey(session.sessionId), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

/** Resolves a webhook back to a chat: by ref first, then by phone number. */
async function resolveSession(
  env: Env,
  ref?: string,
  phone?: string,
): Promise<CheckoutSession | null> {
  if (ref) {
    const direct = await loadSession(env, ref);
    if (direct) return direct;
    console.log('[gokwik:ref-miss]', ref);
  }

  const waId = normalisePhone(phone);
  if (!waId) return null;

  const sessionId = await env.STATE.get(byShopperKey(waId));
  if (!sessionId) return null;
  return loadSession(env, sessionId);
}

/**
 * GoKwik reports Indian numbers in several shapes — bare ten digits, +91
 * prefixed, spaced. WhatsApp ids are the country code and number with no
 * punctuation, so everything is reduced to that.
 */
export function normalisePhone(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits.length >= 10 ? digits : null;
}

/**
 * The one message sent after a size is chosen: what they are buying, what it
 * costs, and a single button out to GoKwik.
 */
export async function sendGoKwikCheckout(
  env: Env,
  to: string,
  state: State,
  product: Product,
  size: string,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const variantId = product.sizes.find((s) => s.size === size)?.variantId;

  const session: CheckoutSession = {
    sessionId,
    waId: to,
    productId: product.id,
    variantId,
    size,
    title: product.title,
    priceINR: product.priceINR,
    createdAt: new Date().toISOString(),
  };

  await saveSession(env, session);
  await env.STATE.put(byShopperKey(to), sessionId, { expirationTtl: SESSION_TTL_SECONDS });

  state.step = 'checkout';
  state.currentLookId = product.id;

  const url = withRef(checkoutUrl(product, size), sessionId);
  console.log('[gokwik:checkout]', sessionId, product.id, size, variantId ?? 'no-variant');

  await sendCtaUrl(
    env,
    to,
    `${product.title}\nSize ${size} · ${product.fabric}\n${formatINR(product.priceINR)}\n\n${COPY.checkoutHint}`,
    'Buy Now',
    url,
  );

  // Nothing else is sent. The chat stays silent until GoKwik speaks, and no
  // timer is scheduled — a 90-second nudge would only ever be a guess.
}

/** Attaches the session id to the checkout URL without disturbing the rest. */
export function withRef(url: string, sessionId: string): string {
  const next = new URL(url);
  next.searchParams.set('ref', sessionId);
  // Shopify carries `attributes[...]` from a cart permalink onto the order as
  // a note attribute. Sent alongside `ref` so attribution survives whichever
  // of the two GoKwik forwards.
  next.searchParams.set('attributes[ref]', sessionId);
  next.searchParams.set('attributes[source]', 'whatsapp-stylist');
  return next.toString();
}

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

interface PaymentEvent {
  ref?: string;
  phone?: string;
  status: 'paid' | 'failed' | 'unknown';
  amountINR?: number;
  orderId?: string;
  reason?: string;
}

/**
 * GoKwik's payload shape is not publicly documented and differs by merchant
 * setup, so the fields are read from several likely spellings rather than one
 * fixed path. Anything unrecognised is reported as `unknown` and acted on by
 * doing nothing, which is the safe direction.
 */
export function parsePaymentEvent(body: any): PaymentEvent {
  const root = body?.data ?? body?.order ?? body ?? {};
  const raw = String(
    root.status ?? root.payment_status ?? root.order_status ?? body?.event ?? '',
  ).toLowerCase();

  const status: PaymentEvent['status'] = /paid|success|captured|complete|confirmed/.test(raw)
    ? 'paid'
    : /fail|declin|cancel|abandon|reject|error/.test(raw)
      ? 'failed'
      : 'unknown';

  const amount = Number(root.amount ?? root.total ?? root.order_total ?? root.total_price);

  return {
    ref:
      root.ref ??
      root.reference ??
      root.merchant_reference ??
      root.note_attributes?.ref ??
      root.attributes?.ref ??
      undefined,
    phone: root.phone ?? root.customer_phone ?? root.customer?.phone ?? root.mobile ?? undefined,
    status,
    // GoKwik reports rupees in some payloads and paise in others; a value that
    // divides cleanly by 100 and dwarfs any garment price is treated as paise.
    amountINR: Number.isFinite(amount)
      ? amount > 100000 && amount % 100 === 0
        ? amount / 100
        : amount
      : undefined,
    orderId: root.order_id ?? root.order_number ?? root.id ?? undefined,
    reason: root.reason ?? root.failure_reason ?? undefined,
  };
}

/**
 * Verifies the caller. GoKwik's signing scheme is merchant-specific, so both
 * of the usual shapes are accepted: a shared secret echoed in a header, or an
 * HMAC-SHA256 of the raw body. Without GOKWIK_WEBHOOK_SECRET set, the route
 * refuses everything rather than trusting an open endpoint.
 */
export async function verifyWebhook(env: Env, request: Request, rawBody: string): Promise<boolean> {
  const secret = env.GOKWIK_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.log('[gokwik:webhook] refused — GOKWIK_WEBHOOK_SECRET unset');
    return false;
  }

  const header =
    request.headers.get('x-gokwik-signature') ??
    request.headers.get('x-webhook-signature') ??
    request.headers.get('authorization') ??
    '';

  if (header && timingSafeEqual(header.replace(/^Bearer\s+/i, ''), secret)) return true;

  if (!header) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(header.toLowerCase().replace(/^sha256=/, ''), hex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The payment webhook.
 *
 * Always answers 200 — a retry storm from GoKwik helps nobody — and reports
 * what it decided in the log. A failed or abandoned payment is answered with
 * silence, deliberately: they may still be retrying in the browser.
 */
export async function handlePaymentWebhook(env: Env, request: Request): Promise<Response> {
  const rawBody = await request.text();

  if (!(await verifyWebhook(env, request, rawBody))) {
    return new Response('Forbidden', { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.log('[gokwik:webhook] bad json');
    return new Response('OK', { status: 200 });
  }

  const event = parsePaymentEvent(body);
  console.log('[gokwik:webhook]', event.status, event.ref ?? 'no-ref', event.orderId ?? 'no-order');

  if (event.status === 'unknown') return new Response('OK', { status: 200 });

  const session = await resolveSession(env, event.ref, event.phone);
  if (!session) {
    console.log('[gokwik:unresolved]', JSON.stringify(event));
    return new Response('OK', { status: 200 });
  }

  // The WhatsApp session id is the idempotency key: GoKwik may deliver the
  // same event more than once, and a second confirmation would be alarming.
  if (session.settledAt) {
    console.log('[gokwik:duplicate]', session.sessionId);
    return new Response('OK', { status: 200 });
  }

  if (event.status === 'failed') {
    // Sold out between selection and checkout is the one failure worth
    // speaking about, because the shopper can act on it. Everything else —
    // a declined card, an abandoned page — is met with silence so a retry
    // is not interrupted.
    if (/stock|inventory|unavailable|sold/i.test(event.reason ?? '')) {
      await sendButtons(env, session.waId, COPY.soldOut, [
        { id: `look:${session.productId}`, title: 'Pick Another Size' },
        { id: 'act:main_menu', title: 'Main Menu' },
      ]);
    }
    return new Response('OK', { status: 200 });
  }

  await saveSession(env, { ...session, settledAt: new Date().toISOString() });
  await sendOrderConfirmation(env, session, event.amountINR ?? session.priceINR);
  return new Response('OK', { status: 200 });
}

/** The only message that tells the shopper their payment worked. */
export async function sendOrderConfirmation(
  env: Env,
  session: CheckoutSession,
  amountINR: number,
): Promise<void> {
  const body = [
    COPY.confirmedTitle,
    `${session.title} · size ${session.size}`,
    `${formatINR(amountINR)} paid`,
    COPY.tracking,
  ].join('\n');

  await sendButtons(env, session.waId, body, [
    { id: 'act:track', title: 'Track Order' },
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);
}
