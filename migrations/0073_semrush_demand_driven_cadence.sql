-- Task #1785: SEMrush demand-driven cadence
-- New tables: skip-log rollup, last-applied-hash dedupe, client view pings.
-- New column on clients for lightweight active-client signal.

-- 1. Active-client signal: a single timestamp per client. Updated cheaply
--    when a user views the heatmap, GBP/local-dominance page, or renders a
--    report. Queried in O(1) by the demand-driven enqueue gate.
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "last_viewed_at" timestamp;

CREATE INDEX IF NOT EXISTS "clients_last_viewed_at_idx"
  ON "clients" ("last_viewed_at" DESC NULLS LAST);

-- 2. Skip-log daily rollup. One row per (date, queue, reason) so we never
--    grow per-skip rows forever. Pruned to 90 days by the existing
--    non-critical-sweeps maintenance pass.
CREATE TABLE IF NOT EXISTS "semrush_cadence_skip_log" (
  "id"            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "date"          date NOT NULL,
  "queue_name"    varchar(64) NOT NULL,
  "reason"        varchar(64) NOT NULL,
  "count"         integer NOT NULL DEFAULT 0,
  "client_count"  integer NOT NULL DEFAULT 0,
  "campaign_count" integer NOT NULL DEFAULT 0,
  "updated_at"    timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "semrush_cadence_skip_log_unique_idx"
  ON "semrush_cadence_skip_log" ("date", "queue_name", "reason");

CREATE INDEX IF NOT EXISTS "semrush_cadence_skip_log_date_idx"
  ON "semrush_cadence_skip_log" ("date" DESC);

-- 3. Last-applied response hash per (campaign, location, snapshot key). Used
--    to suppress identical heatmap-apply fan-out. Independent of the
--    external_call_audit feature flag.
CREATE TABLE IF NOT EXISTS "semrush_last_applied_hashes" (
  "id"            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id"   varchar(128) NOT NULL,
  "location_id"   varchar(128) NOT NULL DEFAULT '',
  "snapshot_key"  varchar(128) NOT NULL DEFAULT '',
  "response_hash" varchar(64) NOT NULL,
  "applied_at"    timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "semrush_last_applied_hashes_unique_idx"
  ON "semrush_last_applied_hashes" ("campaign_id", "location_id", "snapshot_key");
