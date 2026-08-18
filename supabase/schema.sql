-- Reistor AI Stylist — analytics + state schema
--
-- Run once against your Supabase project:
--   Supabase Dashboard -> SQL Editor -> paste -> Run
-- Safe to re-run: every statement is IF NOT EXISTS / CREATE OR REPLACE.
--
-- This database serves two jobs at once:
--
--   1. Bot state. The `kv` table replaces Cloudflare Workers KV, so the same
--      bot code runs on Cloudflare today and on a Linode box later without a
--      storage rewrite. Nothing here is Cloudflare-specific.
--   2. Analytics. Everything the dashboard shows is a query over `events`,
--      `sessions` and `orders`.
--
-- `phone_number_id` is on every table on purpose: a test number and a live
-- number write into the same tables, and the board's numbers must not include
-- your own testing. Every dashboard view filters on it.

/* ------------------------------------------------------------------ *
 * 1. Bot state — the Workers KV replacement
 * ------------------------------------------------------------------ */

-- Conversation state, dedupe markers, the Shopify catalog cache and the
-- Shopify access token all live here, keyed exactly as they were in KV.
-- Expiry is stored rather than enforced by the engine, so reads must check it
-- (store.ts does) and a sweeper deletes the rows later.
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kv_expires_idx ON kv (expires_at)
  WHERE expires_at IS NOT NULL;

-- Deletes expired rows. Called opportunistically by the cron job; there is no
-- correctness dependency on it, since reads already treat an expired row as
-- absent.
CREATE OR REPLACE FUNCTION kv_sweep() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

/* ------------------------------------------------------------------ *
 * 2. Shoppers
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS shoppers (
  wa_id             TEXT PRIMARY KEY,
  phone_number_id   TEXT,
  profile_name      TEXT,
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sessions_count    INTEGER NOT NULL DEFAULT 0,

  -- Set from the user_preferences webhook. Meta's policy requires honouring an
  -- opt-out; marketing sends must check this before any template goes out.
  marketing_opt_out BOOLEAN NOT NULL DEFAULT false,
  opt_out_at        TIMESTAMPTZ,
  opt_in_source     TEXT,
  opt_in_at         TIMESTAMPTZ,

  -- Set when a shopper asks for a person. Pauses automated replies.
  needs_human       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS shoppers_optout_idx ON shoppers (marketing_opt_out)
  WHERE marketing_opt_out = true;

/* ------------------------------------------------------------------ *
 * 3. Sessions — one row per shopper journey
 * ------------------------------------------------------------------ */

