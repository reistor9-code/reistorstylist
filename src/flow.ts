import type { Env, State } from './types';
import type { Product } from './catalog';
import { COPY, cap, fill, formatINR } from './copy';
import {
  CATEGORIES,
  OCCASIONS,
  categoryLabel,
  checkoutUrl,
  filterProducts,
  getProducts,
  inStockSizes,
  occasionLabel,
  occasionPhrase,
} from './catalog';
import { rankLooks } from './ranking';
import {
  sendButtons,
  sendCarouselTemplate,
  sendCatalogMessage,
  sendCtaUrl,
  sendList,
  sendProductCarousel,
  sendSingleProduct,
  sendText,
} from './whatsapp';

export const STATE_TTL_SECONDS = 60 * 60 * 24 * 7;

export function freshState(): State {
  return {
    step: 'welcome',
    offset: 0,
    shownLookIds: [],
    rankedIds: [],
    reasons: {},
    updatedAt: Date.now(),
  };
}

export async function loadState(env: Env, waId: string): Promise<State> {
  const raw = await env.STATE.get(`state:${waId}`);
  if (!raw) return freshState();
  try {
    return { ...freshState(), ...(JSON.parse(raw) as Partial<State>) };
  } catch {
    return freshState();
  }
}

export async function saveState(env: Env, waId: string, state: State): Promise<void> {
  state.updatedAt = Date.now();
  await env.STATE.put(`state:${waId}`, JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

export async function clearState(env: Env, waId: string): Promise<void> {
  await env.STATE.delete(`state:${waId}`);
}


/* ------------------------------------------------------------------ *
 * Flow steps
 * ------------------------------------------------------------------ */

export async function askOccasion(env: Env, to: string, state: State): Promise<void> {
  state.step = 'occasion';

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

export async function askCategory(env: Env, to: string, state: State): Promise<void> {
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
export async function sendLooks(
  env: Env,
  to: string,
  state: State,
  all: Product[],
  lead?: string,
): Promise<number> {
  const byId = new Map(all.map((p) => [p.id, p]));
  // Read before the cursor moves — the menu under the carousel differs between
  // the opening three picks and every batch after them.
  const firstBatch = state.offset === 0;
  const slice = state.rankedIds.slice(state.offset, state.offset + 3);
  const products = slice.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p));

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

  /*
   * Looks go out as product messages only — the carousel card's View opens
   * WhatsApp's PDP, which is where the image gallery lives. Falling back to
   * plain image messages was dropping shoppers into a dead end with no PDP
   * and no way through, so a rejected send now says so and offers a route on.
   */
  if (!sentAsProduct) {
    console.log('[product-message:rejected]', products.length, `catalog=${env.CATALOG_ID ?? 'unset'}`);
    await sendButtons(env, to, COPY.looksUnavailable, [
      { id: 'act:more', title: 'Show More Looks' },
      { id: 'act:main_menu', title: 'Main Menu' },
      { id: 'act:callback', title: 'Talk to Stylist' },
    ]);
  }

  if (sentAsProduct) {
    /*
     * Product cards carry a fixed View button and take no extras, so the
     * onward actions have to ride in their own message under the carousel.
     *
     * The menu differs between the two batches. The opening picks offer one
     * way on — more looks — since the catalogue is a detour before anyone has
     * seen a second round. After that round the ranked edit is usually spent,
     * so paging again would dead-end; the second menu drops it and offers the
     * catalogue or a restart instead.
     */
    await sendButtons(
      env,
      to,
      COPY.whatNext,
      firstBatch
        ? [{ id: 'act:more', title: 'Show More Looks' }]
        : [
            { id: 'act:catalog', title: 'Browse Catalog' },
            { id: 'act:main_menu', title: 'Main Menu' },
            { id: 'act:callback', title: 'Talk to Stylist' },
          ],
    );
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
export function widenCandidates(
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

export async function runBackend(env: Env, to: string, state: State): Promise<void> {
  const all = await getProducts(env);
  const { products: candidates, intro } = widenCandidates(all, state.occasion, state.category);

  if (candidates.length === 0) {
    // Only reachable when every product in the catalog is sold out.
    state.step = 'occasion';
    await sendButtons(env, to, COPY.nothingInStock, [
      { id: 'act:restart_occasion', title: 'Pick Occasion' },
      { id: 'act:callback', title: 'Talk to Stylist' },
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

export async function showMoreLooks(env: Env, to: string, state: State): Promise<void> {
  const all = await getProducts(env);

  if (state.offset >= state.rankedIds.length) {
    await sendButtons(env, to, COPY.noMoreLooks, [
      { id: 'act:browse', title: 'Browse Category' },
      { id: 'act:callback', title: 'Talk to Stylist' },
      { id: 'act:main_menu', title: 'Main Menu' },
    ]);
    return;
  }

  await sendText(env, to, COPY.moreLooksIntro);
  const sent = await sendLooks(env, to, state, all);

  if (sent === 0) {
    await sendText(env, to, COPY.noMoreLooks);
    return;
  }

  // sendLooks already put this batch's menu under the carousel. A second one
  // here would re-offer Show More on the very batch that drops it.
  state.step = 'top3';
}

export async function askSize(env: Env, to: string, state: State, product: Product): Promise<void> {
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

export async function sendCheckout(
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

export async function confirmOrder(env: Env, to: string, state: State): Promise<void> {
  state.step = 'done';
  await sendButtons(env, to, COPY.orderConfirmed, [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);

}

/**
 * The catalogue card, with one way back.
 *
 * WhatsApp's catalogue always opens on everything — `catalog_message` takes a
 * thumbnail id and nothing else, with no collection parameter — so the card
 * cannot be scoped to the shopper's category. The thumbnail is drawn from
 * that category instead, which is as close to a scoped card as the API allows.
 *
 * Main Menu rides in its own message: the catalogue card carries a fixed
 * "View catalogue" button and accepts no extras.
 */
export async function openCatalogue(
  env: Env,
  to: string,
  state: State,
  all: Product[],
): Promise<void> {
  const cover =
    filterProducts(all, undefined, state.category)[0]?.id ??
    state.currentLookId ??
    state.rankedIds[0] ??
    filterProducts(all)[0]?.id;

  const sent = cover ? await sendCatalogMessage(env, to, COPY.browseCatalog, cover) : false;
  if (!sent) console.log('[catalog-message:rejected]', `catalog=${env.CATALOG_ID ?? 'unset'}`);

  await sendButtons(env, to, sent ? COPY.whatNext : COPY.catalogUnavailable, [
    { id: 'act:main_menu', title: 'Main Menu' },
  ]);
}
