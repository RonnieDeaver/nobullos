-- Task #4171: company-scope departments + default Checker/Supervisor holders.
--
-- Adds to sd_departments:
--   1. assignment_scope — 'per_client' (default; existing behavior) or
--      'company'. Company departments' Doer/Checker/Supervisor are assigned
--      once company-wide (via the default_*_user_id columns below) and the
--      department disappears from all per-client assignment surfaces.
--   2. default_checker_user_id / default_supervisor_user_id — extend the
--      existing default_primary_user_id concept to all three roles. For
--      per-client departments these are per-role fallbacks; for company
--      departments they are THE company-wide role holders.

ALTER TABLE sd_departments
  ADD COLUMN IF NOT EXISTS assignment_scope VARCHAR NOT NULL DEFAULT 'per_client';

ALTER TABLE sd_departments
  ADD COLUMN IF NOT EXISTS default_checker_user_id VARCHAR;

ALTER TABLE sd_departments
  ADD COLUMN IF NOT EXISTS default_supervisor_user_id VARCHAR;
