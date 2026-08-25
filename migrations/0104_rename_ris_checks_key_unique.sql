-- Task #2367 follow-up — align the ris_checks UNIQUE(key) constraint name
-- with what drizzle-kit expects (`ris_checks_key_unique`).
--
-- Dev's constraint was created as `ris_checks_key_key` (Postgres default
-- name), so every `drizzle-kit push` treated the drizzle-named constraint as
-- missing and raised an interactive "truncate ris_checks?" prompt, hanging
-- the non-interactive post-merge run. Renaming keeps the same underlying
-- unique index; no data is touched.
--
-- Fully idempotent: safe for scripts/post-merge.sh SAFE_MIGRATIONS.

DO $$
BEGIN
  -- to_regclass() returns NULL (instead of erroring) when the table does not
  -- exist yet, keeping this safe on a brand-new bootstrap database.
  IF to_regclass('public.ris_checks') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'ris_checks_key_key'
        AND conrelid = to_regclass('public.ris_checks')
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'ris_checks_key_unique'
        AND conrelid = to_regclass('public.ris_checks')
    ) THEN
    ALTER TABLE ris_checks
      RENAME CONSTRAINT ris_checks_key_key TO ris_checks_key_unique;
  END IF;
END $$;
