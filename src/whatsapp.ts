/**
 * Every WhatsApp object this bot can send.
 *
 * Each helper says in its doc comment which window it is valid in, because that
 * is the thing that gets a business restricted when it goes wrong:
 *
 *   free-form   only inside the live 24h service window (or the 72h free entry
 *               window opened by a Click-to-WhatsApp ad). Not billed.
 *   template    approved template, sendable at any time. Billed per delivery.
 *
 * Objects that read from the Commerce Catalog (single product, product list,
 * product carousel) additionally need a catalog connected to the WABA and the
 * items live in it, keyed by `retailer_id`.
 */

import type { Env } from './env';

/* ------------------------------------------------------------------ *
 * Limits, straight from the Cloud API reference
 * ------------------------------------------------------------------ */

export const LIMITS = {
  rowTitle: 24,
  rowDescription: 72,
  buttonTitle: 20,
  listButton: 20,
  header: 60,
  footer: 60,
  body: 1024,
  caption: 1024,
  ctaDisplayText: 20,
  /** Rows across all sections of one list. */
  maxRows: 10,
  maxButtons: 3,
  /** Cards an approved product carousel template may carry. */
  maxCarouselCards: 10,
  /** Items in one multi-product message, across all sections. */
  maxProductItems: 30,
  maxProductSections: 10,
} as const;

export function clip(text: string, max: number): string {
  const t = String(text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export interface SendResult {
  ok: boolean;
  /** Message id Meta assigned. Persist it — status webhooks key off this. */
  wamid?: string;
  status: number;
  error?: { code?: number; message?: string; details?: string };
}

/**
 * One POST to /messages. Returns the wamid rather than a bare boolean, because
 * the analytics store needs it to thread delivery receipts back to the message.
 */
export async function send(env: Env, payload: Record<string, unknown>): Promise<SendResult> {
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

    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Meta always returns JSON; a non-JSON body means an edge failure. */
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: {
          code: parsed?.error?.code,
          message: parsed?.error?.message,
          details: parsed?.error?.error_data?.details,
        },
      };
    }

    return { ok: true, status: res.status, wamid: parsed?.messages?.[0]?.id };
  } catch (err) {
    console.log('[outbound:error]', String(err));
    return { ok: false, status: 0, error: { message: String(err) } };
  }
}

/* ------------------------------------------------------------------ *
 * Text and media — free-form
 * ------------------------------------------------------------------ */

/** free-form */
export function sendText(env: Env, to: string, text: string, previewUrl = false) {
  return send(env, {
    to,
    type: 'text',
    text: { preview_url: previewUrl, body: clip(text, LIMITS.body) },
  });
}

/**
 * free-form
 *
 * Meta fetches `imageUrl` server-side, so it has to be a public https URL. If
 * that fetch fails the whole message fails, so this falls back to text rather
 * than dropping the content silently.
 */
export async function sendImage(
  env: Env,
  to: string,
  imageUrl: string,
  caption: string,
): Promise<SendResult> {
  const res = await send(env, {
    to,
    type: 'image',
    image: { link: imageUrl, caption: clip(caption, LIMITS.caption) },
  });
  if (res.ok) return res;
  console.log('[outbound:image-fallback]', imageUrl);
  return sendText(env, to, `${caption}\n${imageUrl}`);
}

/* ------------------------------------------------------------------ *
 * Interactive — free-form, no approval, not billed
 * ------------------------------------------------------------------ */

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/**
 * free-form
 *
 * The occasion and category pickers. A list carries no images — which is
 * exactly why it needs no template and no review queue. Rows are capped at 10
 * across all sections.
 */
