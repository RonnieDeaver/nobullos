-- Task #1838 — Make Front operational classifier rules editable.
--
-- The operational classifier previously matched against hardcoded
-- regex/string arrays in server/services/operationalClassifier.ts and
-- server/services/companyIdentity.ts. Operators had no way to see what
-- a rule said, when it last fired, or to disable a rule without a code
-- change. This migration introduces a single polymorphic rules table
-- plus a hit-attribution table so every operational dismissal carries
-- the id of the rule that fired.
--
-- Rows are seeded idempotently at application boot from
-- server/services/operationalRulesSeed.ts (kept around as bootstrap
-- data only; the DB is now the single source of truth).
--
-- Gated by `front_operational_rules_from_db_enabled` (default ON).
-- Flip the kill switch off to revert to the in-code constants without
-- a redeploy.

CREATE TABLE IF NOT EXISTS "front_operational_rules" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "category" varchar NOT NULL,
  "value" text NOT NULL,
  "weight" numeric(6,3),
  "label" varchar(128),
  "enabled" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_by" varchar REFERENCES "users"("id"),
  "last_applied_at" timestamp,
  "affected_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "front_operational_rules_category_value_uniq"
    UNIQUE ("category", "value")
);

CREATE INDEX IF NOT EXISTS "front_operational_rules_category_enabled_idx"
  ON "front_operational_rules" ("category", "enabled");

CREATE INDEX IF NOT EXISTS "front_operational_rules_enabled_idx"
  ON "front_operational_rules" ("enabled");

CREATE TABLE IF NOT EXISTS "front_operational_rule_hits" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" varchar NOT NULL
    REFERENCES "front_operational_rules"("id") ON DELETE CASCADE,
  "category" varchar,
  "source" varchar NOT NULL,
  "sync_email_id" varchar,
  "conversation_id" text,
  "sender_email" text,
  "subject" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "front_operational_rule_hits_rule_created_idx"
  ON "front_operational_rule_hits" ("rule_id", "created_at");

CREATE INDEX IF NOT EXISTS "front_operational_rule_hits_created_idx"
  ON "front_operational_rule_hits" ("created_at");
