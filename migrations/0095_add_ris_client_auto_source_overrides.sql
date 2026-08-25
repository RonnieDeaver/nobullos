-- Task #2485 — RIS per-client BigQuery binding.
--
-- (1) A per-client BigQuery client key on `clients`, bound into the RIS
--     auto-pull / Performance BigQuery queries as the `@clientKey` STRING
--     named param.
-- (2) A per-client override table layering over the global per-`auto_source`
--     `ris_auto_source_mappings` rows. Every override column is nullable and
--     means "inherit the global mapping value"; the resolver merges
--     override-over-global. `filter_value` is bound as the `@filterValue`
--     STRING named param.
--
-- Fully idempotent (ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS)
-- so the dev migration runner and the prod post-merge path can both apply it
-- safely.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS big_query_client_key text;

CREATE TABLE IF NOT EXISTS ris_client_auto_source_overrides (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  auto_source varchar NOT NULL,
  sql_template text,
  value_column varchar,
  comparator varchar,
  threshold text,
  bq_location varchar,
  filter_value text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  CONSTRAINT ris_client_auto_source_overrides_client_source_unique
    UNIQUE (client_id, auto_source)
);

CREATE INDEX IF NOT EXISTS ris_client_auto_source_overrides_client_idx
  ON ris_client_auto_source_overrides (client_id);
