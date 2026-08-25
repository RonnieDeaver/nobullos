/* test-registration
{
  "name": "Stale-keyword cleanup",
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * Stale-keyword cleanup regression coverage (reviewer point #7).
 *
 * Pins the safety + correctness contract for the stale-keyword cleanup work:
 *   1. Removed keyword disappears from current dashboard availability
 *      (read-path: getPerLocationSnapshots latest-period filter).
 *   2. Removed keyword's HISTORICAL snapshots remain (cleanup is current-date
 *      only; read-path does not delete).
 *   3. Incomplete keyword inventory must NOT trigger stale-keyword deletion.
 *   4. Empty SEMrush keyword list must NOT trigger deletion.
 *   5. Aborted sync must NOT trigger deletion.
 *   6. Keyword comparison is normalization-safe ("Divorce Lawyer" vs
 *      "divorce lawyer" / leading whitespace).
 *   7. Cleanup deletes only the current-date snapshots whose keyword is
 *      genuinely missing from the current SEMrush list.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  semrushLocationCampaigns,
  heatmapSnapshots,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { pruneStaleKeywordSnapshots } from "../server/services/localDominanceSyncWorker";
import { getPerLocationSnapshots } from "../server/services/localDominanceService";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `skc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdSnapshotIds: string[] = [];
const createdMappingIds: string[] = [];
const createdLocationIds: string[] = [];
const createdClientIds: string[] = [];

async function seedClient(firmName: string): Promise<string> {
  const [row] = await db.insert(clients).values({ firmName }).returning({ id: clients.id });
  createdClientIds.push(row.id);
  return row.id;
}

async function seedLocation(clientId: string, name: string): Promise<string> {
  const [row] = await db.insert(clientLocations).values({ clientId, name }).returning({ id: clientLocations.id });
  createdLocationIds.push(row.id);
  return row.id;
}

async function seedMapping(clientId: string, locationId: string, campaignId: string): Promise<void> {
  const [row] = await db.insert(semrushLocationCampaigns).values({
    clientId,
    locationId,
    semrushCampaignId: campaignId,
    semrushCampaignName: `Camp ${campaignId}`,
    isStale: false,
  }).returning({ id: semrushLocationCampaigns.id });
  createdMappingIds.push(row.id);
}

async function seedSnapshot(args: {
  clientId: string;
  locationId: string;
  campaignId: string;
  keywordName: string;
  reportDate: Date;
}): Promise<string> {
  const [row] = await db.insert(heatmapSnapshots).values({
    clientId: args.clientId,
    locationId: args.locationId,
    locationName: "Test Loc",
    campaignId: args.campaignId,
    // Migration 0061 added a CHECK constraint requiring keyword_name to be
    // the canonical (lower / trim / collapsed-whitespace) form. The
    // production write path always normalizes before insert; mirror that
    // here so test fixtures don't blow up on the constraint.
    keywordName: args.keywordName
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase(),
    reportDate: args.reportDate,
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

const day = (iso: string) => ({
  start: new Date(iso + "T00:00:00.000Z"),
  end: new Date(iso + "T23:59:59.999Z"),
  date: new Date(iso + "T12:00:00.000Z"),
});

async function snapshotExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: heatmapSnapshots.id }).from(heatmapSnapshots).where(eq(heatmapSnapshots.id, id));
  return rows.length > 0;
}

// ----------------------------------------------------------------------------
// Test 1: read path drops removed keyword; historical snapshot is preserved.
// ----------------------------------------------------------------------------
async function testReadPathLatestPeriodOnly(): Promise<void> {
  const clientId = await seedClient(`SKC ReadPath ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-rp`;
  await seedMapping(clientId, locId, campId);

  const oldDate = day("2026-01-15");
  const newDate = day("2026-04-15");
  const oldSnapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "law office", reportDate: oldDate.date,
  });
  const newSnapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "family law attorney", reportDate: newDate.date,
  });

  // getPerLocationSnapshots(clientId, keyword?). Pass a non-matching keyword
  // so the snapshot rows are not selected as the "current data" payload — we
  // only care about the `availableKeywords` hint, which is built independently
  // when `keyword` is truthy.
  const result = await getPerLocationSnapshots(clientId, "__no_match__");

  // The location entry should expose only the latest-period keyword.
  const locEntry = (result as any[]).find(r => r.locationId === locId);
  assert(locEntry, "expected an entry for the test location");
  const available: string[] = locEntry.availableKeywords || [];
  assert(
    available.includes("family law attorney"),
    `expected latest keyword to be available, got ${JSON.stringify(available)}`,
  );
  assert(
    !available.includes("law office"),
    `expected stale keyword "law office" to be hidden, got ${JSON.stringify(available)}`,
  );

  // Read-path must NOT mutate: the historical snapshot must still exist.
  assert(await snapshotExists(oldSnapId), "historical snapshot must not be deleted by read path");
  assert(await snapshotExists(newSnapId), "current snapshot must still exist");
  console.log(`[Test1 ReadPathLatestPeriodOnly] ✓`);
}

// ----------------------------------------------------------------------------
// Test 2: cleanup with `keywordListComplete=false` must skip deletion.
// ----------------------------------------------------------------------------
async function testIncompleteInventorySkipsCleanup(): Promise<void> {
  const clientId = await seedClient(`SKC Incomplete ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-inc`;
  await seedMapping(clientId, locId, campId);

  const today = day("2026-04-15");
  const snapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "removed-from-semrush", reportDate: today.date,
  });

  const out = await pruneStaleKeywordSnapshots({
    clientId,
    campaignId: campId,
    effectiveLocationId: locId,
    dayStart: today.start,
    dayEnd: today.end,
    reportDateOnly: "2026-04-15",
    expectedKeywordNames: new Set(["something-else"]),
    keywordListComplete: false,
    origin: "scheduled_background",
  });

  assert(out.cleanupSkippedReason === "keyword inventory incomplete",
    `expected skip reason "keyword inventory incomplete", got ${out.cleanupSkippedReason}`);
  assert(out.prunedKeywordsCount === 0, `expected 0 pruned, got ${out.prunedKeywordsCount}`);
  assert(await snapshotExists(snapId), "snapshot must NOT be deleted when inventory is incomplete");
  console.log(`[Test2 IncompleteInventorySkipsCleanup] ✓`);
}

// ----------------------------------------------------------------------------
// Test 3: empty expected-keyword set must skip deletion.
// ----------------------------------------------------------------------------
async function testEmptyExpectedSkipsCleanup(): Promise<void> {
  const clientId = await seedClient(`SKC Empty ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-emp`;
  await seedMapping(clientId, locId, campId);

  const today = day("2026-04-15");
  const snapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "anything", reportDate: today.date,
  });

  const out = await pruneStaleKeywordSnapshots({
    clientId,
    campaignId: campId,
    effectiveLocationId: locId,
    dayStart: today.start,
    dayEnd: today.end,
    reportDateOnly: "2026-04-15",
    expectedKeywordNames: new Set(),
    keywordListComplete: true,
    origin: "scheduled_background",
  });

  assert(out.cleanupSkippedReason === "empty SEMrush keyword list",
    `expected skip reason "empty SEMrush keyword list", got ${out.cleanupSkippedReason}`);
  assert(out.prunedKeywordsCount === 0, `expected 0 pruned, got ${out.prunedKeywordsCount}`);
  assert(await snapshotExists(snapId), "snapshot must NOT be deleted when expected set is empty");
  console.log(`[Test3 EmptyExpectedSkipsCleanup] ✓`);
}

// ----------------------------------------------------------------------------
// Test 4: aborted signal must skip deletion.
// ----------------------------------------------------------------------------
async function testAbortedSkipsCleanup(): Promise<void> {
  const clientId = await seedClient(`SKC Abort ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-abr`;
  await seedMapping(clientId, locId, campId);

  const today = day("2026-04-15");
  const snapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "removed", reportDate: today.date,
  });

  const ctrl = new AbortController();
  ctrl.abort();
  const out = await pruneStaleKeywordSnapshots({
    clientId,
    campaignId: campId,
    effectiveLocationId: locId,
    dayStart: today.start,
    dayEnd: today.end,
    reportDateOnly: "2026-04-15",
    expectedKeywordNames: new Set(["other"]),
    keywordListComplete: true,
    signal: ctrl.signal,
    origin: "scheduled_background",
  });

  assert(out.cleanupSkippedReason === "sync aborted",
    `expected skip reason "sync aborted", got ${out.cleanupSkippedReason}`);
  assert(out.prunedKeywordsCount === 0, `expected 0 pruned, got ${out.prunedKeywordsCount}`);
  assert(await snapshotExists(snapId), "snapshot must NOT be deleted when sync was aborted");
  console.log(`[Test4 AbortedSkipsCleanup] ✓`);
}

// ----------------------------------------------------------------------------
// Test 5: normalization safety — casing/whitespace differences must NOT
//   trigger a false-positive delete.
// ----------------------------------------------------------------------------
async function testNormalizationSafe(): Promise<void> {
  const clientId = await seedClient(`SKC Norm ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-norm`;
  await seedMapping(clientId, locId, campId);

  const today = day("2026-04-15");
  // Stored snapshot uses one casing/whitespace form.
  const keptId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "Divorce Lawyer", reportDate: today.date,
  });
  // SEMrush returns the same logical keyword in a different form.
  const out = await pruneStaleKeywordSnapshots({
    clientId,
    campaignId: campId,
    effectiveLocationId: locId,
    dayStart: today.start,
    dayEnd: today.end,
    reportDateOnly: "2026-04-15",
    expectedKeywordNames: new Set(["  divorce lawyer  "]),
    keywordListComplete: true,
    origin: "scheduled_background",
  });

  assert(out.cleanupSkippedReason === null, `expected no skip, got ${out.cleanupSkippedReason}`);
  assert(out.cleanupFailedReason === null, `expected no failure, got ${out.cleanupFailedReason}`);
  assert(out.prunedKeywordsCount === 0,
    `expected 0 pruned (normalization should match), got ${out.prunedKeywordsCount}`);
  assert(await snapshotExists(keptId), "snapshot with casing/whitespace difference must be kept");
  console.log(`[Test5 NormalizationSafe] ✓`);
}

// ----------------------------------------------------------------------------
// Test 6: happy path — current-date snapshot whose keyword is genuinely
//   removed gets pruned; historical snapshot for the same keyword is kept.
// ----------------------------------------------------------------------------
async function testHappyPathCurrentDateOnly(): Promise<void> {
  const clientId = await seedClient(`SKC Happy ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campId = `camp-${TEST_TAG}-happy`;
  await seedMapping(clientId, locId, campId);

  const oldDate = day("2026-01-15");
  const today = day("2026-04-15");
  const oldSnapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "law office", reportDate: oldDate.date,
  });
  const currentStaleSnapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "law office", reportDate: today.date,
  });
  const currentKeptSnapId = await seedSnapshot({
    clientId, locationId: locId, campaignId: campId,
    keywordName: "family law attorney", reportDate: today.date,
  });

  const out = await pruneStaleKeywordSnapshots({
    clientId,
    campaignId: campId,
    effectiveLocationId: locId,
    dayStart: today.start,
    dayEnd: today.end,
    reportDateOnly: "2026-04-15",
    expectedKeywordNames: new Set(["family law attorney"]),
    keywordListComplete: true,
    origin: "scheduled_background",
  });

  assert(out.cleanupSkippedReason === null, `expected no skip, got ${out.cleanupSkippedReason}`);
  assert(out.cleanupFailedReason === null, `expected no failure, got ${out.cleanupFailedReason}`);
  assert(out.prunedKeywordsCount === 1,
    `expected 1 pruned (current "law office"), got ${out.prunedKeywordsCount}`);

  assert(await snapshotExists(oldSnapId),
    "historical 'law office' snapshot must be preserved (cleanup is current-date only)");
  assert(!(await snapshotExists(currentStaleSnapId)),
    "current-date 'law office' snapshot must be deleted");
  assert(await snapshotExists(currentKeptSnapId),
    "current-date 'family law attorney' snapshot must be kept");
  console.log(`[Test6 HappyPathCurrentDateOnly] ✓`);
}

// ----------------------------------------------------------------------------
// Cleanup
// ----------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  if (createdSnapshotIds.length > 0) {
    await db.delete(heatmapSnapshots).where(inArray(heatmapSnapshots.id, createdSnapshotIds));
  }
  if (createdMappingIds.length > 0) {
    await db.delete(semrushLocationCampaigns).where(inArray(semrushLocationCampaigns.id, createdMappingIds));
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
    await testReadPathLatestPeriodOnly();
    await testIncompleteInventorySkipsCleanup();
    await testEmptyExpectedSkipsCleanup();
    await testAbortedSkipsCleanup();
    await testNormalizationSafe();
    await testHappyPathCurrentDateOnly();
    console.log("stale-keyword-cleanup: all cases passed");
  } catch (err) {
    console.error("stale-keyword-cleanup: FAILED", err);
    await cleanup();
    process.exitCode = 1;
  }
  await cleanup();
})();
