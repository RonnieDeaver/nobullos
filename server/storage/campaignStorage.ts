// @db-pool-intent: ambient
//
// Task #4337 — storage for marketing campaigns, tracked links, and
// source/campaign attribution rollups. All callers are request-scoped
// routes, so every getDb() here lands on the ambient api pool. See
// scripts/lint-db-pool-tenancy.ts for the contract.
//
// Attribution model (first-touch only, by design):
//   - Leads (clients) and deals carry immutable firstTouchSource /
//     firstTouchCampaign stamps written at creation by the intake paths.
//   - Campaigns claim history BY NORMALIZED KEY (utm_campaign string), not
//     FK: a campaign created after its traffic still attributes it, and
//     deleting a campaign never destroys the stamps.
//   - "unknown" buckets are pre-feature rows (NULL stamp); "direct" is a
//     captured touch with no signal. The report keeps them distinct.
//
// Scope rules baked into the rollups:
//   - Leads = clients rows with leadSource IS NOT NULL (intake-minted or
//     operator-sourced lead records). Operator-created plain client rows
//     never count as leads.
//   - Deals count by createdAt; won revenue counts by stageEnteredAt where
//     the CURRENT stage is a won stage (stage history is out of scope for
//     first-touch reporting).

import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  campaignLinks,
  clients,
  dealStages,
  deals,
  marketingCampaigns,
  normalizeUtmCampaign,
  type CampaignLink,
  type CreateCampaignBody,
  type CreateCampaignLinkBody,
  type MarketingCampaign,
  type UpdateCampaignBody,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

/** Unique-key collision on marketing_campaigns.utm_campaign → route 409. */
export class CampaignKeyConflictError extends Error {
  constructor(public readonly utmCampaign: string) {
    super(`A campaign with utm_campaign key '${utmCampaign}' already exists`);
    this.name = "CampaignKeyConflictError";
  }
}

/** Drizzle wraps pg errors — the SQLSTATE hides in the .cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let e: any = err;
  while (e) {
    if (e.code === "23505") return true;
    e = e.cause;
  }
  return false;
}

export interface CampaignStats {
  leads: number;
  deals: number;
  wonDeals: number;
  wonAmount: number;
}

const EMPTY_STATS: CampaignStats = { leads: 0, deals: 0, wonDeals: 0, wonAmount: 0 };

export type CampaignWithStats = MarketingCampaign & { stats: CampaignStats };

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------

export async function listCampaigns(): Promise<CampaignWithStats[]> {
  return withDbAttribution("campaigns:list", async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(marketingCampaigns)
      .orderBy(desc(marketingCampaigns.createdAt));
    if (rows.length === 0) return [];

    const statsByKey = await aggregateStatsByCampaignKey(null);
    return rows.map((row) => ({
      ...row,
      stats: statsByKey.get(row.utmCampaign) ?? { ...EMPTY_STATS },
    }));
  });
}

export interface CampaignDetail {
  campaign: MarketingCampaign;
  links: CampaignLink[];
  stats: CampaignStats;
  attributedLeads: Array<{
    id: string;
    firmName: string;
    contactName: string | null;
    contactEmail: string | null;
    lifecycleStage: string;
    firstTouchSource: string | null;
    createdAt: Date | null;
  }>;
  attributedDeals: Array<{
    id: string;
    name: string;
    amount: number | null;
    stageName: string | null;
    stageType: string | null;
    clientId: string | null;
    createdAt: Date | null;
  }>;
}

/** Attributed-list cap — campaign pages show the most recent slice. */
export const CAMPAIGN_ATTRIBUTED_LIST_LIMIT = 50;

export async function getCampaignDetail(id: string): Promise<CampaignDetail | null> {
  return withDbAttribution("campaigns:detail", async () => {
    const db = getDb();
    const [campaign] = await db
      .select()
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, id))
      .limit(1);
    if (!campaign) return null;

    const [links, statsByKey, attributedLeads, attributedDeals] = await Promise.all([
      db
        .select()
        .from(campaignLinks)
        .where(eq(campaignLinks.campaignId, id))
        .orderBy(asc(campaignLinks.createdAt)),
      aggregateStatsByCampaignKey(campaign.utmCampaign),
      db
        .select({
          id: clients.id,
          firmName: clients.firmName,
          contactName: clients.contactName,
          contactEmail: clients.contactEmail,
          lifecycleStage: clients.lifecycleStage,
          firstTouchSource: clients.firstTouchSource,
          createdAt: clients.createdAt,
        })
        .from(clients)
        .where(eq(clients.firstTouchCampaign, campaign.utmCampaign))
        .orderBy(desc(clients.createdAt))
        .limit(CAMPAIGN_ATTRIBUTED_LIST_LIMIT),
      db
        .select({
          id: deals.id,
          name: deals.name,
          amount: deals.amount,
          stageName: dealStages.name,
          stageType: dealStages.stageType,
          clientId: deals.clientId,
          createdAt: deals.createdAt,
        })
        .from(deals)
        .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(eq(deals.firstTouchCampaign, campaign.utmCampaign))
        .orderBy(desc(deals.createdAt))
        .limit(CAMPAIGN_ATTRIBUTED_LIST_LIMIT),
    ]);

    return {
      campaign,
      links,
      stats: statsByKey.get(campaign.utmCampaign) ?? { ...EMPTY_STATS },
      attributedLeads,
      attributedDeals,
    };
  });
}

