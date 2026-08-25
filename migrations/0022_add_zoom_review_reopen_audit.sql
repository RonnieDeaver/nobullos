-- Task 546: Allow admins to re-open a resolved Zoom review decision back into
-- the queue. Re-opening clears reviewResolution / reviewedAt / reviewedByUserId
-- and dismiss reason fields, so we keep an independent audit trail for who
-- reopened the decision and how many times it has been reopened.
ALTER TABLE "agent_match_decisions"
  ADD COLUMN IF NOT EXISTS "reopened_at" timestamp,
  ADD COLUMN IF NOT EXISTS "reopened_by_user_id" varchar,
  ADD COLUMN IF NOT EXISTS "reopen_count" integer DEFAULT 0 NOT NULL;
