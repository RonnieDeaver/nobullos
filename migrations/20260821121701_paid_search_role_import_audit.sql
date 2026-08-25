-- Task #5157 — Paid Search role cutover: durable import audit/resume state.
--
-- Creates one table:
--
--   ps_role_import_audit
--     Per-parent / per-role disposition rows from the "Import Paid Search roles"
--     prod action. Keyed by stable ClickUp parent task ID + role name.
--     All five dispositions are persisted as durable evidence, but only
--     imported/unchanged are TERMINAL (skipped on repeat presses); conflict,
--     blank, and ineligible are NON-terminal and re-evaluated each press
--     (Task #5157 fix 5). The distinction is a read-time importer policy; this
--     table's shape/constraints are unchanged.
--     A dedicated table is used (not the generic prod_action_runs) because each
--     row is keyed by the external ClickUp task ID, carries per-row reason/
--     source IDs, and the import must be idempotent across presses.
--
-- Design rules:
--   - IF NOT EXISTS throughout — idempotent replay.
--   - No destructive changes.
--   - Timestamps WITHOUT timezone (UTC; matches codebase convention).
--   - No FK constraints (NoBull monolith convention).
--
-- Never edit applied migrations; add forward-fix migrations only.

CREATE TABLE IF NOT EXISTS ps_role_import_audit (
  id                    varchar          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable ClickUp parent task ID (e.g. "abc123xyz").
  clickup_parent_task_id  varchar        NOT NULL,
  -- "doer" | "checker"
  role                  varchar          NOT NULL,
  -- "imported" | "unchanged" | "conflict" | "blank" | "ineligible"
  -- (only imported/unchanged are terminal; conflict/blank/ineligible are
  --  durable evidence but re-evaluated each press. Transient write failures are
  --  never persisted at all.)
  disposition           varchar          NOT NULL,
  -- Human-readable reason for the disposition.
  reason                text,
  -- NoBull client ID when the parent was successfully matched (nullable).
  client_id             varchar,
  -- The ClickUp People field raw ID on this parent for the role.
  clickup_field_id      varchar,
  -- Raw ClickUp user ID from the People field (single-person; nullable = blank).
  clickup_user_id_current  varchar,
  -- NoBull user ID resolved from clickup_user_id_current (nullable = no mapping).
  nobull_user_id        varchar,
  -- NoBull department ID used for the assignment write (nullable = not written).
  department_id         varchar,
  -- Unique NoBull client name from ClickUp (canonical display name).
  clickup_client_name   text,
  -- ISO timestamp of this particular apply press that created/updated this row.
  applied_at            timestamp        NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  -- NoBull user ID of the operator who pressed Apply.
  applied_by            varchar,
  created_at            timestamp        NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  updated_at            timestamp        NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

-- Hot predicate: resume scan by (task, role); the importer treats only
-- imported/unchanged as terminal at read time.
-- Primary lookup: by stable parent task ID + role (idempotency key).
CREATE UNIQUE INDEX IF NOT EXISTS ps_role_import_audit_task_role_uniq
  ON ps_role_import_audit (clickup_parent_task_id, role);

-- Secondary: by client_id for join/reporting.
CREATE INDEX IF NOT EXISTS ps_role_import_audit_client_idx
  ON ps_role_import_audit (client_id)
  WHERE client_id IS NOT NULL;

-- Secondary: by disposition for dashboard counts.
CREATE INDEX IF NOT EXISTS ps_role_import_audit_disposition_idx
  ON ps_role_import_audit (disposition);

-- Value CHECK constraints — idempotent (Postgres has no ADD CONSTRAINT
-- IF NOT EXISTS for CHECK, so guard on pg_constraint).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ps_role_import_audit_role_chk'
  ) THEN
    ALTER TABLE ps_role_import_audit
      ADD CONSTRAINT ps_role_import_audit_role_chk
      CHECK (role IN ('doer', 'checker'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ps_role_import_audit_disposition_chk'
  ) THEN
    ALTER TABLE ps_role_import_audit
      ADD CONSTRAINT ps_role_import_audit_disposition_chk
      CHECK (disposition IN ('imported', 'unchanged', 'conflict', 'blank', 'ineligible'));
  END IF;
END $$;
