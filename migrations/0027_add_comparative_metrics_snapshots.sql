CREATE TABLE IF NOT EXISTS "comparative_metrics_snapshots" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "timestamp" bigint NOT NULL,
  "calls_total" integer NOT NULL,
  "chosen_responses" integer NOT NULL,
  "none_responses" integer NOT NULL,
  "failures" integer NOT NULL,
  "none_rate" real NOT NULL,
  "chosen_rate" real NOT NULL,
  "truncation_rate" real NOT NULL,
  "avg_shortlist_size" real NOT NULL,
  "avg_excerpt_chars" real NOT NULL,
  "last_reset_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "comparative_metrics_snapshots_ts_idx"
  ON "comparative_metrics_snapshots" ("timestamp");
