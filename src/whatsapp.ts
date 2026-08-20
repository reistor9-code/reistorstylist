import type { Env } from './types';
import { getAnalytics } from './analytics/log';

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

/**
 * A human-readable line for what we just sent.
 *
 * Without this the transcript shows the shopper's half of the conversation
 * and blank placeholders for ours, which answers none of the questions the
 * tab exists for. The text is dug out of whichever shape the message took —
 * plain text, an interactive body, or a template name.
 */
function readableBody(payload: Record<string, unknown>): string {
  const text = payload.text as { body?: string } | undefined;
  if (text?.body) return text.body;

  const interactive = payload.interactive as
    | { type?: string; body?: { text?: string }; action?: unknown }
    | undefined;
  if (interactive?.body?.text) return interactive.body.text;
  if (interactive?.type) return `[${interactive.type}]`;

  const template = payload.template as { name?: string } | undefined;
  if (template?.name) return `[template: ${template.name}]`;

  const image = payload.image as { caption?: string } | undefined;
  if (image?.caption) return image.caption;

  return `[${String(payload.type ?? 'message')}]`;
}

export async function graph(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  const version = env.GRAPH_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`;
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload };

  console.log('[outbound]', JSON.stringify(body));

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
     * Recorded here rather than at each call site, because this is the single
     * place every outbound message passes through — a send logged anywhere
     * else would miss whichever helper was added next.
     *
     * The wamid Meta returns is what the delivery receipt arrives under later,
     * so writing it now is what lets sent, delivered and read be joined at all.
     */
    let wamid: string | undefined;
    try {
      wamid = JSON.parse(text)?.messages?.[0]?.id;
    } catch {
      // A non-JSON body means the send failed; the status below still records it.
    }

    await getAnalytics(env).outbound({
      meta: { body: readableBody(payload) },
      waId: typeof payload.to === 'string' ? payload.to : undefined,
      wamid,
      messageType: typeof payload.type === 'string' ? payload.type : undefined,
      templateName:
        typeof payload.template === 'object' && payload.template
          ? String((payload.template as Record<string, unknown>).name ?? '')
          : undefined,
      ok: res.ok,
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

/**
 * A breath between two sends to the same person.
 *
 * Awaiting graph() only confirms Meta ACCEPTED a message, not that it
 * delivered it — two sends inside the same second can arrive either way
 * round, which is how a follow-up menu appeared above the card it belongs
 * under. A short gap is the only ordering guarantee available.
 *
 * Also keeps us clear of error 131056, which is thrown for more than one
 * message per six seconds to the same recipient.
 */
export const pause = (ms = 1200) => new Promise((resolve) => setTimeout(resolve, ms));

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
