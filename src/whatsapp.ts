import type { Env } from './types.js';
import { getAnalytics } from './analytics/log.js';

/* ------------------------------------------------------------------ *
 * WhatsApp send helpers
 * ------------------------------------------------------------------ */

export const LIMITS = {
  rowTitle: 24,
  rowDescription: 72,
  buttonTitle: 20,
  listButton: 20,
  body: 1024,
  caption: 1024,
  ctaDisplayText: 20,
  maxRows: 10,
  maxButtons: 3,
} as const;

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/* ------------------------------------------------------------------ *
 * Send context
 *
 * graph() is the single funnel every outbound message passes through, which
 * makes it the one place worth logging from. It does not, however, know which
 * funnel step it is serving — that lives up in the router.
 *
 * Rather than thread a context argument through every send helper, route()
 * parks the current state here keyed by recipient. Keying by wa_id is what
 * makes it safe: a Worker isolate can serve several requests at once, but two
 * concurrent requests are for different shoppers, and a single shopper's
 * messages are processed serially inside one route() call. The entry is
 * removed in route()'s finally block, so nothing leaks between requests.
 * ------------------------------------------------------------------ */

interface SendContext {
  sessionId?: string;
  /**
   * The live state object, not a copied step string. `state.step` changes
   * several times while one inbound message is handled, so holding a
   * reference means each send is tagged with the step it actually belongs to.
   */
  state?: { step: string };
}

const sendContext = new Map<string, SendContext>();

export function setSendContext(waId: string, ctx: SendContext): void {
  sendContext.set(waId, ctx);
}

export function clearSendContext(waId: string): void {
  sendContext.delete(waId);
}

/** Best-effort description of an outbound payload, for the event log. */
function describeOutbound(payload: Record<string, unknown>): {
  messageType: string;
  productIds?: string[];
  templateName?: string;
} {
  const type = String(payload.type ?? 'unknown');

  if (type === 'template') {
    const template = payload.template as { name?: string } | undefined;
    return { messageType: 'template', templateName: template?.name };
  }

  if (type === 'interactive') {
    const interactive = payload.interactive as any;
    const kind = String(interactive?.type ?? 'interactive');

    if (kind === 'carousel') {
      const cards = Array.isArray(interactive?.action?.cards) ? interactive.action.cards : [];
      return {
        messageType: 'carousel',
        productIds: cards
          .map((c: any) => c?.action?.product_retailer_id)
          .filter((id: unknown): id is string => typeof id === 'string'),
      };
    }
    if (kind === 'product') {
      const id = interactive?.action?.product_retailer_id;
      return { messageType: 'product', productIds: typeof id === 'string' ? [id] : undefined };
    }
    return { messageType: kind };
  }

  return { messageType: type };
}

