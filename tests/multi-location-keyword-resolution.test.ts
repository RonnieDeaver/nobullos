/* test-registration
{
  "name": "Multi-location keyword resolution",
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * Multi-location keyword resolution regression coverage.
 *
 * Pins the canonical (clientId, locationId, campaignId, keywordName, day)
 * snapshot identity at the two boundaries that broke in task 585:
 *
 *   1. semrushInventorySync.handleRefreshJob — when a single SEMrush campaign
 *      is mapped to multiple (clientId, locationId) pairs in
 *      `semrush_location_campaigns`, the refresh worker must enqueue ONE
 *      `semrush_heatmap_apply` job per (clientId, locationId) pair per
 *      keyword. The pre-585 code path resolved only the first integration
 *      row, silently dropping every non-primary location.
 *
 *   2. localDominanceService.getPerLocationSnapshots — a snapshot tagged
 *      with a real `locationId` must NEVER be cross-attributed to a sibling
 *      location, even if the sibling shares the same campaign mapping. The
 *      legacy `client-${clientId}` placeholder snapshots, however, must
 *      still fan out to every location currently mapped to that campaign so
 *      pre-multi-location data does not disappear from the dashboard.
 *
 * Both tests exercise the real production code paths (no module-level
 * shimming of semrushLocationCampaigns / heatmapSnapshots) and clean up the
 * rows they created in a `finally` block.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  semrushLocationCampaigns,
  heatmapSnapshots,
  sourceEventLog,
  workResultLog,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { handleRefreshJob } from "../server/services/semrushInventorySync";
import { getPerLocationSnapshots } from "../server/services/localDominanceService";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `mlkr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedClient(firmName: string): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ firmName })
    .returning({ id: clients.id });
  return row.id;
}

async function seedLocation(clientId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(clientLocations)
    .values({ clientId, name })
    .returning({ id: clientLocations.id });
  return row.id;
}

async function seedMapping(
  clientId: string,
  locationId: string,
  campaignId: string,
  campaignName: string,
): Promise<void> {
  await db.insert(semrushLocationCampaigns).values({
    clientId,
    locationId,
    semrushCampaignId: campaignId,
    semrushCampaignName: campaignName,
    isStale: false,
  });
}

// -----------------------------------------------------------------------------
// Test 1: handleRefreshJob fans out apply jobs across all mapped locations.
// -----------------------------------------------------------------------------
async function testRefreshFanOut(): Promise<void> {
  const clientId = await seedClient(`MLKR Refresh ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "Loc A");
  const locB = await seedLocation(clientId, "Loc B");
  const locC = await seedLocation(clientId, "Loc C");
  const campaignId = `camp-${TEST_TAG}-shared`;

  await seedMapping(clientId, locA, campaignId, "Camp Shared (A)");
  await seedMapping(clientId, locB, campaignId, "Camp Shared (B)");
  await seedMapping(clientId, locC, campaignId, "Camp Shared (C)");

  const enqueued: Array<{
    queueName: string;
    payload: any;
    dedupeKey?: string;
  }> = [];

  const fakeKeywords = [
    { id: "kw-1", name: "personal injury lawyer", status: "ACTIVE" },
    { id: "kw-2", name: "car accident attorney", status: "ACTIVE" },
  ];

  const fakeCampaign = {
    business: { cid: "cid-xyz", placeIds: ["place-1"] },
    businessName: "Acme Law",
    reportDates: ["2026-04-21"],
    gridSettings: {
      basePoint: { lat: 40.0, lng: -75.0 },
      template: "9x9",
      unit: "MILES",
      distance: 5,
    },
  };

  function fakeHeatmap(_campaignId: string, kwId: string, _opts: any) {
    return Promise.resolve({
      keyword: { name: fakeKeywords.find((k) => k.id === kwId)?.name },
      date: "2026-04-21",
      positions: [
        { point: { id: "p1", lat: 40.0, lng: -75.0 }, rank: 3, diff: 0 },
      ],
    });
  }

  let createdEventIds: string[] = [];
  let createdWorkResultIds: string[] = [];

  try {
    await handleRefreshJob(
      { payload: { campaignId, trigger: "test", reportDate: "2026-04-21" } },
      {
        semrushApi: {
          getCampaign: async () => fakeCampaign,
          getCampaignKeywords: async () => fakeKeywords,
          getHeatmapData: fakeHeatmap,
        },
        enqueueJob: async (p) => {
          enqueued.push({
            queueName: p.queueName,
            payload: p.payload,
            dedupeKey: p.dedupeKey,
          });
          return { id: `fake-${enqueued.length}` };
        },
      },
    );

    // Expectation: 2 keywords × 3 mapped locations = 6 apply jobs.
    assert(
      enqueued.length === fakeKeywords.length * 3,
      `expected ${fakeKeywords.length * 3} apply jobs (one per keyword × mapped location), got ${enqueued.length}`,
    );

    // Every job is for the apply queue.
    for (const j of enqueued) {
      assert(
        j.queueName === "semrush_heatmap_apply",
        `unexpected queueName ${j.queueName}`,
      );
    }

    // Every apply job needs to look up the work_result row by id, so collect
    // those for cleanup at the end of the test.
    const workResultIdsFromPayloads = enqueued
      .map((j) => j.payload?.workResultId)
      .filter(Boolean) as string[];
    createdWorkResultIds = workResultIdsFromPayloads;

    // The dedupe key tells us which (locationId, keywordId) the job is for —
    // we use it as the source of truth for the fan-out shape. Format:
    //   semrush:heatmap_apply:<workResultId>
    // The (clientId, locationId) identity lives on the work_result row.
    const wrRows = await db
      .select({
        id: workResultLog.id,
        eventId: workResultLog.sourceEventId,
        correlationId: workResultLog.correlationId,
        result: workResultLog.resultJson,
      })
      .from(workResultLog)
      .where(inArray(workResultLog.id, workResultIdsFromPayloads));

    createdEventIds = [...new Set(wrRows.map((r) => r.eventId).filter(Boolean) as string[])];

    // Each (locationId, keywordId) pair must appear EXACTLY ONCE.
    const seenPairs = new Set<string>();
    const locationsHit = new Set<string>();
    const clientsHit = new Set<string>();
    for (const r of wrRows) {
      const payload = r.result as any;
      const key = `${payload.locationId}|${payload.keywordId}`;
      assert(
        !seenPairs.has(key),
        `duplicate apply job for (locationId=${payload.locationId}, keywordId=${payload.keywordId})`,
      );
      seenPairs.add(key);
      locationsHit.add(payload.locationId);
      clientsHit.add(payload.clientId);
      assert(
        payload.campaignId === campaignId,
        `apply payload campaignId mismatch: ${payload.campaignId} !== ${campaignId}`,
      );
    }

    assert(
      locationsHit.size === 3,
      `expected apply jobs to span all 3 mapped locations, got ${locationsHit.size}: ${JSON.stringify([...locationsHit])}`,
    );
    assert(locationsHit.has(locA), `locA missing from fan-out`);
    assert(locationsHit.has(locB), `locB missing from fan-out`);
    assert(locationsHit.has(locC), `locC missing from fan-out`);
    assert(
      clientsHit.size === 1 && clientsHit.has(clientId),
      `every apply job must carry the same clientId; got ${JSON.stringify([...clientsHit])}`,
    );

    console.log(
      `  ✓ refresh fan-out: ${enqueued.length} apply jobs across ${locationsHit.size} locations × ${fakeKeywords.length} keywords`,
    );
  } finally {
    if (createdWorkResultIds.length > 0) {
      await db
        .delete(workResultLog)
        .where(inArray(workResultLog.id, createdWorkResultIds));
    }
    if (createdEventIds.length > 0) {
      await db
        .delete(sourceEventLog)
        .where(inArray(sourceEventLog.id, createdEventIds));
    }
    await db
      .delete(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    await db
      .delete(clientLocations)
      .where(eq(clientLocations.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
  }
}

// -----------------------------------------------------------------------------
// Test 2: getPerLocationSnapshots respects per-location identity but still
// fans out legacy fallback snapshots.
// -----------------------------------------------------------------------------
async function testPerLocationResolution(): Promise<void> {
  const clientId = await seedClient(`MLKR PerLoc ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "Per A");
  const locB = await seedLocation(clientId, "Per B");
  const locC = await seedLocation(clientId, "Per C");
  const locD = await seedLocation(clientId, "Per D");
  const campShared = `camp-${TEST_TAG}-perloc-shared`;
  const campLegacyOnly = `camp-${TEST_TAG}-perloc-legacy`;
  const campLegacyShared = `camp-${TEST_TAG}-perloc-legacy-shared`;

  // locA + locB both map to the SAME campaign — this is the exact shape that
  // triggered the cross-attribution bug. locC maps to a different campaign
  // and is the recipient of a legacy fallback snapshot. locC + locD share
  // campLegacyShared so we can also assert that legacy fan-out distributes
  // a single placeholder snapshot to MULTIPLE mapped locations.
  await seedMapping(clientId, locA, campShared, "Shared (A)");
  await seedMapping(clientId, locB, campShared, "Shared (B)");
  await seedMapping(clientId, locC, campLegacyOnly, "Legacy-only (C)");
  await seedMapping(clientId, locC, campLegacyShared, "Legacy-shared (C)");
  await seedMapping(clientId, locD, campLegacyShared, "Legacy-shared (D)");

  const insertedSnapshotIds: string[] = [];

  function snapBase(overrides: Partial<typeof heatmapSnapshots.$inferInsert> = {}) {
    return {
      clientId,
      locationName: "Test",
      businessName: "Test",
      campaignId: campShared,
      keywordId: "kw-x",
      keywordName: "personal injury lawyer",
      reportDate: new Date("2026-04-20T00:00:00Z"),
      businessLat: 40,
      businessLng: -75,
      gridTemplate: "9x9",
      gridUnit: "MILES",
      gridDistance: 5,
      baseLat: 40,
      baseLng: -75,
      pointsNumber: 1,
      shareOfVoiceRaw: 50,
      rawPayload: {} as any,
      ...overrides,
    };
  }

  try {
    // Snapshot 1: real-location snapshot for locA + campShared. MUST attribute
    // only to locA, NOT to locB even though locB also owns campShared.
    const [s1] = await db
      .insert(heatmapSnapshots)
      .values(
        snapBase({
          locationId: locA,
          locationName: "Per A",
          shareOfVoiceRaw: 77,
          reportDate: new Date("2026-04-20T00:00:00Z"),
        }),
      )
      .returning({ id: heatmapSnapshots.id });
    insertedSnapshotIds.push(s1.id);

    // Snapshot 2: legacy fallback snapshot tagged with the placeholder
    // locationId `client-${clientId}` for campLegacyOnly. Must fan out to
    // locC (the one current mapping for that campaign).
    const [s2] = await db
      .insert(heatmapSnapshots)
      .values(
        snapBase({
          locationId: `client-${clientId}`,
          locationName: "Legacy",
          campaignId: campLegacyOnly,
          shareOfVoiceRaw: 42,
          reportDate: new Date("2026-04-19T00:00:00Z"),
        }),
      )
      .returning({ id: heatmapSnapshots.id });
    insertedSnapshotIds.push(s2.id);

    const results = await getPerLocationSnapshots(
      clientId,
      "personal injury lawyer",
    );

    const byLoc = new Map(results.map((r) => [r.locationId, r]));

    // locA has its own real-location snapshot → snapshotId === s1.id, sov=77.
    const a = byLoc.get(locA);
    assert(a, `locA missing from results`);
    assert(
      a!.snapshotId === s1.id,
      `locA should resolve to its own snapshot (${s1.id}), got ${a!.snapshotId}`,
    );
    assert(
      a!.shareOfVoice === 77,
      `locA shareOfVoice should be 77 (its own snapshot), got ${a!.shareOfVoice}`,
    );

    // locB MUST NOT receive locA's real-location snapshot via cross-attribution.
    // It has no snapshot of its own for this campaign and no legacy snapshot
    // for campShared, so its snapshotId must be null.
    const b = byLoc.get(locB);
    assert(b, `locB missing from results`);
    assert(
      b!.snapshotId === null,
      `locB MUST NOT inherit locA's snapshot — expected null, got snapshotId=${b!.snapshotId} sov=${b!.shareOfVoice}`,
    );

    // Snapshot 3: legacy fallback snapshot for campLegacyShared. campLegacyShared
    // is mapped to BOTH locC and locD, so a single placeholder snapshot must
    // fan out to both locations (and must NOT silently drop one of them, the
    // exact failure shape from task 585).
    const [s3] = await db
      .insert(heatmapSnapshots)
      .values(
        snapBase({
          locationId: `client-${clientId}`,
          locationName: "Legacy Shared",
          campaignId: campLegacyShared,
          shareOfVoiceRaw: 31,
          // newer reportDate so it wins over s2 ONLY for its own (locC) entry
          // when both legacy fallbacks could theoretically compete for locC —
          // but they have different campaignIds, so they shouldn't collide.
          reportDate: new Date("2026-04-18T00:00:00Z"),
        }),
      )
      .returning({ id: heatmapSnapshots.id });
    insertedSnapshotIds.push(s3.id);

    const results2 = await getPerLocationSnapshots(
      clientId,
      "personal injury lawyer",
    );
    const byLoc2 = new Map(results2.map((r) => [r.locationId, r]));

    // locC still receives s2 (its newer legacy snapshot for campLegacyOnly,
    // 2026-04-19 > 2026-04-18). locD receives s3 via legacy fan-out across
    // the shared campaign mapping.
    const c = byLoc2.get(locC);
    assert(c, `locC missing from results`);
    assert(
      c!.snapshotId === s2.id,
      `locC should receive legacy fallback snapshot (${s2.id}), got ${c!.snapshotId}`,
    );
    assert(
      c!.shareOfVoice === 42,
      `locC shareOfVoice should be 42 (legacy snapshot), got ${c!.shareOfVoice}`,
    );

    const d = byLoc2.get(locD);
    assert(d, `locD missing from results`);
    assert(
      d!.snapshotId === s3.id,
      `locD should receive legacy-shared fallback snapshot (${s3.id}) via fan-out, got ${d!.snapshotId}`,
    );
    assert(
      d!.shareOfVoice === 31,
      `locD shareOfVoice should be 31 (legacy-shared snapshot), got ${d!.shareOfVoice}`,
    );

    console.log(
      `  ✓ per-location: locA=own-snap, locB=null (no cross-attribution), locC+locD=legacy fan-out across multiple recipients`,
    );
  } finally {
    if (insertedSnapshotIds.length > 0) {
      await db
        .delete(heatmapSnapshots)
        .where(inArray(heatmapSnapshots.id, insertedSnapshotIds));
    }
    await db
      .delete(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    await db
      .delete(clientLocations)
      .where(eq(clientLocations.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
  }
}

async function main() {
  await testRefreshFanOut();
  await testPerLocationResolution();
  console.log("multi-location-keyword-resolution: all cases passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
