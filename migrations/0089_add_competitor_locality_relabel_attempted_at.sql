-- Task #2357 — convergence marker for the competitor locality-RELABEL backfill.
-- Sibling of 0087_add_competitor_structured_location_backfill_attempted_at.sql,
-- but for re-correcting an already-NON-NULL `competitor_locality` that an OLD
-- address parse (before the Task #2291 Australian / Irish-Eircode / Dutch
-- postal rules) wrongly stored as a region / postal token (e.g. "NSW 2000" or
-- an Eircode) instead of the real city.
--
-- The existing structured-location backfill (Task #2052) only writes when BOTH
-- competitor_locality AND competitor_street are NULL, so it never re-corrects
-- these wrong NON-NULL localities. The relabel backfill re-fetches SEMrush
-- getTopCompetitors, re-parses the business address with the CURRENT
-- parseCompetitorAddress, and overwrites the mislabeled locality when the new
-- parse yields a different result.
--
-- Stamped (apply mode) on suspect rows after a successful re-fetch so the
-- backfill_competitor_locality_relabel prod-action converges to "not needed"
-- instead of re-pressing forever. Additive, nullable, idempotent.
ALTER TABLE "heatmap_competitor_snapshots"
  ADD COLUMN IF NOT EXISTS "competitor_locality_relabel_attempted_at" timestamp;
