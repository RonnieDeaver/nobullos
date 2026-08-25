-- Task #2367 — Revenue Integrity System (RIS) QA Layer (V1).
--
-- A granular per-client / per-product / per-location QA checklist ledger
-- owned by the Reporting role. Two tables:
--   * ris_checks         — the data-driven catalog (admin-editable)
--   * ris_check_results  — one row per check x client x location x period
--
-- Fully idempotent (IF NOT EXISTS everywhere) so the dev migration
-- runner and the prod post-merge path can both apply it safely.

CREATE TABLE IF NOT EXISTS ris_checks (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  layer varchar NOT NULL DEFAULT 'qa',
  product varchar NOT NULL,
  category varchar NOT NULL,
  frequency varchar NOT NULL,
  location_specific boolean NOT NULL DEFAULT false,
  default_severity varchar NOT NULL DEFAULT 'medium',
  default_owner_function varchar,
  auto_source varchar,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ris_checks_layer_product_idx
  ON ris_checks (layer, product);
CREATE INDEX IF NOT EXISTS ris_checks_active_idx
  ON ris_checks (active);

CREATE TABLE IF NOT EXISTS ris_check_results (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id varchar NOT NULL REFERENCES ris_checks(id) ON DELETE CASCADE,
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id varchar REFERENCES client_locations(id) ON DELETE CASCADE,
  period varchar NOT NULL,
  status varchar NOT NULL,
  observed_value text,
  notes text,
  evidence_url text,
  failure_reason text,
  corrective_action text,
  severity_override varchar,
  source varchar NOT NULL DEFAULT 'manual',
  checked_by varchar REFERENCES users(id),
  checked_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ris_check_results_client_period_idx
  ON ris_check_results (client_id, period);
CREATE INDEX IF NOT EXISTS ris_check_results_check_idx
  ON ris_check_results (check_id);
CREATE INDEX IF NOT EXISTS ris_check_results_status_idx
  ON ris_check_results (status);

-- A NULL location_id must still collapse to a single row per
-- (check, client, period). COALESCE the nullable column to '' so the
-- uniqueness holds for both location-specific and global checks.
CREATE UNIQUE INDEX IF NOT EXISTS ris_check_results_scope_uq
  ON ris_check_results (check_id, client_id, COALESCE(location_id, ''), period);
