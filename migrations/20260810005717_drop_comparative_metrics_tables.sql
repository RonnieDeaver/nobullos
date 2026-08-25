-- Task #4202: drop the two orphaned tables left behind by the retired
-- "Zoom comparative semantic — live counters" card (card + all server
-- plumbing removed in Task #4177; the telemetry engine that fed them was
-- deleted in Task #2637). Zero readers or writers remain. Evidence of the
-- stored rows (stale telemetry, 2026-05-18..2026-06-19, not archived) is
-- recorded in audits/zoom-comparative-tables-drop-2026-08-10.md.
-- destructive-approved: Task #4202 is the owner-approved L3 vehicle for this drop.
DROP TABLE IF EXISTS comparative_metrics_snapshots;
DROP TABLE IF EXISTS comparative_metrics_daily_rollups;
-- Stale setting row from the retired comparative-reset alert plumbing
-- (absent in dev and prod as of 2026-08-10; delete is a defensive no-op).
DELETE FROM system_settings WHERE key = 'zoom_comparative_reset_alert_slack_channel_id';
