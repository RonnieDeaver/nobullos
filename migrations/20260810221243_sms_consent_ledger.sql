-- Task #4336: SMS consent ledger, consent events, and send-gate audit.
--
-- Compliance floor before any automated/marketing SMS exists: a durable
-- per-phone consent ledger (opted_in / opted_out / unknown with source +
-- evidence), an append-only event history (keyword receipts, manual operator
-- changes, Twilio 21610 carrier-block reconciliation, backfill), and an audit
-- log of every automated-send gate evaluation. Twilio's own opt-out block
-- list is per (recipient, our-number) pair and not bulk-readable via API;
-- Twilio documentation explicitly recommends keeping an application-side
-- ledger. See TWILIO.md "SMS consent & opt-out" for the division of labor.
--
-- sms_consent_events.message_sid carries a partial unique index so webhook
-- replays are a database-level no-op (belt-and-braces alongside the
-- application-level SID dedupe), mirroring twilio_msg_twilio_sid_uniq.
--
-- Idempotent throughout (the replay test applies twice).

CREATE TABLE IF NOT EXISTS sms_consent_ledger (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized varchar NOT NULL,
  phone_match_key varchar NOT NULL,
  state varchar NOT NULL DEFAULT 'unknown',
  source varchar NOT NULL,
  evidence text,
  timezone varchar,
  opted_in_at timestamp,
  opted_out_at timestamp,
  updated_by_user_id varchar REFERENCES users(id),
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_consent_ledger_phone_uniq
  ON sms_consent_ledger (phone_normalized);
CREATE INDEX IF NOT EXISTS sms_consent_ledger_match_key_idx
  ON sms_consent_ledger (phone_match_key);
CREATE INDEX IF NOT EXISTS sms_consent_ledger_updated_at_idx
  ON sms_consent_ledger (updated_at);

CREATE TABLE IF NOT EXISTS sms_consent_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized varchar NOT NULL,
  message_sid varchar,
  event_type varchar NOT NULL,
  keyword varchar,
  prior_state varchar,
  new_state varchar,
  source varchar NOT NULL,
  actor_user_id varchar REFERENCES users(id),
  detail text,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS sms_consent_events_phone_created_idx
  ON sms_consent_events (phone_normalized, created_at);
CREATE INDEX IF NOT EXISTS sms_consent_events_created_at_idx
  ON sms_consent_events (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS sms_consent_events_message_sid_uniq
  ON sms_consent_events (message_sid)
  WHERE message_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_send_gate_audit (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized varchar NOT NULL,
  purpose varchar NOT NULL,
  outcome varchar NOT NULL,
  consent_state varchar,
  detail text,
  requested_by_user_id varchar REFERENCES users(id),
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS sms_send_gate_audit_created_at_idx
  ON sms_send_gate_audit (created_at);
CREATE INDEX IF NOT EXISTS sms_send_gate_audit_phone_created_idx
  ON sms_send_gate_audit (phone_normalized, created_at);
