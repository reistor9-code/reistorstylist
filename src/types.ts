/**
 * Shared type declarations. No runtime code, so every other module can
 * import from here without a cycle.
 */

/* ------------------------------------------------------------------ *
 * Env
 * ------------------------------------------------------------------ */

export interface Env {
  /**
   * Optional now. When SUPABASE_URL and SUPABASE_SERVICE_KEY are set, state
   * moves to Postgres instead — which is what lets this identical code run on
   * a Linode box, where Workers KV does not exist.
   */
  STATE?: KVNamespace;
  WHATSAPP_TOKEN: string;
  PHONE_NUMBER_ID: string;
  VERIFY_TOKEN: string;
  /**
   * Meta App Secret, used to verify X-Hub-Signature-256 on every inbound
   * webhook. Without it the endpoint accepts forged payloads from anyone who
   * finds the URL, and `from` is attacker-controlled — so they can make this
   * Worker send WhatsApp messages to arbitrary numbers on your bill.
   */
  APP_SECRET?: string;
  /** WhatsApp Business Account id, for the nightly analytics pull. */
  WABA_ID?: string;
  /** Analytics + portable state. Unset means the bot runs, unmeasured. */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  /** Shared secret guarding /dashboard. */
  DASHBOARD_TOKEN?: string;
  GRAPH_API_VERSION?: string;
  /** Meta Commerce catalog connected to the WABA. Set it and the recommended
   *  looks render as a product carousel with a real WhatsApp PDP behind each
   *  card; leave it unset and they fall back to image messages. */
  CATALOG_ID?: string;
  /**
   * Shopify CDN transform appended to every catalog image, e.g.
   * "width=1080&height=1080&crop=top". Shopify resizes on demand, so this
   * controls how WhatsApp crops product cards without re-exporting anything.
   * Unset leaves images at their native size.
   */
  CATALOG_IMAGE_TRANSFORM?: string;
  /**
   * Shopify product metafield ("namespace.key") holding bespoke artwork for a
   * product — read by the PDP abandonment card in place of the catalogue shot.
   * Defaults to custom.kwikengage_product_image.
   */
  PDP_IMAGE_METAFIELD?: string;
  /*
   * Shopify Admin API for the India store, read-only. The domain, numeric shop
   * id and API version are plain vars in wrangler.toml; only the key and secret
   * are set with `wrangler secret put`. IND_ prefixed so a second market can be
   * added later without renaming anything.
   */
  IND_SHOPIFY_STORE?: string;
  IND_SHOPIFY_STORE_ID?: string;
  IND_SHOPIFY_API_VERSION?: string;
  IND_SHOPIFY_API_KEY?: string;
  IND_SHOPIFY_API_SECRET?: string;
  OCCASION_TEMPLATE?: string;
  CATEGORY_TEMPLATE?: string;
  TEMPLATE_LANGUAGE?: string;
}

export type Step =
  | 'welcome'
  | 'occasion'
  | 'category'
  | 'top3'
  | 'size'
  | 'checkout'
  | 'done';

export interface State {
  step: Step;
  /**
   * Analytics session this conversation belongs to. Minted on a fresh start
   * and carried until the shopper finishes or restarts, so every event this
   * turn produces threads into one journey row for the funnel.
   */
  sessionId?: string;
  occasion?: string;
  category?: string;
  /** Cursor into `rankedIds` for "Show More Looks". */
  offset: number;
  currentLookId?: string;
  shownLookIds: string[];
  /** Ranked candidates: the top 3 first, then the rest of the shelf. */
  rankedIds: string[];
  reasons: Record<string, string>;
  updatedAt: number;
}

