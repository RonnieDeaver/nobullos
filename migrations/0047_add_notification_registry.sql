-- Migration 0047 — Task #994: Slack Notifications Console & Notification Registry.
--
-- Adds the central notification settings + delivery history tables that back
-- the new admin console at /admin/slack/notifications. Existing legacy
-- setting keys (e.g. `rate_limit_alert_slack_channel_id`,
-- `match_settings_alert_slack_channel_id`, `zoom_review_alert_slack_channel`,
-- `health.digest.channel`) remain in `system_settings` until verified in
-- production — see notificationSettingsResolver for the precedence rules.

CREATE TABLE IF NOT EXISTS "notification_settings" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "notification_id" varchar NOT NULL UNIQUE,
  "enabled" boolean NOT NULL DEFAULT true,
  "channel_id" varchar,
  "channel_name" varchar,
  "updated_by" varchar REFERENCES "users"("id"),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "source" varchar NOT NULL DEFAULT 'default',
  "metadata_json" jsonb
);
CREATE INDEX IF NOT EXISTS "notification_settings_notif_idx"
  ON "notification_settings" ("notification_id");

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "notification_id" varchar NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "channel_id" varchar,
  "channel_name" varchar,
  "status" varchar NOT NULL,
  "error_message" text,
  "error_code" varchar,
  "slack_ts" varchar,
  "payload_preview" text,
  "trigger_source" varchar,
  "trigger_actor_id" varchar,
  "dedupe_key" varchar,
  "metadata_json" jsonb
);
CREATE INDEX IF NOT EXISTS "notif_deliveries_notif_created_idx"
  ON "notification_deliveries" ("notification_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "notif_deliveries_created_idx"
  ON "notification_deliveries" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "notif_deliveries_status_created_idx"
  ON "notification_deliveries" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "notif_deliveries_dedupe_key_idx"
  ON "notification_deliveries" ("dedupe_key");

CREATE TABLE IF NOT EXISTS "notification_health_state" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "notification_id" varchar NOT NULL,
  "dedupe_key" varchar NOT NULL,
  "state" varchar NOT NULL,
  "failure_type" varchar,
  "transitioned_at" timestamp NOT NULL DEFAULT now(),
  "last_notified_at" timestamp,
  "occurrence_count" jsonb,
  "metadata_json" jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_health_state_notif_key_uniq"
  ON "notification_health_state" ("notification_id", "dedupe_key");
