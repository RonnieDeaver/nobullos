import { randomUUID } from "crypto";
import { db, withDbHoldLabel } from "../db";
import { dbRetry } from "../db";
import {
  heatmapSnapshots, heatmapPoints, heatmapMetrics, heatmapOverrides,
  heatmapCompetitorSnapshots,
  type HeatmapSnapshot, type HeatmapPoint, type HeatmapMetric,
  type InsertHeatmapSnapshot, type InsertHeatmapPoint,
  clients,
} from "@shared/schema";
import { eq, desc, and, ilike, or, sql, gte, lte, inArray } from "drizzle-orm";
import { normalizeKeyword } from "@shared/keywordNormalization";
import {
  HEATMAP_RANK_COLORS as RANK_COLORS,
  HEATMAP_MOVEMENT_COLORS as MOVEMENT_COLORS,
} from "@shared/heatmapColors";

interface RawSemrushPoint {
  id?: string;
  lat: number;
  lng: number;
  position?: number | null;
  diff?: number | null;
  is_enabled?: boolean;
}

export interface SemrushImportPayload {
  clientId?: string;
  locationId: string;
  locationName: string;
  businessName?: string;
  campaignId: string;
  keywordId?: string;
  keywordName: string;
  reportDate: string;
  businessLat: number;
  businessLng: number;
  gridTemplate: string;
  gridUnit: string;
  gridDistance: number;
  baseLat: number;
  baseLng: number;
  pointsNumber?: number;
  points: RawSemrushPoint[];
  cid?: string;
  placeIds?: string[];
  campaignReportDates?: string[];
}

function getRankColor(position: number | null | undefined): string {
  if (!position || position <= 0) return RANK_COLORS.unranked;
  if (position <= 3) return RANK_COLORS.top3;
  if (position <= 10) return RANK_COLORS.top10;
  if (position <= 20) return RANK_COLORS.top20;
  return RANK_COLORS.beyond20;
}

function getMovementColor(diff: number | null | undefined): string {
  if (diff === null || diff === undefined || diff === 0) return MOVEMENT_COLORS.stable;
  if (diff > 0) return MOVEMENT_COLORS.improved;
  return MOVEMENT_COLORS.declined;
}

function getRankLabel(position: number | null | undefined): string {
  if (!position || position <= 0) return "Not ranked";
  return `${position}`;
}

function getMovementLabel(diff: number | null | undefined): string {
  if (diff === null || diff === undefined || diff === 0) return "No change";
  if (diff > 0) return `↑${diff}`;
  return `↓${Math.abs(diff)}`;
}

function parseGridDimension(template: string): number {
  const match = template.match(/^(\d+)x\d+$/);
  return match ? parseInt(match[1], 10) : 9;
}

/**
 * Bumped whenever the *geometry* baked into `geojson_cache` changes shape.
 *
 * Task #2605: pre-fix caches sized each cell from the median of consecutive
 * inter-point gaps, which collapsed to a degenerate sliver for jittered /
 * non-axis-aligned SEMrush coordinates (e.g. Ackah Calgary). `recolorCachedGeoJSON`
 * only re-derives colors/labels, never geometry, so a stale cache keeps serving
 * slivers until it is rebuilt from the points table. We stamp this version onto
 * every freshly-built FeatureCollection; caches without it (or with a lower
 * version) are detected on serve and rebuilt. Pre-Task-#2605 caches have no
 * marker (treated as version 0).
 */
export const GEOJSON_GEOMETRY_VERSION = 2;

const MIN_CELL_DEG = 0.001;

/**
 * Derive the per-cell lat/lng span (in degrees) for a heatmap snapshot.
 *
 * Primary strategy (Task #2605): tile the full coordinate extent across
 * `(gridDim - 1)` intervals — `(maxLat - minLat) / (gridDim - 1)` and the
 * longitude equivalent. This produces cells that tile the whole service area
 * even when SEMrush returns jittered, non-axis-aligned coordinates (where the
 * old median-of-gaps approach floored the longitude size to `MIN_CELL_DEG` and
 * rendered thin vertical slivers). For a genuinely clean, evenly-spaced grid the
 * extent / (gridDim - 1) equals the inter-point gap, so there is no regression.
 *
 * Fallback: when the coordinate extent or grid dimension can't yield a usable
 * size (a single point, zero span on an axis, or a degenerate dimension), size
 * from the configured grid distance + unit. A `MIN_CELL_DEG` floor guards
 * against any degenerate result.
 */
export function deriveCellSizeDeg(
  snapshot: Pick<HeatmapSnapshot, "gridTemplate" | "gridDistance" | "gridUnit" | "baseLat">,
  points: Array<{ lat: number; lng: number }>,
): { cellSizeLat: number; cellSizeLng: number } {
  const gridDim = parseGridDimension(snapshot.gridTemplate);

  let latSpan = 0;
  let lngSpan = 0;
  if (points.length > 0) {
    let minLat = points[0].lat, maxLat = points[0].lat;
    let minLng = points[0].lng, maxLng = points[0].lng;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    latSpan = maxLat - minLat;
    lngSpan = maxLng - minLng;
  }

  // Fallback from the configured grid distance/unit + dimension.
  const totalDistance = snapshot.gridDistance;
  const isMetric = snapshot.gridUnit === "KM";
  const distKm = isMetric ? totalDistance : totalDistance * 1.60934;
  const totalSpanKm = distKm * 2;
  const denom = gridDim - 1 || 1;
  const fbLat = (totalSpanKm / 111.32) / denom;
  const fbLng = (totalSpanKm / (111.32 * Math.cos((snapshot.baseLat * Math.PI) / 180))) / denom;

  const extentUsable = gridDim >= 2;
  let cellSizeLat = extentUsable && latSpan > 0 ? latSpan / (gridDim - 1) : fbLat;
  let cellSizeLng = extentUsable && lngSpan > 0 ? lngSpan / (gridDim - 1) : fbLng;

  cellSizeLat = Math.max(cellSizeLat || fbLat || MIN_CELL_DEG, MIN_CELL_DEG);
  cellSizeLng = Math.max(cellSizeLng || fbLng || MIN_CELL_DEG, MIN_CELL_DEG);

  return { cellSizeLat, cellSizeLng };
}

