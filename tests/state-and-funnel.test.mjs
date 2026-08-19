/**
 * Storage portability and funnel bookkeeping.
 *
 * These cover the two pieces that make the Linode move possible: state that
 * behaves identically whatever is behind it, and a funnel position that only
 * moves forward. Both are easy to get subtly wrong and hard to notice — a
 * broken TTL loses a shopper's place, and a funnel that moves backwards
 * understates how far people actually got.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore, KvStore, getStore } from '../dist/platform/store.js';
import { furthestOf, FUNNEL_ORDER, newSessionId } from '../dist/analytics/log.js';
import { widenCandidates } from '../dist/flow.js';
import { rankOrder } from '../dist/ranking.js';
import { checkoutUrl } from '../dist/catalog.js';
import { configFromProcess, missingRequired, configWarnings } from '../dist/platform/config.js';

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

test('store: round-trips a value', async () => {
  const store = new MemoryStore();
  await store.put('state:919876543210', '{"step":"top3"}');
  assert.equal(await store.get('state:919876543210'), '{"step":"top3"}');
});

test('store: a missing key is null, never undefined or a throw', async () => {
  const store = new MemoryStore();
  assert.equal(await store.get('nope'), null);
});

test('store: delete removes the value', async () => {
  const store = new MemoryStore();
  await store.put('k', 'v');
  await store.delete('k');
  assert.equal(await store.get('k'), null);
});

test('store: an expired entry reads as absent', async () => {
  const store = new MemoryStore();
  // Negative TTL puts the expiry in the past — the same check the Supabase
  // store applies on read, since Postgres has no TTL of its own.
  await store.put('k', 'v', { expirationTtl: -1 });
  assert.equal(await store.get('k'), null);
});

test('store: a live TTL still reads', async () => {
  const store = new MemoryStore();
  await store.put('k', 'v', { expirationTtl: 600 });
  assert.equal(await store.get('k'), 'v');
});

test('store: the KV wrapper forwards the TTL option unchanged', async () => {
  // A wrapper that dropped expirationTtl would leave conversation state in KV
  // forever, and the 7-day reset would silently stop happening.
  const calls = [];
  const fakeKv = {
    async get(key) {
      calls.push(['get', key]);
      return null;
    },
    async put(key, value, options) {
      calls.push(['put', key, value, options]);
    },
    async delete(key) {
      calls.push(['delete', key]);
    },
  };

  const store = new KvStore(fakeKv);
  await store.put('a', 'b', { expirationTtl: 42 });
  assert.deepEqual(calls[0], ['put', 'a', 'b', { expirationTtl: 42 }]);
});

test('store: selection prefers Supabase, then KV, then memory', () => {
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };

  assert.equal(
    getStore({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', STATE: kv })
      .constructor.name,
    'SupabaseStore',
  );
  assert.equal(getStore({ STATE: kv }).constructor.name, 'KvStore');
  assert.equal(getStore({}).constructor.name, 'MemoryStore');
  // A half-configured Supabase must not be treated as configured.
  assert.equal(getStore({ SUPABASE_URL: 'https://x.supabase.co' }).constructor.name, 'MemoryStore');
});

/* ------------------------------------------------------------------ *
 * Funnel position
 * ------------------------------------------------------------------ */

test('funnel: furthest step only moves forward', () => {
  assert.equal(furthestOf('occasion', 'category'), 'category');
  assert.equal(furthestOf('size', 'category'), 'size');
  assert.equal(furthestOf('checkout', 'top3'), 'checkout');
});

test('funnel: a side branch never erases real progress', () => {
  // Browsing and the stylist are not on the main funnel. A shopper who reaches
  // sizing and then browses has still reached sizing.
  assert.equal(furthestOf('size', 'browse'), 'size');
  assert.equal(furthestOf('checkout', 'stylist'), 'checkout');
});

test('funnel: undefined is handled at both ends', () => {
  assert.equal(furthestOf(undefined, 'category'), 'category');
  assert.equal(furthestOf('category', undefined), 'category');
  assert.equal(furthestOf(undefined, undefined), 'welcome');
});

test('funnel: the documented order is the journey order', () => {
  assert.deepEqual(FUNNEL_ORDER.slice(0, 4), ['welcome', 'occasion', 'category', 'top3']);
  assert.equal(FUNNEL_ORDER[FUNNEL_ORDER.length - 1], 'done');
});

test('session ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
  assert.equal(ids.size, 200);
});

/* ------------------------------------------------------------------ *
 * Never dead-end the shopper
 * ------------------------------------------------------------------ */

