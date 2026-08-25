/**
 * Task #652 — Heatmap coverage service.
 *
 * Ports the (client, location, campaign, reportDate) gap-detection logic
 * from `scripts/verify-task-642.ts` into a reusable service so the admin UI
 * can surface coverage gaps without operators having to run a CLI script.
 *
 * Coverage classification per (clientId, locationId, campaignId, reportDate):
 *   ok            — actualSnapshots >= expectedActiveKeywords
 *   partial       — 0 < actualSnapshots < expectedActiveKeywords
 *   missing       — actualSnapshots == 0 and expectedActiveKeywords > 0
 *   inconclusive  — expected count could not be determined (SEMrush fetch
 *                   failed or campaign keyword list unavailable).
 *
 * Each SEMrush campaign is fetched at most once per `computeHeatmapCoverage`
 * call, and the per-campaign fetch is also cached at module scope for 10
 * minutes to keep the admin endpoints cheap to refresh.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  semrushLocationCampaigns,
  heatmapSnapshots,
  semrushCampaignMetadataCache,
} from "../../shared/models/heatmap";
import { clients, clientLocations } from "../../shared/models/clients";
import { getCampaign, getCampaignKeywords } from "./semrushApi";

export type CoverageStatus = "ok" | "partial" | "missing" | "inconclusive";

export interface CoverageRow {
  clientId: string;
  clientName: string;
  locationId: string;
  locationName: string;
  campaignId: string;
  campaignName: string | null;
  reportDate: string;
  expectedKeywords: number | null;
  actualSnapshots: number;
  coverage: CoverageStatus;
  note?: string;
  /**
   * True when this row's expected/reportDate metadata came from the
   * persisted last-known-good snapshot rather than a live SEMrush call
   * (Task #1112). When true, `cachedMetadataAt` is the ISO timestamp of
   * the snapshot.
   */
  usedCachedMetadata?: boolean;
  cachedMetadataAt?: string | null;
}

export interface LocationCoverage {
  clientId: string;
  clientName: string;
  locationId: string;
  locationName: string;
  total: number;
  ok: number;
  partial: number;
  missing: number;
  inconclusive: number;
  campaignCount: number;
  status: "ok" | "partial" | "missing" | "inconclusive";
  earliestGapDate: string | null;
  latestGapDate: string | null;
}

export interface CoverageResult {
  generatedAt: string;
  summary: {
    mappings: number;
    campaignsFetched: number;
    campaignFetchFailures: number;
    dateTuples: number;
    ok: number;
    partial: number;
    missing: number;
    inconclusive: number;
  };
  perLocation: LocationCoverage[];
  rows: CoverageRow[];
  campaignFetchFailures: Array<{ campaignId: string; error: string }>;
}

export interface CoverageFilters {
  clientIds?: string[];
  locationIds?: string[];
  sinceMs?: number | null;
  untilMs?: number | null;
}

const ACTIVE_KEYWORD_STATUSES = new Set(["COLLECTED", "UNKNOWN", "ACTIVE"]);

interface CampaignMeta {
  reportDates: string[];
  activeKeywordCount: number | null;
  campaignError?: string;
  keywordError?: string;
  fetchedAt: number;
  /**
   * Set when the live SEMrush fetch failed and we fell back to the persisted
   * last-known-good snapshot from `semrush_campaign_metadata_cache`. The
   * `reportDates` and `activeKeywordCount` above come from that snapshot in
   * that case; `campaignError`/`keywordError` still carry the live failure
   * so the UI can explain why we fell back.
   */
  usedCachedMetadata?: boolean;
  cachedMetadataAt?: string | null;
}

const CAMPAIGN_TTL_MS = 10 * 60 * 1000;
const campaignMetaCache = new Map<string, CampaignMeta>();

interface CoverageCacheEntry {
  key: string;
  computedAt: number;
  result: CoverageResult;
}
const COVERAGE_TTL_MS = 5 * 60 * 1000;
let coverageCache: CoverageCacheEntry | null = null;

function countActive(kws: Array<{ status?: string }> | undefined): number | null {
  if (!Array.isArray(kws)) return null;
  return kws.filter((k) =>
    ACTIVE_KEYWORD_STATUSES.has(String(k?.status || "").toUpperCase()),
  ).length;
}

