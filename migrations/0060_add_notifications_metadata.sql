-- Migration 0060: add metadata jsonb column to notifications (Task #1134).
--
-- Lets notification producers attach structured payload data alongside the
-- free-text message. First user is `match_settings_change` notifications,
-- which now stamp `{ actorId, actorName, actorEmail }` so the
-- `banner-recent-changes` UI on /admin/match-settings can render
-- "by <Author>" without parsing English copy out of `message`.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMIT;
