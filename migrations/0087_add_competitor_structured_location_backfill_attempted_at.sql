-- Task #2052 — convergence marker for the structured-location backfill.
-- Sibling of 0086_add_competitor_gbp_backfill_attempted_at.sql, but for the
-- competitor_locality / competitor_street columns added in
-- 0084_add_competitor_structured_location.sql.
--
-- Stamped (apply mode) on competitor rows that remain BOTH-NULL after a
-- successful SEMrush getTopCompetitors re-fetch (no name-match to fill), or
-- whose parent snapshot has no keyword_id (can never be queried). Without it
-- those permanently-unfillable rows stay candidates forever and the
-- backfill_competitor_structured_location prod-action could never settle to
-- "not needed". Additive, nullable, idempotent.
ALTER TABLE "heatmap_competitor_snapshots"
  ADD COLUMN IF NOT EXISTS "structured_location_backfill_attempted_at" timestamp;
