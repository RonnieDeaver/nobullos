-- Channel bookmarks bar for NoBull Comms (task 11/15)
-- Members can add; channel_admin / team_lead can edit, delete, and reorder.
CREATE TABLE comms_bookmarks (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  type VARCHAR(16) NOT NULL DEFAULT 'link',
  label VARCHAR(200) NOT NULL,
  emoji VARCHAR(64),
  url TEXT,
  attachment_id VARCHAR REFERENCES comms_attachments(id) ON DELETE SET NULL,
  object_key VARCHAR(512),
  filename VARCHAR(512),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX comms_bookmarks_channel_id_idx ON comms_bookmarks(channel_id);
CREATE INDEX comms_bookmarks_channel_order_idx ON comms_bookmarks(channel_id, sort_order);
CREATE INDEX comms_bookmarks_created_by_idx ON comms_bookmarks(created_by);