-- A session is the unit the funnel counts. `last_step` is the furthest point
-- reached, which is what makes drop-off measurable: Meta never tells you where
-- somebody stopped, because a shopper who ignores a message generates no event
-- at all. Absence of a next step is the only signal, so it is recorded here.
CREATE TABLE IF NOT EXISTS sessions (
  session_id        UUID PRIMARY KEY,
  wa_id             TEXT NOT NULL,
  phone_number_id   TEXT,

  occasion          TEXT,
  category          TEXT,

  last_step         TEXT NOT NULL DEFAULT 'welcome',
  -- Highest step reached, ordered by FUNNEL_ORDER in log.ts. Kept separate
  -- from last_step because a shopper can go back to browsing after sizing.
  furthest_step     TEXT NOT NULL DEFAULT 'welcome',

  looks_shown       INTEGER NOT NULL DEFAULT 0,
  products_shown    TEXT[] NOT NULL DEFAULT '{}',
  product_picked    TEXT,
  size_picked       TEXT,
  checkout_opened   BOOLEAN NOT NULL DEFAULT false,
  ordered           BOOLEAN NOT NULL DEFAULT false,

  -- True when widenCandidates() had to drop part of the brief, i.e. the
  -- catalog had nothing for what the shopper actually asked for.
  widened           BOOLEAN NOT NULL DEFAULT false,
  stylist_used      BOOLEAN NOT NULL DEFAULT false,

  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Written by the cron sweep once a session has been silent past the cutoff.
  dropped_at_step   TEXT,
  dropped_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_wa_idx     ON sessions (wa_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_phone_idx   ON sessions (phone_number_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_open_idx    ON sessions (last_at)
  WHERE dropped_at IS NULL AND ordered = false;

/* ------------------------------------------------------------------ *
 * 4. Events — every message in and out, plus notable internal moments
 * ------------------------------------------------------------------ */

-- event_type values:
--   message          a real WhatsApp message, in or out
--   status           delivery receipt for one of our sends (carries pricing)
--   opt_out          user_preferences webhook, stop or resume
--   template_status  template approved / paused / disabled
--   quality          phone number quality rating changed
--   account          account_update: policy violation, verification, ban
--   looks_shown      a round of recommendations went out
--   size_sold_out    a shopper reached sizing and their size was gone
--   widened          the brief was widened because the exact pair was empty
--   fallback         a send was rejected and the code fell back
CREATE TABLE IF NOT EXISTS events (
  id                BIGSERIAL PRIMARY KEY,
  -- Meta's message id. Unique when present, so a webhook retry cannot insert
  -- the same message twice; internal events leave it null.
  wamid             TEXT,
  wa_id             TEXT,
  session_id        UUID,
  phone_number_id   TEXT,

  direction         TEXT,      -- 'in' | 'out' | 'system'
  event_type        TEXT NOT NULL,
  flow_step         TEXT,      -- the funnel step this belongs to. We set it; Meta never does.
  message_type      TEXT,      -- text | interactive | button | image | order | template
  payload_id        TEXT,      -- reply id or template quick-reply payload

  product_ids       TEXT[],
  size              TEXT,

  status            TEXT,      -- sent | delivered | read | failed
  -- Straight from the status webhook's pricing object. This is how cost per
  -- session and cost per order are computed without waiting for a monthly bill.
  billable          BOOLEAN,
  pricing_category  TEXT,      -- marketing | utility | service | authentication
  pricing_type      TEXT,      -- regular | free_customer_service | free_entry_point
  error_code        INTEGER,
  error_title       TEXT,

  template_name     TEXT,
  meta              JSONB,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index rather than a column constraint: internal events have
-- no wamid, and multiple NULLs must stay allowed.
CREATE UNIQUE INDEX IF NOT EXISTS events_wamid_status_idx
  ON events (wamid, status) WHERE wamid IS NOT NULL AND status IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_ts_idx       ON events (ts DESC);
CREATE INDEX IF NOT EXISTS events_wa_idx       ON events (wa_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_session_idx  ON events (session_id);
CREATE INDEX IF NOT EXISTS events_type_idx     ON events (event_type, ts DESC);
CREATE INDEX IF NOT EXISTS events_phone_idx    ON events (phone_number_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_products_idx ON events USING GIN (product_ids);

/* ------------------------------------------------------------------ *
 * 5. Orders — pulled from Shopify, joined back by UTM
 * ------------------------------------------------------------------ */

-- A Worker cannot observe a shopper returning from checkout, so orders are not
-- learned from WhatsApp at all. They are pulled from Shopify and matched by the
-- utm_source=whatsapp / utm_medium=ai-stylist stamped on every checkout URL by
-- checkoutUrl(). That is the only reliable revenue join.
CREATE TABLE IF NOT EXISTS orders (
  order_id      TEXT PRIMARY KEY,
  order_number  TEXT,
  wa_id         TEXT,
  session_id    UUID,
  total_inr     NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'INR',
  landing_site  TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  financial_status TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_utm_idx     ON orders (utm_source, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_wa_idx      ON orders (wa_id);

CREATE TABLE IF NOT EXISTS order_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
  product_id    TEXT,
  variant_sku   TEXT,
  title         TEXT,
  size          TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1,
  price_inr     NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS order_items_unique_idx
  ON order_items (order_id, product_id, size);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);

/* ------------------------------------------------------------------ *
 * 6. Meta pulls — template performance and account health
 * ------------------------------------------------------------------ */

-- Meta keeps template read/click data for only 7 days, so it is copied here
-- daily. Without this the dashboard cannot show a month of campaign
-- performance no matter how the query is written.
/* ------------------------------------------------------------------ *
 * 6a. Product names
 * ------------------------------------------------------------------ */

-- A product id on its own is a Shopify number, which tells a buyer nothing.
-- Titles cannot come from `order_items`, because the products that matter most
-- here — the ones on the restock list — are precisely the ones that never
-- sold. So the name is captured at the moment a product is shown or found
-- sold out, and the dashboard views join against it.
CREATE TABLE IF NOT EXISTS product_names (
  product_id  TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  price_inr   NUMERIC(12,2),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_stats (
  date          DATE NOT NULL,
  template_id   TEXT NOT NULL,
  template_name TEXT,
  sent          INTEGER NOT NULL DEFAULT 0,
  delivered     INTEGER NOT NULL DEFAULT 0,
  read          INTEGER NOT NULL DEFAULT 0,
  clicked       INTEGER NOT NULL DEFAULT 0,
  cost_inr      NUMERIC(12,2) NOT NULL DEFAULT 0,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, template_id)
);

CREATE TABLE IF NOT EXISTS account_health (
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  phone_number_id TEXT NOT NULL,
  quality_rating  TEXT,
  messaging_tier  TEXT,
  templates       JSONB,
  PRIMARY KEY (captured_at, phone_number_id)
);

/* ------------------------------------------------------------------ *
 * 7. Views — one per dashboard tile
 *
 * Views rather than a nightly rollup table, so every number is live and there
 * is no job whose failure silently freezes the dashboard.
 * ------------------------------------------------------------------ */

-- Funnel. Ordinal ordering is explicit so the steps render in journey order
-- rather than alphabetically.
CREATE OR REPLACE VIEW v_funnel AS
SELECT
  phone_number_id,
  date_trunc('day', started_at) AS day,
  COUNT(*)                                                     AS started,
  COUNT(*) FILTER (WHERE occasion IS NOT NULL)                 AS picked_occasion,
  COUNT(*) FILTER (WHERE category IS NOT NULL)                 AS picked_category,
  COUNT(*) FILTER (WHERE looks_shown > 0)                      AS saw_looks,
  COUNT(*) FILTER (WHERE product_picked IS NOT NULL)           AS opened_product,
  COUNT(*) FILTER (WHERE size_picked IS NOT NULL)              AS picked_size,
  COUNT(*) FILTER (WHERE checkout_opened)                      AS opened_checkout,
  COUNT(*) FILTER (WHERE ordered)                              AS ordered,
  COUNT(*) FILTER (WHERE stylist_used)                         AS used_stylist,
  COUNT(*) FILTER (WHERE widened)                              AS widened_brief
FROM sessions
GROUP BY 1, 2;

-- Where sessions died. Answers "on which chats did I lose conversion".
CREATE OR REPLACE VIEW v_dropoff AS
SELECT
  phone_number_id,
  COALESCE(dropped_at_step, furthest_step) AS step,
  COUNT(*)      AS sessions,
  MIN(last_at)  AS first_seen,
  MAX(last_at)  AS last_seen
FROM sessions
WHERE ordered = false
GROUP BY 1, 2;

-- Best sellers, from real Shopify orders attributed to WhatsApp.
CREATE OR REPLACE VIEW v_top_products AS
SELECT
  oi.product_id,
  MAX(oi.title)              AS title,
  SUM(oi.quantity)           AS units_sold,
  SUM(oi.price_inr * oi.quantity) AS revenue_inr,
  COUNT(DISTINCT o.order_id) AS orders,
  MAX(o.created_at)          AS last_sold_at
FROM order_items oi
JOIN orders o ON o.order_id = oi.order_id
WHERE o.utm_source = 'whatsapp'
GROUP BY oi.product_id;

-- Per-product conversion: shown in chat -> sized -> ordered.
-- `shown` unnests products_shown, so a product counts once per session it
-- appeared in rather than once per message.
-- Dropped rather than replaced: CREATE OR REPLACE VIEW cannot add a column to
-- an existing view, so a re-run against an older schema would fail.
DROP VIEW IF EXISTS v_product_conversion;
CREATE VIEW v_product_conversion AS
WITH shown AS (
  SELECT UNNEST(products_shown) AS product_id, COUNT(*) AS times_shown
  FROM sessions GROUP BY 1
),
sized AS (
  SELECT product_picked AS product_id, COUNT(*) AS times_sized
  FROM sessions WHERE product_picked IS NOT NULL GROUP BY 1
),
sold AS (
  SELECT oi.product_id, SUM(oi.quantity) AS units_sold
  FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
  WHERE o.utm_source = 'whatsapp' GROUP BY 1
)
SELECT
  s.product_id,
  -- Falls back to the sold title, then to nothing; the dashboard shows the id
  -- only when neither source has ever seen this product.
  COALESCE(pn.title, (
    SELECT MAX(oi.title) FROM order_items oi WHERE oi.product_id = s.product_id
  )) AS title,
  s.times_shown,
  COALESCE(z.times_sized, 0) AS times_sized,
  COALESCE(d.units_sold, 0)  AS units_sold,
  ROUND(100.0 * COALESCE(d.units_sold, 0) / NULLIF(s.times_shown, 0), 1) AS conversion_pct
FROM shown s
LEFT JOIN sized z ON z.product_id = s.product_id
LEFT JOIN sold  d ON d.product_id = s.product_id
LEFT JOIN product_names pn ON pn.product_id = s.product_id;

-- Lost demand: a shopper wanted a size that was gone. Direct restock input,
-- and the only place the bot can quantify revenue it could not capture.
DROP VIEW IF EXISTS v_lost_demand;
CREATE VIEW v_lost_demand AS
WITH turned_away AS (
  SELECT phone_number_id, UNNEST(product_ids) AS product_id, size, ts
  FROM events
  WHERE event_type = 'size_sold_out'
)
SELECT
  t.phone_number_id,
  t.product_id,
  -- The name matters more here than anywhere else: this list goes to the
  -- buying team, and "7382101" is not something anyone can act on.
  pn.title,
  t.size,
  COUNT(*)     AS times,
  MAX(t.ts)    AS last_at
FROM turned_away t
LEFT JOIN product_names pn ON pn.product_id = t.product_id
GROUP BY 1, 2, 3, 4;

-- What shoppers asked for, occasion x category. Compare against stock to see
-- where the catalog is thin.
CREATE OR REPLACE VIEW v_demand_grid AS
SELECT
  phone_number_id,
  occasion,
  category,
  COUNT(*)                              AS requests,
  COUNT(*) FILTER (WHERE widened)       AS had_nothing,
  COUNT(*) FILTER (WHERE ordered)       AS orders
FROM sessions
WHERE occasion IS NOT NULL AND category IS NOT NULL
GROUP BY 1, 2, 3;

-- Spend, straight from the pricing object on delivery receipts.
CREATE OR REPLACE VIEW v_message_cost AS
SELECT
  phone_number_id,
  date_trunc('day', ts) AS day,
  pricing_category,
  COUNT(*) FILTER (WHERE billable)       AS billable_messages,
  COUNT(*) FILTER (WHERE NOT billable)   AS free_messages,
  COUNT(*)                               AS total_messages
FROM events
WHERE event_type = 'status' AND status = 'sent'
GROUP BY 1, 2, 3;

-- Delivery quality. read_pct is advisory: a shopper who disables read receipts
-- never produces a read status, so this is a floor, not a true rate.
CREATE OR REPLACE VIEW v_delivery AS
SELECT
  phone_number_id,
  date_trunc('day', ts) AS day,
  COUNT(*) FILTER (WHERE status = 'sent')      AS sent,
  COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
  COUNT(*) FILTER (WHERE status = 'read')      AS read,
  COUNT(*) FILTER (WHERE status = 'failed')    AS failed
FROM events
WHERE event_type = 'status'
GROUP BY 1, 2;

-- Who stopped, and how. Explicit opt-out is exact; abandonment is inferred.
CREATE OR REPLACE VIEW v_attrition AS
SELECT
  s.phone_number_id,
  s.wa_id,
  sh.marketing_opt_out,
  sh.opt_out_at,
  MAX(s.last_at)                                   AS last_activity,
  COUNT(*)                                         AS sessions,
  COUNT(*) FILTER (WHERE s.ordered)                AS orders,
  MAX(s.dropped_at_step)                           AS last_dropped_step
FROM sessions s
LEFT JOIN shoppers sh ON sh.wa_id = s.wa_id
GROUP BY 1, 2, 3, 4;

/* ------------------------------------------------------------------ *
 * 8. Row level security
 *
 * RLS on with no policies means the anon key can read nothing. The dashboard
 * runs server-side on Linode and uses the service role key, which bypasses
 * RLS — so there is never a browser holding a key that can read shopper
 * phone numbers.
 * ------------------------------------------------------------------ */

ALTER TABLE kv              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shoppers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_names   ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_health  ENABLE ROW LEVEL SECURITY;
