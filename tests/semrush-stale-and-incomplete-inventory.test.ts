/* test-registration
{
  "name": "SEMrush stale-campaign + incomplete-inventory paths (Task #740)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for two SEMrush sync paths that sit adjacent to the
 * coverage / idempotency contract pinned by tests/semrush-resync-idempotency.test.ts
 * but exercise behavior #618 deliberately did not cover:
 *
 *   1. SemrushNotFoundError on `getCampaign` → the matching
 *      `semrush_location_campaigns` row is flipped to stale
 *      (`isStale=true`, `staleSince` populated), other locations on the same
 *      client continue to sync, and the multi-location aggregate surfaces a
 *      "stale" warning rather than a hard failure.
 *
 *   2. `getCampaignKeywordsWithMeta` returns `complete: false` →
 *      stale-keyword pruning is correctly skipped (no snapshots deleted),
 *      the per-campaign result reports `keywordInventoryComplete=false`, and
 *      the multi-location aggregate produces the
 *      "incomplete keyword inventory" warning string.
 */
import { db } from "../server/db";
import {
  clients,
  clientLocations,
  clientSemrushIntegrations,
  semrushLocationCampaigns,
  heatmapSnapshots,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import {
  syncCampaignForClient,
  syncSingleClient,
  __setSemrushSyncTestOverrides,
} from "../server/services/localDominanceSyncWorker";
import { SemrushNotFoundError } from "../server/services/semrushApi";
import type { SemrushHeatmapPoint } from "../server/services/semrushApi";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `ssii-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REPORT_DATE = "2026-04-15";
const REPORT_DATE_ISO = `${REPORT_DATE}T12:00:00.000Z`;

const createdSnapshotIds: string[] = [];
const createdIntegrationIds: string[] = [];
const createdMappingIds: string[] = [];
const createdLocationIds: string[] = [];
const createdClientIds: string[] = [];

async function seedClient(name: string): Promise<string> {
  const [row] = await db.insert(clients).values({ firmName: name }).returning({ id: clients.id });
  createdClientIds.push(row.id);
  return row.id;
}

async function seedLocation(clientId: string, name: string): Promise<string> {
  const [row] = await db.insert(clientLocations).values({ clientId, name }).returning({ id: clientLocations.id });
  createdLocationIds.push(row.id);
  return row.id;
}

async function seedMapping(clientId: string, locationId: string, campaignId: string, name: string): Promise<string> {
  const [row] = await db.insert(semrushLocationCampaigns).values({
    clientId,
    locationId,
    semrushCampaignId: campaignId,
    semrushCampaignName: name,
    isStale: false,
  }).returning({ id: semrushLocationCampaigns.id });
  createdMappingIds.push(row.id);
  return row.id;
}

async function seedIntegration(clientId: string): Promise<typeof clientSemrushIntegrations.$inferSelect> {
  const [row] = await db.insert(clientSemrushIntegrations).values({
    clientId,
    semrushCampaignId: null,
    businessName: "Test Business",
    integrationEnabled: true,
    isActive: true,
    syncStatus: "idle",
    errorMessage: null,
  }).returning();
  createdIntegrationIds.push(row.id);
  return row;
}

async function seedSnapshot(args: {
  clientId: string;
  locationId: string;
  campaignId: string;
  keywordName: string;
  reportDateIso: string;
}): Promise<string> {
  const [row] = await db.insert(heatmapSnapshots).values({
    clientId: args.clientId,
    locationId: args.locationId,
    locationName: "Test Loc",
    campaignId: args.campaignId,
    keywordName: args.keywordName,
    reportDate: new Date(args.reportDateIso),
    businessLat: 40.0,
    businessLng: -75.0,
    gridTemplate: "9x9",
    gridUnit: "MILES",
    gridDistance: 5,
    baseLat: 40.0,
    baseLng: -75.0,
    rawPayload: {},
  }).returning({ id: heatmapSnapshots.id });
  createdSnapshotIds.push(row.id);
  return row.id;
}

interface CampaignSpec {
  notFound?: boolean;
  keywords: { id: string; name: string }[];
  keywordListComplete?: boolean;
  keywordListIncompleteReason?: "page_cap_reached" | "aborted" | "non_array_payload";
}

interface OverrideTrace {
  getCampaignCalls: string[];
  getHeatmapCalls: Array<{ campaignId: string; keywordId: string }>;
}

function newTrace(): OverrideTrace {
  return { getCampaignCalls: [], getHeatmapCalls: [] };
}

/**
 * Per-campaign override: dispatch on `cid` so a single override can drive a
 * multi-location client where the campaigns must behave differently
 * (one 404s, the other returns normally).
 */
function withPerCampaignOverride(
  campaigns: Record<string, CampaignSpec>,
  trace: OverrideTrace,
): () => void {
  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => {
        trace.getCampaignCalls.push(cid);
        const spec = campaigns[cid];
        if (!spec) throw new Error(`Test override: unknown campaign id ${cid}`);
        if (spec.notFound) {
          throw new SemrushNotFoundError(`Semrush API 404: campaign ${cid} not found (test)`);
        }
        return {
          id: cid,
          reportDates: [REPORT_DATE_ISO],
          businessName: "Test Business",
          gridSettings: {
            template: "9x9",
            unit: "MILES",
            distance: 5,
            basePoint: { lat: 40, lng: -75 },
          },
          lat: 40,
          lng: -75,
        };
      },
      getCampaignKeywordsWithMeta: async (cid: string) => {
        const spec = campaigns[cid];
        if (!spec) throw new Error(`Test override: unknown campaign id ${cid}`);
        const complete = spec.keywordListComplete ?? true;
        return {
          keywords: spec.keywords.map(k => ({ id: k.id, name: k.name, status: "ACTIVE" })),
          complete,
          ...(complete ? {} : { incompleteReason: spec.keywordListIncompleteReason ?? "page_cap_reached" as const }),
        };
      },
      findBestReportDate: (dates: string[], _month: string) => dates[0] ?? null,
      getHeatmapData: async (cid: string, kid: string) => {
        trace.getHeatmapCalls.push({ campaignId: cid, keywordId: kid });
        const spec = campaigns[cid];
        const kw = spec?.keywords.find(k => k.id === kid)!;
        const positions: SemrushHeatmapPoint[] = [
          { point: { id: "p1", lat: 40, lng: -75 }, rank: 1, diff: 0 },
        ];
        return {
          keyword: { id: kw.id, name: kw.name },
          date: REPORT_DATE_ISO,
          positions,
        };
      },
    },
  });
  return () => __setSemrushSyncTestOverrides(null);
}

// ----------------------------------------------------------------------------
// Test 1 — SemrushNotFoundError on one campaign of a multi-location client.
//   • The 404'd campaign's mapping is flipped to stale.
//   • The other location continues to sync (here: already_current, no fetch).
//   • Aggregate outcome is partial_success with a "stale" warning, NOT a
//     hard failure (which would have surfaced as syncStatus="error" via the
//     thrown "All N stale" path).
// ----------------------------------------------------------------------------
async function testStaleCampaignDoesNotPoisonSiblings(): Promise<void> {
  const clientId = await seedClient(`SSII Stale ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "LocA-StaleSource");
  const locB = await seedLocation(clientId, "LocB-StillGood");
  const campA = `camp-${TEST_TAG}-stale`;
  const campB = `camp-${TEST_TAG}-good`;
  const mapAId = await seedMapping(clientId, locA, campA, "Camp A (will go 404)");
  const mapBId = await seedMapping(clientId, locB, campB, "Camp B (still live)");

  // Pre-seed locB as fully current so its sync resolves to already_current
  // without needing any heatmap fetches.
  await seedSnapshot({
    clientId, locationId: locB, campaignId: campB,
    keywordName: "estate planning attorney", reportDateIso: REPORT_DATE_ISO,
  });

  const integration = await seedIntegration(clientId);

  const trace = newTrace();
  const restore = withPerCampaignOverride(
    {
      [campA]: { notFound: true, keywords: [] },
      [campB]: { keywords: [{ id: "kwB1", name: "estate planning attorney" }] },
    },
    trace,
  );

  try {
    const result = await syncSingleClient(clientId);
    assert(result.success === true,
      `expected syncSingleClient overall success (stale is not a hard failure when at least one sibling succeeded), got ${JSON.stringify(result)}`);

    // No heatmap fetches: locA 404'd before any keyword work, locB was
    // already current. This guards against accidental re-fetch on the still
    // -live sibling.
    assert(trace.getHeatmapCalls.length === 0,
      `expected 0 heatmap fetches (locA stale, locB already current), got ${trace.getHeatmapCalls.length}`);

    // Mapping A must be flipped to stale; mapping B must stay live.
    const [afterA] = await db.select()
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.id, mapAId));
    assert(afterA.isStale === true,
      `expected stale mapping A.isStale=true, got ${afterA.isStale}`);
    assert(afterA.staleSince !== null,
      `expected stale mapping A.staleSince to be populated, got ${afterA.staleSince}`);

    const [afterB] = await db.select()
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.id, mapBId));
    assert(afterB.isStale === false,
      `expected sibling mapping B.isStale=false (sibling must not be poisoned), got ${afterB.isStale}`);
    assert(afterB.staleSince === null,
      `expected sibling mapping B.staleSince=null, got ${afterB.staleSince}`);

    // Aggregate must surface as partial_success with a "stale" warning, NOT
    // an error. Note: syncSingleClient stamps syncStatus="success" whenever
    // syncClientIntegration returns (errors are thrown), so the failure-vs-
    // stale distinction lives in lastSyncOutcome + warningMessage.
    const [after] = await db.select()
      .from(clientSemrushIntegrations)
      .where(eq(clientSemrushIntegrations.id, integration.id));
    assert(after.syncStatus === "success",
      `expected syncStatus=success, got ${after.syncStatus}`);
    assert(after.lastSyncOutcome === "partial_success",
      `expected lastSyncOutcome=partial_success when one of N campaigns is stale, got ${after.lastSyncOutcome}`);
    assert(after.warningMessage !== null,
      `expected warningMessage to be set on stale-sibling outcome`);
    assert(/stale/i.test(after.warningMessage ?? ""),
      `expected warningMessage to mention "stale", got: ${after.warningMessage}`);
    assert(!/\bfailed\b/i.test(after.warningMessage ?? "") || /stale/i.test(after.warningMessage ?? ""),
      `warningMessage should classify the 404 as stale, not as a hard failure: ${after.warningMessage}`);
  } finally {
    restore();
  }
  console.log(`[Test1 StaleCampaignDoesNotPoisonSiblings] ✓`);
}