/**
 * Persist the last successful (reportDates, activeKeywordCount) snapshot for
 * a campaign so we can fall back to it during SEMrush outages. Only call
 * after BOTH sub-fetches succeeded — partial successes (e.g. campaign OK,
 * keywords failed) intentionally do NOT overwrite a healthy snapshot.
 */
async function persistCampaignMetadata(
  campaignId: string,
  reportDates: string[],
  activeKeywordCount: number | null,
): Promise<void> {
  try {
    await db
      .insert(semrushCampaignMetadataCache)
      .values({
        campaignId,
        reportDates,
        activeKeywordCount,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: semrushCampaignMetadataCache.campaignId,
        set: {
          reportDates,
          activeKeywordCount,
          fetchedAt: new Date(),
        },
      });
  } catch (err: any) {
    console.warn(
      `[heatmapCoverage] failed to persist campaign metadata for ${campaignId}: ${err?.message || err}`,
    );
  }
}

async function loadPersistedCampaignMetadata(
  campaignId: string,
): Promise<{ reportDates: string[]; activeKeywordCount: number | null; fetchedAt: Date } | null> {
  try {
    const [row] = await db
      .select()
      .from(semrushCampaignMetadataCache)
      .where(eq(semrushCampaignMetadataCache.campaignId, campaignId))
      .limit(1);
    if (!row) return null;
    return {
      reportDates: Array.isArray(row.reportDates) ? row.reportDates : [],
      activeKeywordCount: row.activeKeywordCount,
      fetchedAt: row.fetchedAt,
    };
  } catch (err: any) {
    console.warn(
      `[heatmapCoverage] failed to load persisted campaign metadata for ${campaignId}: ${err?.message || err}`,
    );
    return null;
  }
}

async function loadCampaignMeta(
  campaignId: string,
  opts: { skipMemoryCache?: boolean } = {},
): Promise<CampaignMeta> {
  if (!opts.skipMemoryCache) {
    const cached = campaignMetaCache.get(campaignId);
    if (cached && Date.now() - cached.fetchedAt < CAMPAIGN_TTL_MS) {
      return cached;
    }
  }

  let reportDates: string[] = [];
  let campaignError: string | undefined;
  let liveCampaignOk = false;
  try {
    const camp = await getCampaign(campaignId);
    reportDates = Array.isArray(camp?.reportDates) ? camp.reportDates : [];
    liveCampaignOk = true;
  } catch (err: any) {
    campaignError = err?.message || String(err);
  }

  let activeKeywordCount: number | null = null;
  let keywordError: string | undefined;
  let liveKeywordsOk = false;
  try {
    const kws = await getCampaignKeywords(campaignId);
    activeKeywordCount = countActive(kws);
    liveKeywordsOk = true;
  } catch (err: any) {
    keywordError = err?.message || String(err);
  }

  let usedCachedMetadata = false;
  let cachedMetadataAt: string | null = null;

  if (liveCampaignOk && liveKeywordsOk) {
    // Both halves succeeded — refresh the persisted snapshot.
    await persistCampaignMetadata(campaignId, reportDates, activeKeywordCount);
  } else {
    // Live fetch failed (in whole or part). Fall back to the persisted
    // snapshot for whichever piece(s) we couldn't refresh, so the coverage
    // panel can still classify gaps during a SEMrush outage.
    const persisted = await loadPersistedCampaignMetadata(campaignId);
    if (persisted) {
      if (!liveCampaignOk) {
        reportDates = persisted.reportDates;
        usedCachedMetadata = true;
      }
      if (!liveKeywordsOk) {
        activeKeywordCount = persisted.activeKeywordCount;
        usedCachedMetadata = true;
      }
      if (usedCachedMetadata) {
        cachedMetadataAt = persisted.fetchedAt.toISOString();
      }
    }
  }

  const meta: CampaignMeta = {
    reportDates,
    activeKeywordCount,
    campaignError,
    keywordError,
    fetchedAt: Date.now(),
    usedCachedMetadata,
    cachedMetadataAt,
  };
  campaignMetaCache.set(campaignId, meta);
  return meta;
}

