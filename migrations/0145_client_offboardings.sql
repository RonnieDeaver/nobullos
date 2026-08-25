-- Task #3711: client offboarding with auto-archive on the final service day.
-- One row per offboarding lifecycle; due rows (final_service_date <= today,
-- America/New_York) are executed by the daily offboarding sweep, which
-- atomically claims each record (status scheduled -> processing) before
-- running any step so a concurrent cancel/reschedule can defeat the claim.
-- step_state records each pipeline step's completion idempotently so a crash
-- mid-pipeline re-runs only the incomplete steps on resume.
-- status: scheduled | processing | completed | cancelled.

CREATE TABLE IF NOT EXISTS client_offboardings (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  final_service_date date NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'scheduled',
  initiated_by_user_id varchar REFERENCES users(id),
  cancelled_by_user_id varchar REFERENCES users(id),
  cancelled_at timestamp,
  completed_at timestamp,
  step_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_offboardings_client_id_idx
  ON client_offboardings (client_id);

CREATE INDEX IF NOT EXISTS client_offboardings_status_date_idx
  ON client_offboardings (status, final_service_date);

-- At most one active (scheduled) offboarding per client.
CREATE UNIQUE INDEX IF NOT EXISTS client_offboardings_one_scheduled_idx
  ON client_offboardings (client_id)
  WHERE status = 'scheduled';
