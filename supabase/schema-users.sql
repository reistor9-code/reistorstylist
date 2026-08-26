-- Dashboard accounts.
--
-- The dashboard was one shared secret in a link. That works while one person
-- reads it on one laptop and stops working the moment the URL is public: the
-- secret names nobody, cannot be revoked for one person, and leaves no record
-- of who read a customer's transcript.
--
-- Identity comes from Google. Authorisation comes from this table, and from
-- nowhere else — a Google account proves who somebody is, not that they are
-- allowed in. Anyone who signs in is written down; only rows this table calls
-- 'active' are let through.
--
-- Run once:  psql "$DATABASE_URL" -f supabase/schema-users.sql
-- or paste into the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS dashboard_users (
  -- Lower-cased before it gets here, so the key is the person.
  email          TEXT PRIMARY KEY,
  name           TEXT,
  picture        TEXT,

  -- admin  sees phone numbers, transcripts and the analysis endpoint
  -- viewer  sees aggregates only
  role           TEXT NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('admin', 'viewer')),

  -- pending is the default on purpose. A new sign-in is a request for access,
  -- not a grant of it, and somebody has to say yes in this column.
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'active', 'blocked')),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

-- Who is waiting, oldest first. The list a human works through.
CREATE INDEX IF NOT EXISTS dashboard_users_pending_idx
  ON dashboard_users (created_at)
  WHERE status = 'pending';

-- Only the service key reaches this table — the browser never holds a Supabase
-- credential and the anon role has no business here. RLS with no policy denies
-- everything except the service key, which bypasses it.
ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;

-- ── Granting access ──────────────────────────────────────────────────
--
--   UPDATE dashboard_users SET status = 'active' WHERE email = 'someone@reistor.in';
--   UPDATE dashboard_users SET status = 'active', role = 'admin' WHERE email = '...';
--
-- ── Taking it away ───────────────────────────────────────────────────
--
--   UPDATE dashboard_users SET status = 'blocked' WHERE email = '...';
--
-- A blocked user keeps whatever session they already hold until it expires —
-- the role rides in the token so authorisation cannot fail open when the
-- database is unreachable. Twelve hours is the longest that can last. To end
-- it immediately, change DASHBOARD_JWT_SECRET, which invalidates every
-- session at once.
--
-- ── Who is waiting ───────────────────────────────────────────────────
--
--   SELECT email, name, created_at FROM dashboard_users
--    WHERE status = 'pending' ORDER BY created_at;
