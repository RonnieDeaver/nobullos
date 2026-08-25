-- Migration 0072 — Task #1759 follow-up: Google Ads campaign budget +
-- dollar-denominated metrics alongside the existing micros columns.
--
-- Google Ads returns money values as "micros" (integer * 1_000_000). We
-- keep the micros columns as the authoritative source and add
-- double-precision dollar columns so report consumers don't need to
-- divide on every read. Budget is added to the campaign metadata table.

ALTER TABLE google_ads_campaigns
  ADD COLUMN IF NOT EXISTS budget_micros bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_dollars double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_name text;

ALTER TABLE google_ads_campaign_daily_stats
  ADD COLUMN IF NOT EXISTS cost_dollars double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversion_value_dollars double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_cpc_dollars double precision NOT NULL DEFAULT 0;

ALTER TABLE google_ads_keyword_daily_stats
  ADD COLUMN IF NOT EXISTS cost_dollars double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_cpc_dollars double precision NOT NULL DEFAULT 0;
