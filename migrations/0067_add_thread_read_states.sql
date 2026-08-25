-- Migration 0067 — Task #1685: per-thread "manually marked unread" flag for
-- the Conversation Hub. Keyed by the unified thread key the client builds
-- in `client/src/lib/conversationModel.ts#resolveThreadKey`, the same key
-- used by `thread_assignments` / `thread_notes`. This is a separate row
-- (rather than a column on `twilio_conversations`) so it covers call-only
-- and voicemail-only threads that have no SMS conversation row, and so a
-- row is only written when an operator explicitly toggles state.
--
-- Read/unread is stored GLOBALLY here (mirrors the existing global
-- `twilio_conversations.unread_count` source of truth). The task brief
-- preferred per-user state, but the existing unread plumbing (row badge,
-- Unread filter, sidebar count, auto-mark-on-open) is global today, and
-- splitting one of those into per-user without splitting all of them
-- would create the exact "two sources of truth" drift the task warned
-- against. Documented in code comments on the table + the route handler.

BEGIN;

CREATE TABLE IF NOT EXISTS "thread_read_states" (
  "thread_key" varchar PRIMARY KEY,
  "manually_unread" boolean NOT NULL DEFAULT false,
  "updated_by_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Partial index — the bulk fetch endpoint only cares about rows that are
-- currently marked unread; once cleared, a row can be left around without
-- impacting either Unread-filter count or the hub paint cost.
CREATE INDEX IF NOT EXISTS "thread_read_states_manually_unread_idx"
  ON "thread_read_states" ("manually_unread")
  WHERE "manually_unread" = true;

COMMIT;
