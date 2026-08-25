/* test-registration
{
  "name": "Local dominance multi-location isolation",
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * Multi-location SEMrush sync isolation — regression coverage for task #681.
 *
 * Pins the contract that a slow / failing location does NOT cascade to its
 * siblings. The canonical state table is the single source of truth that the
 * worker, dashboard, and manual-retry path all read from, so we exercise that
 * surface directly:
 *
 *   1. Per (clientId, locationId, campaignId) row isolation: one row's failure
 *      mutations must never touch a sibling row.
 *   2. Bounded retry: attemptCount increments up to maxAttempts; once the cap
 *      is reached, no more nextRetryAt is scheduled.
 *   3. Error category drives behaviour: not_found is non-retryable (stale),
 *      everything else is retryable up to the cap.
 *   4. Backoff is jittered exponential, capped, and strictly positive.
 *   5. Manual retry resets the counter so the row can be re-driven.
 *   6. Orphan prune drops rows for mappings that no longer exist, leaving
 *      sibling rows for current mappings untouched.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  semrushLocationCampaigns,
  semrushLocationSyncState,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  beginAttempt,
  completeAttempt,
  classifyError,
  isRetryableCategory,
  computeBackoffMs,
  resetForManualRetry,
  pruneOrphanRows,
  getSyncState,
  listSyncStateForClient,
} from "../server/services/semrushLocationSyncState";
import { SemrushNotFoundError, SemrushRateLimitError } from "../server/services/semrushApi";
import { _resetCadenceSettingsCache } from "../server/services/semrushCadenceGate";
import { setKillSwitch } from "../server/services/killSwitches";

// Task #1785 widened the effective retry cap when the long-form backoff
// kill switch is ON. These tests pin the legacy short-cycle contract
// (maxAttempts = row.maxAttempts = 3), so we disable the long-form
// backoff for the duration of the run and reset the cadence-gate cache
// so the change takes effect.
await setKillSwitch("semrush_auto_retry_backoff", false, "system");
_resetCadenceSettingsCache();

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `mli-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];
const createdMappingIds: string[] = [];

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

// ---------------------------------------------------------------------------
// Test 1: sibling isolation — failure on the middle location must NOT mutate
// the success rows on either side. This is the headline regression: it
// reproduces the original bug shape where a single failing location's abort
// cascaded into siblings.
// ---------------------------------------------------------------------------
async function testSiblingIsolation(): Promise<void> {
  const clientId = await seedClient(`MLI Sibling ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "Loc A");
  const locB = await seedLocation(clientId, "Loc B (failing)");
  const locC = await seedLocation(clientId, "Loc C");
  const camp = (id: string) => `camp-${TEST_TAG}-${id}`;
  await seedMapping(clientId, locA, camp("a"));
  await seedMapping(clientId, locB, camp("b"));
  await seedMapping(clientId, locC, camp("c"));

  const runId = `run-${TEST_TAG}-iso`;

  // Drive each location through one attempt — A and C succeed, B fails with
  // a retryable category. Each call must touch ONLY its own row.
  await beginAttempt({ clientId, locationId: locA, campaignId: camp("a"), runId, triggeredBy: "scheduled" });
  await completeAttempt({
    clientId, locationId: locA, campaignId: camp("a"),
    status: "succeeded", importedKeywordCount: 17, expectedKeywordCount: 17, durationMs: 12_000,
  });

  await beginAttempt({ clientId, locationId: locB, campaignId: camp("b"), runId, triggeredBy: "scheduled" });
  await completeAttempt({
    clientId, locationId: locB, campaignId: camp("b"),
    status: "failed", durationMs: 60_000,
    errorCategory: "timeout", lastError: "Per-location budget exceeded",
    message: "Per-location budget exceeded",
  });

  await beginAttempt({ clientId, locationId: locC, campaignId: camp("c"), runId, triggeredBy: "scheduled" });
  await completeAttempt({
    clientId, locationId: locC, campaignId: camp("c"),
    status: "succeeded", importedKeywordCount: 12, expectedKeywordCount: 12, durationMs: 9_000,
  });

  const a = await getSyncState({ clientId, locationId: locA, campaignId: camp("a") });
  const b = await getSyncState({ clientId, locationId: locB, campaignId: camp("b") });
  const c = await getSyncState({ clientId, locationId: locC, campaignId: camp("c") });

  assert(a?.status === "succeeded", `loc A should be succeeded, got ${a?.status}`);
  assert(c?.status === "succeeded", `loc C should be succeeded, got ${c?.status}`);
  assert(b?.status === "failed", `loc B should be failed, got ${b?.status}`);

  // Sibling protection: B's failure must NOT have left A or C with any
  // failure / retry metadata.
  assert(a?.lastError == null, `loc A must have no lastError after sibling failure, got ${a?.lastError}`);
  assert(c?.lastError == null, `loc C must have no lastError after sibling failure, got ${c?.lastError}`);
  assert(a?.errorCategory == null, "loc A must have no errorCategory");
  assert(c?.errorCategory == null, "loc C must have no errorCategory");
  assert(a?.nextRetryAt == null, "loc A must have no nextRetryAt");
  assert(c?.nextRetryAt == null, "loc C must have no nextRetryAt");
  assert(a?.lastSucceededAt != null, "loc A must record lastSucceededAt");
  assert(c?.lastSucceededAt != null, "loc C must record lastSucceededAt");

  // The failing row carries the failure metadata AND a scheduled auto-retry
  // (timeout is retryable, attempt 1 of 3).
  assert(b?.attemptCount === 1, `loc B attemptCount should be 1, got ${b?.attemptCount}`);
  assert(b?.errorCategory === "timeout", `loc B errorCategory should be timeout, got ${b?.errorCategory}`);
  assert(b?.nextRetryAt != null, "loc B should have nextRetryAt scheduled (retryable + under cap)");
  assert(b?.runId === runId, "loc B must record the orchestration runId");

  // Each row must persist its own importedKeywordCount.
  assert(a?.importedKeywordCount === 17, `loc A imported should be 17, got ${a?.importedKeywordCount}`);
  assert(b?.importedKeywordCount === 0, `loc B imported should be 0, got ${b?.importedKeywordCount}`);
  assert(c?.importedKeywordCount === 12, `loc C imported should be 12, got ${c?.importedKeywordCount}`);

  console.log(`[Test1 SiblingIsolation] ✓`);
}

// ---------------------------------------------------------------------------
// Test 2: bounded retry — attemptCount climbs up to maxAttempts and then
// nextRetryAt is no longer scheduled. Prevents unbounded retry storms.
// ---------------------------------------------------------------------------
async function testBoundedRetry(): Promise<void> {
  const clientId = await seedClient(`MLI Bounded ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc Bounded");
  const campId = `camp-${TEST_TAG}-bnd`;
  await seedMapping(clientId, locId, campId);
  const key = { clientId, locationId: locId, campaignId: campId };

  for (let i = 1; i <= 3; i++) {
    await beginAttempt({ ...key, runId: `run-${i}`, triggeredBy: i === 1 ? "scheduled" : "auto_retry" });
    await completeAttempt({
      ...key, status: "failed",
      errorCategory: "transient", lastError: `attempt ${i} blew up`,
    });
    const row = await getSyncState(key);
    assert(row?.attemptCount === i, `expected attemptCount=${i}, got ${row?.attemptCount}`);
    if (i < 3) {
      assert(row?.nextRetryAt != null, `attempt ${i}: should still schedule next retry`);
    } else {
      // Once attemptCount === maxAttempts, the helper must NOT schedule
      // another auto-retry. Manual retry path is the only escape hatch.
      assert(row?.nextRetryAt == null,
        `attempt ${i} (cap reached): nextRetryAt must be null, got ${row?.nextRetryAt}`);
    }
  }

  console.log(`[Test2 BoundedRetry] ✓`);
}

// ---------------------------------------------------------------------------
// Test 3: error classification — not_found is non-retryable, others retryable.
// ---------------------------------------------------------------------------
async function testErrorClassification(): Promise<void> {
  assert(classifyError(new SemrushNotFoundError("missing")) === "not_found", "404 should be not_found");
  assert(classifyError(new SemrushRateLimitError("429")) === "rate_limit", "429 should be rate_limit");
  assert(classifyError({ name: "AbortError", message: "aborted" }) === "timeout", "AbortError should be timeout");
  assert(classifyError(new Error("Connection terminated unexpectedly")) === "transient",
    "conn terminated should be transient");
  assert(classifyError(new Error("HTTP 503 Service Unavailable")) === "server", "5xx should be server");
  assert(classifyError(new Error("something weird")) === "unknown", "fallback should be unknown");

  assert(!isRetryableCategory("not_found"), "not_found must be non-retryable");
  assert(isRetryableCategory("timeout"), "timeout must be retryable");
  assert(isRetryableCategory("rate_limit"), "rate_limit must be retryable");
  assert(isRetryableCategory("transient"), "transient must be retryable");
  assert(isRetryableCategory("server"), "server must be retryable");
  assert(isRetryableCategory("unknown"), "unknown must be retryable");

  console.log(`[Test3 ErrorClassification] ✓`);
}

// ---------------------------------------------------------------------------
// Test 4: backoff is jittered exponential and capped. Prevents thundering
// herd and runaway sleeps.
// ---------------------------------------------------------------------------
async function testBackoff(): Promise<void> {
  const a = computeBackoffMs(1);
  const b = computeBackoffMs(2);
  const c = computeBackoffMs(3);
  assert(a >= 5_000 && a < 5_000 + 5_000, `attempt 1 backoff out of range: ${a}`);
  assert(b >= 10_000 && b < 10_000 + 5_000, `attempt 2 backoff out of range: ${b}`);
  assert(c >= 20_000 && c < 20_000 + 5_000, `attempt 3 backoff out of range: ${c}`);
  // Capped at 5 minutes + small jitter. attemptCount=20 should clearly hit
  // the ceiling rather than overflow to hours.
  const huge = computeBackoffMs(20);
  assert(huge <= 5 * 60 * 1000 + 5_000, `huge attempt must be capped, got ${huge}`);
  console.log(`[Test4 Backoff] ✓`);
}

// ---------------------------------------------------------------------------
// Test 5: manual retry resets the counter so a row at the cap can be
// re-driven through the bounded-retry path again.
// ---------------------------------------------------------------------------
async function testManualRetryReset(): Promise<void> {
  const clientId = await seedClient(`MLI Reset ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc Reset");
  const campId = `camp-${TEST_TAG}-rst`;
  await seedMapping(clientId, locId, campId);
  const key = { clientId, locationId: locId, campaignId: campId };

  // Burn through every attempt.
  for (let i = 1; i <= 3; i++) {
    await beginAttempt({ ...key, runId: `r-${i}`, triggeredBy: "scheduled" });
    await completeAttempt({ ...key, status: "failed", errorCategory: "transient", lastError: "boom" });
  }
  const exhausted = await getSyncState(key);
  assert(exhausted?.attemptCount === 3, `exhausted attemptCount should be 3, got ${exhausted?.attemptCount}`);
  assert(exhausted?.status === "failed", "exhausted row should be failed");

  await resetForManualRetry(key);
  const reset = await getSyncState(key);
  assert(reset?.attemptCount === 0, `reset attemptCount should be 0, got ${reset?.attemptCount}`);
  assert(reset?.status === "queued", `reset status should be queued, got ${reset?.status}`);
  assert(reset?.lastError == null, "reset must clear lastError");
  assert(reset?.errorCategory == null, "reset must clear errorCategory");
  assert(reset?.nextRetryAt == null, "reset must clear nextRetryAt");

  console.log(`[Test5 ManualRetryReset] ✓`);
}

// ---------------------------------------------------------------------------
// Test 6: orphan prune drops rows for mappings that no longer exist while
// keeping sibling rows for current mappings.
// ---------------------------------------------------------------------------
async function testOrphanPrune(): Promise<void> {
  const clientId = await seedClient(`MLI Orphan ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "Loc Keep");
  const locB = await seedLocation(clientId, "Loc Orphan");
  const campA = `camp-${TEST_TAG}-ka`;
  const campB = `camp-${TEST_TAG}-ob`;
  await seedMapping(clientId, locA, campA);
  await seedMapping(clientId, locB, campB);

  await beginAttempt({ clientId, locationId: locA, campaignId: campA, runId: "rA", triggeredBy: "scheduled" });
  await completeAttempt({ clientId, locationId: locA, campaignId: campA, status: "succeeded" });
  await beginAttempt({ clientId, locationId: locB, campaignId: campB, runId: "rB", triggeredBy: "scheduled" });
  await completeAttempt({ clientId, locationId: locB, campaignId: campB, status: "succeeded" });

  // Pretend mapping for locB was removed by the operator: prune with only
  // locA in the valid set.
  await pruneOrphanRows(clientId, [{ locationId: locA, campaignId: campA }]);

  const remaining = await listSyncStateForClient(clientId);
  assert(remaining.length === 1, `expected 1 row to remain, got ${remaining.length}`);
  assert(remaining[0].locationId === locA, `expected locA to remain, got ${remaining[0].locationId}`);

  console.log(`[Test6 OrphanPrune] ✓`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  if (createdClientIds.length > 0) {
    // sync_state, mappings, locations all FK-cascade off clients.
    await db.delete(semrushLocationSyncState).where(inArray(semrushLocationSyncState.clientId, createdClientIds));
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
    await testSiblingIsolation();
    await testBoundedRetry();
    await testErrorClassification();
    await testBackoff();
    await testManualRetryReset();
    await testOrphanPrune();
    console.log("local-dominance-multi-location-isolation: all cases passed");
  } catch (err) {
    console.error("local-dominance-multi-location-isolation: FAILED", err);
    await cleanup();
    process.exitCode = 1;
  }
  await cleanup();
})();
