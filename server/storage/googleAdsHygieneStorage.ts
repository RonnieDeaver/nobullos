// @db-pool-intent: ambient
//
// Task #2785 — Google Ads Hygiene: Keyword Intel, Budget Pacing & Alerts.
// Reads/writes flow through `getDb()` so helpers can run from API-pool
// admin routes. Mirrors `googleAdsAuditStorage.ts` bootstrap pattern.

import { getDb, withDbAttribution } from "../db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  googleAdsHygieneAlerts,
  googleAdsKeywordIntelResults,
  type GoogleAdsHygieneAlert,
  type GoogleAdsKeywordIntelResult,
  type InsertGoogleAdsHygieneAlert,
  type InsertGoogleAdsKeywordIntelResult,
} from "@shared/schema";

let tablesEnsured = false;

export async function ensureGoogleAdsHygieneTables(): Promise<void> {
  if (tablesEnsured) return;
  await withDbAttribution("googleAdsHygiene:ensureTables", async () => {
    const db = getDb();
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS google_ads_hygiene_alerts (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id varchar NOT NULL,
        alert_type varchar NOT NULL,
        severity varchar NOT NULL DEFAULT 'warning',
        title text NOT NULL,
        detail text,
        campaign_id varchar,
        campaign_name text,
        measured_value text,
        is_resolved varchar NOT NULL DEFAULT 'no',
        resolved_at timestamp,
        clickup_task_id varchar,
        clickup_list_id varchar,
        clickup_task_status varchar,
        clickup_task_url text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_hygiene_alerts_customer_idx ON google_ads_hygiene_alerts (customer_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_hygiene_alerts_created_at_idx ON google_ads_hygiene_alerts (created_at)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS google_ads_keyword_intel_results (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id varchar NOT NULL,
        run_at timestamp NOT NULL DEFAULT now(),
        campaign_id varchar,
        campaign_name text,
        ad_group_id varchar,
        keyword_text text NOT NULL,
        match_type varchar,
        impressions integer NOT NULL DEFAULT 0,
        clicks integer NOT NULL DEFAULT 0,
        cost_dollars double precision NOT NULL DEFAULT 0,
        conversions integer NOT NULL DEFAULT 0,
        avg_cpc_dollars double precision NOT NULL DEFAULT 0,
        quality_score integer,
        suggestion_type varchar NOT NULL,
        notes text,
        metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_keyword_intel_customer_run_idx ON google_ads_keyword_intel_results (customer_id, run_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_keyword_intel_customer_idx ON google_ads_keyword_intel_results (customer_id)`);
  });
  tablesEnsured = true;
}

export function __resetGoogleAdsHygieneEnsureCacheForTests(): void {
  tablesEnsured = false;
}

// ─── Alerts ─────────────────────────────────────────────────────────────────

export async function insertGoogleAdsHygieneAlerts(
  rows: InsertGoogleAdsHygieneAlert[],
): Promise<GoogleAdsHygieneAlert[]> {
  if (rows.length === 0) return [];
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:insertAlerts", async () => {
    const db = getDb();
    return db.insert(googleAdsHygieneAlerts).values(rows).returning();
  });
}

export async function listGoogleAdsHygieneAlerts(
  customerId: string,
  opts: { limit?: number; includeResolved?: boolean } = {},
): Promise<GoogleAdsHygieneAlert[]> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:listAlerts", async () => {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const conditions = [eq(googleAdsHygieneAlerts.customerId, customerId)];
    if (!opts.includeResolved) {
      conditions.push(eq(googleAdsHygieneAlerts.isResolved, "no"));
    }
    return db
      .select()
      .from(googleAdsHygieneAlerts)
      .where(and(...conditions))
      .orderBy(desc(googleAdsHygieneAlerts.createdAt))
      .limit(limit);
  });
}

export async function getGoogleAdsHygieneAlert(
  alertId: string,
): Promise<GoogleAdsHygieneAlert | undefined> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:getAlert", async () => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(googleAdsHygieneAlerts)
      .where(eq(googleAdsHygieneAlerts.id, alertId))
      .limit(1);
    return row;
  });
}

// Task #4380 (F8): dedicated narrow writer type — ClickUp linkage and
// resolution lifecycle only; alert identity/detection payload stay out.
export type GoogleAdsHygieneAlertStoragePatch = Partial<
  Pick<
    InsertGoogleAdsHygieneAlert,
    "clickupTaskId" | "clickupTaskStatus" | "clickupTaskUrl" | "isResolved" | "resolvedAt"
  >
>;

export async function updateGoogleAdsHygieneAlert(
  alertId: string,
  patch: GoogleAdsHygieneAlertStoragePatch,
): Promise<GoogleAdsHygieneAlert | undefined> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:updateAlert", async () => {
    const db = getDb();
    const [row] = await db
      .update(googleAdsHygieneAlerts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(googleAdsHygieneAlerts.id, alertId))
      .returning();
    return row;
  });
}

export async function resolveGoogleAdsHygieneAlert(
  alertId: string,
): Promise<GoogleAdsHygieneAlert | undefined> {
  return updateGoogleAdsHygieneAlert(alertId, {
    isResolved: "yes",
    resolvedAt: new Date(),
  });
}

/**
 * Delete recent auto-generated alerts for a customer — used before
 * recomputing to avoid duplicates.
 *
 * Intentionally EXCLUDES alerts that are already ClickUp-linked so
 * ongoing task-tracking continuity is not broken by a re-run.
 */
export async function deleteRecentAlertsForCustomer(
  customerId: string,
  olderThanHours = 24,
): Promise<number> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:deleteRecentAlerts", async () => {
    const db = getDb();
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const deleted = await db
      .delete(googleAdsHygieneAlerts)
      .where(
        and(
          eq(googleAdsHygieneAlerts.customerId, customerId),
          eq(googleAdsHygieneAlerts.isResolved, "no"),
          gte(googleAdsHygieneAlerts.createdAt, cutoff),
          isNull(googleAdsHygieneAlerts.clickupTaskId),
        ),
      )
      .returning({ id: googleAdsHygieneAlerts.id });
    return deleted.length;
  });
}

/**
 * Clear the ClickUp linkage from an alert after its task has been closed.
 * Doing this at the storage layer means the next list query returns the
 * alert without a clickupTaskId, so the UI reverts to showing "Create task".
 */
export async function clearClickUpLinkageForAlert(
  alertId: string,
): Promise<GoogleAdsHygieneAlert | undefined> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:clearClickUpLinkage", async () => {
    const db = getDb();
    const [row] = await db
      .update(googleAdsHygieneAlerts)
      .set({
        clickupTaskId: null,
        clickupTaskStatus: null,
        clickupTaskUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(googleAdsHygieneAlerts.id, alertId))
      .returning();
    return row;
  });
}

// ─── Keyword Intel Results ───────────────────────────────────────────────────

/**
 * Clear ALL prior keyword intel results for a customer before a new run.
 * This ensures that a zero-result run (no flagged keywords) correctly wipes
 * the previous run's rows rather than leaving stale data visible.
 */
export async function clearKeywordIntelResultsForCustomer(
  customerId: string,
): Promise<void> {
  await ensureGoogleAdsHygieneTables();
  await withDbAttribution("googleAdsHygiene:clearKeywordResults", async () => {
    const db = getDb();
    await db
      .delete(googleAdsKeywordIntelResults)
      .where(eq(googleAdsKeywordIntelResults.customerId, customerId));
  });
}

export async function insertKeywordIntelResults(
  rows: InsertGoogleAdsKeywordIntelResult[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:insertKeywordResults", async () => {
    const db = getDb();
    await db.insert(googleAdsKeywordIntelResults).values(rows);
    return rows.length;
  });
}

export async function listLatestKeywordIntelResults(
  customerId: string,
  limit = 200,
): Promise<GoogleAdsKeywordIntelResult[]> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:listKeywordResults", async () => {
    const db = getDb();
    const latestRun = await db
      .select({ runAt: googleAdsKeywordIntelResults.runAt })
      .from(googleAdsKeywordIntelResults)
      .where(eq(googleAdsKeywordIntelResults.customerId, customerId))
      .orderBy(desc(googleAdsKeywordIntelResults.runAt))
      .limit(1);
    if (latestRun.length === 0) return [];
    const runAt = latestRun[0].runAt;
    return db
      .select()
      .from(googleAdsKeywordIntelResults)
      .where(
        and(
          eq(googleAdsKeywordIntelResults.customerId, customerId),
          eq(googleAdsKeywordIntelResults.runAt, runAt),
        ),
      )
      .orderBy(desc(googleAdsKeywordIntelResults.impressions))
      .limit(Math.max(1, Math.min(limit, 1000)));
  });
}

export async function getLatestKeywordIntelRunAt(
  customerId: string,
): Promise<Date | null> {
  await ensureGoogleAdsHygieneTables();
  return withDbAttribution("googleAdsHygiene:getLatestKeywordRunAt", async () => {
    const db = getDb();
    const [row] = await db
      .select({ runAt: googleAdsKeywordIntelResults.runAt })
      .from(googleAdsKeywordIntelResults)
      .where(eq(googleAdsKeywordIntelResults.customerId, customerId))
      .orderBy(desc(googleAdsKeywordIntelResults.runAt))
      .limit(1);
    return row?.runAt ?? null;
  });
}
