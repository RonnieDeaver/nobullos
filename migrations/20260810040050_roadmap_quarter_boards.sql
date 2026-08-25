-- Task #4215: quarter-based kanban boards for the roadmap (Task #3728 module).
--
-- Additive-only evolution of roadmap_initiatives: items now live on one of
-- two boards ('product' | 'company' — a hard column, not a value-set row,
-- because report inclusion depends on it structurally) and are scheduled
-- into sortable release-quarter keys ("2026-Q3", UTC boundaries; NULL =
-- "Later"). Completion is a recorded server-owned timestamp. The legacy
-- free-text `timeframe` column is left in place but becomes STOP-WRITE (the
-- public payload derives its value from the release quarter's label).
--
-- Both dev and prod roadmap_initiatives are EMPTY at authoring time, so no
-- backfill is needed. Idempotent throughout (the replay test applies every
-- new migration twice).

ALTER TABLE roadmap_initiatives
  ADD COLUMN IF NOT EXISTS board varchar(16) NOT NULL DEFAULT 'product';

ALTER TABLE roadmap_initiatives
  ADD COLUMN IF NOT EXISTS release_quarter varchar(8);

ALTER TABLE roadmap_initiatives
  ADD COLUMN IF NOT EXISTS completed_at timestamp;

-- Value-set seeds, re-stated from 0150_roadmap.sql: PRODUCTION has zero
-- roadmap_departments / roadmap_types rows (the Publish pipeline diffs
-- structure only, so 0150's seed INSERTs never reached prod — the runtime
-- ensure in server/routes/roadmap.ts closes that gap at first use, and this
-- restatement keeps fresh dev/test databases seeded through the migration
-- path alone). Rows must stay in lockstep with roadmapSeedDepartments /
-- roadmapSeedTypes in shared/models/roadmap.ts. ON CONFLICT (slug) DO
-- NOTHING makes every re-run a no-op.
INSERT INTO roadmap_departments (name, slug, display_order) VALUES
  ('Marketing', 'marketing', 10),
  ('Sales', 'sales', 20),
  ('Operations', 'operations', 30),
  ('Client Success', 'client-success', 40),
  ('Product & Engineering', 'product-engineering', 50)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO roadmap_types (name, slug, display_order) VALUES
  ('New Capability', 'new-capability', 10),
  ('Improvement', 'improvement', 20),
  ('Internal Tooling', 'internal-tooling', 30),
  ('Process', 'process', 40)
ON CONFLICT (slug) DO NOTHING;
