-- Task #1716 — Notifications Stage G
--
-- Drop the legacy `notifications` table. After Stage E+F, no runtime
-- code reads or writes this table; the per-user inbox uses
-- `user_notifications` and `notifyUser()` exclusively.
--
-- CASCADE picks up any orphan foreign key / index / trigger that may
-- still reference the table on older databases.
--
-- Idempotent so the dev migration runner and post-merge.sh can apply
-- it safely on environments where the table has already been removed.

DROP TABLE IF EXISTS notifications CASCADE;
