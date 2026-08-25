/* test-registration
{
  "name": "SEMrush re-sync idempotency",
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for the SEMrush re-sync idempotency rules.
 *
 * Pins the contract of the new sync result model:
 *   - `success`         — fresh import achieved full coverage.
 *   - `already_current` — preflight coverage check showed everything is
 *                         already present for the target report date; SEMrush
 *                         heatmap fetches MUST be skipped.
 *   - `partial_success` — at least one missing keyword was imported but
 *                         coverage is still incomplete.
 *   - `failed`          — no missing keyword could be imported.
 *
 * Tests:
 *   1. Brand-new campaign → status `success`, every missing keyword fetched.
 *   2. Fully-current campaign → status `already_current`, getHeatmapData NOT
 *      called, integration row's errorMessage cleared.
 *   3. Partially-current campaign → only the missing keyword is fetched.
 *   4. Stale older-date snapshot (different reportDate) does NOT count toward
 *      current-day coverage; missing keyword still imports.
 *   5. All keyword fetches throw → status `failed`.
 *   6. Multi-location aggregation: every location's per-campaign result is
 *      `already_current` ⇒ overall syncClientIntegration outcome is `success`
 *      and errorMessage is cleared on the integration row.
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
import type { SemrushHeatmapPoint } from "../server/services/semrushApi";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `srid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REPORT_DATE = "2026-04-15";
const REPORT_DATE_ISO = `${REPORT_DATE}T12:00:00.000Z`;
const OLDER_REPORT_DATE_ISO = "2026-01-15T12:00:00.000Z";

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

async function seedIntegration(args: {
  clientId: string;
  campaignId?: string | null;
  businessName?: string;
  errorMessage?: string | null;
}): Promise<typeof clientSemrushIntegrations.$inferSelect> {
  const [row] = await db.insert(clientSemrushIntegrations).values({
    clientId: args.clientId,
    semrushCampaignId: args.campaignId ?? null,
    businessName: args.businessName ?? "Test Business",
    integrationEnabled: true,
    isActive: true,
    syncStatus: "idle",
    errorMessage: args.errorMessage ?? null,
  }).returning();
  createdIntegrationIds.push(row.id);
  return row;
}

async function seedExistingSnapshot(args: {
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

interface OverrideContext {
  campaignId: string;
  campaignKeywords: { id: string; name: string; status?: string }[];
  reportDates?: string[];
  keywordListComplete?: boolean;
  /** If set, getHeatmapData throws with this message for every keyword. */
  failAllKeywords?: boolean;
  /** Tracks recorded calls so tests can assert behavior. */
  trace: {
    getCampaignCalls: string[];
    getHeatmapCalls: Array<{ campaignId: string; keywordId: string }>;
  };
}

/**
 * Install a fake SEMrush API implementation. Only the external HTTP layer is
 * stubbed — the real `importHeatmap` continues to write through to the test
 * database so the worker's post-attempt coverage check observes real rows.
 *
 * Returns a `restore` callback that unregisters the override; tests must call
 * it (always inside `finally`) so the global seam never leaks across tests.
 */
