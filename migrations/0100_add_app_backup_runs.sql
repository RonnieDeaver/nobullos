-- Task #2657 — daily app backup run lifecycle (`app_backup_runs`).
--
-- This table was originally created via `drizzle-kit push` and never had a
-- migration file, so it shipped to prod but never landed in the dev DB (the
-- non-interactive post-merge `drizzle-kit push` step skips the interactive
-- "created or renamed?" prompt). When `live_data_snapshots` was added with its
-- own migration, the Replit publish schema-diff (dev DB vs prod DB) saw
-- `app_backup_runs` only in prod and proposed dropping/renaming it — a
-- destructive prompt. This migration makes the table part of the deterministic
-- migration history so every fresh clone / environment gets it.
--
-- Idempotent (IF NOT EXISTS) so it is a safe no-op on prod and on the
-- already-reconciled dev DB. DDL is byte-aligned with shared/models/backups.ts;
-- the two indexes are `created_at DESC` to match the live prod structure.
CREATE TABLE IF NOT EXISTS app_backup_runs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(16) NOT NULL DEFAULT 'scheduled',
  status varchar(16) NOT NULL DEFAULT 'in_progress',
  db_status varchar(16),
  files_status varchar(16),
  db_dump_key text,
  file_manifest_key text,
  db_dump_size_bytes bigint,
  file_object_count integer,
  file_copied_count integer,
  file_total_size_bytes bigint,
  total_size_bytes bigint,
  error_message text,
  triggered_by varchar,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_backup_runs_created_at ON app_backup_runs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_backup_runs_status_time ON app_backup_runs USING btree (status, created_at DESC);
