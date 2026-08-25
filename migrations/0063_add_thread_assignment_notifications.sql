-- Migration 0063 — Task #1288: per-user inbox of "you were assigned to
-- this thread" pings. The Conversation Hub renders a badge on the
-- "Mine" chip and a one-time toast for unread rows; rows are inserted
-- by `upsertThreadAssignment` whenever the assignee transitions to a
-- new (non-null) user that isn't the actor making the change.

BEGIN;

CREATE TABLE IF NOT EXISTS "thread_assignment_notifications" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_key" varchar NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "assigned_by_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "read_at" timestamp
);

CREATE INDEX IF NOT EXISTS "thread_assignment_notifications_user_unread_idx"
  ON "thread_assignment_notifications" ("user_id", "read_at");

COMMIT;
