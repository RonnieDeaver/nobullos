-- Migration 0106: Edit-locking & presence for NoBull Sheets.
--
-- Adds:
--   1. revision column on sheet_workbooks for optimistic concurrency (stale-snapshot guard).
--   2. sheet_workbook_locks table — one row per workbook currently being edited;
--      expires automatically when heartbeat stops.

ALTER TABLE sheet_workbooks
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sheet_workbook_locks (
  workbook_id   VARCHAR   PRIMARY KEY REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  holder_user_id VARCHAR  NOT NULL REFERENCES users(id),
  holder_name    TEXT     NOT NULL,
  acquired_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  heartbeat_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS sheet_workbook_locks_expires_at_idx ON sheet_workbook_locks(expires_at);