function generateCellPolygon(
  centerLat: number,
  centerLng: number,
  cellSizeLat: number,
  cellSizeLng: number
): number[][] {
  const halfLat = cellSizeLat / 2;
  const halfLng = cellSizeLng / 2;
  return [
    [centerLng - halfLng, centerLat - halfLat],
    [centerLng + halfLng, centerLat - halfLat],
    [centerLng + halfLng, centerLat + halfLat],
    [centerLng - halfLng, centerLat + halfLat],
    [centerLng - halfLng, centerLat - halfLat],
  ];
}

function computeMetrics(points: Array<{ position: number | null | undefined; diff: number | null | undefined }>) {
  const ranked = points.filter(p => p.position && p.position > 0);
  const positions = ranked.map(p => p.position!).sort((a, b) => a - b);

  const avgRank = positions.length > 0
    ? positions.reduce((s, v) => s + v, 0) / positions.length
    : null;

  const medianRank = positions.length > 0
    ? positions.length % 2 === 0
      ? (positions[positions.length / 2 - 1] + positions[positions.length / 2]) / 2
      : positions[Math.floor(positions.length / 2)]
    : null;

  const total = points.length || 1;
  let top3 = 0, band4to10 = 0, band11to20 = 0, outOfTop20 = 0;
  for (const pt of points) {
    const pos = pt.position;
    if (!pos || pos <= 0) {
      outOfTop20++;
    } else if (pos <= 3) {
      top3++;
    } else if (pos <= 10) {
      band4to10++;
    } else if (pos <= 20) {
      band11to20++;
    } else {
      outOfTop20++;
    }
  }

  return {
    avgRank: avgRank ? Math.round(avgRank * 100) / 100 : null,
    medianRank: medianRank ? Math.round(medianRank * 100) / 100 : null,
    bestRank: positions.length > 0 ? positions[0] : null,
    worstRank: positions.length > 0 ? positions[positions.length - 1] : null,
    top3CoveragePct: Math.round((ranked.filter(p => p.position! <= 3).length / total) * 10000) / 100,
    top10CoveragePct: Math.round((ranked.filter(p => p.position! <= 10).length / total) * 10000) / 100,
    rankedPointsCount: ranked.length,
    unrankedPointsCount: points.length - ranked.length,
    bandTop3Pct: Math.round((top3 / total) * 10000) / 100,
    band4to10Pct: Math.round((band4to10 / total) * 10000) / 100,
    band11to20Pct: Math.round((band11to20 / total) * 10000) / 100,
    bandOutOfTop20Pct: Math.round((outOfTop20 / total) * 10000) / 100,
  };
}

export function buildGeoJSON(
  snapshot: HeatmapSnapshot,
  points: HeatmapPoint[],
  mode: "rank" | "movement" = "rank"
) {
  const { cellSizeLat, cellSizeLng } = deriveCellSizeDeg(snapshot, points);

  const uniqueLats = [...new Set(points.map(p => p.lat))].sort((a, b) => a - b);
  const uniqueLngs = [...new Set(points.map(p => p.lng))].sort((a, b) => a - b);

  const minLat = uniqueLats[0], maxLat = uniqueLats[uniqueLats.length - 1];
  const minLng = uniqueLngs[0], maxLng = uniqueLngs[uniqueLngs.length - 1];
  const latEps = cellSizeLat * 0.1;
  const lngEps = cellSizeLng * 0.1;

  const features = points.map((pt, idx) => {
    const rankColor = getRankColor(pt.position);
    const movementColor = getMovementColor(pt.diff);
    const color = mode === "rank" ? rankColor : movementColor;
    const label = mode === "rank" ? getRankLabel(pt.position) : getMovementLabel(pt.diff);
    const isEdge = pt.lat <= minLat + latEps || pt.lat >= maxLat - latEps ||
                   pt.lng <= minLng + lngEps || pt.lng >= maxLng - lngEps;

    return {
      type: "Feature" as const,
      id: idx,
      properties: {
        pointId: pt.pointId,
        position: pt.position,
        diff: pt.diff,
        color,
        label,
        rankColor,
        movementColor,
        lat: pt.lat,
        lng: pt.lng,
        rankLabel: getRankLabel(pt.position),
        movementLabel: getMovementLabel(pt.diff),
        isEdge: isEdge ? 1 : 0,
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: [generateCellPolygon(pt.lat, pt.lng, cellSizeLat, cellSizeLng)],
      },
    };
  });

  const businessPin = {
    type: "Feature" as const,
    id: points.length,
    properties: {
      type: "business",
      name: snapshot.businessName || snapshot.locationName,
      lat: snapshot.businessLat,
      lng: snapshot.businessLng,
    },
    geometry: {
      type: "Point" as const,
      coordinates: [snapshot.businessLng, snapshot.businessLat],
    },
  };

  return {
    type: "FeatureCollection" as const,
    geometryVersion: GEOJSON_GEOMETRY_VERSION,
    features: [...features, businessPin],
  };
}

const VALID_GRID_TEMPLATES = new Set(["5x5", "7x7", "9x9", "11x11", "13x13", "15x15"]);
const VALID_GRID_UNITS = new Set(["MILES", "KM"]);

function isAbortLike(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const msg = err.message || "";
    if (msg.startsWith("Sync cancelled before SEMrush API call")) return true;
    if (msg.startsWith("Sync cancelled during SEMrush API call")) return true;
  }
  return false;
}

function validateImportPayload(payload: SemrushImportPayload): string | null {
  if (!payload.locationId || typeof payload.locationId !== "string") return "locationId is required";
  if (!payload.locationName || typeof payload.locationName !== "string") return "locationName is required";
  if (!payload.campaignId || typeof payload.campaignId !== "string") return "campaignId is required";
  if (!payload.keywordName || typeof payload.keywordName !== "string") return "keywordName is required";
  if (!payload.reportDate) return "reportDate is required";
  if (isNaN(new Date(payload.reportDate).getTime())) return "reportDate is invalid";
  if (typeof payload.businessLat !== "number" || typeof payload.businessLng !== "number") return "businessLat/businessLng must be numbers";
  if (typeof payload.baseLat !== "number" || typeof payload.baseLng !== "number") return "baseLat/baseLng must be numbers";
  if (!payload.gridTemplate || !VALID_GRID_TEMPLATES.has(payload.gridTemplate)) return `gridTemplate must be one of: ${[...VALID_GRID_TEMPLATES].join(", ")}`;
  if (!payload.gridUnit || !VALID_GRID_UNITS.has(payload.gridUnit)) return `gridUnit must be MILES or KM`;
  if (typeof payload.gridDistance !== "number" || payload.gridDistance <= 0) return "gridDistance must be a positive number";
  if (!Array.isArray(payload.points) || payload.points.length === 0) return "points array is required and must not be empty";
  for (let i = 0; i < payload.points.length; i++) {
    const pt = payload.points[i];
    if (typeof pt.lat !== "number" || typeof pt.lng !== "number") return `points[${i}] must have numeric lat/lng`;
  }
  return null;
}

