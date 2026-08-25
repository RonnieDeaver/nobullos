-- Task #4084 — retire the Google Drive integration (end-state D, taken to
-- full retirement by operator decision on top of the plan in
-- audits/drive-least-privilege-migration-plan.md).
--
-- The pipeline (Zoom recordings, Twilio call archives) now delivers ONLY
-- into in-app client files; the Drive mirror, the Drive import console,
-- and the Drive folder cache/crawler are all gone from the codebase. This
-- migration removes their durable state:
--
--   * google_drive_folder_cache  — hourly crawler cache (the only Drive
--     table that ever existed in PRODUCTION; ~3k rows there).
--   * drive_import_runs / drive_import_items / drive_imported_files —
--     import-console tables (dev-only; Task #4025 was never published, so
--     these do not exist in prod — DROP IF EXISTS is a no-op there).
--   * The Drive-specific system_settings keys (scope lever, delivery-mode
--     lever, unmatched-recordings Drive folder ids, crawler kill switch +
--     staleness-alert knobs, zoom-mirror alert kill switch).
--   * Live notification state for the two retired alert ids. Delivery
--     history rows (notification_deliveries, user_notifications) are
--     deliberately KEPT as audit history.
--
-- KEPT: the google_service_account_key setting — the Sheets read lane
-- (spreadsheets.readonly; Ads OS client-log reader) still authenticates
-- with it. Legacy Drive links stored on communication records are display-
-- only strings and keep working; the files themselves stay in the team's
-- Drive untouched.
--
-- Idempotent by construction (DROP IF EXISTS / DELETE WHERE) — safe under
-- post-merge.sh SAFE_MIGRATIONS re-application and dev-ledger re-runs.

DROP TABLE IF EXISTS drive_import_items CASCADE;
DROP TABLE IF EXISTS drive_import_runs CASCADE;
DROP TABLE IF EXISTS drive_imported_files CASCADE;
DROP TABLE IF EXISTS google_drive_folder_cache CASCADE;

DELETE FROM system_settings WHERE key IN (
  'google_drive_token_scope',
  'client_file_delivery_mode',
  'unmatched_call_recordings_root_folder_id',
  'unmatched_call_recordings_subfolder_id',
  'unmatched_call_transcripts_subfolder_id',
  'kill_switch_google_drive_sync',
  'kill_switch_zoom_drive_mirror_failure_alert',
  'google_drive_sync_staleness_alert_enabled',
  'google_drive_sync_staleness_alert_age_minutes'
);

DELETE FROM notification_settings WHERE notification_id IN (
  'integration.google_drive.zoom_mirror_failing',
  'queue.google_drive_sync.stale_cache'
);

DELETE FROM notification_health_state WHERE notification_id IN (
  'integration.google_drive.zoom_mirror_failing',
  'queue.google_drive_sync.stale_cache'
);
