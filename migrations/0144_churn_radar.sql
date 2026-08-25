-- Task #3692: Churn Risk Radar agent sweep.
-- One-shot portfolio-wide churn interview: runs + per-client results +
-- per-reason findings. Mirrors shared/models/churnRadar.ts.
-- Idempotent: every statement is guarded with IF NOT EXISTS.
--
-- requested_by deliberately has NO foreign key (run history must survive
-- user deletion; see the model docblock).

CREATE TABLE IF NOT EXISTS churn_radar_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR NOT NULL DEFAULT 'running',
  requested_by VARCHAR,
  total_clients INTEGER NOT NULL DEFAULT 0,
  processed_clients INTEGER NOT NULL DEFAULT 0,
  analyzed_clients INTEGER NOT NULL DEFAULT 0,
  insufficient_clients INTEGER NOT NULL DEFAULT 0,
  error_clients INTEGER NOT NULL DEFAULT 0,
  synthesis_json JSONB,
  error_summary TEXT,
  model_version VARCHAR,
  started_at TIMESTAMP DEFAULT now(),
  finished_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS churn_radar_runs_status_idx ON churn_radar_runs (status);
CREATE INDEX IF NOT EXISTS churn_radar_runs_started_at_idx ON churn_radar_runs (started_at);

CREATE TABLE IF NOT EXISTS churn_radar_client_results (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id VARCHAR NOT NULL REFERENCES churn_radar_runs(id) ON DELETE CASCADE,
  client_id VARCHAR NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  firm_name VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  churn_likelihood REAL,
  likelihood_band VARCHAR,
  summary TEXT,
  insufficiency_reason TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT now(),
  CONSTRAINT churn_radar_client_results_run_client_uq UNIQUE (run_id, client_id)
);

CREATE INDEX IF NOT EXISTS churn_radar_client_results_run_idx ON churn_radar_client_results (run_id);
CREATE INDEX IF NOT EXISTS churn_radar_client_results_client_idx ON churn_radar_client_results (client_id);

CREATE TABLE IF NOT EXISTS churn_radar_findings (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id VARCHAR NOT NULL REFERENCES churn_radar_runs(id) ON DELETE CASCADE,
  client_id VARCHAR NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  reason TEXT NOT NULL,
  severity VARCHAR NOT NULL,
  confidence REAL,
  evidence_json JSONB,
  theme_category VARCHAR NOT NULL DEFAULT 'other',
  created_at TIMESTAMP DEFAULT now(),
  CONSTRAINT churn_radar_findings_run_client_rank_uq UNIQUE (run_id, client_id, rank)
);

CREATE INDEX IF NOT EXISTS churn_radar_findings_run_idx ON churn_radar_findings (run_id);
CREATE INDEX IF NOT EXISTS churn_radar_findings_client_idx ON churn_radar_findings (client_id);
CREATE INDEX IF NOT EXISTS churn_radar_findings_theme_idx ON churn_radar_findings (theme_category);