export function sendList(
  env: Env,
  to: string,
  opts: {
    header?: string;
    body: string;
    footer?: string;
    button: string;
    section?: string;
    rows: ListRow[];
  },
) {
  const rows = opts.rows.slice(0, LIMITS.maxRows).map((r) => ({
    id: clip(r.id, 200),
    title: clip(r.title, LIMITS.rowTitle),
    ...(r.description ? { description: clip(r.description, LIMITS.rowDescription) } : {}),
  }));

  return send(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(opts.header ? { header: { type: 'text', text: clip(opts.header, LIMITS.header) } } : {}),
      body: { text: clip(opts.body, LIMITS.body) },
      ...(opts.footer ? { footer: { text: clip(opts.footer, LIMITS.footer) } } : {}),
      action: {
        button: clip(opts.button, LIMITS.listButton),
        sections: [{ title: clip(opts.section || 'Options', LIMITS.rowTitle), rows }],
      },
    },
  });
}

/** free-form — three buttons maximum, hard limit. */
export function sendButtons(
  env: Env,
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
  opts: { header?: string; footer?: string } = {},
) {
  return send(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(opts.header ? { header: { type: 'text', text: clip(opts.header, LIMITS.header) } } : {}),
      body: { text: clip(body, LIMITS.body) },
      ...(opts.footer ? { footer: { text: clip(opts.footer, LIMITS.footer) } } : {}),
      action: {
        buttons: buttons.slice(0, LIMITS.maxButtons).map((b) => ({
          type: 'reply',
          reply: { id: clip(b.id, 200), title: clip(b.title, LIMITS.buttonTitle) },
        })),
      },
    },
  });
}

/** free-form — the only native way to reach a hosted checkout like GoKwik. */
export function sendCtaUrl(
  env: Env,
  to: string,
  body: string,
  displayText: string,
  url: string,
  opts: { header?: string; footer?: string } = {},
) {
  return send(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(opts.header ? { header: { type: 'text', text: clip(opts.header, LIMITS.header) } } : {}),
      body: { text: clip(body, LIMITS.body) },
      ...(opts.footer ? { footer: { text: clip(opts.footer, LIMITS.footer) } } : {}),
      action: {
        name: 'cta_url',
        parameters: { display_text: clip(displayText, LIMITS.ctaDisplayText), url },
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * Catalog-backed — free-form, but the catalog must exist
 * ------------------------------------------------------------------ */

/**
 * free-form · needs catalog
 *
 * WhatsApp's own product view. Everything inside it — media strip, title,
 * price, description, add-to-cart — is rendered by WhatsApp from the catalog
 * item. We supply only the retailer id and an optional line of body copy.
 *
 * A product message carries no buttons of its own; anything you want the
 * shopper to press goes in a separate quick-reply message underneath.
 */
export function sendProduct(
  env: Env,
  to: string,
  retailerId: string,
  opts: { body?: string; footer?: string } = {},
) {
  if (!env.CATALOG_ID) {
    console.log('[catalog:missing] single-product message needs CATALOG_ID');
    return Promise.resolve<SendResult>({
      ok: false,
      status: 0,
      error: { message: 'CATALOG_ID is not configured' },
    });
  }

  return send(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'product',
      ...(opts.body ? { body: { text: clip(opts.body, LIMITS.body) } } : {}),
      ...(opts.footer ? { footer: { text: clip(opts.footer, LIMITS.footer) } } : {}),
      action: { catalog_id: env.CATALOG_ID, product_retailer_id: retailerId },
    },
  });
}

/**
 * free-form · needs catalog
 *
 * Up to 30 catalog items in one message, grouped into sections. This is the
 * approval-free stand-in for a product carousel: it renders as a product list
 * rather than a horizontal swipe, but it is a session message, so there is no
 * template, no review queue and no per-message charge inside the window.
 *
 * A header is mandatory on this object, unlike the other interactive types.
 */
export function sendProductList(
  env: Env,
  to: string,
  opts: {
    header: string;
    body: string;
    footer?: string;
    sections: { title: string; retailerIds: string[] }[];
  },
) {
  if (!env.CATALOG_ID) {
    console.log('[catalog:missing] multi-product message needs CATALOG_ID');
    return Promise.resolve<SendResult>({
      ok: false,
      status: 0,
      error: { message: 'CATALOG_ID is not configured' },
    });
  }

  // The 30-item cap is across every section, not per section.
  let budget = LIMITS.maxProductItems;
  const sections = [];
  for (const s of opts.sections.slice(0, LIMITS.maxProductSections)) {
    if (budget <= 0) break;
    const ids = s.retailerIds.slice(0, budget);
    budget -= ids.length;
    if (!ids.length) continue;
    sections.push({
      title: clip(s.title, LIMITS.rowTitle),
      product_items: ids.map((id) => ({ product_retailer_id: id })),
    });
  }

  return send(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: clip(opts.header, LIMITS.header) },
      body: { text: clip(opts.body, LIMITS.body) },
      ...(opts.footer ? { footer: { text: clip(opts.footer, LIMITS.footer) } } : {}),
      action: { catalog_id: env.CATALOG_ID, sections },
    },
  });
}

