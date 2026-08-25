-- Task #4025 — Google Drive cutover & import.
--
-- 1. drive_import_runs / drive_import_items: one row per admin-launched
--    Drive→client-files import run (dry-run or live) plus a per-Drive-file
--    item ledger (the completion report + checkpoint).
-- 2. drive_imported_files: durable (client_id, drive_file_id) → client_file_id
--    mapping so re-runs and resumed runs SKIP already-imported files instead
--    of duplicating them. Rows CASCADE away when the imported client_files
--    row is purged, which deliberately re-opens re-import for that file.
-- 3. raw_communication_records.client_file_id: in-app copy of a Zoom
--    recording delivered by the client-file delivery fan-out (Task #4025
--    repoint of the Drive-only upload).
-- 4. twilio_calls client-file columns: in-app recording/transcript copies
--    written by the call-archive pipeline's delivery phase (mirrors the
--    drive_* quartet).
--
-- All DDL idempotent (IF NOT EXISTS / IF EXISTS) per TASK_PREFLIGHT §8.

CREATE TABLE IF NOT EXISTS drive_import_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR NOT NULL,                -- 'client' | 'all'
  client_id VARCHAR REFERENCES clients(id) ON DELETE SET NULL,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR NOT NULL DEFAULT 'running', -- running | completed | failed | cancelled
  requested_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name TEXT NOT NULL DEFAULT '',
  -- Retry runs re-process ONLY the failed items of a previous run.
  retry_of_run_id VARCHAR,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  -- Progress / report counters (updated as the walk proceeds).
  clients_total INTEGER NOT NULL DEFAULT 0,
  clients_done INTEGER NOT NULL DEFAULT 0,
  folders_seen INTEGER NOT NULL DEFAULT 0,
  folders_created INTEGER NOT NULL DEFAULT 0,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_imported INTEGER NOT NULL DEFAULT 0,
  files_exported INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  files_failed INTEGER NOT NULL DEFAULT 0,
  bytes_imported BIGINT NOT NULL DEFAULT 0,
  current_client_id VARCHAR,
  current_path TEXT,
  error TEXT,
  heartbeat_at TIMESTAMP,
  started_at TIMESTAMP NOT NULL DEFAULT now(),
  finished_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_import_runs_status_idx
  ON drive_import_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS drive_import_items (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id VARCHAR NOT NULL REFERENCES drive_import_runs(id) ON DELETE CASCADE,
  client_id VARCHAR NOT NULL,
  drive_file_id VARCHAR NOT NULL,
  drive_name TEXT NOT NULL DEFAULT '',
  drive_path TEXT NOT NULL DEFAULT '',
  drive_mime_type VARCHAR,
  drive_size_bytes BIGINT,
  drive_modified_at TIMESTAMP,
  -- planned | imported | exported | skipped_existing | skipped_unsupported |
  -- skipped_too_large | skipped_empty | failed
  status VARCHAR NOT NULL,
  detail TEXT,
  client_file_id VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_import_items_run_status_idx
  ON drive_import_items (run_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS drive_import_items_run_file_uidx
  ON drive_import_items (run_id, drive_file_id);

CREATE TABLE IF NOT EXISTS drive_imported_files (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  drive_file_id VARCHAR NOT NULL,
  client_file_id VARCHAR NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  drive_modified_at TIMESTAMP,
  imported_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS drive_imported_files_client_file_uidx
  ON drive_imported_files (client_id, drive_file_id);
CREATE INDEX IF NOT EXISTS drive_imported_files_client_file_id_idx
  ON drive_imported_files (client_file_id);

-- Zoom recording delivery: in-app copy reference (kept alongside the legacy
-- google_drive_file_url, which stays read-only for historical rows).
ALTER TABLE raw_communication_records
  ADD COLUMN IF NOT EXISTS client_file_id VARCHAR;

-- Call-archive delivery: in-app recording/transcript copies. Timestamps are
-- the per-sink idempotency markers (mirroring drive_*_uploaded_at).
ALTER TABLE twilio_calls
  ADD COLUMN IF NOT EXISTS client_file_recording_id VARCHAR,
  ADD COLUMN IF NOT EXISTS client_file_recording_saved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS client_file_transcript_id VARCHAR,
  ADD COLUMN IF NOT EXISTS client_file_transcript_saved_at TIMESTAMP;
