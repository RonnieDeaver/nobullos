-- comms_link_previews: server-cached OpenGraph / Twitter-card unfurl results.
-- One row per canonical URL; cached_until drives re-fetch on expiry.
CREATE TABLE IF NOT EXISTS comms_link_previews (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  site_name TEXT,
  favicon_url TEXT,
  error TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cached_until TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS comms_link_previews_url_idx ON comms_link_previews(url);
CREATE INDEX IF NOT EXISTS comms_link_previews_cached_until_idx ON comms_link_previews(cached_until);

-- comms_attachments: thumbnail support.
-- thumbnail_key points to a resized/compressed version of image attachments.
-- NULL = same as objectKey (no separate thumbnail stored yet).
ALTER TABLE comms_attachments ADD COLUMN IF NOT EXISTS thumbnail_key VARCHAR(512);
