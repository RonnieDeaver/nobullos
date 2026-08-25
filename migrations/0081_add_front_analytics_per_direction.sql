-- Task #1974 — per-direction message coverage on
-- `front_analytics_monthly_coverage`. Adds Front-side denominators
-- and local numerators split inbound/outbound, plus derived
-- coverage % and gap columns, and a `direction_data_source` audit
-- column tracking which Front surface served the per-direction data.
--
-- Migration is additive and idempotent. Legacy columns
-- (`front_total_messages`, `fetched_into_nobull`, `applied_into_nobull`,
-- `analytics_messages_inbound`, etc.) are preserved read-only for
-- back-compat. Backfill of `messages_inbound_front` from
-- `analytics_messages_inbound` is done where the latter is set and
-- the former is still null — the Analytics value was always
-- inbound-only so it maps directly.
--
-- All new columns are nullable. Plan-limited months (and rows that
-- pre-date this migration) leave per-direction columns NULL; the
-- admin UI surfaces "outbound not yet measured" instead of a false
-- 0/0 until the per-message enumeration fallback fills them in
-- (scaffolded; see FRONT_ANALYTICS_COVERAGE.md).

ALTER TABLE front_analytics_monthly_coverage
  ADD COLUMN IF NOT EXISTS messages_inbound_front integer,
  ADD COLUMN IF NOT EXISTS messages_outbound_front integer,
  ADD COLUMN IF NOT EXISTS messages_inbound_local integer,
  ADD COLUMN IF NOT EXISTS messages_outbound_local integer,
  ADD COLUMN IF NOT EXISTS messages_inbound_coverage_pct real,
  ADD COLUMN IF NOT EXISTS messages_outbound_coverage_pct real,
  ADD COLUMN IF NOT EXISTS messages_inbound_gap integer,
  ADD COLUMN IF NOT EXISTS messages_outbound_gap integer,
  ADD COLUMN IF NOT EXISTS direction_data_source varchar(32);

-- Backfill inbound from the existing Analytics diagnostic column.
UPDATE front_analytics_monthly_coverage
   SET messages_inbound_front = analytics_messages_inbound,
       direction_data_source  = COALESCE(direction_data_source, 'analytics_reports')
 WHERE analytics_messages_inbound IS NOT NULL
   AND messages_inbound_front IS NULL;
