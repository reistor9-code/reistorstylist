/**
 * Reistor AI Stylist — WhatsApp Cloud API bot on a single Cloudflare Worker.
 *
 * GET  /webhook  Meta verification handshake
 * POST /webhook  inbound messages; always answers 200 immediately and does the
 *                work in ctx.waitUntil()
 *
 * State lives in Workers KV, one record per WhatsApp `wa_id`.
 *
 * This file is the entry point and the router only. The pieces live next to
 * it: types.ts, copy.ts, catalog.ts, whatsapp.ts, ranking.ts, flow.ts and
 * admin.ts.
 */

import type { CartLine, Env, State } from './types';
import { CART_TTL_SECONDS, clearCart, loadCart, saveCart } from './cart';
import { handleAdmin } from './admin';
import type { Product } from './catalog';
import {
  CATEGORIES,
  OCCASIONS,
  getProducts,
  parseVariantRetailerId,
  productSku,
} from './catalog';
import { COPY, fill, formatINR } from './copy';
import {
  askCartPick,
  askCategory,
  askOccasion,
  askSize,
  sendStoreCheckout,
  browseCategory,
  clearState,
  confirmOrder,
  freshState,
  loadState,
  runBackend,
  saveState,
  showMoreLooks,
} from './flow';
import {
  markCartSent,
  readEntrySource,
  recordEntrySource,
  recordCallbackRequest,
  recordSearchMiss,
  stripSourceCode,
  type Referral,
} from './analytics/capture';
import { getAnalytics } from './analytics/log';
import { analyticsProbe } from './analytics/probe';
import { handleDashboard } from './dashboard/route';
import { runJobs } from './jobs';
import { handleRazorpayWebhook, razorpayStatus, sendRazorpayCheckout } from './razorpay';
import { handleFastrrWebhook } from './fastrr';
import { clearApplied, loadApplied, refusal, saveApplied, validateCoupon } from './coupons';
import { placeCodOrder, sendCodConfirm } from './cod';
import {
  askAddress,
  isComplete,
  loadAddress,
  parseAddressReply,
  saveAddress,
  summarise,
  type ShippingAddress,
} from './address';
import {
  inAppStatus,
  parsePaymentUpdate,
  sendOrderDetails,
  settlePayment,
  type PaymentUpdate,
} from './inapp';
import { sendButtons, sendText } from './whatsapp';
import { timingSafeEqual, verifyMetaSignature } from './signature';

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

interface Inbound {
  waId: string;
  messageId: string;
  text?: string;
  replyId?: string;
  /** Catalog retailer ids from a sent cart — see parseInbound. */
  orderItems?: string[];
  /** Present only on the first message of a Click-to-WhatsApp conversation. */
  referral?: Referral;
  /** Delivery receipts for our own sends — no shopper action behind them. */
  statuses?: Record<string, unknown>[];
  /** An in-app checkout result, from Meta's India Payments API. */
  payment?: PaymentUpdate;
  /** A delivery address submitted through WhatsApp's address form. */
  address?: ShippingAddress;
}


async function route(env: Env, msg: Inbound): Promise<void> {
  /*
   * Delivery receipts carry no shopper action, so they never touch state or
   * the flow — they are recorded and the function returns. Everything the
   * Delivery and cost tiles report comes from these rows: whether a message
   * arrived, whether it was read, and which category Meta billed it as.
   */
  /*
   * A payment carries no shopper action either, so like a delivery receipt it
   * never touches the flow state: it settles and returns.
   */
  if (msg.payment) {
    await settlePayment(env, msg.payment);
    return;
  }

  if (msg.statuses) {
    const analytics = getAnalytics(env);
    for (const s of msg.statuses) {
      const pricing = (s.pricing ?? {}) as Record<string, unknown>;
      const errors = (s.errors ?? []) as Record<string, unknown>[];
      await analytics.status({
        wamid: String(s.id ?? ''),
        waId: s.recipient_id ? String(s.recipient_id) : undefined,
        status: String(s.status ?? ''),
        billable: typeof pricing.billable === 'boolean' ? pricing.billable : undefined,
        pricingCategory: pricing.category ? String(pricing.category) : undefined,
        pricingType: pricing.type ? String(pricing.type) : undefined,
        errorCode: errors[0]?.code ? Number(errors[0].code) : undefined,
        errorTitle: errors[0]?.title ? String(errors[0].title) : undefined,
        timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : undefined,
      });
    }
    return;
  }

  const to = msg.waId;
  const state = await loadState(env, to);

  /*
   * Attribution, captured before anything else runs.
   *
   * A CTWA referral rides on the first message only, and the prefilled-link
   * code is stripped from the text below — so both have to be read here, while
   * the original message is still intact.
   */
  const source = readEntrySource(msg.text, msg.referral);
  const analytics = getAnalytics(env);

  /*
   * The session row has to exist before anything can be written against it.
   * Nothing else inserts it, so a missing openSession() here turns every
   * later update into a no-op against a row that was never there — which is
   * exactly how a dashboard ends up reading zero while the bot works fine.
   */
  const newSession = !state.sessionId;
  if (newSession) state.sessionId = crypto.randomUUID();
  const sessionId = state.sessionId!;
  if (newSession) await analytics.openSession(sessionId, to);

  // The body rides in `meta`, which the generated events.body column reads.
  await analytics.inbound({
    waId: to,
    sessionId,
    wamid: msg.messageId,
    flowStep: state.step,
    messageType: msg.replyId ? 'interactive' : msg.orderItems ? 'order' : 'text',
    payloadId: msg.replyId,
    meta: msg.text ? { body: msg.text } : undefined,
  });

  try {
    if (msg.address) {
      await handleAddress(env, to, state, msg.address);
    } else if (msg.replyId) {
      await handleReply(env, to, state, msg.replyId);
    } else if (msg.orderItems) {
      await handleOrder(env, to, state, msg.orderItems);
    } else if (msg.text !== undefined) {
      await handleText(env, to, state, stripSourceCode(msg.text));
    }
  } finally {
    /*
     * After the handler, because a greeting resets the session and mints a
     * new id — recording against the old one would attribute the ad to a
     * journey the shopper already abandoned.
     */
    if (state.sessionId && state.sessionId !== sessionId) {
      await analytics.openSession(state.sessionId, to);
    }
    const current = state.sessionId ?? sessionId;

    if (newSession || source.entry_source !== 'organic') {
      await recordEntrySource(env, current, source);
    }

    // Everything the funnel counts, written once per message rather than at
    // each step: the state object already holds the furthest point reached.
    await analytics.patchSession(current, {
      occasion: state.occasion,
      category: state.category,
      lastStep: state.step,
      looksShown: state.shownLookIds.length,
      productsShown: state.shownLookIds,
      productPicked: state.currentLookId,
    });

    await saveState(env, to, state);
  }
}

