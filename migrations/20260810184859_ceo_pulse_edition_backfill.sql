-- Task #4304: Backfill edition tag for the 6 legacy NoBull Briefs.
--
-- All 6 pre-existing production briefs (2026-01 through 2026-06) were
-- identified by the team as "Market Shift" editions. The column was added as
-- nullable in 20260810154500_ceo_pulse_edition.sql (Task #4268), with the
-- backfill explicitly deferred to this task. NULL remains a valid untagged
-- state for any brief NOT listed here.
--
-- Idempotent: the AND edition IS NULL guard is a no-op on repeated replay —
-- once tagged, repeated runs leave the row unchanged.

UPDATE ceo_pulses
  SET edition = 'market_shift'
  WHERE month_key IN ('2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06')
    AND edition IS NULL;
