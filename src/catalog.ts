/**
 * The catalog seam.
 *
 * Every product read in the bot goes through `getProducts`. Behind it sits
 * either Shopify (when SHOPIFY_SHOP and SHOPIFY_TOKEN are set) or the bundled
 * mock file, so the flow runs end to end before the store integration exists.
 *
 * `retailerId` is the join key to the Meta Commerce Catalog. Single-product
 * messages, multi-product messages and product carousels all address items by
 * it, and it must match the `id` column of the feed synced into Commerce
 * Manager. Shopify's variant SKU is the natural choice; whatever you pick, the
 * two systems have to agree or the product simply will not render.
 */

import type { Env } from './env';
import mock from './products.json';

export interface SizeStock {
  size: string;
  stock: number;
}

export interface Product {
  /** Stable internal id, used in reply payloads. */
  id: string;
  /** Join key to the Meta Commerce Catalog feed. */
  retailerId: string;
  title: string;
  occasionTags: string[];
  category: string;
  fabric: string;
  attributes: string;
  priceINR: number;
  /** Pre-formatted with Indian digit grouping, for copy that quotes a price. */
  priceFormatted: string;
  sizes: SizeStock[];
  imageUrl: string;
  productUrl: string;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/**
 * Indian digit grouping without depending on the runtime's ICU data, which a
 * Worker does not reliably carry. ₹2,499 · ₹1,25,000.
 */
export function formatINR(amount: number): string {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return `₹${digits}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `₹${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

export const isInStock = (p: Product) => p.sizes.some((s) => s.stock > 0);

export const inStockSizes = (p: Product) =>
  p.sizes
    .filter((s) => s.stock > 0)
    .map((s) => s.size)
    .sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

/* ------------------------------------------------------------------ *
 * Shopify
 * ------------------------------------------------------------------ */

const SHOPIFY_QUERY = `
query Catalog($cursor: String) {
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
      title
      productType
      tags
      onlineStoreUrl
      featuredImage { url }
      carouselImage: metafield(namespace: "custom", key: "whatsapp_carousel_image") {
        reference { ... on MediaImage { image { url } } }
      }
      fabric: metafield(namespace: "custom", key: "fabric") { value }
      occasions: metafield(namespace: "custom", key: "occasions") { value }
      variants(first: 20) {
        nodes {
          sku
          title
          price
          availableForSale
          inventoryQuantity
          selectedOptions { name value }
        }
      }
    }
  }
}`;

interface ShopifyVariant {
  sku: string | null;
  title: string;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
}

interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  productType: string | null;
  tags: string[];
  onlineStoreUrl: string | null;
  featuredImage: { url: string } | null;
  carouselImage: { reference?: { image?: { url: string } } } | null;
  fabric: { value: string } | null;
  occasions: { value: string } | null;
  variants: { nodes: ShopifyVariant[] };
}

/** Shopify's product type maps onto the bot's category ids. */
const CATEGORY_BY_TYPE: Record<string, string> = {
  top: 'tops',
  tops: 'tops',
  shirt: 'tops',
  blouse: 'tops',
  dress: 'dresses',
  dresses: 'dresses',
  bottom: 'bottoms',
  bottoms: 'bottoms',
  trouser: 'bottoms',
  trousers: 'bottoms',
  skirt: 'bottoms',
  jacket: 'jackets',
  jackets: 'jackets',
  jumpsuit: 'jumpsuits',
  jumpsuits: 'jumpsuits',
  coord: 'coords',
  'co-ord': 'coords',
  'co-ord set': 'coords',
};

const OCCASION_IDS = ['work', 'vacation', 'casual', 'dinner', 'lounge'];

function categoryOf(p: ShopifyProduct): string {
  const type = (p.productType || '').trim().toLowerCase();
  if (CATEGORY_BY_TYPE[type]) return CATEGORY_BY_TYPE[type];
  // Fall back to a tag like "category:tops".
  const tag = p.tags.find((t) => t.toLowerCase().startsWith('category:'));
  if (tag) return tag.slice(9).trim().toLowerCase();
  return 'tops';
}

function occasionsOf(p: ShopifyProduct): string[] {
  // A metafield wins if present; it is the deliberate signal.
  if (p.occasions?.value) {
    try {
      const parsed = JSON.parse(p.occasions.value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).toLowerCase());
    } catch {
      return p.occasions.value
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  // Otherwise read "occasion:work" tags.
  const fromTags = p.tags
    .filter((t) => t.toLowerCase().startsWith('occasion:'))
    .map((t) => t.slice(9).trim().toLowerCase());
  return fromTags.length ? fromTags : OCCASION_IDS.slice(0, 1);
}

function sizeOf(v: ShopifyVariant): string {
  const opt = v.selectedOptions.find((o) => /size/i.test(o.name));
  return (opt?.value ?? v.title ?? '').trim().toUpperCase();
}

function mapShopify(p: ShopifyProduct): Product | null {
  const variants = p.variants.nodes.filter((v) => sizeOf(v));
  if (!variants.length) return null;

  // The variant SKU is the retailer id in the Meta feed. Without one the item
  // cannot be addressed by any product-backed message, so it is skipped rather
  // than sent as a card that will render empty.
  const retailerId = variants.find((v) => v.sku)?.sku;
  if (!retailerId) {
    console.log('[catalog:no-sku]', p.handle);
    return null;
  }

  const price = Number(variants[0].price) || 0;

  return {
    id: p.handle,
    retailerId,
    title: p.title,
    occasionTags: occasionsOf(p),
    category: categoryOf(p),
    fabric: (p.fabric?.value || '').toLowerCase() || 'cotton',
    attributes: p.tags.filter((t) => !t.includes(':')).join(', '),
    priceINR: price,
    priceFormatted: formatINR(price),
    sizes: variants.map((v) => ({
      size: sizeOf(v),
      stock: v.availableForSale ? Math.max(1, v.inventoryQuantity ?? 1) : 0,
    })),
    imageUrl:
      p.carouselImage?.reference?.image?.url ||
      p.featuredImage?.url ||
      '',
    productUrl: p.onlineStoreUrl || `https://reistor.in/products/${p.handle}`,
  };
}

async function fetchShopify(env: Env): Promise<Product[]> {
  const version = env.SHOPIFY_API_VERSION || '2026-07';
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${version}/graphql.json`;

  const out: Product[] = [];
  let cursor: string | null = null;

  // Paginate rather than assuming the catalog fits one page.
  for (let page = 0; page < 20; page++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': env.SHOPIFY_TOKEN as string,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: SHOPIFY_QUERY, variables: { cursor } }),
    });

    if (!res.ok) throw new Error(`shopify ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as {
      data?: { products?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ShopifyProduct[] } };
      errors?: unknown;
    };

    if (json.errors) throw new Error(`shopify errors: ${JSON.stringify(json.errors)}`);

    const block = json.data?.products;
    if (!block) break;

    for (const node of block.nodes) {
      const mapped = mapShopify(node);
      if (mapped) out.push(mapped);
    }

    if (!block.pageInfo.hasNextPage) break;
    cursor = block.pageInfo.endCursor;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

const CACHE_KEY = 'catalog:v1';
const CACHE_TTL_SECONDS = 300;

/**
 * Resolves a bundled image path to a public https URL.
 *
 * Images in `public/looks/` ship as Worker static assets, so their real address
 * is only known once the Worker is deployed. products.json therefore stores a
 * relative path and it is made absolute here against PUBLIC_BASE_URL.
 *
 * Meta fetches every image server-side, so a relative path or a localhost URL
 * silently fails the send — which is why an unset base URL falls back to a
 * placeholder rather than shipping a broken link.
 */
/**
 * The origin this Worker was reached on, learned from the first request.
 *
 * Without it the first deploy is a chicken-and-egg: the hostname does not exist
 * until Wrangler has published, so PUBLIC_BASE_URL cannot be set beforehand and
 * images would be broken until a second deploy. Reading it off the inbound
 * request means product photographs work on the very first deploy, with the
 * config var left as an override for a custom domain.
 */
let runtimeOrigin: string | null = null;

export function setRuntimeOrigin(origin: string): void {
  if (!runtimeOrigin && /^https:\/\//i.test(origin)) runtimeOrigin = origin;
}

export function resolveImage(env: Env, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;

  // An explicit setting wins — a custom domain will not match the request host
  // once one is in front of the Worker.
  const base = (env.PUBLIC_BASE_URL || runtimeOrigin)?.replace(/\/+$/, '');
  if (base) return `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  // Only reachable before any request has landed. Meta fetches images
  // server-side, so a relative path would fail the send outright.
  console.log('[catalog:no-base-url] falling back to a placeholder image');
  return `https://picsum.photos/seed/${encodeURIComponent(path)}/800/1000`;
}

/** Shapes the bundled file into Product, so both sources look identical. */
function mockProducts(env: Env): Product[] {
  return (mock as Omit<Product, 'priceFormatted'>[]).map((p) => ({
    ...p,
    retailerId: p.retailerId ?? p.id,
    priceFormatted: formatINR(p.priceINR),
    imageUrl: resolveImage(env, p.imageUrl),
  }));
}

/**
 * The whole in-stock-capable catalog.
 *
 * Cached in KV for five minutes: a browsing shopper triggers several reads per
 * message, and Shopify's Admin API is rate limited per app, not per shopper.
 * A Shopify failure falls back to the last good cache, then to the mock file —
 * a store outage degrades the bot rather than breaking it.
 */
export async function getProducts(env: Env): Promise<Product[]> {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_TOKEN) return mockProducts(env);

  try {
    const cached = await env.STATE.get(CACHE_KEY, 'json');
    if (cached) return cached as Product[];
  } catch {
    /* A bad cache entry is not worth failing the request over. */
  }

  try {
    const live = await fetchShopify(env);
    if (live.length) {
      await env.STATE.put(CACHE_KEY, JSON.stringify(live), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
      return live;
    }
    console.log('[catalog:empty] shopify returned no usable products');
  } catch (err) {
    console.log('[catalog:error]', String(err));
  }

  return mockProducts(env);
}

/** Looks a product up by internal id or by retailer id — callers have either. */
export async function getProduct(env: Env, key: string): Promise<Product | null> {
  const all = await getProducts(env);
  return all.find((p) => p.id === key || p.retailerId === key) ?? null;
}

export function filterProducts(
  all: Product[],
  occasion?: string,
  category?: string,
): Product[] {
  return all.filter(
    (p) =>
      isInStock(p) &&
      (!occasion || p.occasionTags.includes(occasion)) &&
      (!category || p.category === category),
  );
}

/** GoKwik / reistor.in deep link for one size. */
export function checkoutUrl(product: Product, size: string): string {
  const url = new URL(product.productUrl);
  url.searchParams.set('variant', size);
  url.searchParams.set('utm_source', 'whatsapp');
  url.searchParams.set('utm_medium', 'ai-stylist');
  return url.toString();
}

