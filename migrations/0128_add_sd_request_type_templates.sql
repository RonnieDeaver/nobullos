-- Task #3373 — Service Desk native form + request-type templates
-- Adds per-type intake questions and checklist step templates.
-- Also adds tracking columns to sd_ticket_mapping for template enforcement.

CREATE TABLE IF NOT EXISTS "sd_request_type_questions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_type_id" varchar NOT NULL,
  "label" text NOT NULL,
  "question_type" varchar NOT NULL DEFAULT 'text',
  "required" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "options" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sd_rt_questions_rt_idx" ON "sd_request_type_questions" ("request_type_id");

CREATE TABLE IF NOT EXISTS "sd_request_type_checklist_steps" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_type_id" varchar NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sd_rt_checklist_steps_rt_idx" ON "sd_request_type_checklist_steps" ("request_type_id");

-- Track whether the template checklist was applied to a ticket
ALTER TABLE "sd_ticket_mapping" ADD COLUMN IF NOT EXISTS "template_checklist_applied" boolean NOT NULL DEFAULT false;

-- Track whether the ticket was created via NoBull native form (vs ClickUp directly)
ALTER TABLE "sd_ticket_mapping" ADD COLUMN IF NOT EXISTS "created_via_nobull" boolean NOT NULL DEFAULT false;

-- Track whether the "needs information" notification was already sent for external tickets missing required answers
ALTER TABLE "sd_ticket_mapping" ADD COLUMN IF NOT EXISTS "needs_info_notified" boolean NOT NULL DEFAULT false;
