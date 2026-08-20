/**
 * Demand vs catalog — the occasion × category grid.
 *
 * The most useful cells are the red ones: a pair shoppers asked for that the
 * catalogue could not answer. A blank cell is not a zero, it is a question
 * nobody asked in this window, and the two must not look alike.
 */

import type { DemandCell } from '../queries.js';
import { cardHead, n, note } from './format.js';

/** Row and column order is fixed so the grid reads the same every render. */
const OCCASIONS = ['work', 'vacation', 'casual', 'dinner', 'lounge'] as const;
const CATEGORIES = ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'] as const;

const MISS_THRESHOLD = 0.5;

function cell(c: DemandCell | undefined, maxRequests: number): string {
  if (!c) return '<td></td>';

  const missRate = c.requests ? c.hadNothing / c.requests : 0;
  // Floor of 10% so a cell with a single request is still visible, ceiling
  // around 52% so the darkest cell never swamps the text on top of it.
  const heat = Math.round((0.1 + (c.requests / maxRequests) * 0.42) * 100);
  const tint = missRate >= MISS_THRESHOLD ? '--bad' : '--peri';

  return `<td style="background:color-mix(in srgb,var(${tint}) ${heat}%,transparent);color:var(--text)"
        title="${c.requests} asked · ${c.hadNothing} had nothing · ${c.orders} ordered">
        ${n(c.requests)}<span class="sm">${
          c.hadNothing ? `${c.hadNothing} empty` : `${n(c.orders)} sold`
        }</span></td>`;
}

export function renderDemand(demandGrid: DemandCell[]): string {
  const grid = demandGrid || [];
  const byKey = new Map(grid.map((c) => [`${c.occasion}|${c.category}`, c]));
  const maxRequests = Math.max(1, ...grid.map((c) => c.requests));

  const head = `<tr><th class="rh"></th>${CATEGORIES.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const rows = OCCASIONS.map(
    (o) =>
      `<tr><td class="rh">${o}</td>${CATEGORIES.map((c) =>
        cell(byKey.get(`${o}|${c}`), maxRequests),
      ).join('')}</tr>`,
  ).join('');

  return `<section class="card c7" id="demand">
  ${cardHead('Demand vs catalog', 'what they asked for')}
  <div class="heat"><table>
    ${head}
    ${rows}
  </table></div>
  ${note(`Red cells are pairs the catalogue could not answer. Blank cells were never
    asked for in this window.`)}
</section>`;
}
