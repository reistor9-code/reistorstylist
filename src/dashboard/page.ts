/**
 * The page shell.
 *
 * The report itself is rendered on the server by ui/, one module per section.
 * That is a deliberate change from the previous design, where 850 lines of
 * browser JavaScript lived inside a template string and painted the page after
 * fetching JSON: none of it was type-checked, a renamed field failed silently
 * at 2am rather than at build time, and no editor could follow it.
 *
 * What is left below is the only JavaScript that genuinely has to run in the
 * browser — a theme toggle, the window controls, marking a callback handled,
 * and the scroll-spy. Everything else is HTML by the time it leaves the Worker.
 */

import type { DashboardData } from './queries.js';
import { FONT_CSS } from './fonts.js';
import { CSS } from './styles.js';
import { renderAlerts, renderReport } from './ui/index.js';
import { renderNav, renderSideFoot, renderTopBar } from './ui/shell.js';

export interface ShellOptions {
  token: string;
  apiBase: string;
  days: number;
  phone: string;
}

export interface PageOptions extends ShellOptions {
  /** False when rendering the bundled sample, which the footer states plainly. */
  live?: boolean;
}

/**
 * Escapes a value for a single-quoted JavaScript string literal.
 *
 * The token is operator-supplied rather than attacker-supplied, but it is
 * still untrusted input reaching a script context — a stray quote would break
 * the page, and a crafted one would inject.
 */
function jsString(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\x3c')
    .replace(/[\r\n]/g, '');
}

/** The browser half. Small on purpose — see the note at the top of the file. */
function script(opts: ShellOptions): string {
  return `<script>
const CFG = {
  token:  '${jsString(opts.token)}',
  apiBase:'${jsString(opts.apiBase)}',
  days:   ${Number(opts.days) || 30},
  phone:  '${jsString(opts.phone)}',
};

/* Theme. Stored rather than inferred so a choice survives a reload. */
const THEME_KEY = 'reistor.theme';
const applyTheme = t => document.documentElement.setAttribute('data-theme', t);
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
document.getElementById('theme').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
};

/* The window controls navigate rather than re-fetch: the report is rendered
   server-side, so a new window is a new URL. */
function go(days, phone){
  const qs = new URLSearchParams({ token: CFG.token, days: String(days) });
  if (phone) qs.set('phone', phone);
  location.search = '?' + qs.toString();
}
document.getElementById('days').onchange = e => go(Number(e.target.value), CFG.phone);
document.getElementById('phone').onchange = e => go(CFG.days, e.target.value);
document.getElementById('refresh').onclick = e => { e.target.disabled = true; location.reload(); };

/* Mark called. Optimistic only as far as disabling the button — the row is
   removed by the reload, so the list can never disagree with the database. */
document.querySelectorAll('.cbdone').forEach(btn => {
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch(CFG.apiBase + '/callback?token=' + encodeURIComponent(CFG.token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: Number(btn.dataset.cb), agent: 'dashboard' }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Failed — retry';
    }
  };
});

/* Rail follows the section you are reading. Tracks a set and picks the
   earliest section in document order, rather than letting the last callback
   win — the funnel and the sales stack sit side by side, so at the top of the
   page both intersect. */
const links = [...document.querySelectorAll('#nav a')];
const ORDER = ['callbacks','funnel','sales','health','kan','demand','stopped'];
const live = new Set();
const obs = new IntersectionObserver(es => {
  es.forEach(e => e.isIntersecting ? live.add(e.target.id) : live.delete(e.target.id));
  const now = ORDER.find(id => live.has(id));
  if (!now) return;
  links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + now));
}, { rootMargin: '-15% 0px -70% 0px' });
ORDER.forEach(id => { const el = document.getElementById(id); if (el) obs.observe(el); });
</script>`;
}

export function renderPage(data: DashboardData, opts: PageOptions): string {
  const live = opts.live !== false;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="color-scheme" content="dark light">
<title>Stylist Control Room — Reistor</title>
<style>
${FONT_CSS}
${CSS}
</style>
</head>
<body>

<div class="app">
  <aside class="side">
    <div class="brand"><span class="dot"></span><b>Reistor</b></div>
    <nav id="nav">${renderNav()}</nav>
    <div class="sidefoot" id="sidefoot">${renderSideFoot(data, live)}</div>
  </aside>
  <main id="main">
    ${renderTopBar(data, opts.days, opts.phone)}
    ${renderAlerts(data)}
    ${renderReport(data)}
  </main>
</div>

${script(opts)}

</body>
</html>`;
}
