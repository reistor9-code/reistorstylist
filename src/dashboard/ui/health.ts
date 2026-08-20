/**
 * Account health — quality rating, messaging tier, and per-template status.
 *
 * A paused template is the most expensive failure on this page: the entry flow
 * stops working entirely and no error reaches the shopper, so it is raised as
 * a page-level alert as well as listed here.
 */

import type { Attrition, Health } from '../queries.js';
import { cardHead, empty, esc, n, note, when } from './format.js';

type Template = Health['templates'][number];

const isBroken = (t: Template): boolean =>
  t.status === 'PAUSED' || t.status === 'DISABLED' || t.quality === 'RED';

/** The banner shown above the page when a template has stopped sending. */
export function renderTemplateAlert(health: Health): string {
  const broken = (health.templates || []).filter(isBroken);
  if (!broken.length) return '';

  const heading =
    broken.length === 1 ? 'A template is not sending' : `${broken.length} templates are not sending`;

  const detail = broken
    .map((t) => `<b>${esc(t.name)}</b> — ${esc(t.status)}${t.quality ? ` · quality ${esc(t.quality)}` : ''}`)
    .join(' &nbsp;·&nbsp; ');

  return `<div class="alert">
  <span class="ai">!</span>
  <div><h4>${heading}</h4>
    <p>${detail}.
      The entry flow is broken right now and someone has to act today.</p></div>
</div>`;
}

function templateRow(t: Template): string {
  const bad = isBroken(t);
  return `<tr><td>${esc(t.name)}</td>
        <td><span class="st ${bad ? 'no' : 'ok'}">${esc(t.status)}</span></td>
        <td class="r">${
          t.quality
            ? `<span class="qp ${esc(t.quality)}" style="font-size:11.5px;padding:4px 10px"><i></i>${esc(t.quality)}</span>`
            : '<span style="color:var(--dim)">—</span>'
        }</td></tr>`;
}

export function renderHealth(health: Health, attrition: Attrition): string {
  const templates = health.templates || [];

  return `<section class="card c7" id="health">
  ${cardHead('Account health', `read ${when(health.capturedAt)}`)}
  <div class="figs f3">
    <div class="fig"><span class="fl">Quality rating</span>
      <div style="margin-top:7px">${
        health.qualityRating
          ? `<span class="qp ${esc(health.qualityRating)}"><i></i>${esc(health.qualityRating)}</span>`
          : '<span class="fv" style="font-size:17px;color:var(--dim)">Not read yet</span>'
      }</div></div>
    <div class="fig"><span class="fl">Messaging tier</span>
      <div class="fv">${esc(health.messagingTier || '—')}</div></div>
    <div class="fig"><span class="fl">Opted out</span>
      <div class="fv">${n(attrition.optedOut)}</div></div>
  </div>
  ${
    templates.length
      ? `<div class="tw"><table class="plain">
    <tr><th>Template</th><th>Status</th><th class="r">Quality</th></tr>
    ${templates.map(templateRow).join('')}
  </table></div>`
      : empty('No templates read yet. This lands after the nightly pull, or run /admin/pull once.')
  }
  ${note(`Opted out is exact. Meta provides no block list — only the aggregate quality
    rating above.`)}
</section>`;
}
