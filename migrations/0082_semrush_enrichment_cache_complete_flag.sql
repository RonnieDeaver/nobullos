-- Task #1973: Tag SEMrush enrichment cache rows with their completion
-- status so consumers (campaign-list, demand-driven gate) can treat an
-- incomplete keyword inventory as stale regardless of timestamp.
ALTER TABLE "semrush_enrichment_cache"
  ADD COLUMN IF NOT EXISTS "complete" boolean NOT NULL DEFAULT true;

ALTER TABLE "semrush_enrichment_cache"
  ADD COLUMN IF NOT EXISTS "incomplete_reason" varchar(64);