/**
 * A cart sent from the product page.
 *
 * WhatsApp's cart is a message, not an order — it reaches the business and
 * stops there, with no size and no payment attached. This is where the sale
 * is picked up: size first, then a checkout link.
 */
async function handleOrder(
  env: Env,
  to: string,
  state: State,
  retailerIds: string[],
): Promise<void> {
  const all = await getProducts(env);
  const byId = new Map(all.map((p) => [p.id, p]));

  /*
   * The catalog holds one item per size, so a sent cart arrives with the size
   * already chosen — `<productId>-<SIZE>`. That is the whole point of the
   * variant sync: the shopper picked it on WhatsApp's product page, seeing
   * which sizes were actually in stock, and none of the asking below is
   * needed for those lines.
   *
   * Plain product ids still resolve, because a cart built before the sync — or
   * from a catalogue page Meta has not refreshed — carries the old shape.
   */
  const resolved = retailerIds.map((retailerId) => {
    /*
     * A bare product id means the primary size.
     *
     * The catalog gives its first in-stock size the product id itself, so that
     * the id a carousel card points at is a member of its own variant group —
     * which is what makes WhatsApp draw the size selector. The consequence is
     * that a shopper choosing that size sends the bare id, and reading it as
     * "no size chosen" would ask them again for the one thing they just
     * picked.
     */
    const direct = byId.get(retailerId);
    if (direct) {
      const primary = direct.sizes.find((s) => s.stock > 0) ?? direct.sizes[0];
      return { product: direct, size: primary?.size };
    }

    const parsed = parseVariantRetailerId(retailerId);
    const product = parsed ? byId.get(parsed.productId) : undefined;
    if (!product || !parsed) return null;

    // Trust the catalog's spelling of the size, not the id's.
    const size = product.sizes.find((s) => s.size.toUpperCase().replace(/[^A-Z0-9]/g, '') === parsed.size);
    return { product, size: size?.size };
  }).filter((r): r is { product: Product; size: string | undefined } => Boolean(r));

  const items = resolved.map((r) => r.product);

  if (items.length === 0) {
    console.log('[order:unmatched]', JSON.stringify(retailerIds));
    await sendText(env, to, COPY.cartEmpty);
    return;
  }

  console.log(
    '[order:received]',
    `${items.length} lines`,
    `${resolved.filter((r) => r.size).length} already sized`,
    resolved.map((r) => `${r.product.id}:${r.size ?? '?'}`).join(' '),
  );

  if (state.sessionId) await markCartSent(env, state.sessionId);

  /*
   * The basket is MERGED with whatever is already being sized, not replaced.
   *
   * WhatsApp does not empty the shopper's cart after they send it, so the same
   * cart can arrive again mid-flow — re-sent by hand, redelivered by Meta, or
   * sent again with one more garment added. Rebuilding from scratch threw away
   * every size already chosen, which showed up as the count going backwards:
   * "2 of 4 sized" followed by "2 of 5 sized".
   *
   * Keeping the sizes makes a repeated cart harmless, and an added garment
   * simply joins the queue with the rest still sized.
   */
  /*
   * Sizes are carried over only while a basket is genuinely MID-SIZING —
   * some lines sized, some not. A basket where everything already has a size
   * has been through checkout, and a cart sent after that is a new shop, not
   * a continuation: reusing those sizes skipped the questions entirely and
   * went straight to Buy Now.
   */
  const previous = await loadCart(env, to);
  const midSizing = previous.length > 0 && previous.some((l) => !l.size);
  const alreadySized = new Map(
    midSizing ? previous.map((l) => [l.productId, l.size] as const) : [],
  );
  const resent = alreadySized.size > 0;

  /*
   * The size on the cart line comes from the catalog variant the shopper
   * picked. Anything already sized in a basket still in progress wins over it,
   * so re-sending a half-sized cart does not undo choices made in the chat.
   */
  const cart: CartLine[] = resolved.map(({ product: p, size }) => ({
    productId: p.id,
    title: p.title,
    priceINR: p.priceINR,
    size: alreadySized.get(p.id) ?? size,
  }));
  await saveCart(env, to, cart);

  console.log(
    '[cart:received]',
    `items=${items.length}`,
    `carried=${cart.filter((l) => l.size).length}`,
    resent ? 'merged with a basket already in progress' : 'new basket',
  );

  // Greeted once per basket, and not at all when the same one arrives twice —
  // the shopper is mid-way through sizing and has not just walked in.
  if (!resent) {
    // Only promise a size question when one is actually coming.
    const needsSize = cart.some((l) => !l.size);
    await sendText(env, to, needsSize ? COPY.cartReceived : COPY.cartReceivedSized);
  }
  await sizeNextLine(env, to, state, all);
}

