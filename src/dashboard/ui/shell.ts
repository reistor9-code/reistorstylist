/**
 * The furniture around the sections: sidebar, rail, top bar, footer.
 *
 * Everything here is chrome. It knows the shape of the report — which sections
 * exist and in what order — and nothing about what any of them contain.
 */

import type { DashboardData } from '../queries.js';
import { day, esc, n, when } from './format.js';

const ICON: Record<string, string> = {
  funnel: '<path d="M2 3h14L11 9v6l-4 2V9z"/>',
  sales: '<path d="M3 15V8M9 15V3M15 15v-5"/>',
  health: '<path d="M2 9h3l2-5 3 10 2-5h4"/>',
  stock: '<path d="M3 6l6-3 6 3v7l-6 3-6-3z"/><path d="M3 6l6 3 6-3M9 9v7"/>',
  reach: '<circle cx="9" cy="9" r="6"/><path d="M9 3v6l4 2"/>',
  grid: '<path d="M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z"/>',
  stop: '<circle cx="9" cy="9" r="6"/><path d="M7 7l4 4M11 7l-4 4"/>',
};

/**
 * One entry per section, in document order.
 *
 * The scroll-spy walks this list and highlights the FIRST section currently on
 * screen. Picking the last would put the rail on "Sales" while the reader is
 * plainly looking at the funnel beside it.
 */
export const SECTIONS = [
  { icon: 'stop', label: 'Call these people', anchor: 'callbacks' },
  { icon: 'funnel', label: 'Funnel', anchor: 'funnel' },
  { icon: 'sales', label: 'Sales', anchor: 'sales' },
  { icon: 'health', label: 'Account health', anchor: 'health' },
  { icon: 'stock', label: 'Restock list', anchor: 'kan' },
  { icon: 'reach', label: 'Campaigns', anchor: 'kan' },
  { icon: 'grid', label: 'Demand vs catalog', anchor: 'demand' },
  { icon: 'stop', label: 'Where they stopped', anchor: 'stopped' },
] as const;

export function renderNav(): string {
  return (
    '<div class="navlab">This report</div>' +
    SECTIONS.map(
      (s, i) => `<a href="#${s.anchor}" class="${i === 0 ? 'on' : ''}">
    <svg viewBox="0 0 18 18" stroke-linecap="round" stroke-linejoin="round">${ICON[s.icon]}</svg>
    ${esc(s.label)}</a>`,
    ).join('')
  );
}

export function renderSideFoot(data: DashboardData, live: boolean): string {
  return (
    `Window ${day(data.range.from)} – ${day(data.range.to)}<br>` +
    `Generated ${when(data.generatedAt)}` +
    (data.range.phoneNumberId
      ? `<br>Number …${esc(String(data.range.phoneNumberId).slice(-6))}`
      : '') +
    (live ? '' : '<br><b>Sample data</b> — not connected')
  );
}

const DAY_OPTIONS = [7, 30, 90, 365];

export function renderTopBar(data: DashboardData, days: number, phone: string): string {
  const chats = data.funnel.length ? data.funnel[0].sessions : 0;

  const dayPicker = DAY_OPTIONS.map(
    (d) => `<option value="${d}"${d === days ? ' selected' : ''}>Last ${d} days</option>`,
  ).join('');

  return `<div class="topbar">
    <div class="range">
      <svg viewBox="0 0 18 18" stroke-linecap="round"><rect x="2.5" y="3.5" width="13" height="12" rx="2"/><path d="M2.5 7h13M6 2v3M12 2v3"/></svg>
      <div><div class="r1">${day(data.range.from)} – ${day(data.range.to)}</div>
        <div class="r2">Reistor AI Stylist · WhatsApp</div></div>
    </div>
    <span class="chip">Chats <b>${n(chats)}</b></span>
    <span class="chip">Orders <b>${n(data.revenue.orders)}</b></span>
    <select class="sel" id="days" aria-label="Reporting window">${dayPicker}</select>
    <select class="sel" id="phone" aria-label="Which number">
      <option value=""${phone === '' ? ' selected' : ''}>Live number</option>
      <option value="all"${phone === 'all' ? ' selected' : ''}>All numbers</option>
    </select>
    <button class="btn ghost" type="button" id="theme" aria-label="Switch theme">Theme</button>
    <button class="btn" type="button" id="refresh">Refresh</button>
  </div>`;
}