/**
 * Everything a heatmap import needs to persist, fully computed BEFORE the
 * write transaction opens (audit C-T1, "stage outside, commit inside").
 *
 * All values are derived purely from the immutable import payload plus a
 * caller-supplied snapshot id (generated up front so point rows and the
 * GeoJSON cache — whose `pointId` fallback embeds the snapshot id — can be
 * staged without waiting for the snapshot INSERT to return one).
 */
export interface StagedHeatmapImport {
  snapshotId: string;
  normalizedKeywordName: string;
  dayStart: Date;
  dayEnd: Date;
  snapshotValues: typeof heatmapSnapshots.$inferInsert & { id: string; rawPayload: SemrushImportPayload };
  pointRows: InsertHeatmapPoint[];
  metrics: ReturnType<typeof computeMetrics>;
  geojson: ReturnType<typeof buildGeoJSON>;
}

function getHeatmapImportIdentity(payload: SemrushImportPayload): {
  normalizedKeywordName: string;
  dayStart: Date;
  dayEnd: Date;
} {
  const reportDate = new Date(payload.reportDate);
  const dateOnly = reportDate.toISOString().split("T")[0];
  return {
    normalizedKeywordName: normalizeKeyword(payload.keywordName),
    dayStart: new Date(dateOnly + "T00:00:00.000Z"),
    dayEnd: new Date(dateOnly + "T23:59:59.999Z"),
  };
}

/** Deterministic, key-order-independent stringify for material scan equality. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort()
    .map((key) => JSON.stringify(key) + ":" + stableStringify(record[key]))
    .join(",") + "}";
}

type MaterialSnapshot = Pick<
  HeatmapSnapshot,
  | "locationName"
  | "businessName"
  | "keywordId"
  | "keywordName"
  | "reportDate"
  | "businessLat"
  | "businessLng"
  | "gridTemplate"
  | "gridUnit"
  | "gridDistance"
  | "baseLat"
  | "baseLng"
  | "pointsNumber"
>;

type MaterialPoint = Pick<
  HeatmapPoint,
  "pointIndex" | "lat" | "lng" | "position" | "diff" | "isEnabled"
>;

function buildMaterialScan(
  snapshot: MaterialSnapshot,
  points: MaterialPoint[],
): unknown {
  return {
    locationName: snapshot.locationName,
    businessName: snapshot.businessName ?? null,
    keywordId: snapshot.keywordId ?? null,
    keywordName: normalizeKeyword(snapshot.keywordName),
    reportDate: new Date(snapshot.reportDate).toISOString(),
    businessLat: snapshot.businessLat,
    businessLng: snapshot.businessLng,
    gridTemplate: snapshot.gridTemplate,
    gridUnit: snapshot.gridUnit,
    gridDistance: snapshot.gridDistance,
    baseLat: snapshot.baseLat,
    baseLng: snapshot.baseLng,
    pointsNumber: snapshot.pointsNumber ?? points.length,
    points: points.map((point) => ({
      pointIndex: point.pointIndex,
      lat: point.lat,
      lng: point.lng,
      position: point.position ?? null,
      diff: point.diff ?? null,
      isEnabled: point.isEnabled !== false,
    })),
  };
}

function metricsFromStoredRow(metric: HeatmapMetric | undefined): ReturnType<typeof computeMetrics> {
  return {
    avgRank: metric?.avgRank ?? null,
    medianRank: metric?.medianRank ?? null,
    bestRank: metric?.bestRank ?? null,
    worstRank: metric?.worstRank ?? null,
    top3CoveragePct: metric?.top3CoveragePct ?? 0,
    top10CoveragePct: metric?.top10CoveragePct ?? 0,
    rankedPointsCount: metric?.rankedPointsCount ?? 0,
    unrankedPointsCount: metric?.unrankedPointsCount ?? 0,
    bandTop3Pct: metric?.bandTop3Pct ?? 0,
    band4to10Pct: metric?.band4to10Pct ?? 0,
    band11to20Pct: metric?.band11to20Pct ?? 0,
    bandOutOfTop20Pct: metric?.bandOutOfTop20Pct ?? 0,
  };
}

function buildMetricInsertValues(
  snapshotId: string,
  metrics: ReturnType<typeof computeMetrics>,
) {
  return {
    snapshotId,
    avgRank: metrics.avgRank,
    medianRank: metrics.medianRank,
    bestRank: metrics.bestRank,
    worstRank: metrics.worstRank,
    top3CoveragePct: metrics.top3CoveragePct,
    top10CoveragePct: metrics.top10CoveragePct,
    rankedPointsCount: metrics.rankedPointsCount,
    unrankedPointsCount: metrics.unrankedPointsCount,
    bandTop3Pct: metrics.bandTop3Pct,
    band4to10Pct: metrics.band4to10Pct,
    band11to20Pct: metrics.band11to20Pct,
    bandOutOfTop20Pct: metrics.bandOutOfTop20Pct,
  };
}

function isExactStoredReplay(
  staged: StagedHeatmapImport,
  existingSnapshot: HeatmapSnapshot,
  existingPoints: HeatmapPoint[],
  existingMetric: HeatmapMetric | undefined,
): boolean {
  if (!existingMetric || !existingSnapshot.geojsonCache) return false;
  return stableStringify(buildMaterialScan(existingSnapshot, existingPoints))
      === stableStringify(buildMaterialScan(
        staged.snapshotValues as unknown as MaterialSnapshot,
        staged.pointRows as unknown as MaterialPoint[],
      ))
    && stableStringify(metricsFromStoredRow(existingMetric)) === stableStringify(staged.metrics)
    && stableStringify(existingSnapshot.geojsonCache) === stableStringify(staged.geojson);
}

/**
 * Pure staging step for `importHeatmap`: normalizes the payload, prepares all
 * point rows, computes metrics, and builds the complete GeoJSON cache value.
 * No I/O — safe to call outside any transaction, and the test seam for
 * verifying that CPU-heavy work happens before the commit window.
 */
