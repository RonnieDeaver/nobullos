-- Task #3963 (audit B-012) — Rev.ai callback completion for ATS video
-- transcriptions.
--
-- Adds to ats_submissions:
--   * transcription_failure_code   — typed machine-readable terminal-failure
--                                    reason (see ATS_TRANSCRIPTION_FAILURE_CODES
--                                    in shared/models/ats.ts); previously only a
--                                    bare transcription_status='failed' was written.
--   * transcription_failure_detail — safe human-readable failure detail
--                                    (vendor failure_detail / truncated error).
--   * transcription_updated_at     — server-stamped progress timestamp; drives
--                                    the fallback sweeper's staleness + give-up
--                                    windows (rows have no updated_at column).
--   * ats_submissions_rev_job_id_idx — the callback route and sweeper look
--                                    submissions up by Rev.ai job id.
--
-- Purely additive + idempotent (no backfill). Production converges through
-- drizzle-kit push from shared/models/ats.ts, which declares the same shapes.
ALTER TABLE ats_submissions ADD COLUMN IF NOT EXISTS transcription_failure_code varchar;
ALTER TABLE ats_submissions ADD COLUMN IF NOT EXISTS transcription_failure_detail text;
ALTER TABLE ats_submissions ADD COLUMN IF NOT EXISTS transcription_updated_at timestamp;
CREATE INDEX IF NOT EXISTS ats_submissions_rev_job_id_idx ON ats_submissions (rev_job_id);
