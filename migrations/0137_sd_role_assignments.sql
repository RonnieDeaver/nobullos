-- Task #3618: per-client Doer/Checker/Supervisor role assignments.
--
--   1. sd_client_dept_assignments.backup_user_id → checker_user_id (rename;
--      existing backups carry over as the initial Checker values).
--   2. sd_client_dept_assignments.supervisor_user_id — escalation target.
--   3. sd_ticket_mapping.client_uuid — NoBull clients.id UUID captured at
--      submission (the legacy client_id column is integer and unusable for
--      assignment lookups).
--   4. sd_ticket_mapping.supervisor_escalated_at — once-only escalation marker.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sd_client_dept_assignments' AND column_name = 'backup_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sd_client_dept_assignments' AND column_name = 'checker_user_id'
  ) THEN
    ALTER TABLE sd_client_dept_assignments RENAME COLUMN backup_user_id TO checker_user_id;
  END IF;
END $$;

ALTER TABLE sd_client_dept_assignments
  ADD COLUMN IF NOT EXISTS checker_user_id VARCHAR;

ALTER TABLE sd_client_dept_assignments
  ADD COLUMN IF NOT EXISTS supervisor_user_id VARCHAR;

ALTER TABLE sd_ticket_mapping
  ADD COLUMN IF NOT EXISTS client_uuid VARCHAR;

ALTER TABLE sd_ticket_mapping
  ADD COLUMN IF NOT EXISTS supervisor_escalated_at TIMESTAMP;
