-- Task #4057 — Zoom Transcript Match Assistant (manual year-back sweep).
--
-- `zoom_match_sweeps`: one row per operator-triggered sweep of the past 12
-- months of Zoom cloud recordings; carries the durable progress surface the
-- admin panel polls (per-window discovery status, phase, counters).
--
-- `zoom_transcript_match_analyses`: one row per analyzed Zoom call (unique on
-- record id) holding the AI's guessed client, confidence, rationale, call
-- summary, and names involved. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS zoom_match_sweeps (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar NOT NULL DEFAULT 'running',
  phase varchar NOT NULL DEFAULT 'discovery',
  started_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  window_start timestamp NOT NULL,
  window_end timestamp NOT NULL,
  windows_json jsonb NOT NULL,
  counters_json jsonb NOT NULL,
  phase_state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zoom_match_sweeps_status_idx
  ON zoom_match_sweeps (status);

CREATE INDEX IF NOT EXISTS zoom_match_sweeps_started_at_idx
  ON zoom_match_sweeps (started_at);

CREATE TABLE IF NOT EXISTS zoom_transcript_match_analyses (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id varchar NOT NULL REFERENCES raw_communication_records(id) ON DELETE CASCADE,
  sweep_id varchar REFERENCES zoom_match_sweeps(id) ON DELETE SET NULL,
  status varchar NOT NULL,
  guessed_client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
  confidence real,
  rationale text,
  call_summary text,
  summary_source varchar,
  names_json jsonb,
  model varchar,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  analyzed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ztma_record_id_uq
  ON zoom_transcript_match_analyses (record_id);

CREATE INDEX IF NOT EXISTS ztma_status_idx
  ON zoom_transcript_match_analyses (status);

CREATE INDEX IF NOT EXISTS ztma_guessed_client_idx
  ON zoom_transcript_match_analyses (guessed_client_id);

CREATE INDEX IF NOT EXISTS ztma_sweep_idx
  ON zoom_transcript_match_analyses (sweep_id);
