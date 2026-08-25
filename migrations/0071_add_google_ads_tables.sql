-- Migration 0071 — Task #1759: Google Ads integration.
--
-- System-wide MCC OAuth connection (singleton row), discovered customers,
-- per-day campaign + keyword stats, and a sync-run audit table. Refresh
-- tokens are encrypted at rest by the application (tokenCrypto, AES-256-GCM).

CREATE TABLE IF NOT EXISTS google_ads_connection (
  id varchar PRIMARY KEY DEFAULT 'singleton',
  login_customer_id varchar,
  google_account_email varchar,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expiry timestamp,
  scopes text,
  status varchar NOT NULL DEFAULT 'disconnected',
  last_refresh_at timestamp,
  last_error text,
  connected_at timestamp,
  connected_by varchar,
  disconnected_at timestamp,
  disconnected_by varchar,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS google_ads_customers (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id varchar NOT NULL,
  descriptive_name text,
  currency_code varchar,
  time_zone varchar,
  is_manager boolean NOT NULL DEFAULT false,
  is_test_account boolean NOT NULL DEFAULT false,
  status varchar,
  nobull_client_id varchar,
  sync_enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamp,
  last_sync_error text,
  discovered_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_customers_customer_id_uniq
  ON google_ads_customers (customer_id);
CREATE INDEX IF NOT EXISTS google_ads_customers_nobull_client_idx
  ON google_ads_customers (nobull_client_id);

CREATE TABLE IF NOT EXISTS google_ads_campaigns (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id varchar NOT NULL,
  campaign_id varchar NOT NULL,
  name text,
  status varchar,
  advertising_channel_type varchar,
  start_date date,
  end_date date,
  bidding_strategy_type varchar,
  last_seen_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_campaigns_customer_campaign_uniq
  ON google_ads_campaigns (customer_id, campaign_id);
CREATE INDEX IF NOT EXISTS google_ads_campaigns_customer_idx
  ON google_ads_campaigns (customer_id);

CREATE TABLE IF NOT EXISTS google_ads_campaign_daily_stats (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id varchar NOT NULL,
  campaign_id varchar NOT NULL,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  conversion_value_micros bigint NOT NULL DEFAULT 0,
  average_cpc_micros bigint NOT NULL DEFAULT 0,
  ctr_basis_points integer NOT NULL DEFAULT 0,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_campaign_daily_stats_uniq
  ON google_ads_campaign_daily_stats (customer_id, campaign_id, date);
CREATE INDEX IF NOT EXISTS google_ads_campaign_daily_stats_customer_date_idx
  ON google_ads_campaign_daily_stats (customer_id, date);

CREATE TABLE IF NOT EXISTS google_ads_keyword_daily_stats (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id varchar NOT NULL,
  campaign_id varchar NOT NULL,
  ad_group_id varchar NOT NULL,
  criterion_id varchar NOT NULL,
  keyword_text text,
  match_type varchar,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  average_cpc_micros bigint NOT NULL DEFAULT 0,
  quality_score integer,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_keyword_daily_stats_uniq
  ON google_ads_keyword_daily_stats (customer_id, criterion_id, ad_group_id, date);
CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_stats_customer_date_idx
  ON google_ads_keyword_daily_stats (customer_id, date);
CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_stats_campaign_date_idx
  ON google_ads_keyword_daily_stats (campaign_id, date);

CREATE TABLE IF NOT EXISTS google_ads_sync_runs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id varchar,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  status varchar NOT NULL DEFAULT 'running',
  campaigns_upserted integer NOT NULL DEFAULT 0,
  campaign_stats_upserted integer NOT NULL DEFAULT 0,
  keyword_stats_upserted integer NOT NULL DEFAULT 0,
  error text,
  metadata jsonb
);
CREATE INDEX IF NOT EXISTS google_ads_sync_runs_started_at_idx
  ON google_ads_sync_runs (started_at);
