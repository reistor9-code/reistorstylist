/**
 * "Call these people" — the callback queue.
 *
 * Placed first on the page because it is the only tile somebody has to ACT on.
 * Everything else here is a number to read; this is a work list, and every row
 * is a person the bot promised a call to within 24 hours.
 */

import type { Callback } from '../queries.js';
import { cardHead, dialable, empty, esc, note, prettyNumber, when } from './format.js';

/** The banner shown above the page when a promise is already past due. */
export function renderOverdueAlert(callbacks: Callback[]): string {
  const late = callbacks.filter((c) => c.overdue).length;
  if (!late) return '';

  const heading =
    late === 1
      ? 'Someone has been waiting over 24 hours'
      : `${late} people have been waiting over 24 hours`;

  return `<div class="alert">
  <span class="ai">!</span>
  <div><h4>${heading}</h4>
    <p>The bot promised a call within 24 hours. That promise is already past due —
      the numbers are in the list below.</p></div>
</div>`;
}

function row(c: Callback): string {
  const context =
    c.occasion || c.category
      ? ` · was browsing ${esc([c.occasion, c.category].filter(Boolean).join(' · '))}`
      : '';
  const seen = c.productsSeen.length ? ` · saw ${c.productsSeen.length} looks` : '';
  const waited = c.hoursWaiting < 1 ? 'under an hour' : `${Math.round(c.hoursWaiting)}h`;

  return `<div class="cbrow${c.overdue ? ' late' : ''}">
      <div class="cbwho">
        <div class="cbnum">${esc(prettyNumber(c.waId))}</div>
        <div class="cbmeta">${esc(c.profileName || 'No profile name')}${context}${seen}</div>
        <div class="cbwait${c.overdue ? ' late' : ''}">asked ${when(c.requestedAt)} · waiting ${waited}${
          c.overdue ? ' — past the 24h promise' : ''
        }</div>
        ${
          c.marketingOptOut
            ? '<span class="cbflag">opted out of marketing — call about this request only</span>'
            : ''
        }
      </div>
      <div class="cbact">
        <a class="cbcall" href="tel:${esc(dialable(c.waId))}">Call</a>
        <button class="cbdone" type="button" data-cb="${c.id}">Mark called</button>
      </div>
    </div>`;
}

export function renderCallbacks(callbacks: Callback[]): string {
  const late = callbacks.filter((c) => c.overdue).length;
  const pill = `${callbacks.length} waiting${late ? ` · ${late} overdue` : ''}`;

  return `<section class="card c8" id="callbacks">
  ${cardHead('Call these people', pill)}
  ${
    callbacks.length
      ? `<div class="cb">
    ${callbacks.map(row).join('')}
  </div>`
      : empty(
          'Nobody is waiting for a call. This fills the moment somebody taps “Talk to Stylist”.',
          'margin-top:16px',
        )
  }
  ${note(
    `The bot promises a call within 24 hours. These numbers came from shoppers who
    messaged first and asked to be rung — use them for that, and nothing else.`,
  )}
</section>`;
}
