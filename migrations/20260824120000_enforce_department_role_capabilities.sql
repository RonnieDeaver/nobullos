-- Enforce the owner-approved department role capability contract.
-- Every department supports Doer. Checker is supported only by the verified
-- Paid Search and GBP / Local SEO department UUIDs.
--
-- The cleanup is bounded, set-based, idempotent, and reports every affected
-- count in migration logs. Supervisor state is intentionally untouched.
DO $$
DECLARE
  cleared_default_checkers integer := 0;
  cleared_client_checkers integer := 0;
  deleted_projection_targets integer := 0;
  deleted_projection_commands integer := 0;
  deleted_projection_destinations integer := 0;
BEGIN
  UPDATE sd_departments
  SET default_checker_user_id = NULL,
      updated_at = NOW()
  WHERE id NOT IN (
    'd04fc82e-a7c4-48ad-9e22-1d51830f6479',
    '4d2e06d4-b935-468b-a204-630964e151bc'
  )
    AND default_checker_user_id IS NOT NULL;
  GET DIAGNOSTICS cleared_default_checkers = ROW_COUNT;

  UPDATE sd_client_dept_assignments
  SET checker_user_id = NULL,
      updated_at = NOW()
  WHERE department_id NOT IN (
    'd04fc82e-a7c4-48ad-9e22-1d51830f6479',
    '4d2e06d4-b935-468b-a204-630964e151bc'
  )
    AND checker_user_id IS NOT NULL;
  GET DIAGNOSTICS cleared_client_checkers = ROW_COUNT;

  DELETE FROM cu_role_projection_client_targets
  WHERE destination_id IN (
    SELECT id
    FROM cu_role_projection_destinations
    WHERE responsibility = 'checker'
      AND department_id NOT IN (
        'd04fc82e-a7c4-48ad-9e22-1d51830f6479',
        '4d2e06d4-b935-468b-a204-630964e151bc'
      )
  );
  GET DIAGNOSTICS deleted_projection_targets = ROW_COUNT;

  DELETE FROM cu_role_projection_commands
  WHERE destination_id IN (
    SELECT id
    FROM cu_role_projection_destinations
    WHERE responsibility = 'checker'
      AND department_id NOT IN (
        'd04fc82e-a7c4-48ad-9e22-1d51830f6479',
        '4d2e06d4-b935-468b-a204-630964e151bc'
      )
  );
  GET DIAGNOSTICS deleted_projection_commands = ROW_COUNT;

  DELETE FROM cu_role_projection_destinations
  WHERE responsibility = 'checker'
    AND department_id NOT IN (
      'd04fc82e-a7c4-48ad-9e22-1d51830f6479',
      '4d2e06d4-b935-468b-a204-630964e151bc'
    );
  GET DIAGNOSTICS deleted_projection_destinations = ROW_COUNT;

  RAISE NOTICE
    'department role capability cleanup: defaults=%, overrides=%, targets=%, commands=%, destinations=%',
    cleared_default_checkers,
    cleared_client_checkers,
    deleted_projection_targets,
    deleted_projection_commands,
    deleted_projection_destinations;
END
$$;