export function stageHeatmapImport(payload: SemrushImportPayload, snapshotId: string): StagedHeatmapImport {
  const reportDate = new Date(payload.reportDate);
  const { normalizedKeywordName, dayStart, dayEnd } = getHeatmapImportIdentity(payload);

  const snapshotValues = {
    id: snapshotId,
    clientId: payload.clientId || null,
    locationId: payload.locationId,
    locationName: payload.locationName,
    businessName: payload.businessName,
    campaignId: payload.campaignId,
    keywordId: payload.keywordId,
    keywordName: payload.keywordName,
    reportDate: reportDate,
    businessLat: payload.businessLat,
    businessLng: payload.businessLng,
    gridTemplate: payload.gridTemplate,
    gridUnit: payload.gridUnit,
    gridDistance: payload.gridDistance,
    baseLat: payload.baseLat,
    baseLng: payload.baseLng,
    pointsNumber: payload.pointsNumber || payload.points.length,
    rawPayload: payload,
  };

  const pointRows: InsertHeatmapPoint[] = payload.points.map((pt, idx) => ({
    snapshotId,
    pointId: pt.id || `${snapshotId}-${idx}`,
    pointIndex: idx,
    lat: pt.lat,
    lng: pt.lng,
    position: pt.position ?? null,
    diff: pt.diff ?? null,
    isEnabled: pt.is_enabled !== false,
  }));

  const metrics = computeMetrics(payload.points.map(p => ({
    position: p.position,
    diff: p.diff,
  })));

  // buildGeoJSON only reads payload-derived snapshot fields (grid settings,
  // business name/coords), all of which are stored verbatim by the INSERT
  // below — so the pre-built value is identical to one built post-insert.
  const geojson = buildGeoJSON(
    snapshotValues as unknown as HeatmapSnapshot,
    pointRows.map((pr, i) => ({
      ...pr,
      id: `temp-${i}`,
      createdAt: new Date(),
    })) as HeatmapPoint[],
  );

  return { snapshotId, normalizedKeywordName, dayStart, dayEnd, snapshotValues, pointRows, metrics, geojson };
}

