-- Task #840: enforce one booking page per AM at the schema level.
--
-- The Drizzle column declares `.unique()` on `booking_pages.account_manager_user_id`,
-- but the original 0034 migration created the table without it. The runtime
-- bootstrap in `server/services/bookingDbConstraints.ts` patches this on boot,
-- but environments where bootstrap doesn't run (e.g. ad-hoc DB restores, tools
-- that bypass server boot) would be left without the guard. This migration
-- guarantees the constraint exists by the time any application code runs.
--
-- It is idempotent (NOT EXISTS check) and performs the same deterministic
-- dedup as the bootstrap before adding the constraint: keep the OLDEST row
-- per AM (by created_at NULLS LAST, then id) and re-point all child rows
-- (availability rules, overrides, scheduled meetings, audit log) to the
-- surviving page so we don't lose history.

DO $$
DECLARE
  dup record;
  keeper_id varchar;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'booking_pages_account_manager_user_id_unique'
  ) THEN
    FOR dup IN
      SELECT account_manager_user_id
      FROM booking_pages
      GROUP BY account_manager_user_id
      HAVING COUNT(*) > 1
    LOOP
      SELECT id INTO keeper_id
      FROM booking_pages
      WHERE account_manager_user_id = dup.account_manager_user_id
      ORDER BY created_at NULLS LAST, id
      LIMIT 1;

      UPDATE booking_availability_rules
      SET booking_page_id = keeper_id
      WHERE booking_page_id IN (
        SELECT id FROM booking_pages
        WHERE account_manager_user_id = dup.account_manager_user_id
          AND id <> keeper_id
      );

      BEGIN
        UPDATE booking_availability_overrides
        SET booking_page_id = keeper_id
        WHERE booking_page_id IN (
          SELECT id FROM booking_pages
          WHERE account_manager_user_id = dup.account_manager_user_id
            AND id <> keeper_id
        );
      EXCEPTION WHEN undefined_table THEN
        NULL;
      END;

      BEGIN
        UPDATE scheduled_meetings
        SET booking_page_id = keeper_id
        WHERE booking_page_id IN (
          SELECT id FROM booking_pages
          WHERE account_manager_user_id = dup.account_manager_user_id
            AND id <> keeper_id
        );
      EXCEPTION WHEN undefined_table OR undefined_column THEN
        NULL;
      END;

      BEGIN
        UPDATE booking_audit_log
        SET booking_page_id = keeper_id
        WHERE booking_page_id IN (
          SELECT id FROM booking_pages
          WHERE account_manager_user_id = dup.account_manager_user_id
            AND id <> keeper_id
        );
      EXCEPTION WHEN undefined_table OR undefined_column THEN
        NULL;
      END;

      DELETE FROM booking_pages
      WHERE account_manager_user_id = dup.account_manager_user_id
        AND id <> keeper_id;
    END LOOP;

    ALTER TABLE booking_pages
    ADD CONSTRAINT booking_pages_account_manager_user_id_unique
    UNIQUE (account_manager_user_id);
  END IF;
END$$;
