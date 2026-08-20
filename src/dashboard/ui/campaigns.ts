/**
 * Campaigns — per-template read and click rates.
 *
 * Rates are measured against DELIVERED rather than sent, because a message
 * that never arrived cannot be read, and counting it against you turns a
 * carrier problem into a copy problem.
 *
 * Meta keeps these counts for only 7 days, so anything older than that is gone
 * whatever the reporting window says.
 */

import type { CampaignStat } from '../queries.js';
import { empty, esc, n } from './format.js';

function card(c: CampaignStat): string {
  return `<div class="mini">
      <div class="tags"><span class="tag pink">${c.readPct}% read</span>
        <span class="tag lav">${c.clickPct}% clicked</span></div>
      <b class="mt">${esc(c.templateName)}</b>
      <div class="mrow"><span>Sent</span><b>${n(c.sent)}</b></div>
      <div class="mrow"><span>Delivered</span><b>${n(c.delivered)}</b></div>
      <div class="mfoot"><span>rates measured against delivered</span></div>
    </div>`;
}

export function renderCampaigns(campaigns: CampaignStat[]): string {
  return `<div class="col">
    <div class="colh"><h4>Campaigns</h4><span>${campaigns.length}</span></div>
    ${
      campaigns.length
        ? campaigns.map(card).join('')
        : empty(
            `No template data yet. Meta keeps read and click counts for only 7 days, so this
            fills in once the nightly pull has run.`,
          )
    }
  </div>`;
}
