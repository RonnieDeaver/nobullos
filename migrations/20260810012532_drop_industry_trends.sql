-- Task #4181: drop the abandoned industry_trends table (F5 boundary
-- inventory, audit finding R-03). Zero live read or write references
-- repo-wide — the practice-area trends endpoint in
-- server/routes/settings.ts computes its aiAnalysis fresh per request and
-- returns it in the HTTP response only; nothing ever persisted here after
-- one experimental row (2026-01-08, both dev and prod; 7 months stale).
-- Evidence of the stored row is recorded in
-- audits/industry-trends-drop-2026-08-10.md.
-- destructive-approved: Task #4181 is the owner-approved L3 vehicle for this drop; single stale row, content preserved in the audit doc; DROP IF EXISTS is idempotent, no lock concerns (table is never queried).
DROP TABLE IF EXISTS industry_trends;
