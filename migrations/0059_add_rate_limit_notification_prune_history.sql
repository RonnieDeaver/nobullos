-- Migration 0059: rate_limit_notification_prune_history table (Task #1117).
--
-- Persistent audit log of every notification-history cleanup run (both the
-- nightly scheduled prune and on-demand admin-triggered prunes). Lets the
-- /admin/users "Notification History" card render a "Recent cleanups"
-- section showing who ran cleanup, when, with what retention, how many
-- rows were deleted, and how long each run took. Also exposed via
-- GET /api/health/rate-limits/notification-retention/history for
-- export/filtering later.
--
-- `triggered_by` identifies the run source: "scheduler" (nightly cron),
-- "startup" (the post-boot prime prune), or "on_demand" (admin-triggered
-- via the POST /prune endpoint). `actor_id` is non-null only for
-- on-demand runs and is used to resolve a display name.

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_notification_prune_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at          timestamp NOT NULL DEFAULT now(),
  triggered_by    varchar(32) NOT NULL,
  actor_id        varchar,
  retention_days  integer NOT NULL,
  cutoff_ms       bigint NOT NULL,
  deleted_rows    integer NOT NULL DEFAULT 0,
  duration_ms     integer NOT NULL DEFAULT 0,
  status          varchar(16) NOT NULL DEFAULT 'ok',
  error_message   text
);

CREATE INDEX IF NOT EXISTS rate_limit_notification_prune_history_ran_at_idx
  ON rate_limit_notification_prune_history (ran_at DESC);

COMMIT;
