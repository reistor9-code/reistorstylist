/**
 * Restock list — demand the catalogue could not serve.
 *
 * Every row is a shopper who reached sizing and found the size gone. That is a
 * buying signal, not a failure log: they had picked the garment and were ready.
 */

import type { LostDemand } from '../queries.js';
import { day, empty, esc, n, note, pname } from './format.js';

function card(l: LostDemand): string {
  return `<div class="mini">
      <div class="tags"><span class="tag ${l.size === null ? 'bad' : 'gold'}">${
        l.size === null ? 'every size gone' : `size ${esc(l.size)}`
      }</span></div>
      <b class="mt">${esc(pname(l))}</b>
      <div class="mrow"><span>Shoppers turned away</span><b>${n(l.times)}</b></div>
      <div class="mfoot"><span>last ${day(l.lastAt)}</span></div>
    </div>`;
}

export function renderRestock(lostDemand: LostDemand[]): string {
  return `<div class="col">
    <div class="colh"><h4>Restock list</h4><span>${lostDemand.length}</span></div>
    ${
      lostDemand.length
        ? lostDemand.map(card).join('')
        : empty(
            `Nothing sold out on a shopper yet. This fills as soon as somebody reaches sizing
            and the size is gone.`,
          )
    }
    ${note('Demand you could not serve — not a failure log.')}
  </div>`;
}
