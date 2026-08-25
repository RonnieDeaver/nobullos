-- Comms: thread following & thread inbox.
-- comms_thread_members tracks which users follow which threads,
-- plus per-user last-read-reply pointers and unread/mention counters.

CREATE TABLE IF NOT EXISTS comms_thread_members (
  id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  root_message_id VARCHAR NOT NULL,
  channel_id      VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  user_id         VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following       BOOLEAN NOT NULL DEFAULT true,
  last_read_reply_at TIMESTAMP NOT NULL DEFAULT to_timestamp(0),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS comms_thread_members_unique
  ON comms_thread_members (root_message_id, user_id);

CREATE INDEX IF NOT EXISTS comms_thread_members_user_id_idx
  ON comms_thread_members (user_id);

CREATE INDEX IF NOT EXISTS comms_thread_members_root_message_id_idx
  ON comms_thread_members (root_message_id);

CREATE INDEX IF NOT EXISTS comms_thread_members_channel_id_idx
  ON comms_thread_members (channel_id);
