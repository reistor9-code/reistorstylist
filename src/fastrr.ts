/**
 * Fastrr (Shiprocket Checkout) — the confirmation half.
 *
 * Fastrr replaces the storefront checkout rather than exposing a checkout to
 * call, exactly as GoKwik does. So the bot does not create anything: Buy Now
 * hands over a Shopify cart permalink and Fastrr's panel takes it from there.
 * See sendStoreCheckout() in flow.ts.
 *
 * What Fastrr adds over GoKwik is a webhook you can register yourself, from
 * the dashboard, without asking anyone's permission. That is the only reason
 * this file exists: it is what closes the loop and tells the shopper in the
 * thread that their order went through.
 *
 * A Worker cannot watch someone come back from a browser, so without a
 * webhook the shopper pays and the chat goes silent.
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED — Fastrr publishes no public payload schema. Everything below
 * reads the payload defensively: several spellings are accepted for each
 * field, and the first webhook of every shape is logged in full so the parser
 * can be tightened against something real. Confirm against a live delivery
 * before trusting these numbers in the dashboard.
 * ---------------------------------------------------------------------------
 */

import type { Env, State } from './types';
import { COPY } from './copy';
import { formatINR } from './copy';
import { sendButtons, sendText } from './whatsapp';
import { clearCart } from './cart';

const PENDING_TTL_SECONDS = 60 * 60 * 24 * 3;

/** Keyed by shopper, because the phone number is what the webhook carries. */
const pendingKey = (waId: string) => `co:${waId}`;

export interface PendingCheckout {
  waId: string;
  /** The flow session, so a purchase can be tied back to the journey. */
  flowSessionId?: string;
  lines: { productId: string; title: string; size: string; priceINR: number }[];
  totalINR: number;
  checkoutUrl: string;
  createdAt: string;
  /** Set once a webhook has been acted on — the idempotency guard. */
  settledAt?: string;
  orderNumber?: string;
}

/**
 * Remembers who is at checkout, so a webhook carrying only a phone number can
 * be answered in the right thread.
 *
 * Its own KV record rather than a field on the flow state, for the reason
 * cart.ts documents: concurrent webhooks read-modify-write the state and the
 * slower save puts back a copy without the newer field.
 */
