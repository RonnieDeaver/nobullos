-- Comms: server-synced drafts + scheduled messages.
-- All DDL is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- ─── comms_drafts ──────────────────────────────────────────────────────────────
-- Per-user, per-channel (optionally per-thread-root) draft storage.
-- Each user has at most one draft per (channel_id, COALESCE(parent_id, '')).
CREATE TABLE IF NOT EXISTS comms_drafts (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  parent_id   VARCHAR,
  content     TEXT NOT NULL DEFAULT '',
  metadata    JSONB,
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS comms_drafts_unique_idx
  ON comms_drafts (user_id, channel_id, COALESCE(parent_id, ''));
CREATE INDEX IF NOT EXISTS comms_drafts_user_id_idx ON comms_drafts(user_id);
CREATE INDEX IF NOT EXISTS comms_drafts_channel_id_idx ON comms_drafts(channel_id);

-- ─── comms_scheduled_messages ─────────────────────────────────────────────────
-- Scheduled posts: created by users, delivered by the worker queue at scheduled_for.
CREATE TABLE IF NOT EXISTS comms_scheduled_messages (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  parent_id     VARCHAR,
  content       TEXT NOT NULL,
  metadata      JSONB,
  scheduled_for TIMESTAMP NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  delivered_message_id VARCHAR,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_scheduled_messages_user_id_idx ON comms_scheduled_messages(user_id);
CREATE INDEX IF NOT EXISTS comms_scheduled_messages_channel_id_idx ON comms_scheduled_messages(channel_id);
CREATE INDEX IF NOT EXISTS comms_scheduled_messages_due_idx
  ON comms_scheduled_messages (status, scheduled_for)
  WHERE status = 'pending';
