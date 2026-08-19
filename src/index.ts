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

import type { Env, State } from './types.js';
import { handleAdmin } from './admin.js';
import { CATEGORIES, OCCASIONS, getProducts } from './catalog.js';
import { COPY } from './copy.js';
import {
  askCategory,
  askOccasion,
  askSize,
  clearState,
  confirmOrder,
  freshState,
  loadState,
  openCatalogue,
  runBackend,
  saveState,
  sendCheckout,
  showMoreLooks,
} from './flow.js';
import {
  clearSendContext,
  graphCall,
  sendButtons,
  sendText,
  setSendContext,
} from './whatsapp.js';
import { getStore } from './platform/store.js';
import { getAnalytics, newSessionId } from './analytics/log.js';
import { runDailyPull as runPull, type PullSummary } from './analytics/pull.js';
import { shouldProcess, verifySignature } from './webhook/signature.js';
import {
  batchIsEmpty,
  parseWebhook,
  type InboundMessage,
  type WebhookBatch,
} from './webhook/parse.js';
import { handleDashboard } from './dashboard/route.js';
import { shopifyFetch } from './catalog.js';

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

interface Inbound {
  waId: string;
  messageId: string;
  text?: string;
  replyId?: string;
  /** From the webhook's `contacts` block, for the shopper record. */
  profileName?: string;
}


