CREATE TABLE IF NOT EXISTS "user_activity_logs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar REFERENCES "users"("id"),
  "action_type" varchar NOT NULL,
  "route" text,
  "action_detail" text,
  "metadata" jsonb,
  "session_id" varchar,
  "duration" integer,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_activity_user_id" ON "user_activity_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_activity_timestamp" ON "user_activity_logs" ("timestamp");
CREATE INDEX IF NOT EXISTS "idx_activity_action_type" ON "user_activity_logs" ("action_type");
CREATE INDEX IF NOT EXISTS "idx_activity_session_id" ON "user_activity_logs" ("session_id");
