-- Migration 0106: NoBull Sheets — version history & restore.
--
-- Stores full workbook snapshots as versions.  Retention is enforced by the
-- application-layer thinning policy on every write (Task #2934).
--
-- Retention rules (applied at insert time, non-restore-point rows only):
--   age < 24 h            → keep all  (dense window)
--   1 d  ≤ age < 7 d      → keep newest per calendar day
--   7 d  ≤ age < 30 d     → keep newest per calendar week
--   age ≥ 30 d            → delete
--   hard cap per workbook → 100 versions (oldest deleted first)

CREATE TABLE IF NOT EXISTS sheet_workbook_versions (
  id                  VARCHAR   PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id         VARCHAR   NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  snapshot            JSONB     NOT NULL,
  snapshot_size_bytes INTEGER   NOT NULL DEFAULT 0,
  created_by          VARCHAR   REFERENCES users(id),
  label               TEXT,
  is_restore_point    BOOLEAN   NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sheet_workbook_versions_workbook_id_idx
  ON sheet_workbook_versions(workbook_id);
CREATE INDEX IF NOT EXISTS sheet_workbook_versions_workbook_created_at_idx
  ON sheet_workbook_versions(workbook_id, created_at DESC);
