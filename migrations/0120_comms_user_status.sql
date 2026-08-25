-- Comms user status: manual status, DND with expiry, custom status, auto-away anchor.
-- All DDL is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS comms_user_statuses (
  user_id              VARCHAR PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  manual_status        VARCHAR(16),
  dnd_expires_at       TIMESTAMP,
  prior_status         VARCHAR(16),
  custom_emoji         VARCHAR(64),
  custom_text          VARCHAR(100),
  custom_expires_at    TIMESTAMP,
  recent_custom_statuses JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_activity_at     TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comms_user_statuses_updated_at_idx ON comms_user_statuses(updated_at);
