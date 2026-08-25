-- Task #4334: outbound client-facing email — one send seam with
-- mailbox-first routing (Front channel per user) and an owner-gated
-- SendGrid overflow fallback (ships disabled).
--
-- Three additive tables (see shared/models/outboundEmail.ts for column
-- semantics):
--   email_suppressions:    global do-not-send list, enforced on every path.
--   user_email_identities: user → own-mailbox Front channel mapping.
--   outbound_emails:       per-recipient send log + idempotency/claim ledger.
--
-- Purely additive and idempotent (replay test applies every migration twice).
-- No data INSERTs here — the suppression seed from historical website
-- unsubscribe inquiries is a lazy runtime ensure (migration INSERTs never
-- reach prod; Publish diff is structure-only).

CREATE TABLE IF NOT EXISTS email_suppressions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  reason varchar(20) NOT NULL,
  source varchar(40) NOT NULL,
  notes text,
  created_by varchar REFERENCES users(id),
  last_event_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_email_uq
  ON email_suppressions (email);
CREATE INDEX IF NOT EXISTS email_suppressions_created_at_idx
  ON email_suppressions (created_at);

CREATE TABLE IF NOT EXISTS user_email_identities (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  front_channel_id varchar NOT NULL,
  from_email text NOT NULL,
  daily_cap integer,
  active boolean NOT NULL DEFAULT true,
  updated_by varchar REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_identities_user_id_uq
  ON user_email_identities (user_id);

CREATE TABLE IF NOT EXISTS outbound_emails (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id varchar NOT NULL,
  sender_user_id varchar NOT NULL REFERENCES users(id),
  client_id varchar REFERENCES clients(id),
  to_email text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  message_class varchar(20) NOT NULL DEFAULT 'transactional',
  consent_source varchar(40) NOT NULL DEFAULT 'manual_compose',
  status varchar(24) NOT NULL DEFAULT 'queued',
  path varchar(16),
  front_channel_id varchar,
  front_message_id varchar,
  sendgrid_message_id varchar,
  delivery_status varchar(20),
  dispatch_claim_token varchar,
  dispatch_claimed_at timestamp,
  cap_window_day varchar(10),
  error_code varchar,
  error_message text,
  unsubscribe_token varchar,
  deferred_count integer NOT NULL DEFAULT 0,
  scheduled_for timestamp,
  sent_at timestamp,
  created_by varchar NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_emails_batch_id_idx
  ON outbound_emails (batch_id);
CREATE INDEX IF NOT EXISTS outbound_emails_created_at_idx
  ON outbound_emails (created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_emails_to_email_idx
  ON outbound_emails (to_email);
CREATE INDEX IF NOT EXISTS outbound_emails_cap_count_idx
  ON outbound_emails (sender_user_id, cap_window_day)
  WHERE path = 'front_channel' AND status IN ('sending', 'sent', 'unknown');
CREATE INDEX IF NOT EXISTS outbound_emails_status_scheduled_idx
  ON outbound_emails (status, scheduled_for);
CREATE INDEX IF NOT EXISTS outbound_emails_sendgrid_message_id_idx
  ON outbound_emails (sendgrid_message_id)
  WHERE sendgrid_message_id IS NOT NULL;
