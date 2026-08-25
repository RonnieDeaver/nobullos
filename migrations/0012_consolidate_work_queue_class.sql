ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "workload_class" varchar;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "queue_name" varchar;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "job_type" varchar;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "payload" jsonb;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "payload_json" jsonb;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "cursor" text;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "cursor_json" jsonb;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "leased_at" timestamp;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "error_code" varchar;
ALTER TABLE "work_queue" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'work_queue' AND column_name = 'queue_class') THEN
    UPDATE "work_queue" SET "workload_class" = "queue_class" WHERE "workload_class" IS NULL;
    ALTER TABLE "work_queue" DROP COLUMN "queue_class";
  END IF;
END $$;

UPDATE "work_queue" SET "queue_name" = "job_type" WHERE "queue_name" IS NULL AND "job_type" IS NOT NULL;
UPDATE "work_queue" SET "job_type" = "queue_name" WHERE "job_type" IS NULL AND "queue_name" IS NOT NULL;
UPDATE "work_queue" SET "queue_name" = 'unknown' WHERE "queue_name" IS NULL;
UPDATE "work_queue" SET "job_type" = 'unknown' WHERE "job_type" IS NULL;
UPDATE "work_queue" SET "workload_class" = 'repair' WHERE "workload_class" IS NULL;

DO $$ BEGIN
  ALTER TABLE "work_queue" ALTER COLUMN "workload_class" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "work_queue" ALTER COLUMN "queue_name" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

DROP INDEX IF EXISTS "wq_class_status_priority_created_idx";
CREATE INDEX IF NOT EXISTS "wq_class_status_priority_created_idx" ON "work_queue" ("workload_class", "status", "priority", "created_at");

CREATE INDEX IF NOT EXISTS "idx_work_queue_status_class" ON "work_queue" ("status", "workload_class");
CREATE INDEX IF NOT EXISTS "idx_work_queue_queue_name" ON "work_queue" ("queue_name");
CREATE INDEX IF NOT EXISTS "idx_work_queue_retry_at" ON "work_queue" ("retry_at");
CREATE INDEX IF NOT EXISTS "idx_work_queue_priority" ON "work_queue" ("priority");
CREATE INDEX IF NOT EXISTS "idx_work_queue_lease_expires" ON "work_queue" ("lease_expires_at");
