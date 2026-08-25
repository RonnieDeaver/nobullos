-- Task #3889: Going Quiet — mark snapshots written while the ingestion feed
-- was stale. When the fleet-wide feed-freshness probe (newest ingested
-- inbound communication row vs front_sync_emails' own recent activity)
-- says the pipeline is behind, the daily sweep persists snapshots with
-- data_gap = true, forces is_flagged = false, suppresses the per-client
-- going-quiet notifications, and raises a single admin pipeline alert
-- instead. Data-gap snapshots are also skipped as the "previous snapshot"
-- baseline for flag-transition detection so a gap day can neither fire a
-- false re-engagement nor double-notify the same quiet streak.
ALTER TABLE client_engagement_snapshots
  ADD COLUMN IF NOT EXISTS data_gap boolean NOT NULL DEFAULT false;

-- Index backing for the new freshness probes (they run on every Going Quiet
-- tab load and every prod-action status poll — they must never seq-scan
-- raw_communication_records; see the Task #2925 lesson).
--
-- 1. Sweep/route probe: MAX(timestamp) over ingested Front INBOUND rows.
CREATE INDEX IF NOT EXISTS raw_comm_front_inbound_ts_idx
  ON raw_communication_records ("timestamp")
  WHERE source_type = 'front_email' AND direction = 'inbound';

-- 2. Rolling-window prod action: per-month COUNT(DISTINCT external_thread_id)
--    and MAX(timestamp) over materialized per-message rows.
CREATE INDEX IF NOT EXISTS raw_comm_front_email_message_ts_idx
  ON raw_communication_records ("timestamp", external_thread_id)
  WHERE source_type = 'front_email' AND source_subtype = 'email_message';

-- 3. Tracker-activity side of the probe ORs last_message_at with the already
--    -indexed created_at (front_sync_created_at_idx) — both need btrees for
--    the bitmap-OR, and MAX(last_message_at) wants index-backed too.
CREATE INDEX IF NOT EXISTS front_sync_last_message_at_idx
  ON front_sync_emails (last_message_at);
