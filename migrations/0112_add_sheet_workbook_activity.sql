-- Migration: add sheet_workbook_activity table
-- Per-workbook audit trail for the Sheets module.

CREATE TABLE IF NOT EXISTS sheet_workbook_activity (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id varchar NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  actor_id varchar REFERENCES users(id) ON DELETE SET NULL,
  actor_name text NOT NULL DEFAULT '',
  action varchar NOT NULL,
  detail jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sheet_workbook_activity_workbook_id_idx
  ON sheet_workbook_activity (workbook_id);

CREATE INDEX IF NOT EXISTS sheet_workbook_activity_workbook_created_at_idx
  ON sheet_workbook_activity (workbook_id, created_at);
