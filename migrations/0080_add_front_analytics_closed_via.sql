-- Task #1905 — auto-close dedupe-only resolved recovery windows.
--
-- When the historical-recovery worker repeatedly hits 100%-dedupe
-- across a window AND the apply layer confirms the conversations
-- already resolved into NoBull (via front_sync_emails.pipeline_state =
-- 'applied'), the gap is a phantom: it was already ingested via the
-- live webhook path. Auto-closure now writes back to this column so
-- subsequent ticks skip the row instead of repeatedly re-enqueuing
-- recoveries that can never make forward progress.
--
-- Nullable: legacy rows have no closure attribution. The auto-closure
-- candidate filter treats any non-null value as "do not re-enqueue".
-- Cleared automatically when an operator un-parks the window or when
-- the next coverage refresh observes new ingest_gap > 0.

ALTER TABLE front_analytics_monthly_coverage
  ADD COLUMN IF NOT EXISTS closed_via varchar(32);