/**
 * Force a fresh metadata fetch for a single campaign, bypassing the
 * in-process TTL cache. Returns the resulting `CampaignMeta` so callers can
 * report whether the live fetch succeeded or whether we fell back to the
 * persisted snapshot. Also invalidates the coverage result cache so the
 * panel reflects the new state on its next refresh.
 */
export async function refreshCampaignMetadata(
  campaignId: string,
): Promise<CampaignMeta> {
  campaignMetaCache.delete(campaignId);
  const meta = await loadCampaignMeta(campaignId, { skipMemoryCache: true });
  invalidateHeatmapCoverageCache();
  return meta;
}

function dayBounds(rd: string): { start: Date; end: Date } | null {
  const t = new Date(rd);
  if (Number.isNaN(t.getTime())) return null;
  const start = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0, 0),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function filterKey(filters: CoverageFilters): string {
  return JSON.stringify({
    clientIds: filters.clientIds?.slice().sort() ?? null,
    locationIds: filters.locationIds?.slice().sort() ?? null,
    sinceMs: filters.sinceMs ?? null,
    untilMs: filters.untilMs ?? null,
  });
}

/**
 * Compute coverage. Set `force=true` to bypass the in-memory result cache
 * (e.g. when the operator hits "Refresh"). Per-campaign SEMrush fetches are
 * still cached at the campaign level to keep refresh cheap.
 */
