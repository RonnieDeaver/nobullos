-- Idempotent creation of backfill_jobs.
-- Pre-creates the table so `drizzle-kit push` does not prompt
-- "is backfill_jobs created or renamed from user_feedback?".

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  triggered_by text,
  parameters_json jsonb NOT NULL,
  total_units integer NOT NULL DEFAULT 0,
  processed_units integer NOT NULL DEFAULT 0,
  succeeded_units integer NOT NULL DEFAULT 0,
  failed_units integer NOT NULL DEFAULT 0,
  already_current_units integer NOT NULL DEFAULT 0,
  coverage_gaps_json jsonb,
  result_json jsonb,
  error_message text,
  started_at timestamp,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backfill_jobs_type_idx ON backfill_jobs (job_type);
CREATE INDEX IF NOT EXISTS backfill_jobs_status_idx ON backfill_jobs (status);
CREATE INDEX IF NOT EXISTS backfill_jobs_created_idx ON backfill_jobs (created_at);