// ----------------------------------------------------------------------------
// Test 2 — keywordListComplete=false skips stale-keyword pruning AND the
// aggregate surfaces an "incomplete keyword inventory" warning.
//
//   • Per-campaign result: keywordInventoryComplete === false.
//   • A snapshot for a keyword no longer in SEMrush remains untouched
//     (proof that pruning was skipped).
//   • syncSingleClient → integration.warningMessage contains the canonical
//     "incomplete keyword inventory" string.
// ----------------------------------------------------------------------------
async function testIncompleteInventorySkipsPruneAndWarnsAtAggregate(): Promise<void> {
  const clientId = await seedClient(`SSII Incomplete ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-incomplete`;
  await seedMapping(clientId, locId, campId, "Camp Incomplete");

  // Pre-seed: one snapshot for the keyword SEMrush still advertises
  // (so the campaign resolves to already_current with no heatmap fetches),
  // PLUS one snapshot for a keyword SEMrush no longer returns. The latter
  // would be pruned if the cleanup safety guard misfired; we assert it
  // survives because keywordListComplete=false MUST skip the prune.
  await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "divorce lawyer", reportDateIso: REPORT_DATE_ISO,
  });
  const survivorId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "removed-by-semrush keyword",
    reportDateIso: REPORT_DATE_ISO,
  });

  const integration = await seedIntegration(clientId);

  const trace = newTrace();
  const restore = withPerCampaignOverride(
    {
      [campId]: {
        keywords: [{ id: "kw1", name: "divorce lawyer" }],
        keywordListComplete: false,
      },
    },
    trace,
  );

  try {
    // (a) Per-campaign result must report keywordInventoryComplete=false.
    const perCampaign = await syncCampaignForClient(clientId, campId, locId, "Test Business");
    assert(perCampaign.keywordInventoryComplete === false,
      `expected keywordInventoryComplete=false on incomplete inventory, got ${perCampaign.keywordInventoryComplete}`);
    // (b) The "removed-by-semrush keyword" snapshot MUST still exist —
    //     proof that stale-keyword pruning was skipped.
    const survivorRowsAfterDirect = await db.select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(eq(heatmapSnapshots.id, survivorId));
    assert(survivorRowsAfterDirect.length === 1,
      `expected the would-be-pruned snapshot to survive incomplete-inventory sync (direct call)`);
    // No heatmap fetches: "divorce lawyer" was already current.
    assert(trace.getHeatmapCalls.length === 0,
      `expected 0 heatmap fetches (already current), got ${trace.getHeatmapCalls.length}`);

    // (c) Run the production aggregate path so we can assert the warning
    //     wording the operator actually sees on the integration row.
    const result = await syncSingleClient(clientId);
    assert(result.success === true,
      `expected syncSingleClient success on incomplete-inventory + already-current data, got ${JSON.stringify(result)}`);

    const survivorRowsAfterAggregate = await db.select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(eq(heatmapSnapshots.id, survivorId));
    assert(survivorRowsAfterAggregate.length === 1,
      `expected the would-be-pruned snapshot to survive incomplete-inventory sync (aggregate call)`);

    const [after] = await db.select()
      .from(clientSemrushIntegrations)
      .where(eq(clientSemrushIntegrations.id, integration.id));
    assert(after.syncStatus === "success",
      `expected syncStatus=success on cleanup-only warning path, got ${after.syncStatus}`);
    assert(after.warningMessage !== null,
      `expected warningMessage to be set when keyword inventory is incomplete`);
    assert(/incomplete keyword inventory/i.test(after.warningMessage ?? ""),
      `expected warningMessage to contain "incomplete keyword inventory", got: ${after.warningMessage}`);
    assert(/cleanup skipped/i.test(after.warningMessage ?? ""),
      `expected warningMessage to mention that cleanup was skipped, got: ${after.warningMessage}`);
    // Operators must be told *which* campaign(s) had the incomplete inventory and *why*,
    // so they can decide whether to retry, raise the page cap, or leave it.
    assert((after.warningMessage ?? "").includes(campId),
      `expected warningMessage to name the affected campaign id "${campId}", got: ${after.warningMessage}`);
    assert(/page cap reached/i.test(after.warningMessage ?? ""),
      `expected warningMessage to include the abort reason "page cap reached", got: ${after.warningMessage}`);
  } finally {
    restore();
  }
  console.log(`[Test2 IncompleteInventorySkipsPruneAndWarnsAtAggregate] ✓`);
}

