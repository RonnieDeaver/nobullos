-- Task #875: track per-row last-updated time on twilio_messages so the
-- thread view can poll for in-place status mutations (queued → sent →
-- delivered) using a separate "updated since" watermark. Without this,
-- incremental fetch on `created_at` alone never picks up Twilio
-- delivery-status callback writes because the row's created_at is
-- unchanged.
--
-- Backfill: existing rows get updated_at = created_at (or now() if
-- created_at is NULL, which would be unusual but defensive).
ALTER TABLE twilio_messages
  ADD COLUMN IF NOT EXISTS updated_at timestamp;

UPDATE twilio_messages
   SET updated_at = COALESCE(created_at, now())
 WHERE updated_at IS NULL;

ALTER TABLE twilio_messages
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS twilio_msg_updated_at_idx
  ON twilio_messages (updated_at);
