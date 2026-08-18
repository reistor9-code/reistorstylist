/**
 * Worker bindings, secrets and vars.
 *
 * Secrets are set with `wrangler secret put <NAME>` and never appear in
 * wrangler.toml. Vars are plain config and live in wrangler.toml.
 */
export interface Env {
  /* ---- bindings ---- */

  /** Per-shopper conversation state, keyed by wa_id. */
  STATE: KVNamespace;

  /* ---- secrets ---- */

  /** Meta system-user or temporary access token. */
  WHATSAPP_TOKEN: string;
  /** WhatsApp Business phone number id — not the phone number itself. */
  PHONE_NUMBER_ID: string;
  /** Any string; must match what is pasted into Meta's webhook config. */
  VERIFY_TOKEN: string;
  /**
   * Meta App Secret. Used to verify X-Hub-Signature-256 on every inbound
   * webhook. Without it the endpoint accepts forged messages from anyone who
   * finds the URL, and `from` is attacker-controlled — so they can make this
   * Worker send WhatsApp messages to arbitrary numbers on your bill.
   */
  APP_SECRET?: string;
  /** Optional — the bot degrades to deterministic ranking without it. */
  ANTHROPIC_API_KEY?: string;
  /** PKCS#8 RSA private key, PEM, for WhatsApp Flow data exchange. */
  FLOW_PRIVATE_KEY?: string;
  /** Passphrase, if the private key above is encrypted. */
  FLOW_KEY_PASSPHRASE?: string;
  /** Shopify Admin API access token. */
  SHOPIFY_TOKEN?: string;

  /* ---- vars ---- */

  ANTHROPIC_MODEL?: string;
  GRAPH_API_VERSION?: string;
  TEMPLATE_LANGUAGE?: string;

  /**
   * This Worker's own public origin, e.g.
   * https://reistor-ai-stylist-azmeer.<subdomain>.workers.dev
   *
   * Product photographs ship as Worker static assets under /looks/, and Meta
   * fetches every image server-side — a relative path or a localhost URL fails
   * the send. Set this after the first deploy, when the hostname is known.
   */
  PUBLIC_BASE_URL?: string;

  /**
   * How the occasion and category pickers are sent:
   *
   *   'list'        interactive list only — free, instant, no approval, but a
   *                 list row has no image field, so it is text only
   *   'image+list'  a cover photograph, then the list underneath — still
   *                 free-form and approval-free, and the shopper sees pictures
   *   'carousel'    media card carousel template — an image on every card, but
   *                 it needs Meta approval and is billed per delivered message
   *
   * Carousel falls back to image+list, which falls back to list.
   */
  PICKER_STYLE?: string;

  OCCASION_TEMPLATE?: string;
  CATEGORY_TEMPLATE?: string;

  /**
   * How a round of looks is sent:
   *   'list'     multi-product message — free, no approval, needs catalog
   *   'carousel' product card carousel template — approval + billed per send
   *   'image'    plain image messages — no catalog needed at all
   * Carousel falls back to list, and list falls back to image, so the flow
   * always completes whatever is or is not set up yet.
   */
  ROUND_STYLE?: string;

  /** Meta Commerce Catalog id. Required by every product-backed object. */
  CATALOG_ID?: string;
  /** Published Flow id for the size chooser. */
  SIZE_FLOW_ID?: string;

  PRODUCT_CAROUSEL_TEMPLATE?: string;
  ORDER_CONFIRMATION_TEMPLATE?: string;
  NUDGE_COUPON_TEMPLATE?: string;
  NUDGE_CALLBACK_TEMPLATE?: string;

  /** myshop.myshopify.com — the admin host, not the storefront domain. */
  SHOPIFY_SHOP?: string;
  SHOPIFY_API_VERSION?: string;
}
