-- Migration 0048: client_locations_audit shadow table
--
-- Mirrors migration 0045 (client_contacts_audit). Records every
-- insert/update/delete on client_locations so we can answer "who edited
-- this address / when did this location go inactive" from the audit
-- trail directly. Locations are now editable by any account manager
-- (Task #999), so per-row accountability matches the contacts pattern.
--
-- Audit rows are written by the same transaction as the underlying
-- mutation in `server/storage/clientStorage.ts`, so an audit row exists
-- if and only if the row was actually changed.

BEGIN;

CREATE TABLE IF NOT EXISTS client_locations_audit (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     varchar NOT NULL,
  client_id       varchar NOT NULL,
  action          varchar(16) NOT NULL,         -- insert | update | delete
  actor_user_id   varchar,                       -- nullable for system writes
  source          varchar(64),                   -- operator_ui | system | legacy_migration
  reason          text,
  old_name        text,
  new_name        text,
  old_address     text,
  new_address     text,
  old_city        text,
  new_city        text,
  old_state       text,
  new_state       text,
  old_lat         real,
  new_lat         real,
  old_lng         real,
  new_lng         real,
  old_is_active   boolean,
  new_is_active   boolean,
  created_at      timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_locations_audit_location_id_idx
  ON client_locations_audit (location_id, created_at DESC);

CREATE INDEX IF NOT EXISTS client_locations_audit_client_id_idx
  ON client_locations_audit (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS client_locations_audit_actor_idx
  ON client_locations_audit (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMIT;
