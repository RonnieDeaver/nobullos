CREATE TABLE IF NOT EXISTS "blocked_ips" (
  "ip" varchar(64) PRIMARY KEY NOT NULL,
  "blocked_at" bigint NOT NULL,
  "reason" text
);
