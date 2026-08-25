-- Migration 0058: call_archive_health_snapshots table (Task #1094).
--
-- Periodic snapshots of the call-recording archive backlog so the
-- /admin/twilio "Archive pipeline health" card and the
-- /admin/twilio/call-archive drill-in can render a 24h trend
-- (sparkline) under each counter without running heavy SQL on every
-- render. The existing 15-minute call-archive backlog watcher
-- (server/services/callArchiveBacklogAlerts.ts) writes one row per
-- tick using the same COUNT(*) queries it already runs, so this
-- snapshot pipeline is effectively free.

BEGIN;

CREATE TABLE IF NOT EXISTS call_archive_health_snapshots (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sampled_at                  timestamp NOT NULL DEFAULT now(),
  pending_stuck_count         integer NOT NULL DEFAULT 0,
  oldest_pending_age_seconds  integer,
  recent_failed_count         integer NOT NULL DEFAULT 0,
  pending_hours               integer NOT NULL,
  failed_lookback_hours       integer NOT NULL
);

CREATE INDEX IF NOT EXISTS call_archive_health_snapshots_sampled_at_idx
  ON call_archive_health_snapshots (sampled_at DESC);

COMMIT;
