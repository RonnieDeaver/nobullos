-- Task #852: voicemail playback + transcription on twilio_calls.
-- Populated by the /webhooks/voicemail-recording-status and
-- /webhooks/voicemail-transcription handlers when an inbound call
-- falls through to the voicemail <Record> verb (no targets, or no
-- target answered). All nullable — calls that never reached the
-- voicemail prompt simply have no values here.
--
-- voicemail_recording_url is the Twilio recording URL (no .mp3 suffix);
-- the audio proxy adds .mp3 and applies the same SSRF guard as the
-- Dial-recording proxy. voicemail_listened_at is set the first time
-- a user opens the voicemail card; the inbox "VM" badge counts
-- voicemails where this column is NULL.
ALTER TABLE twilio_calls
  ADD COLUMN IF NOT EXISTS voicemail_recording_sid varchar,
  ADD COLUMN IF NOT EXISTS voicemail_recording_url varchar,
  ADD COLUMN IF NOT EXISTS voicemail_recording_duration integer,
  ADD COLUMN IF NOT EXISTS voicemail_transcription_text text,
  ADD COLUMN IF NOT EXISTS voicemail_transcription_status varchar,
  ADD COLUMN IF NOT EXISTS voicemail_listened_at timestamp;

-- Default voicemail greeting played to the caller before the beep.
-- Editable via system settings without redeploy.
INSERT INTO system_settings (key, value)
VALUES (
  'twilio_voicemail_greeting',
  'The person you are trying to reach is not available. Please leave a message after the beep, and press the pound key when finished.'
)
ON CONFLICT (key) DO NOTHING;
