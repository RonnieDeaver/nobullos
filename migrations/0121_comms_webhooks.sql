-- Incoming webhooks for NoBull Comms (task 14/15)
-- Tokens are stored as SHA-256 hex hashes; the raw token is returned once at creation time only.
CREATE TABLE comms_webhooks (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL DEFAULT 'Incoming Webhook',
  token_hash VARCHAR(64) NOT NULL,
  created_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX comms_webhooks_token_hash_idx ON comms_webhooks(token_hash);
CREATE INDEX comms_webhooks_channel_id_idx ON comms_webhooks(channel_id);
CREATE INDEX comms_webhooks_created_by_idx ON comms_webhooks(created_by);
