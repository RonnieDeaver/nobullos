-- NoBull Comms: built-in Slack replacement
-- Channels, messages, reactions, read states, calls, client tags

CREATE TABLE IF NOT EXISTS comms_channels (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80),
  slug VARCHAR(80),
  type VARCHAR(16) NOT NULL DEFAULT 'channel',
  visibility VARCHAR(16) NOT NULL DEFAULT 'public',
  topic TEXT,
  description TEXT,
  client_id VARCHAR REFERENCES clients(id) ON DELETE SET NULL,
  created_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  archived_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_channels_slug_idx ON comms_channels(slug);
CREATE INDEX IF NOT EXISTS comms_channels_client_id_idx ON comms_channels(client_id);
CREATE INDEX IF NOT EXISTS comms_channels_type_idx ON comms_channels(type);

CREATE TABLE IF NOT EXISTS comms_channel_members (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL DEFAULT 'member',
  muted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT comms_channel_members_unique UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS comms_channel_members_channel_id_idx ON comms_channel_members(channel_id);
CREATE INDEX IF NOT EXISTS comms_channel_members_user_id_idx ON comms_channel_members(user_id);

CREATE TABLE IF NOT EXISTS comms_messages (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  parent_id VARCHAR,
  content TEXT NOT NULL DEFAULT '',
  content_type VARCHAR(16) NOT NULL DEFAULT 'text',
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_messages_channel_id_idx ON comms_messages(channel_id);
CREATE INDEX IF NOT EXISTS comms_messages_channel_created_idx ON comms_messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS comms_messages_parent_id_idx ON comms_messages(parent_id);
CREATE INDEX IF NOT EXISTS comms_messages_user_id_idx ON comms_messages(user_id);

CREATE TABLE IF NOT EXISTS comms_reactions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT comms_reactions_unique UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS comms_reactions_message_id_idx ON comms_reactions(message_id);

CREATE TABLE IF NOT EXISTS comms_read_states (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id VARCHAR,
  last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT comms_read_states_unique UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS comms_read_states_channel_id_idx ON comms_read_states(channel_id);
CREATE INDEX IF NOT EXISTS comms_read_states_user_id_idx ON comms_read_states(user_id);

CREATE TABLE IF NOT EXISTS comms_calls (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  initiated_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  livekit_room_name VARCHAR(256),
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  participants_json JSONB,
  system_message_id VARCHAR,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP,
  duration_seconds INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_calls_channel_id_idx ON comms_calls(channel_id);
CREATE INDEX IF NOT EXISTS comms_calls_status_idx ON comms_calls(status);

CREATE TABLE IF NOT EXISTS comms_message_client_tags (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id VARCHAR NOT NULL REFERENCES comms_messages(id) ON DELETE CASCADE,
  client_id VARCHAR NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_method VARCHAR(32) NOT NULL DEFAULT 'mention',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT comms_message_client_tags_unique UNIQUE(message_id, client_id)
);

CREATE INDEX IF NOT EXISTS comms_message_client_tags_message_idx ON comms_message_client_tags(message_id);
CREATE INDEX IF NOT EXISTS comms_message_client_tags_client_idx ON comms_message_client_tags(client_id);
