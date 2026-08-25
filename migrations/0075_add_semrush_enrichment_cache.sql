-- Pool Epic Phase 1.2 — Persistent SEMrush campaign enrichment cache.
--
-- Replaces the in-process `campaignKeywordsCache` / `campaignLocationCache`
-- Maps for the durable, restart-surviving layer. Gated by the existing
-- Phase 0 kill switch `semrush_persistent_enrichment_cache_enabled`
-- (default OFF; flip on once this migration has shipped and the
-- read-through path has soaked in non-prod).
--
-- Writes happen only on the worker pool via `runWithWorkerDb` +
-- `withDbAttribution`. Reads are best-effort and never block the
-- request path: if the table is missing or the row is stale, the
-- caller falls back to the legacy in-process cache + HTTP fetch.

CREATE TABLE IF NOT EXISTS "semrush_enrichment_cache" (
  "campaign_id" varchar(128) PRIMARY KEY,
  "business_name" varchar(512),
  "location" varchar(1024),
  "address" varchar(1024),
  "keywords_json" jsonb,
  "keyword_count" integer NOT NULL DEFAULT 0,
  "payload_hash" varchar(64),
  "source" varchar(32) NOT NULL,
  "last_refreshed_at" timestamp NOT NULL DEFAULT now(),
  "last_read_at" timestamp,
  "notes" text
);

CREATE INDEX IF NOT EXISTS "idx_semrush_enrichment_cache_refreshed_at"
  ON "semrush_enrichment_cache" ("last_refreshed_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_semrush_enrichment_cache_source_time"
  ON "semrush_enrichment_cache" ("source", "last_refreshed_at" DESC);