export async function graph(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  const version = env.GRAPH_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`;
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload };

  console.log('[outbound]', JSON.stringify(body));

  const to = typeof payload.to === 'string' ? payload.to : undefined;
  const ctx = to ? sendContext.get(to) : undefined;
  const described = describeOutbound(payload);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[outbound:response]', res.status, text);

    /*
     * The wamid is captured because every later delivery receipt keys off it.
     * Without this row a status webhook can still be counted, but it cannot be
     * attributed to a funnel step or a product.
     */
    let wamid: string | undefined;
    try {
      wamid = JSON.parse(text)?.messages?.[0]?.id;
    } catch {
      /* Meta returns JSON; a non-JSON body means an edge failure. */
    }

    await getAnalytics(env).outbound({
      waId: to,
      wamid,
      sessionId: ctx?.sessionId,
      flowStep: ctx?.state?.step,
      ok: res.ok,
      ...described,
    });

    return res.ok;
  } catch (err) {
    console.log('[outbound:error]', String(err));
    return false;
  }
}

export async function sendText(env: Env, to: string, text: string): Promise<boolean> {
  return graph(env, {
    to,
    type: 'text',
    text: { preview_url: false, body: clip(text, LIMITS.body) },
  });
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export async function sendList(
  env: Env,
  to: string,
  opts: { header?: string; body: string; footer?: string; button: string; rows: ListRow[] },
): Promise<boolean> {
  const rows = opts.rows.slice(0, LIMITS.maxRows).map((r) => ({
    id: clip(r.id, 200),
    title: clip(r.title, LIMITS.rowTitle),
    ...(r.description ? { description: clip(r.description, LIMITS.rowDescription) } : {}),
  }));

  return graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(opts.header ? { header: { type: 'text', text: clip(opts.header, 60) } } : {}),
      body: { text: clip(opts.body, LIMITS.body) },
      ...(opts.footer ? { footer: { text: clip(opts.footer, 60) } } : {}),
      action: { button: clip(opts.button, LIMITS.listButton), sections: [{ title: 'Options', rows }] },
    },
  });
}

export async function sendButtons(
  env: Env,
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<boolean> {
  return graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, LIMITS.body) },
      action: {
        buttons: buttons.slice(0, LIMITS.maxButtons).map((b) => ({
          type: 'reply',
          reply: { id: clip(b.id, 200), title: clip(b.title, LIMITS.buttonTitle) },
        })),
      },
    },
  });
}

/**
 * Sends recommended looks as an interactive product carousel.
 *
 * Each card is a catalog item, so tapping one opens WhatsApp's own product
 * page — images, price, description, Add to cart — rendered by Meta from the
 * catalog rather than built here. Unlike the occasion/category pickers this is
 * a free-form interactive message: no template, no approval, and unbilled
 * inside the 24-hour window.
 *
 * Meta requires 2–10 cards and rejects a header, footer or buttons. Product
 * ids double as catalog `retailer_id`s — see createCatalogItems().
 *
 * Returns false when the catalog is unset, there are too few cards, or Meta
 * rejects the send, so the caller can fall back to plain images.
 */
export async function sendProductCarousel(
  env: Env,
  to: string,
  bodyText: string,
  retailerIds: string[],
): Promise<boolean> {
  if (!env.CATALOG_ID || retailerIds.length < 2) return false;

  return graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'carousel',
      body: { text: clip(bodyText, LIMITS.body) },
      action: {
        cards: retailerIds.slice(0, 10).map((retailerId, index) => ({
          card_index: index,
          type: 'product',
          action: { product_retailer_id: retailerId, catalog_id: env.CATALOG_ID },
        })),
      },
    },
  });
}

/**
 * Single product message — the same WhatsApp PDP as a carousel card, for when
 * there is only one look to show. A carousel needs at least two cards, so
 * without this a one-product result would have no product page at all.
 */
export async function sendSingleProduct(
  env: Env,
  to: string,
  bodyText: string,
  retailerId: string,
): Promise<boolean> {
  if (!env.CATALOG_ID) return false;

  return graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'product',
      body: { text: clip(bodyText, LIMITS.body) },
      action: { catalog_id: env.CATALOG_ID, product_retailer_id: retailerId },
    },
  });
}

/**
 * Opens the business's full Meta catalog in WhatsApp.
 *
 * `thumbnail_product_retailer_id` is mandatory — it only picks the cover
 * image, but the send is rejected without it.
 */
export async function sendCatalogMessage(
  env: Env,
  to: string,
  body: string,
  thumbnailRetailerId: string,
): Promise<boolean> {
  if (!env.CATALOG_ID) return false;
  return graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: clip(body, LIMITS.body) },
      action: {
        name: 'catalog_message',
        parameters: { thumbnail_product_retailer_id: thumbnailRetailerId },
      },
    },
  });
}

/** Falls back to a text message if Meta cannot fetch the image URL. */
export async function sendImage(env: Env, to: string, imageUrl: string, caption: string): Promise<boolean> {
  const ok = await graph(env, {
    to,
    type: 'image',
    image: { link: imageUrl, caption: clip(caption, LIMITS.caption) },
  });
  if (ok) return true;
  console.log('[outbound:image-fallback]', imageUrl);
  return sendText(env, to, `${caption}\n${imageUrl}`);
}

export interface CarouselCard {
  /** Public https image for the card header. */
  imageUrl: string;
  /** Values for the card body's {{n}} variables, in order. */
  bodyParams: string[];
  /** Quick-reply payload — routed exactly like a list row id. */
  payload: string;
}

/**
 * Sends an approved carousel template. Card count and card body structure are
 * fixed at template-approval time, so `cards` must match the approved template
 * one for one. Returns false if Meta rejects it (template paused on quality,
 * user opted out of marketing, …) so callers can prompt for a typed answer.
 */
export async function sendCarouselTemplate(
  env: Env,
  to: string,
  templateName: string,
  cards: CarouselCard[],
): Promise<boolean> {
  return graph(env, {
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: env.TEMPLATE_LANGUAGE || 'en_US' },
      components: [
        {
          type: 'carousel',
          cards: cards.map((card, cardIndex) => ({
            card_index: cardIndex,
            components: [
              {
                type: 'header',
                parameters: [{ type: 'image', image: { link: card.imageUrl } }],
              },
              ...(card.bodyParams.length
                ? [
                    {
                      type: 'body',
                      parameters: card.bodyParams.map((text) => ({ type: 'text', text })),
                    },
                  ]
                : []),
              {
                type: 'button',
                sub_type: 'quick_reply',
                // Index of the button within this card, not the card index.
                index: '0',
                parameters: [{ type: 'payload', payload: card.payload }],
              },
            ],
          })),
        },
      ],
    },
  });
}

export async function sendCtaUrl(
  env: Env,
  to: string,
  body: string,
  displayText: string,
  url: string,
): Promise<boolean> {
  return graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: clip(body, LIMITS.body) },
      action: {
        name: 'cta_url',
        parameters: { display_text: clip(displayText, LIMITS.ctaDisplayText), url },
      },
    },
  });
}

/** Thin Graph wrapper that never throws, so each step can be reported. */
export async function graphCall(
  env: Env,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const version = env.GRAPH_API_VERSION || 'v21.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/**
 * Uploads every in-stock product as a catalog item.
 *
 * `price` goes in minor units (paise) alongside an explicit currency, which is
 * what the batch endpoint expects. `availability` is derived from real stock so
 * a sold-out piece cannot be added to a cart.
 */
