-- Migration 0085 — re-add the user_notifications unread-dedupe partial
-- UNIQUE index that was disabled 2026-05-26 (see migration 0067 and
-- shared/models/notifications.ts). The app layer already expects it:
-- notifyUser()'s 23505/race fallback in
-- server/services/notifications/userInbox.ts is written for this index.
-- Re-adding it restores the DB-level guarantee that a duplicate UNREAD
-- notification for the same (user_id, dedupe_key) can never be created,
-- not even under a race the in-query dedupe misses.
--
-- PROD PUBLISH SEQUENCE (important): the pre-cleanup DELETE below does
-- NOT run during a Replit Publish — only the diffed CREATE UNIQUE INDEX
-- does. So before publishing, run the `dedupe_user_notifications_unread`
-- prod-action (its self-heal also keeps prod near-zero). Replit then
-- introspects this dev DB (which now carries the index) and creates it
-- on the already-deduped prod table, so the CREATE succeeds instead of
-- blocking the deploy on legacy duplicate rows.
--
-- This migration's DELETE+CREATE is the dev / workspace path (applied by
-- the post-merge psql step) and is fully idempotent: the DELETE is a
-- no-op when no duplicates remain, and CREATE ... IF NOT EXISTS is safe
-- to re-run.
--
-- ============================================================================
-- TWO-PHASE PUBLISH ROLLOUT (PHASE 2 — index re-enabled)
-- ----------------------------------------------------------------------------
-- The `dedupe_user_notifications_unread` prod-action that this index relies on
-- for its pre-publish cleanup was NOT yet live on production, so the very first
-- publish that tried to build this index failed: prod still held ~668 legacy
-- duplicate UNREAD rows and the CREATE UNIQUE INDEX could not be applied.
--
-- Because that cleanup button only goes live *as part of* a successful publish,
-- it could never run before the index build — a chicken-and-egg. We broke it in
-- two phases:
--
--   PHASE 1 (done): the CREATE UNIQUE INDEX below was commented out and the
--     index dropped from the dev DB, so the dev↔prod schema diff carried NO
--     index and the publish succeeded. That shipped the dedupe prod-action
--     button and the app-level (window-less) in-query dedupe that already
--     prevents new duplicates from forming.
--   PHASE 2 (current): prod has now been deduped via the now-live
--     `dedupe_user_notifications_unread` button (verified 0 duplicate UNREAD
--     groups), so the CREATE UNIQUE INDEX below is re-enabled and re-applied to
--     dev. The next publish builds it on the already-clean prod table, which
--     restores the DB-level guarantee.
-- ============================================================================
BEGIN;

-- Block concurrent writers for the duration of the dedupe + index build
-- so a concurrent insert can't slip a fresh duplicate in between the
-- DELETE and the CREATE UNIQUE INDEX. SHARE ROW EXCLUSIVE conflicts with
-- INSERT/UPDATE/DELETE but still allows concurrent SELECTs.
LOCK TABLE user_notifications IN SHARE ROW EXCLUSIVE MODE;

-- Collapse any pre-existing duplicate UNREAD rows per (user_id,
-- dedupe_key) down to the newest, so the unique index can be built.
DELETE FROM user_notifications u
USING (
  SELECT id FROM (
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

-- One UNREAD row per (user_id, dedupe_key) when a dedupe_key is set.
-- Read/archived rows fall out of the partial predicate so a later
-- dispatch with the same key can still produce a fresh notification.
--
-- PHASE 2: index creation re-enabled (see TWO-PHASE PUBLISH ROLLOUT above)
-- now that prod has been deduped via the now-live
-- `dedupe_user_notifications_unread` prod-action.
CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_user_dedupe_unread_uniq
  ON user_notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND read_at IS NULL AND archived_at IS NULL;

COMMIT;
