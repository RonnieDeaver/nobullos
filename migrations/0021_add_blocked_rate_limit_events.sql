CREATE TABLE IF NOT EXISTS "blocked_rate_limit_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "timestamp" bigint NOT NULL,
  "category" varchar(128) NOT NULL,
  "method" varchar(16) NOT NULL,
  "path" text NOT NULL,
  "ip" varchar(64) NOT NULL,
  "user_id" varchar(128)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocked_rate_limit_events_timestamp_idx"
  ON "blocked_rate_limit_events" ("timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocked_rate_limit_events_user_timestamp_idx"
  ON "blocked_rate_limit_events" ("user_id", "timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocked_rate_limit_events_ip_timestamp_idx"
  ON "blocked_rate_limit_events" ("ip", "timestamp");
