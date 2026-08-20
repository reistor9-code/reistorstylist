/**
 * Sales — orders and revenue, as two stat tiles beside the funnel.
 *
 * Cost per order is counted in billed MESSAGES, not rupees. Meta's per-message
 * price varies by category and country, so a rupee figure here would be a
 * guess; a message count is exact and multiplies out to money when you know
 * your own rate.
 */

import type { FunnelStep, Revenue } from '../queries.js';
import { inr, n, note } from './format.js';

export function renderSales(revenue: Revenue, funnel: FunnelStep[]): string {
  const chats = funnel.length ? funnel[0].sessions : 0;
  const conversion = chats ? ((revenue.orders / chats) * 100).toFixed(1) : null;

  return `<div class="stack" id="sales">
  <div class="stat">
    <span class="sl">Orders</span>
    <div class="sv"><span class="sn">${n(revenue.orders)}</span>
      ${conversion !== null ? `<span class="badge">${conversion}% of chats</span>` : ''}</div>
  </div>
  <div class="stat">
    <span class="sl">Revenue</span>
    <div class="sv"><span class="sn">${inr(revenue.revenueINR)}</span>
      <span class="badge">${inr(revenue.averageOrderINR)} avg</span></div>
    ${note(
      revenue.costPerOrder === null
        ? 'Billed messages per order not available yet.'
        : `${n(revenue.costPerOrder)} billed messages per order — messages, not rupees.`,
    )}
  </div>
</div>`;
}
