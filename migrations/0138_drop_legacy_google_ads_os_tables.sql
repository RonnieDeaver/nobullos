-- Task #3603: retire the broken legacy Ads OS module (Task #2958 port).
-- The rebuilt Ads OS (/ads-os, migration 0136_ads_os_stores.sql) reached
-- spec parity, so the nine runtime-created legacy tables are dropped.
-- These tables were created by ensureGoogleAdsOsTables() at runtime and
-- never had migration files, so the drop must be applied to BOTH dev and
-- prod for the publish-time schema diff to stay clean.
-- Idempotent: every statement uses IF EXISTS.

DROP TABLE IF EXISTS google_ads_client_mappings;
DROP TABLE IF EXISTS google_ads_client_criteria;
DROP TABLE IF EXISTS google_ads_pacing_store;
DROP TABLE IF EXISTS google_ads_traffic_quality;
DROP TABLE IF EXISTS google_ads_actioned_keywords;
DROP TABLE IF EXISTS google_ads_account_alerts;
DROP TABLE IF EXISTS google_ads_audit_summaries;
DROP TABLE IF EXISTS google_ads_client_log_summaries;
DROP TABLE IF EXISTS google_ads_dashboard_snapshots;

-- Clean up the legacy morning-refresh scheduler's settings (kill switch +
-- last-run stamp). The rebuilt scheduler uses ads_os_pacing_refresh_*.
DELETE FROM system_settings
  WHERE key IN ('ads_os_morning_refresh_enabled', 'ads_os_morning_refresh_last_run_date');
