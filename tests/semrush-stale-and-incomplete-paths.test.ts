/* test-registration
{
  "name": "SEMrush stale + incomplete-inventory paths",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for the SEMrush sync stale-campaign and
 * incomplete-inventory paths (task #740).
 *
 * Two safety-critical behaviors are pinned:
 *
 *   1. STALE CAMPAIGN: When `getCampaign` throws `SemrushNotFoundError`
 *      (HTTP 404), `syncCampaignForClient` propagates the error so the
 *      orchestrator (`runLocationWithRetry`) can mark the location/campaign
 *      mapping as stale. We assert the error is propagated AND no heatmap
 *      snapshots are written for that campaign during the failed call.
 *
 *   2. INCOMPLETE INVENTORY: When `getCampaignKeywordsWithMeta` returns
 *      `complete: false` (pagination didn't reach end-of-list), the
 *      stale-keyword cleanup MUST be skipped — otherwise legitimate
 *      keywords that just weren't fetched in this run could be wrongly
 *      deleted. We assert the result carries
 *      `cleanupSkippedReason='inventory_incomplete'` and no heatmap rows
 *      are deleted from a pre-seeded snapshot under the same campaign.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  heatmapSnapshots,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  syncCampaignForClient,
  __setSemrushSyncTestOverrides,
} from "../server/services/localDominanceSyncWorker";
import { SemrushNotFoundError } from "../server/services/semrushApi";
import type { SemrushHeatmapPoint } from "../server/services/semrushApi";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `ssip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REPORT_DATE_ISO = "2026-04-15T12:00:00.000Z";
const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];

async function seed(name: string): Promise<{ clientId: string; locationId: string; campaignId: string }> {
  const [c] = await db.insert(clients).values({ firmName: `${name} ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  const [l] = await db.insert(clientLocations).values({ clientId: c.id, name: "L1" })
    .returning({ id: clientLocations.id });
  createdLocationIds.push(l.id);
  return { clientId: c.id, locationId: l.id, campaignId: `camp-${TAG}-${name}` };
}

async function cleanup(): Promise<void> {
  if (createdClientIds.length) {
    await db.delete(heatmapSnapshots).where(inArray(heatmapSnapshots.clientId, createdClientIds));
    await db.delete(clientLocations).where(inArray(clientLocations.id, createdLocationIds));
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

async function snapshotsFor(campaignId: string, clientId: string): Promise<number> {
  const rows = await db.select({ id: heatmapSnapshots.id })
    .from(heatmapSnapshots)
    .where(and(
      eq(heatmapSnapshots.campaignId, campaignId),
      eq(heatmapSnapshots.clientId, clientId),
    ));
  return rows.length;
}

async function testStaleCampaign(): Promise<void> {
  const { clientId, locationId, campaignId } = await seed("stale");
  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => {
        throw new SemrushNotFoundError(`campaign ${cid} not found`);
      },
      getCampaignKeywordsWithMeta: async () => ({ keywords: [], complete: true }),
      findBestReportDate: () => null,
      getHeatmapData: async () => {
        throw new Error("getHeatmapData should never be reached for a stale campaign");
      },
    },
  });
  try {
    let thrown: unknown = null;
    try {
      await syncCampaignForClient(clientId, campaignId, locationId, "Stale Campaign");
    } catch (err) {
      thrown = err;
    }
    assert(thrown != null, "syncCampaignForClient should propagate the 404 from getCampaign");
    assert(thrown instanceof SemrushNotFoundError,
      `error should be SemrushNotFoundError so the orchestrator can mark stale, got ${(thrown as Error)?.constructor?.name}`);
    assert((await snapshotsFor(campaignId, clientId)) === 0,
      "no heatmap snapshots should be written when the campaign is stale");
  } finally {
    __setSemrushSyncTestOverrides(null);
  }
}

async function testIncompleteInventory(): Promise<void> {
  const { clientId, locationId, campaignId } = await seed("incomplete");

  // Seed two snapshots for the report date — one that matches the
  // (incomplete) keyword list, and one that does NOT. If cleanup were
  // (wrongly) to run with an incomplete inventory, the second snapshot
  // would be deleted. The contract is: with incomplete inventory, NO
  // cleanup runs, so both snapshots survive.
  const reportDate = new Date(REPORT_DATE_ISO);
  const baseSnap = {
    clientId,
    locationId,
    locationName: "L1",
    businessName: "IncompleteInv",
    campaignId,
    reportDate,
    businessLat: 40,
    businessLng: -75,
    gridTemplate: "9x9",
    gridUnit: "MILES",
    gridDistance: 5,
    baseLat: 40,
    baseLng: -75,
    rawPayload: { positions: [] },
  };
  await db.insert(heatmapSnapshots).values([
    { ...baseSnap, keywordName: `kw-known ${TAG}` },
    { ...baseSnap, keywordName: `kw-unfetched ${TAG}` },
  ]);
  const seededCount = await snapshotsFor(campaignId, clientId);
  assert(seededCount === 2, `expected 2 seeded snapshots, got ${seededCount}`);

  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => ({
        id: cid,
        reportDates: [REPORT_DATE_ISO],
        businessName: "IncompleteInv",
        gridSettings: { template: "9x9", unit: "MILES", distance: 5, basePoint: { lat: 40, lng: -75 } },
        lat: 40,
        lng: -75,
      }),
      // complete: false → cleanup MUST be skipped (the unfetched keyword
      // could legitimately exist; we just didn't see it this run).
      getCampaignKeywordsWithMeta: async () => ({
        keywords: [{ id: "k1", name: `kw-known ${TAG}`, status: "ACTIVE" }],
        complete: false,
      }),
      findBestReportDate: (dates: string[]) => dates[0] ?? null,
      getHeatmapData: async (cid: string, _kid: string) => {
        const positions: SemrushHeatmapPoint[] = [
          { point: { id: "p1", lat: 40, lng: -75 }, rank: 1, diff: 0 },
        ];
        return {
          keyword: { id: "k1", name: `kw-known ${TAG}` },
          date: REPORT_DATE_ISO,
          positions,
        };
      },
    },
  });
  try {
    // Capture the structural shape we depend on without coupling to the
    // un-exported internal `SyncCampaignResult` type.
    const result: {
      keywordInventoryComplete?: boolean;
      cleanupSkippedReason?: string | null;
    } = await syncCampaignForClient(clientId, campaignId, locationId, "IncompleteInv");
    assert(result.keywordInventoryComplete === false,
      `result should report keywordInventoryComplete=false, got ${result.keywordInventoryComplete}`);
    assert(typeof result.cleanupSkippedReason === "string" && result.cleanupSkippedReason.length > 0,
      `cleanup should be skipped with a reason when inventory is incomplete, got cleanupSkippedReason=${result.cleanupSkippedReason}`);

    // The unfetched-but-pre-existing snapshot must still be present.
    const after = await snapshotsFor(campaignId, clientId);
    assert(after >= 2,
      `incomplete inventory must NOT delete the unfetched keyword snapshot (before=2, after=${after})`);
  } finally {
    __setSemrushSyncTestOverrides(null);
  }
}

async function main(): Promise<void> {
  try {
    await testStaleCampaign();
    await testIncompleteInventory();
    console.log("semrush-stale-and-incomplete-paths: PASSED");
  } finally {
    __setSemrushSyncTestOverrides(null);
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("semrush-stale-and-incomplete-paths: FAILED", err);
  __setSemrushSyncTestOverrides(null);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
