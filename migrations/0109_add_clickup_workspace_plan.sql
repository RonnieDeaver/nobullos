-- Task #2982: Store detected ClickUp workspace plan name in the mirror so
-- plan-gated feature notices can be driven without extra API calls.
--
-- The clickup_workspaces table was created via db:push in early ClickUp epics;
-- this migration conditionally adds the column so it is safe in dev
-- environments where the table may not yet exist (the schema push will
-- create it with the column included) while reliably applying the column in
-- prod (where the table was created via push before this migration shipped).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'clickup_workspaces'
  ) THEN
    ALTER TABLE clickup_workspaces ADD COLUMN IF NOT EXISTS plan varchar;
  END IF;
END $$;
