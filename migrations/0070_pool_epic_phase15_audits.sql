-- Task #1728 (Pool epic Phase 1.5):
--   * external_call_audits + external_call_audit_daily_rollups
--   * db_hold_label_rollups
--
-- These tables are write-gated by Phase 0 kill switches
-- (`external_call_audit_enabled`, `db_hold_rollup_enabled`). Creating
-- the tables here is behavior-neutral — the writers do nothing until
-- the operator flips the switch in `system_settings`.

CREATE TABLE IF NOT EXISTS "external_call_audits" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "integration" VARCHAR(32) NOT NULL,
  "endpoint" VARCHAR(256) NOT NULL,
  "method" VARCHAR(16) NOT NULL DEFAULT 'GET',
  "called_at" BIGINT NOT NULL,
  "duration_ms" INTEGER NOT NULL DEFAULT 0,
  "status_code" INTEGER,
  "response_size_bytes" INTEGER,
  "response_cache_hit" BOOLEAN NOT NULL DEFAULT FALSE,
  "same_response_as_previous" BOOLEAN NOT NULL DEFAULT FALSE,
  "caller_label" VARCHAR(128),
  "request_dedupe_key" VARCHAR(64) NOT NULL,
  "response_hash" VARCHAR(64),
  "error_class" VARCHAR(64),
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_external_call_audits_called_at"
  ON "external_call_audits" ("called_at");
CREATE INDEX IF NOT EXISTS "idx_external_call_audits_integration_called"
  ON "external_call_audits" ("integration", "called_at");
CREATE INDEX IF NOT EXISTS "idx_external_call_audits_dedupe"
  ON "external_call_audits" ("request_dedupe_key", "called_at");

CREATE TABLE IF NOT EXISTS "external_call_audit_daily_rollups" (
  "id" INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "date" VARCHAR(10) NOT NULL,
  "integration" VARCHAR(32) NOT NULL,
  "endpoint" VARCHAR(256) NOT NULL,
  "caller_label" VARCHAR(128) NOT NULL DEFAULT '',
  "call_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "avg_duration_ms" INTEGER,
  "p95_duration_ms" INTEGER,
  "cache_hit_count" INTEGER NOT NULL DEFAULT 0,
  "same_response_count" INTEGER NOT NULL DEFAULT 0,
  "total_response_bytes" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_external_call_audit_daily_rollups"
  ON "external_call_audit_daily_rollups"
  ("date", "integration", "endpoint", "caller_label");

CREATE INDEX IF NOT EXISTS "idx_external_call_audit_daily_rollups_date"
  ON "external_call_audit_daily_rollups" ("date");

CREATE TABLE IF NOT EXISTS "db_hold_label_rollups" (
  "id" INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "date" VARCHAR(10) NOT NULL,
  "pool" VARCHAR(32) NOT NULL,
  "hold_label" VARCHAR(256) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "max_duration_ms" INTEGER NOT NULL DEFAULT 0,
  "avg_duration_ms" INTEGER,
  "p95_duration_ms" INTEGER,
  "total_hold_time_ms" BIGINT NOT NULL DEFAULT 0,
  "first_seen_at" BIGINT NOT NULL,
  "last_seen_at" BIGINT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_db_hold_label_rollups"
  ON "db_hold_label_rollups" ("date", "pool", "hold_label");

CREATE INDEX IF NOT EXISTS "idx_db_hold_label_rollups_date"
  ON "db_hold_label_rollups" ("date");
CREATE INDEX IF NOT EXISTS "idx_db_hold_label_rollups_pool_date"
  ON "db_hold_label_rollups" ("pool", "date");
