-- Migration 0052 — Recurrence schema for scheduled meetings (Task #1032A).
--
-- Phase 1 of the recurring-meetings epic. Additive only:
--   * Adds nullable recurrence fields on `scheduled_meetings` so the
--     existing one-off booking flow keeps working unchanged (every
--     existing row stays NULL).
--   * Adds the four split-tracking fields up front so the later
--     "this and following" / "entire series" edit phases don't need a
--     second migration. No code reads them yet.
--   * Creates `meeting_recurrence_exceptions` for per-occurrence
--     overrides (canceled / rescheduled occurrences) keyed by the
--     series master and the original-start instant.
--
-- All recurrence helpers (validator + expander) ship in this same task
-- but are not wired into any booking path yet.

BEGIN;

-- ---------------------------------------------------------------------------
-- scheduled_meetings: recurrence + series-split fields (all nullable).
-- ---------------------------------------------------------------------------
ALTER TABLE scheduled_meetings
  ADD COLUMN IF NOT EXISTS recurrence text[],
  ADD COLUMN IF NOT EXISTS recurrence_source varchar,
  ADD COLUMN IF NOT EXISTS series_master_id varchar
    REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurring_event_id varchar,
  ADD COLUMN IF NOT EXISTS original_start_time timestamp,
  ADD COLUMN IF NOT EXISTS recurrence_timezone varchar,
  ADD COLUMN IF NOT EXISTS recurrence_summary text,
  ADD COLUMN IF NOT EXISTS zoom_recurrence_mode varchar,
  ADD COLUMN IF NOT EXISTS zoom_recurrence_fallback_reason varchar,
  ADD COLUMN IF NOT EXISTS previous_series_master_id varchar
    REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_series_master_id varchar
    REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS split_from_meeting_id varchar
    REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS split_at_original_start_time timestamp;

CREATE INDEX IF NOT EXISTS scheduled_meetings_series_master_idx
  ON scheduled_meetings (series_master_id);
CREATE INDEX IF NOT EXISTS scheduled_meetings_recurring_event_idx
  ON scheduled_meetings (recurring_event_id, original_start_time);

-- ---------------------------------------------------------------------------
-- meeting_recurrence_exceptions: per-occurrence overrides for a series.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_recurrence_exceptions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_meeting_id varchar
    REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  series_master_id varchar NOT NULL
    REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  recurring_event_id varchar,
  original_start_time timestamp NOT NULL,
  exception_type varchar NOT NULL,
  override_start_time_utc timestamp,
  override_end_time_utc timestamp,
  override_timezone varchar,
  reason text,
  created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  CONSTRAINT meeting_recurrence_exceptions_unique
    UNIQUE (series_master_id, original_start_time)
);

CREATE INDEX IF NOT EXISTS meeting_recurrence_exceptions_meeting_idx
  ON meeting_recurrence_exceptions (scheduled_meeting_id);
CREATE INDEX IF NOT EXISTS meeting_recurrence_exceptions_master_idx
  ON meeting_recurrence_exceptions (series_master_id);
CREATE INDEX IF NOT EXISTS meeting_recurrence_exceptions_event_idx
  ON meeting_recurrence_exceptions (recurring_event_id, original_start_time);

COMMIT;
