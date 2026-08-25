-- Per-user sidebar categories and ordered channel membership (comms parity 6/15)
-- Models Mattermost's sidebar-categories API: favorites, channels, dms built-in types
-- plus unlimited custom categories; channel ordering is per-category manual position.
-- Tasks #3405/#3417: IF NOT EXISTS guards added so the dev-migration reconciler
-- (reconcileLedgerAgainstSchema) can safely auto-requeue/re-run this file if the
-- ledger and live schema ever drift again (comms_sidebar_categories_user_type_idx
-- once went missing while the ledger said this file was applied, blocking startup).
CREATE TABLE IF NOT EXISTS comms_sidebar_categories (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'custom',
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  sorting VARCHAR(16) NOT NULL DEFAULT 'recent',
  unreads_on_top BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_sidebar_categories_user_id_idx ON comms_sidebar_categories(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS comms_sidebar_categories_user_type_idx
  ON comms_sidebar_categories(user_id, type)
  WHERE type IN ('favorites', 'channels', 'dms');

CREATE TABLE IF NOT EXISTS comms_sidebar_category_items (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id VARCHAR NOT NULL REFERENCES comms_sidebar_categories(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id VARCHAR NOT NULL REFERENCES comms_channels(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(category_id, channel_id)
);

CREATE INDEX IF NOT EXISTS comms_sidebar_category_items_category_id_idx ON comms_sidebar_category_items(category_id);
CREATE INDEX IF NOT EXISTS comms_sidebar_category_items_user_id_idx ON comms_sidebar_category_items(user_id);
CREATE INDEX IF NOT EXISTS comms_sidebar_category_items_channel_id_idx ON comms_sidebar_category_items(channel_id);