export async function computeHeatmapCoverage(
  filters: CoverageFilters = {},
  opts: { force?: boolean } = {},
): Promise<CoverageResult> {
  const key = filterKey(filters);
  if (
    !opts.force &&
    coverageCache &&
    coverageCache.key === key &&
    Date.now() - coverageCache.computedAt < COVERAGE_TTL_MS
  ) {
    return coverageCache.result;
  }

  const conditions = [eq(semrushLocationCampaigns.isStale, false)];
  if (filters.clientIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.clientId} IN (${sql.join(
        filters.clientIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  if (filters.locationIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.locationId} IN (${sql.join(
        filters.locationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }

  const mappings = await db
    .select({
      clientId: semrushLocationCampaigns.clientId,
      clientName: clients.firmName,
      locationId: semrushLocationCampaigns.locationId,
      locationName: clientLocations.name,
      campaignId: semrushLocationCampaigns.semrushCampaignId,
      campaignName: semrushLocationCampaigns.semrushCampaignName,
    })
    .from(semrushLocationCampaigns)
    .leftJoin(clients, eq(clients.id, semrushLocationCampaigns.clientId))
    .leftJoin(
      clientLocations,
      eq(clientLocations.id, semrushLocationCampaigns.locationId),
    )
    .where(and(...conditions));

  // Restrict to multi-location clients (the surface the task actually
  // targets — single-location clients are a degenerate case where coverage
  // gaps are obvious from the existing dashboard). When a caller scopes the
  // request to specific locationIds we skip the filter so a drill-down on a
  // single location still works.
  const scopedToSpecificLocations = !!filters.locationIds?.length;
  const clientLocationCounts = new Map<string, Set<string>>();
  for (const m of mappings) {
    if (!clientLocationCounts.has(m.clientId)) {
      clientLocationCounts.set(m.clientId, new Set());
    }
    clientLocationCounts.get(m.clientId)!.add(m.locationId);
  }
  const eligibleMappings = scopedToSpecificLocations
    ? mappings
    : mappings.filter(
        (m) => (clientLocationCounts.get(m.clientId)?.size ?? 0) > 1,
      );

  const rows: CoverageRow[] = [];
  const campaignFetchFailures = new Map<string, string>();
  const seenCampaigns = new Set<string>();

  // Hit per-campaign metadata once even when the campaign maps to multiple
  // locations.
  const campaignMetaPromises = new Map<string, Promise<CampaignMeta>>();
  function getMeta(cid: string): Promise<CampaignMeta> {
    let p = campaignMetaPromises.get(cid);
    if (!p) {
      p = loadCampaignMeta(cid);
      campaignMetaPromises.set(cid, p);
    }
    return p;
  }

  for (const m of eligibleMappings) {
    const meta = await getMeta(m.campaignId);
    seenCampaigns.add(m.campaignId);
    // Only count a live failure as a "campaign fetch failure" when we ALSO
    // had no cached fallback to rescue classification — otherwise the
    // top-of-panel banner would falsely tell operators those locations show
    // as inconclusive when they're actually being classified from cache.
    if (meta.campaignError && meta.reportDates.length === 0) {
      campaignFetchFailures.set(m.campaignId, meta.campaignError);
    }
    // If the live campaign fetch failed AND we have no cached reportDates to
    // fall back on, we can't classify any (clientId, locationId, campaignId,
    // reportDate) tuples — emit a single inconclusive row so operators see
    // the location at all.
    if (meta.campaignError && meta.reportDates.length === 0) {
      rows.push({
        clientId: m.clientId,
        clientName: m.clientName ?? "(unknown)",
        locationId: m.locationId,
        locationName: m.locationName ?? "(unknown)",
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        reportDate: "(campaign fetch failed)",
        expectedKeywords: null,
        actualSnapshots: 0,
        coverage: "inconclusive",
        note: `campaign fetch failed: ${meta.campaignError}`,
      });
      continue;
    }

    for (const rd of meta.reportDates) {
      const bounds = dayBounds(rd);
      if (!bounds) continue;
      const ts = bounds.start.getTime();
      if (filters.sinceMs != null && ts < filters.sinceMs) continue;
      if (filters.untilMs != null && ts > filters.untilMs) continue;

      const [{ count }] = await db
        .select({
          count: sql<number>`count(distinct ${heatmapSnapshots.keywordId})::int`,
        })
        .from(heatmapSnapshots)
        .where(
          and(
            eq(heatmapSnapshots.clientId, m.clientId),
            eq(heatmapSnapshots.locationId, m.locationId),
            eq(heatmapSnapshots.campaignId, m.campaignId),
            sql`${heatmapSnapshots.reportDate} >= ${bounds.start}`,
            sql`${heatmapSnapshots.reportDate} < ${bounds.end}`,
          ),
        );

      const actual = Number(count) || 0;
      const expected = meta.activeKeywordCount;

      let coverage: CoverageStatus;
      let note: string | undefined;
      if (expected === null) {
        coverage = "inconclusive";
        note = meta.keywordError
          ? `keyword fetch failed: ${meta.keywordError}`
          : "active keyword count unknown";
      } else if (expected === 0) {
        coverage = "ok";
        note = "campaign has no active keywords";
      } else if (actual === 0) {
        coverage = "missing";
      } else if (actual < expected) {
        coverage = "partial";
      } else {
        coverage = "ok";
      }

      // Surface the cached-metadata fallback in the row note so operators
      // know they're looking at last-known-good data, not a fresh classification.
      let rowNote = note;
      if (meta.usedCachedMetadata && meta.cachedMetadataAt) {
        const cachedDay = meta.cachedMetadataAt.slice(0, 10);
        const prefix = `using cached SEMrush metadata from ${cachedDay}`;
        rowNote = rowNote ? `${prefix}; ${rowNote}` : prefix;
      }

      rows.push({
        clientId: m.clientId,
        clientName: m.clientName ?? "(unknown)",
        locationId: m.locationId,
        locationName: m.locationName ?? "(unknown)",
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        reportDate: rd,
        expectedKeywords: expected,
        actualSnapshots: actual,
        coverage,
        note: rowNote,
        usedCachedMetadata: meta.usedCachedMetadata || undefined,
        cachedMetadataAt: meta.usedCachedMetadata ? meta.cachedMetadataAt : undefined,
      });
    }
  }

  // Aggregate by location.
  const byLoc = new Map<string, LocationCoverage & { _campaigns: Set<string>; _gapDates: string[] }>();
  for (const r of rows) {
    const k = `${r.clientId}::${r.locationId}`;
    let agg = byLoc.get(k);
    if (!agg) {
      agg = {
        clientId: r.clientId,
        clientName: r.clientName,
        locationId: r.locationId,
        locationName: r.locationName,
        total: 0,
        ok: 0,
        partial: 0,
        missing: 0,
        inconclusive: 0,
        campaignCount: 0,
        status: "ok",
        earliestGapDate: null,
        latestGapDate: null,
        _campaigns: new Set<string>(),
        _gapDates: [],
      };
      byLoc.set(k, agg);
    }
    agg.total++;
    agg[r.coverage]++;
    agg._campaigns.add(r.campaignId);
    if (r.coverage === "missing" || r.coverage === "partial") {
      agg._gapDates.push(r.reportDate);
    }
  }

  const perLocation: LocationCoverage[] = Array.from(byLoc.values()).map((a) => {
    const status: LocationCoverage["status"] =
      a.missing > 0
        ? "missing"
        : a.partial > 0
        ? "partial"
        : a.inconclusive > 0
        ? "inconclusive"
        : "ok";
    const sorted = a._gapDates
      .map((d) => d.slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    return {
      clientId: a.clientId,
      clientName: a.clientName,
      locationId: a.locationId,
      locationName: a.locationName,
      total: a.total,
      ok: a.ok,
      partial: a.partial,
      missing: a.missing,
      inconclusive: a.inconclusive,
      campaignCount: a._campaigns.size,
      status,
      earliestGapDate: sorted[0] ?? null,
      latestGapDate: sorted[sorted.length - 1] ?? null,
    };
  });

  perLocation.sort((x, y) =>
    `${x.clientName}/${x.locationName}`.localeCompare(
      `${y.clientName}/${y.locationName}`,
    ),
  );

  const summary = {
    mappings: eligibleMappings.length,
    campaignsFetched: seenCampaigns.size - campaignFetchFailures.size,
    campaignFetchFailures: campaignFetchFailures.size,
    dateTuples: rows.length,
    ok: rows.filter((r) => r.coverage === "ok").length,
    partial: rows.filter((r) => r.coverage === "partial").length,
    missing: rows.filter((r) => r.coverage === "missing").length,
    inconclusive: rows.filter((r) => r.coverage === "inconclusive").length,
  };

  const result: CoverageResult = {
    generatedAt: new Date().toISOString(),
    summary,
    perLocation,
    rows,
    campaignFetchFailures: Array.from(campaignFetchFailures, ([campaignId, error]) => ({
      campaignId,
      error,
    })),
  };

  coverageCache = { key, computedAt: Date.now(), result };
  return result;
}

/**
 * Per-(clientId, locationId) drill-down: returns the same coverage rows
 * filtered to one location, plus a list of "gap windows" per campaign that
 * the UI can hand straight to the backfill rerun endpoint.
 */
export interface LocationDrilldown {
  clientId: string;
  locationId: string;
  rows: CoverageRow[];
  gapWindows: Array<{
    campaignId: string;
    campaignName: string | null;
    sinceDate: string;
    untilDate: string;
    reportDates: string[];
  }>;
  generatedAt: string;
}

export async function getLocationDrilldown(
  clientId: string,
  locationId: string,
  opts: { force?: boolean; sinceMs?: number | null; untilMs?: number | null } = {},
): Promise<LocationDrilldown> {
  const result = await computeHeatmapCoverage(
    {
      clientIds: [clientId],
      locationIds: [locationId],
      sinceMs: opts.sinceMs ?? null,
      untilMs: opts.untilMs ?? null,
    },
    { force: opts.force },
  );
  const rows = result.rows.filter(
    (r) => r.clientId === clientId && r.locationId === locationId,
  );
  const gaps = rows.filter(
    (r) => r.coverage === "missing" || r.coverage === "partial",
  );
  const byCampaign = new Map<
    string,
    { campaignId: string; campaignName: string | null; reportDates: Set<string> }
  >();
  for (const r of gaps) {
    let g = byCampaign.get(r.campaignId);
    if (!g) {
      g = {
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        reportDates: new Set(),
      };
      byCampaign.set(r.campaignId, g);
    }
    const day = r.reportDate.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) g.reportDates.add(day);
  }
  const gapWindows = Array.from(byCampaign.values()).map((g) => {
    const sorted = Array.from(g.reportDates).sort();
    return {
      campaignId: g.campaignId,
      campaignName: g.campaignName,
      sinceDate: sorted[0],
      untilDate: sorted[sorted.length - 1],
      reportDates: sorted,
    };
  });
  return {
    clientId,
    locationId,
    rows,
    gapWindows,
    generatedAt: result.generatedAt,
  };
}

export function invalidateHeatmapCoverageCache() {
  coverageCache = null;
}
