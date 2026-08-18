/**
 * The dashboard endpoint.
 *
 *   GET /dashboard?token=…            the dashboard (fetches the API on load)
 *   GET /dashboard/api?token=…        the data as JSON
 *   GET /dashboard/plain?token=…      the same numbers with no JavaScript
 *
 * Rendered on the server on purpose. The alternative — a browser page holding
 * a Supabase key and querying directly — would put a credential that can read
 * every shopper's phone number into anything that can open DevTools. Here the
 * service key never leaves the process, and the browser receives only the
 * aggregate numbers it is meant to display.
 *
 * Query parameters:
 *   days=30       window, default 30
 *   phone=<id>    restrict to one phone number id, so test traffic can be
 *                 excluded from the figures a board is shown
 */

import { type SupabaseConfig } from '../platform/supabase.js';
import { defaultRange, loadDashboard, type DashboardData } from './queries.js';
import { renderShell } from './page.js';

export interface DashboardEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  DASHBOARD_TOKEN?: string;
  PHONE_NUMBER_ID?: string;
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
function tokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function handleDashboard(
  request: Request,
  env: DashboardEnv,
  path: string,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!env.DASHBOARD_TOKEN) {
    return new Response(
      'DASHBOARD_TOKEN is not set. Set it before exposing this route.',
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const supplied =
    url.searchParams.get('token') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null;

  // The null check is what narrows `supplied` to a string for renderShell
  // below; tokenMatches already rejects null, but that does not narrow.
  if (!supplied || !tokenMatches(supplied, env.DASHBOARD_TOKEN)) {
    return new Response('Forbidden', { status: 403 });
  }

  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));

  /*
   * The page itself needs no database.
   *
   * It is a shell that fetches /dashboard/api once loaded, which means a
   * Supabase outage renders a dashboard explaining the outage rather than a
   * bare 503 with no context. The token is carried through so the page's own
   * request authenticates without asking the reader for it twice.
   */
  if (path === '/dashboard') {
    return new Response(
      renderShell({
        token: supplied,
        apiBase: '/dashboard/api',
        days,
        phone: url.searchParams.get('phone') ?? '',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Aggregates over a shared inbox: never let a proxy cache them.
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      },
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(
      'SUPABASE_URL / SUPABASE_SERVICE_KEY are not set, so there is no data to show.',
      { status: 503 },
    );
  }

  const cfg: SupabaseConfig = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY };
  /*
   * Defaults to the number this instance is configured with, so the figures
   * shown match the bot that is running. `phone=all` opts into everything,
   * which is how test and live traffic get compared side by side.
   */
  const phoneParam = url.searchParams.get('phone');
  const phoneNumberId =
    phoneParam === 'all' ? undefined : (phoneParam ?? env.PHONE_NUMBER_ID ?? undefined);

  const range = defaultRange(days, phoneNumberId);
  const data = await loadDashboard(cfg, range);

  if (path === '/dashboard/api') {
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /*
   * A no-JavaScript rendering of the same numbers.
   *
   * Kept because the main page is a fetch-and-render shell, and there is
   * always someone reading on a locked-down browser, printing to PDF for a
   * board pack, or debugging whether a blank tile is a data problem or a
   * front-end one. This answers that question in one request.
   */
  return new Response(render(data), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Aggregates over a shared inbox: never let a proxy cache them.
      'cache-control': 'no-store',
    },
  });
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Indian digit grouping, matching the bot's own formatINR(). */
function inr(amount: number): string {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return `₹${digits}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `₹${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function tile(title: string, body: string, note?: string): string {
  return `<section class="tile">
    <h2>${esc(title)}</h2>
    ${body}
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
  </section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody>
  </table></div>`;
}

function funnelBars(data: DashboardData): string {
  const top = data.funnel[0]?.sessions || 1;
  return `<div class="funnel">${data.funnel
    .map((s) => {
      const width = Math.max(1, Math.round((s.sessions / top) * 100));
      const heavy = s.lostPct >= 50 ? ' heavy' : '';
      return `<div class="frow">
        <span class="flabel">${esc(s.label)}</span>
        <span class="fbar"><i style="width:${width}%"></i></span>
        <span class="fval">${s.sessions.toLocaleString('en-IN')}</span>
        <span class="floss${heavy}">${s.lostPct > 0 ? `−${s.lostPct}%` : ''}</span>
      </div>`;
    })
    .join('')}</div>`;
}

export function render(d: DashboardData): string {
  const health = d.health;
  const qualityClass =
    health.qualityRating === 'GREEN'
      ? 'ok'
      : health.qualityRating === 'RED'
        ? 'bad'
        : health.qualityRating
          ? 'warn'
          : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Reistor AI Stylist — Dashboard</title>
<style>
  :root{--bg:#faf9f7;--card:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e6e3dd;--accent:#7b5e3b;--bad:#b3261e;--warn:#8a6d1f;--ok:#2f6b3f}
  @media (prefers-color-scheme:dark){:root{--bg:#141311;--card:#1d1c19;--ink:#f0eee9;--muted:#9d9992;--line:#302e2a;--accent:#c9a227;--bad:#f2b8b5;--warn:#e8c766;--ok:#8fd4a3}}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  header{max-width:1100px;margin:0 auto 20px}
  h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:13px}
  main{max-width:1100px;margin:0 auto;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .tile.wide{grid-column:1/-1}
  h2{margin:0 0 12px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .kpis{display:flex;flex-wrap:wrap;gap:20px}
  .kpi .v{font-size:26px;font-weight:600;letter-spacing:-.02em}
  .kpi .k{font-size:12px;color:var(--muted)}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:6px 8px;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:0}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .note{margin:10px 0 0;font-size:12px;color:var(--muted)}
  .empty{color:var(--muted);font-size:14px;margin:0}
  .funnel{display:grid;gap:6px}
  .frow{display:grid;grid-template-columns:150px 1fr 60px 56px;align-items:center;gap:10px;font-size:13px}
  .fbar{background:var(--line);border-radius:4px;height:16px;overflow:hidden}
  .fbar i{display:block;height:100%;background:var(--accent)}
  .fval{text-align:right;font-variant-numeric:tabular-nums}
  .floss{text-align:right;font-size:12px;color:var(--muted)}
  .floss.heavy{color:var(--bad);font-weight:600}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
  .pill.ok{color:var(--ok);border-color:currentColor}
  .pill.warn{color:var(--warn);border-color:currentColor}
  .pill.bad{color:var(--bad);border-color:currentColor}
  @media (max-width:560px){.frow{grid-template-columns:110px 1fr 48px 44px}}
</style>
</head><body>

<header>
  <h1>Reistor AI Stylist</h1>
  <div class="sub">
    ${esc(d.range.from)} to ${esc(d.range.to)} ·
    ${d.range.phoneNumberId ? `number ${esc(d.range.phoneNumberId)}` : 'all numbers'} ·
    generated ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} UTC
  </div>
</header>

<main>

${tile(
  'Sales',
  `<div class="kpis">
     <div class="kpi"><div class="v">${d.revenue.orders}</div><div class="k">Orders</div></div>
     <div class="kpi"><div class="v">${inr(d.revenue.revenueINR)}</div><div class="k">Revenue</div></div>
     <div class="kpi"><div class="v">${inr(d.revenue.averageOrderINR)}</div><div class="k">Average order</div></div>
     <div class="kpi"><div class="v">${d.revenue.costPerOrder ?? '—'}</div><div class="k">Billed msgs / order</div></div>
   </div>`,
  'Orders come from Shopify, matched on utm_source=whatsapp. A Worker cannot see a shopper return from checkout, so this is the authoritative revenue figure.',
)}

${tile(
  'Account health',
  `<div class="kpis">
     <div class="kpi"><div class="v"><span class="pill ${qualityClass}">${esc(health.qualityRating ?? 'unknown')}</span></div><div class="k">Quality rating</div></div>
     <div class="kpi"><div class="v">${esc(health.messagingTier ?? '—')}</div><div class="k">Messaging tier</div></div>
     <div class="kpi"><div class="v">${d.attrition.optedOut}</div><div class="k">Marketing opt-outs</div></div>
   </div>
   ${table(
     ['Template', 'Status', 'Quality'],
     health.templates.map((t) => [esc(t.name), esc(t.status), esc(t.quality ?? '—')]),
     'No template status recorded yet — run /admin/pull once.',
   )}`,
  'Meta reports blocks only as an aggregate quality rating. There is no per-person block list, so opt-outs are exact and blocks are not.',
)}

<section class="tile wide">
  <h2>Funnel — where conversion is lost</h2>
  ${funnelBars(d)}
  <p class="note">Opening a product page fires no webhook, so "Opened a product" counts shoppers who reached sizing or sent a cart. Steps below it are exact.</p>
</section>

${tile(
  'Lost demand — restock these',
  table(
    ['Product', 'Size', 'Times', 'Last'],
    d.lostDemand.map((l) => [
      esc(l.productId),
      esc(l.size ?? 'all sizes'),
      `<span class="num">${l.times}</span>`,
      esc(l.lastAt?.slice(0, 10) ?? '—'),
    ]),
    'No sold-out requests recorded.',
  ),
  'A shopper who reached sizing had already decided. Each row is a sale lost to stock, not to interest.',
)}

${tile(
  'Top sellers',
  table(
    ['Product', 'Units', 'Revenue'],
    d.topProducts.map((p) => [
      esc(p.title),
      `<span class="num">${p.unitsSold}</span>`,
      `<span class="num">${inr(p.revenueINR)}</span>`,
    ]),
    'No attributed orders yet.',
  ),
)}

${tile(
  'Conversion by product',
  table(
    ['Product', 'Shown', 'Sized', 'Sold', 'Conv.'],
    d.productConversion.map((p) => [
      esc(p.productId),
      `<span class="num">${p.timesShown}</span>`,
      `<span class="num">${p.timesSized}</span>`,
      `<span class="num">${p.unitsSold}</span>`,
      `<span class="num">${p.conversionPct}%</span>`,
    ]),
    'No looks shown yet.',
  ),
)}

${tile(
  'Campaign performance',
  table(
    ['Template', 'Sent', 'Delivered', 'Read', 'Click'],
    d.campaigns.map((c) => [
      esc(c.templateName),
      `<span class="num">${c.sent}</span>`,
      `<span class="num">${c.delivered}</span>`,
      `<span class="num">${c.readPct}%</span>`,
      `<span class="num">${c.clickPct}%</span>`,
    ]),
    'No template data yet. Meta keeps read and click counts for only 7 days, so this fills in once the nightly pull has run.',
  ),
)}

${tile(
  'Demand vs catalog',
  table(
    ['Occasion', 'Category', 'Asked', 'Nothing to show', 'Orders'],
    d.demandGrid.map((c) => [
      esc(c.occasion),
      esc(c.category),
      `<span class="num">${c.requests}</span>`,
      `<span class="num">${c.hadNothing}</span>`,
      `<span class="num">${c.orders}</span>`,
    ]),
    'No completed briefs yet.',
  ),
  '"Nothing to show" means the brief had to be widened — the catalog had no in-stock match for what was asked.',
)}

${tile(
  'Delivery',
  `<div class="kpis">
     <div class="kpi"><div class="v">${d.delivery.sent}</div><div class="k">Sent</div></div>
     <div class="kpi"><div class="v">${d.delivery.deliveredPct}%</div><div class="k">Delivered</div></div>
     <div class="kpi"><div class="v">${d.delivery.readPct}%</div><div class="k">Read</div></div>
     <div class="kpi"><div class="v">${d.delivery.failed}</div><div class="k">Failed</div></div>
   </div>`,
  'Read rate is a floor: a shopper with read receipts disabled never produces a read status.',
)}

${tile(
  'Messages and billing',
  `<div class="kpis">
     <div class="kpi"><div class="v">${d.cost.billableMessages}</div><div class="k">Billable</div></div>
     <div class="kpi"><div class="v">${d.cost.freeMessages}</div><div class="k">Free</div></div>
   </div>
   ${table(
     ['Category', 'Messages'],
     d.cost.byCategory.map((c) => [esc(c.category), `<span class="num">${c.messages}</span>`]),
     'No billing data yet — a test number never bills, so these stay at zero until launch.',
   )}`,
  'Taken from the pricing object on each delivery receipt, so it is current rather than month-end.',
)}

${tile(
  'Where sessions stopped',
  table(
    ['Step', 'Sessions'],
    d.attrition.droppedByStep.map((s) => [esc(s.step), `<span class="num">${s.sessions}</span>`]),
    'No abandoned sessions recorded.',
  ),
  'Abandonment produces no webhook. These are sessions that went silent past 24 hours and were swept by the nightly job.',
)}

</main>
</body></html>`;
}
