/* ==================================================================== *
 * Analytics extension
 *
 * Additive only. Run it after schema.sql, and safe to run twice — every
 * statement is IF NOT EXISTS or CREATE OR REPLACE, so it can be re-applied
 * after an edit without dropping a row.
 *
 * Covers the seven reports the base schema cannot answer:
 *
 *   1. Acquisition      which ad or link produced orders, not just chats
 *   2. Risk             quality rating over time, opt-out rate, block proxy
 *   3. Search misses    what shoppers typed that the bot did not understand
 *   4. Timing           time to purchase, repeat rate, hour-of-day
 *   5. Carts            sent but never paid
 *   6. Conversations    per-shopper transcripts
 *   7. Stock            demand against what is actually on the shelf
 * ==================================================================== */


/* Fails early and says why. Without this the first ALTER reports
   "relation sessions does not exist", which reads like a broken file rather
   than a file run in the wrong order. */
DO $$
BEGIN
  IF to_regclass('public.sessions') IS NULL THEN
    RAISE EXCEPTION
      'Run schema.sql first. This file extends its tables and cannot create them.';
  END IF;
END $$;


/* ------------------------------------------------------------------ *
 * 1. Entry source — where the shopper came from
 *
 * A Click-to-WhatsApp ad delivers a `referral` object on the FIRST inbound
 * message and never again, so it has to be captured at that moment or it is
 * gone. `ctwa_clid` is the join key Meta's Conversions API uses to credit a
 * purchase back to the ad, which is why it is stored unhashed and untouched.
 *
 * Everything else — Instagram bio, a QR code on a hangtag — arrives through a
 * prefilled wa.me message instead, parsed into utm_source.
 * ------------------------------------------------------------------ */

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS entry_source       TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ctwa_clid          TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_id              TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_url         TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS referral_headline  TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_source         TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_campaign       TEXT;

