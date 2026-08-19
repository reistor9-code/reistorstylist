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

import type { Env, State } from './types';
import { handleAdmin } from './admin';
import { CATEGORIES, OCCASIONS, getProducts, isInStock } from './catalog';
import { COPY } from './copy';
import {
  askBrowsePick,
  askCategory,
  askOccasion,
  askSize,
  browseCategory,
  clearState,
  confirmOrder,
  freshState,
  loadState,
  runBackend,
  saveState,
  sendCheckout,
  showMoreLooks,
} from './flow';
import { sendButtons, sendCatalogMessage, sendText } from './whatsapp';

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

interface Inbound {
  waId: string;
  messageId: string;
  text?: string;
  replyId?: string;
}


async function route(env: Env, msg: Inbound): Promise<void> {
  const to = msg.waId;
  const state = await loadState(env, to);

  try {
    if (msg.replyId) {
      await handleReply(env, to, state, msg.replyId);
    } else if (msg.text !== undefined) {
      await handleText(env, to, state, msg.text);
    }
  } finally {
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
    case 'act:catalog': {
      // The catalogue card, not an in-chat product list. WhatsApp's catalogue
      // screen always opens on everything — `catalog_message` takes only a
      // thumbnail id, with no collection parameter — so this cannot be scoped
      // to the shopper's category.
      const cover =
        state.currentLookId ??
        state.rankedIds[0] ??
        all.find(isInStock)?.id;
      const sent = cover
        ? await sendCatalogMessage(env, to, COPY.browseCatalog, cover)
        : false;
      if (!sent) {
        console.log('[catalog-message:rejected]', `catalog=${env.CATALOG_ID ?? 'unset'}`);
        await browseCategory(env, to, state, true);
      }
      return;
    }
    case 'act:browse':
      await browseCategory(env, to, state, true);
      return;
    case 'act:load_more':
      await browseCategory(env, to, state, false);
      return;
    case 'act:pick_item':
      await askBrowsePick(env, to, state);
      return;
    case 'act:back':
      if (state.rankedIds.length) {
        state.step = 'top3';
        await sendText(env, to, COPY.tapACard);
      } else {
        await askOccasion(env, to, state);
      }
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
   * way to page or browse by hand. Everything else runs off the buttons.
   */
  const keyword = text.trim().toLowerCase();
  if (state.rankedIds.length) {
    if (/^(more|next)\b/.test(keyword)) {
      await showMoreLooks(env, to, state);
      return;
    }
    if (/^browse\b/.test(keyword)) {
      await browseCategory(env, to, state, true);
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
    case 'browse':
      await sendText(env, to, COPY.tapAnOption);
      await browseCategory(env, to, state, false);
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

  // Delivery / read receipts arrive on the same webhook field — ignore them.
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    if (value.statuses) console.log('[inbound:status]', JSON.stringify(value.statuses));
    return null;
  }

  const message = value.messages[0];
  const waId: string | undefined = message.from;
  const messageId: string | undefined = message.id;
  if (!waId || !messageId) return null;

  if (message.type === 'text') {
    return { waId, messageId, text: String(message.text?.body ?? '') };
  }

  if (message.type === 'interactive') {
    const replyId =
      message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id ?? undefined;
    if (replyId) return { waId, messageId, replyId: String(replyId) };
    return null;
  }

  if (message.type === 'button') {
    // Template quick-reply buttons (carousel cards included) land here rather
    // than under `interactive`. The routing id is in `payload`; `text` is only
    // the visible button label.
    const payload = message.button?.payload;
    if (payload) return { waId, messageId, replyId: String(payload) };
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
      console.log('[verify]', mode, token === env.VERIFY_TOKEN ? 'token-ok' : 'token-mismatch');

      if (mode === 'subscribe' && token === env.VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      console.log('[inbound:bad-json]');
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    console.log('[inbound]', JSON.stringify(body));

    const msg = parseInbound(body);
    if (msg) {
      ctx.waitUntil(
        (async () => {
          if (await alreadyHandled(env, msg.messageId)) {
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
} satisfies ExportedHandler<Env>;
