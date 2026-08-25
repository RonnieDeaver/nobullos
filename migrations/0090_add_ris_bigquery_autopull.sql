-- Task #2368 — RIS BigQuery auto-pull.
--
-- Adds the runtime-configurable mapping registry that bridges a
-- ris_checks.auto_source tag to the BigQuery query producing its observed
-- value, plus the confirm/override + needs-review bookkeeping columns on
-- ris_check_results. Fully idempotent so the dev migration runner and the
-- prod post-merge path can both apply it safely.

CREATE TABLE IF NOT EXISTS ris_auto_source_mappings (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  auto_source varchar NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT false,
  sql_template text NOT NULL DEFAULT '',
  value_column varchar NOT NULL DEFAULT 'value',
  comparator varchar NOT NULL DEFAULT 'none',
  threshold text,
  unit_label varchar,
  bq_location varchar,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ris_auto_source_mappings_enabled_idx
  ON ris_auto_source_mappings (enabled);

-- Confirm/override + needs-review bookkeeping on the result ledger.
ALTER TABLE ris_check_results
  ADD COLUMN IF NOT EXISTS confirmed_at timestamp;
ALTER TABLE ris_check_results
  ADD COLUMN IF NOT EXISTS confirmed_by varchar REFERENCES users(id);
ALTER TABLE ris_check_results
  ADD COLUMN IF NOT EXISTS auto_error text;
