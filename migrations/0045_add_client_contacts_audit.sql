-- Migration 0045: client_contacts_audit shadow table
--
-- Records every insert/update/delete on client_contacts so the next
-- "an email I removed came back" report can be answered from the
-- audit trail directly (actor, before/after emails+phones, source,
-- reason) instead of cross-referencing user_activity_logs.
--
-- Companion to the optimistic-concurrency guard (`expected_updated_at`)
-- added to PUT /api/clients/:clientId/contacts/:id, which prevents a
-- stale form payload from overwriting a fresher delete.
--
-- Audit rows are written by the same transaction as the underlying
-- mutation in `server/storage/clientStorage.ts`, so an audit row exists
-- if and only if the row was actually changed.

BEGIN;

CREATE TABLE IF NOT EXISTS client_contacts_audit (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      varchar NOT NULL,
  client_id       varchar NOT NULL,
  action          varchar(16) NOT NULL,         -- insert | update | delete
  actor_user_id   varchar,                       -- nullable for system writes
  source          varchar(64),                   -- operator_ui | operator_promotion | trusted_domain_promotion | system | legacy_migration
  reason          text,                          -- free-form: e.g. "PUT /api/clients/.../contacts/...", "promoteEmailsToClientContact"
  old_name        text,
  new_name        text,
  old_role_title  text,
  new_role_title  text,
  old_is_primary  boolean,
  new_is_primary  boolean,
  old_emails      text[],
  new_emails      text[],
  old_phones      text[],
  new_phones      text[],
  created_at      timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_contacts_audit_contact_id_idx
  ON client_contacts_audit (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS client_contacts_audit_client_id_idx
  ON client_contacts_audit (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS client_contacts_audit_actor_idx
  ON client_contacts_audit (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMIT;