const product = (id, occasionTags, category, stock = 3) => ({
  id,
  title: id,
  occasionTags,
  category,
  fabric: 'hemp',
  attributes: 'test, piece',
  priceINR: 2999,
  sizes: [{ size: 'M', stock }],
  imageUrl: 'https://example.com/x.jpg',
  productUrl: 'https://reistor.in/products/x',
});

test('widen: an exact match carries no explanation', () => {
  const all = [product('a', ['work'], 'tops')];
  const { products, intro } = widenCandidates(all, 'work', 'tops');
  assert.equal(products.length, 1);
  assert.equal(intro, undefined);
});

test('widen: an empty pair drops the category and says so', () => {
  const all = [product('a', ['work'], 'dresses')];
  const { products, intro } = widenCandidates(all, 'work', 'tops');
  assert.equal(products.length, 1);
  // A widened edit must never be passed off as an exact match.
  assert.ok(intro && intro.length > 0);
});

test('widen: an empty occasion falls back to the category', () => {
  const all = [product('a', ['casual'], 'tops')];
  const { products, intro } = widenCandidates(all, 'lounge', 'tops');
  assert.equal(products.length, 1);
  assert.ok(intro);
});

test('widen: with nothing matching at all, the whole shelf is offered', () => {
  const all = [product('a', ['casual'], 'dresses')];
  const { products, intro } = widenCandidates(all, 'lounge', 'tops');
  assert.equal(products.length, 1);
  assert.ok(intro);
});

test('widen: sold-out products are never surfaced', () => {
  const all = [product('a', ['work'], 'tops', 0)];
  const { products } = widenCandidates(all, 'work', 'tops');
  assert.equal(products.length, 0);
});

test('widen: every intro obeys the brand copy rules', async () => {
  const { copyViolations } = await import('../dist/copy.js');
  const all = [product('a', ['casual'], 'dresses')];

  for (const [occasion, category] of [['work', 'tops'], ['lounge', 'tops'], ['lounge', 'coords']]) {
    const { intro } = widenCandidates(all, occasion, category);
    if (intro) assert.equal(copyViolations(intro).length, 0, `intro broke the rules: "${intro}"`);
  }
});

test('rank: widest size availability first, then price', () => {
  const wide = { ...product('wide', ['work'], 'tops'), sizes: [
    { size: 'S', stock: 1 }, { size: 'M', stock: 1 }, { size: 'L', stock: 1 },
  ] };
  const narrow = { ...product('narrow', ['work'], 'tops'), priceINR: 1000 };

  // Availability wins even though `narrow` is cheaper.
  assert.deepEqual(rankOrder([narrow, wide]).map((p) => p.id), ['wide', 'narrow']);
});

test('checkout links carry the size and the attribution UTMs', () => {
  // These UTMs are the only join between a WhatsApp session and a Shopify
  // order, since a Worker cannot observe the shopper returning from checkout.
  const url = new URL(checkoutUrl(product('a', ['work'], 'tops'), 'M'));
  assert.equal(url.searchParams.get('variant'), 'M');
  assert.equal(url.searchParams.get('utm_source'), 'whatsapp');
  assert.equal(url.searchParams.get('utm_medium'), 'ai-stylist');
});

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

test('config: required keys are reported when absent', () => {
  assert.deepEqual(missingRequired({}), ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN']);
  assert.deepEqual(
    missingRequired({ WHATSAPP_TOKEN: 'a', PHONE_NUMBER_ID: 'b', VERIFY_TOKEN: 'c' }),
    [],
  );
});

test('config: values are trimmed', () => {
  // A secret pasted into a .env file routinely picks up a trailing newline,
  // and the resulting auth failure names neither the token nor the whitespace.
  const cfg = configFromProcess({ WHATSAPP_TOKEN: '  abc\n', PHONE_NUMBER_ID: '123' });
  assert.equal(cfg.WHATSAPP_TOKEN, 'abc');
});

test('config: empty strings are treated as unset', () => {
  const cfg = configFromProcess({ APP_SECRET: '' });
  assert.equal(cfg.APP_SECRET, undefined);
});

test('config: a missing APP_SECRET is warned about explicitly', () => {
  const warnings = configWarnings({ WHATSAPP_TOKEN: 'a' });
  assert.ok(warnings.some((w) => w.includes('APP_SECRET')));
  assert.equal(configWarnings({ APP_SECRET: 's' }).some((w) => w.includes('APP_SECRET')), false);
});
