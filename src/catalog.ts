import type { Env } from './types';
import { graphCall } from './whatsapp';
import { cap } from './copy';
import catalog from './products.json';

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

export interface SizeStock {
  size: string;
  stock: number;
  /**
   * Shopify variant id. The checkout permalink is built from this, so a size
   * without one cannot be bought directly. Optional because items cached
   * before variant ids were carried will not have it.
   */
  variantId?: string;
  /**
   * Shopify's SKU for this size. Optional for the same reason as variantId —
   * items cached before it was carried will not have one, and Shopify itself
   * allows a blank SKU.
   */
  sku?: string;
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
  /**
   * The whole Shopify gallery, primary first. Meta allows up to 10 images per
   * catalog item and renders the extras as the swipeable PDP gallery.
   * Optional so the bundled products.json fallback stays valid.
   */
  imageUrls?: string[];
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
export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Shopify tag → occasion id. Conservative: an unmapped tag is simply ignored. */
export const OCCASION_TAGS: Record<string, string> = {
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
export const CATEGORY_TERMS: Record<string, string> = {
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

export const FABRIC_TERMS = [
  'hemp',
  'linen',
  'tencel',
  'modal',
  'organic cotton',
  'cotton',
  'bemberg',
] as const;

export interface ShopifyVariant {
  id: number;
  sku: string;
  title: string;
  price: string;
  inventory_quantity: number;
}

export interface ShopifyProduct {
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
export function variantSize(title: string): string | null {
  for (const part of title.split('/').map((p) => p.trim())) {
    const hit = SIZE_ORDER.find((s) => s.toLowerCase() === part.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export function mapShopifyProduct(p: ShopifyProduct): Product | null {
  const tags = p.tags.split(',').map((t) => norm(t)).filter(Boolean);

  const occasionTags = [...new Set(tags.map((t) => OCCASION_TAGS[t]).filter(Boolean))];

  // product_type first; fall back to tags when it is blank or the catch-all
  // "Clothing", which covers a large slice of the store.
  const typeKey = norm(p.product_type);
  const category =
    CATEGORY_TERMS[typeKey] ?? tags.map((t) => CATEGORY_TERMS[t]).find(Boolean) ?? null;
  if (!category) return null;

  const sizes: SizeStock[] = (p.variants ?? []).flatMap((v) => {
    const size = variantSize(v.title);
    if (!size) return [];
    return [{
      size,
      stock: v.inventory_quantity,
      variantId: v.id ? String(v.id) : undefined,
      sku: v.sku || undefined,
    }];
  });
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
    imageUrls: (p.images ?? []).map((i) => i.src).filter(Boolean).slice(0, 10),
    productUrl: `https://reistor.in/products/${p.handle}`,
  };
}

export const SHOPIFY_CACHE_KEY = 'shopify:ind:products';

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

/** Where the picker artwork is served from — see dashboard/public/. */
/**
 * Where the picker artwork is served from.
 *
 * A path, not a URL. The host comes from ASSET_BASE at send time so moving the
 * images off Cloudflare Pages onto the Linode's own Nginx is one environment
 * variable rather than six edits and a redeploy — which matters when the
 * cutover has to be reversible in a hurry.
 */
const CATEGORY_IMAGE_PATH = '/categories';

export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];

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
export const OCCASIONS = [
  {
    id: 'work',
    label: 'Work & Meetings',
    phrase: 'long meeting days',
    blurb: 'Refined silhouettes that keep comfort in mind.',
    image: '/occasions/top/work.jpg',
  },
  {
    id: 'vacation',
    label: 'Vacation & Travel',
    phrase: 'packing light',
    blurb: 'Stylish, comfortable pieces made for days away and perfect photo ops.',
    image: '/occasions/top/vacation.jpg',
  },
  {
    id: 'casual',
    label: 'Weekend & Brunch',
    phrase: 'slow weekend plans',
    blurb: 'Easy styles for relaxed mornings and plans that follow.',
    image: '/occasions/top/casual.jpg',
  },
  {
    id: 'dinner',
    label: 'Dinner Date',
    phrase: 'evening plans',
    blurb: 'Romantic styles that make you look and feel amazing.',
    image: '/occasions/top/dinner.jpg',
  },
  {
    id: 'lounge',
    label: 'Loungewear',
    phrase: 'quiet days at home',
    blurb: 'The comfiest styles to lounge in, step out in, and feel great in all day long.',
    image: '/occasions/top/lounge.jpg',
  },
] as const;

/**
 * Category card copy, written per occasion — the same six categories read
 * differently for a meeting than for a beach.
 *
 * These strings are frozen inside the five approved `category_picker_<id>`
 * templates, so nothing here is sent at runtime. They live in code as the
 * record of what was approved, and as the input to /admin/retemplate when a
 * new version is submitted.
 */
export const CATEGORY_BLURBS: Record<string, Record<string, string>> = {
  work: {
    tops: 'Polished staples in breathable fabrics.',
    dresses: 'From desk to dinner, beautifully.',
    bottoms: 'Polished, comfortable and easy to style.',
    jackets: 'Light layers that pull a look together.',
    jumpsuits: 'One-piece dressing, beautifully done.',
    coords: 'A polished look, already matched.',
  },
  vacation: {
    tops: 'Easy staples for days away.',
    dresses: 'Made for sunny days and perfect photo ops.',
    bottoms: 'Light, comfortable and easy to pack.',
    jackets: 'Light layers for cooler evenings.',
    jumpsuits: 'Easy one-piece dressing for your getaway.',
    coords: 'Travel-ready sets that make packing easy.',
  },
  casual: {
    tops: 'Easy styles for relaxed days.',
    dresses: 'Pretty, comfortable and made for brunch.',
    bottoms: 'Relaxed styles with plenty of room to move.',
    jackets: 'Easy layers for cooler days.',
    jumpsuits: 'One-piece dressing made easy.',
    coords: 'Matching styles for an easy weekend look.',
  },
  dinner: {
    tops: 'Feminine styles made for evenings out.',
    dresses: 'Romantic styles that make every occasion feel special.',
    bottoms: 'Elegant styles made for dinner and drinks.',
    jackets: 'Light layers for cooler evenings.',
    jumpsuits: 'Flattering one-pieces made for date night.',
    coords: 'Beautiful matching styles for an evening out.',
  },
  lounge: {
    tops: 'The comfiest tops for lounging or going out.',
    dresses: 'Soft, comfortable dresses for all-day wear.',
    bottoms: 'Relaxed fits made for comfort all day.',
    jackets: 'Easy layers for cooler days, at home or out.',
    jumpsuits: "Comfortable one-pieces you'll want to live in.",
    coords: 'The comfiest matching sets for home and beyond.',
  },
};

export const CATEGORIES = [
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

/**
 * Category artwork, per occasion.
 *
 * The six categories are the same everywhere, but a shopper dressing for a
 * meeting and one packing for a beach should not be shown the same jacket.
 * Card copy already varies this way — see CATEGORY_BLURBS — and the images are
 * a send-time parameter, so they can vary without a new template.
 *
 * Keyed occasion → category. Anything missing falls back to the shared image
 * on CATEGORIES, so an occasion can be filled in one category at a time and a
 * gap costs a generic card rather than a broken one.
 */
/**
 * Which occasions have their own category artwork, and for which garments.
 *
 * The six categories are the same everywhere, but a shopper dressing for a
 * meeting and one dressing for dinner should not be shown the same jacket.
 * Card copy already varies this way — see CATEGORY_BLURBS — and images are a
 * send-time parameter, so they vary without a new template.
 *
 * Listed rather than derived, so a category with no photograph yet falls back
 * to the shared image instead of pointing at a URL that 404s. Files live at
 * assets/categories/<occasion>/<category>.jpg and are published by
 * `npm run cards`; adding an occasion here means adding its six files too.
 */
export const CATEGORY_ARTWORK: Record<string, readonly string[]> = {
  work: ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'],
  dinner: ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'],
  lounge: ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'],
  vacation: ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'],
  casual: ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'],
};

/**
 * The card image for one category, given the occasion the shopper picked.
 *
 * Held behind CATEGORY_ARTWORK_ENABLED so the photography can ship and be
 * switched on separately. Off, every card falls back to the shared image on
 * CATEGORIES exactly as before — the map above stays populated, so it still
 * records which occasions are ready rather than losing that when it is off.
 */
export function categoryImage(
  env: Env,
  occasion: string | undefined,
  categoryId: string,
): string {
  const enabled = (env.CATEGORY_ARTWORK_ENABLED || 'off').toLowerCase() === 'on';
  if (enabled && occasion && CATEGORY_ARTWORK[occasion]?.includes(categoryId)) {
    return assetUrl(env, `${CATEGORY_IMAGE_PATH}/${occasion}/${categoryId}.jpg`);
  }
  return CATEGORIES.find((c) => c.id === categoryId)?.image ?? '';
}


/**
 * Absolute URL for an asset the bot serves itself.
 *
 * Meta fetches card images over the public internet, so a path is not enough.
 * Anything already absolute is returned untouched — Shopify CDN images arrive
 * that way and must not be rewritten.
 */
export function assetUrl(env: Env, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = (env.ASSET_BASE || 'https://reistor-dashboard.pages.dev').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The occasion card's artwork, resolved against ASSET_BASE. */
export const occasionImage = (env: Env, o: { image: string }) => assetUrl(env, o.image);


export const occasionLabel = (id?: string) => OCCASIONS.find((o) => o.id === id)?.label ?? 'this occasion';
export const occasionPhrase = (id?: string) => OCCASIONS.find((o) => o.id === id)?.phrase ?? 'the day ahead';
export const categoryLabel = (id?: string) => CATEGORIES.find((c) => c.id === id)?.label ?? 'this category';

/**
 * One SKU for a whole product.
 *
 * Shopify holds a SKU per variant, so a product has one per size. Where those
 * share a stem — RST-TOP-0142-XS, -S, -M — the stem is the product's code and
 * is what a merchandiser recognises. Where they do not, the first size's SKU
 * is more useful than nothing.
 */
export function productSku(p: Product): string | undefined {
  const skus = p.sizes.map((s) => s.sku).filter((s): s is string => Boolean(s));
  if (!skus.length) return undefined;
  if (skus.length === 1) return skus[0];

  let stem = skus[0];
  for (const sku of skus.slice(1)) {
    let i = 0;
    while (i < stem.length && i < sku.length && stem[i] === sku[i]) i++;
    stem = stem.slice(0, i);
  }
  // Trailing separators are an artefact of the comparison, not part of the code.
  stem = stem.replace(/[-_/\s]+$/, '');
  return stem.length >= 3 ? stem : skus[0];
}


export const isInStock = (p: Product) => p.sizes.some((s) => s.stock > 0);

export const inStockSizes = (p: Product) =>
  p.sizes
    .filter((s) => s.stock > 0)
    .map((s) => s.size)
    .sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

export function filterProducts(all: Product[], occasion?: string, category?: string): Product[] {
  return all.filter(
    (p) =>
      isInStock(p) &&
      (!occasion || p.occasionTags.includes(occasion)) &&
      (!category || p.category === category),
  );
}


/** GoKwik / reistor.in checkout deep link for a specific size. */
export function checkoutUrl(product: Product, size: string): string {
  const variantId = product.sizes.find((s) => s.size === size)?.variantId;
  const origin = new URL(product.productUrl).origin;

  /*
   * Shopify's cart permalink — /cart/<variant_id>:<qty> — drops the shopper
   * straight into checkout with the size already chosen, which is where GoKwik
   * takes over. A size label in `?variant=` does nothing; the id is required.
   *
   * Without one — an item cached before variant ids were carried — fall back
   * to the product page rather than sending anyone to a broken cart.
   */
  const url = variantId
    ? new URL(`/cart/${variantId}:1`, origin)
    : new URL(product.productUrl);

  url.searchParams.set('utm_source', 'whatsapp');
  url.searchParams.set('utm_medium', 'ai-stylist');
  return url.toString();
}

/**
 * One GoKwik checkout for a whole basket.
 *
 * Shopify's cart permalink takes several lines — /cart/<v1>:1,<v2>:1 — so the
 * sizing loop can hand the entire bag over in a single URL rather than sending
 * the shopper through checkout once per garment. GoKwik intercepts that
 * checkout on reistor.in, which is why no GoKwik API call is involved.
 *
 * Returns null when not one line resolves to a variant id, so the caller can
 * say so rather than opening an empty cart.
 */
export function cartCheckoutUrl(
  env: Env,
  products: Product[],
  lines: { productId: string; size: string }[],
): string | null {
  const byId = new Map(products.map((p) => [p.id, p]));
  const parts: string[] = [];
  let origin: string | undefined;

  for (const line of lines) {
    const product = byId.get(line.productId);
    const variantId = product?.sizes.find((s) => s.size === line.size)?.variantId;
    if (!product || !variantId) {
      console.log('[checkout:no-variant]', line.productId, line.size);
      continue;
    }
    origin ??= new URL(product.productUrl).origin;
    parts.push(`${variantId}:1`);
  }

  if (!parts.length || !origin) return null;

  const url = new URL(`/cart/${parts.join(',')}`, origin);

  /*
   * Land on the cart page, not straight in checkout.
   *
   * A bare /cart/<variant>:1 adds the items and redirects to /checkout without
   * ever rendering the cart page — and both GoKwik and Fastrr work by
   * replacing the checkout BUTTON on that page. Skip the page, skip the
   * script, and the shopper gets Shopify's own checkout instead of the
   * one-click panel. It costs one extra tap and is the difference between the
   * one-click checkout running and not.
   *
   * CHECKOUT_LANDING=checkout restores the old behaviour if a future app
   * intercepts the permalink directly.
   */
  if ((env.CHECKOUT_LANDING || 'cart').toLowerCase() !== 'checkout') {
    url.searchParams.set('return_to', '/cart');
  }

  // Read back by the nightly pull to attribute the order to the bot.
  url.searchParams.set('utm_source', 'whatsapp');
  url.searchParams.set('utm_medium', 'ai-stylist');
  return url.toString();
}


/* ------------------------------------------------------------------ *
 * State (KV, one record per wa_id)
 * ------------------------------------------------------------------ */

/** Every retailer_id currently in the catalog, paged out. */
export async function existingRetailerIds(env: Env, catalogId: string): Promise<Set<string>> {
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
/**
 * Appends the configured Shopify CDN transform to an image URL.
 *
 * Shopify srcs already carry a `?v=` cache-buster, so the separator has to be
 * chosen rather than assumed. Non-Shopify URLs are returned untouched.
 */
export function catalogImage(env: Env, url: string): string {
  const transform = env.CATALOG_IMAGE_TRANSFORM?.trim();
  if (!transform || !url) return url;
  if (!/\/cdn\/shop\/|cdn\.shopify\.com/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${transform}`;
}

/**
 * The catalog id for one size of one garment.
 *
 * Variants need their own retailer_id, and it has to be derivable both ways:
 * forward when the catalog is built, backward when a sent cart arrives
 * carrying only these ids. `<productId>-<size>` does both without a lookup
 * table, and stays stable if Shopify reissues a variant id.
 */
export const variantRetailerId = (productId: string, size: string) =>
  `${productId}-${size.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;

/** Reads one back. Returns null for a plain product id from the old catalog. */
export function parseVariantRetailerId(
  retailerId: string,
): { productId: string; size: string } | null {
  const at = retailerId.lastIndexOf('-');
  if (at <= 0) return null;
  return { productId: retailerId.slice(0, at), size: retailerId.slice(at + 1) };
}

/**
 * The catalog id for one size, when the product id itself joins the group.
 *
 * A Meta variant group has no parent item — it is just a set of items sharing
 * an item_group_id. That left us with an id we could send (the product-level
 * item, in no group) and ids in a group we could not send, so neither path
 * rendered a size selector.
 *
 * So the first in-stock size claims the product id, and the rest keep the
 * suffixed form. The id the carousel already sends is then a member of its own
 * group, which is what Meta needs to draw the selector.
 */
export function groupedRetailerId(p: Product, size: string): string {
  const primary = (p.sizes.find((s) => s.stock > 0) ?? p.sizes[0])?.size;
  return size === primary ? p.id : variantRetailerId(p.id, size);
}


/**
 * The variant a product message should point at.
 *
 * A carousel card takes one retailer_id, but the shopper should land on the
 * group and choose from it — so the card points at the first size actually in
 * stock. Meta renders the whole group's size selector from there, which is the
 * point of the exercise.
 */
export function primaryRetailerId(env: Env, p: Product): string {
  /*
   * Off until variant items are proven sendable.
   *
   * A variant can sit in the catalog as in-stock and published while WhatsApp
   * still answers "product not found for product_retailer_id" — the messaging
   * index lags the catalog API by an unknown amount on newly created items,
   * and it is not certain a variant is addressable in a product message at
   * all. Pointing cards at ids Meta will not accept turns every carousel into
   * "those looks are not reachable", so this stays off until a real send
   * succeeds.
   */
  if ((env.CATALOG_VARIANTS || 'off').toLowerCase() !== 'on') return p.id;

  const inStock = p.sizes.find((s) => s.stock > 0) ?? p.sizes[0];
  return inStock ? variantRetailerId(p.id, inStock.size) : p.id;
}

/**
 * Pushes the catalog to Meta, one item per size.
 *
 * The catalog used to hold one item per product, which is why a sent cart
 * arrived with no size and why the bot then had to ask for one garment at a
 * time. Grouping sizes under `item_group_id` moves that choice onto WhatsApp's
 * own product page: the shopper picks the size there, sees which sizes are
 * actually in stock, and the cart arrives ready to charge.
 *
 * Meta requires every variant field to be populated on every item in a group,
 * and the name to be identical across it — otherwise the group silently does
 * not render as one product.
 *
 * `limit` and `offset` exist because this is now ~3,400 items rather than 481.
 * A full sync is more than one Worker invocation's CPU budget, so the nightly
 * job walks it in slices.
 */
export async function syncCatalogItems(
  env: Env,
  catalogId: string,
  products: Product[],
  opts: {
    limit?: number;
    offset?: number;
    prune?: boolean;
    only?: string;
    /** Let the product id claim the first in-stock size. See groupedRetailerId. */
    groupPrimary?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const { limit, offset = 0, prune = true, only, groupPrimary = false } = opts;
  if (only) products = products.filter((p) => p.id === only);

  const existing = await existingRetailerIds(env, catalogId);

  /* Every size of every garment, flattened. */
  const all = products.flatMap((p) =>
    p.sizes.map((s) => ({ product: p, size: s })),
  );
  const live = new Set(
    all.map(({ product, size }) =>
      groupPrimary ? groupedRetailerId(product, size.size) : variantRetailerId(product.id, size.size),
    ),
  );

  const slice = limit ? all.slice(offset, offset + limit) : all;

  /*
   * items_batch, not batch.
   *
   * The older /batch endpoint validates against a whitelist that has no
   * item_group_id in it — it answers "Invalid keys "item_group_id" were found
   * in param "data"" and writes nothing. /items_batch takes the full feed
   * field set, which is where variants live.
   *
   * Its field names are the feed's, not the older endpoint's: `id` rather than
   * a request-level retailer_id, `title`, `link`, `image_link`, and a price
   * that is a string carrying its own currency.
   */
  const upserts = slice.map(({ product: p, size }) => {
    const id = groupPrimary ? groupedRetailerId(p, size.size) : variantRetailerId(p.id, size.size);
    return {
      method: existing.has(id) ? 'UPDATE' : 'CREATE',
      data: {
        id,
        // Identical across the group, or Meta shows them as separate products.
        title: p.title,
        description: `${cap(p.fabric)}, ${p.attributes}.`,
        link: p.productUrl,
        // Collections are product sets filtered on a field, so the category
        // has to exist on the item itself.
        product_type: categoryLabel(p.category),
        image_link: catalogImage(env, p.imageUrl),
        ...(p.imageUrls && p.imageUrls.length > 1
          ? {
              additional_image_link: p.imageUrls
                .slice(1, 10)
                .map((u) => catalogImage(env, u))
                .join(','),
            }
          : {}),
        price: `${p.priceINR.toFixed(2)} INR`,
        // Per size, which is the gain: a sold-out size is unpickable on the
        // product page rather than filtered out afterwards.
        availability: size.stock > 0 ? 'in stock' : 'out of stock',
        condition: 'new',
        brand: 'Reistor',
        /* What makes the sizes one product with a selector. */
        /*
         * Prefixed so it cannot equal a retailer_id.
         *
         * The group id was the bare product id, which is also the retailer_id
         * of the original product-level item still in the catalog. A group
         * whose id collides with a product is a plausible reason Meta accepts
         * the items but will not address them in a message.
         */
        item_group_id: `grp-${p.id}`,
        size: size.size,
      },
    };
  });

  /*
   * Pruning is skipped on a partial sync. `existing` holds every id in the
   * catalog, so a slice would see the sizes it is not carrying as stale and
   * delete the rest of the catalog.
   */
  const stale = prune && !limit ? [...existing].filter((id) => !live.has(id)) : [];

  const requests = [
    ...upserts,
    ...stale.map((id) => ({ method: 'DELETE', data: { id } })),
  ];

  const batches: { status: number; body: unknown }[] = [];
  for (let i = 0; i < requests.length; i += 100) {
    batches.push(
      await graphCall(env, `${catalogId}/items_batch`, {
        method: 'POST',
        body: { item_type: 'PRODUCT_ITEM', requests: requests.slice(i, i + 100) },
      }),
    );
  }

  return {
    variants: all.length,
    created: upserts.filter((r) => r.method === 'CREATE').length,
    updated: upserts.filter((r) => r.method === 'UPDATE').length,
    deleted: stale.length,
    ...(limit ? { offset, sliceSize: slice.length, more: offset + slice.length < all.length } : {}),
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
/**
 * Moves the catalog from whichever WABA holds it to the one that needs it.
 *
 * Meta allows a catalog to be linked to exactly one WhatsApp Business Account,
 * and answers a second link attempt with error_subcode 2388099. A business that
 * has accumulated more than one WABA — a test account, an older one, the live
 * one — therefore has to unlink before it can link, and there is no way to ask
 * "which WABA holds this catalog" directly. So each candidate is read in turn.
 *
 * Deliberately separate from provisionCatalog(), which re-syncs every product
 * after linking. Moving a link is not a reason to push 481 items through the
 * Graph API again, and that sync is what risks the Worker's CPU budget.
 */
export async function relinkCatalog(
  env: Env,
  catalogId: string,
  target: string,
  candidates: string[],
): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = { catalogId, target };

  // Which WABAs currently hold it. Read before anything is changed.
  const holders: string[] = [];
  const inspected: Record<string, unknown> = {};
  for (const waba of candidates) {
    const res = await graphCall(env, `${waba}/product_catalogs?fields=id,name`);
    const data = (res.body as { data?: { id?: string }[] })?.data ?? [];
    inspected[waba] = data.map((c) => c.id);
    if (data.some((c) => c.id === catalogId)) holders.push(waba);
  }
  steps.inspected = inspected;
  steps.heldBy = holders;

  if (holders.includes(target)) {
    steps.result = 'already linked to the target — nothing to do';
    return steps;
  }

  // Unlink from every holder. Usually one, but a stale link would block us.
  const unlinked: Record<string, unknown> = {};
  for (const waba of holders) {
    unlinked[waba] = await graphCall(
      env,
      `${waba}/product_catalogs?catalog_id=${encodeURIComponent(catalogId)}`,
      { method: 'DELETE' },
    );
  }
  steps.unlinked = unlinked;

  steps.linked = await graphCall(env, `${target}/product_catalogs`, {
    method: 'POST',
    body: { catalog_id: catalogId },
  });

  // Read back rather than trusting the write.
  const after = await graphCall(env, `${target}/product_catalogs?fields=id,name`);
  steps.after = after.body;

  return steps;
}


export async function provisionCatalog(
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

  /*
   * Only the first slice. One item per size is thousands of them, which will
   * not finish inside one invocation — /admin/sync walks the rest.
   */
  const products = await getProducts(env);
  steps.items = await syncCatalogItems(env, catalogId, products, { limit: 400, offset: 0 });
  steps.itemCount = products.length;
  steps.next = 'Continue with /admin/sync?offset=400 until "more" reads false.';
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
export const SHOPIFY_TOKEN_KEY = 'shopify:ind:token';
/** Re-mint this far before the token actually dies, so no request races expiry. */
export const SHOPIFY_TOKEN_MARGIN_S = 3 * 3600;

export const shopifyHost = (env: Env) =>
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
export async function shopifyAccessToken(env: Env, force = false): Promise<string | null> {
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
export async function shopifyFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const url = `https://${shopifyHost(env)}/admin/api/${env.IND_SHOPIFY_API_VERSION || '2026-04'}/${path}`;

  // `init.body` is always a string here, so the 401 retry can re-send it — a
  // stream would already be consumed by the first attempt.
  const call = async (token: string) =>
    fetch(url, {
      ...init,
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

/* ------------------------------------------------------------------ *
 * Product metafields (custom images for the PDP / abandonment card)
 * ------------------------------------------------------------------ */

/**
 * One Shopify Admin GraphQL call, on top of the same token handling as
 * shopifyFetch. Metafields are read over GraphQL rather than REST because a
 * `file_reference` stores only a `gid://shopify/MediaImage/…`; resolving that
 * gid to a CDN url in the same round trip is a GraphQL-only trick.
 */
export async function shopifyGraphql(
  env: Env,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ status: number; data?: any; errors?: unknown }> {
  const res = await shopifyFetch(env, 'graphql.json', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  try {
    const body = JSON.parse(text) as { data?: unknown; errors?: unknown };
    return { status: res.status, data: body.data, errors: body.errors };
  } catch {
    return { status: res.status, errors: text.slice(0, 500) };
  }
}

/** The metafield a partner integration reads for its own product artwork. */
export const PDP_IMAGE_METAFIELD_DEFAULT = 'custom.kwikengage_product_image';

/** Long values (a reviews widget is ~10KB of HTML) are cut unless full=1. */
const VALUE_LIMIT = 400;

export interface MetafieldRow {
  /** "namespace.key" — the identifier handed to a partner. */
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
  truncated?: boolean;
  /** Resolved CDN url, present when the value is an image reference. */
  imageUrl?: string;
  width?: number;
  height?: number;
  altText?: string;
  /** Same, for list.file_reference metafields. */
  imageUrls?: string[];
}

const PRODUCT_META_FIELDS = `
  id
  legacyResourceId
  title
  handle
  status
  featuredMedia { ... on MediaImage { image { url } } }
  metafields(first: 100) {
    nodes {
      namespace
      key
      type
      value
      reference {
        ... on MediaImage { id image { url width height altText } }
        ... on GenericFile { id url }
      }
      references(first: 10) {
        nodes {
          ... on MediaImage { id image { url width height altText } }
          ... on GenericFile { id url }
        }
      }
    }
  }
`;

interface RawMetafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
  reference?: { image?: { url?: string; width?: number; height?: number; altText?: string }; url?: string } | null;
  references?: { nodes?: { image?: { url?: string }; url?: string }[] } | null;
}

/** Both shapes of image reference collapse to a plain url. */
const refUrl = (r: RawMetafield['reference']) => r?.image?.url ?? r?.url ?? undefined;

/**
 * Every metafield on one product, with file references resolved to CDN urls.
 *
 * `id` accepts a numeric Shopify product id or a full gid; `handle` is the
 * other way in. Reading the resolved image needs `read_files` on the Shopify
 * app alongside `read_products` — without it Shopify answers the reference
 * field with an access error, which is surfaced in `errors` rather than
 * swallowed.
 */
export async function productMetafields(
  env: Env,
  opts: { id?: string; handle?: string; namespace?: string; key?: string; full?: boolean },
): Promise<Record<string, unknown>> {
  if (!env.IND_SHOPIFY_STORE) return { error: 'Not configured: IND_SHOPIFY_STORE' };
  if (!opts.id && !opts.handle) return { error: 'Pass ?id=<product id> or ?handle=<product handle>' };

  const query = opts.id
    ? `query PM($id: ID!) { product(id: $id) { ${PRODUCT_META_FIELDS} } }`
    : `query PM($q: String!) { products(first: 1, query: $q) { nodes { ${PRODUCT_META_FIELDS} } } }`;

  const variables = opts.id
    ? { id: opts.id.startsWith('gid://') ? opts.id : `gid://shopify/Product/${opts.id}` }
    : { q: `handle:${opts.handle}` };

  const res = await shopifyGraphql(env, query, variables);
  const product = res.data?.product ?? res.data?.products?.nodes?.[0];

  if (!product) {
    return {
      error: 'Product not found',
      lookedUpBy: opts.id ? { id: variables } : { handle: opts.handle },
      status: res.status,
      errors: res.errors,
    };
  }

  const wanted = env.PDP_IMAGE_METAFIELD || PDP_IMAGE_METAFIELD_DEFAULT;

  const all: MetafieldRow[] = (product.metafields?.nodes ?? []).map((m: RawMetafield) => {
    const url = refUrl(m.reference);
    const list = (m.references?.nodes ?? []).map((n) => n.image?.url ?? n.url).filter(Boolean) as string[];
    const long = !opts.full && m.value.length > VALUE_LIMIT;

    return {
      id: `${m.namespace}.${m.key}`,
      namespace: m.namespace,
      key: m.key,
      type: m.type,
      value: long ? `${m.value.slice(0, VALUE_LIMIT)}…` : m.value,
      ...(long ? { truncated: true } : {}),
      ...(url
        ? {
            imageUrl: url,
            width: m.reference?.image?.width,
            height: m.reference?.image?.height,
            altText: m.reference?.image?.altText || undefined,
          }
        : {}),
      ...(list.length ? { imageUrls: list } : {}),
    };
  });

  // `namespace=all` is the escape hatch; the default keeps the reviews and
  // channel-app namespaces out of the way.
  const namespace = opts.namespace ?? 'custom';
  const filtered = all.filter(
    (m) =>
      (namespace === 'all' || m.namespace === namespace) &&
      (!opts.key || m.key === opts.key || m.id === opts.key),
  );

  const custom = all.find((m) => m.id === wanted);
  /*
   * The plain-url twin of the file_reference field. It exists because a REST
   * read of a file_reference hands back a `gid://shopify/MediaImage/…` and
   * nothing else, which a partner integration cannot render — the mirror is
   * the same image as a link anyone can GET. It doubles as the fallback here
   * when the reference itself will not resolve for want of `read_files`.
   */
  const mirrorKey = `${wanted}_url`;
  const mirror = all.find((m) => m.id === mirrorKey);

  return {
    store: env.IND_SHOPIFY_STORE,
    apiVersion: env.IND_SHOPIFY_API_VERSION,
    product: {
      id: String(product.legacyResourceId),
      gid: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      productUrl: `https://reistor.in/products/${product.handle}`,
      featuredImage: product.featuredMedia?.image?.url ?? null,
    },
    // The one field the abandonment card is after, lifted out of the list so
    // it can be read without walking it.
    customImage: {
      metafield: wanted,
      found: Boolean(custom),
      type: custom?.type ?? null,
      value: custom?.value ?? null,
      imageUrl: custom?.imageUrl ?? mirror?.value ?? null,
      width: custom?.width ?? null,
      height: custom?.height ?? null,
      urlMetafield: mirrorKey,
      urlFound: Boolean(mirror),
      url: mirror?.value ?? null,
    },
    filter: { namespace, key: opts.key ?? null },
    count: filtered.length,
    totalOnProduct: all.length,
    metafields: filtered,
    ...(res.errors ? { errors: res.errors } : {}),
  };
}