/**
 * Sizes the basket one garment at a time, then checks out once.
 *
 * Called after every size is chosen, so a four-piece cart asks four times and
 * charges once. Without the loop the first size ended the flow and the other
 * three garments were silently dropped — the shopper paid for one of the four
 * things they had chosen.
 */
/**
 * Which checkout the Buy Now button opens.
 *
 * "fastrr" and "gokwik" send the SAME Shopify cart permalink. Neither is
 * called by this Worker and neither needs credentials here — both are apps
 * installed on reistor.in that replace the store's checkout, and which of
 * them answers is decided there, not in this file.
 *
 * They are distinct values only so the logs say which was expected, and so a
 * confirmation route can be chosen: Fastrr posts to /webhooks/fastrr, while
 * GoKwik's notification URL is not ours to configure.
 *
 * Razorpay stays wired and is one variable away — set CHECKOUT_PROVIDER to
 * "razorpay" to send in-chat payment links again. Keeping all three live
 * means a checkout that misbehaves mid-test is a config change rather than a
 * rollback.
 */
/**
 * Picks the basket back up once the address is in.
 *
 * The lines were stashed when the form went out, so the shopper resumes the
 * bag they sized rather than starting again.
 */
/**
 * A delivery address came back from the form.
 *
 * Saved for six months so the shopper confirms rather than retypes next time,
 * echoed so they can see what will be shipped to, and then the basket they
 * were sizing picks up where it left off.
 */
async function handleAddress(
  env: Env,
  to: string,
  state: State,
  address: ShippingAddress,
): Promise<void> {
  await saveAddress(env, to, address);
  console.log('[address:saved]', to, address.city ?? '', address.in_pin_code ?? '');

  await sendText(env, to, `${COPY.addressSaved}
${summarise(address)}`);
  await resumeCheckout(env, to, state);
}

type CheckoutLine = { productId: string; title: string; size: string; priceINR: number };

/**
 * The basket parked while checkout asks a question, without consuming it.
 *
 * Falls back to the Cash on Delivery hold, because choosing COD moves the
 * lines from `colines` to `cod` — and a shopper who then decides to pay online
 * after all still has a basket, just not where the online path was looking.
 */
async function parkedLines(env: Env, to: string): Promise<CheckoutLine[]> {
  for (const key of [`colines:${to}`, `cod:${to}`]) {
    const raw = await env.STATE.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as CheckoutLine[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // A malformed hold is the same as no hold.
    }
  }
  return [];
}

async function resumeCheckout(env: Env, to: string, state: State): Promise<void> {
  const raw = await env.STATE.get(`colines:${to}`);
  const lines = raw ? (JSON.parse(raw) as { productId: string; title: string; size: string; priceINR: number }[]) : [];

  if (!lines.length) {
    console.log('[address:no-pending-lines]', to);
    await sendText(env, to, COPY.addressSavedNoBag);
    return;
  }

  await env.STATE.delete(`colines:${to}`);

  /*
   * `askedAlready` so the form is sent once and once only.
   *
   * The shopper has just filled it in. If anything about what came back reads
   * as incomplete — a field named differently than expected, a form submitted
   * half-empty — asking again produces exactly the same result and traps them
   * in a loop. Better to carry on and let the order be tagged address-pending,
   * which is a person's afternoon rather than a dead conversation.
   */
  await openCheckout(env, to, state, await getProducts(env), lines, { address: true });
}

