-- Migration: add sheet_templates table for workbook templates & duplication feature.
CREATE TABLE IF NOT EXISTS sheet_templates (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_workbook_id varchar REFERENCES sheet_workbooks(id) ON DELETE SET NULL,
  snapshot jsonb,
  data_block_defs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by varchar NOT NULL REFERENCES users(id),
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sheet_templates_created_by_idx ON sheet_templates (created_by);
CREATE INDEX IF NOT EXISTS sheet_templates_archived_at_idx ON sheet_templates (archived_at);