export async function importHeatmap(payload: SemrushImportPayload, signal?: AbortSignal): Promise<{
  snapshotId: string;
  pointCount: number;
  metrics: ReturnType<typeof computeMetrics>;
  status: "created" | "unchanged" | "refreshed";
}> {
  const validationError = validateImportPayload(payload);
  if (validationError) {
    throw new Error(`Validation failed: ${validationError}`);
  }

  // Task #4054 — capture the client link at snapshot creation. Callers that
  // know the client pass it; when absent, resolve it here via the SAME
  // unambiguous campaign→client rule the backfill prod-action uses, so
  // routine imports stop producing NULL-client rows for the backfill to mop
  // up every few days. NULL stays NULL only for genuinely ambiguous or
  // unmatched campaigns (surface, never guess). Best-effort: a resolution
  // failure degrades to the pre-#4054 behavior (NULL) rather than blocking
  // the import.
  if (!payload.clientId) {
    try {
      const { resolveUnambiguousClientForCampaign } = await import(
        "./heatmapClientBackfill"
      );
      const resolved = await resolveUnambiguousClientForCampaign(
        db,
        payload.campaignId,
      );
      if (resolved) payload = { ...payload, clientId: resolved };
    } catch (err: any) {
      console.warn(
        `[Heatmap Import] Client-link resolution failed for campaign ${payload.campaignId} (non-fatal, snapshot stays unlinked):`,
        err?.message,
      );
    }
  }

  // A read-only identity hint lets changed same-day scans stage point ids and
  // GeoJSON against the existing snapshot id before the write transaction.
  // The authoritative identity decision is still revalidated under FOR UPDATE
  // below; a concurrent insert between these phases causes a bounded restage.
  const identity = getHeatmapImportIdentity(payload);
  const identityLockKey = [
    payload.campaignId,
    payload.locationId,
    identity.normalizedKeywordName,
    identity.dayStart.toISOString().slice(0, 10),
  ].map((part) => `${part.length}:${part}`).join("|");
  const hintedExisting = await withDbHoldLabel("semrush_heatmap_apply:identity_hint", () =>
    db.select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(
        and(
          eq(heatmapSnapshots.campaignId, payload.campaignId),
          sql`lower(regexp_replace(trim(${heatmapSnapshots.keywordName}), '\\s+', ' ', 'g')) = ${identity.normalizedKeywordName}`,
          eq(heatmapSnapshots.locationId, payload.locationId),
          gte(heatmapSnapshots.reportDate, identity.dayStart),
          lte(heatmapSnapshots.reportDate, identity.dayEnd),
        ),
      )
      .limit(1),
  );

  // Phase A/B (audit C-T1): all CPU-heavy staging — point-row preparation,
  // metrics computation, GeoJSON construction/serialization — happens before
  // the write transaction opens. A dbRetry re-attempt reuses the same staged
  // data (nothing committed on a failed attempt).
  let staged = stageHeatmapImport(payload, hintedExisting[0]?.id ?? randomUUID());

  // Pool Epic Phase 1.4: explicit hold-label attribution for the
  // heatmap-apply transaction. This is now a SHORT hold: only the
  // duplicate-day existence check plus the atomic writes of pre-staged
  // values. It stays visible on `/admin/db-attribution/trends` and trips
  // the >10s warn / >30s alert guards if it ever grows long again.
  // External SEMrush HTTP calls (metrics + competitors) happen post-commit
  // below — they are deliberately outside this hold window.
  type PersistedImportResult = {
    snapshotId: string;
    pointCount: number;
    metrics: ReturnType<typeof computeMetrics>;
    status: "created" | "unchanged" | "refreshed";
  };
  type RestageResult = { status: "restage"; snapshotId: string };

  let txResult: PersistedImportResult | undefined;
  for (let reconcileAttempt = 0; reconcileAttempt < 3; reconcileAttempt++) {
    const attemptResult = await dbRetry(async (): Promise<PersistedImportResult | RestageResult> => {
      return withDbHoldLabel("semrush_heatmap_apply:apply", () =>
        db.transaction(async (tx): Promise<PersistedImportResult | RestageResult> => {
      // No unique constraint exists for the canonical same-day identity.
      // Serialize both first inserts and later refreshes on that identity so
      // two concurrent importers cannot both observe "missing" and create
      // separate snapshots. The xact-scoped lock releases automatically.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${"semrush-heatmap:" + identityLockKey}, 42))`,
      );

      // Duplicate-import check MUST stay inside the transaction: it reads
      // mutable DB state (a concurrent import of the same campaign/keyword/
      // day) and gates whether we insert or reconcile. FOR UPDATE serializes
      // refreshes of an existing identity so readers can never observe mixed
      // snapshot/point/metric/cache versions. Identity here MUST stay
      // aligned with the coverage / stale-cleanup paths in
      // localDominanceSyncWorker, both of which use the same canonical
      // `normalizeKeyword` helper.
      const existing = await tx.select()
        .from(heatmapSnapshots)
        .where(
          and(
            eq(heatmapSnapshots.campaignId, payload.campaignId),
            sql`lower(regexp_replace(trim(${heatmapSnapshots.keywordName}), '\\s+', ' ', 'g')) = ${staged.normalizedKeywordName}`,
            eq(heatmapSnapshots.locationId, payload.locationId),
            gte(heatmapSnapshots.reportDate, staged.dayStart),
            lte(heatmapSnapshots.reportDate, staged.dayEnd),
          )
        )
        .for("update")
        .limit(1);

      if (existing.length > 0) {
        if (existing[0].id !== staged.snapshotId) {
          return { status: "restage", snapshotId: existing[0].id };
        }

        const existingPoints = await tx.select()
          .from(heatmapPoints)
          .where(eq(heatmapPoints.snapshotId, existing[0].id))
          .orderBy(heatmapPoints.pointIndex);
        const existingMetrics = await tx.select()
          .from(heatmapMetrics)
          .where(eq(heatmapMetrics.snapshotId, existing[0].id))
          .limit(1);
        const existingMetric = existingMetrics[0];

        if (isExactStoredReplay(staged, existing[0], existingPoints, existingMetric)) {
          return {
            snapshotId: existing[0].id,
            pointCount: existingPoints.length,
            metrics: metricsFromStoredRow(existingMetric),
            status: "unchanged",
          };
        }

        await tx.update(heatmapSnapshots)
          .set({
            clientId: staged.snapshotValues.clientId,
            locationId: staged.snapshotValues.locationId,
            locationName: staged.snapshotValues.locationName,
            businessName: staged.snapshotValues.businessName,
            campaignId: staged.snapshotValues.campaignId,
            keywordId: staged.snapshotValues.keywordId,
            keywordName: staged.snapshotValues.keywordName,
            reportDate: staged.snapshotValues.reportDate,
            businessLat: staged.snapshotValues.businessLat,
            businessLng: staged.snapshotValues.businessLng,
            gridTemplate: staged.snapshotValues.gridTemplate,
            gridUnit: staged.snapshotValues.gridUnit,
            gridDistance: staged.snapshotValues.gridDistance,
            baseLat: staged.snapshotValues.baseLat,
            baseLng: staged.snapshotValues.baseLng,
            pointsNumber: staged.snapshotValues.pointsNumber,
            rawPayload: staged.snapshotValues.rawPayload,
            // Never leave the prior scan's derived SoV attached to the new
            // grid if post-commit derivation or vendor enrichment fails.
            shareOfVoiceRaw: null,
            geojsonCache: staged.geojson,
          })
          .where(eq(heatmapSnapshots.id, existing[0].id));

        await tx.delete(heatmapPoints)
          .where(eq(heatmapPoints.snapshotId, existing[0].id));
        await tx.delete(heatmapMetrics)
          .where(eq(heatmapMetrics.snapshotId, existing[0].id));
        await tx.delete(heatmapCompetitorSnapshots)
          .where(eq(heatmapCompetitorSnapshots.snapshotId, existing[0].id));

        if (staged.pointRows.length > 0) {
          const batchSize = 500;
          for (let i = 0; i < staged.pointRows.length; i += batchSize) {
            await tx.insert(heatmapPoints).values(staged.pointRows.slice(i, i + batchSize));
          }
        }

        await tx.insert(heatmapMetrics)
          .values(buildMetricInsertValues(existing[0].id, staged.metrics));

        return {
          snapshotId: existing[0].id,
          pointCount: staged.pointRows.length,
          metrics: staged.metrics,
          status: "refreshed",
        };
      }

      // Phase C: atomic writes of pre-staged values only. No computation or
      // serialization happens inside this window.
      await tx.insert(heatmapSnapshots).values(staged.snapshotValues);

      if (staged.pointRows.length > 0) {
        const batchSize = 500;
        for (let i = 0; i < staged.pointRows.length; i += batchSize) {
          await tx.insert(heatmapPoints).values(staged.pointRows.slice(i, i + batchSize));
        }
      }

      await tx.insert(heatmapMetrics)
        .values(buildMetricInsertValues(staged.snapshotId, staged.metrics));

      await tx.update(heatmapSnapshots)
        .set({ geojsonCache: staged.geojson })
        .where(eq(heatmapSnapshots.id, staged.snapshotId));

      return {
        snapshotId: staged.snapshotId,
        pointCount: staged.pointRows.length,
        metrics: staged.metrics,
        status: "created",
      };
    }),
      );
    }, "importHeatmap");

    if (attemptResult.status === "restage") {
      staged = stageHeatmapImport(payload, attemptResult.snapshotId);
      continue;
    }
    txResult = attemptResult;
    break;
  }

  if (!txResult) {
    throw new Error("Heatmap import identity changed repeatedly during reconciliation");
  }

  if (txResult.status === "unchanged") {
    console.log(`[Heatmap Import] Exact replay skipped for snapshot ${txResult.snapshotId} (${txResult.pointCount} persisted points)`);
    return txResult;
  }

  if (txResult.status === "refreshed") {
    console.log(`[Heatmap Import] Refreshed snapshot ${txResult.snapshotId} in place with ${txResult.pointCount} points`);
  }

  const enrichmentErrors: string[] = [];

  try {
    const { computeAndStoreDerivedMetrics } = await import("./localDominanceService");
    const derivedResult = await computeAndStoreDerivedMetrics(txResult.snapshotId, payload);
    if (derivedResult.errors.length > 0) {
      enrichmentErrors.push(...derivedResult.errors);
    }
    console.log(`[Heatmap] Derived metrics for snapshot ${txResult.snapshotId}: bands=${derivedResult.bandsWritten}, sov=${derivedResult.sovWritten}, errors=${derivedResult.errors.length}`);
  } catch (err) {
    const msg = `Failed to compute derived metrics for snapshot ${txResult.snapshotId}: ${err instanceof Error ? err.message : err}`;
    console.error(`[Heatmap] ${msg}`);
    if (err instanceof Error && err.stack) {
      console.error("[Heatmap] Stack trace:", err.stack);
    }
    enrichmentErrors.push(msg);
  }

  if (payload.campaignId && payload.keywordId) {
    try {
      const { getCampaignMetrics, getTopCompetitors } = await import("./semrushApi");
      const { storeCompetitorData } = await import("./localDominanceService");

      try {
        const metricsOpts: { cid?: string; placeIds?: string[] } = {};
        if (payload.cid) metricsOpts.cid = payload.cid;
        if (payload.placeIds?.length) metricsOpts.placeIds = payload.placeIds;
        const metricsData = await getCampaignMetrics(payload.campaignId, payload.keywordId, metricsOpts, signal);
        if (metricsData.shareOfVoice !== null) {
          const updated = await db.update(heatmapSnapshots)
            .set({ shareOfVoiceRaw: metricsData.shareOfVoice })
            .where(and(
              eq(heatmapSnapshots.id, txResult.snapshotId),
              eq(heatmapSnapshots.rawPayload, payload),
            ))
            .returning({ id: heatmapSnapshots.id });
          if (updated.length > 0) {
            console.log(`[Heatmap] SEMrush SoV written for snapshot ${txResult.snapshotId}: ${metricsData.shareOfVoice}`);
          } else {
            console.log(`[Heatmap] Discarded stale SEMrush SoV for superseded snapshot version ${txResult.snapshotId}`);
          }
        } else {
          const msg = `SEMrush getCampaignMetrics returned null SoV for campaign ${payload.campaignId}, keyword ${payload.keywordId}`;
          console.warn(`[Heatmap] ${msg}`);
          enrichmentErrors.push(msg);
        }
      } catch (metricsErr) {
        if (isAbortLike(metricsErr)) {
          console.warn(`[Heatmap] Metrics fetch aborted post-commit for campaign ${payload.campaignId}, keyword ${payload.keywordId} (snapshot already committed; skipping)`);
        } else {
          const msg = `Failed to fetch SEMrush metrics for campaign ${payload.campaignId}, keyword ${payload.keywordId}: ${metricsErr instanceof Error ? metricsErr.message : metricsErr}`;
          console.error(`[Heatmap] ${msg}`);
          if (metricsErr instanceof Error && metricsErr.stack) {
            console.error("[Heatmap] Metrics fetch stack trace:", metricsErr.stack);
          }
          enrichmentErrors.push(msg);
        }
      }

      try {
        let competitors: Awaited<ReturnType<typeof getTopCompetitors>> = [];
        let competitorReportDate: string | undefined;
        if (payload.campaignReportDates?.length) {
          const { findBestReportDate } = await import("../services/semrushApi");
          const heatmapDate = new Date(payload.reportDate);
          const heatmapMonth = `${heatmapDate.getFullYear()}-${String(heatmapDate.getMonth() + 1).padStart(2, "0")}`;
          competitorReportDate = findBestReportDate(payload.campaignReportDates, heatmapMonth) || undefined;
        }
        const compOpts: { cid?: string; placeIds?: string[] } = {};
        if (payload.cid) compOpts.cid = payload.cid;
        if (payload.placeIds?.length) compOpts.placeIds = payload.placeIds;
        try {
          competitors = await getTopCompetitors(payload.campaignId, payload.keywordId, competitorReportDate, compOpts, signal);
        } catch (dateErr) {
          const errMsg = dateErr instanceof Error ? dateErr.message : String(dateErr);
          const is400 = errMsg.includes("returned 400");
          if (competitorReportDate && is400) {
            console.log(`[Heatmap] Competitors fetch returned 400 for date ${competitorReportDate}, retrying without date`);
            try {
              competitors = await getTopCompetitors(payload.campaignId, payload.keywordId, undefined, compOpts, signal);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              // A dateless retry that ALSO returns 400 is SEMrush saying there
              // is simply no top-competitor data for this campaign+keyword —
              // a benign no-data condition, not an enrichment failure. Keep it
              // at log-level (not warn) and leave `competitors` empty so the
              // snapshot is NOT pushed to partial. A genuine error (network,
              // 5xx, rate limit) still surfaces as a warning.
              if (retryMsg.includes("returned 400")) {
                console.log(`[Heatmap] No competitor data for campaign ${payload.campaignId}, keyword ${payload.keywordId} (dateless retry also 400 — valid no-data response)`);
              } else {
                console.warn(`[Heatmap] Competitors retry without date also failed: ${retryMsg}`);
              }
            }
          } else {
            console.warn(`[Heatmap] Competitors fetch failed: ${errMsg}`);
          }
        }
        if (competitors.length > 0) {
          await storeCompetitorData(
            txResult.snapshotId,
            payload.clientId || null,
            payload.campaignId,
            payload.keywordName,
            new Date(payload.reportDate),
            competitors,
            payload,
          );
          console.log(`[Heatmap] Stored ${competitors.length} competitors for snapshot ${txResult.snapshotId}`);
        } else {
          // Empty competitor array is a legitimate data condition (no ranked
          // competitors for this grid+keyword), not an enrichment failure.
          console.log(`[Heatmap] No competitors returned for campaign ${payload.campaignId}, keyword ${payload.keywordId}, date ${payload.reportDate} (valid no-data response)`);
        }
      } catch (compErr) {
        if (isAbortLike(compErr)) {
          console.warn(`[Heatmap] Competitors fetch aborted post-commit for campaign ${payload.campaignId}, keyword ${payload.keywordId} (snapshot already committed; skipping)`);
        } else {
          const msg = `Failed to fetch SEMrush competitors for campaign ${payload.campaignId}, keyword ${payload.keywordId}: ${compErr instanceof Error ? compErr.message : compErr}`;
          console.error(`[Heatmap] ${msg}`);
          if (compErr instanceof Error && compErr.stack) {
            console.error("[Heatmap] Competitor fetch stack trace:", compErr.stack);
          }
          enrichmentErrors.push(msg);
        }
      }
    } catch (err) {
      const msg = `Failed to import SEMrush modules: ${err instanceof Error ? err.message : err}`;
      console.error(`[Heatmap] ${msg}`);
      enrichmentErrors.push(msg);
    }
  }

  if (enrichmentErrors.length > 0 && payload.clientId) {
    try {
      const { clientSemrushIntegrations } = await import("@shared/schema");
      // Enrichment warnings are NON-FATAL: snapshot was already committed above.
      // Persist to `warningMessage` (separate from `errorMessage`) so the UI
      // doesn't render them as a "Sync failed" banner.
      const warningSummary = `Enrichment warnings (snapshot ${txResult.snapshotId}): ${enrichmentErrors.join("; ")}`.substring(0, 500);
      await db.update(clientSemrushIntegrations)
        .set({ warningMessage: warningSummary, updatedAt: new Date() })
        .where(eq(clientSemrushIntegrations.clientId, payload.clientId));
    } catch (logErr) {
      console.error("[Heatmap] Failed to persist enrichment warnings:", logErr);
    }
  }

  return {
    snapshotId: txResult.snapshotId,
    pointCount: txResult.pointCount,
    metrics: txResult.metrics,
    status: txResult.status,
  };
}

