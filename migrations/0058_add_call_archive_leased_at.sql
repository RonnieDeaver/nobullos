-- Migration 0058: twilio_calls.archive_leased_at (Task #1099).
--
-- The call-archive pipeline's heartbeat overwrites archive_locked_until
-- every minute and intermediate writes (transcript_error, etc.) bump
-- updated_at, so the stuck-processing admin view's "processing age"
-- (NOW() - updated_at) is only an upper bound on time-since-claim.
--
-- Add an explicit lease epoch that is set by the claim SQL when a row
-- transitions into 'processing' and is NEVER touched by the heartbeat,
-- mirroring how work_queue.leased_at is computed for the work_queue
-- stuck-processing view.
--
-- Best-effort backfill for rows currently in 'processing': seed
-- archive_leased_at from updated_at so the UI has something better
-- than NULL while the next claim refreshes the value.

BEGIN;

ALTER TABLE twilio_calls
  ADD COLUMN IF NOT EXISTS archive_leased_at timestamp;

UPDATE twilio_calls
SET archive_leased_at = updated_at
WHERE archive_status = 'processing'
  AND archive_leased_at IS NULL;

COMMIT;
