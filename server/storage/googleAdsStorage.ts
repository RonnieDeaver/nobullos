// @db-pool-intent: ambient
//
// Task #1759 — Google Ads storage. Reads/writes flow through `getDb()`
// so the same helpers can run from the API pool (operator routes) and
// the worker pool (sync worker via `runWithWorkerDb`). Mirrors the
// `ensureUserSlackPreferenceTables` pattern so tests booting without
// migrations still get the tables in place.

import { getDb, withDbAttribution } from "../db";
import { and, desc, eq, sql } from "drizzle-orm";
import { bindArrayParam } from "../utils/sqlArray";
import {
  googleAdsCampaignDailyStats,
  googleAdsCampaigns,
  googleAdsCustomers,
  googleAdsKeywordDailyStats,
  googleAdsSyncRuns,
  type GoogleAdsCampaign,
  type GoogleAdsCustomer,
  type GoogleAdsSyncRun,
  type InsertGoogleAdsCampaign,
  type InsertGoogleAdsCampaignDailyStats,
  type InsertGoogleAdsCustomer,
  type InsertGoogleAdsKeywordDailyStats,
  type InsertGoogleAdsSyncRun,
} from "@shared/schema";

let tablesEnsured = false;

export async function ensureGoogleAdsTables(): Promise<void> {
  if (tablesEnsured) return;
  const db = getDb();
  // (Task #4008: no google_ads_connection CREATE here — the credential
  // singleton retired with the in-app OAuth flow; auth is env-only now.)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS google_ads_customers (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL,
      descriptive_name text,
      currency_code varchar,
      time_zone varchar,
      is_manager boolean NOT NULL DEFAULT false,
      is_test_account boolean NOT NULL DEFAULT false,
      status varchar,
      nobull_client_id varchar,
      sync_enabled boolean NOT NULL DEFAULT true,
      last_sync_at timestamp,
      last_sync_error text,
      discovered_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS google_ads_customers_customer_id_uniq ON google_ads_customers (customer_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_customers_nobull_client_idx ON google_ads_customers (nobull_client_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS google_ads_campaigns (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL,
      campaign_id varchar NOT NULL,
      name text,
      status varchar,
      advertising_channel_type varchar,
      start_date date,
      end_date date,
      bidding_strategy_type varchar,
      budget_micros bigint NOT NULL DEFAULT 0,
      budget_dollars double precision NOT NULL DEFAULT 0,
      budget_name text,
      last_seen_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS google_ads_campaigns_customer_campaign_uniq ON google_ads_campaigns (customer_id, campaign_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_campaigns_customer_idx ON google_ads_campaigns (customer_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS google_ads_campaign_daily_stats (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL,
      campaign_id varchar NOT NULL,
      date date NOT NULL,
      impressions bigint NOT NULL DEFAULT 0,
      clicks bigint NOT NULL DEFAULT 0,
      cost_micros bigint NOT NULL DEFAULT 0,
      cost_dollars double precision NOT NULL DEFAULT 0,
      conversions integer NOT NULL DEFAULT 0,
      conversion_value_micros bigint NOT NULL DEFAULT 0,
      conversion_value_dollars double precision NOT NULL DEFAULT 0,
      average_cpc_micros bigint NOT NULL DEFAULT 0,
      average_cpc_dollars double precision NOT NULL DEFAULT 0,
      ctr_basis_points integer NOT NULL DEFAULT 0,
      synced_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS google_ads_campaign_daily_stats_uniq ON google_ads_campaign_daily_stats (customer_id, campaign_id, date)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_campaign_daily_stats_customer_date_idx ON google_ads_campaign_daily_stats (customer_id, date)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS google_ads_keyword_daily_stats (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL,
      campaign_id varchar NOT NULL,
      ad_group_id varchar NOT NULL,
      criterion_id varchar NOT NULL,
      keyword_text text,
      match_type varchar,
      date date NOT NULL,
      impressions bigint NOT NULL DEFAULT 0,
      clicks bigint NOT NULL DEFAULT 0,
      cost_micros bigint NOT NULL DEFAULT 0,
      cost_dollars double precision NOT NULL DEFAULT 0,
      conversions integer NOT NULL DEFAULT 0,
      average_cpc_micros bigint NOT NULL DEFAULT 0,
      average_cpc_dollars double precision NOT NULL DEFAULT 0,
      quality_score integer,
      synced_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS google_ads_keyword_daily_stats_uniq ON google_ads_keyword_daily_stats (customer_id, criterion_id, ad_group_id, date)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_stats_customer_date_idx ON google_ads_keyword_daily_stats (customer_id, date)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_stats_campaign_date_idx ON google_ads_keyword_daily_stats (campaign_id, date)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS google_ads_sync_runs (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar,
      started_at timestamp NOT NULL DEFAULT now(),
      finished_at timestamp,
      status varchar NOT NULL DEFAULT 'running',
      campaigns_upserted integer NOT NULL DEFAULT 0,
      campaign_stats_upserted integer NOT NULL DEFAULT 0,
      keyword_stats_upserted integer NOT NULL DEFAULT 0,
      error text,
      metadata jsonb
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS google_ads_sync_runs_started_at_idx ON google_ads_sync_runs (started_at)`);

  tablesEnsured = true;
}

export function __resetGoogleAdsEnsureCacheForTests(): void {
  tablesEnsured = false;
}

// ─── customers ──────────────────────────────────────────────────────────

/**
 * Task #2904 — rows pruned by discovery (no longer present in the MCC)
 * carry this status. They are hidden from `listGoogleAdsCustomers` (and
 * therefore from the account dropdown + `listEnabledCustomerIds`) but
 * kept in the table so history survives and a re-appearing account
 * simply gets its live status back via the discovery upsert.
 */
export const GOOGLE_ADS_CUSTOMER_REMOVED_STATUS = "REMOVED";

export async function listGoogleAdsCustomers(options?: {
  includeRemoved?: boolean;
}): Promise<GoogleAdsCustomer[]> {
  await ensureGoogleAdsTables();
  const base = getDb().select().from(googleAdsCustomers);
  const query = options?.includeRemoved
    ? base
    : base.where(
        sql`${googleAdsCustomers.status} IS DISTINCT FROM ${GOOGLE_ADS_CUSTOMER_REMOVED_STATUS}`,
      );
  return query.orderBy(desc(googleAdsCustomers.discoveredAt));
}

export async function getGoogleAdsCustomerByCustomerId(
  customerId: string,
): Promise<GoogleAdsCustomer | undefined> {
  await ensureGoogleAdsTables();
  const [row] = await getDb()
    .select()
    .from(googleAdsCustomers)
    .where(eq(googleAdsCustomers.customerId, customerId))
    .limit(1);
  return row;
}

export async function upsertGoogleAdsCustomer(
  values: InsertGoogleAdsCustomer,
): Promise<GoogleAdsCustomer> {
  await ensureGoogleAdsTables();
  const db = getDb();
  const [row] = await db
    .insert(googleAdsCustomers)
    .values(values)
    .onConflictDoUpdate({
      target: googleAdsCustomers.customerId,
      set: {
        descriptiveName: values.descriptiveName,
        currencyCode: values.currencyCode,
        timeZone: values.timeZone,
        isManager: values.isManager ?? false,
        isTestAccount: values.isTestAccount ?? false,
        status: values.status,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function updateGoogleAdsCustomerMapping(
  customerId: string,
  patch: { nobullClientId?: string | null; syncEnabled?: boolean },
): Promise<GoogleAdsCustomer | undefined> {
  await ensureGoogleAdsTables();
  const [row] = await getDb()
    .update(googleAdsCustomers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(googleAdsCustomers.customerId, customerId))
    .returning();
  return row;
}

/**
 * Task #2904 — flag every customer row that did NOT appear in the latest
 * discovery pass as `REMOVED` (and stop syncing it). Rows already flagged
 * are skipped so the returned count means "newly pruned this pass". The
 * caller must only invoke this with a non-empty, complete discovery set —
 * an empty/partial set would mass-flag live accounts, so an empty array
 * is a hard no-op.
 */
export async function markGoogleAdsCustomersRemoved(
  activeCustomerIds: string[],
): Promise<number> {
  if (activeCustomerIds.length === 0) return 0;
  return withDbAttribution(
    "google_ads:mark_customers_removed",
    async () => {
      await ensureGoogleAdsTables();
      const result = await getDb()
        .update(googleAdsCustomers)
        .set({
          status: GOOGLE_ADS_CUSTOMER_REMOVED_STATUS,
          syncEnabled: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            sql`${googleAdsCustomers.customerId} <> ALL(${bindArrayParam(activeCustomerIds, "text")})`,
            sql`${googleAdsCustomers.status} IS DISTINCT FROM ${GOOGLE_ADS_CUSTOMER_REMOVED_STATUS}`,
          ),
        )
        .returning({ id: googleAdsCustomers.id });
      return result.length;
    },
  );
}

export async function markGoogleAdsCustomerSynced(
  customerId: string,
  error: string | null,
): Promise<void> {
  await ensureGoogleAdsTables();
  await getDb()
    .update(googleAdsCustomers)
    .set({
      lastSyncAt: new Date(),
      lastSyncError: error,
      updatedAt: new Date(),
    })
    .where(eq(googleAdsCustomers.customerId, customerId));
}

// ─── campaigns + stats ──────────────────────────────────────────────────

/**
 * Chunk size for Google Ads bulk upserts. Keeps each `INSERT ... ON
 * CONFLICT DO UPDATE` statement bounded so a large MCC (thousands of
 * keyword × day rows per customer) never produces a single oversized
 * statement and never holds a worker-pool connection for more than the
 * 10s DB hold rule (see replit.md `DB Hold Rules`).
 */
const GOOGLE_ADS_UPSERT_CHUNK_SIZE = 500;

function chunk<T>(rows: T[], size: number): T[][] {
  if (rows.length <= size) return [rows];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function bulkUpsertGoogleAdsCampaigns(
  rows: InsertGoogleAdsCampaign[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureGoogleAdsTables();
  const db = getDb();
  let written = 0;
  for (const batch of chunk(rows, GOOGLE_ADS_UPSERT_CHUNK_SIZE)) {
    await db
      .insert(googleAdsCampaigns)
      .values(batch)
      .onConflictDoUpdate({
        target: [googleAdsCampaigns.customerId, googleAdsCampaigns.campaignId],
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          advertisingChannelType: sql`excluded.advertising_channel_type`,
          startDate: sql`excluded.start_date`,
          endDate: sql`excluded.end_date`,
          biddingStrategyType: sql`excluded.bidding_strategy_type`,
          budgetMicros: sql`excluded.budget_micros`,
          budgetDollars: sql`excluded.budget_dollars`,
          budgetName: sql`excluded.budget_name`,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      });
    written += batch.length;
  }
  return written;
}

export async function bulkUpsertGoogleAdsCampaignDailyStats(
  rows: InsertGoogleAdsCampaignDailyStats[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureGoogleAdsTables();
  const db = getDb();
  let written = 0;
  for (const batch of chunk(rows, GOOGLE_ADS_UPSERT_CHUNK_SIZE)) {
    await db
      .insert(googleAdsCampaignDailyStats)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          googleAdsCampaignDailyStats.customerId,
          googleAdsCampaignDailyStats.campaignId,
          googleAdsCampaignDailyStats.date,
        ],
        set: {
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          costMicros: sql`excluded.cost_micros`,
          costDollars: sql`excluded.cost_dollars`,
          conversions: sql`excluded.conversions`,
          conversionValueMicros: sql`excluded.conversion_value_micros`,
          conversionValueDollars: sql`excluded.conversion_value_dollars`,
          averageCpcMicros: sql`excluded.average_cpc_micros`,
          averageCpcDollars: sql`excluded.average_cpc_dollars`,
          ctr: sql`excluded.ctr_basis_points`,
          syncedAt: new Date(),
        },
      });
    written += batch.length;
  }
  return written;
}

export async function bulkUpsertGoogleAdsKeywordDailyStats(
  rows: InsertGoogleAdsKeywordDailyStats[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureGoogleAdsTables();
  const db = getDb();
  let written = 0;
  for (const batch of chunk(rows, GOOGLE_ADS_UPSERT_CHUNK_SIZE)) {
    await db
      .insert(googleAdsKeywordDailyStats)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          googleAdsKeywordDailyStats.customerId,
          googleAdsKeywordDailyStats.criterionId,
          googleAdsKeywordDailyStats.adGroupId,
          googleAdsKeywordDailyStats.date,
        ],
        set: {
          keywordText: sql`excluded.keyword_text`,
          matchType: sql`excluded.match_type`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          costMicros: sql`excluded.cost_micros`,
          costDollars: sql`excluded.cost_dollars`,
          conversions: sql`excluded.conversions`,
          averageCpcMicros: sql`excluded.average_cpc_micros`,
          averageCpcDollars: sql`excluded.average_cpc_dollars`,
          qualityScore: sql`excluded.quality_score`,
          syncedAt: new Date(),
        },
      });
    written += batch.length;
  }
  return written;
}

export async function listGoogleAdsCampaigns(
  customerId: string,
): Promise<GoogleAdsCampaign[]> {
  await ensureGoogleAdsTables();
  return getDb()
    .select()
    .from(googleAdsCampaigns)
    .where(eq(googleAdsCampaigns.customerId, customerId))
    .orderBy(desc(googleAdsCampaigns.lastSeenAt));
}

// ─── sync run audit ─────────────────────────────────────────────────────

export async function createGoogleAdsSyncRun(
  values: InsertGoogleAdsSyncRun,
): Promise<GoogleAdsSyncRun> {
  await ensureGoogleAdsTables();
  const [row] = await getDb()
    .insert(googleAdsSyncRuns)
    .values(values)
    .returning();
  return row;
}

// Task #4380 (F8): dedicated narrow writer type — sync-run completion
// tallies only; run identity/startedAt stay out.
export type GoogleAdsSyncRunFinishPatch = Partial<
  Pick<
    InsertGoogleAdsSyncRun,
    | "status"
    | "campaignsUpserted"
    | "campaignStatsUpserted"
    | "keywordStatsUpserted"
    | "error"
  >
> & { finishedAt?: Date | null };

export async function finishGoogleAdsSyncRun(
  id: string,
  patch: GoogleAdsSyncRunFinishPatch,
): Promise<void> {
  await ensureGoogleAdsTables();
  await getDb()
    .update(googleAdsSyncRuns)
    .set({ ...patch, finishedAt: patch.finishedAt ?? new Date() })
    .where(eq(googleAdsSyncRuns.id, id));
}

export async function listRecentGoogleAdsSyncRuns(
  limit = 25,
): Promise<GoogleAdsSyncRun[]> {
  await ensureGoogleAdsTables();
  return getDb()
    .select()
    .from(googleAdsSyncRuns)
    .orderBy(desc(googleAdsSyncRuns.startedAt))
    .limit(Math.max(1, Math.min(limit, 200)));
}