// Task #4087: getLatestSnapshot was removed — its only caller was the removed
// GET /api/heatmaps/location/:locationId/latest route.

export async function getSnapshotsByLocation(locationId: string): Promise<HeatmapSnapshot[]> {
  return db.select().from(heatmapSnapshots)
    .where(eq(heatmapSnapshots.locationId, locationId))
    .orderBy(desc(heatmapSnapshots.reportDate));
}

export async function getSnapshotIdsForReportMonth(
  clientId: string,
  reportMonth: string
): Promise<Record<string, string[]>> {
  const { semrushLocationCampaigns } = await import("@shared/schema");

  const mappings = await db.select({
    locationId: semrushLocationCampaigns.locationId,
    campaignId: semrushLocationCampaigns.semrushCampaignId,
  })
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.clientId, clientId));

  if (mappings.length === 0) return {};

  const [year, month] = reportMonth.split("-").map(Number);
  const monthStart = new Date(year, month - 1, 1);
  const lastDayOfMonth = new Date(year, month, 0);
  const monthEnd = new Date(lastDayOfMonth.getFullYear(), lastDayOfMonth.getMonth(), lastDayOfMonth.getDate() + 3, 23, 59, 59, 999);

  const campaignIds = [...new Set(mappings.map(m => m.campaignId))];

  const snapshots = await db.select({
    id: heatmapSnapshots.id,
    locationId: heatmapSnapshots.locationId,
    campaignId: heatmapSnapshots.campaignId,
    reportDate: heatmapSnapshots.reportDate,
    keywordName: heatmapSnapshots.keywordName,
  })
    .from(heatmapSnapshots)
    .where(
      and(
        eq(heatmapSnapshots.clientId, clientId),
        inArray(heatmapSnapshots.campaignId, campaignIds),
        gte(heatmapSnapshots.reportDate, monthStart),
        lte(heatmapSnapshots.reportDate, monthEnd),
      )
    )
    .orderBy(desc(heatmapSnapshots.reportDate));

  const allowedCampaignsByLocation = new Map<string, Set<string>>();
  for (const m of mappings) {
    if (!allowedCampaignsByLocation.has(m.locationId)) {
      allowedCampaignsByLocation.set(m.locationId, new Set());
    }
    allowedCampaignsByLocation.get(m.locationId)!.add(m.campaignId);
  }

  // Task #4848 — one snapshot per (location, keyword). The SEMrush tracker
  // scans weekly, so a month window holds ~4 same-keyword snapshots per
  // campaign; storing them all gave report drafts a wall of near-identical
  // maps. The list is ordered newest-first, so the FIRST occurrence of a
  // (location, keyword) pair is the latest in-window scan — older duplicates
  // are skipped regardless of which mapped campaign produced them, and
  // latest-first ordering is preserved (the first ID stays the primary
  // snapshot). Keyword names are stored canonical (CHECK
  // heatmap_snapshots_keyword_name_canonical_chk), so plain string equality
  // is the right grouping key. This matches the manual picker lane
  // (fetch-all-heatmaps), which always yielded one snapshot per keyword.
  const seenKeywordsByLocation = new Map<string, Set<string>>();
  const result: Record<string, string[]> = {};
  for (const snap of snapshots) {
    const allowed = allowedCampaignsByLocation.get(snap.locationId);
    if (!allowed || !allowed.has(snap.campaignId)) continue;
    let seenKeywords = seenKeywordsByLocation.get(snap.locationId);
    if (!seenKeywords) {
      seenKeywords = new Set<string>();
      seenKeywordsByLocation.set(snap.locationId, seenKeywords);
    }
    if (seenKeywords.has(snap.keywordName)) continue;
    seenKeywords.add(snap.keywordName);
    if (!result[snap.locationId]) {
      result[snap.locationId] = [];
    }
    result[snap.locationId].push(snap.id);
  }

  return result;
}