async function openCheckout(
  env: Env,
  to: string,
  state: State,
  all: Product[],
  lines: { productId: string; title: string; size: string; priceINR: number }[],
  /*
   * What has already been settled for this basket.
   *
   * One flag used to cover both, which meant a shopper who filled in an
   * address was never offered a discount — the same boolean that said "stop
   * asking about delivery" also said "stop asking about codes".
   */
  done: { address?: boolean; coupon?: boolean; payment?: boolean } = {},
): Promise<void> {
  /*
   * The address, before the money.
   *
   * WhatsApp's address_message is India-only and needs no entitlement, so it
   * works while the Payments API approval sits with Meta. Asking here rather
   * than after payment means the Shopify order arrives fulfillable instead of
   * tagged address-pending for someone to chase.
   *
   * A shopper who has ordered before is not asked again — their address is on
   * file and offered inside the form as a pickable option when they are.
   */
  if (!done.address && (env.ADDRESS_CAPTURE || 'on').toLowerCase() === 'on') {
    const known = await loadAddress(env, to);
    // Stashed either way, so whichever button comes back resumes this basket.
    await env.STATE.put(`colines:${to}`, JSON.stringify(lines), {
      expirationTtl: CART_TTL_SECONDS,
    });

    /*
     * A returning shopper confirms rather than retypes — but is shown what
     * they are confirming. Silently shipping to an address from six months ago
     * is the kind of thing nobody notices until a parcel goes to an old flat.
     */
    if (isComplete(known)) {
      state.step = 'address';
      await sendButtons(env, to, `${COPY.addressConfirm}
${summarise(known)}`, [
        { id: 'act:addr_ok', title: 'Deliver here' },
        { id: 'act:addr_new', title: 'Use another' },
      ]);
      return;
    }

    if (await askAddress(env, to, state, COPY.addressAsk)) return;
    // address_message unavailable — carry on rather than strand the shopper.
    console.log('[address:skipped] falling through to checkout');
  }

  /*
   * The discount, after the address and before the money.
   *
   * Here rather than earlier because the basket is final by this point — a
   * code with a minimum spend can be judged against a total that will not
   * change, so "that code needs ₹3,000 or more" is true when it is said.
   */
  if (!done.coupon && (env.COUPONS || 'on').toLowerCase() === 'on') {
    await env.STATE.put(`colines:${to}`, JSON.stringify(lines), {
      expirationTtl: CART_TTL_SECONDS,
    });
    state.step = 'coupon';

    const subtotal = lines.reduce((sum, l) => sum + l.priceINR, 0);
    const already = await loadApplied(env, to);

    /*
     * A code already applied is re-priced against THIS basket, not carried
     * over at the amount it was worth on the last one. Ten per cent of a
     * 3,000 bag is not ten per cent of a 2,100 bag, and a stale figure would
     * quote one number and charge another.
     *
     * It is also re-validated: a code can expire, or stop meeting its minimum
     * spend, between one basket and the next.
     */
    if (already) {
      const recheck = await validateCoupon(env, already.code, subtotal, lines.length);
      if (recheck.ok) {
        await saveApplied(env, to, recheck.coupon);
        await sendButtons(
          env,
          to,
          fill(COPY.couponApplied, {
            code: recheck.coupon.code,
            was: formatINR(subtotal),
            now: formatINR(Math.max(1, subtotal - recheck.coupon.discountINR)),
          }),
          [
            { id: 'act:nocoupon', title: 'Continue' },
            { id: 'act:coupon', title: 'Use another code' },
          ],
        );
        return;
      }
      // No longer valid on this basket — drop it and ask afresh.
      console.log('[coupon:dropped]', already.code, recheck.ok ? '' : recheck.reason);
      await clearApplied(env, to);
    }

    await sendButtons(env, to, COPY.couponAsk, [
      { id: 'act:coupon', title: 'Apply a code' },
      { id: 'act:nocoupon', title: 'No, continue' },
    ]);
    return;
  }

  /*
   * How they want to pay, once the bag and the price are settled.
   *
   * Cash on delivery is most of Indian fashion ecommerce, so it is offered
   * beside the card rather than buried. The two paths diverge completely from
   * here: online creates a payment link and waits for a webhook, COD places
   * the order on a button press and collects nothing.
   */
  if (!done.payment && (env.COD || 'on').toLowerCase() === 'on') {
    await env.STATE.put(`colines:${to}`, JSON.stringify(lines), {
      expirationTtl: CART_TTL_SECONDS,
    });
    await sendButtons(env, to, COPY.payHow, [
      { id: 'act:pay_online', title: 'Pay online' },
      { id: 'act:pay_cod', title: 'Cash on delivery' },
    ]);
    return;
  }

  const provider = (env.CHECKOUT_PROVIDER || 'fastrr').toLowerCase();

  /*
   * The only checkout that stays inside the thread. It is tried first and
   * falls through rather than failing: an unset payment configuration, an
   * unverified business or a number without the entitlement all reject the
   * send, and a shopper who has just picked their size should get a working
   * checkout regardless of which prerequisite is missing.
   */
  if (provider === 'whatsapp') {
    if (await sendOrderDetails(env, to, state, lines)) return;
    console.log('[checkout:inapp-fallback] falling back to a payment link');
    await sendRazorpayCheckout(env, to, state, lines);
    return;
  }

  if (provider === 'razorpay') {
    await sendRazorpayCheckout(env, to, state, lines);
    return;
  }
  await sendStoreCheckout(env, to, state, all, lines);
}

