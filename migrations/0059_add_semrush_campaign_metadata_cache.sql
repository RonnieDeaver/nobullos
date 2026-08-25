-- Migration 0059: semrush_campaign_metadata_cache (Task #1112).
--
-- Persist the last successful (campaignId, reportDates, activeKeywordCount)
-- snapshot for each SEMrush campaign so the heatmap coverage panel can keep
-- classifying gaps when live SEMrush calls fail (rate-limited / down).
-- Writes only happen on a successful live fetch — failed fetches never
-- overwrite a healthy snapshot. Reads happen as a fallback inside
-- server/services/heatmapCoverage.ts when the live fetch errors.

BEGIN;

CREATE TABLE IF NOT EXISTS "semrush_campaign_metadata_cache" (
  "campaign_id" text PRIMARY KEY,
  "report_dates" jsonb NOT NULL,
  "active_keyword_count" integer,
  "fetched_at" timestamp NOT NULL DEFAULT now()
);

COMMIT;
