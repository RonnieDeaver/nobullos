-- Task #2371 — RIS Performance Layer (V1)
--
-- Adds the Performance-layer columns to the existing RIS catalog + result
-- ledger. Fully idempotent (ADD COLUMN IF NOT EXISTS) so a dev re-apply or
-- a prod first-apply are both safe. No new tables: Performance rows reuse
-- ris_checks (layer='performance') and ris_check_results.

-- Catalog: metric kind + optional per-check threshold-band override.
ALTER TABLE ris_checks ADD COLUMN IF NOT EXISTS metric_type varchar;
ALTER TABLE ris_checks ADD COLUMN IF NOT EXISTS thresholds jsonb;

-- Result ledger: numeric provenance for a Performance comparison. Stored as
-- text to preserve exact rendered values (currency, ratios). NULL for QA.
ALTER TABLE ris_check_results ADD COLUMN IF NOT EXISTS current_value text;
ALTER TABLE ris_check_results ADD COLUMN IF NOT EXISTS previous_value text;
ALTER TABLE ris_check_results ADD COLUMN IF NOT EXISTS target_value text;
ALTER TABLE ris_check_results ADD COLUMN IF NOT EXISTS change_pct text;
