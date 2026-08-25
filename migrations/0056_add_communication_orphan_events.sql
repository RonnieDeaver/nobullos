-- Migration 0056: communication_orphan_events audit table (Task #966).
--
-- Records every event that orphans a raw_communication_records row
-- (i.e. transitions a row to match_status='orphaned' because the
-- linked client was deleted, or because the task-902 retroactive
-- sweep stamped a pre-existing dangling row). Replaces the previous
-- pattern of concatenating free-text reasons onto
-- raw_communication_records.operational_classification_reason — that
-- column remains readable for backwards compat but new code reads
-- this structured table instead.
--
-- One row per (raw_record, orphaning event). The same record can in
-- principle appear here more than once (e.g. dangling-fk sweep after
-- a client_deleted event that did not null the fk in the legacy
-- pre-#897 path), but in steady-state the table is one row per row
-- ever orphaned.
--
-- Written by:
--   - server/storage/clientStorage.ts deleteClient   (cause='client_deleted')
--   - scripts/applyOrphanedCommunicationPolicy.ts    (cause='sweep_backfill')

BEGIN;

CREATE TABLE IF NOT EXISTS communication_orphan_events (
  id                          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_communication_record_id varchar NOT NULL,
  prior_client_id             varchar,
  prior_match_status          varchar,
  cause                       varchar(32) NOT NULL,   -- client_deleted | sweep_backfill
  source                      varchar(64) NOT NULL,   -- deleteClient | task-902-sweep | manual
  reason                      text,
  occurred_at                 timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS communication_orphan_events_record_idx
  ON communication_orphan_events (raw_communication_record_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS communication_orphan_events_prior_client_idx
  ON communication_orphan_events (prior_client_id, occurred_at DESC)
  WHERE prior_client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS communication_orphan_events_occurred_at_idx
  ON communication_orphan_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS communication_orphan_events_cause_idx
  ON communication_orphan_events (cause, occurred_at DESC);

COMMIT;
