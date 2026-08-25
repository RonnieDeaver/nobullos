-- Migration 0041: Call recording archive + transcription + Drive sync pipeline
--
-- Adds the metadata needed to:
--   1. Archive Twilio recordings into our private object storage.
--   2. Transcribe them with OpenAI and store the text alongside.
--   3. Mirror the audio + transcript into the matched client's Google
--      Drive folder (auto-created "Call Recordings" / "Call Transcripts"
--      subfolders) — or an "unmatched" root folder.
--   4. Delete from Twilio after a 7-day safety window once the local
--      copy is confirmed.
--   5. Reconcile Drive location when a call's matched client changes.

BEGIN;

-- ---------------------------------------------------------------------------
-- twilio_calls: archive pipeline state + transcript + drive metadata
-- ---------------------------------------------------------------------------
ALTER TABLE twilio_calls
  ADD COLUMN IF NOT EXISTS archive_status VARCHAR DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS archive_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archive_last_error TEXT,
  ADD COLUMN IF NOT EXISTS archive_locked_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS archive_next_attempt_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS object_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS object_storage_archived_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS transcript_text TEXT,
  ADD COLUMN IF NOT EXISTS transcript_completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS transcript_error TEXT,
  ADD COLUMN IF NOT EXISTS drive_recording_file_id TEXT,
  ADD COLUMN IF NOT EXISTS drive_recording_folder_id TEXT,
  ADD COLUMN IF NOT EXISTS drive_recording_web_link TEXT,
  ADD COLUMN IF NOT EXISTS drive_recording_uploaded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS drive_transcript_file_id TEXT,
  ADD COLUMN IF NOT EXISTS drive_transcript_folder_id TEXT,
  ADD COLUMN IF NOT EXISTS drive_transcript_web_link TEXT,
  ADD COLUMN IF NOT EXISTS drive_transcript_uploaded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS twilio_delete_eligible_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS twilio_recording_deleted_at TIMESTAMP;

-- archive_status canonical values:
--   pending             — no recording yet (or recording not completed)
--   queued              — recording is completed; waiting for the worker
--   processing          — worker has claimed it (also see archive_locked_until)
--   archived_storage    — uploaded to private object storage
--   transcribed         — transcript text saved to DB
--   uploaded_to_drive   — both files mirrored to Drive
--   done                — all steps complete, deletion timer started
--   failed              — gave up after retries (see archive_last_error)
--   skipped             — recording_status='absent' or no recording_url

-- Worker poll: pick rows where (status in queued/processing/...non-terminal)
--   AND (archive_locked_until IS NULL OR archive_locked_until < now())
--   AND (archive_next_attempt_at IS NULL OR archive_next_attempt_at <= now())
CREATE INDEX IF NOT EXISTS twilio_calls_archive_worker_idx
  ON twilio_calls (archive_status, archive_next_attempt_at)
  WHERE archive_status NOT IN ('done', 'failed', 'skipped');

-- Sweep poll for Twilio deletion: rows that are done, past their delete-eligible
-- time, and not yet deleted from Twilio.
CREATE INDEX IF NOT EXISTS twilio_calls_twilio_delete_sweep_idx
  ON twilio_calls (twilio_delete_eligible_at)
  WHERE twilio_recording_deleted_at IS NULL AND archive_status = 'done';

-- Reconcile sweep: rows that are done but whose drive_recording_folder_id
-- might no longer match the desired folder for the current client_id.
CREATE INDEX IF NOT EXISTS twilio_calls_drive_reconcile_idx
  ON twilio_calls (client_id, drive_recording_folder_id)
  WHERE archive_status = 'done' AND drive_recording_file_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- command_panels: cached per-client subfolder ids so we don't recreate them
-- on every call. Auto-created on first use under googleDriveFolderLink.
-- ---------------------------------------------------------------------------
ALTER TABLE command_panels
  ADD COLUMN IF NOT EXISTS call_recordings_subfolder_id TEXT,
  ADD COLUMN IF NOT EXISTS call_transcripts_subfolder_id TEXT;

-- system_settings rows for the unmatched-call drop folder and cached
-- subfolder ids are created lazily by the admin UI / pipeline on first
-- use (storage.setSystemSetting). We don't seed them here because the
-- updated_by column has an FK to users.id and there is no synthetic
-- "system" user available at migration time.

COMMIT;
