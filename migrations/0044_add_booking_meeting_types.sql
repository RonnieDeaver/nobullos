-- Migration 0044 — Reusable named meeting types per AM (Task #890).
--
-- Adds `booking_meeting_types` so AMs can save a small catalogue of
-- presets (e.g. "Discovery 30min", "Strategy 60min") and pick from
-- them with one click on the Schedule panel. Also adds optional
-- `meeting_type_id` + `meeting_type_name` columns on
-- `scheduled_meetings` so the booked meeting records which preset it
-- was created from. The name is denormalized so it survives a later
-- delete / rename of the meeting type row.

CREATE TABLE IF NOT EXISTS booking_meeting_types (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  account_manager_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 30,
  buffer_before_minutes integer NOT NULL DEFAULT 0,
  buffer_after_minutes integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  CONSTRAINT booking_meeting_types_am_name_unique
    UNIQUE (account_manager_user_id, name)
);
CREATE INDEX IF NOT EXISTS booking_meeting_types_am_idx
  ON booking_meeting_types (account_manager_user_id);

ALTER TABLE scheduled_meetings
  ADD COLUMN IF NOT EXISTS meeting_type_id varchar
    REFERENCES booking_meeting_types(id) ON DELETE SET NULL;

ALTER TABLE scheduled_meetings
  ADD COLUMN IF NOT EXISTS meeting_type_name text;
