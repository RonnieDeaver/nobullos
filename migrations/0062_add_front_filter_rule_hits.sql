-- Migration 0062 (Task #1270): per-rule recent-hit log so the Integrations Hub
-- can show admins which filter rules are actually catching new mail vs sitting
-- idle. The in-memory `recordRuleHit` already bumps `affected_count` /
-- `last_applied_at`, but operators had no way to drill into the specific
-- messages that fired a rule — making it impossible to tell whether a rule is
-- silently swallowing real client mail. This table stores the last N hits per
-- rule for the drill-down; it is append-only with periodic per-rule trimming
-- handled in application code.

BEGIN;

CREATE TABLE IF NOT EXISTS "front_filter_rule_hits" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" varchar NOT NULL REFERENCES "front_filter_rules"("id") ON DELETE CASCADE,
  "source" varchar NOT NULL,
  "sync_email_id" varchar,
  "conversation_id" text,
  "sender_email" text,
  "subject" text,
  "rule_type" varchar,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "front_filter_rule_hits_rule_created_idx"
  ON "front_filter_rule_hits" ("rule_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "front_filter_rule_hits_created_idx"
  ON "front_filter_rule_hits" ("created_at" DESC);

COMMIT;