export async function createCampaign(
  input: CreateCampaignBody,
  createdBy: string,
): Promise<MarketingCampaign> {
  const key = normalizeUtmCampaign(input.utmCampaign);
  if (!key) throw new Error("utmCampaign normalizes to empty");
  return withDbAttribution("campaigns:create", async () => {
    try {
      const [row] = await getDb()
        .insert(marketingCampaigns)
        .values({
          name: input.name,
          utmCampaign: key,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          notes: input.notes ?? null,
          createdBy,
        })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new CampaignKeyConflictError(key);
      throw err;
    }
  });
}

export async function updateCampaign(
  id: string,
  fields: UpdateCampaignBody,
): Promise<MarketingCampaign | null> {
  const set: Partial<typeof marketingCampaigns.$inferInsert> = {};
  if (fields.name !== undefined) set.name = fields.name;
  if (fields.utmCampaign !== undefined) {
    // Re-pointing the key is allowed — attribution follows the key, so this
    // re-targets which stamped rows the campaign claims. Uniqueness holds.
    const key = normalizeUtmCampaign(fields.utmCampaign);
    if (!key) throw new Error("utmCampaign normalizes to empty");
    set.utmCampaign = key;
  }
  if (fields.startDate !== undefined) set.startDate = fields.startDate;
  if (fields.endDate !== undefined) set.endDate = fields.endDate;
  if (fields.notes !== undefined) set.notes = fields.notes;
  if (fields.isArchived !== undefined) set.isArchived = fields.isArchived;
  if (Object.keys(set).length === 0) {
    return withDbAttribution("campaigns:update", async () => {
      const [row] = await getDb()
        .select()
        .from(marketingCampaigns)
        .where(eq(marketingCampaigns.id, id))
        .limit(1);
      return row ?? null;
    });
  }
  set.updatedAt = new Date();
  return withDbAttribution("campaigns:update", async () => {
    try {
      const [row] = await getDb()
        .update(marketingCampaigns)
        .set(set)
        .where(eq(marketingCampaigns.id, id))
        .returning();
      return row ?? null;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CampaignKeyConflictError(set.utmCampaign ?? "");
      }
      throw err;
    }
  });
}

/**
 * Deletes the campaign record (links cascade). First-touch stamps on
 * clients/deals are string keys and deliberately survive — attribution is
 * historical fact; a recreated campaign with the same key re-claims it.
 */
