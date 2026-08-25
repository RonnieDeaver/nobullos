-- Task #5235: contract the retired Supervisor schema after the live-state cleanup.
-- destructive-approved: Task #5235 explicitly authorizes these three nullable-column drops after zero-live-state checks; each takes a brief ACCESS EXCLUSIVE metadata lock with no table rewrite or index build.
-- retires-current-schema-replay-of: 20260825120000_retire_supervisor_live_state.sql
-- This migration deliberately performs no cleanup. Any remaining live state
-- aborts the transaction before the three retired columns are dropped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sd_departments'
      AND column_name = 'default_supervisor_user_id'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM sd_departments
      WHERE default_supervisor_user_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Task 5235 blocked: sd_departments.default_supervisor_user_id is not neutralized';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sd_client_dept_assignments'
      AND column_name = 'supervisor_user_id'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM sd_client_dept_assignments
      WHERE supervisor_user_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Task 5235 blocked: sd_client_dept_assignments.supervisor_user_id is not neutralized';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sd_ticket_mapping'
      AND column_name = 'supervisor_escalated_at'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM sd_ticket_mapping
      WHERE supervisor_escalated_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Task 5235 blocked: sd_ticket_mapping.supervisor_escalated_at is not neutralized';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM sd_request_type_checklist_steps
    WHERE assignee_role IS NOT NULL
      AND lower(assignee_role) NOT IN ('doer', 'checker')
  ) THEN
    RAISE EXCEPTION 'Task 5235 blocked: unsupported checklist assignee roles remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM cu_role_projection_commands command
    JOIN cu_role_projection_destinations destination
      ON destination.id = command.destination_id
    WHERE lower(destination.responsibility) = 'supervisor'
  ) THEN
    RAISE EXCEPTION 'Task 5235 blocked: Supervisor projection command rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM cu_role_projection_client_targets target
    JOIN cu_role_projection_destinations destination
      ON destination.id = target.destination_id
    WHERE lower(destination.responsibility) = 'supervisor'
  ) THEN
    RAISE EXCEPTION 'Task 5235 blocked: Supervisor projection target rows remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM cu_role_projection_destinations
    WHERE lower(responsibility) NOT IN ('doer', 'checker')
  ) THEN
    RAISE EXCEPTION 'Task 5235 blocked: unsupported projection destination responsibilities remain';
  END IF;
END $$;

ALTER TABLE sd_departments
  DROP COLUMN IF EXISTS default_supervisor_user_id;

ALTER TABLE sd_client_dept_assignments
  DROP COLUMN IF EXISTS supervisor_user_id;

ALTER TABLE sd_ticket_mapping
  DROP COLUMN IF EXISTS supervisor_escalated_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'sd_request_type_checklist_steps'::regclass
      AND conname = 'sd_rt_checklist_steps_assignee_role_supported'
  ) THEN
    ALTER TABLE sd_request_type_checklist_steps
      ADD CONSTRAINT sd_rt_checklist_steps_assignee_role_supported
      CHECK (assignee_role IS NULL OR assignee_role IN ('doer', 'checker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'cu_role_projection_destinations'::regclass
      AND conname = 'cu_role_projection_destinations_responsibility_supported'
  ) THEN
    ALTER TABLE cu_role_projection_destinations
      ADD CONSTRAINT cu_role_projection_destinations_responsibility_supported
      CHECK (responsibility IN ('doer', 'checker'));
  END IF;
END $$;