async function route(env: Env, msg: Inbound): Promise<void> {
  const to = msg.waId;
  const state = await loadState(env, to);
  const analytics = getAnalytics(env);

  /*
   * A session is the unit the funnel counts, so one is minted whenever a
   * conversation genuinely begins — no session yet, or the last one ended. It
   * is carried in state, which means every event this turn produces threads
   * into the same journey row.
   */
  if (!state.sessionId || state.step === 'done') {
    state.sessionId = newSessionId();
    await analytics.openSession(state.sessionId, to);
  }

  setSendContext(to, { sessionId: state.sessionId, state });

  await analytics.inbound({
    waId: to,
    wamid: msg.messageId,
    sessionId: state.sessionId,
    flowStep: state.step,
    messageType: msg.replyId ? 'interactive' : 'text',
    payloadId: msg.replyId,
    profileName: msg.profileName,
  });

  try {
    if (msg.replyId) {
      await handleReply(env, to, state, msg.replyId);
    } else if (msg.text !== undefined) {
      await handleText(env, to, state, msg.text);
    }
  } finally {
    /*
     * Patched from the state the turn ended in, so the funnel reflects where
     * the shopper actually got to. In `finally` for the same reason saveState
     * is — a mid-flow error must not lose the progress already made.
     */
    if (state.sessionId) {
      await analytics.patchSession(state.sessionId, {
        occasion: state.occasion,
        category: state.category,
        lastStep: state.step,
        productPicked: state.currentLookId,
      });
    }
    clearSendContext(to);
    await saveState(env, to, state);
  }
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
    await sendCheckout(env, to, state, product, size);
    return;
  }

  switch (replyId) {
    case 'act:more':
      await showMoreLooks(env, to, state);
      return;
    // Both labels lead to the same place: WhatsApp's catalogue cannot be
    // opened on one category, so "Browse Catalog" and "Browse Category" can
    // only ever show the same card.
    case 'act:catalog':
    case 'act:browse':
      await openCatalogue(env, to, state, all);
      return;
    case 'act:paid':
      await confirmOrder(env, to, state);
      return;
    case 'act:callback': {
      /*
       * Nothing here records the request: the log line below is its only
       * trace, and `wrangler tail` shows it solely while someone is watching.
       * The shopper's wa_id is the number to ring.
       */
      console.log(
        '[stylist:callback]',
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
  if (state.step === 'checkout') {
    await confirmOrder(env, to, state);
    return;
  }

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
  const keyword = text.trim().toLowerCase();
  if (state.rankedIds.length) {
    if (/^(more|next)\b/.test(keyword)) {
      await showMoreLooks(env, to, state);
      return;
    }
    if (/^(browse|catalog|catalogue)\b/.test(keyword)) {
      await openCatalogue(env, to, state, await getProducts(env));
      return;
    }
  }

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

/**
 * Records everything in the batch that is not a shopper message.
 *
 * Delivery receipts, opt-outs, template pauses and account alerts all arrive
 * here and none of them route into the conversation. They used to be logged to
 * the console and dropped — which threw away, among other things, the pricing
 * object that is the only per-message cost data Meta ever hands over.
 */
async function recordNonMessageEvents(env: Env, batch: WebhookBatch): Promise<void> {
  const analytics = getAnalytics(env);

  for (const status of batch.statuses) await analytics.status(status);

  for (const optOut of batch.optOuts) {
    // Policy requires honouring this. The flag it sets is what any future
    // marketing send has to consult before going out.
    console.log('[optout]', optOut.waId, optOut.value);
    await analytics.optOut(optOut.waId, optOut.value, optOut.timestamp);
  }

  for (const evt of batch.templateEvents) {
    console.log('[template]', evt.name, evt.event);
    await analytics.templateStatus(evt.name, evt.event, evt.meta);
  }

  for (const evt of batch.accountEvents) {
    console.log('[account]', evt.type, JSON.stringify(evt.meta));
    await analytics.accountEvent(evt.type, evt.meta);
  }
}

/**
 * Turns a parsed webhook message into what the router expects.
 *
 * A cart (`type: "order"`) is the one case worth calling out: it is the only
 * webhook Meta sends that proves a shopper engaged with a product card, since
 * opening the product page itself fires nothing at all.
 */
async function toInbound(env: Env, msg: InboundMessage): Promise<Inbound | null> {
  if (msg.order) {
    await getAnalytics(env).milestone('cart_sent', {
      waId: msg.waId,
      productIds: msg.order.items.map((i) => i.retailerId),
      meta: {
        catalogId: msg.order.catalogId,
        items: msg.order.items,
        total: msg.order.items.reduce((sum, i) => sum + i.price * i.quantity, 0),
      },
    });
    return { waId: msg.waId, messageId: msg.messageId, text: msg.text ?? '' };
  }

  if (msg.replyId) return { waId: msg.waId, messageId: msg.messageId, replyId: msg.replyId };
  if (msg.text !== undefined) return { waId: msg.waId, messageId: msg.messageId, text: msg.text };

  // Images, audio, location, reactions. Logged by the caller, not routed —
  // there is no branch in the flow that acts on them.
  console.log('[inbound:unroutable-type]', msg.messageType);
  return null;
}

/** Meta retries webhooks; swallow a repeat of a message id we already ran. */
async function alreadyHandled(env: Env, messageId: string): Promise<boolean> {
  const key = `msg:${messageId}`;
  if (await getStore(env).get(key)) return true;
  await getStore(env).put(key, '1', { expirationTtl: 600 });
  return false;
}

/* ------------------------------------------------------------------ *
 * Worker entrypoint
 * ------------------------------------------------------------------ */


/**
 * The nightly analytics pull, with this project's Graph and Shopify clients
 * injected. pull.ts declares what it needs rather than importing it, so the
 * module graph stays acyclic. Exported so server.ts can drive it from cron.
 */
export function runDailyPull(env: Env): Promise<PullSummary> {
  return runPull(env, {
    graphCall: (p) => graphCall(env, p),
    shopifyFetch: (p) => shopifyFetch(env, p),
  });
}

export type Background = (promise: Promise<unknown>) => void;

/**
 * The whole HTTP surface, platform neutral.
 *
 * Takes a standard Request and returns a standard Response, so Cloudflare
 * calls it from the fetch handler below and Node calls it from server.ts
 * through a small adapter. `background` is the one real difference: on
 * Cloudflare it is ctx.waitUntil, on Node a fire-and-forget with a catch.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  background: Background,
): Promise<Response> {
  {
    const url = new URL(request.url);
    // Tolerate a trailing slash — "/webhook/" is an easy thing to paste into Meta.
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' && request.method === 'GET') {
      return new Response('Reistor AI Stylist is running. Webhook lives at /webhook.', {
        status: 200,
      });
    }

    /*
     * Liveness probe. Deliberately touches no external service, so a Meta or
     * Shopify outage cannot make the process look dead and trigger a restart
     * loop.
     */
    if (path === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          ok: true,
          store: env.SUPABASE_URL ? 'supabase' : env.STATE ? 'kv' : 'memory',
          signatureVerification: env.APP_SECRET ? 'on' : 'OFF',
          analytics: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'on' : 'off',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (path === '/dashboard' || path.startsWith('/dashboard/')) {
      return handleDashboard(request, env, path);
    }

    /*
     * Runs the nightly pull by hand — useful on the first day, when waiting
     * for 02:30 to discover the Shopify credentials are wrong is a poor use
     * of an evening.
     */
    if (path === '/admin/pull' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify(await runDailyPull(env), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
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
      console.log('[verify]', mode, token === env.VERIFY_TOKEN ? 'token-ok' : 'token-mismatch');

      if (mode === 'subscribe' && token === env.VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    /*
     * The body is read as TEXT first, then parsed.
     *
     * Signature verification runs over the exact bytes Meta sent. Parsing the
     * JSON and re-serialising it changes key order and whitespace, so the HMAC
     * would never match — reading text once and parsing from the string is the
     * only order that works.
     */
    const rawBody = await request.text();

    const outcome = await verifySignature(
      env.APP_SECRET,
      request.headers.get('x-hub-signature-256'),
      rawBody,
    );
    if (!shouldProcess(outcome)) {
      // 403 rather than 200: a forged payload is not an event to acknowledge.
      return new Response('Forbidden', { status: 403 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.log('[inbound:bad-json]');
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    console.log('[inbound]', rawBody);

    const batch = parseWebhook(body);

    if (!batchIsEmpty(batch)) {
      background(
        (async () => {
          try {
            // Statuses, opt-outs, template and account events. None of these
            // route into a conversation, and all of them are worth keeping.
            await recordNonMessageEvents(env, batch);

            for (const message of batch.messages) {
              if (await alreadyHandled(env, message.messageId)) {
                console.log('[inbound:duplicate]', message.messageId);
                continue;
              }
              const inbound = await toInbound(env, message);
              if (inbound) await route(env, inbound);
            }
          } catch (err) {
            console.log('[route:error]', String(err), (err as Error)?.stack);
          }
        })(),
      );
    }

    // Meta expects a fast 200 regardless of what happens downstream.
    return new Response('EVENT_RECEIVED', { status: 200 });
  }
}

/* ------------------------------------------------------------------ *
 * Cloudflare entrypoint
 *
 * Thin by design: everything above runs unchanged on Node. The only Worker
 * specific line is ctx.waitUntil, wrapped as `background`.
 * ------------------------------------------------------------------ */

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, (promise) => ctx.waitUntil(promise));
  },

  /** Daily cron, configured under [triggers] in wrangler.toml. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyPull(env));
  },
} satisfies ExportedHandler<Env>;
