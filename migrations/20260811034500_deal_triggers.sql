-- Task #4332 — Native deal auto-move triggers.
-- Additive only; idempotent (the replay seam re-applies migrations twice).
--
--   deal_trigger_events: durable normalized trigger-event log. event_key is
--   the replay guard (UNIQUE; emitters INSERT … ON CONFLICT DO NOTHING and
--   only the inserting caller processes). Rows are never deleted; FKs SET
--   NULL so the log survives parent deletes.
--
--   pandadoc_documents.linked_deal_id: explicit document→deal link (moves
--   never guess a deal — unlinked docs surface for manual linking).
--
--   deal_stage_history.moved_by_source / trigger_event_id: source
--   attribution for auto-moves (NULL = manual move; moved_by_user_id stays
--   NULL for system moves). trigger_event_id is a soft reference into
--   deal_trigger_events (no FK: append-only log, avoids a model cycle).

CREATE TABLE IF NOT EXISTS deal_trigger_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type varchar(40) NOT NULL,
  event_key text NOT NULL,
  source_id text NOT NULL,
  client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
  deal_id varchar REFERENCES deals(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'pending',
  outcome varchar(40),
  stage_history_id varchar,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  processed_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_trigger_events_event_key_uq
  ON deal_trigger_events (event_key);
CREATE INDEX IF NOT EXISTS deal_trigger_events_type_created_idx
  ON deal_trigger_events (trigger_type, created_at);
CREATE INDEX IF NOT EXISTS deal_trigger_events_source_idx
  ON deal_trigger_events (source_id);

ALTER TABLE pandadoc_documents
  ADD COLUMN IF NOT EXISTS linked_deal_id varchar REFERENCES deals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pandadoc_documents_linked_deal_idx
  ON pandadoc_documents (linked_deal_id);

ALTER TABLE deal_stage_history
  ADD COLUMN IF NOT EXISTS moved_by_source varchar(40);
ALTER TABLE deal_stage_history
  ADD COLUMN IF NOT EXISTS trigger_event_id varchar;
