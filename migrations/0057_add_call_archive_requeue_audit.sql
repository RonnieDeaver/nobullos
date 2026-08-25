-- Migration 0057: call_archive_requeue_audit table (Task #1086).
--
-- Records every call-archive re-queue action triggered from the admin
-- UI. Both the per-row endpoint (Task #1052) and the bulk endpoint
-- (Task #1082) previously only logged to console; this table gives
-- admins an in-app history surfaced on /admin/twilio/call-archive
-- without grepping server logs.

BEGIN;

CREATE TABLE IF NOT EXISTS call_archive_requeue_audit (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         varchar REFERENCES users(id),
  mode            varchar(32) NOT NULL,    -- single | bulk_failed | bulk_stuck
  target_call_id  varchar,                 -- twilio_calls.id for mode='single'
  affected_count  integer NOT NULL DEFAULT 0,
  note            text,
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_archive_requeue_audit_created_at_idx
  ON call_archive_requeue_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS call_archive_requeue_audit_user_id_idx
  ON call_archive_requeue_audit (user_id);

COMMIT;
