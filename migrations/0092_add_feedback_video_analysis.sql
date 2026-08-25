-- Task #2409 — auto-process feedback video attachments.
-- Stores the TwelveLabs-derived transcript + key-moment frames for each
-- uploaded feedback video so the planning agent (and the admin console) can
-- read them without replaying the raw video. Additive + idempotent.
ALTER TABLE user_feedback
  ADD COLUMN IF NOT EXISTS video_analysis jsonb;
