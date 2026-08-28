-- Move the existing onboarding roster into the Role Assignments authority.
-- The legacy table remains intact for compatibility and possible later retirement.
DO $$
DECLARE
  onboarding_department_id varchar;
  matching_department_count integer;
  legacy_default_user_id varchar;
BEGIN
  SELECT count(*)::integer
    INTO matching_department_count
    FROM sd_departments
   WHERE lower(trim(name)) = 'onboarding';

  IF matching_department_count > 1 THEN
    RAISE EXCEPTION
      'Cannot migrate onboarding roster: found % departments named Onboarding; keep exactly one',
      matching_department_count;
  END IF;

  IF matching_department_count = 1 THEN
    SELECT id
      INTO onboarding_department_id
      FROM sd_departments
     WHERE lower(trim(name)) = 'onboarding'
     LIMIT 1;

    UPDATE sd_departments
       SET active = true,
           assignment_scope = 'company',
           updated_at = now()
     WHERE id = onboarding_department_id;
  ELSE
    INSERT INTO sd_departments (name, active, assignment_scope, sort_order)
    VALUES (
      'Onboarding',
      true,
      'company',
      COALESCE((SELECT max(sort_order) + 1 FROM sd_departments), 1)
    )
    RETURNING id INTO onboarding_department_id;
  END IF;

  INSERT INTO sd_department_members
    (department_id, user_id, active, created_at, updated_at)
  SELECT
    onboarding_department_id,
    legacy.user_id,
    legacy.active,
    legacy.created_at,
    now()
  FROM onboarding_assignees legacy
  ON CONFLICT (department_id, user_id) DO UPDATE
    SET active = EXCLUDED.active,
        updated_at = now();

  SELECT user_id
    INTO legacy_default_user_id
    FROM onboarding_assignees
   WHERE is_default = true
     AND active = true
   LIMIT 1;

  IF legacy_default_user_id IS NOT NULL THEN
    UPDATE sd_departments
       SET default_primary_user_id = legacy_default_user_id,
           updated_at = now()
     WHERE id = onboarding_department_id;
  END IF;
END
$$;