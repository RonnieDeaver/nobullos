-- Migration 0066 — Task #1675: mark Front Analytics coverage failures
-- as recoverable vs. unrecoverable.
--
-- Adds an `unrecoverable` flag to `front_analytics_monthly_coverage`.
-- The refresh worker uses it to stop re-burning ticks on months that
-- Front itself genuinely cannot return (e.g. confirmed permanent 403 /
-- out of retention). Cleared on the next successful pull.

ALTER TABLE front_analytics_monthly_coverage
  ADD COLUMN IF NOT EXISTS unrecoverable boolean NOT NULL DEFAULT false;
