import type { Env } from './types';
import { CATEGORIES, OCCASIONS, SHOPIFY_CACHE_KEY, filterProducts, getProducts, isInStock, productMetafields, provisionCatalog, shopifyFetch, shopifyHost } from './catalog';
import { COPY } from './copy';
import { graphCall } from './whatsapp';

/* ------------------------------------------------------------------ *
 * Carousel template provisioning (one-off, via /admin/templates)
 * ------------------------------------------------------------------ */

/**
 * Meta's resumable upload: open a session against the APP, PUSH the bytes, get
 * back an opaque handle. Card headers need one of these as their approval-time
 * example image (real images are supplied per-card at send time).
 */
export async function uploadExampleImage(env: Env, appId: string, imageUrl: string): Promise<string> {
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



export async function sampleShopify(env: Env, limit: number): Promise<Record<string, unknown>> {
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
export async function surveyCatalogs(env: Env, business: string): Promise<Record<string, unknown>> {
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
export async function diagnoseProducts(
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

export async function createTemplate(
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
export function carouselCards(
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

export function carouselTemplate(
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
export async function updateCarouselTemplates(
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
export async function createCarouselTemplates(env: Env, waba: string, appId: string, suffix?: string) {
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


/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Every /admin route, all gated on VERIFY_TOKEN. These are one-off setup and
 * diagnostic helpers rather than part of the shopper flow.
 *
 * Returns null when the path is not an admin route, so the caller falls
 * through to the webhook.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  path: string,
): Promise<Response | null> {
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
    /*
     * WhatsApp Commerce Settings for this phone number.
     *
     * A catalog can be linked to the WABA and still be hidden in chat, which
     * makes `catalog_message` fail with (#131009) while product messages and
     * the PDP keep working. This reads the flags, and with &enable=1 turns the
     * catalog and cart on.
     *
     *   /admin/commerce?token=<VERIFY_TOKEN>[&enable=1][&cart=0]
     */
    /*
     * Creates a product set per category, which WhatsApp renders as
     * Collections inside the catalogue view.
     *
     * Run /admin/catalog first — the sets filter on `product_type`, which the
     * sync writes, so items uploaded before that field existed match nothing.
     *
     *   /admin/sets?token=<VERIFY_TOKEN>[&catalog=<CATALOG_ID>]
     */
    if (path === '/admin/sets' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const catalogId = url.searchParams.get('catalog') ?? env.CATALOG_ID;
      if (!catalogId) {
        return new Response('Missing ?catalog=<CATALOG_ID> and CATALOG_ID is unset', {
          status: 400,
        });
      }

      const listed = await graphCall(env, `${catalogId}/product_sets?fields=name&limit=100`);
      const existing = new Set(
        ((listed.body as { data?: { name: string }[] })?.data ?? []).map((set) => set.name),
      );

      const results: Record<string, unknown> = {};
      for (const category of CATEGORIES) {
        if (existing.has(category.label)) {
          results[category.label] = 'already exists';
          continue;
        }
        const created = await graphCall(env, `${catalogId}/product_sets`, {
          method: 'POST',
          body: {
            name: category.label,
            filter: JSON.stringify({ product_type: { eq: category.label } }),
          },
        });
        results[category.label] = created;
      }

      const after = await graphCall(env, `${catalogId}/product_sets?fields=name,product_count&limit=100`);
      const result = { catalogId, existingBefore: [...existing], results, after };
      console.log('[admin:sets]', JSON.stringify(result));
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (path === '/admin/commerce' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }

      const version = env.GRAPH_API_VERSION || 'v21.0';
      const base = `https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/whatsapp_commerce_settings`;
      const auth = { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` };
      const call = async (init?: RequestInit, query = '') => {
        const res = await fetch(base + query, { ...init, headers: auth });
        const text = await res.text();
        try {
          return { status: res.status, body: JSON.parse(text) };
        } catch {
          return { status: res.status, body: text };
        }
      };

      const before = await call();
      let update: { status: number; body: unknown } | undefined;
      if (url.searchParams.get('enable')) {
        const cart = url.searchParams.get('cart') === '0' ? 'false' : 'true';
        update = await call(
          { method: 'POST' },
          `?is_catalog_visible=true&is_cart_enabled=${cart}`,
        );
      }
      const after = update ? await call() : undefined;

      const result = { phoneNumberId: env.PHONE_NUMBER_ID, before, update, after };
      console.log('[admin:commerce]', JSON.stringify(result));
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

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

    /*
     * Read-only: every metafield on one product, with `file_reference` values
     * resolved from a `gid://shopify/MediaImage/…` to a CDN url — which is the
     * part a plain REST read cannot do.
     *
     * This is what a partner integration (the PDP abandonment card) reads to
     * pick up bespoke artwork per product instead of the catalogue shot.
     *
     *   /admin/metafields?token=<VERIFY_TOKEN>&id=<PRODUCT_ID>
     *   /admin/metafields?token=<VERIFY_TOKEN>&handle=<PRODUCT_HANDLE>
     *
     * Optional: &namespace=custom|all (default custom), &key=<key>, and
     * &full=1 to stop long values being truncated.
     */
    if (path === '/admin/metafields' && request.method === 'GET') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }

      const result = await productMetafields(env, {
        id: url.searchParams.get('id') ?? undefined,
        handle: url.searchParams.get('handle') ?? undefined,
        namespace: url.searchParams.get('namespace') ?? undefined,
        key: url.searchParams.get('key') ?? undefined,
        full: url.searchParams.get('full') === '1',
      });

      return new Response(JSON.stringify(result, null, 2), {
        status: result.error ? 400 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }

  return null;
}
