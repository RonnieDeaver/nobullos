-- Comms daily-driver feature gaps: attachments, notification prefs, pins, saved messages, FTS.
-- All DDL is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- ─── comms_attachments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_attachments (
  id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  uploaded_by    VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  object_key     VARCHAR(512) NOT NULL,
  filename       VARCHAR(512) NOT NULL,
  content_type   VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes     INTEGER,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comms_attachments_message_id_idx ON comms_attachments(message_id);
CREATE INDEX IF NOT EXISTS comms_attachments_uploaded_by_idx ON comms_attachments(uploaded_by);

-- ─── comms_notification_prefs ─────────────────────────────────────────────────
-- pref: 'all' (default), 'mentions', 'muted'
CREATE TABLE IF NOT EXISTS comms_notification_prefs (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  user_id     VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref        VARCHAR(16) NOT NULL DEFAULT 'all',
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS comms_notification_prefs_channel_id_idx ON comms_notification_prefs(channel_id);
CREATE INDEX IF NOT EXISTS comms_notification_prefs_user_id_idx ON comms_notification_prefs(user_id);

-- ─── comms_pinned_messages ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_pinned_messages (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  message_id  VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  pinned_by   VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS comms_pinned_messages_channel_id_idx ON comms_pinned_messages(channel_id);

-- ─── comms_saved_messages ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comms_saved_messages (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS comms_saved_messages_user_id_idx ON comms_saved_messages(user_id);

-- ─── FTS index on comms_messages.content ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS comms_messages_content_fts_idx
  ON comms_messages USING GIN (to_tsvector('english', content));
