-- Task #3056 — Service Desk foundation: ClickUp structure, config & ticket mapping.
-- Single "All Service Requests" List architecture (Space → Folder → List) with
-- department as a custom field, so "change fulfilling department" is a field
-- edit — never a List move (ClickUp FAQ: tasks cannot be moved between Lists
-- via API).

CREATE TABLE IF NOT EXISTS "sd_departments" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sd_department_members" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "department_id" varchar NOT NULL,
  "user_id" varchar NOT NULL,
  "clickup_user_id" varchar,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sd_department_members_dept_idx" ON "sd_department_members" ("department_id");
CREATE INDEX IF NOT EXISTS "sd_department_members_user_idx" ON "sd_department_members" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sd_department_members_dept_user_uniq" ON "sd_department_members" ("department_id", "user_id");

CREATE TABLE IF NOT EXISTS "sd_request_types" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "department_id" varchar,
  "name" text NOT NULL,
  "description" text,
  "active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sd_request_types_dept_idx" ON "sd_request_types" ("department_id");

CREATE TABLE IF NOT EXISTS "sd_list_mapping" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "clickup_list_id" varchar,
  "clickup_space_id" varchar,
  "clickup_folder_id" varchar,
  "clickup_workspace_id" varchar,
  "field_client_id" varchar,
  "field_department_id" varchar,
  "field_owner_dept_id" varchar,
  "field_request_type_id" varchar,
  "field_requester_id" varchar,
  "field_requested_date_id" varchar,
  "field_committed_date_id" varchar,
  "field_waiting_who_id" varchar,
  "field_waiting_what_id" varchar,
  "field_waiting_when_id" varchar,
  "department_option_ids" jsonb,
  "request_type_option_ids" jsonb,
  "master_form_url" text,
  "master_form_embed_url" text,
  "setup_step" varchar NOT NULL DEFAULT 'not_started',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sd_ticket_mapping" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "clickup_task_id" varchar NOT NULL,
  "client_id" integer,
  "requester_user_id" varchar,
  "owner_user_id" varchar,
  "department_id" varchar,
  "read_at" timestamp,
  "last_notified_at" timestamp,
  "notification_version" integer NOT NULL DEFAULT 0,
  "nts" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "sd_ticket_mapping_task_idx" ON "sd_ticket_mapping" ("clickup_task_id");
CREATE INDEX IF NOT EXISTS "sd_ticket_mapping_client_idx" ON "sd_ticket_mapping" ("client_id");
CREATE INDEX IF NOT EXISTS "sd_ticket_mapping_requester_idx" ON "sd_ticket_mapping" ("requester_user_id");
CREATE INDEX IF NOT EXISTS "sd_ticket_mapping_owner_idx" ON "sd_ticket_mapping" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "sd_ticket_mapping_dept_idx" ON "sd_ticket_mapping" ("department_id");

-- Seed the 10 departments from the spec (§ Done looks like).
INSERT INTO "sd_departments" ("name", "sort_order") VALUES
  ('Google Ads', 1),
  ('LSA', 2),
  ('GBP', 3),
  ('GHL & Automations', 4),
  ('Web & Landing Pages', 5),
  ('Reporting & Data', 6),
  ('Intake', 7),
  ('Account Management', 8),
  ('Operations', 9),
  ('Finance', 10)
ON CONFLICT DO NOTHING;