async function sizeNextLine(
  env: Env,
  to: string,
  state: State,
  all: Product[],
): Promise<void> {
  const cart = await loadCart(env, to);
  const unsized = cart.filter((l) => !l.size);
  const byId = new Map(all.map((p) => [p.id, p]));

  console.log('[cart:next]', `lines=${cart.length}`, `unsized=${unsized.length}`);

  if (unsized.length === 0) {
    const lines = cart
      .filter((l): l is CartLine & { size: string } => Boolean(l.size))
      .map((l) => ({
        productId: l.productId,
        title: l.title,
        size: l.size,
        priceINR: l.priceINR,
      }));

    if (!lines.length) {
      await sendText(env, to, COPY.cartEmpty);
      return;
    }

    await openCheckout(env, to, state, all, lines);
    return;
  }

  // One left: no point asking which. Straight to its size list.
  if (unsized.length === 1) {
    const product = byId.get(unsized[0].productId);
    if (product) {
      await askSize(env, to, state, product);
      return;
    }
    // The catalogue no longer has it — drop the line rather than stall.
    unsized[0].size = 'unavailable';
    await sizeNextLine(env, to, state, all);
    return;
  }

  const remaining = unsized
    .map((l) => byId.get(l.productId))
    .filter((p): p is Product => Boolean(p));

  await askCartPick(env, to, state, remaining, cart.length - unsized.length);
}

async function handleReply(env: Env, to: string, state: State, replyId: string): Promise<void> {
  const all = await getProducts(env);
  const byId = new Map(all.map((p) => [p.id, p]));

  if (replyId.startsWith('occ:')) {
    state.occasion = replyId.slice(4);
    await askCategory(env, to, state);
    return;
  }

  if (replyId.startsWith('cat:')) {
    state.category = replyId.slice(4);
    await runBackend(env, to, state);
    return;
  }

  if (replyId.startsWith('look:')) {
    const product = byId.get(replyId.slice(5));
    if (!product) {
      await askOccasion(env, to, state);
      return;
    }
    await askSize(env, to, state, product);
    return;
  }

  if (replyId.startsWith('size:')) {
    const [, productId, size] = replyId.split(':');
    const product = byId.get(productId);
    if (!product) {
      await askOccasion(env, to, state);
      return;
    }

    /*
     * A size against a basket line records it and moves to the next unsized
     * garment; the payment happens once, at the end. A size chosen outside a
     * basket — straight off a look — is a basket of one and checks out
     * immediately, which is the same code path with nothing left to ask.
     */
    /*
     * Matched loosely on purpose. A basket line is found even if it already
     * carries a size — a shopper who reopens an earlier size list and changes
     * their mind should update that line, not start a second checkout for the
     * same garment.
     */
    const cart = await loadCart(env, to);
    const line = cart.find((l) => l.productId === productId && !l.size)
      ?? cart.find((l) => l.productId === productId);

    console.log(
      '[cart:size]',
      productId,
      size,
      `cart=${cart.length}`,
      `matched=${Boolean(line)}`,
      `unsized=${cart.filter((l) => !l.size).length}`,
    );

    if (line) {
      /*
       * The array is rebuilt and reassigned rather than the element mutated
       * in place. Mutating through a reference works only while `cart` and
       * `state.cart` are the same object, which is one refactor away from
       * silently not being true — and the symptom is a size that vanishes and
       * a picker that never shrinks.
       */
      await saveCart(
        env,
        to,
        cart.map((l) => (l.productId === productId && l === line ? { ...l, size } : l)),
      );
      await sizeNextLine(env, to, state, all);
      return;
    }

    await openCheckout(env, to, state, all, [
      { productId, title: product.title, size, priceINR: product.priceINR },
    ]);
    return;
  }

  switch (replyId) {
    case 'act:more':
      await showMoreLooks(env, to, state);
      return;
    // Two ids, one action. 'act:catalog' predates the rename and is still
    // live in any menu a shopper had on screen before the deploy.
    case 'act:catalog':
    case 'act:browse':
      await browseCategory(env, to, state, all);
      return;
    /*
     * Pay online and Cash on delivery sit on one card, and a shopper is
     * allowed to change their mind.
     *
     * Both used to consume the parked basket on the way past — read `colines`,
     * delete it, continue. So whichever button was tapped first emptied the
     * shelf, and the other one found nothing and answered "Address saved. Tap
     * a look to start a new bag." to somebody who was standing at the till
     * with a garment chosen.
     *
     * Neither deletes now. The basket is released when an order is actually
     * placed — clearCart() takes `colines` and `cod` with it — or when the
     * hour's TTL runs out. Tapping back and forth between the two just re-asks
     * the question, which is what the card looks like it does.
     */
    case 'act:pay_online': {
      const lines = await parkedLines(env, to);
      if (lines.length) {
        await openCheckout(env, to, state, all, lines, {
          address: true,
          coupon: true,
          payment: true,
        });
      } else await sendText(env, to, COPY.addressSavedNoBag);
      return;
    }
    case 'act:pay_cod': {
      const lines = await parkedLines(env, to);
      if (lines.length) await sendCodConfirm(env, to, state, lines);
      else await sendText(env, to, COPY.addressSavedNoBag);
      return;
    }
    case 'act:cod_confirm':
      await placeCodOrder(env, to, state);
      return;
    case 'act:addr_ok':
      // Confirmed. The coupon step still owes them a question.
      await resumeCheckout(env, to, state);
      return;
    case 'act:addr_new': {
      /*
       * The form opens with the saved address offered as a pickable option, so
       * "use another" is a change of mind rather than a blank page — and
       * picking the old one again is still one tap.
       */
      if (await askAddress(env, to, state, COPY.addressAsk)) return;
      await resumeCheckout(env, to, state);
      return;
    }
    case 'act:coupon':
      // Cleared first, so "use another code" replaces rather than stacking.
      await clearApplied(env, to);
      state.step = 'coupon';
      await sendText(env, to, COPY.couponPrompt);
      return;
    case 'act:nocoupon': {
      // Straight past the discount, and past the address too — it is already
      // saved by the time this button exists.
      const raw = await env.STATE.get(`colines:${to}`);
      const lines = raw ? JSON.parse(raw) : [];
      await env.STATE.delete(`colines:${to}`);
      if (lines.length) await openCheckout(env, to, state, all, lines, { address: true, coupon: true });
      else await sendText(env, to, COPY.addressSavedNoBag);
      return;
    }
    case 'act:paid':
      await confirmOrder(env, to, state);
      return;
    case 'act:callback': {
      /*
       * The request goes to the database, which is what puts it on the
       * dashboard's "Call these people" queue. The log line stays as a
       * fallback: with Supabase unconfigured the write no-ops, and a promise
       * of a call within 24 hours should not vanish silently.
       */
      const stored = await recordCallbackRequest(env, {
        waId: to,
        sessionId: state.sessionId,
        occasion: state.occasion,
        category: state.category,
        productsSeen: state.shownLookIds,
      });
      console.log(
        '[stylist:callback]',
        stored ? 'queued' : 'LOG ONLY — not stored',
        JSON.stringify({
          waId: to,
          occasion: state.occasion ?? null,
          category: state.category ?? null,
          looksShown: state.shownLookIds,
          at: new Date().toISOString(),
        }),
      );
      await sendButtons(env, to, COPY.stylistCallback, [
        { id: 'act:main_menu', title: 'Main Menu' },
      ]);
      return;
    }
    case 'act:main_menu': {
      await clearCart(env, to);
      // A clean restart: unlike act:restart_occasion this carries no occasion
      // over, so whatever the shopper picks next is what the search runs on.
      Object.assign(state, freshState());
      await askOccasion(env, to, state);
      return;
    }
    case 'act:again':
    case 'act:restart_occasion': {
      const occasion = state.occasion;
      Object.assign(state, freshState());
      state.occasion = occasion;
      await askOccasion(env, to, state);
      return;
    }
    case 'act:end':
      await clearCart(env, to);
      await sendText(env, to, COPY.goodbye);
      await clearState(env, to);
      Object.assign(state, freshState());
      state.step = 'done';
      return;
    default:
      console.log('[router:unknown-reply]', replyId);
      await askOccasion(env, to, state);
  }
}

