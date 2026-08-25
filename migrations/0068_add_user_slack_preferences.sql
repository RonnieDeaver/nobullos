-- Migration 0068 — Task #1687: Notifications epic Phase 2 (per-user Slack DM forwarding).
--
-- Two new tables:
--   * user_slack_identities — links a NoBull OS user to their Slack user id
--     (resolved via Slack `users.lookupByEmail`, see TASK #1687 notes).
--     `last_dm_status` / `last_dm_error` / `last_dm_at` are updated by the
--     sender service so the user-settings panel can surface a "Last Slack DM
--     failed — reconnect Slack" banner without scanning delivery rows.
--   * user_notification_preferences — per-(userId, category) opt-in matrix.
--     In-app defaults TRUE; Slack DM defaults FALSE. Lazy-backfill on first
--     read means an existing user gets the defaults applied automatically.
--
-- Independent from notification_settings / notification_deliveries (those
-- route admin watcher events to a Slack channel; this is per-user DMs).

CREATE TABLE IF NOT EXISTS user_slack_identities (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slack_user_id varchar NOT NULL,
  slack_team_id varchar,
  slack_email varchar,
  connected_at timestamp NOT NULL DEFAULT now(),
  disconnected_at timestamp,
  last_dm_status varchar,
  last_dm_error text,
  last_dm_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_slack_identities_user_idx
  ON user_slack_identities (user_id);

CREATE INDEX IF NOT EXISTS user_slack_identities_slack_user_idx
  ON user_slack_identities (slack_user_id);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category varchar NOT NULL,
  in_app_enabled boolean NOT NULL DEFAULT true,
  slack_dm_enabled boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_notification_prefs_user_category_uniq
  ON user_notification_preferences (user_id, category);
