-- Paid Search role import: append-only per-press attempt evidence.
--
-- The existing ps_role_import_audit table remains the compact current/resume
-- state keyed by (ClickUp parent task, role). This companion table is
-- intentionally append-only so later retries cannot erase earlier conflict,
-- blank, ineligible, actor, or transient-failure evidence.

CREATE TABLE IF NOT EXISTS ps_role_import_attempts (
  id                       varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id            varchar NOT NULL,
  clickup_parent_task_id   varchar NOT NULL,
  role                     varchar NOT NULL,
  disposition              varchar NOT NULL,
  reason                   text,
  client_id                varchar,
  clickup_field_id         varchar,
  clickup_user_id_current  varchar,
  nobull_user_id           varchar,
  department_id            varchar,
  clickup_client_name      text,
  attempted_at             timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  attempted_by             varchar,
  created_at               timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS ps_role_import_attempts_task_role_time_idx
  ON ps_role_import_attempts (clickup_parent_task_id, role, attempted_at);

CREATE INDEX IF NOT EXISTS ps_role_import_attempts_run_idx
  ON ps_role_import_attempts (import_run_id);

CREATE INDEX IF NOT EXISTS ps_role_import_attempts_disposition_idx
  ON ps_role_import_attempts (disposition);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ps_role_import_attempts_role_chk'
      AND conrelid = 'ps_role_import_attempts'::regclass
  ) THEN
    ALTER TABLE ps_role_import_attempts
      ADD CONSTRAINT ps_role_import_attempts_role_chk
      CHECK (role IN ('doer', 'checker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ps_role_import_attempts_disposition_chk'
      AND conrelid = 'ps_role_import_attempts'::regclass
  ) THEN
    ALTER TABLE ps_role_import_attempts
      ADD CONSTRAINT ps_role_import_attempts_disposition_chk
      CHECK (disposition IN (
        'imported',
        'unchanged',
        'conflict',
        'blank',
        'ineligible',
        'retryable'
      ));
  END IF;
END $$;