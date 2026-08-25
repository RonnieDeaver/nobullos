-- Task #4230: drop the legacy free-text roadmap_initiatives.timeframe
-- column. Task #4215 moved scheduling to release_quarter; since then the
-- column has been STOP-WRITE (strict route schemas reject it, nothing
-- selects it) and the public payload's `timeframe` field is DERIVED from
-- the quarter label (server/lib/publicRoadmap.ts) — that derived field is
-- untouched by this drop. Verified 2026-08-10: zero non-NULL timeframe
-- values in BOTH dev and production (both tables had 0 rows).
-- destructive-approved: Task #4230 is the owner-approved vehicle for this drop; column is stop-write with zero stored values in dev and prod; DROP COLUMN IF EXISTS is idempotent, table is tiny, no index references it.
ALTER TABLE roadmap_initiatives DROP COLUMN IF EXISTS timeframe;