/*
 * Trailing letters are repeated deliberately: shoppers type "Hii", "heyyy",
 * "hellooo". A plain /hi\b/ fails on every one of them, dropping the shopper
 * into the "tap an option" branch instead of restarting the flow.
 */
const GREETING = /^\s*(hi+|hey+|hell?o+|start|menu|restart|namaste|hola)\b/i;

async function handleText(env: Env, to: string, state: State, text: string): Promise<void> {
  /*
   * Nothing here confirms an order. `step === 'checkout'` used to treat any
   * typed message as "I paid" and send the confirmation — which, now that a
   * real payment link is on the other side of that button, would announce a
   * payment that never happened. Only Razorpay's webhook confirms.
   */

  if (GREETING.test(text) || state.step === 'welcome' || state.step === 'done') {
    Object.assign(state, freshState());
    await sendText(env, to, COPY.welcome);
    await askOccasion(env, to, state);
    return;
  }

  // A typed occasion or category name is a reasonable shortcut.
  const occasion = OCCASIONS.find((o) => o.label.toLowerCase() === text.trim().toLowerCase());
  if (occasion) {
    state.occasion = occasion.id;
    await askCategory(env, to, state);
    return;
  }

  const category = CATEGORIES.find((c) => c.label.toLowerCase() === text.trim().toLowerCase());
  if (category && state.occasion) {
    state.category = category.id;
    await runBackend(env, to, state);
    return;
  }

  /*
   * The carousel carries no menu of its own, so these keywords are the only
   * way to page or open the catalogue by hand. The rest runs off the buttons.
   */
  /*
   * A typed discount code.
   *
   * Read before the keyword shortcuts below, or a code like MORE or BROWSE
   * would be swallowed by them and the shopper would be shown more looks
   * instead of a discount.
   */
  if (state.step === 'coupon') {
    const raw = await env.STATE.get(`colines:${to}`);
    const lines = raw
      ? (JSON.parse(raw) as { productId: string; title: string; size: string; priceINR: number }[])
      : [];
    const subtotal = lines.reduce((sum, l) => sum + l.priceINR, 0);

    const result = await validateCoupon(env, text, subtotal, lines.length);

    if (!result.ok) {
      console.log('[coupon:refused]', text.trim(), result.reason);
      await sendButtons(env, to, refusal(result.reason), [
        { id: 'act:coupon', title: 'Try another' },
        { id: 'act:nocoupon', title: 'Continue' },
      ]);
      return;
    }

    await saveApplied(env, to, result.coupon);
    console.log('[coupon:applied]', result.coupon.code, `-₹${result.coupon.discountINR}`);

    await sendText(
      env,
      to,
      fill(COPY.couponApplied, {
        code: result.coupon.code,
        was: formatINR(subtotal),
        now: formatINR(Math.max(1, subtotal - result.coupon.discountINR)),
      }),
    );

    await env.STATE.delete(`colines:${to}`);
    if (lines.length) await openCheckout(env, to, state, await getProducts(env), lines, { address: true, coupon: true });
    else await sendText(env, to, COPY.addressSavedNoBag);
    return;
  }

  const keyword = text.trim().toLowerCase();
  if (state.rankedIds.length) {
    if (/^(more|next)\b/.test(keyword)) {
      await showMoreLooks(env, to, state);
      return;
    }
    if (/^(browse|category|catalog|catalogue)\b/.test(keyword)) {
      await browseCategory(env, to, state, await getProducts(env));
      return;
    }
  }

  /*
   * Everything above matched nothing, so this is something the bot cannot
   * answer. Recorded here and only here — a shopper who typed "Tops" was
   * served by the shortcut above and is not a miss. What lands in this table
   * is the list of things customers want that the flow does not offer.
   */
  await recordSearchMiss(env, {
    waId: to,
    sessionId: state.sessionId,
    raw: text,
    flowStep: state.step,
  });

  switch (state.step) {
    case 'category':
      await sendText(env, to, COPY.tapAnOption);
      await askCategory(env, to, state);
      return;
    case 'top3':
    case 'size':
      // No menu to re-send — point at the cards instead.
      await sendText(env, to, COPY.tapACard);
      return;
    default:
      await sendText(env, to, COPY.tapAnOption);
      await askOccasion(env, to, state);
  }
}

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

