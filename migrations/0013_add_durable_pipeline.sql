CREATE TABLE IF NOT EXISTS "source_event_log" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_system" varchar NOT NULL CHECK ("source_system" IN ('front', 'zoom', 'semrush')),
  "source_event_type" varchar NOT NULL,
  "source_object_id" varchar NOT NULL,
  "dedupe_key" varchar NOT NULL,
  "payload_json" jsonb NOT NULL,
  "normalized_identity_keys_json" jsonb,
  "ruleset_version" varchar,
  "status" varchar DEFAULT 'received' NOT NULL CHECK ("status" IN ('received', 'normalized', 'ready_to_apply', 'applied', 'failed', 'dead_lettered', 'ignored')),
  "replayable" boolean DEFAULT true NOT NULL,
  "correlation_id" varchar,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "error_code" varchar,
  "error_message" text,
  "retry_at" timestamp,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "normalized_at" timestamp,
  "applied_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "sel_dedupe_key_idx" ON "source_event_log" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "sel_status_idx" ON "source_event_log" ("status");
CREATE INDEX IF NOT EXISTS "sel_status_retry_at_idx" ON "source_event_log" ("status", "retry_at");
CREATE INDEX IF NOT EXISTS "sel_source_system_idx" ON "source_event_log" ("source_system");
CREATE INDEX IF NOT EXISTS "sel_source_system_type_idx" ON "source_event_log" ("source_system", "source_event_type");
CREATE INDEX IF NOT EXISTS "sel_correlation_id_idx" ON "source_event_log" ("correlation_id");
CREATE INDEX IF NOT EXISTS "sel_received_at_idx" ON "source_event_log" ("received_at");

CREATE TABLE IF NOT EXISTS "work_result_log" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_event_id" varchar NOT NULL REFERENCES "source_event_log" ("id") ON DELETE CASCADE,
  "source_system" varchar NOT NULL CHECK ("source_system" IN ('front', 'zoom', 'semrush')),
  "result_type" varchar NOT NULL,
  "result_json" jsonb NOT NULL,
  "status" varchar DEFAULT 'pending' NOT NULL CHECK ("status" IN ('pending', 'completed', 'failed', 'dead_lettered')),
  "ruleset_version" varchar,
  "correlation_id" varchar,
  "error_code" varchar,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "wrl_source_event_id_idx" ON "work_result_log" ("source_event_id");
CREATE INDEX IF NOT EXISTS "wrl_status_idx" ON "work_result_log" ("status");
CREATE INDEX IF NOT EXISTS "wrl_source_system_idx" ON "work_result_log" ("source_system");
CREATE INDEX IF NOT EXISTS "wrl_correlation_id_idx" ON "work_result_log" ("correlation_id");
CREATE INDEX IF NOT EXISTS "wrl_result_type_idx" ON "work_result_log" ("result_type");

CREATE TABLE IF NOT EXISTS "apply_state" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "work_result_id" varchar NOT NULL REFERENCES "work_result_log" ("id") ON DELETE CASCADE,
  "source_event_id" varchar NOT NULL REFERENCES "source_event_log" ("id") ON DELETE CASCADE,
  "source_system" varchar NOT NULL CHECK ("source_system" IN ('front', 'zoom', 'semrush')),
  "apply_target" varchar NOT NULL,
  "outcome" varchar DEFAULT 'pending' NOT NULL CHECK ("outcome" IN ('pending', 'success', 'partial', 'conflict', 'failed', 'skipped')),
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "ruleset_version" varchar,
  "applied_version" varchar,
  "input_hash" varchar,
  "response_json" jsonb,
  "error_code" varchar,
  "error_message" text,
  "retry_at" timestamp,
  "attempted_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "as_work_result_id_idx" ON "apply_state" ("work_result_id");
CREATE INDEX IF NOT EXISTS "as_source_event_id_idx" ON "apply_state" ("source_event_id");
CREATE INDEX IF NOT EXISTS "as_outcome_idx" ON "apply_state" ("outcome");
CREATE INDEX IF NOT EXISTS "as_outcome_retry_at_idx" ON "apply_state" ("outcome", "retry_at");
CREATE INDEX IF NOT EXISTS "as_source_system_idx" ON "apply_state" ("source_system");
CREATE INDEX IF NOT EXISTS "as_apply_target_idx" ON "apply_state" ("apply_target");
