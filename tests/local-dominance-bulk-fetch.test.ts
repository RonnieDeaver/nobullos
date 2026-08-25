/* test-registration
{
  "name": "Local dominance bulk fetch (Task #1810)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1810 — verifies that getLocalDominanceDataForReportBulk returns the
 * same shape as the per-location helper for every requested location, and
 * collapses what would otherwise be N×(snapshots+metrics+competitors+sov-trend
 * +prior-metrics) sequential SELECTs into a fixed number of queries.
 *
 * The test uses the query-budget harness to pin the call to a bounded query
 * count regardless of location-count.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../server/db";
import {
  getLocalDominanceDataForReport,
  getLocalDominanceDataForReportBulk,
} from "../server/services/localDominanceService";
import { runWithQueryBudget } from "./helpers/queryBudget";

const TAG = "task-1810-bulk-dominance";

async function seedFixture(): Promise<{
  clientId: string;
  campaignId: string;
  perLocation: Array<{ locationId: string; snapshotIds: string[] }>;
}> {
  const clientId = `${TAG}-client-${randomUUID().slice(0, 8)}`;
  const campaignId = `${TAG}-cmp-${randomUUID().slice(0, 8)}`;

  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${clientId}, ${`${TAG} client`})
    ON CONFLICT (id) DO NOTHING
  `);

  const perLocation: Array<{ locationId: string; snapshotIds: string[] }> = [];
  for (let i = 0; i < 3; i++) {
    const locId = `${TAG}-loc-${i}-${randomUUID().slice(0, 6)}`;
    const snapshotIds: string[] = [];
    for (let j = 0; j < 2; j++) {
      const snapId = randomUUID();
      const reportDate = new Date(2026, 4, 10 + j).toISOString().slice(0, 10);
      const keyword = `kw-${i}-${j}`;
      await db.execute(sql`
        INSERT INTO heatmap_snapshots
          (id, client_id, campaign_id, keyword_name, report_date,
           share_of_voice_raw, location_id, location_name,
           business_lat, business_lng,
           grid_template, grid_unit, grid_distance,
           base_lat, base_lng, raw_payload)
        VALUES
          (${snapId}, ${clientId}, ${campaignId}, ${keyword}, ${reportDate},
           ${50 + i + j}, ${`loc-${i}`}, ${`Location ${i}`},
           0, 0, '5x5', 'mi', 1, 0, 0, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `);
      await db.execute(sql`
        INSERT INTO heatmap_metrics (snapshot_id, band_top_3_pct, band_4_to_10_pct, band_11_to_20_pct, band_out_of_top_20_pct, avg_rank)
        VALUES (${snapId}, 30, 20, 15, 35, ${5 + i + j})
      `);
      snapshotIds.push(snapId);
    }
    perLocation.push({ locationId: locId, snapshotIds });
  }
  return { clientId, campaignId, perLocation };
}

async function cleanup(clientId: string): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM heatmap_metrics WHERE snapshot_id IN (SELECT id FROM heatmap_snapshots WHERE client_id = ${clientId})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM heatmap_snapshots WHERE client_id = ${clientId}`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  } catch {}
}

async function run(): Promise<void> {
  // Skip when the schema is unavailable (test runner against a stripped DB).
  try {
    await db.execute(sql`SELECT 1 FROM heatmap_snapshots LIMIT 1`);
  } catch (err: any) {
    if (/does not exist/i.test(err?.message ?? "")) {
      console.log("[local-dominance-bulk-fetch] heatmap tables missing — skipping");
      return;
    }
    throw err;
  }

  const fixture = await seedFixture();
  try {
    // Per-location reference output (one call per location).
    const expected = new Map<string, any>();
    for (const { locationId, snapshotIds } of fixture.perLocation) {
      expected.set(locationId, await getLocalDominanceDataForReport(fixture.clientId, snapshotIds));
    }

    // Bulk variant should produce the same per-location shapes.
    const actual = await getLocalDominanceDataForReportBulk(fixture.clientId, fixture.perLocation);
    assert.equal(actual.size, fixture.perLocation.length, "bulk returns one entry per location");
    for (const { locationId } of fixture.perLocation) {
      const a = actual.get(locationId);
      const e = expected.get(locationId);
      assert.ok(a, `bulk has entry for ${locationId}`);
      assert.equal(a.keywordSnapshots.length, e.keywordSnapshots.length, `snapshot count matches for ${locationId}`);
      assert.equal(a.distributionBands?.bandTop3Pct ?? null, e.distributionBands?.bandTop3Pct ?? null, "bands match");
    }

    // Query budget: the bulk call is bounded by DISTINCT (campaign, keyword)
    // pairs, not by location count. The bulk path now runs
    // `getClientSovTrend` once per distinct campaign (top-level fallback)
    // AND once per distinct (campaign, keyword) triple (per-keyword trends),
    // each ~2 SELECTs, on top of ~4 fixed bulk SELECTs. The regression this
    // guards against is per-LOCATION / per-SNAPSHOT fan-out.
    const distinctTriples = new Set(
      fixture.perLocation.flatMap((p, i) => p.snapshotIds.map((_, j) => `kw-${i}-${j}`)),
    ).size; // 6 in this fixture (every snapshot has a unique keyword)
    // Fixed overhead measured at 8 SELECTs (bulk snapshot/band/settings reads).
    // The guard is against per-LOCATION/per-SNAPSHOT fan-out, which would
    // multiply the total by location count, far beyond this bound.
    const budget = 8 + 2 * (1 + distinctTriples); // fixed + campaign trend + per-triple trends
    const { result, count } = await runWithQueryBudget(
      () => getLocalDominanceDataForReportBulk(fixture.clientId, fixture.perLocation),
    );
    assert.equal(result.size, fixture.perLocation.length, "budget-wrapped call still returns map");
    assert.ok(count <= budget, `bulk-fetch query budget — expected ≤ ${budget}, observed ${count}`);
    console.log("[local-dominance-bulk-fetch] PASS");
  } finally {
    await cleanup(fixture.clientId);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error("[local-dominance-bulk-fetch] FAIL:", err);
    process.exitCode = 1;
  },
);
