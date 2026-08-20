import type { Product } from './catalog';
import { cap } from './copy';
import { inStockSizes, occasionPhrase } from './catalog';

/* ------------------------------------------------------------------ *
 * Ranking
 *
 * Plain backend logic, no model call: the edit is curated by hand upstream,
 * so the order is predictable, instant and free, and every reason is written
 * to the brand copy rules by construction.
 * ------------------------------------------------------------------ */


/** Deterministic, copy-rule-safe one-liner shown under every look. */
export function lookReason(p: Product, occasion?: string): string {
  const parts = p.attributes.split(',').map((s) => s.trim());
  const detail = parts[1] ?? parts[0];
  return `${cap(p.fabric)}, ${detail} — cut for ${occasionPhrase(occasion)}.`;
}

/** Broadest size availability first, then price. */
export function rankOrder(candidates: Product[]): Product[] {
  return [...candidates].sort((a, b) => {
    const diff = inStockSizes(b).length - inStockSizes(a).length;
    return diff !== 0 ? diff : a.priceINR - b.priceINR;
  });
}

export interface Ranking {
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
export function rankLooks(candidates: Product[], occasion?: string): Ranking {
  const order = rankOrder(candidates).map((p) => p.id);
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const reasons: Record<string, string> = {};

  for (const id of order) {
    reasons[id] = lookReason(byId.get(id)!, occasion);
  }

  return { order, reasons };
}


/* ------------------------------------------------------------------ *
 * Variety
 * ------------------------------------------------------------------ */

/**
 * Colour words, stripped to find the garment underneath.
 *
 * "V neck Drawstring Knit Romper in Black" and "V-neck Drawstring Knit Romper
 * in Earth Grey" are one style in two colourways. They carry identical stock
 * and price, so any sort puts them side by side — and a shopper shown three
 * looks where two are the same garment has really been shown two.
 */
const COLOUR_WORDS =
  /\b(black|white|off[- ]?white|ecru|ivory|cream|beige|tan|brown|grey|gray|charcoal|navy|blue|denim|indigo|teal|green|olive|sage|khaki|mustard|yellow|gold|orange|rust|terracotta|red|maroon|burgundy|pink|blush|rose|lilac|lavender|purple|mauve|earth|stone|sand|natural|multi|printed?|stripes?|striped)\b/gi;

export function styleKey(title: string): string {
  return title
    .toLowerCase()
    // "… in Earth Grey" — everything after the colour preposition.
    .replace(/\s+in\s+[^,]*$/, '')
    .replace(COLOUR_WORDS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Spreads colourways so consecutive picks are different garments.
 *
 * Groups keep the order they arrived in, so the ranking still decides quality;
 * the round-robin only decides which of two equally-ranked colourways is shown
 * now and which waits for the next round.
 */
export function diversify(products: Product[]): Product[] {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const key = styleKey(p.title) || p.id;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }

  const out: Product[] = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const group of groups.values()) {
      const next = group.shift();
      if (next) {
        out.push(next);
        moved = true;
      }
    }
  }
  return out;
}

/**
 * Ranks each layer of the brief separately and concatenates them.
 *
 * The exact occasion × category match leads, then progressively looser
 * matches behind it. Ranking the whole pool at once would let a loose match
 * with broad sizing outrank an exact one — and layering is what stops
 * "Show More Looks" dead-ending after a single round on a thin pair.
 */
export function rankLayers(layers: Product[][], occasion?: string): Ranking {
  const seen = new Set<string>();
  const order: string[] = [];
  const reasons: Record<string, string> = {};

  for (const layer of layers) {
    const fresh = layer.filter((p) => !seen.has(p.id));
    for (const p of diversify(rankOrder(fresh))) {
      seen.add(p.id);
      order.push(p.id);
      reasons[p.id] = lookReason(p, occasion);
    }
  }

  return { order, reasons };
}
