-- Task #829: Append-only audit trail for report section saves.
-- Adds last-edit metadata to live `report_sections` rows and creates a new
-- `report_section_history` table that records every save with attribution.

ALTER TABLE "report_sections"
  ADD COLUMN IF NOT EXISTS "last_edited_by" varchar,
  ADD COLUMN IF NOT EXISTS "last_edit_source" varchar,
  ADD COLUMN IF NOT EXISTS "last_edit_at" timestamp;

CREATE TABLE IF NOT EXISTS "report_section_history" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "report_section_id" varchar,
  "report_id" varchar NOT NULL,
  "section_key" varchar NOT NULL,
  "previous_data" jsonb,
  "new_data" jsonb NOT NULL,
  "data_changed" boolean NOT NULL DEFAULT true,
  "edited_by" varchar NOT NULL,
  "edit_source" varchar NOT NULL,
  "webhook_import_log_id" varchar,
  "created_at" timestamp NOT NULL DEFAULT now()
);

ALTER TABLE "report_section_history"
  ADD COLUMN IF NOT EXISTS "data_changed" boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "report_section_history_report_id_idx"
  ON "report_section_history" ("report_id");
CREATE INDEX IF NOT EXISTS "report_section_history_section_idx"
  ON "report_section_history" ("report_id", "section_key");
