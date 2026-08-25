-- Recording columns for twilio_calls. Populated by the
-- /api/twilio/webhooks/recording-status webhook (DialVerb recordings)
-- so the Conversation Hub can render an audio player on completed calls.
-- All nullable: pre-existing rows + calls where recording is disabled
-- simply have no recording metadata. recording_status mirrors Twilio's
-- own RecordingStatus values: in-progress | completed | failed | absent.
-- recording_channels is the integer Twilio reports (1 = mono, 2 = dual).
ALTER TABLE twilio_calls
  ADD COLUMN IF NOT EXISTS recording_sid varchar,
  ADD COLUMN IF NOT EXISTS recording_url varchar,
  ADD COLUMN IF NOT EXISTS recording_duration integer,
  ADD COLUMN IF NOT EXISTS recording_status varchar,
  ADD COLUMN IF NOT EXISTS recording_channels integer;

-- Default disclosure announcement played on the inbound greeting and
-- the outbound whisper (called party only). Generic, jurisdiction-safe
-- wording suitable for two-party-consent states. Editable via system
-- settings later without redeploying. INSERT-only-if-missing so a
-- re-run of this migration leaves admin-edited values alone.
INSERT INTO system_settings (key, value)
VALUES (
  'twilio_recording_disclosure',
  'This call may be recorded for quality assurance and compliance purposes.'
)
ON CONFLICT (key) DO NOTHING;
