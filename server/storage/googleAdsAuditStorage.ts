// @db-pool-intent: ambient
//
// Task #2784 — Google Ads Hygiene Audit storage. Reads/writes flow
// through `getDb()` so the audit engine can run from an API-pool admin
// route. Mirrors `googleAdsStorage.ts`'s `ensure*Tables` bootstrap
// pattern so tests booting without migrations still get the tables.

import { getDb, withDbAttribution } from "../db";
import { desc, eq, sql } from "drizzle-orm";
import {
  googleAdsAuditCheckResults,
  googleAdsAuditRuns,
  type GoogleAdsAuditCheckResult,
  type GoogleAdsAuditRun,
  type InsertGoogleAdsAuditCheckResult,
  type InsertGoogleAdsAuditRun,
} from "@shared/schema";

let tablesEnsured = false;

export async function ensureGoogleAdsAuditTables(): Promise<void> {
  if (tablesEnsured) return;
  await withDbAttribution("googleAdsAudit:ensureTables", async () => {
    const db = getDb();
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS google_ads_audit_runs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'running',
        started_at timestamp NOT NULL DEFAULT now(),
        finished_at timestamp,
        triggered_by varchar,
        score_h double precision,
        score_h_final double precision,
        category_scores jsonb,
        triggered_gates jsonb,
        error text,
        metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_audit_runs_customer_idx ON google_ads_audit_runs (customer_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_audit_runs_started_at_idx ON google_ads_audit_runs (started_at)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS google_ads_audit_check_results (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id varchar NOT NULL,
        check_id varchar NOT NULL,
        category_id varchar NOT NULL,
        status varchar NOT NULL,
        score double precision,
        weight double precision NOT NULL DEFAULT 0,
        measured_value text,
        measured_numeric double precision,
        affected_entities jsonb,
        recommended_fix text,
        is_gate text,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_audit_check_results_run_idx ON google_ads_audit_check_results (run_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_audit_check_results_run_check_idx ON google_ads_audit_check_results (run_id, check_id)`);
  });

  tablesEnsured = true;
}

export async function createGoogleAdsAuditRun(
  data: InsertGoogleAdsAuditRun,
): Promise<GoogleAdsAuditRun> {
  await ensureGoogleAdsAuditTables();
  return withDbAttribution("googleAdsAudit:createRun", async () => {
    const db = getDb();
    const [row] = await db.insert(googleAdsAuditRuns).values(data).returning();
    return row;
  });
}

// Task #4380 (F8): dedicated narrow writer type — audit-run lifecycle
// completion fields only; row identity/customer scoping stay out.
export type GoogleAdsAuditRunStoragePatch = Partial<
  Pick<
    InsertGoogleAdsAuditRun,
    | "status"
    | "finishedAt"
    | "scoreH"
    | "scoreHFinal"
    | "categoryScores"
    | "triggeredGates"
    | "error"
  >
>;

export async function updateGoogleAdsAuditRun(
  runId: string,
  patch: GoogleAdsAuditRunStoragePatch,
): Promise<GoogleAdsAuditRun | undefined> {
  await ensureGoogleAdsAuditTables();
  return withDbAttribution("googleAdsAudit:updateRun", async () => {
    const db = getDb();
    const [row] = await db
      .update(googleAdsAuditRuns)
      .set(patch)
      .where(eq(googleAdsAuditRuns.id, runId))
      .returning();
    return row;
  });
}

export async function getGoogleAdsAuditRun(
  runId: string,
): Promise<GoogleAdsAuditRun | undefined> {
  await ensureGoogleAdsAuditTables();
  return withDbAttribution("googleAdsAudit:getRun", async () => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(googleAdsAuditRuns)
      .where(eq(googleAdsAuditRuns.id, runId));
    return row;
  });
}

export async function listGoogleAdsAuditRuns(
  customerId: string,
  limit = 25,
): Promise<GoogleAdsAuditRun[]> {
  await ensureGoogleAdsAuditTables();
  return withDbAttribution("googleAdsAudit:listRuns", async () => {
    const db = getDb();
    return db
      .select()
      .from(googleAdsAuditRuns)
      .where(eq(googleAdsAuditRuns.customerId, customerId))
      .orderBy(desc(googleAdsAuditRuns.startedAt))
      .limit(limit);
  });
}

export async function insertGoogleAdsAuditCheckResults(
  results: InsertGoogleAdsAuditCheckResult[],
): Promise<number> {
  if (results.length === 0) return 0;
  await ensureGoogleAdsAuditTables();
  return withDbAttribution("googleAdsAudit:insertCheckResults", async () => {
    const db = getDb();
    await db.insert(googleAdsAuditCheckResults).values(results);
    return results.length;
  });
}

export async function listGoogleAdsAuditCheckResults(
  runId: string,
): Promise<GoogleAdsAuditCheckResult[]> {
  await ensureGoogleAdsAuditTables();
  return withDbAttribution("googleAdsAudit:listCheckResults", async () => {
    const db = getDb();
    return db
      .select()
      .from(googleAdsAuditCheckResults)
      .where(eq(googleAdsAuditCheckResults.runId, runId));
  });
}
