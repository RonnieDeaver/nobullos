CREATE TABLE IF NOT EXISTS "work_queue" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "queue_name" varchar NOT NULL,
  "job_type" varchar NOT NULL,
  "workload_class" varchar NOT NULL,
  "priority" integer DEFAULT 5 NOT NULL,
  "status" varchar DEFAULT 'pending' NOT NULL,
  "payload" jsonb,
  "payload_json" jsonb,
  "dedupe_key" varchar,
  "cursor" text,
  "cursor_json" jsonb,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "retry_at" timestamp,
  "leased_at" timestamp,
  "lease_owner" varchar,
  "lease_expires_at" timestamp,
  "heartbeat_at" timestamp,
  "error_code" varchar,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_work_queue_status_class" ON "work_queue" ("status", "workload_class");
CREATE INDEX IF NOT EXISTS "idx_work_queue_queue_name" ON "work_queue" ("queue_name");
CREATE INDEX IF NOT EXISTS "idx_work_queue_retry_at" ON "work_queue" ("retry_at");
CREATE INDEX IF NOT EXISTS "idx_work_queue_priority" ON "work_queue" ("priority");
CREATE INDEX IF NOT EXISTS "idx_work_queue_lease_expires" ON "work_queue" ("lease_expires_at");
CREATE INDEX IF NOT EXISTS "wq_status_retry_at_idx" ON "work_queue" ("status", "retry_at");
CREATE INDEX IF NOT EXISTS "wq_class_status_priority_created_idx" ON "work_queue" ("workload_class", "status", "priority", "created_at");
CREATE INDEX IF NOT EXISTS "wq_lease_expires_at_idx" ON "work_queue" ("lease_expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "wq_dedupe_key_idx" ON "work_queue" ("dedupe_key") WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed', 'failed', 'dead_letter', 'cancelled');
