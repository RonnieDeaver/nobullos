-- Task #5156 — ClickUp Role Projection lane: durable schema migration.
--
-- Creates three tables:
--
--   cu_role_projection_destinations
--     Environment-scoped department+responsibility → ClickUp target config.
--     One row per (workspace_id, department_id, responsibility, environment).
--     Stores: target kind, list/field IDs, one-person contract, env class,
--     enabled flag, sandbox-exit + owner approval timestamps.
--
--   cu_role_projection_client_targets
--     Stable client→target evidence. One row per (client_id, destination_id).
--     Stores: exact ClickUp task/list ID, resolved owning-list ID, provenance JSON.
--
--   cu_role_projection_commands
--     Durable projection commands. One row per (client_id, destination_id).
--     Stores: desired NoBull user + CU user ID, revision, target snapshot,
--     status machine, bounded attempt counters, lease (owner/token/expiry),
--     observed People IDs, safe error, verified/drift/terminal timestamps.
--
-- Design rules:
--   - IF NOT EXISTS throughout — idempotent replay.
--   - No destructive changes.
--   - Timestamps WITHOUT timezone (UTC; matches codebase convention).
--   - Hot-predicate indexes for drain + lease expiry sweeper paths.
--   - No FK constraints (NoBull monolith convention).
--
-- Never edit applied migrations; add forward-fix migrations only.

-- ── cu_role_projection_destinations ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cu_role_projection_destinations (
  id                        varchar          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              varchar          NOT NULL,
  department_id             varchar          NOT NULL,
  -- "doer" | "checker" | "supervisor"
  responsibility            varchar          NOT NULL,
  -- "direct_task" | "client_list_parent"
  target_kind               varchar          NOT NULL,
  -- client_list_parent: owning list UUID for each client's task
  list_id                   varchar,
  -- direct_task (company-scope): the single ClickUp task ID carrying the People field
  target_id                 varchar,
  -- ClickUp People custom-field UUID
  people_field_id           varchar          NOT NULL,
  -- Maximum persons allowed in field (1 = one-person contract)
  max_people                integer          NOT NULL DEFAULT 1,
  -- "sandbox" | "production"
  environment               varchar          NOT NULL DEFAULT 'sandbox',
  enabled                   boolean          NOT NULL DEFAULT false,
  -- Sandbox-exit approval
  sandbox_exit_approved_at  timestamp,
  sandbox_exit_approved_by  varchar,
  -- Owner approval for production writes
  owner_approved_at         timestamp,
  owner_approved_by         varchar,
  created_at                timestamp        NOT NULL DEFAULT now(),
  updated_at                timestamp        NOT NULL DEFAULT now()
);

-- Reconcile an earlier task-local CREATE TABLE IF NOT EXISTS shape before
-- creating indexes or serving code that reads the final columns. This remains
-- a no-op on fresh databases and makes idempotent replay safe.
ALTER TABLE cu_role_projection_destinations
  ADD COLUMN IF NOT EXISTS target_id varchar;

CREATE UNIQUE INDEX IF NOT EXISTS cu_role_proj_dest_uniq
  ON cu_role_projection_destinations (workspace_id, department_id, responsibility, environment);

CREATE INDEX IF NOT EXISTS cu_role_proj_dest_dept_idx
  ON cu_role_projection_destinations (department_id);

CREATE INDEX IF NOT EXISTS cu_role_proj_dest_workspace_idx
  ON cu_role_projection_destinations (workspace_id);

CREATE INDEX IF NOT EXISTS cu_role_proj_dest_enabled_env_idx
  ON cu_role_projection_destinations (enabled, environment);

-- ── cu_role_projection_client_targets ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cu_role_projection_client_targets (
  id                varchar    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         varchar    NOT NULL,
  destination_id    varchar    NOT NULL,
  -- Exact ClickUp task ID or list ID for this client
  target_id         varchar    NOT NULL,
  -- Resolved owning list ID from GET /task/:id (proves task is in expected list)
  resolved_list_id  varchar,
  -- Provenance / duplicate detection JSON blob
  provenance        jsonb,
  -- Set only after a live GET immediately before a mutation proved ownership.
  ownership_verified_at timestamp,
  created_at        timestamp  NOT NULL DEFAULT now(),
  updated_at        timestamp  NOT NULL DEFAULT now()
);

