-- Task #4331 — Stage automation rules engine.
-- Additive only; idempotent (safe under the dev-migration replay seam).
-- No seed rows: rules are operator-created; the kill-switch setting is
-- absent-means-enabled, so production needs only the structure.
-- Lockstep with shared/models/dealAutomation.ts.

CREATE TABLE IF NOT EXISTS deal_automation_rules (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id varchar NOT NULL REFERENCES deal_pipelines(id) ON DELETE CASCADE,
  stage_id varchar NOT NULL REFERENCES deal_stages(id) ON DELETE CASCADE,
  from_stage_id varchar REFERENCES deal_stages(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  actions jsonb NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  updated_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_automation_rules_stage_enabled_idx
  ON deal_automation_rules (stage_id, enabled);
CREATE INDEX IF NOT EXISTS deal_automation_rules_pipeline_idx
  ON deal_automation_rules (pipeline_id);

CREATE TABLE IF NOT EXISTS deal_stage_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_history_id varchar NOT NULL REFERENCES deal_stage_history(id) ON DELETE CASCADE,
  deal_id varchar NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  pipeline_id varchar NOT NULL REFERENCES deal_pipelines(id),
  from_stage_id varchar REFERENCES deal_stages(id),
  to_stage_id varchar NOT NULL REFERENCES deal_stages(id),
  moved_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  status varchar(12) NOT NULL DEFAULT 'pending',
  processed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_stage_events_stage_history_uq
  ON deal_stage_events (stage_history_id);
CREATE INDEX IF NOT EXISTS deal_stage_events_status_created_idx
  ON deal_stage_events (status, created_at);
CREATE INDEX IF NOT EXISTS deal_stage_events_deal_id_idx
  ON deal_stage_events (deal_id);

CREATE TABLE IF NOT EXISTS deal_automation_runs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id varchar NOT NULL REFERENCES deal_automation_rules(id) ON DELETE CASCADE,
  event_id varchar NOT NULL REFERENCES deal_stage_events(id) ON DELETE CASCADE,
  deal_id varchar NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  rule_name text NOT NULL,
  deal_name text NOT NULL,
  status varchar(12) NOT NULL,
  skip_reason varchar(40),
  action_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_automation_runs_rule_event_uq
  ON deal_automation_runs (rule_id, event_id);
CREATE INDEX IF NOT EXISTS deal_automation_runs_rule_started_idx
  ON deal_automation_runs (rule_id, started_at);
CREATE INDEX IF NOT EXISTS deal_automation_runs_deal_id_idx
  ON deal_automation_runs (deal_id);
CREATE INDEX IF NOT EXISTS deal_automation_runs_started_idx
  ON deal_automation_runs (started_at);
