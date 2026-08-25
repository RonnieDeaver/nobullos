-- Comms parity 8/15: edit history + message reminders
-- comms_message_edit_history stores a snapshot of prior content before each edit.
-- comms_message_reminders stores per-user remind-me records with scheduled delivery.

CREATE TABLE IF NOT EXISTS comms_message_edit_history (
  id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  editor_id    VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  prior_content TEXT NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_msg_edit_history_msg_idx
  ON comms_message_edit_history (message_id);

CREATE INDEX IF NOT EXISTS comms_msg_edit_history_editor_idx
  ON comms_message_edit_history (editor_id);

-- reminder status: pending | delivered | cancelled
CREATE TABLE IF NOT EXISTS comms_message_reminders (
  id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  channel_id   VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  note         TEXT,
  remind_at    TIMESTAMP NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_reminders_user_idx
  ON comms_message_reminders (user_id);

CREATE INDEX IF NOT EXISTS comms_reminders_due_idx
  ON comms_message_reminders (status, remind_at);

CREATE INDEX IF NOT EXISTS comms_reminders_message_idx
  ON comms_message_reminders (message_id);