/**
 * TEMPLATE · approval required · billed · needs catalog
 *
 * The horizontally swipeable product carousel. Two things worth holding onto,
 * both confirmed against Meta's template reference:
 *
 *   - The template is created with two product cards, but an approved template
 *     may send up to ten. Card count is NOT frozen at approval, so a category
 *     whose product count moves day to day is fine.
 *   - Cards take no custom buttons. Every card must carry the same components,
 *     and the only button types the format allows are a native View button or a
 *     URL button, both declared on the template rather than per send.
 *
 * Returns ok:false when Meta rejects it — unapproved, paused on quality, or the
 * shopper opted out of marketing — so the caller can fall back to a product
 * list and never strand somebody mid-flow.
 */
export function sendProductCarousel(
  env: Env,
  to: string,
  retailerIds: string[],
  bodyParams: string[] = [],
) {
  if (!env.CATALOG_ID) {
    console.log('[catalog:missing] product carousel needs CATALOG_ID');
    return Promise.resolve<SendResult>({
      ok: false,
      status: 0,
      error: { message: 'CATALOG_ID is not configured' },
    });
  }

  const ids = retailerIds.slice(0, LIMITS.maxCarouselCards);

  return send(env, {
    to,
    type: 'template',
    template: {
      name: env.PRODUCT_CAROUSEL_TEMPLATE || 'product_round',
      language: { code: env.TEMPLATE_LANGUAGE || 'en_US' },
      components: [
        ...(bodyParams.length
          ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
          : []),
        {
          type: 'carousel',
          cards: ids.map((retailerId, cardIndex) => ({
            card_index: cardIndex,
            components: [
              {
                type: 'header',
                parameters: [
                  {
                    type: 'product',
                    product: { product_retailer_id: retailerId, catalog_id: env.CATALOG_ID },
                  },
                ],
              },
            ],
          })),
        },
      ],
    },
  });
}

export interface MediaCard {
  /** Public https image for the card header. Meta fetches it server-side. */
  imageUrl: string;
  /** Values for the card body's {{n}} variables, in order. */
  bodyParams: string[];
  /** Quick-reply payload — routed exactly like a list row id. */
  payload: string;
}

/**
 * TEMPLATE · approval required · billed
 *
 * The occasion and category pickers as image cards. This is a MEDIA card
 * carousel, not a product card carousel — the images are ours rather than the
 * catalog's, so it needs no catalog at all, only template approval.
 *
 * Unlike the product carousel, the card COUNT here is fixed by the approved
 * template, since each card's image is supplied per send against a structure
 * frozen at approval. Card order must match the OCCASIONS / CATEGORIES arrays,
 * because cards are addressed by index.
 *
 * Returns ok:false when Meta rejects it — unapproved, paused on quality, or
 * the shopper opted out of marketing — so the caller falls back to a list and
 * nobody is stranded mid-flow.
 */
