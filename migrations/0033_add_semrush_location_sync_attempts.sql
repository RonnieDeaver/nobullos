-- Idempotent creation of semrush_location_sync_attempts.
-- Pre-creates the table so `drizzle-kit push` does not prompt
-- "is semrush_location_sync_attempts created or renamed from user_feedback?".

CREATE TABLE IF NOT EXISTS semrush_location_sync_attempts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_state_id varchar NOT NULL REFERENCES semrush_location_sync_state(id) ON DELETE CASCADE,
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id varchar NOT NULL REFERENCES client_locations(id) ON DELETE CASCADE,
  campaign_id text NOT NULL,
  run_id varchar NOT NULL,
  attempt_number integer NOT NULL,
  phase text NOT NULL,
  status text NOT NULL,
  triggered_by text,
  report_date text,
  imported_keyword_count integer,
  expected_keyword_count integer,
  duration_ms integer,
  error_category text,
  last_error text,
  message text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semrush_loc_sync_attempts_state_idx ON semrush_location_sync_attempts (sync_state_id);
CREATE INDEX IF NOT EXISTS semrush_loc_sync_attempts_client_idx ON semrush_location_sync_attempts (client_id);
CREATE INDEX IF NOT EXISTS semrush_loc_sync_attempts_location_idx ON semrush_location_sync_attempts (location_id);
CREATE INDEX IF NOT EXISTS semrush_loc_sync_attempts_run_idx ON semrush_location_sync_attempts (run_id);
CREATE INDEX IF NOT EXISTS semrush_loc_sync_attempts_created_idx ON semrush_location_sync_attempts (created_at);
