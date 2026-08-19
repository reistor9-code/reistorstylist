import type { Product } from './catalog.js';
import { cap } from './copy.js';
import { inStockSizes, occasionPhrase } from './catalog.js';

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

