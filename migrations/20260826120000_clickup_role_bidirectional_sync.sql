-- Task #5247 — additive bidirectional role revision contract and evidence.

ALTER TABLE clickup_webhook_receipts
  ADD COLUMN IF NOT EXISTS actor_clickup_user_id varchar,
  ADD COLUMN IF NOT EXISTS changed_field_ids jsonb;

CREATE TABLE IF NOT EXISTS cu_role_sync_contracts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL,
  destination_id varchar NOT NULL,
  local_revision integer NOT NULL DEFAULT 0,
  vendor_revision varchar,
  last_outbound_revision varchar,
  last_observed_clickup_user_ids jsonb,
  conflict_state varchar NOT NULL DEFAULT 'none',
  conflict_evidence jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cu_role_sync_contract_uniq
  ON cu_role_sync_contracts (client_id, destination_id);
CREATE INDEX IF NOT EXISTS cu_role_sync_contract_conflict_idx
  ON cu_role_sync_contracts (conflict_state);

CREATE TABLE IF NOT EXISTS cu_role_sync_transition_evidence (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id varchar,
  command_id varchar,
  client_id varchar NOT NULL,
  destination_id varchar,
  department_id varchar,
  responsibility varchar,
  actor_type varchar NOT NULL,
  actor_id varchar,
  source varchar NOT NULL,
  before_assignment jsonb,
  after_assignment jsonb,
  local_revision integer NOT NULL,
  vendor_revision varchar,
  outcome varchar NOT NULL,
  details jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cu_role_sync_evidence_receipt_dest_uniq
  ON cu_role_sync_transition_evidence (receipt_id, destination_id);
CREATE INDEX IF NOT EXISTS cu_role_sync_evidence_client_created_idx
  ON cu_role_sync_transition_evidence (client_id, created_at);
CREATE INDEX IF NOT EXISTS cu_role_sync_evidence_dest_created_idx
  ON cu_role_sync_transition_evidence (destination_id, created_at);