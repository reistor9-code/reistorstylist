/**
 * Assembles the report from its sections.
 *
 * This file decides ORDER and nothing else. Each section owns its own markup,
 * its own empty state and its own caveats, so adding one is a new module plus
 * a line here — and no section can quietly reach into another's data.
 */

import type { DashboardData } from '../queries.js';
import { renderCallbacks, renderOverdueAlert } from './callbacks.js';
import { renderCampaigns } from './campaigns.js';
import { renderDelivery } from './delivery.js';
import { renderDemand } from './demand.js';
import { renderFunnel } from './funnel.js';
import { renderHealth, renderTemplateAlert } from './health.js';
import { renderConversion, renderTopSellers } from './products.js';
import { renderRestock } from './restock.js';
import { renderSales } from './sales.js';
import { renderStopped } from './stopped.js';

export * from './format.js';
export { SECTIONS } from './shell.js';

/**
 * The four-column board. Grouped because they share a scroll container and a
 * single card, not because they are related — each column is its own module.
 */
function renderBoard(data: DashboardData): string {
  return `<div class="kan card" id="kan" style="padding:22px">
  ${renderRestock(data.lostDemand || [])}
  ${renderTopSellers(data.topProducts || [])}
  ${renderConversion(data.productConversion || [])}
  ${renderCampaigns(data.campaigns || [])}
</div>`;
}

/** Alerts sit above everything: they are the reason somebody opens this page. */
export function renderAlerts(data: DashboardData): string {
  return renderOverdueAlert(data.callbacks || []) + renderTemplateAlert(data.health);
}

export function renderReport(data: DashboardData): string {
  return `<div class="grid">
    ${renderCallbacks(data.callbacks || [])}
    ${renderFunnel(data.funnel || [], data.range)}
    ${renderSales(data.revenue, data.funnel || [])}
    ${renderHealth(data.health, data.attrition)}
    ${renderDelivery(data.delivery, data.cost)}
    ${renderBoard(data)}
    ${renderDemand(data.demandGrid || [])}
    ${renderStopped(data.attrition)}
  </div>`;
}
