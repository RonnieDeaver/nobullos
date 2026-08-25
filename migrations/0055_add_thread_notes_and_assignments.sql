-- Migration 0055 — Task #850: notes + assignment + status on Conversation
-- Hub threads. Keyed by the unified thread key the client builds in
-- `client/src/lib/conversationModel.ts#resolveThreadKey` (e.g.
-- `phone:8005551234`, `group:<convId>`, `contact:<id>`,
-- `client-phone:<clientId>:<digits>`) so notes/assignments survive across
-- multiple SMS conversation rows that share one phone number.

BEGIN;

CREATE TABLE IF NOT EXISTS "thread_notes" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_key" varchar NOT NULL,
  "body" text NOT NULL,
  "created_by_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "thread_notes_thread_key_idx"
  ON "thread_notes" ("thread_key", "created_at");

CREATE TABLE IF NOT EXISTS "thread_assignments" (
  "thread_key" varchar PRIMARY KEY,
  "assigned_to_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "status" varchar NOT NULL DEFAULT 'open',
  "updated_by_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "thread_assignments_assigned_idx"
  ON "thread_assignments" ("assigned_to_user_id");
CREATE INDEX IF NOT EXISTS "thread_assignments_status_idx"
  ON "thread_assignments" ("status");

COMMIT;
