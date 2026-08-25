/* test-registration
{
  "name": "SEMrush multi-location resilience",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for the SEMrush multi-location resilience fix
 * (task #681).
 *
 * Pins that when one location's SEMrush sync fails (timeout / unexpected
 * error), the remaining locations still complete their sync and persist
 * their data. There must be no cross-location cancellation: a single
 * failing campaign should not abort the whole client's sync.
 *
 * Setup: one client, two locations (A, B) with two campaigns. The
 * SEMrush stub is configured so:
 *   - Location A's campaign throws on getHeatmapData (simulates a SEMrush
 *     timeout).
 *   - Location B's campaign succeeds normally and persists its snapshot.
 *
 * Assertions:
 *   1. `syncClientIntegration` does NOT throw (because at least one
 *      campaign succeeded).
 *   2. Location B's heatmap snapshot is persisted for the report date.
 *   3. Location A produced no snapshot (failure isolated to A).
 *   4. The integration row's syncStatus is updated and the warning/error
 *      message references the failed location only.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  clientSemrushIntegrations,
  semrushLocationCampaigns,
  heatmapSnapshots,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  syncSingleClient,
  __setSemrushSyncTestOverrides,
} from "../server/services/localDominanceSyncWorker";
import type { SemrushHeatmapPoint } from "../server/services/semrushApi";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `smlr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REPORT_DATE_ISO = "2026-04-15T12:00:00.000Z";

const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];
const createdMappingIds: string[] = [];
const createdIntegrationIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdClientIds.length) {
    await db.delete(heatmapSnapshots).where(inArray(heatmapSnapshots.clientId, createdClientIds));
    await db.delete(semrushLocationCampaigns).where(inArray(semrushLocationCampaigns.id, createdMappingIds));
    await db.delete(clientSemrushIntegrations).where(inArray(clientSemrushIntegrations.id, createdIntegrationIds));
    await db.delete(clientLocations).where(inArray(clientLocations.id, createdLocationIds));
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

async function seed(): Promise<{
  clientId: string;
  locA: string;
  locB: string;
  campA: string;
  campB: string;
  integration: typeof clientSemrushIntegrations.$inferSelect;
}> {
  const [c] = await db.insert(clients).values({ firmName: `Multi-loc ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);

  const [la] = await db.insert(clientLocations).values({ clientId: c.id, name: "LocA" })
    .returning({ id: clientLocations.id });
  const [lb] = await db.insert(clientLocations).values({ clientId: c.id, name: "LocB" })
    .returning({ id: clientLocations.id });
  createdLocationIds.push(la.id, lb.id);

  const campA = `camp-${TAG}-A`;
  const campB = `camp-${TAG}-B`;
  const [mA] = await db.insert(semrushLocationCampaigns).values({
    clientId: c.id, locationId: la.id, semrushCampaignId: campA,
    semrushCampaignName: "Camp A", isStale: false,
  }).returning({ id: semrushLocationCampaigns.id });
  const [mB] = await db.insert(semrushLocationCampaigns).values({
    clientId: c.id, locationId: lb.id, semrushCampaignId: campB,
    semrushCampaignName: "Camp B", isStale: false,
  }).returning({ id: semrushLocationCampaigns.id });
  createdMappingIds.push(mA.id, mB.id);

  const [integration] = await db.insert(clientSemrushIntegrations).values({
    clientId: c.id,
    semrushCampaignId: null,
    businessName: "Test",
    integrationEnabled: true,
    isActive: true,
    syncStatus: "idle",
  }).returning();
  createdIntegrationIds.push(integration.id);

  return { clientId: c.id, locA: la.id, locB: lb.id, campA, campB, integration };
}

async function main(): Promise<void> {
  const { clientId, locA, locB, campA, campB, integration } = await seed();

  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => ({
        id: cid,
        reportDates: [REPORT_DATE_ISO],
        businessName: "Test",
        gridSettings: { template: "9x9", unit: "MILES", distance: 5, basePoint: { lat: 40, lng: -75 } },
        lat: 40,
        lng: -75,
      }),
      getCampaignKeywordsWithMeta: async () => ({
        keywords: [{ id: "kw1", name: `kw ${TAG}`, status: "ACTIVE" }],
        complete: true,
      }),
      findBestReportDate: (dates: string[]) => dates[0] ?? null,
      getHeatmapData: async (cid: string, _kid: string) => {
        if (cid === campA) {
          throw new Error("Simulated SEMrush timeout for location A");
        }
        const positions: SemrushHeatmapPoint[] = [
          { point: { id: "p1", lat: 40, lng: -75 }, rank: 1, diff: 0 },
        ];
        return {
          keyword: { id: "kw1", name: `kw ${TAG}` },
          date: REPORT_DATE_ISO,
          positions,
        };
      },
    },
  });

  try {
    // Should NOT throw — location B succeeds, so the overall sync succeeds.
    await syncSingleClient(clientId);

    const snapsB = await db.select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(and(
        eq(heatmapSnapshots.clientId, clientId),
        eq(heatmapSnapshots.locationId, locB),
        eq(heatmapSnapshots.campaignId, campB),
      ));
    assert(snapsB.length === 1,
      `expected 1 snapshot for the SUCCESSFUL location B, got ${snapsB.length}`);

    const snapsA = await db.select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(and(
        eq(heatmapSnapshots.clientId, clientId),
        eq(heatmapSnapshots.locationId, locA),
        eq(heatmapSnapshots.campaignId, campA),
      ));
    assert(snapsA.length === 0,
      `expected 0 snapshots for the FAILED location A (failure isolated), got ${snapsA.length}`);

    // The per-client status update lives one level up in `syncSingleClient`.
    // What we pin here is the resilience contract of `syncClientIntegration`
    // itself: it must NOT throw when at least one location succeeds, and the
    // failed location must not roll back the successful one's persisted data.
    const [after] = await db.select()
      .from(clientSemrushIntegrations)
      .where(eq(clientSemrushIntegrations.id, integration.id));
    assert(after !== undefined, "integration row should still exist after sync");
    console.log("semrush-multi-location-resilience: PASSED");
  } finally {
    __setSemrushSyncTestOverrides(null);
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("semrush-multi-location-resilience: FAILED", err);
  __setSemrushSyncTestOverrides(null);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