function withSemrushOverride(ctx: OverrideContext): () => void {
  const reportDates = ctx.reportDates ?? [REPORT_DATE_ISO];
  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => {
        ctx.trace.getCampaignCalls.push(cid);
        return {
          id: cid,
          reportDates,
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
      getCampaignKeywordsWithMeta: async (_cid: string) => ({
        keywords: ctx.campaignKeywords.map(k => ({
          id: k.id,
          name: k.name,
          status: k.status ?? "ACTIVE",
        })),
        complete: ctx.keywordListComplete ?? true,
      }),
      findBestReportDate: (dates: string[], _month: string) => dates[0] ?? null,
      getHeatmapData: async (cid: string, kid: string) => {
        ctx.trace.getHeatmapCalls.push({ campaignId: cid, keywordId: kid });
        if (ctx.failAllKeywords) {
          throw new Error(`Simulated SEMrush failure for keyword ${kid}`);
        }
        const kw = ctx.campaignKeywords.find(k => k.id === kid)!;
        const positions: SemrushHeatmapPoint[] = [
          { point: { id: "p1", lat: 40, lng: -75 }, rank: 1, diff: 0 },
          { point: { id: "p2", lat: 40.01, lng: -75.01 }, rank: 5, diff: 1 },
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

function newTrace(): OverrideContext["trace"] {
  return { getCampaignCalls: [], getHeatmapCalls: [] };
}

// ----------------------------------------------------------------------------
// Test 1: brand-new campaign — every keyword imported, status=success.
// ----------------------------------------------------------------------------
async function testBrandNewCampaign(): Promise<void> {
  const clientId = await seedClient(`SRID NewCampaign ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-new`;
  const ctx: OverrideContext = {
    campaignId: campId,
    campaignKeywords: [
      { id: "kw1", name: "estate planning attorney" },
      { id: "kw2", name: "probate lawyer" },
    ],
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);
  try {
    const result = await syncCampaignForClient(clientId, campId, locId, "Test Business");
    assert(result.status === "success", `expected status=success, got ${result.status}`);
    assert(result.imported === 2, `expected imported=2, got ${result.imported}`);
    assert(result.attempted === 2, `expected attempted=2, got ${result.attempted}`);
    assert(result.skippedAlreadyCurrent === 0,
      `expected skippedAlreadyCurrent=0, got ${result.skippedAlreadyCurrent}`);
    assert(result.existingCoverageCount === 2,
      `expected existingCoverageCount=2, got ${result.existingCoverageCount}`);
    assert(ctx.trace.getHeatmapCalls.length === 2,
      `expected 2 SEMrush heatmap fetches, got ${ctx.trace.getHeatmapCalls.length}`);
  } finally {
    restore();
  }
  console.log(`[Test1 BrandNewCampaign] ✓`);
}

// ----------------------------------------------------------------------------
// Test 2: fully-current campaign — already_current, no SEMrush heatmap calls.
// ----------------------------------------------------------------------------
async function testFullyCurrentSkipsFetch(): Promise<void> {
  const clientId = await seedClient(`SRID Current ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-cur`;

  await seedExistingSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "divorce lawyer", reportDateIso: REPORT_DATE_ISO,
  });
  await seedExistingSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "family law attorney", reportDateIso: REPORT_DATE_ISO,
  });

  const ctx: OverrideContext = {
    campaignId: campId,
    campaignKeywords: [
      { id: "kw1", name: "divorce lawyer" },
      { id: "kw2", name: "family law attorney" },
    ],
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);
  try {
    const result = await syncCampaignForClient(clientId, campId, locId, "Test Business");
    assert(result.status === "already_current",
      `expected status=already_current, got ${result.status}`);
    assert(result.imported === 0, `expected imported=0, got ${result.imported}`);
    assert(result.skippedAlreadyCurrent === 2,
      `expected skippedAlreadyCurrent=2, got ${result.skippedAlreadyCurrent}`);
    assert(result.existingCoverageCount === 2,
      `expected existingCoverageCount=2, got ${result.existingCoverageCount}`);
    assert(ctx.trace.getHeatmapCalls.length === 0,
      `expected 0 SEMrush heatmap fetches when already current, got ${ctx.trace.getHeatmapCalls.length}`);
  } finally {
    restore();
  }
  console.log(`[Test2 FullyCurrentSkipsFetch] ✓`);
}

// ----------------------------------------------------------------------------
// Test 3: partially-current campaign — only the missing keyword is fetched.
// ----------------------------------------------------------------------------
async function testPartiallyCurrentFetchesMissingOnly(): Promise<void> {
  const clientId = await seedClient(`SRID Partial ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-part`;

  // One of the two expected keywords already has a current-day snapshot.
  await seedExistingSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "divorce lawyer", reportDateIso: REPORT_DATE_ISO,
  });

  const ctx: OverrideContext = {
    campaignId: campId,
    campaignKeywords: [
      { id: "kw1", name: "divorce lawyer" },          // already current
      { id: "kw2", name: "family law attorney" },     // missing
    ],
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);
  try {
    const result = await syncCampaignForClient(clientId, campId, locId, "Test Business");
    assert(result.status === "success",
      `expected status=success after backfilling the missing keyword, got ${result.status}`);
    assert(result.imported === 1, `expected imported=1, got ${result.imported}`);
    assert(result.skippedAlreadyCurrent === 1,
      `expected skippedAlreadyCurrent=1, got ${result.skippedAlreadyCurrent}`);
    assert(ctx.trace.getHeatmapCalls.length === 1,
      `expected exactly 1 SEMrush heatmap fetch, got ${ctx.trace.getHeatmapCalls.length}`);
    assert(ctx.trace.getHeatmapCalls[0].keywordId === "kw2",
      `expected the fetched keyword to be the missing one (kw2), got ${ctx.trace.getHeatmapCalls[0].keywordId}`);
  } finally {
    restore();
  }
  console.log(`[Test3 PartiallyCurrentFetchesMissingOnly] ✓`);
}

// ----------------------------------------------------------------------------
// Test 4: stale older-date snapshot does NOT count as current.
// ----------------------------------------------------------------------------
async function testOlderDateDoesNotCountAsCurrent(): Promise<void> {
  const clientId = await seedClient(`SRID Older ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-old`;

  // Snapshot exists but on a previous report date — must NOT satisfy current
  // coverage; the sync should still fetch the keyword for today.
  await seedExistingSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "divorce lawyer", reportDateIso: OLDER_REPORT_DATE_ISO,
  });

  const ctx: OverrideContext = {
    campaignId: campId,
    campaignKeywords: [{ id: "kw1", name: "divorce lawyer" }],
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);
  try {
    const result = await syncCampaignForClient(clientId, campId, locId, "Test Business");
    assert(result.status === "success",
      `expected status=success (older snapshot must not be treated as current), got ${result.status}`);
    assert(result.imported === 1, `expected imported=1, got ${result.imported}`);
    assert(result.skippedAlreadyCurrent === 0,
      `expected skippedAlreadyCurrent=0 (older date should not count), got ${result.skippedAlreadyCurrent}`);
    assert(ctx.trace.getHeatmapCalls.length === 1,
      `expected 1 SEMrush heatmap fetch even with older snapshot present, got ${ctx.trace.getHeatmapCalls.length}`);
  } finally {
    restore();
  }
  console.log(`[Test4 OlderDateDoesNotCountAsCurrent] ✓`);
}

// ----------------------------------------------------------------------------
// Test 5: all-failures path — every fetch throws → status `failed`.
// ----------------------------------------------------------------------------
async function testAllFailuresReturnsFailed(): Promise<void> {
  const clientId = await seedClient(`SRID AllFail ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-fail`;

  const ctx: OverrideContext = {
    campaignId: campId,
    campaignKeywords: [
      { id: "kw1", name: "estate planning attorney" },
      { id: "kw2", name: "probate lawyer" },
    ],
    failAllKeywords: true,
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);
  try {
    const result = await syncCampaignForClient(clientId, campId, locId, "Test Business");
    assert(result.status === "failed", `expected status=failed, got ${result.status}`);
    assert(result.imported === 0, `expected imported=0, got ${result.imported}`);
    assert(result.keywordErrors.length === 2,
      `expected 2 keyword errors, got ${result.keywordErrors.length}`);
    assert(result.existingCoverageCount === 0,
      `expected existingCoverageCount=0, got ${result.existingCoverageCount}`);
  } finally {
    restore();
  }
  console.log(`[Test5 AllFailuresReturnsFailed] ✓`);
}

// ----------------------------------------------------------------------------
// Test 6: multi-location aggregation. Both locations are already_current →
// the production manager (`syncSingleClient`) clears errorMessage/warningMessage
// and reports overall success.
// ----------------------------------------------------------------------------
async function testMultiLocationAlreadyCurrentAggregatesAsSuccess(): Promise<void> {
  const clientId = await seedClient(`SRID Multi ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "LocA");
  const locB = await seedLocation(clientId, "LocB");
  const campA = `camp-${TEST_TAG}-A`;
  const campB = `camp-${TEST_TAG}-B`;
  await seedMapping(clientId, locA, campA, "Camp A");
  await seedMapping(clientId, locB, campB, "Camp B");

  // The shared override below advertises BOTH keywords for every campaign.
  // Pre-seed both as current-day snapshots for each (location, campaign) so
  // every per-campaign sync resolves to already_current.
  for (const [loc, camp] of [[locA, campA], [locB, campB]] as const) {
    for (const kw of ["divorce lawyer", "family law attorney"]) {
      await seedExistingSnapshot({
        clientId, locationId: loc, campaignId: camp,
        keywordName: kw, reportDateIso: REPORT_DATE_ISO,
      });
    }
  }

  // Stale errorMessage from a prior failure that the success path is required
  // to clear. We do NOT clear it ourselves — `syncSingleClient` must.
  const integration = await seedIntegration({
    clientId,
    campaignId: null,
    errorMessage: "previous failure that the success path must clear",
  });

  // Single shared override that knows about both campaigns. getHeatmapData
  // throws to assert it's never called when both locations are already current.
  const ctx: OverrideContext = {
    campaignId: `${campA}|${campB}`,
    campaignKeywords: [
      { id: "a1", name: "divorce lawyer" },
      { id: "b1", name: "family law attorney" },
    ],
    failAllKeywords: true, // any heatmap fetch must fail loudly
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);

  try {
    const result = await syncSingleClient(clientId);
    assert(result.success === true,
      `expected syncSingleClient to report success, got ${JSON.stringify(result)}`);
    assert(ctx.trace.getHeatmapCalls.length === 0,
      `expected 0 SEMrush heatmap fetches when both locations already current, got ${ctx.trace.getHeatmapCalls.length}`);

    const [after] = await db.select()
      .from(clientSemrushIntegrations)
      .where(eq(clientSemrushIntegrations.id, integration.id));
    assert(after.syncStatus === "success",
      `expected syncStatus=success after multi-location already_current, got ${after.syncStatus}`);
    assert(after.errorMessage === null,
      `expected errorMessage cleared by production sync path, got ${after.errorMessage}`);
    assert(after.warningMessage === null,
      `expected warningMessage null when every location is already current, got ${after.warningMessage}`);
    assert(after.lastSuccessfulSyncAt !== null,
      `expected lastSuccessfulSyncAt to be stamped`);
  } finally {
    restore();
  }
  console.log(`[Test6 MultiLocationAlreadyCurrentAggregatesAsSuccess] ✓`);
}

// ----------------------------------------------------------------------------
// Test 7: production sync path (`syncSingleClient`) clears stale errorMessage
// after a fresh, full-import success on a single-campaign integration.
// ----------------------------------------------------------------------------
async function testSuccessfulSyncClearsErrorMessage(): Promise<void> {
  const clientId = await seedClient(`SRID ClearErr ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-clearerr`;
  // No mapping rows — exercise the integration.semrushCampaignId path
  // through syncSingleClient → syncClientIntegration → syncCampaignForClient.
  const integration = await seedIntegration({
    clientId,
    campaignId: campId,
    errorMessage: "previous failure that the success path must clear",
  });
  // syncCampaignForClient uses the mapping's locationId when present, but the
  // single-campaign branch passes integration.businessLocationId instead.
  // Set businessLocationId so importHeatmap stub seeds the snapshot under the
  // location the post-attempt coverage check will look at.
  await db.update(clientSemrushIntegrations)
    .set({ businessLocationId: locId })
    .where(eq(clientSemrushIntegrations.id, integration.id));

  const ctx: OverrideContext = {
    campaignId: campId,
    campaignKeywords: [{ id: "kw1", name: "estate planning attorney" }],
    trace: newTrace(),
  };
  const restore = withSemrushOverride(ctx);
  try {
    const result = await syncSingleClient(clientId);
    assert(result.success === true,
      `expected syncSingleClient to succeed, got ${JSON.stringify(result)}`);
    assert(ctx.trace.getHeatmapCalls.length === 1,
      `expected 1 SEMrush heatmap fetch on fresh import, got ${ctx.trace.getHeatmapCalls.length}`);

    const [after] = await db.select()
      .from(clientSemrushIntegrations)
      .where(eq(clientSemrushIntegrations.id, integration.id));
    assert(after.syncStatus === "success",
      `expected syncStatus=success after fresh import, got ${after.syncStatus}`);
    assert(after.errorMessage === null,
      `expected errorMessage cleared by production sync path, got ${after.errorMessage}`);
    assert(after.lastSuccessfulSyncAt !== null,
      `expected lastSuccessfulSyncAt to be stamped`);
  } finally {
    restore();
  }
  console.log(`[Test7 SuccessfulSyncClearsErrorMessage] ✓`);
}

// ----------------------------------------------------------------------------
// Cleanup
// ----------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  // Delete every heatmap_snapshots row owned by our test clients (covers both
  // pre-seeded rows tracked in createdSnapshotIds and rows created indirectly
  // by the production importHeatmap path during Test 7).
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
    await testBrandNewCampaign();
    await testFullyCurrentSkipsFetch();
    await testPartiallyCurrentFetchesMissingOnly();
    await testOlderDateDoesNotCountAsCurrent();
    await testAllFailuresReturnsFailed();
    await testMultiLocationAlreadyCurrentAggregatesAsSuccess();
    await testSuccessfulSyncClearsErrorMessage();
    console.log("semrush-resync-idempotency: all cases passed");
  } catch (err) {
    console.error("semrush-resync-idempotency: FAILED", err);
    __setSemrushSyncTestOverrides(null);
    await cleanup();
    process.exitCode = 1;
  }
  __setSemrushSyncTestOverrides(null);
  await cleanup();
})();
