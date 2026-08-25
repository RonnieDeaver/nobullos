-- Task #1948 — Survive a server restart for the recent-deletion banner marker.
--
-- Task #1932 introduced a "Removed by <user> · just now" marker on the
-- Front Console > Filter Rules "Just created" banner so concurrent
-- reviewers see when another tab deletes a freshly-created rule. The
-- ledger driving that marker was a process-local in-memory ring buffer
-- in server/services/operationalRules.ts; a server restart inside the
-- 5-minute banner window silently dropped the marker.
--
-- This table persists each operational-rule deletion with the actor
-- attribution so the GET /api/integrations/front/operational-rules
-- `recentDeletions` payload can be sourced from the database. We keep
-- the rows around as a small audit trail; the API only surfaces the
-- last ~10 minutes via a deletedAt cutoff.

CREATE TABLE IF NOT EXISTS "front_operational_rule_deletions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" varchar NOT NULL,
  "category" varchar NOT NULL,
  "value" text NOT NULL,
  "label" varchar(128),
  "rule_created_at" timestamp NOT NULL,
  "deleted_at" timestamp NOT NULL DEFAULT now(),
  "deleted_by_id" varchar REFERENCES "users"("id"),
  "deleted_by_name" text
);

CREATE INDEX IF NOT EXISTS "front_operational_rule_deletions_deleted_at_idx"
  ON "front_operational_rule_deletions" ("deleted_at");
