/**
 * Shared type declarations. No runtime code, so every other module can
 * import from here without a cycle.
 */

/* ------------------------------------------------------------------ *
 * Env
 * ------------------------------------------------------------------ */

export interface Env {
  STATE: KVNamespace;
  WHATSAPP_TOKEN: string;
  PHONE_NUMBER_ID: string;
  VERIFY_TOKEN: string;
  /**
   * Meta app secret. Every inbound webhook is signed with it, and without
   * it the endpoint accepts anything anyone posts. See src/signature.ts.
   */
  APP_SECRET?: string;
  /**
   * Gates /admin/*. Separate from VERIFY_TOKEN because Meta holds that one
   * — anyone who can read the app's webhook config could otherwise run
   * catalog syncs and send test messages. Falls back to VERIFY_TOKEN when
   * unset, so nothing breaks before it is set.
   */
  ADMIN_TOKEN?: string;
  /* Razorpay — test-mode payment links. See src/razorpay.ts. */
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  /* Reserved for the GoKwik path in src/payments.ts, which is not wired up. */
  GOKWIK_WEBHOOK_SECRET?: string;
  /* Dashboard — see src/dashboard/. Supabase holds the analytics tables. */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  DASHBOARD_TOKEN?: string;
  /* Conversions API — credits a purchase back to the ad that caused it. */
  /** Needed by the nightly pull for template performance. */
  WABA_ID?: string;
  META_DATASET_ID?: string;
  META_CAPI_TOKEN?: string;
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
  /**
   * Which checkout Buy Now opens.
   *
   *   fastrr   — Shopify cart permalink; Shiprocket's Fastrr panel takes over
   *   gokwik   — the same permalink; GoKwik takes over instead
   *   razorpay — an in-chat payment link, which also creates the Shopify order
   *
   * fastrr and gokwik send an identical URL: which one answers is decided by
   * the app installed on reistor.in, not here. They are separate values only
   * so the logs and the confirmation route say which one is expected.
   */
  CHECKOUT_PROVIDER?: string;
  /**
   * Where the checkout link lands — "cart" (default) or "checkout".
   *
   * One-click apps replace the button on the cart page, so a link that jumps
   * straight to /checkout bypasses them. See cartCheckoutUrl().
   */
  CHECKOUT_LANDING?: string;
  /**
   * "on" serves the per-occasion category photography in
   * dashboard/public/categories; anything else falls back to the shared
   * images on CATEGORIES. See categoryImage().
   */
  /**
   * "on" points product carousel cards at a size variant so WhatsApp shows
   * its size selector. Off (default) uses the product-level id, which is
   * what Meta currently accepts. See primaryRetailerId().
   */
  /**
   * Host serving the picker artwork — the occasion and category cards.
   * Defaults to the Cloudflare Pages site; set it to the Linode's own
   * host to cut Pages out. See assetUrl().
   */
  ASSET_BASE?: string;
  CATALOG_VARIANTS?: string;
  CATEGORY_ARTWORK_ENABLED?: string;
  /**
   * The payment configuration name Meta generates in WhatsApp Manager →
   * Payment configurations → India, with Razorpay authorised. Required for
   * CHECKOUT_PROVIDER="whatsapp"; see src/inapp.ts.
   */
  WHATSAPP_PAYMENT_CONFIG?: string;
  /** Fastrr (Shiprocket Checkout) webhook signing secret. See src/fastrr.ts. */
  FASTRR_WEBHOOK_SECRET?: string;
  /**
   * "list" sends the occasion and category pickers as interactive lists
   * instead of carousel templates — free service messages, no approval and
   * no billing, at the cost of the photography. Anything else uses the
   * templates, with a list as the fallback when a send is rejected.
   */
  /**
   * "on" (default) asks for a delivery address with WhatsApp's India
   * address form before opening checkout, so the Shopify order arrives
   * fulfillable. See src/address.ts.
   */
  ADDRESS_CAPTURE?: string;
  /**
   * "on" (default) offers a discount code before checkout, validated
   * against Shopify. Needs read_discounts on the Shopify app; without it
   * every code is refused. See src/coupons.ts.
   */
  COUPONS?: string;
  /**
   * "on" (default) offers cash on delivery beside online payment. A COD
   * order is created PENDING with no transaction — see src/cod.ts.
   */
  COD?: string;
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
  /** Waiting on the address form. Sits between sizing and checkout. */
  | 'address'
  /** Waiting on a typed discount code. */
  | 'coupon'
  | 'checkout'
  | 'done';

/**
 * One garment from a sent cart.
 *
 * A cart arrives with no sizes — WhatsApp's catalogue holds one entry per
 * product, not per variant — so each line is sized in turn before anything is
 * charged, and the whole basket is then bought once.
 */
export interface CartLine {
  productId: string;
  title: string;
  priceINR: number;
  size?: string;
}

export interface State {
  /** Groups every event in one journey. New on each restart of the flow. */
  sessionId?: string;
  step: Step;
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

