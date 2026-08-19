/**
 * The callback inbox, and the Meta policy rules it has to respect.
 *
 * This table is the only place a human-dialable phone number is surfaced, so
 * the rules around it are asserted rather than remembered. Each test below
 * corresponds to a way a business actually gets restricted:
 *
 *   - reusing service contacts for marketing
 *   - messaging outside the 24-hour window without a template
 *   - ignoring an opt-out
 *   - exposing customer data beyond the people meant to see it
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Analytics, getAnalytics } from '../dist/analytics/log.js';
import { COPY, copyViolations } from '../dist/copy.js';

const schema = readFileSync('supabase/schema.sql', 'utf8');
const page = readFileSync('web/dashboard.html', 'utf8');

/* ------------------------------------------------------------------ *
 * The promise the bot makes
 * ------------------------------------------------------------------ */

test('a callback is only promised when it was actually recorded', async () => {
  /*
   * With analytics unconfigured, callbackRequest() returns false. The router
   * uses that to pick the copy — promising a call nobody will see is worse
   * than not offering one.
   */
  const offline = getAnalytics({});
  assert.equal(await offline.callbackRequest({ waId: '919876543210' }), false);
  assert.ok(offline instanceof Analytics);
});

test('both callback replies exist and obey the brand rules', () => {
  assert.ok(COPY.stylistCallback, 'the promise copy');
  assert.ok(COPY.stylistCallbackUnavailable, 'the fallback when nothing was stored');
  assert.equal(copyViolations(COPY.stylistCallback).length, 0);
  assert.equal(copyViolations(COPY.stylistCallbackUnavailable).length, 0);
});

test('the fallback copy makes no promise it cannot keep', () => {
  // It must not say anyone will call, because nothing was recorded.
  assert.doesNotMatch(COPY.stylistCallbackUnavailable, /\bcall\b/i);
});

/* ------------------------------------------------------------------ *
 * Meta policy — the ways a business gets restricted
 * ------------------------------------------------------------------ */

test('policy: one open request per shopper, so nobody is rung repeatedly', () => {
  // Three taps is impatience, not three customers.
  assert.match(
    schema,
    /CREATE UNIQUE INDEX[\s\S]*callback_one_open_per_shopper[\s\S]*WHERE status = 'pending'/,
  );
});

test('policy: the marketing opt-out travels with every row', () => {
  // Asking for a callback is service, not consent to be marketed at. The flag
  // has to reach the screen or somebody will export the list for a promo.
  assert.match(schema, /marketing_opt_out[\s\S]*AS marketing_opt_out|COALESCE\(s\.marketing_opt_out/);
  assert.ok(page.includes('opted out of marketing'), 'the flag is shown to whoever calls');
});

test('policy: the 24-hour service window is recorded, not assumed', () => {
  // A phone call is unaffected by it; a WhatsApp reply after it closes needs
  // an approved template. Recording it is what lets anyone tell the difference.
  assert.match(schema, /window_expires_at[\s\S]*interval '24 hours'/);
  assert.match(schema, /window_open/);
});

test('policy: the table carries no marketing-consent field to misuse', () => {
  // There is deliberately nothing here that could be read as "opted in".
  const table = schema.slice(
    schema.indexOf('CREATE TABLE IF NOT EXISTS callback_requests'),
    schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS callback_one_open_per_shopper'),
  );
  assert.doesNotMatch(table, /marketing_consent|opt_in|subscribed|promo/i);
});

test('policy: purpose limitation is stated where the numbers are shown', () => {
  assert.ok(
    page.includes('use them for that, and nothing else'),
    'the tile says what the numbers may be used for',
  );
});

test('policy: row level security is on, so the anon key reads nothing', () => {
  assert.match(schema, /ALTER TABLE callback_requests ENABLE ROW LEVEL SECURITY/);
});

/* ------------------------------------------------------------------ *
 * Exposure
 * ------------------------------------------------------------------ */

test('the dashboard page is never indexable or cacheable', () => {
  // A page listing customer phone numbers must not end up in a search index
  // or a shared proxy cache.
  assert.match(page, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  const route = readFileSync('src/dashboard/route.ts', 'utf8');
  assert.match(route, /'cache-control': 'no-store'/);
  assert.match(route, /'referrer-policy': 'no-referrer'/);
});

test('the write endpoint is the only POST, and it is token guarded', () => {
  const route = readFileSync('src/dashboard/route.ts', 'utf8');
  // Exactly one path accepts a write.
  assert.match(route, /path === '\/dashboard\/api\/callback' && request\.method === 'POST'/);
  // And the token check sits above it, not after.
  assert.ok(
    route.indexOf("tokenMatches(supplied") < route.indexOf('if (isCallbackWrite)'),
    'the token is verified before any write runs',
  );
});

test('marking called cannot overwrite an earlier record', () => {
  const queries = readFileSync('src/dashboard/queries.ts', 'utf8');
  // status=eq.pending in the filter means a double submit updates nothing,
  // rather than rewriting who called and when.
  assert.match(queries, /'callback_requests',\s*`id=eq\.\$\{id\}&status=eq\.pending`/);
});

test('agent and notes are length-capped before they reach the database', () => {
  const queries = readFileSync('src/dashboard/queries.ts', 'utf8');
  assert.match(queries, /agent\.slice\(0, 80\)/);
  assert.match(queries, /notes\.slice\(0, 500\)/);
});
