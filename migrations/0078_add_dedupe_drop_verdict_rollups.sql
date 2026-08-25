-- Task #1907 — persist Front recovery apply-layer drop counters so
-- they survive process restarts.
--
-- Two tables back the persisted view used by the admin
-- DedupeDropPanel:
--
--   * `dedupe_drop_verdict_rollups` — per-UTC-day verdict counts
--     (apply_layer_dropping / coverage_denominator_likely_wrong /
--     mixed). The panel sums the last 14 days for its headline
--     apply-layer-drop rate, so the number no longer resets on a
--     process restart mid-incident.
--
--   * `dedupe_drop_active_chains` — currently open per-window
--     consecutive `apply_layer_dropping` chains (and whether the
--     Slack alert has already fired). Hydrated into in-memory state
--     on first access so the alert escalator does not double-fire
--     after a restart and the panel's "active chains" table reflects
--     the real picture instead of looking healthy until the next
--     sample lands.
--
-- Both writes happen on the worker pool (the service is only called
-- from the Front historical recovery worker). Read path uses the
-- worker pool too, via the admin trends route's `withDbAttribution`
-- wrapper. The tables are tiny: at most 3 verdict rows per day, and
-- one chain row per (jobId, windowLabel) currently open.

CREATE TABLE IF NOT EXISTS "dedupe_drop_verdict_rollups" (
  "date" VARCHAR(10) NOT NULL,
  "verdict" VARCHAR(48) NOT NULL,
  "count" BIGINT NOT NULL DEFAULT 0,
  "first_seen_at" BIGINT NOT NULL,
  "last_seen_at" BIGINT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("date", "verdict")
);

CREATE INDEX IF NOT EXISTS "idx_dedupe_drop_verdict_rollups_date"
  ON "dedupe_drop_verdict_rollups" ("date");

CREATE TABLE IF NOT EXISTS "dedupe_drop_active_chains" (
  "window_key" VARCHAR(512) PRIMARY KEY,
  "job_id" VARCHAR(128),
  "window_label" VARCHAR(256) NOT NULL,
  "consecutive_pages" INTEGER NOT NULL,
  "first_page_number" INTEGER NOT NULL,
  "last_page_number" INTEGER NOT NULL,
  "observed_at" BIGINT NOT NULL,
  "alerted" BOOLEAN NOT NULL DEFAULT FALSE,
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
