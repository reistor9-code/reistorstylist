/**
 * Where they stopped — sessions that went quiet, and opt-outs.
 *
 * "Went quiet" is inferred, not received. Meta sends no abandonment event: a
 * shopper who ignores a carousel generates nothing at all, so silence for 24
 * hours is the only signal there is. Opted out, by contrast, is exact — and is
 * not the same thing as being blocked, which Meta never reports per-shopper.
 */

import type { Attrition } from '../queries.js';
import { cardHead, empty, esc, hueAt, n, note } from './format.js';

function row(d: Attrition['droppedByStep'][number], i: number, max: number): string {
  return `<div class="frow" style="grid-template-columns:96px 1fr 52px">
      <span class="flab">${esc(d.step)}</span>
      <span class="ftrack" style="height:22px"><span class="fbar"
        style="width:${(d.sessions / max) * 100}%;background:var(${hueAt(i)})"></span></span>
      <span class="fnum">${n(d.sessions)}</span></div>`;
}

export function renderStopped(attrition: Attrition): string {
  const dropped = attrition.droppedByStep || [];
  const max = Math.max(1, ...dropped.map((d) => d.sessions));

  return `<section class="card c5" id="stopped">
  ${cardHead('Where they stopped')}
  <div class="figs">
    <div class="fig"><span class="fl">Went quiet</span><div class="fv">${n(attrition.abandoned)}</div></div>
    <div class="fig"><span class="fl">Opted out</span><div class="fv">${n(attrition.optedOut)}</div></div>
  </div>
  ${
    dropped.length
      ? `<div class="fn" style="margin-top:14px">
    ${dropped.map((d, i) => row(d, i, max)).join('')}
  </div>`
      : empty(
          `Nobody has gone quiet yet — sessions are swept into this list 24 hours after their
          last message.`,
          'margin-top:14px',
        )
  }
  ${note(`“Went quiet” is inferred from 24 hours of silence — Meta sends no abandonment
    event. Opted out is exact, and is not the same as blocked.`)}
</section>`;
}
