-- Comms: per-user global notification settings + keyword watch list.
-- All DDL is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- ─── comms_user_notification_settings ──────────────────────────────────────────
-- One row per user; created on first save, absent = all defaults.
-- global_default: fallback when no per-channel pref is set
--   "all"      → all messages trigger desktop/sound (default)
--   "mentions" → only @mentions + keyword hits trigger desktop/sound
--   "nothing"  → suppress desktop notifications (badge still appears)
-- keywords: JSON array of strings matched with word-boundary (case-insensitive)
CREATE TABLE IF NOT EXISTS comms_user_notification_settings (
  user_id                  VARCHAR PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  global_default           VARCHAR(16)  NOT NULL DEFAULT 'all',
  sound_enabled            BOOLEAN      NOT NULL DEFAULT TRUE,
  sound_choice             VARCHAR(32)  NOT NULL DEFAULT 'default',
  desktop_enabled          BOOLEAN      NOT NULL DEFAULT FALSE,
  suppress_snippet_private BOOLEAN      NOT NULL DEFAULT FALSE,
  keywords                 JSONB        NOT NULL DEFAULT '[]'::jsonb,
  updated_at               TIMESTAMP    NOT NULL DEFAULT NOW()
);
