-- Task 639: Stop accidental duplicate RER recordings for the same month.
-- The route handler is already idempotent in the happy path, but the table
-- has no DB-level guard, so a concurrent double-submit (or a future code
-- path) could still insert duplicate (clientId, recording, month) rows.
-- Add a unique constraint so the database enforces the invariant.
--
-- Step 1: Collapse any pre-existing duplicates by keeping the earliest
-- assignedAt row per (client_id, raw_communication_record_id, reporting_month)
-- and deleting the rest. assignedAt has a default of now() so it should be
-- populated for every row; if it is not, treat NULLs as latest (drop them in
-- favor of any concrete timestamp), and fall back to id ordering for ties.
DELETE FROM "command_panel_rer_recordings"
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY client_id, raw_communication_record_id, reporting_month
        ORDER BY assigned_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM "command_panel_rer_recordings"
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
ALTER TABLE "command_panel_rer_recordings"
  ADD CONSTRAINT "rer_recordings_client_recording_month_uq"
  UNIQUE ("client_id", "raw_communication_record_id", "reporting_month");