function parseInbound(body: any): Inbound | null {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return null;

  /*
   * An in-app payment result. It arrives on this webhook rather than a route
   * of its own, and carries no message, so it is read before the messages
   * check below would return null on it.
   */
  const payment = parsePaymentUpdate(value);
  if (payment) {
    console.log('[inbound:payment]', JSON.stringify(value));
    return { waId: '', messageId: '', payment };
  }

  // Delivery / read receipts arrive on the same webhook field — ignore them.
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    /*
     * Delivery receipts. Previously logged and dropped, which is why delivery
     * rate and message cost read zero: sent/delivered/read/failed and the
     * billing category all arrive here and nowhere else.
     */
    if (value.statuses) {
      console.log('[inbound:status]', JSON.stringify(value.statuses));
      return { waId: '', messageId: '', statuses: value.statuses };
    }
    return null;
  }

  const message = value.messages[0];
  const waId: string | undefined = message.from;
  const messageId: string | undefined = message.id;
  if (!waId || !messageId) return null;

  /*
   * Click-to-WhatsApp attribution. Meta attaches `referral` to the FIRST
   * message of a conversation started from an ad and never again, so it is
   * lifted here — on any message type, because the ad can land the shopper
   * straight onto a button.
   */
  const referral: Referral | undefined = message.referral
    ? {
        source_type: message.referral.source_type,
        source_id: message.referral.source_id,
        source_url: message.referral.source_url,
        ctwa_clid: message.referral.ctwa_clid,
        headline: message.referral.headline,
      }
    : undefined;
  if (referral) console.log('[inbound:referral]', JSON.stringify(referral));

  if (message.type === 'text') {
    return { waId, messageId, referral, text: String(message.text?.body ?? '') };
  }

  if (message.type === 'interactive') {
    const replyId =
      message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id ?? undefined;
    if (replyId) return { waId, messageId, referral, replyId: String(replyId) };

    /*
     * A submitted address arrives as an interactive message with no list or
     * button id — the fields ride in an nfm_reply. Read after the ids so a
     * normal tap never touches this path.
     */
    const address = parseAddressReply(message);
    if (address) {
      console.log('[inbound:address]', JSON.stringify(message.interactive));
      return { waId, messageId, referral, address };
    }

    console.log('[inbound:interactive-unhandled]', JSON.stringify(message.interactive));
    return null;
  }

  if (message.type === 'order') {
    /*
     * A cart sent from the product page. Items carry the catalog
     * `retailer_id`, which is our product id — but no size, because the
     * catalog holds one entry per product rather than one per variant.
     * The size is asked for in chat before checkout.
     */
    const orderItems: string[] = (message.order?.product_items ?? [])
      .map((item: { product_retailer_id?: string }) => String(item.product_retailer_id ?? ''))
      .filter(Boolean);
    console.log('[inbound:order]', orderItems.length, JSON.stringify(orderItems));
    return { waId, messageId, referral, orderItems };
  }

  if (message.type === 'button') {
    // Template quick-reply buttons (carousel cards included) land here rather
    // than under `interactive`. The routing id is in `payload`; `text` is only
    // the visible button label.
    const payload = message.button?.payload;
    if (payload) return { waId, messageId, referral, replyId: String(payload) };
    return { waId, messageId, text: String(message.button?.text ?? '') };
  }

  console.log('[inbound:unsupported-type]', message.type);
  return { waId, messageId, text: '' };
}

/** Meta retries webhooks; swallow a repeat of a message id we already ran. */
async function alreadyHandled(env: Env, messageId: string): Promise<boolean> {
  const key = `msg:${messageId}`;
  if (await env.STATE.get(key)) return true;
  await env.STATE.put(key, '1', { expirationTtl: 600 });
  return false;
}

