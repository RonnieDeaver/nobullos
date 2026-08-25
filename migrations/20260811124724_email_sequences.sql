-- Task #4335 — Email templates and approval-gated sequences.
-- Additive only; idempotent (the replay seam re-applies migrations twice).
--
--   email_templates: merge-field template library (tokens validated at save).
--   email_sequences / email_sequence_steps: named fixed step lists (email
--     step + wait delay). Sequences are born 'paused'; auto_send_enabled is
--     the owner-gated escape hatch from the approval queue.
--   email_sequence_enrollments: one row per enrolled entity per run.
--     email_seq_enrollments_active_uq is the CONCURRENT-enrollment guard
--     (partial unique on status='active'); inserts go through
--     ON CONFLICT DO NOTHING.
--   email_sequence_step_sends: per-(enrollment, step) claim ledger + frozen
--     rendered content + approval state. email_seq_step_sends_enrollment_step_uq
--     is the double-send guard — replayed/retried jobs lose the insert and
--     no-op. Content frozen at draft time: what's approved is what sends.

CREATE TABLE IF NOT EXISTS email_templates (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  description text,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  archived boolean NOT NULL DEFAULT false,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_sequences (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  description text,
  status varchar(12) NOT NULL DEFAULT 'paused',
  auto_send_enabled boolean NOT NULL DEFAULT false,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_sequence_steps (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id varchar NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  template_id varchar NOT NULL REFERENCES email_templates(id),
  delay_minutes integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_seq_steps_sequence_order_uq
  ON email_sequence_steps (sequence_id, step_order);
CREATE INDEX IF NOT EXISTS email_seq_steps_template_id_idx
  ON email_sequence_steps (template_id);

CREATE TABLE IF NOT EXISTS email_sequence_enrollments (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id varchar NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  entity_type varchar(10) NOT NULL,
  entity_id varchar NOT NULL,
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  recipient_email varchar(320) NOT NULL,
  sender_user_id varchar NOT NULL REFERENCES users(id),
  status varchar(12) NOT NULL DEFAULT 'active',
  cancel_reason varchar(24),
  cancel_note text,
  current_step_order integer NOT NULL DEFAULT 0,
  next_step_at timestamp,
  lifecycle_stage_at_enrollment varchar(40),
  segment_id varchar REFERENCES segments(id) ON DELETE SET NULL,
  enrolled_by varchar REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamp,
  cancelled_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_seq_enrollments_active_uq
  ON email_sequence_enrollments (sequence_id, entity_type, entity_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS email_seq_enrollments_sequence_status_idx
  ON email_sequence_enrollments (sequence_id, status);
CREATE INDEX IF NOT EXISTS email_seq_enrollments_client_active_idx
  ON email_sequence_enrollments (client_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS email_seq_enrollments_email_active_idx
  ON email_sequence_enrollments (recipient_email)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS email_sequence_step_sends (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id varchar NOT NULL REFERENCES email_sequence_enrollments(id) ON DELETE CASCADE,
  sequence_id varchar NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_id varchar NOT NULL REFERENCES email_sequence_steps(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  template_id varchar REFERENCES email_templates(id) ON DELETE SET NULL,
  recipient_email varchar(320) NOT NULL,
  sender_user_id varchar NOT NULL REFERENCES users(id),
  rendered_subject text NOT NULL DEFAULT '',
  rendered_body_text text NOT NULL DEFAULT '',
  rendered_body_html text,
  missing_fields text[] DEFAULT '{}'::text[],
  status varchar(16) NOT NULL DEFAULT 'draft',
  error_message text,
  outbound_batch_id varchar,
  outbound_email_id varchar,
  auto_approved boolean NOT NULL DEFAULT false,
  approved_by varchar REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamp,
  rejected_by varchar REFERENCES users(id) ON DELETE SET NULL,
  rejected_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_seq_step_sends_enrollment_step_uq
  ON email_sequence_step_sends (enrollment_id, step_id);
CREATE INDEX IF NOT EXISTS email_seq_step_sends_status_idx
  ON email_sequence_step_sends (status);
CREATE INDEX IF NOT EXISTS email_seq_step_sends_enrollment_idx
  ON email_sequence_step_sends (enrollment_id);
CREATE INDEX IF NOT EXISTS email_seq_step_sends_sequence_step_idx
  ON email_sequence_step_sends (sequence_id, step_order);
