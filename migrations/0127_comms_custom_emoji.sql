-- comms_custom_emoji: team-wide custom emoji managed via /api/comms/emoji.
-- Images live in private object storage and are served through an authenticated
-- route (/api/comms/emoji/:id/image) with immutable cache headers.
-- name is unique, lower-kebab-or-snake, 2–64 chars [a-zA-Z0-9_-].
CREATE TABLE IF NOT EXISTS comms_custom_emoji (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(64) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  content_type VARCHAR(64) NOT NULL DEFAULT 'image/png',
  size_bytes INTEGER,
  created_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS comms_custom_emoji_name_idx ON comms_custom_emoji(name);
CREATE INDEX IF NOT EXISTS comms_custom_emoji_created_by_idx ON comms_custom_emoji(created_by);

-- comms_emoji_usage: per-user emoji usage counts for "frequently used" row.
-- emoji stores the raw emoji character or ":name:" for custom emoji.
-- ON CONFLICT (user_id, emoji): increment use_count + refresh last_used_at.
CREATE TABLE IF NOT EXISTS comms_emoji_usage (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(64) NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS comms_emoji_usage_unique ON comms_emoji_usage(user_id, emoji);
CREATE INDEX IF NOT EXISTS comms_emoji_usage_user_idx ON comms_emoji_usage(user_id);
CREATE INDEX IF NOT EXISTS comms_emoji_usage_last_used_idx ON comms_emoji_usage(user_id, last_used_at);