-- Timing. `ordered_at` is duplicated from orders on purpose: time-to-purchase
-- is asked for constantly and joining orders for every row of the funnel is
-- wasteful when the answer never changes once written.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cart_sent_at       TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS checkout_opened_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ordered_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sessions_source_idx ON sessions (entry_source, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_ctwa_idx   ON sessions (ctwa_clid) WHERE ctwa_clid IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_cart_idx   ON sessions (cart_sent_at)
  WHERE cart_sent_at IS NOT NULL AND ordered = false;


/* ------------------------------------------------------------------ *
 * 2. Message bodies — the transcript
 *
 * The events table records that a message happened and what kind it was, but
 * not what it said, so "show me this customer's conversation" cannot be
 * answered from it.
 *
 * Derived from `meta` rather than written directly, so the analytics writer
 * needs no change at all: a call site passes `meta: { body: text }` and the
 * column fills itself. That keeps log.ts untouched and mergeable with the
 * branch it came from.
 *
 * RETENTION. This holds what shoppers actually typed, which under the DPDP Act
 * is personal data collected for a stated purpose. Keep it to a window rather
 * than forever — the sweep at the bottom of this file strips the text after 90
 * days while leaving the event row, so the funnel keeps counting a message
 * whose words are long gone.
 * ------------------------------------------------------------------ */

ALTER TABLE events ADD COLUMN IF NOT EXISTS body TEXT
  GENERATED ALWAYS AS (meta ->> 'body') STORED;


/* ------------------------------------------------------------------ *
 * 3. Search misses — what the bot could not answer
 *
 * Every typed message that matched no greeting, no occasion, no category and
 * no keyword. For a stylist bot this is the most direct product feedback
 * there is: occasions you do not offer, categories you do not stock, and
 * questions nobody has written an answer for.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS search_misses (
  id          BIGSERIAL PRIMARY KEY,
  wa_id       TEXT,
  session_id  UUID,
  -- Lower-cased and trimmed at write time so grouping does not have to.
  normalised  TEXT NOT NULL,
  raw         TEXT NOT NULL,
  -- Where in the flow they were when they typed it. "welcome" means they
  -- ignored the carousel entirely, which reads very differently from a miss
  -- at the size step.
  flow_step   TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_misses_norm_idx ON search_misses (normalised);
CREATE INDEX IF NOT EXISTS search_misses_ts_idx   ON search_misses (ts DESC);


/* ------------------------------------------------------------------ *
 * 4. CAPI events — what was reported to Meta
 *
 * Written after a successful send so a retry cannot double-count a purchase
 * in ad reporting. `event_id` is our idempotency key and is also sent to
 * Meta, which deduplicates on it.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS capi_events (
  event_id     TEXT PRIMARY KEY,
  event_name   TEXT NOT NULL,
  wa_id        TEXT,
  session_id   UUID,
  ctwa_clid    TEXT,
  value_inr    NUMERIC(12,2),
  order_id     TEXT,
  -- null until Meta answers; a failed send is worth seeing rather than hiding
  response_code INTEGER,
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capi_sent_idx ON capi_events (sent_at DESC);


/* ------------------------------------------------------------------ *
 * 5. Stock snapshots — demand measured against the shelf
 *
 * Lost demand alone says a size was gone. Joined against stock it says
 * whether it is still gone, which is the difference between a report and a
 * restocking list.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS product_stock (
  product_id   TEXT NOT NULL,
  size         TEXT NOT NULL,
  stock        INTEGER NOT NULL DEFAULT 0,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, size)
);


/* ==================================================================== *
 * Views — one per report
 * ==================================================================== */

/* ------------------------------------------------------------------ *
 * Acquisition: chats -> orders -> revenue, per source
 *
 * The whole point of the tile. A source that produces conversations but no
 * orders is costing money, and the base funnel cannot show that because it
 * has no idea where anyone came from.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_acquisition AS
SELECT
  COALESCE(s.entry_source, 'organic')                        AS source,
  COALESCE(s.utm_campaign, s.ad_id, '—')                     AS campaign,
  DATE(s.started_at)                                         AS day,
  s.phone_number_id,
  COUNT(*)                                                   AS sessions,
  COUNT(*) FILTER (WHERE s.furthest_step <> 'welcome')       AS engaged,
  COUNT(*) FILTER (WHERE s.ordered)                          AS orders,
  COALESCE(SUM(o.total_inr) FILTER (WHERE s.ordered), 0)     AS revenue_inr,
  ROUND(
    COUNT(*) FILTER (WHERE s.ordered)::numeric
      / NULLIF(COUNT(*), 0) * 100, 1)                        AS conversion_pct
FROM sessions s
LEFT JOIN orders o ON o.session_id = s.session_id
GROUP BY 1, 2, 3, 4;


/* ------------------------------------------------------------------ *
 * Risk: quality over time
 *
 * Meta drops a messaging tier with little warning. A rating that went GREEN →
 * YELLOW three days ago is the signal worth acting on, and it is invisible in
 * a single snapshot.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_quality_trend AS
SELECT
  DATE(captured_at)                    AS day,
  phone_number_id,
  -- Worst reading of the day rather than the last: a rating that dipped and
  -- recovered still happened, and is what predicts the next dip.
  MIN(CASE quality_rating
        WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 WHEN 'GREEN' THEN 3 ELSE 4 END) AS worst_rank,
  MAX(messaging_tier)                  AS messaging_tier
FROM account_health
GROUP BY 1, 2
ORDER BY 1 DESC;


/* ------------------------------------------------------------------ *
 * Risk: opt-outs, the leading indicator of a block
 *
 * Attributed to the last template that reached the shopper before they left,
 * which is the closest thing to a cause the data supports. It is an
 * association, not proof, and the dashboard says so.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_optout_by_campaign AS
WITH last_template AS (
  SELECT DISTINCT ON (e.wa_id)
    e.wa_id,
    e.template_name
  FROM events e
  WHERE e.direction = 'out' AND e.template_name IS NOT NULL
  ORDER BY e.wa_id, e.ts DESC
)
SELECT
  COALESCE(lt.template_name, '— no template —')  AS template_name,
  DATE(sh.opt_out_at)                            AS day,
  COUNT(*)                                       AS opt_outs
FROM shoppers sh
LEFT JOIN last_template lt ON lt.wa_id = sh.wa_id
WHERE sh.marketing_opt_out = true AND sh.opt_out_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 2 DESC, 3 DESC;


/* ------------------------------------------------------------------ *
 * Search misses, grouped
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_search_misses AS
SELECT
  normalised,
  COUNT(*)                        AS times,
  COUNT(DISTINCT wa_id)           AS shoppers,
  MAX(ts)                         AS last_at,
  -- One example of the raw text, so the report shows what was actually typed
  -- rather than only the normalised form.
  (ARRAY_AGG(raw ORDER BY ts DESC))[1] AS example,
  (ARRAY_AGG(flow_step ORDER BY ts DESC))[1] AS last_step
FROM search_misses
GROUP BY 1
ORDER BY times DESC;


/* ------------------------------------------------------------------ *
 * Timing: how long a purchase takes
 *
 * Reported as a median rather than a mean. One shopper who buys three weeks
 * later drags an average past anything useful.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_time_to_purchase AS
SELECT
  DATE(started_at)                                            AS day,
  COUNT(*)                                                    AS orders,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (ordered_at - started_at)) / 60)::numeric, 1) AS median_minutes,
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (ordered_at - started_at)) / 60)::numeric, 1) AS p90_minutes
FROM sessions
WHERE ordered = true AND ordered_at IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;


/* ------------------------------------------------------------------ *
 * Repeat rate and value per shopper
 *
 * The number that decides whether WhatsApp is a channel or a campaign.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_shopper_value AS
SELECT
  sh.wa_id,
  sh.profile_name,
  sh.first_seen,
  sh.last_seen,
  sh.sessions_count,
  COUNT(o.order_id)                                   AS orders,
  COALESCE(SUM(o.total_inr), 0)                       AS revenue_inr,
  ROUND(COALESCE(AVG(o.total_inr), 0), 2)             AS aov_inr,
  COUNT(o.order_id) > 1                               AS is_repeat
FROM shoppers sh
LEFT JOIN orders o ON o.wa_id = sh.wa_id
GROUP BY 1, 2, 3, 4, 5;

CREATE OR REPLACE VIEW v_repeat_rate AS
SELECT
  COUNT(*) FILTER (WHERE orders > 0)                              AS buyers,
  COUNT(*) FILTER (WHERE is_repeat)                               AS repeat_buyers,
  ROUND(COUNT(*) FILTER (WHERE is_repeat)::numeric
    / NULLIF(COUNT(*) FILTER (WHERE orders > 0), 0) * 100, 1)     AS repeat_pct,
  ROUND(AVG(aov_inr) FILTER (WHERE orders > 0), 2)                AS aov_inr
FROM v_shopper_value;


/* ------------------------------------------------------------------ *
 * Timing: when people actually message
 *
 * Day of week against hour, for deciding when a campaign should go out.
 * Times are UTC — the dashboard shifts them to IST for display rather than
 * baking a timezone into the data.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_hour_heatmap AS
SELECT
  EXTRACT(DOW  FROM ts)::int                       AS dow,
  EXTRACT(HOUR FROM ts)::int                       AS hour,
  COUNT(*)                                         AS messages,
  COUNT(DISTINCT wa_id)                            AS shoppers
FROM events
WHERE direction = 'in' AND event_type = 'message'
GROUP BY 1, 2;


/* ------------------------------------------------------------------ *
 * Carts sent and never paid
 *
 * A sent cart is the strongest intent signal in the whole flow — they picked
 * the garment and pressed send. Recovering it costs a template outside the
 * 24-hour window, so `window_open` is carried to make that cost visible
 * before anyone spends it.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_abandoned_carts AS
SELECT
  s.session_id,
  s.wa_id,
  sh.profile_name,
  s.occasion,
  s.category,
  s.product_picked,
  s.size_picked,
  s.cart_sent_at,
  s.checkout_opened_at,
  ROUND(EXTRACT(EPOCH FROM (now() - s.cart_sent_at)) / 3600, 1) AS hours_since,
  (now() - s.last_at) < INTERVAL '24 hours'                     AS window_open,
  sh.marketing_opt_out
FROM sessions s
LEFT JOIN shoppers sh ON sh.wa_id = s.wa_id
WHERE s.cart_sent_at IS NOT NULL AND s.ordered = false
ORDER BY s.cart_sent_at DESC;


/* ------------------------------------------------------------------ *
 * Does the human stylist actually close?
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_callback_conversion AS
SELECT
  DATE(cr.requested_at)                                     AS day,
  COUNT(*)                                                  AS requests,
  COUNT(*) FILTER (WHERE cr.status <> 'pending')            AS called,
  COUNT(DISTINCT o.order_id)                                AS orders_after,
  COALESCE(SUM(o.total_inr), 0)                             AS revenue_inr
FROM callback_requests cr
LEFT JOIN orders o
  ON o.wa_id = cr.wa_id AND o.created_at > cr.requested_at
GROUP BY 1
ORDER BY 1 DESC;


/* ------------------------------------------------------------------ *
 * Demand against the shelf
 *
 * Left join, not inner: a size nobody has stocked at all has no row in
 * product_stock, and that is exactly the case worth surfacing.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE VIEW v_size_vs_stock AS
SELECT
  ld.product_id,
  pn.title,
  ld.size,
  ld.times                                    AS turned_away,
  COALESCE(ps.stock, 0)                       AS stock_now,
  ps.captured_at                              AS stock_read_at,
  COALESCE(ps.stock, 0) = 0                   AS still_gone
FROM v_lost_demand ld
LEFT JOIN product_stock ps
  ON ps.product_id = ld.product_id AND ps.size = ld.size
LEFT JOIN product_names pn ON pn.product_id = ld.product_id
ORDER BY ld.times DESC;


/* ------------------------------------------------------------------ *
 * Retention sweep
 *
 * Call from the nightly job. Clears message text past the window while
 * leaving the event row intact, so every count on the dashboard keeps
 * working on a conversation whose words are gone.
 * ------------------------------------------------------------------ */
CREATE OR REPLACE FUNCTION redact_old_message_bodies(days INTEGER DEFAULT 90)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE affected INTEGER;
BEGIN
  -- `body` is generated from meta, so the text is removed at the source. The
  -- rest of `meta` survives: it carries counts and ids the reports still need.
  UPDATE events
     SET meta = meta - 'body'
   WHERE meta ? 'body'
     AND ts < now() - (days || ' days')::INTERVAL;
  GET DIAGNOSTICS affected = ROW_COUNT;

  DELETE FROM search_misses WHERE ts < now() - (days || ' days')::INTERVAL;
  RETURN affected;
END $$;


/* ==================================================================== *
 * Grants
 *
 * The Worker connects as `service_role`. Supabase grants that role
 * automatically for tables it creates through its own tooling, but a schema
 * applied straight from the SQL editor is owned by `postgres` with nothing
 * granted onward — and then every read and write comes back 42501,
 * "permission denied", which the analytics layer swallows. The dashboard then
 * shows a confident zero instead of an error.
 *
 * Sequences matter as much as tables: events and search_misses are BIGSERIAL,
 * and an insert is refused without the sequence grant even when the table
 * grant is in place.
 * ==================================================================== */

GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Anything added later inherits the same grants, so this is a one-off.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
