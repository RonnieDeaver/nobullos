-- Task #3712: AM coaching runs & per-AM coaching reports for the Churn
-- Command Center "Team Coaching" tab.
--
-- am_coaching_runs: one row per director-triggered background analysis
-- across all account managers. Carries live progress counters the UI polls
-- (processed/failed of total) and the department-wide synthesis JSON written
-- after every per-AM report finishes. status: running | completed | failed.
--
-- am_coaching_reports: one row per (run, account manager). Structured
-- results only — ranked mistakes with evidence citations pointing at
-- raw_communication_records, strengths, per-channel (Zoom vs email)
-- summaries, coaching focus. insufficient_data marks AMs with too little
-- verifiably-theirs material; failed preserves the per-AM error without
-- killing the run.

CREATE TABLE IF NOT EXISTS am_coaching_runs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar(16) NOT NULL DEFAULT 'running',
  requested_by_user_id varchar REFERENCES users(id),
  total_managers integer NOT NULL DEFAULT 0,
  processed_managers integer NOT NULL DEFAULT 0,
  failed_managers integer NOT NULL DEFAULT 0,
  department_synthesis_json jsonb,
  model_version varchar,
  error text,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS am_coaching_runs_status_idx
  ON am_coaching_runs (status);

CREATE INDEX IF NOT EXISTS am_coaching_runs_started_at_idx
  ON am_coaching_runs (started_at);

CREATE TABLE IF NOT EXISTS am_coaching_reports (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id varchar NOT NULL REFERENCES am_coaching_runs(id) ON DELETE CASCADE,
  am_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL,
  client_count integer NOT NULL DEFAULT 0,
  zoom_sample_count integer NOT NULL DEFAULT 0,
  email_sample_count integer NOT NULL DEFAULT 0,
  unattributed_sample_count integer NOT NULL DEFAULT 0,
  mistakes_json jsonb,
  unattributed_json jsonb,
  strengths_json jsonb,
  zoom_summary text,
  email_summary text,
  coaching_focus text,
  insufficient_data boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamp DEFAULT now(),
  CONSTRAINT am_coaching_reports_run_am_uniq UNIQUE (run_id, am_user_id)
);

CREATE INDEX IF NOT EXISTS am_coaching_reports_run_id_idx
  ON am_coaching_reports (run_id);

CREATE INDEX IF NOT EXISTS am_coaching_reports_am_user_id_idx
  ON am_coaching_reports (am_user_id);
