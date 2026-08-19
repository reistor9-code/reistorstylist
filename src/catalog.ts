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

export const occasionLabel = (id?: string) => OCCASIONS.find((o) => o.id === id)?.label ?? 'this occasion';
export const occasionPhrase = (id?: string) => OCCASIONS.find((o) => o.id === id)?.phrase ?? 'the day ahead';
export const categoryLabel = (id?: string) => CATEGORIES.find((c) => c.id === id)?.label ?? 'this category';

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
  const url = new URL(product.productUrl);
  url.searchParams.set('variant', size);
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

export async function syncCatalogItems(
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
      // Collections are product sets filtered on a field, so the category has
      // to exist on the item itself. This is what groups the catalogue into
      // Tops / Dresses / Bottoms in WhatsApp.
      product_type: categoryLabel(p.category),
      image_url: catalogImage(env, p.imageUrl),
      // Extras beyond the primary become the PDP's swipeable gallery. Meta
      // caps a product at 10 images, so the primary plus 9 additional.
      ...(p.imageUrls && p.imageUrls.length > 1
        ? { additional_image_urls: p.imageUrls.slice(1, 10).map((u) => catalogImage(env, u)) }
        : {}),
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
