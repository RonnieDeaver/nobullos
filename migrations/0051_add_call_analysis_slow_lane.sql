-- Migration 0051: call analysis slow lane + dynamic ffmpeg timeouts (Task #1049)
--
-- The `call_analysis_jobs` table has accumulated 1,641 timeout-driven
-- failures because long calls share the same 90 s ffmpeg budget and
-- single worker as short calls. This migration adds:
--   * `lane` — `normal` (default) or `slow`. Long / very-long audio is
--     re-routed to the slow lane so it cannot starve normal-call latency.
--   * `failure_reason` — typed reason (`ffmpeg_timeout`,
--     `ffmpeg_invalid_audio`, `whisper_timeout`, `download_failed`,
--     `cpu_starved`, `file_too_large`, `unknown`) so the failure mix is
--     groupable instead of a free-text string.
--   * `audio_duration_seconds` / `audio_size_bytes` — preflight metadata
--     captured before conversion. Lets the slow-lane router and future
--     dashboards reason about file shape without re-probing.

BEGIN;

ALTER TABLE call_analysis_jobs
  ADD COLUMN IF NOT EXISTS lane varchar(16) DEFAULT 'normal' NOT NULL,
  ADD COLUMN IF NOT EXISTS failure_reason varchar(64),
  ADD COLUMN IF NOT EXISTS audio_duration_seconds real,
  ADD COLUMN IF NOT EXISTS audio_size_bytes bigint;

-- Pollers filter on (lane, status, attemptCount) — a composite index
-- keeps both lanes' poll queries on a single index scan.
CREATE INDEX IF NOT EXISTS call_analysis_jobs_lane_status_idx
  ON call_analysis_jobs (lane, status);

COMMIT;
