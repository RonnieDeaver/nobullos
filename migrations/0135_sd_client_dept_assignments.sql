-- Task #3585: per-client department assignments + auto-assign on submit
--
-- Adds:
--   1. sd_departments.default_primary_user_id — fallback assignee when no
--      client-level assignment exists for a given department.
--   2. sd_client_dept_assignments — per-client primary + backup per department.

ALTER TABLE sd_departments
  ADD COLUMN IF NOT EXISTS default_primary_user_id VARCHAR;

CREATE TABLE IF NOT EXISTS sd_client_dept_assignments (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          VARCHAR NOT NULL,
  department_id      VARCHAR NOT NULL,
  primary_user_id    VARCHAR,
  backup_user_id     VARCHAR,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sd_client_dept_assignments_client_dept_uniq
  ON sd_client_dept_assignments (client_id, department_id);

CREATE INDEX IF NOT EXISTS sd_client_dept_assignments_client_idx
  ON sd_client_dept_assignments (client_id);

CREATE INDEX IF NOT EXISTS sd_client_dept_assignments_dept_idx
  ON sd_client_dept_assignments (department_id);
