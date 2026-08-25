-- Task #1806 — Audit trail for every CEO "Apply pending prod writes" press.
--
-- One row per (apply press × action), written from the worker pool after
-- the action's `apply()` resolves. Never written from a request hold —
-- all inserts are wrapped in `runWithWorkerDb` + `withDbAttribution`.
-- Read by the panel's "Recent runs" section and by the 2 → 3 ramp gate
-- in Task #1807.

CREATE TABLE IF NOT EXISTS "prod_action_runs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "action_id" varchar(128) NOT NULL,
  "action_title" varchar(256) NOT NULL,
  "actor_user_id" varchar REFERENCES users(id),
  "outcome_state" varchar(16) NOT NULL,
  "detail" text,
  "rows_affected" integer,
  "error_message" text,
  "applied_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_prod_action_runs_applied_at"
  ON "prod_action_runs" ("applied_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_prod_action_runs_action_state_time"
  ON "prod_action_runs" ("action_id", "outcome_state", "applied_at" DESC);
