/**
 * The funnel — chats in, orders out, and where the people in between went.
 *
 * A step losing half the previous step is marked hot, because that is the one
 * number on this page most likely to be worth someone's afternoon.
 */

import type { FunnelStep, Range } from '../queries.js';
import { cardHead, empty, esc, hueAt, n, note } from './format.js';

const HOT_THRESHOLD = 50;

/** The banner for a step bleeding half its traffic. */
export function biggestDrop(funnel: FunnelStep[]): string {
  const bleeding = funnel.filter((f) => f.lostPct >= HOT_THRESHOLD);
  if (!bleeding.length) return '';

  return note(
    `Biggest drop at <b>${esc(bleeding[0].label)}</b> — ${bleeding[0].lostPct}% of the previous
    step lost here.`,
    'color:var(--bad)',
  );
}

function row(f: FunnelStep, i: number, peak: number): string {
  const hot = f.lostPct >= HOT_THRESHOLD;
  // A floor of 1.5% so a step with almost nothing still shows a sliver rather
  // than an empty track that reads as a rendering fault.
  const width = peak ? Math.max(1.5, (f.sessions / peak) * 100) : 0;

  return `<div class="frow${hot ? ' hot' : ''}">
        <span class="flab" title="${esc(f.label)}">${esc(f.label)}</span>
        <span class="ftrack"><span class="fbar" style="width:${width}%;
          background:var(${hueAt(i)})"></span></span>
        <span class="fnum">${n(f.sessions)}</span>
        <span class="flost${hot ? ' hot' : ''}">${i === 0 ? '' : `−${f.lostPct}%`}</span>
      </div>`;
}

export function renderFunnel(funnel: FunnelStep[], range: Range): string {
  const peak = funnel.length ? funnel[0].sessions : 1;
  const days = Math.round(
    (new Date(range.to).getTime() - new Date(range.from).getTime()) / 864e5,
  );
  const pill = `${n(funnel[0] ? funnel[0].sessions : 0)} chats · last ${days} days`;

  return `<section class="card c8" id="funnel">
  ${cardHead('Funnel', pill)}
  ${
    peak
      ? `<div class="fn">
    ${funnel.map((f, i) => row(f, i, peak)).join('')}
  </div>`
      : empty(
          `No chats in this window yet. The funnel fills the moment somebody messages the
    number — it comes from live webhooks, not the nightly job.`,
          'margin-top:16px',
        )
  }
  ${biggestDrop(funnel)}
  ${note(`“Opened a product” — opening a product page fires no webhook. Counted from
    shoppers who reached sizing or sent a cart.`)}
</section>`;
}
