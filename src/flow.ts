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
import { rankLayers } from './ranking';
import {
  LIMITS,
  sendButtons,
  sendCarouselTemplate,
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
    // A new journey each time the flow restarts, so the funnel counts a
    // shopper who comes back next week as a second session rather than
    // reopening the first one.
    sessionId: crypto.randomUUID(),
    offset: 0,
    shownLookIds: [],
    rankedIds: [],
    reasons: {},
    /*
     * Named explicitly even though they are empty.
     *
     * Resets are done with Object.assign(state, freshState()), which copies
     * only the keys freshState() HAS — so a field omitted here survives every
     * reset, which is how stale picks outlived Main Menu.
     */
    currentLookId: undefined,
    occasion: undefined,
    category: undefined,
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

  /*
   * One category template per occasion. The same six categories are described
   * differently for a meeting than for a beach, and card copy is frozen at
   * approval — so the wording can only vary by sending a different template.
   *
   * Names follow `<base>_<occasionId>`: category_picker_work, _vacation,
   * _casual, _dinner, _lounge. The shared base is the fallback for a session
   * with no occasion set, and for a per-occasion template that is missing or
   * paused — that send is rejected, and the code below drops to a typed
   * prompt rather than leaving the shopper with nothing.
   */
  const base = env.CATEGORY_TEMPLATE || 'category_picker';
  const cards = CATEGORIES.map((c) => ({
    imageUrl: c.image,
    bodyParams: [],
    payload: `cat:${c.id}`,
  }));

  if (state.occasion) {
    const perOccasion = `${base}_${state.occasion}`;
    if (await sendCarouselTemplate(env, to, perOccasion, cards)) return;
    console.log('[carousel:rejected]', perOccasion, '— falling back to', base);
  }

  if (await sendCarouselTemplate(env, to, base, cards)) return;

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
            { id: 'act:catalog', title: 'Browse Category' },
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
  const { intro } = widenCandidates(all, state.occasion, state.category);

  /*
   * Two layers, and CATEGORY IS NEVER RELAXED: the exact brief first, then the
   * same category for any occasion.
   *
   * An earlier version also fell through to "same occasion, any category" and
   * then to the whole shelf, which is how a shopper who asked for Bottoms was
   * shown a dress and two tops under a header still reading "Dinner Date ·
   * Bottoms". Occasion is a soft preference; category is what they actually
   * chose, and widening it makes the recommendation look broken.
   *
   * Layering still gives "Show More Looks" somewhere to go — there are far
   * more bottoms in the catalogue than bottoms tagged for one occasion.
   */
  const layers = [
    filterProducts(all, state.occasion, state.category),
    filterProducts(all, undefined, state.category),
  ];
  const candidates = layers.flat();

  if (candidates.length === 0) {
    // Only reachable when every product in the catalog is sold out.
    state.step = 'occasion';
    await sendButtons(env, to, COPY.nothingInStock, [
      { id: 'act:restart_occasion', title: 'Pick Occasion' },
      { id: 'act:callback', title: 'Talk to Stylist' },
    ]);
    return;
  }

  const ranking = rankLayers(layers, state.occasion);
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

  // Nothing follows the button. The shopper is about to be in a browser
  // typing card details, and a second message there is noise at best.
}

export async function confirmOrder(env: Env, to: string, state: State): Promise<void> {
  state.step = 'done';
  await sendButtons(env, to, COPY.orderConfirmed, [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);

}

/**
 * The category deep-dive, behind the Browse Category button.
 *
 * This used to send `catalog_message`, which could only ever open WhatsApp's
 * entire catalogue — the message takes a thumbnail id and nothing else, with
 * no collection parameter, so a shopper who asked for Tops was handed all of
 * it. A product carousel can be scoped, so the button now delivers what its
 * name promises: up to ten more pieces from the shopper's own occasion and
 * category.
 *
 * Every card still opens WhatsApp's own PDP, so Add to cart is unaffected.
 *
 * The six already shown are skipped. Ranked ids come first so the better
 * matches lead, with anything the ranking never reached appended after them.
 */
export async function browseCategory(
  env: Env,
  to: string,
  state: State,
  all: Product[],
): Promise<void> {
  const seen = new Set(state.shownLookIds);
  const inBrief = filterProducts(all, state.occasion, state.category);
  const briefIds = new Set(inBrief.map((p) => p.id));
  const ranked = new Set(state.rankedIds);

  const ordered = [
    ...state.rankedIds.filter((id) => briefIds.has(id) && !seen.has(id)),
    ...inBrief.filter((p) => !seen.has(p.id) && !ranked.has(p.id)).map((p) => p.id),
  ];

  const onward = [
    { id: 'act:main_menu', title: 'Main Menu' },
    { id: 'act:callback', title: 'Talk to Stylist' },
  ];

  /*
   * Meta rejects a carousel with fewer than two cards, and a single leftover
   * piece is not worth a message of its own after six the shopper has already
   * turned down. Both cases end the edit rather than limping on.
   */
  if (ordered.length < 2) {
    const body = fill(COPY.categoryExhausted, {
      occasion: occasionLabel(state.occasion),
      category: categoryLabel(state.category),
    });
    await sendButtons(env, to, body, onward);
    return;
  }

  const picks = ordered.slice(0, 10);
  const body = fill(COPY.categoryMore, {
    occasion: occasionLabel(state.occasion),
    category: categoryLabel(state.category),
  });

  const sent = await sendProductCarousel(env, to, body, picks);

  if (!sent) {
    console.log('[browse-category:rejected]', picks.length, `catalog=${env.CATALOG_ID ?? 'unset'}`);
    await sendButtons(env, to, COPY.looksUnavailable, onward);
    return;
  }

  // Recorded so a second Browse Category pages deeper rather than repeating,
  // and so the abandoned-cart sweep knows what this shopper actually saw.
  for (const id of picks) {
    if (!state.shownLookIds.includes(id)) state.shownLookIds.push(id);
  }

  // Product cards carry a fixed View button and take no extras, so the onward
  // actions ride in their own message. Browse Category is deliberately absent
  // — it has just been used, and re-offering it would loop the shopper back
  // onto the carousel they are looking at.
  await sendButtons(env, to, COPY.whatNext, onward);
}


/**
 * More than one piece in the bag. Sizes are per garment, so they are worked
 * one at a time — the row id runs into the same `look:` handler the size list
 * hangs off.
 */
/**
 * Asks which garment to size next.
 *
 * No greeting here: this is called once per remaining piece, and repeating
 * "Your bag is here" on the third pass reads as if the flow has restarted.
 * The body carries the count instead, so the shopper can see the list is
 * finite and shrinking rather than looping forever.
 */
export async function askCartPick(
  env: Env,
  to: string,
  state: State,
  items: Product[],
  sized = 0,
): Promise<void> {
  const total = sized + items.length;
  await sendList(env, to, {
    header: COPY.sizeHeader,
    body: sized
      ? fill(COPY.cartPickNext, { done: String(sized), total: String(total) })
      : COPY.cartPick,
    button: 'Pick item',
    rows: items.slice(0, LIMITS.maxRows).map((p) => ({
      id: `look:${p.id}`,
      title: p.title,
      description: `${formatINR(p.priceINR)} · ${cap(p.fabric)}`,
    })),
  });
}
