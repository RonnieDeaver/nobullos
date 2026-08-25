-- Add recording fields to comms_calls for LiveKit auto-egress recording pipeline.
-- All columns are nullable so existing rows are unaffected.
ALTER TABLE comms_calls
  ADD COLUMN IF NOT EXISTS recording_egress_id VARCHAR(256),
  ADD COLUMN IF NOT EXISTS recording_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS recording_object_key VARCHAR(512),
  ADD COLUMN IF NOT EXISTS recording_transit_key VARCHAR(512),
  ADD COLUMN IF NOT EXISTS recording_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS recording_file_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS recording_completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS recording_error VARCHAR(512),
  ADD COLUMN IF NOT EXISTS recording_system_message_id VARCHAR(256);
