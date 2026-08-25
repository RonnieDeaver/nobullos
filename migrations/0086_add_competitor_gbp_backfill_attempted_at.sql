-- Migration 0086 — competitor GBP-URL backfill convergence.
--
-- Adds a durable "backfill attempted, nothing to fill" marker to
-- heatmap_competitor_snapshots. competitorLocationBackfill.processSnapshot
-- (apply mode) stamps it on rows whose competitor_gbp_url is still NULL
-- after a successful SEMrush re-fetch (no name-match), and on rows whose
-- parent snapshot has no keywordId (can never be queried). With it,
-- findCandidateSnapshots excludes these permanently-unfillable rows so the
-- `backfill_competitor_location_labels` prod-action converges to "not
-- needed" instead of re-counting the same NULL rows forever.
--
-- Additive nullable column — publish-safe (no constraint to violate, no
-- backfill required; existing rows default to NULL = "not yet attempted").
ALTER TABLE heatmap_competitor_snapshots
  ADD COLUMN IF NOT EXISTS gbp_url_backfill_attempted_at timestamp;
