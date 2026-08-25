-- Migration 0067 — Task #1686: Notifications epic Phase 1 (in-app inbox foundation).
--
-- Per-user notification primitive. Notifications are written by the
-- `notifyUser()` helper (server/services/notifications/userInbox.ts) and
-- consumed by the bell + dropdown in GlobalAppNav and the /notifications
-- inbox page. They are independent of the Slack-channel notification
-- system in notification_settings/notification_deliveries (those tables
-- are a separate concept — admin-routed watchers, not per-user inbox).
--
-- Dedupe: when a caller supplies `dedupe_key`, the helper looks for an
-- existing UNREAD row with the same (user_id, dedupe_key) created within
-- the last hour and returns it instead of inserting a duplicate. The
-- partial unique index below enforces this at the DB level too.

CREATE TABLE IF NOT EXISTS user_notifications (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category varchar NOT NULL,
  title text NOT NULL,
  body text,
  deep_link text,
  metadata jsonb,
  dedupe_key varchar,
  read_at timestamp,
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx
  ON user_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_notifications_user_unread_idx
  ON user_notifications (user_id, read_at)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS user_notifications_user_archived_idx
  ON user_notifications (user_id, archived_at);

CREATE INDEX IF NOT EXISTS user_notifications_user_category_idx
  ON user_notifications (user_id, category);

-- Dedupe lookup: one unread row per (user_id, dedupe_key) when a
-- dedupe_key is set. Read/archived rows fall out of the index so a
-- subsequent dispatch with the same key can produce a fresh row.
--
-- Idempotent backfill: legacy callers (notably the zoom-review backlog
-- alerter, pre-Task #1707 Stage B+C) wrote multiple unread rows for
-- the same (user_id, dedupe_key). Those rows would block the unique
-- index from being created on databases that already received them.
-- Before creating the index, collapse such duplicates to the newest
-- row per key. This is safe to run repeatedly: if no duplicates
-- remain (e.g. on a fresh prod DB), the DELETE is a no-op.
BEGIN;

-- Block concurrent writers for the duration of the dedupe + index
-- build so a concurrent insert can't slip a fresh duplicate in
-- between DELETE and CREATE UNIQUE INDEX. SHARE ROW EXCLUSIVE
-- conflicts with INSERT/UPDATE/DELETE but allows concurrent SELECTs.
LOCK TABLE user_notifications IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM user_notifications u
USING (
  SELECT id
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY user_id, dedupe_key
             ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM user_notifications
    WHERE dedupe_key IS NOT NULL
      AND read_at IS NULL
      AND archived_at IS NULL
  ) ranked
  WHERE ranked.rn > 1
) dups
WHERE u.id = dups.id;

-- 2026-05-26: The partial UNIQUE index below was intentionally disabled
-- because Replit Publish diffs introspected dev → prod and tried to
-- create it on a prod table that already had legacy duplicate unread
-- rows, blocking every deploy. The pre-cleanup DELETE above does NOT
-- run during Publish (only the diffed DDL does), so the index could
-- never be built on prod.
--
-- It was RE-ADDED in migration 0085
-- (0085_readd_user_notifications_dedupe_unique_index.sql) following the
-- documented sequence: run the `dedupe_user_notifications_unread`
-- prod-action so prod has no dupes, then let a fresh Publish create the
-- index off the introspected dev DB. See 0085 and
-- shared/models/notifications.ts for the full sequence. The index def
-- (now live) is:
--
-- CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_user_dedupe_unread_uniq
--   ON user_notifications (user_id, dedupe_key)
--   WHERE dedupe_key IS NOT NULL AND read_at IS NULL AND archived_at IS NULL;

COMMIT;
