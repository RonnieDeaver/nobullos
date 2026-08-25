-- Task #4268: "The NoBull Brief" rebrand — edition tag for ceo_pulses.
--
-- Adds a nullable `edition` column ('company_update' | 'market_shift'). The
-- value set is enforced at the API layer via insertCeoPulseSchema /
-- updateCeoPulseSchema (shared/models/reports.ts) — deliberately no CHECK
-- constraint, so the drizzle model in dev stays the publish-diff source of
-- truth for this table's structure. NULL means a legacy untagged brief:
-- renderers show no edition tag for NULL, and no backfill is performed
-- (out of scope per task). Purely additive and idempotent (the migration
-- replay test applies every new migration twice).

ALTER TABLE ceo_pulses
  ADD COLUMN IF NOT EXISTS edition varchar;
