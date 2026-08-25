-- Task 643: Stop accidental duplicate key-call assignments for the same call type.
-- The table previously had a non-unique btree index on (command_panel_id, call_type),
-- so the application-level upsertKeyCall (select-then-insert) could race and create
-- duplicate rows on concurrent submissions. Promote the invariant to a real DB-level
-- unique constraint so onConflictDoUpdate can replace the racy upsert.
--
-- Step 1: Collapse any pre-existing duplicate rows by keeping the most recently
-- assigned row per (command_panel_id, call_type) and deleting the rest. assigned_at
-- has a default of now() so it should be populated for every row; treat NULLs as
-- oldest, and fall back to id ordering for ties.
DELETE FROM "command_panel_key_calls"
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY command_panel_id, call_type
        ORDER BY assigned_at DESC NULLS LAST, id DESC
      ) AS rn
    FROM "command_panel_key_calls"
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
DROP INDEX IF EXISTS "key_calls_unique_type_idx";
--> statement-breakpoint
ALTER TABLE "command_panel_key_calls"
  ADD CONSTRAINT "key_calls_panel_call_type_uq"
  UNIQUE ("command_panel_id", "call_type");
