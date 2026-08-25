-- Migration 0093 — competitor backfill convergence (Task #2434).
--
-- The two competitor backfill prod-actions
-- (`backfill_competitor_location_labels` / Task #2017 and
-- `backfill_competitor_structured_location` / Task #2052) never converged
-- to a terminal "not needed": a snapshot whose SEMrush
-- `getTopCompetitors` re-fetch keeps returning a *transient* outcome
-- (campaign_backoff / fetch_failed) was never stamped attempted, so the
-- self-heal tick re-counted the same unreachable rows forever.
--
-- These two counters add a bounded transient-retry budget. The process
-- helpers increment the relevant counter on each transient apply attempt;
-- once it reaches BACKFILL_TRANSIENT_RETRY_BUDGET the row is stamped with
-- its existing `*_backfill_attempted_at` marker (terminal). Campaigns
-- proven gone (absent from semrush_campaign_metadata_cache) stamp at once,
-- without spending the budget.
--
-- Additive NOT NULL columns with a constant DEFAULT 0 — publish-safe and
-- metadata-only on PG16 (no table rewrite; existing rows read 0 =
-- "zero transient attempts"). The two are independent (different target
-- columns / fill semantics) just like the two `*_attempted_at` markers.
ALTER TABLE heatmap_competitor_snapshots
  ADD COLUMN IF NOT EXISTS gbp_url_backfill_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS structured_location_backfill_retry_count integer NOT NULL DEFAULT 0;