export function sendMediaCarousel(
  env: Env,
  to: string,
  templateName: string,
  cards: MediaCard[],
  bodyParams: string[] = [],
) {
  return send(env, {
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: env.TEMPLATE_LANGUAGE || 'en_US' },
      components: [
        ...(bodyParams.length
          ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
          : []),
        {
          type: 'carousel',
          cards: cards.slice(0, LIMITS.maxCarouselCards).map((card, cardIndex) => ({
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

/* ------------------------------------------------------------------ *
 * Flows — free-form, no template review
 * ------------------------------------------------------------------ */

/**
 * free-form
 *
 * Opens a Flow in its own sheet over the thread. A Flow needs to be published
 * in Flow Builder or via the Flows API, but it is NOT a message template — no
 * review queue, and it costs nothing inside the service window.
 *
 * `data_exchange` means WhatsApp calls our endpoint to fill the screen, which
 * is what makes live size and stock possible. `flowToken` is ours: it comes
 * back on every request and on the completion payload, so it is how the
 * submitted size is tied to the right shopper and the right SKU.
 */
export function sendFlow(
  env: Env,
  to: string,
  opts: {
    flowToken: string;
    cta: string;
    header?: string;
    body: string;
    footer?: string;
    /** First screen id when using `navigate` instead of `data_exchange`. */
    screen?: string;
    data?: Record<string, unknown>;
    mode?: 'data_exchange' | 'navigate';
  },
) {
  if (!env.SIZE_FLOW_ID) {
    console.log('[flow:missing] SIZE_FLOW_ID is not configured');
    return Promise.resolve<SendResult>({
      ok: false,
      status: 0,
      error: { message: 'SIZE_FLOW_ID is not configured' },
    });
  }

  const action = opts.mode || 'data_exchange';

  return send(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      ...(opts.header ? { header: { type: 'text', text: clip(opts.header, LIMITS.header) } } : {}),
      body: { text: clip(opts.body, LIMITS.body) },
      ...(opts.footer ? { footer: { text: clip(opts.footer, LIMITS.footer) } } : {}),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: opts.flowToken,
          flow_id: env.SIZE_FLOW_ID,
          flow_cta: clip(opts.cta, LIMITS.buttonTitle),
          flow_action: action,
          ...(action === 'navigate' && opts.screen
            ? { flow_action_payload: { screen: opts.screen, ...(opts.data ? { data: opts.data } : {}) } }
            : {}),
        },
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * Templates — approval required, billed, sendable outside the window
 * ------------------------------------------------------------------ */

/**
 * TEMPLATE · approval required · billed
 *
 * Used for the order confirmation (Utility) and the recovery nudges at 24h and
 * 48h (Marketing). Writing a coupon code into a free-form message after the
 * window has closed is one of the most common ways a business gets restricted —
 * once the window is shut, this is the only thing that sends.
 */
export function sendTemplate(
  env: Env,
  to: string,
  name: string,
  opts: {
    bodyParams?: string[];
    headerImageUrl?: string;
    headerVideoUrl?: string;
    /** Appended in order; index is positional within the template. */
    buttonUrlParams?: string[];
    language?: string;
  } = {},
) {
  const components: Record<string, unknown>[] = [];

  if (opts.headerVideoUrl) {
    components.push({
      type: 'header',
      parameters: [{ type: 'video', video: { link: opts.headerVideoUrl } }],
    });
  } else if (opts.headerImageUrl) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: opts.headerImageUrl } }],
    });
  }

  if (opts.bodyParams?.length) {
    components.push({
      type: 'body',
      parameters: opts.bodyParams.map((text) => ({ type: 'text', text })),
    });
  }

  opts.buttonUrlParams?.forEach((text, i) => {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(i),
      parameters: [{ type: 'text', text }],
    });
  });

  return send(env, {
    to,
    type: 'template',
    template: {
      name,
      language: { code: opts.language || env.TEMPLATE_LANGUAGE || 'en_US' },
      ...(components.length ? { components } : {}),
    },
  });
}

/* ------------------------------------------------------------------ *
 * Read receipts
 * ------------------------------------------------------------------ */

/** Marks the shopper's message read, so the bot reads as attentive rather than slow. */
export async function markRead(env: Env, messageId: string): Promise<void> {
  const version = env.GRAPH_API_VERSION || 'v21.0';
  try {
    await fetch(`https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    console.log('[read:error]', String(err));
  }
}
