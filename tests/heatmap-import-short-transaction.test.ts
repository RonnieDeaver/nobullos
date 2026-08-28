/* test-registration
{
  "name": "Heatmap import short transaction (audit C-T1)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy: exercises real importHeatmap transactions (commit + forced-rollback paths) against the test database.",
  "tier": "small"
}
test-registration */
/**
 * Audit C-T1 — "stage outside, commit inside" refactor of importHeatmap.
 *
 * Proves:
 *  1. A successful import atomically commits snapshot + points + metrics +
 *     geojsonCache, with business data equivalent to the pure staging output
 *     (canonical JSON comparison — jsonb does not preserve key order).
 *  2. A forced point-write failure rolls back everything (no snapshot, no
 *     points, no metrics, no cache row).
 *  3. A forced cache-write (geojsonCache update) failure rolls back snapshot,
 *     points, and metrics.
 *  4. A staging failure (point-prep/metrics/GeoJSON) performs no writes at
 *     all — db.transaction is never invoked.
 *  5. Transaction boundary is structurally verified via deterministic tx-op
 *     assertions (a tx proxy records every select/insert/update): only the
 *     duplicate-day existence check plus the atomic writes run inside the
 *     callback. Plus a pure stageHeatmapImport test (no DB).
 *  6. Duplicate-import (same campaign/keyword/day) semantics unchanged: the
 *     second import returns the existing snapshot id and writes nothing new.
 *  7. A materially changed same-day 5×5 scan atomically refreshes the same
 *     snapshot id to a 15×15 / 225-point scan, including metrics and cache.
 *  8. A failed same-day refresh rolls back to the complete prior version.
 *  9. Enrichment begins only after a successful commit: rollback paths reject
 *     before any enrichment (the enrichment target snapshot never exists).
 *
 * Hermeticity: unique per-run campaign/location IDs; all rows deleted in
 * `finally` (points/metrics/competitor rows cascade from the snapshot).
 */

