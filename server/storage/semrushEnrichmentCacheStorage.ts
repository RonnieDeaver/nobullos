// @db-pool-intent: worker
//
// Pool Epic Phase 1.2 — Persistent SEMrush enrichment cache storage.
//
// All callers (background_refresh apply path, on-demand enrichment, the
// stale-promotion sweep) invoke these helpers from a `runWithWorkerDb`
// + `withDbAttribution` scope. Every `getDb()` call in this file is
// therefore worker-pool bound. Reads degrade gracefully (return null)
// when the table is missing or the row is stale — never throws past
// the caller, never blocks the API request path.

import { sql, inArray, desc } from "drizzle-orm";
import {
  semrushEnrichmentCache,
  type InsertSemrushEnrichmentCache,
  type SemrushEnrichmentCacheRow,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

let tableReady: Promise<void> | null = null;

export async function ensureSemrushEnrichmentCacheTable(): Promise<void> {
  if (!tableReady) {
    tableReady = withDbAttribution(
      "maintenance:semrush-enrichment-cache-ensure-table",
      async () => {
        await getDb().execute(sql`
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
            "notes" text,
            "complete" boolean NOT NULL DEFAULT true,
            "incomplete_reason" varchar(64)
          )
        `);
        // Task #1973: ensureTable runs on every boot, so add the new
        // columns idempotently for envs whose table predates migration 0081.
        await getDb().execute(sql`
          ALTER TABLE "semrush_enrichment_cache"
            ADD COLUMN IF NOT EXISTS "complete" boolean NOT NULL DEFAULT true
        `);
        await getDb().execute(sql`
          ALTER TABLE "semrush_enrichment_cache"
            ADD COLUMN IF NOT EXISTS "incomplete_reason" varchar(64)
        `);
        await getDb().execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_semrush_enrichment_cache_refreshed_at"
            ON "semrush_enrichment_cache" ("last_refreshed_at" DESC)
        `);
        await getDb().execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_semrush_enrichment_cache_source_time"
            ON "semrush_enrichment_cache" ("source", "last_refreshed_at" DESC)
        `);
      },
    ).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

export async function upsertSemrushEnrichmentCache(
  row: InsertSemrushEnrichmentCache,
): Promise<void> {
  await ensureSemrushEnrichmentCacheTable();
  await withDbAttribution(
    "maintenance:semrush-enrichment-cache-upsert",
    () =>
      getDb()
        .insert(semrushEnrichmentCache)
        .values({
          ...row,
          keywordCount: row.keywordCount ?? 0,
        })
        .onConflictDoUpdate({
          target: semrushEnrichmentCache.campaignId,
          set: {
            businessName: row.businessName ?? null,
            location: row.location ?? null,
            address: row.address ?? null,
            keywordsJson: row.keywordsJson ?? null,
            keywordCount: row.keywordCount ?? 0,
            payloadHash: row.payloadHash ?? null,
            source: row.source,
            lastRefreshedAt: sql`now()`,
            notes: row.notes ?? null,
            complete: row.complete ?? true,
            incompleteReason: row.incompleteReason ?? null,
          },
        }),
  );
}

export async function getSemrushEnrichmentCacheByIds(
  campaignIds: string[],
  maxAgeMs: number,
): Promise<Map<string, SemrushEnrichmentCacheRow>> {
  const out = new Map<string, SemrushEnrichmentCacheRow>();
  if (campaignIds.length === 0) return out;
  try {
    await ensureSemrushEnrichmentCacheTable();
    const rows = await withDbAttribution(
      "maintenance:semrush-enrichment-cache-read",
      () =>
        getDb()
          .select()
          .from(semrushEnrichmentCache)
          .where(inArray(semrushEnrichmentCache.campaignId, campaignIds)),
    );
    const cutoff = Date.now() - Math.max(1000, maxAgeMs);
    for (const row of rows) {
      if (row.lastRefreshedAt && row.lastRefreshedAt.getTime() >= cutoff) {
        out.set(row.campaignId, row);
      }
    }
  } catch (err: any) {
    // Reads degrade silently — caller falls back to legacy in-process
    // cache + HTTP fetch. Logged at the call site, not here, to avoid
    // log spam when the migration hasn't been applied to a given env.
    return out;
  }
  return out;
}

export async function listRecentSemrushEnrichmentCache(
  limit = 50,
): Promise<SemrushEnrichmentCacheRow[]> {
  await ensureSemrushEnrichmentCacheTable();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return withDbAttribution(
    "maintenance:semrush-enrichment-cache-list-recent",
    () =>
      getDb()
        .select()
        .from(semrushEnrichmentCache)
        .orderBy(desc(semrushEnrichmentCache.lastRefreshedAt))
        .limit(safeLimit),
  );
}

export async function pruneSemrushEnrichmentCache(
  olderThanMs: number,
): Promise<number> {
  await ensureSemrushEnrichmentCacheTable();
  const cutoff = new Date(Date.now() - Math.max(60_000, olderThanMs));
  const result = await withDbAttribution(
    "maintenance:semrush-enrichment-cache-prune",
    () =>
      getDb().execute(sql`
        DELETE FROM semrush_enrichment_cache
        WHERE last_refreshed_at < ${cutoff}
      `),
  );
  return (result as any)?.rowCount ?? 0;
}
