-- Task #4391: drop the three dead legacy tables flagged by the data-ownership
-- review (task #4338): conversations + messages (shared/models/chat.ts) and
-- intake_stats (shared/models/reports.ts).
-- Evidence (audits/legacy-chat-intake-stats-drop-2026-08-11.md):
--   * zero server/client/script/test references to the drizzle symbols or
--     their zod schemas repo-wide (only the model definitions themselves);
--   * no routes ever touched them, so no route-metrics window applies;
--   * 0 rows in BOTH dev and prod (max(created_at) NULL) — no data loss.
-- destructive-approved: Task #4391 is the owner-approved L3 vehicle for this
-- drop; all three tables are empty in dev and prod with no code consumers;
-- DROP IF EXISTS is idempotent and lock-safe (tables are never queried).
-- messages first (FK references conversations).
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS intake_stats;
