-- Task #3058 — Service Desk ticket workflow: event log for reassignment history
-- and audit trail consumed by the views/notifications task.
--
-- event_type values:
--   status_transition, reassignment, department_change, committed_date_change,
--   confirm_complete, reopen, mark_duplicate, mark_out_of_scope, cancel,
--   waiting_on_set, comment_system

CREATE TABLE IF NOT EXISTS "sd_ticket_events" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "clickup_task_id" varchar NOT NULL,
  "event_type" varchar NOT NULL,
  "actor_user_id" varchar,
  "data" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sd_ticket_events_task_idx" ON "sd_ticket_events" ("clickup_task_id");
CREATE INDEX IF NOT EXISTS "sd_ticket_events_type_idx" ON "sd_ticket_events" ("event_type");
CREATE INDEX IF NOT EXISTS "sd_ticket_events_created_idx" ON "sd_ticket_events" ("created_at");
