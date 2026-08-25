-- Task #1047: deterministic schema for the Front sync pipeline columns.
--
-- Background: `front_sync_emails.pipeline_state` (and the related
-- pipeline bookkeeping columns) are referenced by the Drizzle model
-- `frontSyncEmails` in `shared/models/communications.ts`. Every
-- `select().from(frontSyncEmails)` in the storage layer therefore
-- emits an explicit column list that includes `pipeline_state`. If
-- the column is missing in production the worker query fails with
-- `column "pipeline_state" does not exist`, which is exactly the
-- drift Task #1047 is repairing.
--
-- These columns were previously created only by the runtime DDL
-- helper `ensureFrontSyncEmailsColumns()` in `server/index.ts`. That
-- helper still runs at boot as defense-in-depth, but a fresh
-- environment that never executes the bootstrap (snapshot restore,
-- new replica, an alternate runner) would be missing the columns.
-- This migration mirrors the bootstrap DDL one-to-one so the schema
-- is reproducible from `migrations/` alone.
--
-- All statements are additive and idempotent: re-running is a no-op,
-- and applying after the bootstrap helper already added the columns
-- is also a no-op.

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS pipeline_state varchar NOT NULL DEFAULT 'discovered';

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS last_message_id text;

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS version_key text;

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS pipeline_error text;

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS pipeline_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS state_changed_at timestamp DEFAULT now();

ALTER TABLE front_sync_emails
  ADD COLUMN IF NOT EXISTS bulk_classifier_version integer;

CREATE INDEX IF NOT EXISTS front_sync_pipeline_state_idx
  ON front_sync_emails (pipeline_state);

CREATE INDEX IF NOT EXISTS front_sync_version_key_idx
  ON front_sync_emails (version_key);
