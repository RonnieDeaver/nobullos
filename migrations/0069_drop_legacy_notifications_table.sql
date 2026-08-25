-- Migration 0069 — Task #1718: Retire the legacy `notifications` table.
--
-- Stages B/C (Task #1713) migrated every server-side writer off this table;
-- Stage D (Task #1714) removed the Dashboard "Legacy notifications" panel
-- and the Match Settings legacy banner; Stage E (Task #1715) removed the
-- `/api/legacy-notifications` shim routes and `storage.createNotification`
-- / `storage.getNotifications`. Nothing reads or writes the table anymore
-- — all new events land in `user_notifications` (the per-user bell).
--
-- This Stage F migration drops the table and its index so the schema
-- matches the code. There is no rollback path: any rows that existed at
-- drop time were pre-Stage-B/C legacy data the new bell never indexed.

BEGIN;

DROP INDEX IF EXISTS notifications_user_id_idx;
DROP TABLE IF EXISTS notifications;

COMMIT;