export async function deleteCampaign(id: string): Promise<boolean> {
  return withDbAttribution("campaigns:delete", async () => {
    const rows = await getDb()
      .delete(marketingCampaigns)
      .where(eq(marketingCampaigns.id, id))
      .returning({ id: marketingCampaigns.id });
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Campaign links (UTM builder)
// ---------------------------------------------------------------------------

export async function createCampaignLink(
  campaignId: string,
  input: CreateCampaignLinkBody,
  createdBy: string,
): Promise<{ campaign: MarketingCampaign; link: CampaignLink } | null> {
  return withDbAttribution("campaigns:createLink", async () => {
    const db = getDb();
    const [campaign] = await db
      .select()
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, campaignId))
      .limit(1);
    if (!campaign) return null;
    const [link] = await db
      .insert(campaignLinks)
      .values({
        campaignId,
        label: input.label ?? null,
        destinationUrl: input.destinationUrl,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        utmTerm: input.utmTerm ?? null,
        utmContent: input.utmContent ?? null,
        createdBy,
      })
      .returning();
    return { campaign, link };
  });
}

export async function deleteCampaignLink(
  campaignId: string,
  linkId: string,
): Promise<boolean> {
  return withDbAttribution("campaigns:deleteLink", async () => {
    const rows = await getDb()
      .delete(campaignLinks)
      .where(and(eq(campaignLinks.id, linkId), eq(campaignLinks.campaignId, campaignId)))
      .returning({ id: campaignLinks.id });
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/**
 * Per-campaign-key stats (all-time). Pass a key to restrict to one campaign,
 * or null for every non-null key (list view). Merged in JS from three
 * grouped queries — index-friendly and shape-stable at NoBull scale.
 */
async function aggregateStatsByCampaignKey(
  key: string | null,
): Promise<Map<string, CampaignStats>> {
  // Callers (list/detail) already run inside campaigns:* scopes, but the
  // attribution lint requires the getDb() call site to be lexically inside
  // a wrap callback; the innermost scope wins on the slow-query dashboard.
  return withDbAttribution("campaigns:stats", async () => {
  const db = getDb();
  const clientKeyCond =
    key === null
      ? isNotNull(clients.firstTouchCampaign)
      : eq(clients.firstTouchCampaign, key);
  const dealKeyCond =
    key === null
      ? isNotNull(deals.firstTouchCampaign)
      : eq(deals.firstTouchCampaign, key);

  const [leadRows, dealRows, wonRows] = await Promise.all([
    db
      .select({
        key: clients.firstTouchCampaign,
        n: sql<number>`count(*)::int`,
      })
      .from(clients)
      .where(clientKeyCond)
      .groupBy(clients.firstTouchCampaign),
    db
      .select({
        key: deals.firstTouchCampaign,
        n: sql<number>`count(*)::int`,
      })
      .from(deals)
      .where(dealKeyCond)
      .groupBy(deals.firstTouchCampaign),
    db
      .select({
        key: deals.firstTouchCampaign,
        n: sql<number>`count(*)::int`,
        amount: sql<number>`coalesce(sum(coalesce(${deals.amount}, 0)), 0)::float8`,
      })
      .from(deals)
      .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
      .where(and(dealKeyCond, eq(dealStages.stageType, "won")))
      .groupBy(deals.firstTouchCampaign),
  ]);

  const map = new Map<string, CampaignStats>();
  const bucket = (k: string | null): CampaignStats | null => {
    if (!k) return null;
    let b = map.get(k);
    if (!b) {
      b = { ...EMPTY_STATS };
      map.set(k, b);
    }
    return b;
  };
  for (const r of leadRows) {
    const b = bucket(r.key);
    if (b) b.leads = r.n;
  }
  for (const r of dealRows) {
    const b = bucket(r.key);
    if (b) b.deals = r.n;
  }
  for (const r of wonRows) {
    const b = bucket(r.key);
    if (b) {
      b.wonDeals = r.n;
      b.wonAmount = r.amount;
    }
  }
  return map;
  });
}

export interface AttributionDateRange {
  /** Inclusive UTC start, or null for open. */
  fromUtc: Date | null;
  /** EXCLUSIVE UTC end (day after the requested end date), or null. */
  toUtcExclusive: Date | null;
}

export interface SourceAttributionRow {
  source: string; // normalized token, "direct", or "unknown" (NULL stamp)
  leads: number;
  deals: number;
  wonDeals: number;
  wonAmount: number;
}

export interface CampaignAttributionRow {
  utmCampaign: string;
  campaignId: string | null; // null = stamped key with no campaign record
  campaignName: string | null;
  leads: number;
  deals: number;
  wonDeals: number;
  wonAmount: number;
}

export interface AttributionReport {
  sources: SourceAttributionRow[];
  campaigns: CampaignAttributionRow[];
}

function dateConds(
  col: typeof clients.createdAt | typeof deals.createdAt | typeof deals.stageEnteredAt,
  range: AttributionDateRange,
) {
  const conds = [];
  if (range.fromUtc) conds.push(gte(col, range.fromUtc));
  if (range.toUtcExclusive) conds.push(lt(col, range.toUtcExclusive));
  return conds;
}

/**
 * "Where did this quarter's business come from" — source and campaign
 * rollups over leads (clients.createdAt), deals (deals.createdAt), and won
 * revenue (deals.stageEnteredAt where the current stage is won), all
 * bucketed by first-touch stamps.
 */
export async function getAttributionReport(
  range: AttributionDateRange,
): Promise<AttributionReport> {
  return withDbAttribution("campaigns:attributionReport", async () => {
    const db = getDb();
    const sourceExpr = sql<string>`coalesce(${clients.firstTouchSource}, 'unknown')`;
    const dealSourceExpr = sql<string>`coalesce(${deals.firstTouchSource}, 'unknown')`;

    const [
      leadsBySource,
      dealsBySource,
      wonBySource,
      leadsByCampaign,
      dealsByCampaign,
      wonByCampaign,
    ] = await Promise.all([
      db
        .select({ key: sourceExpr, n: sql<number>`count(*)::int` })
        .from(clients)
        .where(and(isNotNull(clients.leadSource), ...dateConds(clients.createdAt, range)))
        .groupBy(sourceExpr),
      db
        .select({ key: dealSourceExpr, n: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(...dateConds(deals.createdAt, range)))
        .groupBy(dealSourceExpr),
      db
        .select({
          key: dealSourceExpr,
          n: sql<number>`count(*)::int`,
          amount: sql<number>`coalesce(sum(coalesce(${deals.amount}, 0)), 0)::float8`,
        })
        .from(deals)
        .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(and(eq(dealStages.stageType, "won"), ...dateConds(deals.stageEnteredAt, range)))
        .groupBy(dealSourceExpr),
      db
        .select({ key: clients.firstTouchCampaign, n: sql<number>`count(*)::int` })
        .from(clients)
        .where(
          and(
            isNotNull(clients.firstTouchCampaign),
            isNotNull(clients.leadSource),
            ...dateConds(clients.createdAt, range),
          ),
        )
        .groupBy(clients.firstTouchCampaign),
      db
        .select({ key: deals.firstTouchCampaign, n: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(isNotNull(deals.firstTouchCampaign), ...dateConds(deals.createdAt, range)))
        .groupBy(deals.firstTouchCampaign),
      db
        .select({
          key: deals.firstTouchCampaign,
          n: sql<number>`count(*)::int`,
          amount: sql<number>`coalesce(sum(coalesce(${deals.amount}, 0)), 0)::float8`,
        })
        .from(deals)
        .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(
          and(
            isNotNull(deals.firstTouchCampaign),
            eq(dealStages.stageType, "won"),
            ...dateConds(deals.stageEnteredAt, range),
          ),
        )
        .groupBy(deals.firstTouchCampaign),
    ]);

    // Merge source buckets.
    const sourceMap = new Map<string, SourceAttributionRow>();
    const sourceBucket = (key: string): SourceAttributionRow => {
      let b = sourceMap.get(key);
      if (!b) {
        b = { source: key, leads: 0, deals: 0, wonDeals: 0, wonAmount: 0 };
        sourceMap.set(key, b);
      }
      return b;
    };
    for (const r of leadsBySource) sourceBucket(r.key).leads = r.n;
    for (const r of dealsBySource) sourceBucket(r.key).deals = r.n;
    for (const r of wonBySource) {
      const b = sourceBucket(r.key);
      b.wonDeals = r.n;
      b.wonAmount = r.amount;
    }

    // Merge campaign buckets + resolve campaign records by key.
    const campaignMap = new Map<string, CampaignAttributionRow>();
    const campaignBucket = (key: string | null): CampaignAttributionRow | null => {
      if (!key) return null;
      let b = campaignMap.get(key);
      if (!b) {
        b = {
          utmCampaign: key,
          campaignId: null,
          campaignName: null,
          leads: 0,
          deals: 0,
          wonDeals: 0,
          wonAmount: 0,
        };
        campaignMap.set(key, b);
      }
      return b;
    };
    for (const r of leadsByCampaign) {
      const b = campaignBucket(r.key);
      if (b) b.leads = r.n;
    }
    for (const r of dealsByCampaign) {
      const b = campaignBucket(r.key);
      if (b) b.deals = r.n;
    }
    for (const r of wonByCampaign) {
      const b = campaignBucket(r.key);
      if (b) {
        b.wonDeals = r.n;
        b.wonAmount = r.amount;
      }
    }
    const keys = [...campaignMap.keys()];
    if (keys.length > 0) {
      const records = await db
        .select({
          id: marketingCampaigns.id,
          name: marketingCampaigns.name,
          utmCampaign: marketingCampaigns.utmCampaign,
        })
        .from(marketingCampaigns)
        .where(inArray(marketingCampaigns.utmCampaign, keys));
      for (const rec of records) {
        const b = campaignMap.get(rec.utmCampaign);
        if (b) {
          b.campaignId = rec.id;
          b.campaignName = rec.name;
        }
      }
    }

    const byWonThenVolume = (
      a: { wonAmount: number; deals: number; leads: number },
      b: { wonAmount: number; deals: number; leads: number },
    ) => b.wonAmount - a.wonAmount || b.deals - a.deals || b.leads - a.leads;
    return {
      sources: [...sourceMap.values()].sort(byWonThenVolume),
      campaigns: [...campaignMap.values()].sort(byWonThenVolume),
    };
  });
}
