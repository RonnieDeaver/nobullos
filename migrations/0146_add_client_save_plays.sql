-- Migration 0141 — Task #3696: save-play tracker for at-risk clients.
--
-- client_save_plays: an accountable intervention ("save play") on a client,
-- optionally seeded from a daily judgment's recommended action
-- (source_judgment_id → client_daily_judgments, SET NULL so play history
-- survives judgment deletion). Status flow: active → completed | abandoned;
-- outcome_note records what happened, closed_at/closed_by_user_id stamp the
-- transition. Completed/abandoned plays are kept for post-mortem review.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS only.

BEGIN;

CREATE TABLE IF NOT EXISTS "client_save_plays" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" varchar NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "why" text,
  "source_judgment_id" varchar REFERENCES "client_daily_judgments"("id") ON DELETE SET NULL,
  "assigned_to_user_id" varchar NOT NULL REFERENCES "users"("id"),
  "due_date" date NOT NULL,
  "status" varchar NOT NULL DEFAULT 'active',
  "notes" text,
  "outcome_note" text,
  "created_by_user_id" varchar REFERENCES "users"("id"),
  "closed_at" timestamp,
  "closed_by_user_id" varchar REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "client_save_plays_client_id_idx"
  ON "client_save_plays" ("client_id");
CREATE INDEX IF NOT EXISTS "client_save_plays_status_idx"
  ON "client_save_plays" ("status");
CREATE INDEX IF NOT EXISTS "client_save_plays_client_status_idx"
  ON "client_save_plays" ("client_id", "status");
CREATE INDEX IF NOT EXISTS "client_save_plays_assigned_to_idx"
  ON "client_save_plays" ("assigned_to_user_id");

COMMIT;