ALTER TABLE cu_role_projection_client_targets
  ADD COLUMN IF NOT EXISTS ownership_verified_at timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS cu_role_proj_client_target_uniq
  ON cu_role_projection_client_targets (client_id, destination_id);

CREATE INDEX IF NOT EXISTS cu_role_proj_client_target_client_idx
  ON cu_role_projection_client_targets (client_id);

CREATE INDEX IF NOT EXISTS cu_role_proj_client_target_dest_idx
  ON cu_role_projection_client_targets (destination_id);

CREATE INDEX IF NOT EXISTS cu_role_proj_client_target_target_idx
  ON cu_role_projection_client_targets (target_id);

-- ── cu_role_projection_commands ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cu_role_projection_commands (
  id                        varchar    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                 varchar    NOT NULL,
  destination_id            varchar    NOT NULL,
  -- Desired NoBull user ID (null = clear the People field)
  desired_user_id           varchar,
  -- Desired ClickUp user ID (null = clear/unassign)
  desired_clickup_user_id   varchar,
  -- Deterministic revision token for idempotency
  revision                  varchar    NOT NULL,
  -- Snapshot of the target entity at staging time (JSON)
  target_snapshot           jsonb,
  -- Status: pending | ambiguous | synced | failed | blocked | drift | disabled
  status                    varchar    NOT NULL DEFAULT 'pending',
  -- Total mutation attempts (genuine vendor calls)
  attempt_count             integer    NOT NULL DEFAULT 0,
  -- Maximum attempts before terminal failure
  max_attempts              integer    NOT NULL DEFAULT 5,
  -- All attempted writes (including ambiguous)
  mutation_attempts         integer    NOT NULL DEFAULT 0,
  -- Earliest eligible time for next attempt (null = immediately eligible)
  next_attempt_at           timestamp,
  -- Lease ownership
  lease_owner               varchar,
  lease_token               varchar,
  lease_expires_at          timestamp,
  -- Last observed ClickUp People field user IDs (JSON array of strings)
  observed_clickup_user_ids jsonb,
  -- Safe sanitized error from last attempt
  last_error                text,
  -- Canonical error code from last attempt (missing_identity, missing_target,
  -- list_mismatch, invalid_field, invalid_cardinality, auth, rate_limited,
  -- timeout, vendor_5xx, exhausted)
  last_error_code           varchar,
  -- State timestamps
  verified_at               timestamp,
  drift_detected_at         timestamp,
  terminal_at               timestamp,
  created_at                timestamp  NOT NULL DEFAULT now(),
  updated_at                timestamp  NOT NULL DEFAULT now()
);

ALTER TABLE cu_role_projection_commands
  ADD COLUMN IF NOT EXISTS last_error_code varchar;

CREATE UNIQUE INDEX IF NOT EXISTS cu_role_proj_cmd_uniq
  ON cu_role_projection_commands (client_id, destination_id);

-- Hot drain predicate: status=pending, next_attempt_at <= now
CREATE INDEX IF NOT EXISTS cu_role_proj_cmd_status_next_idx
  ON cu_role_projection_commands (status, next_attempt_at);

-- Lease expiry sweeper
CREATE INDEX IF NOT EXISTS cu_role_proj_cmd_lease_expires_idx
  ON cu_role_projection_commands (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS cu_role_proj_cmd_client_idx
  ON cu_role_projection_commands (client_id);

CREATE INDEX IF NOT EXISTS cu_role_proj_cmd_dest_idx
  ON cu_role_projection_commands (destination_id);

-- Fast "find by error code" for the admin status panel.
CREATE INDEX IF NOT EXISTS cu_role_proj_cmd_error_code_idx
  ON cu_role_projection_commands (last_error_code)
  WHERE last_error_code IS NOT NULL;