export async function getSnapshot(snapshotId: string): Promise<HeatmapSnapshot | undefined> {
  const rows = await db.select().from(heatmapSnapshots)
    .where(eq(heatmapSnapshots.id, snapshotId))
    .limit(1);
  return rows[0];
}

/**
 * Re-derive a cached GeoJSON's per-cell colors and labels from each cell's
 * stored `position` / `diff` (the single source of truth), in place, using the
 * same helpers buildGeoJSON uses. Returns `false` when the cache can't be
 * re-derived (one or more cells lack the `position` key — a shape predating
 * position storage), signalling the caller to drop the cache and rebuild from
 * the points table.
 *
 * This is what keeps a served snapshot's cells fully colored even when the
 * cached entry was written by an older buildGeoJSON: legacy caches missing
 * `rankColor`, or carrying "#"-prefixed labels, are corrected on read; a cell
 * with a null position degrades to the explicit unranked slate rather than an
 * absent color (which would let the frontend paint it black).
 */
export function recolorCachedGeoJSON(cached: any, mode: "rank" | "movement" = "rank"): boolean {
  if (!cached?.features) return false;
  const cellFeatures = cached.features.filter(
    (f: any) => f.properties?.type !== "business" && f.geometry?.type === "Polygon",
  );
  const canDerive =
    cellFeatures.length > 0 &&
    cellFeatures.every((f: any) => f.properties && "position" in f.properties);
  if (!canDerive) return false;
  for (const f of cached.features) {
    if (f.properties?.type === "business") continue;
    const position = f.properties.position;
    const diff = f.properties.diff;
    const rankColor = getRankColor(position);
    const movementColor = getMovementColor(diff);
    f.properties.rankColor = rankColor;
    f.properties.movementColor = movementColor;
    f.properties.rankLabel = getRankLabel(position);
    f.properties.movementLabel = getMovementLabel(diff);
    f.properties.color = mode === "rank" ? rankColor : movementColor;
    f.properties.label = mode === "rank" ? f.properties.rankLabel : f.properties.movementLabel;
  }
  return true;
}