import { db } from "../server/db";
import {
  heatmapSnapshots,
  heatmapPoints,
  heatmapMetrics,
  heatmapCompetitorSnapshots,
} from "@shared/schema";
import { getTableName } from "drizzle-orm";
import { eq, like } from "drizzle-orm";
import {
  importHeatmap,
  stageHeatmapImport,
  getSnapshotGeoJSON,
  GEOJSON_GEOMETRY_VERSION,
  type SemrushImportPayload,
} from "../server/services/heatmapService";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `hist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function makePayload(overrides: Partial<SemrushImportPayload> = {}): SemrushImportPayload {
  return {
    locationId: `loc-${TAG}`,
    locationName: "Test Location",
    businessName: "Test Business",
    campaignId: `camp-${TAG}`,
    // keywordId deliberately omitted: skips the post-commit SEMrush HTTP
    // enrichment block (network-dead under test) without changing any
    // transactional behavior.
    keywordName: "personal injury lawyer",
    reportDate: "2026-08-01T12:00:00.000Z",
    businessLat: 40.0,
    businessLng: -75.0,
    gridTemplate: "5x5",
    gridUnit: "MILES",
    gridDistance: 5,
    baseLat: 40.0,
    baseLng: -75.0,
    // No pt.id on purpose: exercises the `${snapshotId}-${idx}` pointId
    // fallback, which is exactly the value that forced the snapshot id to
    // be generated before staging.
    points: [
      { lat: 40.0, lng: -75.0, position: 2, diff: 0 },
      { lat: 40.01, lng: -75.01, position: 9, diff: -1 },
      { lat: 40.02, lng: -75.02, position: null, diff: null },
    ],
    ...overrides,
  };
}

/** Recursively sort object keys so jsonb round-trips compare stably. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

interface TxSpyOptions {
  failOnInsertTable?: unknown;
  failOnUpdate?: boolean;
}

interface TxSpy {
  ops: string[];
  txInvocations: number;
  restore: () => void;
}

/**
 * Patches db.transaction so the callback receives a proxied tx that records
 * every select/insert/update (with table name) and can deterministically
 * throw on a chosen operation to force a rollback.
 */
function installTxSpy(opts: TxSpyOptions = {}): TxSpy {
  const dbAny = db as any;
  const hadOwn = Object.prototype.hasOwnProperty.call(dbAny, "transaction");
  const prev = dbAny.transaction;
  const origTx = dbAny.transaction.bind(dbAny);
  const spy: TxSpy = {
    ops: [],
    txInvocations: 0,
    restore: () => {
      if (hadOwn) dbAny.transaction = prev;
      else delete dbAny.transaction;
    },
  };
  dbAny.transaction = (fn: (tx: any) => Promise<unknown>) => {
    spy.txInvocations++;
    return origTx(async (tx: any) => {
      const proxy = new Proxy(tx, {
        get(target, prop) {
          if (prop === "insert") {
            return (table: any) => {
              spy.ops.push(`insert:${getTableName(table)}`);
              if (opts.failOnInsertTable && table === opts.failOnInsertTable) {
                const tableName = getTableName(table);
                throw new Error(table === heatmapPoints
                  ? "forced point-write failure"
                  : `forced ${tableName} insert failure`);
              }
              return target.insert(table);
            };
          }
          if (prop === "update") {
            return (table: any) => {
              spy.ops.push(`update:${getTableName(table)}`);
              if (opts.failOnUpdate) {
                throw new Error("forced cache-write failure");
              }
              return target.update(table);
            };
          }
          if (prop === "delete") {
            return (table: any) => {
              spy.ops.push(`delete:${getTableName(table)}`);
              return target.delete(table);
            };
          }
          if (prop === "select") {
            return (...args: any[]) => {
              spy.ops.push("select");
              return target.select(...args);
            };
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      return fn(proxy);
    });
  };
  return spy;
}

async function countRowsFor(campaignId: string): Promise<{ snapshots: number; points: number; metrics: number }> {
  const snaps = await db.select({ id: heatmapSnapshots.id })
    .from(heatmapSnapshots)
    .where(eq(heatmapSnapshots.campaignId, campaignId));
  let points = 0;
  let metrics = 0;
  for (const s of snaps) {
    points += (await db.select({ id: heatmapPoints.id }).from(heatmapPoints).where(eq(heatmapPoints.snapshotId, s.id))).length;
    metrics += (await db.select({ id: heatmapMetrics.id }).from(heatmapMetrics).where(eq(heatmapMetrics.snapshotId, s.id))).length;
  }
  return { snapshots: snaps.length, points, metrics };
}

async function seedCompetitor(snapshotId: string, campaignId: string, name: string): Promise<void> {
  await db.insert(heatmapCompetitorSnapshots).values({
    snapshotId,
    campaignId,
    keyword: "personal injury lawyer",
    scanDate: new Date("2026-08-01T12:00:00.000Z"),
    competitorName: name,
    competitorRankPosition: 1,
  });
}

// ----------------------------------------------------------------------------
// Test A — pure staging helper (no DB): complete staged output.
// ----------------------------------------------------------------------------
function testPureStaging(): void {
  const payload = makePayload({ campaignId: `camp-${TAG}-pure` });
  const staged = stageHeatmapImport(payload, "fixed-snapshot-id");
  assert(staged.snapshotId === "fixed-snapshot-id", "staged snapshotId echoes input");
  assert(staged.snapshotValues.id === "fixed-snapshot-id", "snapshotValues carries the pre-generated id");
  assert(staged.pointRows.length === 3, "one staged row per payload point");
  assert(staged.pointRows[0].pointId === "fixed-snapshot-id-0", "pointId fallback embeds the pre-generated snapshot id");
  assert(staged.pointRows.every(r => r.snapshotId === "fixed-snapshot-id"), "all point rows stamped with snapshot id");
  assert(staged.metrics.rankedPointsCount === 2 && staged.metrics.unrankedPointsCount === 1, "metrics computed during staging");
  assert(staged.metrics.bestRank === 2 && staged.metrics.worstRank === 9, "rank metrics correct");
  const gj = staged.geojson as any;
  assert(gj.type === "FeatureCollection" && gj.geometryVersion === GEOJSON_GEOMETRY_VERSION, "GeoJSON fully built during staging with geometry version");
  assert(gj.features.length === 4, "3 cells + business pin");
  assert(gj.features[0].properties.pointId === "fixed-snapshot-id-0", "GeoJSON cells carry the staged pointId");
  console.log("[TestA PureStaging] ✓");
}

// ----------------------------------------------------------------------------
// Test B — success path: atomic commit, tx-op boundary, stored equivalence.
// ----------------------------------------------------------------------------
async function testSuccessCommitAndBoundary(): Promise<void> {
  const payload = makePayload({ campaignId: `camp-${TAG}-ok` });
  const spy = installTxSpy();
  let result: Awaited<ReturnType<typeof importHeatmap>>;
  try {
    result = await importHeatmap(payload);
  } finally {
    spy.restore();
  }
  assert(spy.txInvocations === 1, `exactly one transaction, got ${spy.txInvocations}`);
  assert(result.status === "created", `first import should report created, got ${result.status}`);
  // Structural boundary: ONLY the dedupe check + atomic writes inside the tx.
  assert(
    JSON.stringify(spy.ops) === JSON.stringify([
      "select",
      "insert:heatmap_snapshots",
      "insert:heatmap_points",
      "insert:heatmap_metrics",
      "update:heatmap_snapshots",
    ]),
    `unexpected tx op sequence: ${JSON.stringify(spy.ops)}`,
  );

  const [snap] = await db.select().from(heatmapSnapshots).where(eq(heatmapSnapshots.id, result.snapshotId));
  assert(!!snap, "snapshot committed");
  assert(snap.keywordName === payload.keywordName && snap.gridTemplate === "5x5", "snapshot business fields stored");
  assert(canonical(snap.rawPayload) === canonical(payload), "rawPayload stored verbatim");

  const pts = await db.select().from(heatmapPoints).where(eq(heatmapPoints.snapshotId, result.snapshotId));
  assert(pts.length === 3, `3 points committed, got ${pts.length}`);
  const p0 = pts.find(p => p.pointIndex === 0)!;
  assert(p0.pointId === `${result.snapshotId}-0` && p0.position === 2, "point row shape unchanged (fallback pointId, position)");

  const [met] = await db.select().from(heatmapMetrics).where(eq(heatmapMetrics.snapshotId, result.snapshotId));
  assert(!!met, "metrics committed");

  // Stored data equivalent to a fresh pure staging of the same inputs.
  const staged = stageHeatmapImport(payload, result.snapshotId);
  assert(canonical(snap.geojsonCache) === canonical(staged.geojson), "committed geojsonCache equals the pre-staged GeoJSON");
  assert(met.avgRank === staged.metrics.avgRank && met.medianRank === staged.metrics.medianRank
    && met.bestRank === staged.metrics.bestRank && met.worstRank === staged.metrics.worstRank
    && met.rankedPointsCount === staged.metrics.rankedPointsCount
    && met.unrankedPointsCount === staged.metrics.unrankedPointsCount
    && met.bandTop3Pct === staged.metrics.bandTop3Pct
    && met.bandOutOfTop20Pct === staged.metrics.bandOutOfTop20Pct,
    "committed metrics equal staged metrics");
  assert(canonical(result.metrics) === canonical(staged.metrics), "returned metrics equal staged metrics");
  console.log("[TestB SuccessCommitAndBoundary] ✓");
}

// ----------------------------------------------------------------------------
// Test C — forced point-write failure rolls back everything.
// ----------------------------------------------------------------------------
async function testPointWriteFailureRollsBack(): Promise<void> {
  const campaignId = `camp-${TAG}-ptfail`;
  const payload = makePayload({ campaignId });
  const spy = installTxSpy({ failOnInsertTable: heatmapPoints });
  let threw = false;
  try {
    await importHeatmap(payload);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes("forced point-write failure"), `unexpected error: ${err}`);
  } finally {
    spy.restore();
  }
  assert(threw, "import must reject on point-write failure (so enrichment never runs)");
  const counts = await countRowsFor(campaignId);
  assert(counts.snapshots === 0 && counts.points === 0 && counts.metrics === 0,
    `rollback must leave nothing committed, got ${JSON.stringify(counts)}`);
  console.log("[TestC PointWriteFailureRollsBack] ✓");
}

// ----------------------------------------------------------------------------
// Test D — forced cache-write failure rolls back snapshot + points + metrics.
// ----------------------------------------------------------------------------
async function testCacheWriteFailureRollsBack(): Promise<void> {
  const campaignId = `camp-${TAG}-cachefail`;
  const payload = makePayload({ campaignId });
  const spy = installTxSpy({ failOnUpdate: true });
  let threw = false;
  try {
    await importHeatmap(payload);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes("forced cache-write failure"), `unexpected error: ${err}`);
  } finally {
    spy.restore();
  }
  assert(threw, "import must reject on cache-write failure");
  const counts = await countRowsFor(campaignId);
  assert(counts.snapshots === 0 && counts.points === 0 && counts.metrics === 0,
    `cache-write rollback must leave nothing committed, got ${JSON.stringify(counts)}`);
  console.log("[TestD CacheWriteFailureRollsBack] ✓");
}

// ----------------------------------------------------------------------------
// Test E — staging failure performs no writes (transaction never opens).
// ----------------------------------------------------------------------------
async function testStagingFailureWritesNothing(): Promise<void> {
  const campaignId = `camp-${TAG}-stagefail`;
  const payload = makePayload({ campaignId });
  // Passes validation (which only reads lat/lng), then throws during staging
  // when point-prep/metrics read `position` — before any transaction.
  const poisoned = { lat: 40.03, lng: -75.03 } as any;
  Object.defineProperty(poisoned, "position", {
    enumerable: true,
    get() { throw new Error("forced staging failure"); },
  });
  payload.points.push(poisoned);
  const spy = installTxSpy();
  let threw = false;
  try {
    await importHeatmap(payload);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes("forced staging failure"), `unexpected error: ${err}`);
  } finally {
    spy.restore();
  }
  assert(threw, "import must reject on staging failure");
  assert(spy.txInvocations === 0, `staging failure must never open a transaction, got ${spy.txInvocations}`);
  const counts = await countRowsFor(campaignId);
  assert(counts.snapshots === 0 && counts.points === 0 && counts.metrics === 0,
    `staging failure must write nothing, got ${JSON.stringify(counts)}`);
  console.log("[TestE StagingFailureWritesNothing] ✓");
}

// ----------------------------------------------------------------------------
// Test F — duplicate-import semantics unchanged (same campaign/keyword/day).
// ----------------------------------------------------------------------------
async function testDuplicateImportIdempotent(): Promise<void> {
  const campaignId = `camp-${TAG}-dup`;
  const payload = makePayload({ campaignId });
  const first = await importHeatmap(payload);
  const spy = installTxSpy();
  let second: Awaited<ReturnType<typeof importHeatmap>>;
  try {
    // Casing/whitespace variance must still dedupe via normalizeKeyword —
    // note the stored row keeps the canonical spelling (DB CHECK).
    second = await importHeatmap(payload);
  } finally {
    spy.restore();
  }
  assert(second.snapshotId === first.snapshotId, "duplicate import returns the existing snapshot id");
  assert(second.status === "unchanged", `exact replay should report unchanged, got ${second.status}`);
  assert(second.pointCount === 3, `exact replay should report 3 persisted points, got ${second.pointCount}`);
  assert(canonical(second.metrics) === canonical(first.metrics), "duplicate import returns existing metrics");
  // Boundary on the duplicate path: locked identity + points + metrics reads
  // only — NO writes.
  assert(JSON.stringify(spy.ops) === JSON.stringify(["select", "select", "select"]),
    `duplicate path must not write, got ${JSON.stringify(spy.ops)}`);
  const counts = await countRowsFor(campaignId);
  assert(counts.snapshots === 1 && counts.points === 3 && counts.metrics === 1,
    `duplicate import must not add rows, got ${JSON.stringify(counts)}`);
  console.log("[TestF DuplicateImportIdempotent] ✓");
}

function makeGridPoints(dim: number, rankOffset = 0): SemrushImportPayload["points"] {
  const points: SemrushImportPayload["points"] = [];
  for (let row = 0; row < dim; row++) {
    for (let col = 0; col < dim; col++) {
      points.push({
        lat: 40 + row * 0.01,
        lng: -75 + col * 0.01,
        position: ((row * dim + col + rankOffset) % 25) + 1,
        diff: rankOffset === 0 ? 0 : (col % 3) - 1,
      });
    }
  }
  return points;
}

// ----------------------------------------------------------------------------
// Test G — changed same-day scan refreshes the same snapshot id atomically.
// ----------------------------------------------------------------------------
async function testChangedSameDayScanRefreshesInPlace(): Promise<void> {
  const campaignId = `camp-${TAG}-refresh`;
  const initialPayload = makePayload({
    campaignId,
    gridTemplate: "5x5",
    pointsNumber: 25,
    points: makeGridPoints(5),
  });
  const first = await importHeatmap(initialPayload);
  await seedCompetitor(first.snapshotId, campaignId, "Prior Scan Competitor");

  const refreshedPayload = makePayload({
    campaignId,
    locationName: "Refreshed Location",
    businessName: "Refreshed Business",
    gridTemplate: "15x15",
    gridDistance: 10,
    pointsNumber: 225,
    points: makeGridPoints(15, 4),
  });
  const second = await importHeatmap(refreshedPayload);

  assert(second.snapshotId === first.snapshotId, "changed same-day scan preserves the snapshot id");
  assert(second.status === "refreshed", `changed scan should report refreshed, got ${second.status}`);
  assert(second.pointCount === 225, `refresh response should report 225 persisted points, got ${second.pointCount}`);

  const snapshots = await db.select().from(heatmapSnapshots)
    .where(eq(heatmapSnapshots.campaignId, campaignId));
  assert(snapshots.length === 1, `refresh must retain one canonical snapshot, got ${snapshots.length}`);
  const [snapshot] = snapshots;
  assert(snapshot.id === first.snapshotId, "stored snapshot id remains report-reference stable");
  assert(snapshot.gridTemplate === "15x15" && snapshot.pointsNumber === 225,
    `snapshot metadata should refresh to 15x15/225, got ${snapshot.gridTemplate}/${snapshot.pointsNumber}`);
  assert(snapshot.locationName === "Refreshed Location" && snapshot.businessName === "Refreshed Business",
    "snapshot descriptive metadata refreshed");
  assert(canonical(snapshot.rawPayload) === canonical(refreshedPayload), "raw payload refreshed to incoming scan");

  const points = await db.select().from(heatmapPoints)
    .where(eq(heatmapPoints.snapshotId, first.snapshotId));
  assert(points.length === 225, `refresh should replace children with 225 points, got ${points.length}`);
  assert(points.some((point) => point.pointIndex === 224), "last 15x15 point persisted");

  const metrics = await db.select().from(heatmapMetrics)
    .where(eq(heatmapMetrics.snapshotId, first.snapshotId));
  assert(metrics.length === 1, `refresh should retain exactly one metrics row, got ${metrics.length}`);
  assert(canonical(second.metrics) === canonical(stageHeatmapImport(refreshedPayload, first.snapshotId).metrics),
    "refresh response metrics match the newly persisted scan");
  const competitors = await db.select().from(heatmapCompetitorSnapshots)
    .where(eq(heatmapCompetitorSnapshots.snapshotId, first.snapshotId));
  assert(competitors.length === 0, "refresh atomically clears prior-scan competitor children");

  const servedGeojson = await getSnapshotGeoJSON(first.snapshotId);
  const polygonFeatures = servedGeojson.features.filter((feature: any) => feature.geometry?.type === "Polygon");
  assert(polygonFeatures.length === 225,
    `report-bound snapshot should serve 225 polygon features after refresh, got ${polygonFeatures.length}`);
  assert(servedGeojson.features.length === 226, "served cache includes 225 cells plus the business pin");
  console.log("[TestG ChangedSameDayScanRefreshesInPlace] ✓");
}

// ----------------------------------------------------------------------------
// Test H — a failed changed-content refresh preserves the prior full version.
// ----------------------------------------------------------------------------
async function testFailedRefreshPreservesPriorVersion(): Promise<void> {
  const campaignId = `camp-${TAG}-refreshfail`;
  const initialPayload = makePayload({
    campaignId,
    gridTemplate: "5x5",
    pointsNumber: 25,
    points: makeGridPoints(5),
  });
  const first = await importHeatmap(initialPayload);
  await seedCompetitor(first.snapshotId, campaignId, "Rollback Competitor");
  const [beforeSnapshot] = await db.select().from(heatmapSnapshots)
    .where(eq(heatmapSnapshots.id, first.snapshotId));
  const beforePoints = await db.select().from(heatmapPoints)
    .where(eq(heatmapPoints.snapshotId, first.snapshotId))
    .orderBy(heatmapPoints.pointIndex);
  const beforeMetrics = await db.select().from(heatmapMetrics)
    .where(eq(heatmapMetrics.snapshotId, first.snapshotId));
  const beforeCompetitors = await db.select().from(heatmapCompetitorSnapshots)
    .where(eq(heatmapCompetitorSnapshots.snapshotId, first.snapshotId));

  const changedPayload = makePayload({
    campaignId,
    gridTemplate: "15x15",
    gridDistance: 10,
    pointsNumber: 225,
    points: makeGridPoints(15, 7),
  });
  const spy = installTxSpy({ failOnInsertTable: heatmapMetrics });
  let threw = false;
  try {
    await importHeatmap(changedPayload);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes("forced heatmap_metrics insert failure"), `unexpected error: ${err}`);
  } finally {
    spy.restore();
  }
  assert(threw, "failed refresh must reject");
  assert(spy.ops.includes("update:heatmap_snapshots")
    && spy.ops.includes("delete:heatmap_points")
    && spy.ops.includes("delete:heatmap_metrics")
    && spy.ops.includes("delete:heatmap_competitor_snapshots")
    && spy.ops.includes("insert:heatmap_points")
    && spy.ops.includes("insert:heatmap_metrics"),
  `refresh failure fixture must reach replacement writes, got ${JSON.stringify(spy.ops)}`);

  const [afterSnapshot] = await db.select().from(heatmapSnapshots)
    .where(eq(heatmapSnapshots.id, first.snapshotId));
  const afterPoints = await db.select().from(heatmapPoints)
    .where(eq(heatmapPoints.snapshotId, first.snapshotId))
    .orderBy(heatmapPoints.pointIndex);
  const afterMetrics = await db.select().from(heatmapMetrics)
    .where(eq(heatmapMetrics.snapshotId, first.snapshotId));
  const afterCompetitors = await db.select().from(heatmapCompetitorSnapshots)
    .where(eq(heatmapCompetitorSnapshots.snapshotId, first.snapshotId));
  assert(canonical(afterSnapshot) === canonical(beforeSnapshot), "failed refresh restores prior snapshot metadata/raw/cache");
  assert(canonical(afterPoints) === canonical(beforePoints), "failed refresh restores all prior point rows");
  assert(canonical(afterMetrics) === canonical(beforeMetrics), "failed refresh restores prior metrics row");
  assert(canonical(afterCompetitors) === canonical(beforeCompetitors), "failed refresh restores prior competitor rows");
  console.log("[TestH FailedRefreshPreservesPriorVersion] ✓");
}

// ----------------------------------------------------------------------------
// Test I — concurrent first imports serialize to one canonical snapshot.
// ----------------------------------------------------------------------------
async function testConcurrentFirstImportsCreateOneSnapshot(): Promise<void> {
  const campaignId = `camp-${TAG}-concurrent`;
  const payload = makePayload({
    campaignId,
    gridTemplate: "5x5",
    pointsNumber: 25,
    points: makeGridPoints(5),
  });

  const [left, right] = await Promise.all([
    importHeatmap(payload),
    importHeatmap(payload),
  ]);
  assert(left.snapshotId === right.snapshotId, "concurrent first imports converge on one snapshot id");
  assert(new Set([left.status, right.status]).has("created"), "one concurrent importer creates the snapshot");
  assert(new Set([left.status, right.status]).has("unchanged"), "the other concurrent importer observes an exact replay");

  const counts = await countRowsFor(campaignId);
  assert(counts.snapshots === 1 && counts.points === 25 && counts.metrics === 1,
    `concurrent first imports must persist one complete version, got ${JSON.stringify(counts)}`);
  console.log("[TestI ConcurrentFirstImportsCreateOneSnapshot] ✓");
}

// ----------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  // Points / metrics / competitor rows cascade from the snapshot delete.
  await db.delete(heatmapSnapshots).where(like(heatmapSnapshots.campaignId, `camp-${TAG}%`));
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles.
(async () => {
  try {
    testPureStaging();
    await testSuccessCommitAndBoundary();
    await testPointWriteFailureRollsBack();
    await testCacheWriteFailureRollsBack();
    await testStagingFailureWritesNothing();
    await testDuplicateImportIdempotent();
    await testChangedSameDayScanRefreshesInPlace();
    await testFailedRefreshPreservesPriorVersion();
    await testConcurrentFirstImportsCreateOneSnapshot();
    console.log("heatmap-import-short-transaction: all cases passed");
  } catch (err) {
    console.error("heatmap-import-short-transaction: FAILED", err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
