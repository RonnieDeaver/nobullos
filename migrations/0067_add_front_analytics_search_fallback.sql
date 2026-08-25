-- Migration 0067 — Task #1681: Front Analytics search-API fallback for
-- plan-limited months (July–October 2025).
--
-- Front's Analytics Reports API returns a 403 with the literal message
-- "plan does not give you access to that time period" for months
-- outside the workspace's analytics retention window. For those months
-- we fall back to `GET /conversations/search/:query` with
-- `is:inbound after:<unix> before:<unix>` to recover a denominator.
--
-- The fallback's unit (inbound conversations) is NOT the same as the
-- Analytics metric (inbound messages), so we persist both source AND
-- unit alongside the count so the dashboard can pill the difference
-- and the alerts code can avoid apples-to-oranges threshold compares.
--
-- Memoization: `analytics_plan_limited_at` records the timestamp of
-- the most recent confirmed plan-limit response. The worker uses this
-- to skip the doomed Analytics submit for ~7 days (re-probe weekly so
-- the operator gets healed automatically if the workspace plan is
-- upgraded).
--
-- All columns nullable / defaulted so this migration is idempotent
-- and backward-compatible with existing rows.

ALTER TABLE front_analytics_monthly_coverage
  ADD COLUMN IF NOT EXISTS denominator_source varchar(32),
  ADD COLUMN IF NOT EXISTS denominator_unit   varchar(32),
  ADD COLUMN IF NOT EXISTS analytics_plan_limited_at timestamp;
