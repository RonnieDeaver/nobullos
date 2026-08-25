-- Task #5234: neutralize live Supervisor state without contracting retained columns.
-- Each statement is bounded to Supervisor rows and is repeat-safe; notices are
-- intentionally emitted for the production migration audit.
DO $$
DECLARE
  cleared_defaults integer;
  cleared_assignments integer;
  cleared_steps integer;
  deleted_commands integer;
  deleted_targets integer;
  deleted_destinations integer;
BEGIN
  UPDATE sd_departments
  SET default_supervisor_user_id = NULL, updated_at = NOW()
  WHERE default_supervisor_user_id IS NOT NULL;
  GET DIAGNOSTICS cleared_defaults = ROW_COUNT;

  UPDATE sd_client_dept_assignments
  SET supervisor_user_id = NULL, updated_at = NOW()
  WHERE supervisor_user_id IS NOT NULL;
  GET DIAGNOSTICS cleared_assignments = ROW_COUNT;

  UPDATE sd_request_type_checklist_steps
  SET assignee_role = NULL, assignee_department_id = NULL, updated_at = NOW()
  WHERE lower(assignee_role) = 'supervisor';
  GET DIAGNOSTICS cleared_steps = ROW_COUNT;

  DELETE FROM cu_role_projection_commands command
  USING cu_role_projection_destinations destination
  WHERE command.destination_id = destination.id
    AND lower(destination.responsibility) = 'supervisor';
  GET DIAGNOSTICS deleted_commands = ROW_COUNT;

  DELETE FROM cu_role_projection_client_targets target
  USING cu_role_projection_destinations destination
  WHERE target.destination_id = destination.id
    AND lower(destination.responsibility) = 'supervisor';
  GET DIAGNOSTICS deleted_targets = ROW_COUNT;

  DELETE FROM cu_role_projection_destinations
  WHERE lower(responsibility) = 'supervisor';
  GET DIAGNOSTICS deleted_destinations = ROW_COUNT;

  RAISE NOTICE 'Task 5234 Supervisor cleanup: defaults=%, assignments=%, checklist_steps=%, projection_commands=%, projection_targets=%, projection_destinations=%',
    cleared_defaults, cleared_assignments, cleared_steps, deleted_commands, deleted_targets, deleted_destinations;
END $$;