// ----------------------------------------------------------------------------
// Cleanup
// ----------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  if (createdClientIds.length > 0) {
    await db.delete(heatmapSnapshots)
      .where(inArray(heatmapSnapshots.clientId, createdClientIds));
  } else if (createdSnapshotIds.length > 0) {
    await db.delete(heatmapSnapshots)
      .where(inArray(heatmapSnapshots.id, createdSnapshotIds));
  }
  if (createdMappingIds.length > 0) {
    await db.delete(semrushLocationCampaigns).where(inArray(semrushLocationCampaigns.id, createdMappingIds));
  }
  if (createdIntegrationIds.length > 0) {
    await db.delete(clientSemrushIntegrations).where(inArray(clientSemrushIntegrations.id, createdIntegrationIds));
  }
  if (createdLocationIds.length > 0) {
    await db.delete(clientLocations).where(inArray(clientLocations.id, createdLocationIds));
  }
  if (createdClientIds.length > 0) {
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  try {
    await testStaleCampaignDoesNotPoisonSiblings();
    await testIncompleteInventorySkipsPruneAndWarnsAtAggregate();
    console.log("semrush-stale-and-incomplete-inventory: all cases passed");
  } catch (err) {
    console.error("semrush-stale-and-incomplete-inventory: FAILED", err);
    __setSemrushSyncTestOverrides(null);
    await cleanup();
    process.exitCode = 1;
  }
  __setSemrushSyncTestOverrides(null);
  await cleanup();
})();