export async function markCheckoutSent(
  env: Env,
  waId: string,
  state: State,
  lines: PendingCheckout['lines'],
  checkoutUrl: string,
): Promise<void> {
  const pending: PendingCheckout = {
    waId,
    flowSessionId: state.sessionId,
    lines,
    totalINR: lines.reduce((sum, l) => sum + l.priceINR, 0),
    checkoutUrl,
    createdAt: new Date().toISOString(),
  };
  await env.STATE.put(pendingKey(waId), JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
  console.log('[checkout:pending]', waId, `${lines.length} lines`);
}

export async function loadPending(env: Env, waId: string): Promise<PendingCheckout | null> {
  const raw = await env.STATE.get(pendingKey(waId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingCheckout;
  } catch {
    return null;
  }
}

async function savePending(env: Env, pending: PendingCheckout): Promise<void> {
  await env.STATE.put(pendingKey(pending.waId), JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
}

/** WhatsApp ids are `91XXXXXXXXXX`; checkouts store all sorts of shapes. */
export function normalisePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Keep the last ten — country code, leading zero and spacing all vary.
  return digits.slice(-10);
}

export interface CheckoutEvent {
  kind: 'paid' | 'abandoned' | 'failed' | 'unknown';
  phone: string | null;
  orderNumber?: string;
  amountINR?: number;
  raw: unknown;
}

/**
 * Reads a Fastrr webhook without insisting on one spelling.
 *
 * The one payload shape published anywhere is the abandoned-cart one, which
 * uses `custPhone` and `cartId`. The success shape is undocumented, so each
 * value is looked for under every name it plausibly arrives as. Anything
 * unrecognised comes back as 'unknown' and is logged rather than guessed at.
 */
export function parseFastrrEvent(body: unknown): CheckoutEvent {
  const root = (body ?? {}) as Record<string, any>;
  const data = (root.data ?? root.payload ?? root.order ?? root) as Record<string, any>;

  const pick = (...keys: string[]): any => {
    for (const key of keys) {
      if (data[key] !== undefined && data[key] !== null) return data[key];
      if (root[key] !== undefined && root[key] !== null) return root[key];
    }
    return undefined;
  };

  const phone = normalisePhone(
    pick('custPhone', 'customer_phone', 'phone', 'mobile', 'customerPhone') ??
      (pick('customer') as Record<string, any> | undefined)?.phone,
  );

  const rawAmount = Number(pick('amount', 'total', 'cartTotal', 'total_price', 'orderTotal'));
  /*
   * Indian checkouts quote in rupees, gateways in paise. A basket that costs
   * more than a lakh is far likelier to be paise than a real order here, so
   * that is where the line is drawn.
   */
  const amountINR = Number.isFinite(rawAmount)
    ? rawAmount > 100_000
      ? Math.round(rawAmount / 100)
      : rawAmount
    : undefined;

  const orderNumber = pick('order_id', 'orderId', 'order_number', 'orderNumber', 'cartId');

  const label = String(
    pick('event', 'event_type', 'eventType', 'status', 'type', 'stage') ?? '',
  ).toLowerCase();

  let kind: CheckoutEvent['kind'] = 'unknown';
  if (/paid|success|placed|created|confirm|complete|capture/.test(label)) kind = 'paid';
  else if (/abandon/.test(label)) kind = 'abandoned';
  else if (/fail|cancel|decline/.test(label)) kind = 'failed';

  return {
    kind,
    phone,
    orderNumber: orderNumber ? String(orderNumber) : undefined,
    amountINR,
    raw: body,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies the caller.
 *
 * Fastrr's signing scheme is not published, so both usual shapes are accepted:
 * the shared secret echoed in a header, or an HMAC-SHA256 of the raw body.
 * Without FASTRR_WEBHOOK_SECRET the route refuses everything rather than
 * trusting an open endpoint that can mark orders paid.
 */
export async function verifySignature(
  env: Env,
  request: Request,
  rawBody: string,
): Promise<boolean> {
  const secret = env.FASTRR_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.log('[fastrr:webhook] refused — FASTRR_WEBHOOK_SECRET unset');
    return false;
  }

  const header =
    request.headers.get('x-fastrr-signature') ??
    request.headers.get('x-shiprocket-signature') ??
    request.headers.get('x-webhook-signature') ??
    request.headers.get('authorization') ??
    '';

  if (!header) {
    console.log('[fastrr:webhook] refused — no signature header');
    return false;
  }

  if (timingSafeEqual(header.replace(/^Bearer\s+/i, ''), secret)) return true;

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

/**
 * Confirms an order in the thread.
 *
 * Exported because the Shopify sweep needs to say exactly the same thing when
 * it finds an order the webhook never reported — one wording, one idempotency
 * guard, whichever route noticed the payment first.
 */
export async function confirmPaid(
  env: Env,
  pending: PendingCheckout,
  orderNumber?: string,
): Promise<boolean> {
  if (pending.settledAt) {
    console.log('[fastrr:already-settled]', pending.waId, pending.orderNumber);
    return false;
  }

  // Claimed before anything is sent, so a retry arriving mid-flight finds it
  // taken rather than sending a second confirmation.
  pending.settledAt = new Date().toISOString();
  pending.orderNumber = orderNumber ?? pending.orderNumber;
  await savePending(env, pending);

  const itemised = pending.lines.map((l) => `${l.title} · ${l.size}`).join('\n');
  const body = [
    COPY.orderConfirmed,
    '',
    itemised,
    '',
    `Total ${formatINR(pending.totalINR)}`,
    pending.orderNumber ? `Order ${pending.orderNumber}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  await sendButtons(env, pending.waId, body, [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);

  // The bag is bought; leaving it would size it again on the next message.
  await clearCart(env, pending.waId);

  console.log('[fastrr:confirmed]', pending.waId, pending.orderNumber ?? '(no order number)');
  return true;
}

/**
 * The webhook endpoint.
 *
 * Always answers 200 once the signature checks out, whatever happens after —
 * a non-2xx makes Fastrr retry, and a retry cannot fix a payload we could not
 * read. Failures are logged instead, which is where they can be acted on.
 */
export async function handleFastrrWebhook(env: Env, request: Request): Promise<Response> {
  const rawBody = await request.text();

  if (!(await verifySignature(env, request, rawBody))) {
    return new Response('Forbidden', { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.log('[fastrr:webhook] unparseable body', rawBody.slice(0, 300));
    return new Response('OK', { status: 200 });
  }

  const event = parseFastrrEvent(body);

  /*
   * Logged in full on purpose. The payload schema is not published, so the
   * first real delivery of each shape is the only specification available —
   * and this line is how the parser above gets tightened.
   */
  console.log('[fastrr:webhook]', event.kind, event.phone ?? 'no-phone', rawBody.slice(0, 1500));

  if (event.kind !== 'paid') return new Response('OK', { status: 200 });

  if (!event.phone) {
    console.log('[fastrr:no-phone] cannot match a shopper to this payment');
    return new Response('OK', { status: 200 });
  }

  /*
   * Matched on the last ten digits. WhatsApp ids carry the country code and
   * checkout forms may not, so neither is trusted whole.
   */
  const pending = await loadPending(env, `91${event.phone}`);
  if (!pending) {
    console.log('[fastrr:no-pending]', event.phone, '— paid, but no checkout on record');
    return new Response('OK', { status: 200 });
  }

  await confirmPaid(env, pending, event.orderNumber);
  return new Response('OK', { status: 200 });
}

/** Told to the shopper only when the webhook says the payment failed. */
export async function reportFailure(env: Env, waId: string): Promise<void> {
  await sendText(env, waId, COPY.checkoutUnavailable);
}
