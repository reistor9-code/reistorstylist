/**
 * Delivery — what was sent, what arrived, what it cost in messages.
 *
 * Read rate is reported as a floor rather than a rate, because a shopper with
 * read receipts switched off never reports a read at all. Treating it as a
 * true percentage would understate every campaign on the page.
 */

import type { CostStats, DeliveryStats } from '../queries.js';
import { cardHead, esc, n, note } from './format.js';

export function renderDelivery(delivery: DeliveryStats, cost: CostStats): string {
  const byCategory = cost.byCategory || [];

  return `<section class="card c5">
  ${cardHead('Delivery')}
  <div class="figs f3">
    <div class="fig"><span class="fl">Sent</span><div class="fv">${n(delivery.sent)}</div></div>
    <div class="fig"><span class="fl">Delivered</span><div class="fv">${delivery.deliveredPct}%</div></div>
    <div class="fig"><span class="fl">Read</span><div class="fv">${delivery.readPct}%</div></div>
    <div class="fig"><span class="fl">Failed</span>
      <div class="fv" style="color:${delivery.failed ? 'var(--bad)' : 'inherit'}">${n(delivery.failed)}</div></div>
    <div class="fig"><span class="fl">Billable</span>
      <div class="fv">${n(cost.billableMessages)}</div></div>
    <div class="fig"><span class="fl">Free</span>
      <div class="fv">${n(cost.freeMessages)}</div></div>
  </div>
  ${
    byCategory.length
      ? `<div class="tw"><table class="plain two">
    ${byCategory
      .map(
        (c) => `<tr><td style="text-transform:capitalize">${esc(c.category)}</td>
      <td class="r">${n(c.messages)}</td></tr>`,
      )
      .join('')}
  </table></div>`
      : ''
  }
  ${note(
    `Read rate is a floor, not a true rate — a shopper with read receipts off never
      reports a read.${
        cost.billableMessages === 0
          ? ' A test number never bills; these stay at zero until launch.'
          : ''
      }`,
  )}
</section>`;
}