/* ------------------------------------------------------------------ *
 * Worker entrypoint
 * ------------------------------------------------------------------ */


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Tolerate a trailing slash — "/webhook/" is an easy thing to paste into Meta.
    const path = url.pathname.replace(/\/+$/, '') || '/';

    /*
     * Runs the nightly job now. The cron fires at 02:30 IST; waiting for that
     * to find out whether a pull works is not a debugging strategy.
     */
    if (path === '/admin/pull' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify(await runJobs(env), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Reports whether the analytics writes actually work, rather than leaving
    // a silent failure to look identical to an empty table.
    if (path === '/admin/analytics' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify(await analyticsProbe(env), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // The dashboard. Token-gated inside handleDashboard, which also serves
    // /dashboard/api, /dashboard/plain and the mark-called write.
    if (path === '/dashboard' || path.startsWith('/dashboard/')) {
      return handleDashboard(request, env, path, async () => {
        // Names and SKUs for the product tables. Cached in KV for ten minutes
        // like every other catalogue read, so this costs nothing per view.
        const all = await getProducts(env);
        return all.map((p) => ({ id: p.id, title: p.title, sku: productSku(p) }));
      });
    }

    /*
     * Fastrr's order webhook — what tells the thread a GoKwik-style checkout
     * went through. Registered from the Fastrr dashboard, which is the reason
     * this path exists at all: Fastrr lets you add a webhook yourself.
     *
     * Signature-checked inside the handler, so it needs no VERIFY_TOKEN and
     * sits ahead of the admin routes.
     */
    if (path === '/webhooks/fastrr' && request.method === 'POST') {
      return handleFastrrWebhook(env, request);
    }

    // Razorpay's payment webhook. Signature-checked inside the handler, so it
    // sits ahead of the admin routes and needs no VERIFY_TOKEN.
    if (path === '/webhooks/razorpay' && request.method === 'POST') {
      return handleRazorpayWebhook(env, request);
    }

    // What the in-app checkout has and still needs. No secrets printed.
    if (path === '/admin/inapp' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify(inAppStatus(env), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Reports whether the keys are set, and which mode they are — without
    // printing the secret. Useful before a first test.
    if (path === '/admin/razorpay' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify(await razorpayStatus(env), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (path === '/' && request.method === 'GET') {
      return new Response('Reistor AI Stylist is running. Webhook lives at /webhook.', {
        status: 200,
      });
    }

    const admin = await handleAdmin(request, env, url, path);
    if (admin) return admin;

    if (path !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    // Verification handshake
    if (request.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      const matches = Boolean(token && env.VERIFY_TOKEN && timingSafeEqual(token, env.VERIFY_TOKEN));
      console.log('[verify]', mode, matches ? 'token-ok' : 'token-mismatch');

      if (mode === 'subscribe' && matches && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    /*
     * The raw bytes, read once and used for both the signature and the parse.
     *
     * Meta signs exactly what it sent. Parsing first and re-serialising to
     * check would change the whitespace and reject a genuine message.
     */
    const raw = await request.text();
    const verdict = await verifyMetaSignature(env, request, raw);

    if (verdict === 'bad' || verdict === 'missing') {
      console.log('[inbound:refused]', verdict);
      return new Response('Forbidden', { status: 403 });
    }
    if (verdict === 'unconfigured') {
      /*
       * Logged on every request rather than once at boot. A webhook nobody is
       * checking must not become quiet background noise — anyone who learns
       * this URL can drive the entire flow, spend the messaging balance and
       * place orders. Set APP_SECRET.
       */
      console.log('[inbound:UNVERIFIED] APP_SECRET is unset — anyone can forge this request');
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      console.log('[inbound:bad-json]');
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    console.log('[inbound]', JSON.stringify(body));

    const msg = parseInbound(body);
    if (msg) {
      ctx.waitUntil(
        (async () => {
          /*
           * Status batches carry no message id of their own, so they skip the
           * dedupe entirely. Running them through it would cache the empty
           * string on the first batch and discard every receipt after it —
           * leaving delivery and cost permanently reading one message.
           *
           * Repeats are harmless here: the events table is unique on
           * (wamid, status), so the same receipt twice is one row.
           */
          if (!msg.statuses && !msg.payment && (await alreadyHandled(env, msg.messageId))) {
            console.log('[inbound:duplicate]', msg.messageId);
            return;
          }
          try {
            await route(env, msg);
          } catch (err) {
            console.log('[route:error]', String(err), (err as Error)?.stack);
          }
        })(),
      );
    }

    // Meta expects a fast 200 regardless of what happens downstream.
    return new Response('EVENT_RECEIVED', { status: 200 });
  },

  /*
   * The nightly job. Reads only — Shopify orders, and two authenticated GETs
   * against our own WABA for template performance and account health. Nothing
   * here sends a message, so nothing here can affect the number's standing.
   *
   * Scheduled for 21:00 UTC, which is 02:30 IST: after the day's trading has
   * settled and before anyone opens the dashboard.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runJobs(env).catch((err) => {
        console.log('[jobs:error]', String(err));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
