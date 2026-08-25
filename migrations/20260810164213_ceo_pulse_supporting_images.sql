-- Task #4293: supporting images for update briefs (The NoBull Brief).
--
-- Adds a nullable `supporting_images` JSONB column to ceo_pulses. Shape is an
-- ordered array of { slot, ext, caption? } entries — array order is display
-- order, `slot` is a stable per-brief integer identity (allocated max+1 so
-- {{image-N}} letter placeholders and object-storage keys survive reorders),
-- `ext` is one of jpg|png|webp derived from magic-byte sniffing at upload
-- (never from the client). The value set is enforced at the API layer via the
-- dedicated image endpoints (shared/models/reports.ts constants +
-- updateCeoPulseImagesSchema) — deliberately no CHECK constraint, so the
-- drizzle model in dev stays the publish-diff source of truth for this
-- table's structure. NULL means a brief with no uploaded images (all legacy
-- rows): renderers treat it exactly like an empty list, no backfill.
-- Purely additive and idempotent (the migration replay test applies every
-- new migration twice).

ALTER TABLE ceo_pulses
  ADD COLUMN IF NOT EXISTS supporting_images jsonb;
