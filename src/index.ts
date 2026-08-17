/**
 * Reistor AI Stylist — WhatsApp Cloud API bot on a single Cloudflare Worker.
 *
 * GET  /webhook  Meta verification handshake
 * POST /webhook  inbound messages; always answers 200 immediately and does the
 *                work in ctx.waitUntil()
 *
 * State lives in Workers KV, one record per WhatsApp `wa_id`.
 */

import Anthropic from '@anthropic-ai/sdk';
import catalog from './products.json';

/* ------------------------------------------------------------------ *
 * Env
 * ------------------------------------------------------------------ */

export interface Env {
  STATE: KVNamespace;
  WHATSAPP_TOKEN: string;
  PHONE_NUMBER_ID: string;
  VERIFY_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GRAPH_API_VERSION?: string;
  /** Meta Commerce catalog connected to the WABA. Set it and the recommended
   *  looks render as a product carousel with a real WhatsApp PDP behind each
   *  card; leave it unset and they fall back to image messages. */
  CATALOG_ID?: string;
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

/* ------------------------------------------------------------------ *
 * Brand copy rules
 *
 * Applied to every string this Worker emits — static copy below, plus a
 * runtime check on anything the model writes (see `copyViolations`).
 * ------------------------------------------------------------------ */

const BANNED_WORDS = [
  'should',
  'need',
  'needs',
  'needed',
  'pulled-together',
  'effortless',
  'great',
  'best',
  'lovely choice',
  'fluid',
];

const BANNED_SENTENCE_STARTS = ['With', 'And', 'Here'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Fills `{name}` placeholders in a COPY string. Unknown keys become ''. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

/** Returns a list of brand-copy problems in `text`. Empty means clean. */
function copyViolations(text: string): string[] {
  const issues: string[] = [];

  for (const word of BANNED_WORDS) {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(word)}([^a-z]|$)`, 'i');
    if (re.test(text)) issues.push(`banned word "${word}"`);
  }

  for (const start of BANNED_SENTENCE_STARTS) {
    const re = new RegExp(`(^|[.!?]\\s+|\\n\\s*)${start}\\b`);
    if (re.test(text)) issues.push(`sentence starts with "${start}"`);
  }

  return issues;
}

const COPY_RULES_PROMPT = `Copy rules — these are absolute:
- Never use these words: should, need, pulled-together, effortless, great, best, lovely choice, fluid.
- Never begin a sentence with "With", "And", or "Here".
- Prices are Indian rupees written as ₹2,499.
- Womenswear voice: concise, specific, warm without gushing.
- Name the fabric when it is a natural one (hemp, linen, modal, Tencel).`;

const COPY = {
  welcome:
    "Hi there! 👋 I'm Reistor AI Stylist. I'll help you find the perfect outfit for any occasion. " +
    "Two questions and I'll put a look together for you ✨",
  // Both are the approved templates' body text — see createCarouselTemplates().
  occasionHeader: "What's the occasion?",
  categoryHeader: 'What type of clothing are you looking for?',
  moreLooksIntro: 'A few more, same brief:',
  // Shown when the exact occasion × category pair is empty and the edit was
  // widened instead of dead-ended — see widenCandidates(). {placeholders} are
  // filled by fill().
  widenedToOccasion: 'Nothing in {category} for {occasion} yet. Three picks for {phrase} instead:',
  widenedToCategory: 'Nothing styled for {occasion} yet. Three picks from {category} instead:',
  widenedToShelf: 'Nothing styled for that combination yet. Three from the current edit:',
  browseWidened: 'Nothing in {category} in stock. The full edit instead:',
  nothingInStock:
    'Everything is off the shelf right now. Talk to our stylist and I will flag what lands next.',
  noMoreLooks: 'That is the full edit for this brief. Browse the category or talk to our stylist.',
  whatNext: 'What next?',
  whichLook: 'Which look would you like to size?',
  sizeHeader: 'Choose your size',
  sizeBody: 'Only sizes in stock are listed.',
  checkoutBody: 'Your size is held in the bag. Tap below to check out on reistor.in.',
  afterCheckout: 'Tap below once you are back from checkout.',
  orderConfirmed: 'Order Confirmed! Thank you for shopping with Reistor.',
  browseIntro: 'The full category, newest first:',
  browseEnd: 'That is everything in stock for this category.',
  stylistConnecting: 'Connecting you with our stylist…',
  stylistMenu: 'Tell me what you are after, or pick a starting point:',
  stylistFallback:
    'Tell me a little more about the occasion and your usual fit, and I will pull two options.',
  goodbye: 'Thanks for shopping with Reistor. Message anytime for a new look ✨',
  tapAnOption: 'Tap an option below to keep going.',
  // Meta rejects a product message without a body — "(#131009) The parameter
  // interactive['body'] is required" — so the mandatory line confirms the two
  // choices back to the shopper rather than being filler. Names and prices are
  // already on the cards, drawn from the catalog.
  picksEcho: '{occasion} · {category}',
  // The carousel is the end of the scripted flow, so there is no menu to point
  // at — the cards and the product page behind them are the next step.
  tapACard: 'Tap a card above for the full look. Type "stylist" to ask me anything.',
  // Only reachable if the carousel template send is rejected. The typed-name
  // shortcut in handleText() picks these up, so the flow still moves.
  occasionTypePrompt:
    'Type the occasion you are dressing for — Work & Meeting, Vacation & Travel, Casual & Brunch, Dinner Date or Loungewear.',
  categoryTypePrompt:
    'Type a category to narrow the edit — Tops, Dresses, Bottoms, Jackets, Jumpsuits or Co-ord Sets.',
} as const;

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

export interface SizeStock {
  size: string;
  stock: number;
}

export interface Product {
  id: string;
  title: string;
  occasionTags: string[];
  category: string;
  fabric: string;
  attributes: string;
  priceINR: number;
  sizes: SizeStock[];
  imageUrl: string;
  productUrl: string;
}

/**
 * The only catalog seam in this Worker. Every read goes through here, so a
 * live Shopify Admin API query (products + variant inventory, mapped into
 * `Product`) can replace the body without touching any flow logic.
 */
/*
 * Shopify → Product mapping.
 *
 * Built from the live India store, so it accommodates what is actually there
 * rather than a tidy model: tags differ in case and spacing ("vacation" vs
 * "Vacation", "Everyday" vs "Every day"), `product_type` is sometimes blank or
 * the generic "Clothing", and variant titles put the size on either side of the
 * slash. Everything below is matched case-insensitively and by token.
 */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Shopify tag → occasion id. Conservative: an unmapped tag is simply ignored. */
const OCCASION_TAGS: Record<string, string> = {
  weartowork: 'work',
  'wear to work': 'work',
  vacation: 'vacation',
  'holiday collection': 'vacation',
  everyday: 'casual',
  'every day': 'casual',
  'easy everyday': 'casual',
  always: 'casual',
  datenight: 'dinner',
  'date night edit': 'dinner',
  'noir edits': 'dinner',
  'that cozy feeling': 'lounge',
  pajama: 'lounge',
};

/** product_type or tag → category id. */
const CATEGORY_TERMS: Record<string, string> = {
  top: 'tops',
  tops: 'tops',
  dress: 'dresses',
  dresses: 'dresses',
  pant: 'bottoms',
  pants: 'bottoms',
  bottoms: 'bottoms',
  jacket: 'jackets',
  jackets: 'jackets',
  jumpsuit: 'jumpsuits',
  jumpsuits: 'jumpsuits',
  romper: 'jumpsuits',
  'co-ord sets': 'coords',
  'co-ord set': 'coords',
  coords: 'coords',
};

const FABRIC_TERMS = [
  'hemp',
  'linen',
  'tencel',
  'modal',
  'organic cotton',
  'cotton',
  'bemberg',
] as const;

interface ShopifyVariant {
  sku: string;
  title: string;
  price: string;
  inventory_quantity: number;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html?: string;
  product_type: string;
  tags: string;
  status: string;
  variants?: ShopifyVariant[];
  images?: { src: string }[];
}

/** Variant titles are "Colour / M" or "M / Colour" — match the size by token. */
function variantSize(title: string): string | null {
  for (const part of title.split('/').map((p) => p.trim())) {
    const hit = SIZE_ORDER.find((s) => s.toLowerCase() === part.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function mapShopifyProduct(p: ShopifyProduct): Product | null {
  const tags = p.tags.split(',').map((t) => norm(t)).filter(Boolean);

  const occasionTags = [...new Set(tags.map((t) => OCCASION_TAGS[t]).filter(Boolean))];

  // product_type first; fall back to tags when it is blank or the catch-all
  // "Clothing", which covers a large slice of the store.
  const typeKey = norm(p.product_type);
  const category =
    CATEGORY_TERMS[typeKey] ?? tags.map((t) => CATEGORY_TERMS[t]).find(Boolean) ?? null;
  if (!category) return null;

  const sizes = (p.variants ?? [])
    .map((v) => ({ size: variantSize(v.title), stock: v.inventory_quantity }))
    .filter((s): s is SizeStock => Boolean(s.size));
  if (!sizes.length) return null;

  const fabric = FABRIC_TERMS.find((f) => tags.includes(f)) ?? 'natural fabric';
  const price = Number(p.variants?.[0]?.price ?? 0);

  return {
    // The Shopify product id doubles as the catalog retailer_id: stable, unique
    // and immune to SKU or handle edits.
    id: String(p.id),
    title: p.title,
    occasionTags,
    category,
    fabric,
    attributes: p.product_type || category,
    priceINR: Math.round(price),
    sizes,
    imageUrl: p.images?.[0]?.src ?? '',
    productUrl: `https://reistor.in/products/${p.handle}`,
  };
}

const SHOPIFY_CACHE_KEY = 'shopify:ind:products';

/**
 * The only catalog seam in this Worker. Reads the live Shopify store when it is
 * configured, falling back to the bundled mock otherwise.
 *
 * Results are cached in KV for ten minutes — getProducts() is called several
 * times per inbound message, and paging the whole store each time would add
 * seconds to every reply.
 */
export async function getProducts(env: Env): Promise<Product[]> {
  if (!env.IND_SHOPIFY_STORE || !env.IND_SHOPIFY_API_SECRET) return catalog as Product[];

  const cached = await env.STATE.get(SHOPIFY_CACHE_KEY);
  if (cached) return JSON.parse(cached) as Product[];

  const mapped: Product[] = [];
  let skipped = 0;
  let pageInfo: string | null = null;

  // Cap the paging: a runaway loop against a large store would blow the CPU
  // budget, and 1000 products is far more than the flow ever surfaces.
  for (let page = 0; page < 4; page++) {
    const query: string = pageInfo
      ? `products.json?limit=250&page_info=${pageInfo}`
      : 'products.json?limit=250&status=active';

    const res: Response = await shopifyFetch(env, query);
    if (!res.ok) {
      console.log('[shopify:list-error]', res.status, (await res.text()).slice(0, 200));
      break;
    }

    const body = (await res.json()) as { products?: ShopifyProduct[] };
    for (const p of body.products ?? []) {
      const product = mapShopifyProduct(p);
      if (product) mapped.push(product);
      else skipped++;
    }

    const link = res.headers.get('link') ?? '';
    const next = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
    if (!next) break;
    pageInfo = next[1];
  }

  if (!mapped.length) {
    console.log('[shopify:empty] falling back to the bundled catalog');
    return catalog as Product[];
  }

  console.log('[shopify:loaded]', `mapped=${mapped.length}`, `skipped=${skipped}`);
  await env.STATE.put(SHOPIFY_CACHE_KEY, JSON.stringify(mapped), { expirationTtl: 600 });
  return mapped;
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];

/*
 * `image` and `blurb` are only used by the carousel pickers — swap the images
 * for real artwork. Card order here MUST match the approved template's card
 * order, since cards are addressed by index.
 *
 * `blurb` is the card's static body copy. Card bodies carry no {{n}} variables
 * at all — Meta weighs a template's variable count against its main body
 * length, and a carousel's body is one short question, so even a single
 * per-card variable is rejected ("Parameters words ratio exceeds limit").
 */
const OCCASIONS = [
  {
    id: 'work',
    label: 'Work & Meeting',
    phrase: 'long meeting days',
    blurb: 'Tailored hemp and linen shirting, cut for long days of back-to-back meetings.',
    image: 'https://picsum.photos/seed/occ-work/1080/1080',
  },
  {
    id: 'vacation',
    label: 'Vacation & Travel',
    phrase: 'packing light',
    blurb: 'Breathable modal and Tencel pieces that pack flat and travel well.',
    image: 'https://picsum.photos/seed/occ-vacation/1080/1080',
  },
  {
    id: 'casual',
    label: 'Casual & Brunch',
    phrase: 'slow weekend plans',
    blurb: 'Relaxed shapes in hemp and cotton for slow weekend plans.',
    image: 'https://picsum.photos/seed/occ-casual/1080/1080',
  },
  {
    id: 'dinner',
    label: 'Dinner Date',
    phrase: 'evening plans',
    blurb: 'Bias-cut Tencel and linen with a quiet shine for evening plans.',
    image: 'https://picsum.photos/seed/occ-dinner/1080/1080',
  },
  {
    id: 'lounge',
    label: 'Loungewear',
    phrase: 'quiet days at home',
    blurb: 'Soft modal and cotton made for quiet days spent at home.',
    image: 'https://picsum.photos/seed/occ-lounge/1080/1080',
  },
] as const;

const CATEGORIES = [
  {
    id: 'tops',
    label: 'Tops',
    blurb: 'Shirts, blouses and tees in hemp, linen and modal for every day.',
    image: 'https://picsum.photos/seed/cat-tops/1080/1080',
  },
  {
    id: 'dresses',
    label: 'Dresses',
    blurb: 'Midi, slip and shirt dresses that carry from day into evening.',
    image: 'https://picsum.photos/seed/cat-dresses/1080/1080',
  },
  {
    id: 'bottoms',
    label: 'Bottoms',
    blurb: 'Trousers, shorts and skirts with a high rise and a roomy leg.',
    image: 'https://picsum.photos/seed/cat-bottoms/1080/1080',
  },
  {
    id: 'jackets',
    label: 'Jackets',
    blurb: 'Unlined hemp layers that sit over almost everything else.',
    image: 'https://picsum.photos/seed/cat-jackets/1080/1080',
  },
  {
    id: 'jumpsuits',
    label: 'Jumpsuits',
    blurb: 'One-piece dressing in hemp, linen and modal, belted or loose.',
    image: 'https://picsum.photos/seed/cat-jumpsuits/1080/1080',
  },
  {
    id: 'coords',
    label: 'Co-ord Sets',
    blurb: 'Matched tops and bottoms designed to be worn together.',
    image: 'https://picsum.photos/seed/cat-coords/1080/1080',
  },
] as const;

const occasionLabel = (id?: string) => OCCASIONS.find((o) => o.id === id)?.label ?? 'this occasion';
const occasionPhrase = (id?: string) => OCCASIONS.find((o) => o.id === id)?.phrase ?? 'the day ahead';
const categoryLabel = (id?: string) => CATEGORIES.find((c) => c.id === id)?.label ?? 'this category';

const isInStock = (p: Product) => p.sizes.some((s) => s.stock > 0);

const inStockSizes = (p: Product) =>
  p.sizes
    .filter((s) => s.stock > 0)
    .map((s) => s.size)
    .sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

function filterProducts(all: Product[], occasion?: string, category?: string): Product[] {
  return all.filter(
    (p) =>
      isInStock(p) &&
      (!occasion || p.occasionTags.includes(occasion)) &&
      (!category || p.category === category),
  );
}

/** Indian digit grouping without relying on the runtime's ICU data. */
function formatINR(amount: number): string {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return `₹${digits}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `₹${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** GoKwik / reistor.in checkout deep link for a specific size. */
function checkoutUrl(product: Product, size: string): string {
  const url = new URL(product.productUrl);
  url.searchParams.set('variant', size);
  url.searchParams.set('utm_source', 'whatsapp');
  url.searchParams.set('utm_medium', 'ai-stylist');
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * State (KV, one record per wa_id)
 * ------------------------------------------------------------------ */

type Step =
  | 'welcome'
  | 'occasion'
  | 'category'
  | 'top3'
  | 'pick_look'
  | 'size'
  | 'checkout'
  | 'browse'
  | 'stylist'
  | 'done';

interface State {
  step: Step;
  occasion?: string;
  category?: string;
  /** Cursor into `rankedIds` for "Show More Looks". */
  offset: number;
  mode: 'flow' | 'stylist';
  currentLookId?: string;
  shownLookIds: string[];
  /** Ranked candidates: the model's top 3 first, then the rest of the shelf. */
  rankedIds: string[];
  reasons: Record<string, string>;
  /** Separate cursor for "Browse Same Category" pagination. */
  browseOffset: number;
  stylistTurns: { role: 'user' | 'assistant'; content: string }[];
  updatedAt: number;
}

const STATE_TTL_SECONDS = 60 * 60 * 24 * 7;

function freshState(): State {
  return {
    step: 'welcome',
    offset: 0,
    mode: 'flow',
    shownLookIds: [],
    rankedIds: [],
    reasons: {},
    browseOffset: 0,
    stylistTurns: [],
    updatedAt: Date.now(),
  };
}

async function loadState(env: Env, waId: string): Promise<State> {
  const raw = await env.STATE.get(`state:${waId}`);
  if (!raw) return freshState();
  try {
    return { ...freshState(), ...(JSON.parse(raw) as Partial<State>) };
  } catch {
    return freshState();
  }
}

async function saveState(env: Env, waId: string, state: State): Promise<void> {
  state.updatedAt = Date.now();
  await env.STATE.put(`state:${waId}`, JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

async function clearState(env: Env, waId: string): Promise<void> {
  await env.STATE.delete(`state:${waId}`);
}

/* ------------------------------------------------------------------ *
 * WhatsApp send helpers
 * ------------------------------------------------------------------ */

const LIMITS = {
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

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

async function graph(env: Env, payload: Record<string, unknown>): Promise<boolean> {
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
    return res.ok;
  } catch (err) {
    console.log('[outbound:error]', String(err));
    return false;
  }
}

async function sendText(env: Env, to: string, text: string): Promise<boolean> {
  return graph(env, {
    to,
    type: 'text',
    text: { preview_url: false, body: clip(text, LIMITS.body) },
  });
}

interface ListRow {
  id: string;
  title: string;
  description?: string;
}

async function sendList(
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

async function sendButtons(
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
async function sendProductCarousel(
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
async function sendSingleProduct(
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

/** Falls back to a text message if Meta cannot fetch the image URL. */
async function sendImage(env: Env, to: string, imageUrl: string, caption: string): Promise<boolean> {
  const ok = await graph(env, {
    to,
    type: 'image',
    image: { link: imageUrl, caption: clip(caption, LIMITS.caption) },
  });
  if (ok) return true;
  console.log('[outbound:image-fallback]', imageUrl);
  return sendText(env, to, `${caption}\n${imageUrl}`);
}

interface CarouselCard {
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
async function sendCarouselTemplate(
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

async function sendCtaUrl(
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

/* ------------------------------------------------------------------ *
 * Anthropic — ranking + free-text stylist
 * ------------------------------------------------------------------ */

const DEFAULT_MODEL = 'claude-sonnet-5';

function anthropic(env: Env): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Deterministic, copy-rule-safe one-liner shown under every look. */
function lookReason(p: Product, occasion?: string): string {
  const parts = p.attributes.split(',').map((s) => s.trim());
  const detail = parts[1] ?? parts[0];
  return `${cap(p.fabric)}, ${detail} — cut for ${occasionPhrase(occasion)}.`;
}

/** Broadest size availability first, then price. */
function rankOrder(candidates: Product[]): Product[] {
  return [...candidates].sort((a, b) => {
    const diff = inStockSizes(b).length - inStockSizes(a).length;
    return diff !== 0 ? diff : a.priceINR - b.priceINR;
  });
}

interface Ranking {
  order: string[];
  reasons: Record<string, string>;
}

/**
 * Orders the candidates and writes a one-liner for each.
 *
 * Deliberately deterministic — no model call. The edit is curated by hand
 * upstream, so ranking stays predictable, instant and free, and every reason
 * is copy-rule-safe by construction rather than by after-the-fact checking.
 */
function rankLooks(candidates: Product[], occasion?: string): Ranking {
  const order = rankOrder(candidates).map((p) => p.id);
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const reasons: Record<string, string> = {};

  for (const id of order) {
    reasons[id] = lookReason(byId.get(id)!, occasion);
  }

  return { order, reasons };
}

function stylistSystem(all: Product[]): string {
  const shelf = all
    .filter(isInStock)
    .map(
      (p) =>
        `- ${p.title} (${formatINR(p.priceINR)}, ${p.fabric}, ${categoryLabel(p.category)}, for ${p.occasionTags
          .map((t) => occasionLabel(t))
          .join(' / ')}) — sizes ${inStockSizes(p).join(', ')}`,
    )
    .join('\n');

  return `You are the stylist for Reistor, a sustainable womenswear label in India. You are chatting with a shopper on WhatsApp.

Voice: concise, specific, warm without gushing. Two or three short sentences per reply, four at most. One question at a time.
Recommend only from the shelf below, and quote prices exactly as written. Name the fabric when you recommend something.
If someone asks about size or fit, ask about their usual fit before recommending, then be concrete about how the fabric behaves.
Never invent stock, discounts, delivery dates, or products.

${COPY_RULES_PROMPT}

In stock right now:
${shelf}`;
}

async function stylistReply(env: Env, state: State, all: Product[], userText: string): Promise<string> {
  const client = anthropic(env);
  if (!client) return COPY.stylistFallback;

  const history = state.stylistTurns.slice(-8).map((t) => ({ role: t.role, content: t.content }));
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userText }];

  const ask = async (extra?: string): Promise<string> => {
    const res = await client.messages.create(
      {
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 400,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: extra ? `${stylistSystem(all)}\n\n${extra}` : stylistSystem(all),
        messages,
      },
      { timeout: 15_000 },
    );
    console.log('[anthropic:stylist]', res.stop_reason, JSON.stringify(res.usage));
    if (res.stop_reason === 'refusal') return '';
    return textOf(res.content);
  };

  try {
    let reply = await ask();
    let issues = reply ? copyViolations(reply) : ['empty reply'];

    if (issues.length) {
      console.log('[copy:stylist-violation]', issues.join('; '));
      reply = await ask(
        `Your previous draft broke the copy rules (${issues.join('; ')}). Rewrite it so every rule holds.`,
      );
      issues = reply ? copyViolations(reply) : ['empty reply'];
    }

    if (!reply || issues.length) {
      console.log('[copy:stylist-fallback]', issues.join('; '));
      return COPY.stylistFallback;
    }
    return reply;
  } catch (err) {
    console.log('[anthropic:stylist-error]', String(err));
    return COPY.stylistFallback;
  }
}

/* ------------------------------------------------------------------ *
 * Flow steps
 * ------------------------------------------------------------------ */

async function askOccasion(env: Env, to: string, state: State): Promise<void> {
  state.step = 'occasion';
  state.mode = 'flow';

  const sent = await sendCarouselTemplate(
    env,
    to,
    env.OCCASION_TEMPLATE || 'occasion_picker',
    OCCASIONS.map((o) => ({
      imageUrl: o.image,
      // Card bodies are static — see carouselTemplate() for why.
      bodyParams: [],
      payload: `occ:${o.id}`,
    })),
  );
  if (sent) return;

  // Template paused on quality or the shopper opted out of marketing. Ask for
  // a typed answer rather than stranding them mid-flow.
  console.log('[carousel:rejected] occasion');
  await sendText(env, to, COPY.occasionTypePrompt);
}

async function askCategory(env: Env, to: string, state: State): Promise<void> {
  state.step = 'category';

  const sent = await sendCarouselTemplate(
    env,
    to,
    env.CATEGORY_TEMPLATE || 'category_picker',
    CATEGORIES.map((c) => ({
      imageUrl: c.image,
      bodyParams: [],
      payload: `cat:${c.id}`,
    })),
  );
  if (sent) return;

  console.log('[carousel:rejected] category');
  await sendText(env, to, COPY.categoryTypePrompt);
}

/**
 * Sends looks [offset, offset+3) as a product carousel, or as image messages
 * if that is unavailable. `lead` is prepended to the carousel body — it exists
 * so a widened brief can explain itself without costing a separate message.
 */
async function sendLooks(
  env: Env,
  to: string,
  state: State,
  all: Product[],
  lead?: string,
): Promise<number> {
  const byId = new Map(all.map((p) => [p.id, p]));
  const slice = state.rankedIds.slice(state.offset, state.offset + 3);
  const products = slice.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p));

  const caption = (product: Product, i: number) =>
    `Look ${state.offset + i + 1} — ${formatINR(product.priceINR)} — ${
      state.reasons[product.id] ?? lookReason(product, state.occasion)
    }`;

  /*
   * Preferred path: a product message, so every look has a real PDP behind it.
   * Carousel for two or more, single product message for exactly one — Meta
   * rejects a carousel with fewer than two cards.
   *
   * The body is mandatory — a bodyless send is refused with "(#131009) The
   * parameter interactive['body'] is required" — so rather than filler it
   * echoes the shopper's two choices back. A widened brief replaces it, since
   * explaining the swap matters more than confirming the pick.
   */
  const body =
    lead ??
    fill(COPY.picksEcho, {
      occasion: occasionLabel(state.occasion),
      category: categoryLabel(state.category),
    });

  const ids = products.map((p) => p.id);
  const sentAsProduct =
    products.length >= 2
      ? await sendProductCarousel(env, to, body, ids)
      : products.length === 1
        ? await sendSingleProduct(env, to, body, products[0].id)
        : false;

  if (!sentAsProduct) {
    if (env.CATALOG_ID && products.length) console.log('[product-message:rejected]', products.length);
    if (lead) await sendText(env, to, lead);
    for (let i = 0; i < products.length; i++) {
      await sendImage(env, to, products[i].imageUrl, caption(products[i], i));
    }
  }

  for (const product of products) {
    if (!state.shownLookIds.includes(product.id)) state.shownLookIds.push(product.id);
  }

  state.offset += slice.length;
  return slice.length;
}

/**
 * Picks the products to rank, widening the brief until something is found.
 *
 * The catalog does not cover all 30 occasion × category pairs — Loungewear is
 * empty in every category, Co-ord Sets in every occasion — so the exact pair
 * can legitimately come back empty. Rather than dead-ending the shopper, drop
 * one half of the brief, then the other, then fall back to the whole in-stock
 * shelf. The returned `intro` says which step was taken, so a widened edit is
 * never passed off as an exact match.
 *
 * Only returns empty if nothing in the catalog is in stock at all.
 */
function widenCandidates(
  all: Product[],
  occasion?: string,
  category?: string,
): { products: Product[]; intro?: string } {
  // An exact match needs no explanation, so it carries no intro at all.
  const exact = filterProducts(all, occasion, category);
  if (exact.length) return { products: exact };

  const byOccasion = filterProducts(all, occasion, undefined);
  if (byOccasion.length) {
    return {
      products: byOccasion,
      intro: fill(COPY.widenedToOccasion, {
        category: categoryLabel(category),
        occasion: occasionLabel(occasion),
        phrase: occasionPhrase(occasion),
      }),
    };
  }

  const byCategory = filterProducts(all, undefined, category);
  if (byCategory.length) {
    return {
      products: byCategory,
      intro: fill(COPY.widenedToCategory, {
        occasion: occasionLabel(occasion),
        category: categoryLabel(category),
      }),
    };
  }

  return { products: filterProducts(all), intro: COPY.widenedToShelf };
}

async function runBackend(env: Env, to: string, state: State): Promise<void> {
  const all = await getProducts(env);
  const { products: candidates, intro } = widenCandidates(all, state.occasion, state.category);

  if (candidates.length === 0) {
    // Only reachable when every product in the catalog is sold out.
    state.step = 'occasion';
    await sendButtons(env, to, COPY.nothingInStock, [
      { id: 'act:restart_occasion', title: 'Pick Occasion' },
      { id: 'act:stylist', title: 'Talk to Stylist' },
    ]);
    return;
  }

  const ranking = rankLooks(candidates, state.occasion);
  state.rankedIds = ranking.order;
  state.reasons = ranking.reasons;
  state.offset = 0;
  state.shownLookIds = [];
  state.currentLookId = undefined;

  // Products go out with no preamble. The one exception is a widened brief,
  // which rides inside the carousel body rather than as its own message —
  // silently swapping the category for a different one would be misleading.
  await sendLooks(env, to, state, all, intro);

  // Nothing follows the carousel by design — the cards are the next step, and
  // the PDP behind each one carries the detail that a menu used to.
  state.step = 'top3';
}

async function showMoreLooks(env: Env, to: string, state: State): Promise<void> {
  const all = await getProducts(env);

  if (state.offset >= state.rankedIds.length) {
    await sendButtons(env, to, COPY.noMoreLooks, [
      { id: 'act:browse', title: 'Browse Category' },
      { id: 'act:stylist', title: 'Talk to Stylist' },
      { id: 'act:restart_occasion', title: 'Start Over' },
    ]);
    return;
  }

  await sendText(env, to, COPY.moreLooksIntro);
  const sent = await sendLooks(env, to, state, all);

  if (sent === 0) {
    await sendText(env, to, COPY.noMoreLooks);
    return;
  }

  state.step = 'top3';
  await sendButtons(env, to, COPY.whatNext, [
    { id: 'act:size', title: 'View & Select Size' },
    { id: 'act:more', title: 'Show More Looks' },
  ]);
}

/** Reply buttons 1 / 2 / 3 over the three looks currently on screen. */
async function askWhichLook(env: Env, to: string, state: State): Promise<void> {
  const all = await getProducts(env);
  const byId = new Map(all.map((p) => [p.id, p]));
  const start = Math.max(0, state.offset - 3);
  const visible = state.rankedIds.slice(start, state.offset);

  if (visible.length === 0) {
    await askOccasion(env, to, state);
    return;
  }

  if (visible.length === 1) {
    state.currentLookId = visible[0];
    await askSize(env, to, state, byId.get(visible[0])!);
    return;
  }

  state.step = 'pick_look';
  await sendButtons(
    env,
    to,
    COPY.whichLook,
    visible.map((id, i) => ({ id: `look:${id}`, title: `${start + i + 1}` })),
  );
}

async function askSize(env: Env, to: string, state: State, product: Product): Promise<void> {
  const sizes = inStockSizes(product);

  if (sizes.length === 0) {
    await sendButtons(env, to, `${product.title} is out of stock in every size right now.`, [
      { id: 'act:more', title: 'Show More Looks' },
      { id: 'act:browse', title: 'Browse Category' },
    ]);
    return;
  }

  state.step = 'size';
  state.currentLookId = product.id;
  await sendList(env, to, {
    header: COPY.sizeHeader,
    body: `${product.title} — ${formatINR(product.priceINR)}. ${COPY.sizeBody}`,
    button: 'Pick size',
    rows: sizes.map((size) => ({
      id: `size:${product.id}:${size}`,
      title: size,
      description: cap(product.fabric),
    })),
  });
}

async function sendCheckout(
  env: Env,
  to: string,
  state: State,
  product: Product,
  size: string,
): Promise<void> {
  state.step = 'checkout';
  state.currentLookId = product.id;

  await sendCtaUrl(
    env,
    to,
    `${product.title}, size ${size} — ${formatINR(product.priceINR)}. ${COPY.checkoutBody}`,
    'Buy Now',
    checkoutUrl(product, size),
  );
  await sendButtons(env, to, COPY.afterCheckout, [{ id: 'act:paid', title: 'Order Placed' }]);
}

async function confirmOrder(env: Env, to: string, state: State): Promise<void> {
  state.step = 'done';
  await sendButtons(env, to, COPY.orderConfirmed, [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);
}

/** Paginates every in-stock product in the current category, 3 at a time. */
async function browseCategory(env: Env, to: string, state: State, reset: boolean): Promise<void> {
  const all = await getProducts(env);
  // Same reason as widenCandidates(): a category can be empty in stock, and an
  // empty browse page is a dead end. Widen to the whole shelf and say so.
  const inCategory = filterProducts(all, undefined, state.category);
  const widened = inCategory.length === 0;
  const items = widened ? filterProducts(all) : inCategory;

  if (reset) {
    state.browseOffset = 0;
    await sendText(
      env,
      to,
      widened
        ? fill(COPY.browseWidened, { category: categoryLabel(state.category) })
        : `${categoryLabel(state.category)} — ${COPY.browseIntro}`,
    );
  }

  const page = items.slice(state.browseOffset, state.browseOffset + 3);
  for (const product of page) {
    await sendImage(
      env,
      to,
      product.imageUrl,
      `${product.title} — ${formatINR(product.priceINR)} — ${cap(product.fabric)}, sizes ${inStockSizes(
        product,
      ).join(', ')}`,
    );
  }
  state.browseOffset += page.length;
  state.step = 'browse';

  const more = state.browseOffset < items.length;
  const buttons = [
    ...(more ? [{ id: 'act:load_more', title: 'Load More' }] : []),
    { id: 'act:pick_item', title: 'Pick an Item' },
    { id: 'act:back', title: 'Back to Looks' },
  ];
  await sendButtons(env, to, more ? COPY.whatNext : COPY.browseEnd, buttons);
}

async function askBrowsePick(env: Env, to: string, state: State): Promise<void> {
  const all = await getProducts(env);
  // Mirrors browseCategory(): the pick list has to offer whatever was actually
  // paged out, widened set included, or it comes back with zero rows.
  const inCategory = filterProducts(all, undefined, state.category);
  const shelf = inCategory.length ? inCategory : filterProducts(all);
  const shown = shelf.slice(0, state.browseOffset);
  const pool = shown.length ? shown : shelf;

  state.step = 'browse';
  await sendList(env, to, {
    header: 'Pick an item to size',
    body: `${categoryLabel(state.category)}, in stock.`,
    button: 'Pick item',
    rows: pool.slice(0, LIMITS.maxRows).map((p) => ({
      id: `look:${p.id}`,
      title: p.title,
      description: `${formatINR(p.priceINR)} · ${cap(p.fabric)}`,
    })),
  });
}

async function enterStylist(env: Env, to: string, state: State): Promise<void> {
  state.mode = 'stylist';
  state.step = 'stylist';
  state.stylistTurns = [];

  await sendText(env, to, COPY.stylistConnecting);
  await sendList(env, to, {
    body: COPY.stylistMenu,
    button: 'Choose',
    rows: [
      { id: 'sty:specific', title: 'Something specific', description: 'Describe what you are after' },
      { id: 'sty:fit', title: 'Size & fit help', description: 'Find your fit across fabrics' },
      { id: 'sty:style', title: 'A different style', description: 'Try another direction' },
      { id: 'act:back', title: 'Back to looks', description: 'Return to the curated edit' },
    ],
  });
}

async function handleStylistText(env: Env, to: string, state: State, text: string): Promise<void> {
  const all = await getProducts(env);
  const reply = await stylistReply(env, state, all, text);

  state.stylistTurns.push({ role: 'user', content: text });
  state.stylistTurns.push({ role: 'assistant', content: reply });
  state.stylistTurns = state.stylistTurns.slice(-12);

  await sendText(env, to, reply);
  await sendButtons(env, to, 'Anything else?', [{ id: 'act:back', title: 'Back to looks' }]);
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

interface Inbound {
  waId: string;
  messageId: string;
  text?: string;
  replyId?: string;
}

const STYLIST_OPENERS: Record<string, string> = {
  'sty:specific': 'I have something specific in mind.',
  'sty:fit': 'Help me with size and fit.',
  'sty:style': "I'm looking for a different style.",
};

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

  if (replyId.startsWith('sty:')) {
    state.mode = 'stylist';
    state.step = 'stylist';
    await handleStylistText(env, to, state, STYLIST_OPENERS[replyId] ?? 'Help me find something.');
    return;
  }

  switch (replyId) {
    case 'act:size':
      await askWhichLook(env, to, state);
      return;
    case 'act:more':
      await showMoreLooks(env, to, state);
      return;
    case 'act:browse':
      await browseCategory(env, to, state, true);
      return;
    case 'act:load_more':
      await browseCategory(env, to, state, false);
      return;
    case 'act:pick_item':
      await askBrowsePick(env, to, state);
      return;
    case 'act:stylist':
      await enterStylist(env, to, state);
      return;
    case 'act:back':
      state.mode = 'flow';
      state.stylistTurns = [];
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
/** Typed escape from stylist mode — the "Back to looks" button is the other one. */
const BREAKOUT = /^\s*(restart|menu|main menu|start over|back|back to looks)\s*[.!]?\s*$/i;

async function handleText(env: Env, to: string, state: State, text: string): Promise<void> {
  if (state.mode === 'stylist') {
    if (BREAKOUT.test(text)) {
      state.mode = 'flow';
      state.stylistTurns = [];
      if (state.rankedIds.length) {
        state.step = 'top3';
        await sendText(env, to, COPY.tapACard);
      } else {
        await askOccasion(env, to, state);
      }
      return;
    }
    await handleStylistText(env, to, state, text);
    return;
  }

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
   * With the "What next?" menu gone, these keywords are the only way left to
   * reach sizing, paging and the stylist by hand. Without them those steps are
   * reachable solely through the product page.
   */
  const keyword = text.trim().toLowerCase();
  if (state.rankedIds.length) {
    if (/^(size|sizes)\b/.test(keyword)) {
      await askWhichLook(env, to, state);
      return;
    }
    if (/^(more|next)\b/.test(keyword)) {
      await showMoreLooks(env, to, state);
      return;
    }
    if (/^browse\b/.test(keyword)) {
      await browseCategory(env, to, state, true);
      return;
    }
  }
  if (/^stylist\b/.test(keyword)) {
    await enterStylist(env, to, state);
    return;
  }

  switch (state.step) {
    case 'category':
      await sendText(env, to, COPY.tapAnOption);
      await askCategory(env, to, state);
      return;
    case 'top3':
    case 'pick_look':
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
 * Carousel template provisioning (one-off, via /admin/templates)
 * ------------------------------------------------------------------ */

/**
 * Meta's resumable upload: open a session against the APP, PUSH the bytes, get
 * back an opaque handle. Card headers need one of these as their approval-time
 * example image (real images are supplied per-card at send time).
 */
async function uploadExampleImage(env: Env, appId: string, imageUrl: string): Promise<string> {
  const version = env.GRAPH_API_VERSION || 'v21.0';

  const image = await fetch(imageUrl);
  if (!image.ok) throw new Error(`could not fetch example image ${imageUrl}: ${image.status}`);
  const bytes = new Uint8Array(await image.arrayBuffer());
  const mime = image.headers.get('content-type')?.split(';')[0] || 'image/jpeg';

  const startRes = await fetch(
    `https://graph.facebook.com/${version}/${appId}/uploads` +
      `?file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } },
  );
  const start = (await startRes.json()) as { id?: string };
  if (!start.id) throw new Error(`upload session failed: ${JSON.stringify(start)}`);

  // Note the OAuth (not Bearer) scheme — a quirk of the resumable upload API.
  const finishRes = await fetch(`https://graph.facebook.com/${version}/${start.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${env.WHATSAPP_TOKEN}`, file_offset: '0' },
    body: bytes,
  });
  const finish = (await finishRes.json()) as { h?: string };
  if (!finish.h) throw new Error(`upload failed: ${JSON.stringify(finish)}`);
  return finish.h;
}

/* ------------------------------------------------------------------ *
 * Commerce catalog provisioning (one-off, via /admin/catalog)
 *
 * The product carousel needs a catalog connected to the WABA, with one item
 * per product keyed by `retailer_id`. Product ids are reused verbatim as
 * retailer ids so the send path needs no extra mapping.
 * ------------------------------------------------------------------ */

/** Thin Graph wrapper that never throws, so each step can be reported. */
async function graphCall(
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
/** Every retailer_id currently in the catalog, paged out. */
async function existingRetailerIds(env: Env, catalogId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let path: string | null = `${catalogId}/products?fields=retailer_id&limit=250`;

  for (let page = 0; page < 10 && path; page++) {
    const res: { status: number; body: unknown } = await graphCall(env, path);
    const body = res.body as {
      data?: { retailer_id: string }[];
      paging?: { next?: string; cursors?: { after?: string } };
    };
    for (const item of body?.data ?? []) ids.add(item.retailer_id);

    const after = body?.paging?.cursors?.after;
    path = body?.paging?.next && after
      ? `${catalogId}/products?fields=retailer_id&limit=250&after=${after}`
      : null;
  }

  return ids;
}

/**
 * Reconciles the catalog with the live product set.
 *
 * CREATE for new items, UPDATE for ones already there, DELETE for anything left
 * over — which is what clears the original mock rows once real products arrive.
 * Out-of-stock products are uploaded too, marked `out of stock`: the flow hides
 * them, but a PDP opened from an older message still resolves.
 *
 * Batches are chunked because Meta rejects oversized request arrays.
 */
async function syncCatalogItems(
  env: Env,
  catalogId: string,
  products: Product[],
): Promise<Record<string, unknown>> {
  const existing = await existingRetailerIds(env, catalogId);
  const live = new Set(products.map((p) => p.id));

  const upserts = products.map((p) => ({
    method: existing.has(p.id) ? 'UPDATE' : 'CREATE',
    retailer_id: p.id,
    data: {
      name: p.title,
      description: `${cap(p.fabric)}, ${p.attributes}.`,
      url: p.productUrl,
      image_url: p.imageUrl,
      price: p.priceINR * 100,
      currency: 'INR',
      availability: isInStock(p) ? 'in stock' : 'out of stock',
      condition: 'new',
      brand: 'Reistor',
    },
  }));

  const stale = [...existing].filter((id) => !live.has(id));
  const requests = [
    ...upserts,
    ...stale.map((retailer_id) => ({ method: 'DELETE', retailer_id })),
  ];

  const batches: { status: number; body: unknown }[] = [];
  for (let i = 0; i < requests.length; i += 100) {
    batches.push(
      await graphCall(env, `${catalogId}/batch`, {
        method: 'POST',
        body: { requests: requests.slice(i, i + 100) },
      }),
    );
  }

  return {
    created: upserts.filter((r) => r.method === 'CREATE').length,
    updated: upserts.filter((r) => r.method === 'UPDATE').length,
    deleted: stale.length,
    batches: batches.map((b) => ({ status: b.status, body: b.body })),
  };
}

/**
 * Creates the catalog, connects it to the WABA and fills it, reporting each
 * step rather than stopping at the first failure — the token may carry
 * `whatsapp_business_management` but not `catalog_management`, and knowing
 * exactly which step failed is the point.
 *
 * Pass `catalog=<id>` to skip creation and use an existing catalog.
 */
async function provisionCatalog(
  env: Env,
  business: string,
  waba: string,
  existing?: string,
): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = {};
  let catalogId = existing;

  if (!catalogId) {
    const created = await graphCall(env, `${business}/owned_product_catalogs`, {
      method: 'POST',
      body: { name: 'Reistor Stylist Catalog', vertical: 'commerce' },
    });
    steps.create = created;
    catalogId = (created.body as { id?: string })?.id;
  } else {
    steps.create = 'skipped — existing catalog id supplied';
  }

  if (!catalogId) {
    steps.hint =
      'No catalog id. Creating one needs catalog_management/business_management on the token — ' +
      'create it in Commerce Manager instead and re-run with &catalog=<id>.';
    return steps;
  }

  steps.catalogId = catalogId;
  steps.connect = await graphCall(env, `${waba}/product_catalogs`, {
    method: 'POST',
    body: { catalog_id: catalogId },
  });

  const products = await getProducts(env);
  steps.items = await syncCatalogItems(env, catalogId, products);
  steps.itemCount = products.length;
  steps.next = `Set CATALOG_ID = "${catalogId}" in wrangler.toml, then redeploy.`;

  return steps;
}

/**
 * Read-only sample of the Shopify catalog.
 *
 * Returns the fields getProducts() will map — tags, product_type, variants and
 * inventory — so the occasion mapping is written against the real data rather
 * than assumed. Touches nothing: a GET with read_products.
 */
const SHOPIFY_TOKEN_KEY = 'shopify:ind:token';
/** Re-mint this far before the token actually dies, so no request races expiry. */
const SHOPIFY_TOKEN_MARGIN_S = 3 * 3600;

const shopifyHost = (env: Env) =>
  (env.IND_SHOPIFY_STORE ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/**
 * Returns a usable Shopify access token, minting a new one when needed.
 *
 * A key/secret pair mints a `client_credentials` token that Shopify expires in
 * about 24 hours. Rather than a scheduled refresh — which can still hand out a
 * dead token if the timing drifts — the token is cached in KV with a TTL three
 * hours short of its real expiry and re-minted on the first request after that.
 * Workers are stateless, so an in-process cache would not survive isolate
 * recycling; KV is the only durable option here.
 *
 * A permanent custom-app token (`shpat_…`) is used as-is and never minted.
 */
async function shopifyAccessToken(env: Env, force = false): Promise<string | null> {
  const secret = env.IND_SHOPIFY_API_SECRET ?? '';
  /*
   * Only `shpat_` (Admin API access token) and `shpca_` (legacy custom app)
   * authenticate API calls. `shpss_` sits next to them on the same Shopify
   * page but is the app's secret key — for OAuth and webhook signing — and
   * sending it yields "Invalid API key or access token".
   */
  if (/^shp(at|ca)_/.test(secret)) return secret;
  if (!env.IND_SHOPIFY_API_KEY || !secret) return null;

  if (!force) {
    const cached = await env.STATE.get(SHOPIFY_TOKEN_KEY);
    if (cached) return cached;
  }

  const res = await fetch(`https://${shopifyHost(env)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.IND_SHOPIFY_API_KEY,
      client_secret: secret,
      grant_type: 'client_credentials',
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.log('[shopify:token-error]', res.status, text.slice(0, 300));
    return null;
  }

  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    console.log('[shopify:token-missing]', text.slice(0, 300));
    return null;
  }

  // KV needs at least 60s; expires_in is seconds and typically ~86400.
  const ttl = Math.max(60, (body.expires_in ?? 86_400) - SHOPIFY_TOKEN_MARGIN_S);
  await env.STATE.put(SHOPIFY_TOKEN_KEY, body.access_token, { expirationTtl: ttl });
  console.log('[shopify:token-minted]', `expires_in=${body.expires_in}`, `cached_for=${ttl}s`);

  return body.access_token;
}

/**
 * One Shopify Admin API call. Retries once on 401 with a freshly minted token,
 * which covers a token revoked or expired earlier than its stated lifetime.
 */
async function shopifyFetch(env: Env, path: string): Promise<Response> {
  const url = `https://${shopifyHost(env)}/admin/api/${env.IND_SHOPIFY_API_VERSION || '2026-04'}/${path}`;

  const call = async (token: string) =>
    fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    });

  const token = await shopifyAccessToken(env);
  if (!token) return new Response('{"errors":"no Shopify token available"}', { status: 401 });

  const res = await call(token);
  if (res.status !== 401) return res;

  console.log('[shopify:401] re-minting token and retrying');
  const fresh = await shopifyAccessToken(env, true);
  return fresh ? call(fresh) : res;
}

async function sampleShopify(env: Env, limit: number): Promise<Record<string, unknown>> {
  const missing = (
    ['IND_SHOPIFY_STORE', 'IND_SHOPIFY_API_KEY', 'IND_SHOPIFY_API_SECRET'] as const
  ).filter((k) => !env[k]);
  if (missing.length) return { error: `Not configured: ${missing.join(', ')}` };

  // status=active mirrors what shoppers may actually be shown; inventory_* is
  // needed to tell "sold out" from "inventory simply not tracked".
  const query =
    `products.json?limit=${limit}&status=active` +
    `&fields=id,title,handle,product_type,tags,status,variants,images`;
  const res = await shopifyFetch(env, query);
  const text = await res.text();
  if (!res.ok) {
    // Prefix and length only — enough to tell shpat_ from shpss_ or a truncated
    // paste, without putting the credential itself in a response.
    const secret = env.IND_SHOPIFY_API_SECRET ?? '';
    const key = env.IND_SHOPIFY_API_KEY ?? '';

    /*
     * Separate "bad token" from "bad API version" from "wrong store". shop.json
     * is the cheapest authenticated call; running it across versions shows
     * whether only the configured version fails. An unauthenticated call proves
     * the domain resolves to a real Shopify store at all.
     */
    const host = shopifyHost(env);
    const probe = async (label: string, url: string, auth: boolean) => {
      const r = await fetch(url, {
        headers: auth ? { 'X-Shopify-Access-Token': secret } : {},
      });
      const b = await r.text();
      return { [label]: { status: r.status, body: b.slice(0, 160) } };
    };

    const probes = Object.assign(
      {},
      await probe('shopJson_configuredVersion', `https://${host}/admin/api/${env.IND_SHOPIFY_API_VERSION}/shop.json`, true),
      await probe('shopJson_2025_10', `https://${host}/admin/api/2025-10/shop.json`, true),
      await probe('storefrontReachable_noAuth', `https://${host}/admin/api/2025-10/shop.json`, false),
    );

    return {
      status: res.status,
      store: env.IND_SHOPIFY_STORE,
      apiVersion: env.IND_SHOPIFY_API_VERSION,
      credentials: {
        secretPrefix: secret.slice(0, 6),
        secretLength: secret.length,
        secretHasWhitespace: secret !== secret.trim(),
        keyPrefix: key.slice(0, 6),
        keyLength: key.length,
      },
      probes,
      body: text.slice(0, 500),
    };
  }

  const parsed = JSON.parse(text) as {
    products?: {
      id: number;
      title: string;
      product_type: string;
      tags: string;
      status: string;
      variants?: {
        id: number;
        sku: string;
        title: string;
        price: string;
        inventory_quantity: number;
        inventory_management: string | null;
        inventory_policy: string;
      }[];
      images?: { src: string }[];
    }[];
  };

  const products = (parsed.products ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    product_type: p.product_type,
    status: p.status,
    tags: p.tags.split(',').map((t) => t.trim()).filter(Boolean),
    firstImage: p.images?.[0]?.src,
    variants: (p.variants ?? []).map((v) => ({
      sku: v.sku,
      size: v.title,
      price: v.price,
      stock: v.inventory_quantity,
      tracked: v.inventory_management,
      whenOutOfStock: v.inventory_policy,
    })),
  }));

  // The tag vocabulary is what the occasion mapping has to be built against.
  const allTags = [...new Set(products.flatMap((p) => p.tags))].sort();
  const skusMissing = products.filter((p) => p.variants.some((v) => !v.sku)).length;
  const allVariants = products.flatMap((p) => p.variants);
  const inventory = {
    variants: allVariants.length,
    withStock: allVariants.filter((v) => v.stock > 0).length,
    tracked: allVariants.filter((v) => v.tracked).length,
    continueSellingWhenOut: allVariants.filter((v) => v.whenOutOfStock === 'continue').length,
  };
  const productTypes = [...new Set(products.map((p) => p.product_type))].sort();

  return {
    store: env.IND_SHOPIFY_STORE,
    storeId: env.IND_SHOPIFY_STORE_ID,
    apiVersion: env.IND_SHOPIFY_API_VERSION,
    count: products.length,
    allTags,
    productTypes,
    inventory,
    productsWithBlankSkus: skusMissing,
    products,
  };
}

/**
 * Read-only survey of the commerce catalogs on a business.
 *
 * Lists every catalog with its product count and samples a few items from
 * each, so the Shopify-synced one can be identified and its `retailer_id`
 * format read off. Writes nothing — deliberately, since the live catalog and
 * Business Manager must not be disturbed.
 */
async function surveyCatalogs(env: Env, business: string): Promise<Record<string, unknown>> {
  const listed = await graphCall(
    env,
    `${business}/owned_product_catalogs?fields=id,name,product_count,vertical&limit=25`,
  );

  const catalogs = (listed.body as { data?: { id: string; name: string }[] })?.data ?? [];

  const sampled = await Promise.all(
    catalogs.map(async (c) => {
      const items = await graphCall(
        env,
        `${c.id}/products?fields=retailer_id,name,price,availability&limit=3`,
      );
      return { ...c, sample: (items.body as { data?: unknown[] })?.data ?? items.body };
    }),
  );

  return { business, catalogs: sampled };
}

/**
 * Diagnostic for the product carousel / single product message.
 *
 * Reads back what is actually in the catalog, then sends a real product
 * message and returns Meta's raw response. `wrangler tail` sessions expire
 * mid-debug, and a boolean from graph() hides the reason a send failed.
 */
async function diagnoseProducts(
  env: Env,
  to: string,
  ids: string[],
  omitBody = false,
  waba?: string,
): Promise<Record<string, unknown>> {
  if (!env.CATALOG_ID) return { error: 'CATALOG_ID is not set on the Worker' };

  /*
   * Which catalog this WABA is actually bound to. A catalog links to exactly
   * one WABA, and sending from any other returns "product not found" even
   * though the item plainly exists — indistinguishable from a missing item
   * unless you check the binding directly.
   */
  const linkedCatalogs = waba
    ? (await graphCall(env, `${waba}/product_catalogs?fields=id,name,product_count`)).body
    : 'pass &waba=<WABA_ID> to check the catalog binding';

  // How big the catalog actually is, and whether each id being sent is really
  // in it. A card fails identically whether the item was never created or is
  // still being indexed, so look it up directly rather than infer.
  const size = await graphCall(env, `${env.CATALOG_ID}?fields=product_count,name`);
  // Commerce settings for this phone number: whether the catalog is visible to
  // shoppers at all. A hidden catalog makes every product message fail.
  const commerce = await graphCall(env, `${env.PHONE_NUMBER_ID}/whatsapp_commerce_settings`);
  const lookups = await Promise.all(
    ids.map(async (retailerId) => {
      const filter = encodeURIComponent(JSON.stringify({ retailer_id: { eq: retailerId } }));
      /*
       * visibility and review_status are the two reasons an item can sit in a
       * catalog and still be unsendable: `staging` hides it, and a review that
       * is pending or rejected keeps it out of WhatsApp entirely.
       */
      const found = await graphCall(
        env,
        `${env.CATALOG_ID}/products?fields=retailer_id,name,availability,visibility,review_status,image_url&filter=${filter}`,
      );
      const rows = (found.body as { data?: unknown[] })?.data ?? [];
      return { retailerId, inCatalog: rows.length > 0, row: rows[0] ?? null };
    }),
  );

  const interactive =
    ids.length >= 2
      ? {
          type: 'carousel',
          ...(omitBody ? {} : { body: { text: 'Catalog test' } }),
          action: {
            cards: ids.slice(0, 10).map((retailerId, index) => ({
              card_index: index,
              type: 'product',
              action: { product_retailer_id: retailerId, catalog_id: env.CATALOG_ID },
            })),
          },
        }
      : {
          type: 'product',
          body: { text: 'Catalog test' },
          action: { catalog_id: env.CATALOG_ID, product_retailer_id: ids[0] },
        };

  const send = await graphCall(env, `${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
  });

  return {
    catalogId: env.CATALOG_ID,
    catalogSize: size.body,
    linkedCatalogs,
    commerceSettings: commerce.body,
    sentIds: ids,
    lookups,
    send,
  };
}

async function createTemplate(
  env: Env,
  waba: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const version = env.GRAPH_API_VERSION || 'v21.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** All cards share one structure — that is a hard requirement of the format. */
function carouselCards(
  cards: readonly { label: string }[],
  exampleHandle: string,
): Record<string, unknown>[] {
  return cards.map((card) => ({
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: [exampleHandle] } },
      /*
       * Label only — no blurb, no {{n}} variables.
       *
       * A card BODY is mandatory (Meta rejects a card without one), so the
       * label is the shortest legal card copy. Variables are impossible here
       * for a separate reason: Meta weighs a template's total variable count
       * against its main body length, and a carousel's body is one short
       * question, so even one per-card variable fails validation with
       * "Parameters words ratio exceeds limit".
       */
      { type: 'BODY', text: card.label },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Choose' }] },
    ],
  }));
}

function carouselTemplate(
  name: string,
  language: string,
  bodyText: string,
  cards: readonly { label: string }[],
  exampleHandle: string,
): Record<string, unknown> {
  return {
    name,
    language,
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: bodyText },
      { type: 'CAROUSEL', cards: carouselCards(cards, exampleHandle) },
    ],
  };
}

/**
 * Rewrites both approved templates to label-only cards.
 *
 * An edit re-opens Meta review, so the live templates keep sending their
 * current copy until the new version is approved. Category and language cannot
 * be changed by an edit, and are deliberately not sent.
 */
async function updateCarouselTemplates(
  env: Env,
  waba: string,
  appId: string,
): Promise<Record<string, unknown>> {
  const exampleHandle = await uploadExampleImage(env, appId, OCCASIONS[0].image);

  const listed = await graphCall(env, `${waba}/message_templates?fields=name,id,status&limit=100`);
  const templates = (listed.body as { data?: { name: string; id: string; status: string }[] })?.data ?? [];

  const edit = async (name: string, bodyText: string, cards: readonly { label: string }[]) => {
    const found = templates.find((t) => t.name === name);
    if (!found) return { error: `template "${name}" not found on this WABA` };

    const res = await graphCall(env, found.id, {
      method: 'POST',
      body: {
        components: [
          { type: 'BODY', text: bodyText },
          { type: 'CAROUSEL', cards: carouselCards(cards, exampleHandle) },
        ],
      },
    });
    return { id: found.id, statusBefore: found.status, result: res };
  };

  return {
    occasion: await edit(env.OCCASION_TEMPLATE || 'occasion_picker', COPY.occasionHeader, OCCASIONS),
    category: await edit(env.CATEGORY_TEMPLATE || 'category_picker', COPY.categoryHeader, CATEGORIES),
  };
}

/**
 * `suffix` creates a parallel pair under new names (occasion_picker_v2, …).
 * Meta will not accept an edit that rewrites carousel cards — it answers a
 * bare "(#100) Invalid parameter" — so changing card copy means submitting new
 * templates and repointing OCCASION_TEMPLATE / CATEGORY_TEMPLATE once approved.
 */
async function createCarouselTemplates(env: Env, waba: string, appId: string, suffix?: string) {
  const language = env.TEMPLATE_LANGUAGE || 'en_US';
  const exampleHandle = await uploadExampleImage(env, appId, OCCASIONS[0].image);
  const named = (base: string) => (suffix ? `${base}_${suffix}` : base);

  const occasion = await createTemplate(
    env,
    waba,
    carouselTemplate(
      named(env.OCCASION_TEMPLATE || 'occasion_picker'),
      language,
      COPY.occasionHeader,
      OCCASIONS,
      exampleHandle,
    ),
  );

  const category = await createTemplate(
    env,
    waba,
    carouselTemplate(
      named(env.CATEGORY_TEMPLATE || 'category_picker'),
      language,
      COPY.categoryHeader,
      CATEGORIES,
      exampleHandle,
    ),
  );

  return { language, exampleHandle, occasion, category };
}

/* ------------------------------------------------------------------ *
 * Webhook parsing
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

    /*
     * One-off setup helper: subscribes a WhatsApp Business Account to this app,
     * reusing the WHATSAPP_TOKEN secret so no token has to be handled by hand.
     * Real messages route through the WABA, and without this subscription Meta
     * generates the event but never forwards it to the callback URL.
     *
     *   /admin/subscribe?token=<VERIFY_TOKEN>&waba=<WABA_ID>
     *
     * Gated on VERIFY_TOKEN so it is not publicly triggerable. Safe to delete
     * once the subscription is in place.
     */
    if (path === '/admin/subscribe' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const waba = url.searchParams.get('waba');
      if (!waba) {
        return new Response('Missing ?waba=<WABA_ID>', { status: 400 });
      }

      const version = env.GRAPH_API_VERSION || 'v21.0';
      const endpoint = `https://graph.facebook.com/${version}/${waba}/subscribed_apps`;
      const headers = { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` };
      const read = async (init?: RequestInit) => {
        const res = await fetch(endpoint, { ...init, headers });
        const text = await res.text();
        try {
          return { status: res.status, body: JSON.parse(text) };
        } catch {
          return { status: res.status, body: text };
        }
      };

      const before = await read();
      const subscribe = await read({ method: 'POST' });
      const after = await read();
      const result = { waba, before, subscribe, after };
      console.log('[admin:subscribe]', JSON.stringify(result));

      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    /*
     * Creates + submits the two carousel picker templates via the Cloud API.
     * WhatsApp Manager does not expose the carousel component in every account,
     * but the API accepts it regardless.
     *
     *   /admin/templates?token=<VERIFY_TOKEN>&waba=<WABA_ID>&app=<APP_ID>
     *
     * Safe to re-run: an existing name comes back as a duplicate error rather
     * than creating anything. Delete this route once the templates exist.
     */
    if (path === '/admin/templates' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const waba = url.searchParams.get('waba');
      const appId = url.searchParams.get('app');
      if (!waba || !appId) {
        return new Response('Missing ?waba=<WABA_ID>&app=<APP_ID>', { status: 400 });
      }

      try {
        const result = await createCarouselTemplates(
          env,
          waba,
          appId,
          url.searchParams.get('suffix') ?? undefined,
        );
        console.log('[admin:templates]', JSON.stringify(result));
        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        console.log('[admin:templates-error]', String(err));
        return new Response(JSON.stringify({ error: String(err) }, null, 2), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    /*
     * Creates the commerce catalog, connects it to the WABA and uploads every
     * in-stock product as an item. Needed once before the product carousel can
     * send anything.
     *
     *   /admin/catalog?token=<VERIFY_TOKEN>&business=<BUSINESS_ID>&waba=<WABA_ID>
     *   ...&catalog=<CATALOG_ID>   to use a catalog made in Commerce Manager
     *
     * Reports every step so a permission failure is visible rather than silent.
     */
    if (path === '/admin/catalog' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const business = url.searchParams.get('business');
      const waba = url.searchParams.get('waba');
      if (!business || !waba) {
        return new Response('Missing ?business=<BUSINESS_ID>&waba=<WABA_ID>', { status: 400 });
      }

      try {
        const result = await provisionCatalog(
          env,
          business,
          waba,
          url.searchParams.get('catalog') ?? undefined,
        );
        console.log('[admin:catalog]', JSON.stringify(result));
        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        console.log('[admin:catalog-error]', String(err));
        return new Response(JSON.stringify({ error: String(err) }, null, 2), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    /*
     * Sends a real product message and reports Meta's raw response, plus the
     * first few catalog items as they exist server-side.
     *
     *   /admin/testproduct?token=<VERIFY_TOKEN>&to=<WA_ID>&ids=<id1,id2>
     */
    if (path === '/admin/testproduct' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const to = url.searchParams.get('to');
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (!to || !ids.length) {
        return new Response('Missing ?to=<WA_ID>&ids=<id1,id2>', { status: 400 });
      }

      const result = await diagnoseProducts(
        env,
        to,
        ids,
        url.searchParams.get('nobody') === '1',
        url.searchParams.get('waba') ?? undefined,
      );
      console.log('[admin:testproduct]', JSON.stringify(result));
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    /*
     * Rewrites both picker templates to label-only cards and re-submits them
     * for review. The live versions keep sending until Meta approves.
     *
     *   /admin/retemplate?token=<VERIFY_TOKEN>&waba=<WABA_ID>&app=<APP_ID>
     */
    if (path === '/admin/retemplate' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const waba = url.searchParams.get('waba');
      const appId = url.searchParams.get('app');
      if (!waba || !appId) {
        return new Response('Missing ?waba=<WABA_ID>&app=<APP_ID>', { status: 400 });
      }

      try {
        const result = await updateCarouselTemplates(env, waba, appId);
        console.log('[admin:retemplate]', JSON.stringify(result));
        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        console.log('[admin:retemplate-error]', String(err));
        return new Response(JSON.stringify({ error: String(err) }, null, 2), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    /*
     * Coverage of the mapped catalog: how many in-stock products land in each
     * occasion x category cell, which is what decides whether the flow has
     * anything to show.
     *
     *   /admin/mapped?token=<VERIFY_TOKEN>[&fresh=1]
     */
    if (path === '/admin/mapped' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.searchParams.get('fresh') === '1') await env.STATE.delete(SHOPIFY_CACHE_KEY);

      const all = await getProducts(env);
      const inStock = all.filter(isInStock);

      const grid: Record<string, Record<string, number>> = {};
      for (const o of OCCASIONS) {
        grid[o.label] = {};
        for (const c of CATEGORIES) {
          grid[o.label][c.label] = filterProducts(inStock, o.id, c.id).length;
        }
      }

      return new Response(
        JSON.stringify(
          {
            total: all.length,
            inStock: inStock.length,
            withNoOccasion: inStock.filter((p) => !p.occasionTags.length).length,
            byCategory: Object.fromEntries(
              CATEGORIES.map((c) => [c.label, filterProducts(inStock, undefined, c.id).length]),
            ),
            grid,
            sample: inStock.slice(0, 3),
          },
          null,
          2,
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    /*
     * Read-only sample of Shopify products, to build the mapping against.
     *
     *   /admin/shopify?token=<VERIFY_TOKEN>[&limit=5][&version=2026-01]
     */
    if (path === '/admin/shopify' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const result = await sampleShopify(env, Number(url.searchParams.get('limit') ?? 5));
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    /*
     * Read-only: lists the business's catalogs and samples each one.
     *
     *   /admin/catalogs?token=<VERIFY_TOKEN>&business=<BUSINESS_ID>
     */
    if (path === '/admin/catalogs' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const business = url.searchParams.get('business');
      if (!business) return new Response('Missing ?business=<BUSINESS_ID>', { status: 400 });

      const result = await surveyCatalogs(env, business);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

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
