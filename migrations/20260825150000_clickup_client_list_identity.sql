-- Canonical ClickUp Client List identity and reviewed role-field metadata.
-- Additive and idempotent: no existing role-projection data is rewritten.

ALTER TABLE cu_role_projection_destinations
  ADD COLUMN IF NOT EXISTS people_field_label varchar(255);

ALTER TABLE cu_role_projection_destinations
  ADD COLUMN IF NOT EXISTS people_field_type varchar(64);

CREATE TABLE IF NOT EXISTS cu_client_list_mappings (
  id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             varchar NOT NULL,
  list_id               varchar NOT NULL,
  task_id               varchar NOT NULL,
  remote_task_name      text,
  remote_revision       varchar(255),
  provenance            jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_state            varchar NOT NULL DEFAULT 'pending_review',
  conflict_evidence     jsonb,
  ownership_verified_at timestamp NOT NULL,
  last_error            text,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cu_client_list_mapping_client_uniq
  ON cu_client_list_mappings (client_id);

CREATE UNIQUE INDEX IF NOT EXISTS cu_client_list_mapping_task_uniq
  ON cu_client_list_mappings (list_id, task_id);

CREATE INDEX IF NOT EXISTS cu_client_list_mapping_task_idx
  ON cu_client_list_mappings (task_id);

CREATE INDEX IF NOT EXISTS cu_client_list_mapping_list_idx
  ON cu_client_list_mappings (list_id);

CREATE INDEX IF NOT EXISTS cu_client_list_mapping_state_updated_idx
  ON cu_client_list_mappings (sync_state, updated_at);