export async function getSnapshotPoints(snapshotId: string): Promise<HeatmapPoint[]> {
  return db.select().from(heatmapPoints)
    .where(eq(heatmapPoints.snapshotId, snapshotId));
}

export async function getSnapshotMetrics(snapshotId: string): Promise<HeatmapMetric | undefined> {
  const rows = await db.select().from(heatmapMetrics)
    .where(eq(heatmapMetrics.snapshotId, snapshotId))
    .limit(1);
  return rows[0];
}

export async function getSnapshotGeoJSON(
  snapshotId: string,
  mode: "rank" | "movement" = "rank"
): Promise<any> {
  const snapshot = await getSnapshot(snapshotId);
  if (!snapshot) return null;

  if (snapshot.geojsonCache) {
    const cached = typeof snapshot.geojsonCache === "string"
      ? JSON.parse(snapshot.geojsonCache)
      : snapshot.geojsonCache;
    if (cached?.features) {
      const cacheGeomVersion = typeof cached.geometryVersion === "number" ? cached.geometryVersion : 0;
      if (cacheGeomVersion < GEOJSON_GEOMETRY_VERSION) {
        // Cache geometry predates the cell-sizing fix (Task #2605); its polygons
        // may be degenerate slivers. recolorCachedGeoJSON only re-derives
        // colors/labels, never geometry, so drop the cache and rebuild it from
        // the points table below with the corrected sizing.
        console.warn(`[heatmapService] Stale geojsonCache geometry (v${cacheGeomVersion} < v${GEOJSON_GEOMETRY_VERSION}) for snapshot ${snapshotId} — clearing cache to rebuild`);
        try {
          await db.update(heatmapSnapshots)
            .set({ geojsonCache: null })
            .where(eq(heatmapSnapshots.id, snapshotId));
        } catch (clearErr) {
          console.error(`[heatmapService] Failed to clear stale-geometry cache for snapshot ${snapshotId}:`, clearErr);
        }
      } else if (recolorCachedGeoJSON(cached, mode)) {
        // Re-derive every cell's colors/labels from its stored position/diff so
        // the served shape is self-correcting (see recolorCachedGeoJSON). Returns
        // false only for caches too old to re-derive (cells lacking `position`),
        // which we drop and rebuild from the points table below.
        return cached;
      } else {
        console.warn(`[heatmapService] Stale geojsonCache for snapshot ${snapshotId} — cells missing position, clearing cache`);
        try {
          await db.update(heatmapSnapshots)
            .set({ geojsonCache: null })
            .where(eq(heatmapSnapshots.id, snapshotId));
        } catch (clearErr) {
          console.error(`[heatmapService] Failed to clear stale cache for snapshot ${snapshotId}:`, clearErr);
        }
      }
    }
  }

  const points = await getSnapshotPoints(snapshotId);
  const geojson = buildGeoJSON(snapshot, points, mode);

  try {
    const fullGeojson = buildGeoJSON(snapshot, points, "rank");
    await db.update(heatmapSnapshots)
      .set({ geojsonCache: fullGeojson })
      .where(eq(heatmapSnapshots.id, snapshotId));
  } catch (cacheWriteErr) {
    console.error(`[heatmapService] Failed to write geojsonCache for snapshot ${snapshotId}:`, cacheWriteErr);
  }

  return geojson;
}

export async function getLocationOverride(locationId: string) {
  const rows = await db.select().from(heatmapOverrides)
    .where(eq(heatmapOverrides.locationId, locationId))
    .limit(1);
  return rows[0];
}

export async function searchSnapshots(opts: {
  search?: string;
  limit?: number;
}): Promise<Array<HeatmapSnapshot & { metrics?: HeatmapMetric; clientName: string | null }>> {
  const limit = opts.limit || 50;

  let query = db
    .select({
      snapshot: heatmapSnapshots,
      metric: heatmapMetrics,
      clientName: clients.firmName,
    })
    .from(heatmapSnapshots)
    .leftJoin(heatmapMetrics, eq(heatmapMetrics.snapshotId, heatmapSnapshots.id))
    .leftJoin(clients, eq(clients.id, heatmapSnapshots.clientId))
    .orderBy(desc(heatmapSnapshots.reportDate))
    .limit(limit);

  if (opts.search) {
    const pattern = `%${opts.search}%`;
    query = query.where(
      or(
        ilike(heatmapSnapshots.locationName, pattern),
        ilike(heatmapSnapshots.keywordName, pattern),
        ilike(heatmapSnapshots.businessName, pattern),
        ilike(heatmapSnapshots.campaignId, pattern),
        ilike(clients.firmName, pattern),
      )
    ) as any;
  }

  const rows = await query;
  return rows.map(r => ({
    ...r.snapshot,
    metrics: r.metric || undefined,
    clientName: r.clientName ?? null,
  }));
}

export function getGridPolicy(marketType: string): { template: string; unit: string; distance: number } {
  switch (marketType) {
    case "small":
      return { template: "7x7", unit: "MILES", distance: 3 };
    case "large_metro":
      return { template: "11x11", unit: "MILES", distance: 6 };
    default:
      return { template: "9x9", unit: "MILES", distance: 5 };
  }
}

export async function getAllDistinctLocations(): Promise<Array<{
  locationId: string;
  locationName: string;
  businessName: string | null;
  latestDate: Date | null;
  snapshotCount: number;
}>> {
  const rows = await db.execute(sql`
    SELECT 
      location_id as "locationId",
      MAX(location_name) as "locationName",
      MAX(business_name) as "businessName",
      MAX(report_date) as "latestDate",
      COUNT(*)::int as "snapshotCount"
    FROM heatmap_snapshots
    GROUP BY location_id
    ORDER BY MAX(report_date) DESC
  `);
  return rows.rows as any;
}
