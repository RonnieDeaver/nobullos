-- Task #5245 — durable canonical ClickUp Client List lifecycle mirror.
-- Additive, UTC, and idempotent. No vendor operation runs in this migration.

CREATE TABLE IF NOT EXISTS cu_client_mirror_commands (
  id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             varchar NOT NULL,
  desired_name          text NOT NULL,
  desired_archived      boolean NOT NULL DEFAULT false,
  merged_into_client_id varchar,
  revision              varchar(64) NOT NULL,
  status                varchar NOT NULL DEFAULT 'pending',
  attempt_count         integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 5,
  next_attempt_at       timestamp,
  lease_owner           varchar,
  lease_token           varchar,
  lease_expires_at      timestamp,
  last_error_code       varchar(64),
  last_error            text,
  terminal_at           timestamp,
  verified_at           timestamp,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cu_client_mirror_command_client_uniq
  ON cu_client_mirror_commands (client_id);
CREATE INDEX IF NOT EXISTS cu_client_mirror_command_drain_idx
  ON cu_client_mirror_commands (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS cu_client_mirror_command_lease_idx
  ON cu_client_mirror_commands (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

ALTER TABLE cu_client_list_mappings
  ADD COLUMN IF NOT EXISTS owned_name text;
ALTER TABLE cu_client_list_mappings
  ADD COLUMN IF NOT EXISTS owned_archived boolean;