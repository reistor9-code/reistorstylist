/**
 * The two product columns: what sold, and what converts.
 *
 * They are separated because they answer different questions. Top sellers is
 * volume — what to reorder. Conversion is efficiency — a product shown two
 * hundred times and sold twice is costing you carousel slots, however well it
 * photographs.
 */

import type { ProductConversion, TopProduct } from '../queries.js';
import { day, empty, esc, inr, n, pname } from './format.js';

/* ------------------------------------------------------------------ *
 * Top sellers
 * ------------------------------------------------------------------ */

function sellerCard(p: TopProduct): string {
  return `<div class="mini">
      <div class="tags"><span class="tag lav">${n(p.unitsSold)} sold</span></div>
      <b class="mt">${esc(p.title)}</b>
      <div class="mrow"><span>Revenue</span><b>${inr(p.revenueINR)}</b></div>
      <div class="mrow"><span>Orders</span><b>${n(p.orders)}</b></div>
      <div class="mfoot"><span>last ${day(p.lastSoldAt)}</span></div>
    </div>`;
}

export function renderTopSellers(topProducts: TopProduct[]): string {
  return `<div class="col">
    <div class="colh"><h4>Top sellers</h4><span>${topProducts.length}</span></div>
    ${
      topProducts.length
        ? topProducts.map(sellerCard).join('')
        : empty(
            `No sales recorded yet. Revenue comes from the nightly job, so this lands a day
            after the funnel does.`,
          )
    }
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

const GOOD_CONVERSION = 5;

function conversionCard(p: ProductConversion): string {
  // Guarded against zero so a product logged as sold but never shown does not
  // divide by nothing and render a bar of width Infinity.
  const shown = p.timesShown || 1;
  const sizedPct = (p.timesSized / shown) * 100;
  const soldPct = (p.unitsSold / shown) * 100;

  return `<div class="mini">
        <div class="tags"><span class="tag ${p.conversionPct >= GOOD_CONVERSION ? 'lav' : 'pink'}">${
          p.conversionPct
        }%</span></div>
        <b class="mt">${esc(pname(p))}</b>
        <div class="mrow"><span>Shown</span><b>${n(p.timesShown)}</b></div>
        <div class="mrow"><span>Reached sizing</span><b>${n(p.timesSized)}</b></div>
        <div class="mrow"><span>Sold</span><b>${n(p.unitsSold)}</b></div>
        <span class="spark">
          <i style="width:${soldPct}%;background:var(--lav)"></i>
          <i style="width:${Math.max(0, sizedPct - soldPct)}%;background:var(--peri)"></i>
        </span>
      </div>`;
}

export function renderConversion(productConversion: ProductConversion[]): string {
  return `<div class="col">
    <div class="colh"><h4>Conversion</h4><span>${productConversion.length}</span></div>
    ${
      productConversion.length
        ? productConversion.map(conversionCard).join('')
        : empty(
            'No conversion data yet. Needs both a shown-count and an order against the same product.',
          )
    }
  </div>`;
}
