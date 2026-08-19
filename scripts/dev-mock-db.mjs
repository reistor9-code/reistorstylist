/**
 * A stand-in for Supabase, for local verification.
 *
 * Answers the PostgREST reads the dashboard makes, with rows shaped exactly
 * like the views in supabase/schema.sql. That matters: pointing the page at a
 * hand-written JSON blob would prove only that the page renders. Going through
 * the real query layer proves the column names, the aggregation and the
 * mapping in queries.ts are right too — which is where the mistakes actually
 * live.
 *
 *   node scripts/dev-mock-db.mjs [--port 8799] [--empty]
 *
 * `--empty` returns nothing for every table, which is what the dashboard looks
 * like on day one.
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 8799;
const EMPTY = args.includes('--empty');
const PHONE = '1221684564367817';

const today = '2026-08-18';

/* Rows keyed by the table or view PostgREST is asked for. */
const TABLES = {
  v_funnel: [
    {
      phone_number_id: PHONE, day: today,
      started: 420, picked_occasion: 380, picked_category: 310, saw_looks: 295,
      opened_product: 141, picked_size: 88, opened_checkout: 61, ordered: 34,
      used_stylist: 52, widened_brief: 26,
    },
  ],
  // One overdue, one fresh, one opted out of marketing — so the alarm, the
  // waiting counter and the compliance flag are all exercised.
  v_callbacks: [
    { id: 1, wa_id: '919876543210', phone_number_id: PHONE, profile_name: 'Aditi',
      occasion: 'work', category: 'tops', products_seen: ['7382019', '7382044'],
      requested_at: '2026-08-18T04:00:00Z', window_expires_at: '2026-08-19T04:00:00Z',
      window_open: false, status: 'pending', called_at: null, called_by: null, notes: null,
      marketing_opt_out: false, hours_waiting: 31.5 },
    { id: 2, wa_id: '919812345678', phone_number_id: PHONE, profile_name: null,
      occasion: 'dinner', category: 'dresses', products_seen: ['7382088'],
      requested_at: '2026-08-19T09:00:00Z', window_expires_at: '2026-08-20T09:00:00Z',
      window_open: true, status: 'pending', called_at: null, called_by: null, notes: null,
      marketing_opt_out: true, hours_waiting: 2.1 },
  ],
  v_top_products: [
    { product_id: '7382019', title: 'Hemp Poplin Shirt',  units_sold: 12, revenue_inr: 35988, orders: 11, last_sold_at: '2026-08-17T14:22:10Z' },
    { product_id: '7382044', title: 'Linen Notch Blouse', units_sold: 9,  revenue_inr: 28791, orders: 9,  last_sold_at: '2026-08-18T06:40:00Z' },
    { product_id: '7382088', title: 'Modal Slip Dress',   units_sold: 5,  revenue_inr: 19995, orders: 5,  last_sold_at: '2026-08-16T11:05:00Z' },
  ],
  v_product_conversion: [
    { product_id: '7382019', title: 'Hemp Poplin Shirt',   times_shown: 120, times_sized: 30, units_sold: 12, conversion_pct: 10 },
    { product_id: '7382044', title: 'Linen Notch Blouse',  times_shown: 98,  times_sized: 21, units_sold: 9,  conversion_pct: 9.2 },
    { product_id: '7382077', title: 'Tencel Wide Trouser', times_shown: 76,  times_sized: 4,  units_sold: 0,  conversion_pct: 0 },
  ],
  // The title column is the fix this build added — without it these rows read
  // as bare Shopify numbers, which no buyer can act on.
  v_lost_demand: [
    { phone_number_id: PHONE, product_id: '7382101', title: 'Hemp Wrap Jumpsuit',  size: 'M',  times: 18, last_at: '2026-08-16T10:02:00Z' },
    { phone_number_id: PHONE, product_id: '7382101', title: 'Hemp Wrap Jumpsuit',  size: 'L',  times: 11, last_at: '2026-08-15T18:44:00Z' },
    { phone_number_id: PHONE, product_id: '7382055', title: 'Cotton Tweed Blazer', size: null, times: 6,  last_at: '2026-08-14T09:10:00Z' },
  ],
  v_demand_grid: [
    { phone_number_id: PHONE, occasion: 'work',     category: 'tops',      requests: 90, had_nothing: 4,  orders: 12 },
    { phone_number_id: PHONE, occasion: 'work',     category: 'bottoms',   requests: 44, had_nothing: 2,  orders: 6 },
    { phone_number_id: PHONE, occasion: 'casual',   category: 'dresses',   requests: 61, had_nothing: 0,  orders: 8 },
    { phone_number_id: PHONE, occasion: 'vacation', category: 'jumpsuits', requests: 37, had_nothing: 5,  orders: 4 },
    { phone_number_id: PHONE, occasion: 'dinner',   category: 'dresses',   requests: 18, had_nothing: 9,  orders: 2 },
    { phone_number_id: PHONE, occasion: 'lounge',   category: 'tops',      requests: 22, had_nothing: 22, orders: 0 },
    { phone_number_id: PHONE, occasion: 'lounge',   category: 'coords',    requests: 14, had_nothing: 14, orders: 0 },
  ],
  template_stats: [
    { date: today, template_id: 't1', template_name: 'occasion_picker', sent: 400, delivered: 392, read: 300, clicked: 180, cost_inr: 344 },
    { date: today, template_id: 't2', template_name: 'category_picker', sent: 372, delivered: 366, read: 281, clicked: 152, cost_inr: 320 },
  ],
  v_delivery: [
    { phone_number_id: PHONE, day: today, sent: 1200, delivered: 1180, read: 900, failed: 20 },
  ],
  v_message_cost: [
    { phone_number_id: PHONE, day: today, pricing_category: 'marketing', billable_messages: 780, free_messages: 0,   total_messages: 780 },
    { phone_number_id: PHONE, day: today, pricing_category: 'service',   billable_messages: 0,   free_messages: 420, total_messages: 420 },
  ],
  v_dropoff: [
    { phone_number_id: PHONE, step: 'top3',     sessions: 154, first_seen: null, last_seen: null },
    { phone_number_id: PHONE, step: 'category', sessions: 70,  first_seen: null, last_seen: null },
    { phone_number_id: PHONE, step: 'size',     sessions: 46,  first_seen: null, last_seen: null },
    { phone_number_id: PHONE, step: 'checkout', sessions: 30,  first_seen: null, last_seen: null },
  ],
  shoppers: [{ wa_id: '91987650001' }, { wa_id: '91987650002' }, { wa_id: '91987650003' }],
  account_health: [
    {
      captured_at: '2026-08-18T02:30:00Z', phone_number_id: PHONE,
      quality_rating: 'GREEN', messaging_tier: 'TIER_1K',
      // One PAUSED template, so the alarm banner is exercised rather than
      // assumed to work.
      templates: [
        { name: 'occasion_picker', status: 'APPROVED', quality_score: { score: 'GREEN' } },
        { name: 'category_picker', status: 'PAUSED',   quality_score: { score: 'RED' } },
      ],
    },
  ],
  orders: [
    { order_id: '1', total_inr: 2999 }, { order_id: '2', total_inr: 3199 },
    { order_id: '3', total_inr: 2499 }, { order_id: '4', total_inr: 3999 },
  ],
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const table = url.pathname.replace(/^\/rest\/v1\//, '').split('?')[0];

  const rows = EMPTY ? [] : (TABLES[table] ?? []);
  if (!EMPTY && !TABLES[table]) console.log('[mock-db] unknown table:', table);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(rows));
}).listen(PORT, () => {
  console.log(`[mock-db] on :${PORT} ${EMPTY ? '(EMPTY dataset)' : '(populated)'}`);
});
