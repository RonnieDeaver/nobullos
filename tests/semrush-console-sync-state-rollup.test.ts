/* test-registration
{
  "name": "SEMrush console sync-state per-client outcome rollup (Task #1212)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1212 — Regression coverage for the SEMrush per-client outcome
 * rollup that powers `GET /api/semrush/console/sync-state` (Task #739).
 *
 * The mapping rules ("error" → failed, "already_current" → alreadyCurrent,
 * "partial_success" → partiallyRefreshed, "success" / null+success →
 * freshlySynced, otherwise neverRun) were previously inlined in
 * server/routes/heatmap.ts with no automated coverage. This test:
 *
 *   (1) Seeds `client_semrush_integrations` rows that exercise every
 *       outcome value (including the legacy
 *       "syncStatus=success + lastSyncOutcome=null" case and the
 *       "syncStatus=error overrides outcome" case).
 *   (2) Reads those rows back through the SAME projection the route uses,
 *       runs the rollup helper (`computeSyncStateRollup`), and asserts on
 *       both the aggregate `outcomeTotals` and per-client
 *       `integration.outcome` values that
 *       `/api/semrush/console/sync-state` returns.
 *   (3) Confirms that clients with NO `semrush_location_sync_state` rows
 *       still appear in `perClient` when an integration row exists — the
 *       per-client integration card has to render even when the sync queue
 *       for that client is empty.
 *
 * The rollup helper is exercised directly (not over HTTP) because we have
 * no admin session in the test environment; the helper is the exact same
 * code path the handler runs after its two SELECT queries return.
 */

import { db } from "../server/db";
import { eq, inArray } from "drizzle-orm";
import {
  clients,
  clientLocations,
  clientSemrushIntegrations,
  semrushLocationSyncState,
} from "@shared/schema";
import {
  computeSyncStateRollup,
  classifyIntegrationOutcome,
} from "../server/routes/semrushSyncStateRollup";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `scsr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];
const createdIntegrationIds: string[] = [];
const createdSyncStateIds: string[] = [];

async function seedClient(name: string): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ firmName: name })
    .returning({ id: clients.id });
  createdClientIds.push(row.id);
  return row.id;
}

async function seedLocation(clientId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(clientLocations)
    .values({ clientId, name })
    .returning({ id: clientLocations.id });
  createdLocationIds.push(row.id);
  return row.id;
}

async function seedIntegration(args: {
  clientId: string;
  syncStatus: string | null;
  lastSyncOutcome: string | null;
  enabled?: boolean;
  errorMessage?: string | null;
  summary?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(clientSemrushIntegrations)
    .values({
      clientId: args.clientId,
      businessName: `Biz ${TAG}`,
      integrationEnabled: args.enabled ?? true,
      isActive: true,
      syncStatus: args.syncStatus ?? "idle",
      lastSyncOutcome: args.lastSyncOutcome,
      lastSyncSummary: args.summary ?? null,
      errorMessage: args.errorMessage ?? null,
      lastSuccessfulSyncAt:
        args.syncStatus === "success" ? new Date("2026-04-01T00:00:00.000Z") : null,
      lastFailedSyncAt:
        args.syncStatus === "error" ? new Date("2026-04-02T00:00:00.000Z") : null,
    })
    .returning({ id: clientSemrushIntegrations.id });
  createdIntegrationIds.push(row.id);
  return row.id;
}

async function seedSyncState(args: {
  clientId: string;
  locationId: string;
  campaignId: string;
  status: string;
}): Promise<string> {
  const [row] = await db
    .insert(semrushLocationSyncState)
    .values({
      clientId: args.clientId,
      locationId: args.locationId,
      campaignId: args.campaignId,
      status: args.status,
    })
    .returning({ id: semrushLocationSyncState.id });
  createdSyncStateIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (createdSyncStateIds.length > 0) {
    await db
      .delete(semrushLocationSyncState)
      .where(inArray(semrushLocationSyncState.id, createdSyncStateIds));
  }
  if (createdIntegrationIds.length > 0) {
    await db
      .delete(clientSemrushIntegrations)
      .where(inArray(clientSemrushIntegrations.id, createdIntegrationIds));
  }
  if (createdLocationIds.length > 0) {
    await db
      .delete(clientLocations)
      .where(inArray(clientLocations.id, createdLocationIds));
  }
  if (createdClientIds.length > 0) {
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

// ---------------------------------------------------------------------------
// Test 1 — pure mapping rules, no DB. Locks the contract for every outcome
// vocabulary value the worker can write today.
// ---------------------------------------------------------------------------
function testClassifyIntegrationOutcome(): void {
  const cases: Array<{
    syncStatus: string | null;
    lastSyncOutcome: string | null;
    expectedOutcome: ReturnType<typeof classifyIntegrationOutcome>["outcome"];
    expectedBucket: ReturnType<typeof classifyIntegrationOutcome>["bucket"];
    label: string;
  }> = [
    // syncStatus=error must override any outcome value (including success).
    { syncStatus: "error", lastSyncOutcome: "success",         expectedOutcome: "failed",              expectedBucket: "failed",              label: "error overrides success outcome" },
    { syncStatus: "error", lastSyncOutcome: null,              expectedOutcome: "failed",              expectedBucket: "failed",              label: "error with null outcome" },
    { syncStatus: "error", lastSyncOutcome: "already_current", expectedOutcome: "failed",              expectedBucket: "failed",              label: "error overrides already_current" },
    // already_current
    { syncStatus: "success", lastSyncOutcome: "already_current", expectedOutcome: "already_current",  expectedBucket: "alreadyCurrent",      label: "already_current" },
    // partial_success
    { syncStatus: "success", lastSyncOutcome: "partial_success", expectedOutcome: "partially_refreshed", expectedBucket: "partiallyRefreshed", label: "partial_success" },
    // success
    { syncStatus: "success", lastSyncOutcome: "success",       expectedOutcome: "freshly_synced",      expectedBucket: "freshlySynced",       label: "explicit success outcome" },
    // Legacy: syncStatus=success but lastSyncOutcome was never written.
    { syncStatus: "success", lastSyncOutcome: null,            expectedOutcome: "freshly_synced",      expectedBucket: "freshlySynced",       label: "legacy null+success" },
    // neverRun fall-throughs
    { syncStatus: "idle",    lastSyncOutcome: null,            expectedOutcome: null,                  expectedBucket: "neverRun",            label: "idle + null" },
    { syncStatus: null,      lastSyncOutcome: null,            expectedOutcome: null,                  expectedBucket: "neverRun",            label: "null + null" },
    { syncStatus: "running", lastSyncOutcome: null,            expectedOutcome: null,                  expectedBucket: "neverRun",            label: "running + null (in-flight, never completed)" },
    // Unknown future outcome falls through to neverRun (so a worker change
    // that introduces a brand-new outcome string surfaces as a visibly
    // missing classification rather than getting silently mis-bucketed).
    { syncStatus: "success", lastSyncOutcome: "totally_new_thing", expectedOutcome: null,              expectedBucket: "neverRun",            label: "unknown outcome falls to neverRun" },
  ];

  for (const c of cases) {
    const got = classifyIntegrationOutcome({
      syncStatus: c.syncStatus,
      lastSyncOutcome: c.lastSyncOutcome,
    });
    assert(
      got.outcome === c.expectedOutcome && got.bucket === c.expectedBucket,
      `[${c.label}] expected outcome=${c.expectedOutcome} bucket=${c.expectedBucket}, got outcome=${got.outcome} bucket=${got.bucket}`,
    );
  }

  console.log(`[Test1 classifyIntegrationOutcome] ✓ (${cases.length} cases)`);
}

// ---------------------------------------------------------------------------
// Test 2 — Real DB seeding + real route projection.
//
// We seed one integration row for each outcome bucket, plus one client that
// has NO sync-state rows at all (to prove it still appears in perClient
// because of its integration row). Then we run the same SELECT the handler
// runs and feed the result through `computeSyncStateRollup`, asserting on
// both `outcomeTotals` and per-client `integration.outcome`.
// ---------------------------------------------------------------------------
async function testEndToEndRollupFromSeededRows(): Promise<void> {
  // One client per outcome bucket so we can pin the per-client mapping.
  const cFresh         = await seedClient(`SCSR Fresh ${TAG}`);
  const cFreshLegacy   = await seedClient(`SCSR FreshLegacy ${TAG}`);
  const cAlreadyCur    = await seedClient(`SCSR AlreadyCur ${TAG}`);
  const cPartial       = await seedClient(`SCSR Partial ${TAG}`);
  const cFailed        = await seedClient(`SCSR Failed ${TAG}`);
  const cFailedOverride = await seedClient(`SCSR FailedOverride ${TAG}`);
  const cNeverRun      = await seedClient(`SCSR NeverRun ${TAG}`);
  const cNoSyncState   = await seedClient(`SCSR NoSyncState ${TAG}`);
  const cDisabled      = await seedClient(`SCSR Disabled ${TAG}`);

  await seedIntegration({ clientId: cFresh,          syncStatus: "success", lastSyncOutcome: "success" });
  await seedIntegration({ clientId: cFreshLegacy,    syncStatus: "success", lastSyncOutcome: null });
  await seedIntegration({ clientId: cAlreadyCur,     syncStatus: "success", lastSyncOutcome: "already_current" });
  await seedIntegration({ clientId: cPartial,        syncStatus: "success", lastSyncOutcome: "partial_success" });
  await seedIntegration({ clientId: cFailed,         syncStatus: "error",   lastSyncOutcome: null,      errorMessage: "boom" });
  // syncStatus=error must override any non-null outcome — test #2 of the
  // route's contract that prevents an "error + success" row from being
  // mis-bucketed as freshlySynced.
  await seedIntegration({ clientId: cFailedOverride, syncStatus: "error",   lastSyncOutcome: "success", errorMessage: "boom2" });
  await seedIntegration({ clientId: cNeverRun,       syncStatus: "idle",    lastSyncOutcome: null });
  await seedIntegration({ clientId: cNoSyncState,    syncStatus: "success", lastSyncOutcome: "already_current" });
  // Disabled integration must NOT be counted — the route filters by
  // integrationEnabled=true.
  await seedIntegration({ clientId: cDisabled,       syncStatus: "success", lastSyncOutcome: "success", enabled: false });

  // Seed one sync-state row for every client EXCEPT cNoSyncState (and
  // cDisabled, which we want to be entirely absent).
  for (const cid of [cFresh, cFreshLegacy, cAlreadyCur, cPartial, cFailed, cFailedOverride, cNeverRun]) {
    const locId = await seedLocation(cid, `Loc ${TAG} ${cid.slice(0, 6)}`);
    await seedSyncState({
      clientId: cid,
      locationId: locId,
      campaignId: `camp-${TAG}-${cid.slice(0, 6)}`,
      status: "succeeded",
    });
  }

  const seededIds = new Set([
    cFresh, cFreshLegacy, cAlreadyCur, cPartial, cFailed,
    cFailedOverride, cNeverRun, cNoSyncState, cDisabled,
  ]);

  // ---- Mirror the two route SELECTs (filtered to OUR seeded client IDs
  // so we don't get poisoned by other rows on shared dev DBs). ----

  const rawSyncRows = await db
    .select({
      clientId: semrushLocationSyncState.clientId,
      clientName: clients.firmName,
      status: semrushLocationSyncState.status,
    })
    .from(semrushLocationSyncState)
    .leftJoin(clients, eq(semrushLocationSyncState.clientId, clients.id))
    .where(inArray(semrushLocationSyncState.clientId, Array.from(seededIds)));

  const rawIntegrationRows = await db
    .select({
      clientId: clientSemrushIntegrations.clientId,
      clientName: clients.firmName,
      syncStatus: clientSemrushIntegrations.syncStatus,
      lastSyncOutcome: clientSemrushIntegrations.lastSyncOutcome,
      lastSyncSummary: clientSemrushIntegrations.lastSyncSummary,
      lastSuccessfulSyncAt: clientSemrushIntegrations.lastSuccessfulSyncAt,
      lastFailedSyncAt: clientSemrushIntegrations.lastFailedSyncAt,
      errorMessage: clientSemrushIntegrations.errorMessage,
    })
    .from(clientSemrushIntegrations)
    .leftJoin(clients, eq(clientSemrushIntegrations.clientId, clients.id))
    .where(eq(clientSemrushIntegrations.integrationEnabled, true));

  // Scope to our seeded ids so the test is robust on shared DBs.
  const integrationRows = rawIntegrationRows.filter((r) => seededIds.has(r.clientId));
  const syncStateRows = rawSyncRows;

  const { perClient, outcomeTotals } = computeSyncStateRollup({
    syncStateRows,
    integrationRows,
  });

  // ---- outcomeTotals: bucket counts must match exactly ----
  // (8 enabled integrations among the seeded set; the disabled one is
  // filtered by the WHERE clause and must not appear.)
  assert(outcomeTotals.totalIntegrations === 8,
    `expected 8 enabled integrations in seeded set, got ${outcomeTotals.totalIntegrations}`);
  assert(outcomeTotals.freshlySynced === 2,
    `expected freshlySynced=2 (cFresh + cFreshLegacy), got ${outcomeTotals.freshlySynced}`);
  assert(outcomeTotals.alreadyCurrent === 2,
    `expected alreadyCurrent=2 (cAlreadyCur + cNoSyncState), got ${outcomeTotals.alreadyCurrent}`);
  assert(outcomeTotals.partiallyRefreshed === 1,
    `expected partiallyRefreshed=1 (cPartial), got ${outcomeTotals.partiallyRefreshed}`);
  assert(outcomeTotals.failed === 2,
    `expected failed=2 (cFailed + cFailedOverride), got ${outcomeTotals.failed}`);
  assert(outcomeTotals.neverRun === 1,
    `expected neverRun=1 (cNeverRun), got ${outcomeTotals.neverRun}`);

  // ---- Per-client integration.outcome must match the bucket ----
  function bucketFor(clientId: string) {
    return perClient.find((b) => b.clientId === clientId);
  }
  const expectedPerClient: Array<{ id: string; outcome: string | null; label: string }> = [
    { id: cFresh,          outcome: "freshly_synced",      label: "cFresh" },
    { id: cFreshLegacy,    outcome: "freshly_synced",      label: "cFreshLegacy" },
    { id: cAlreadyCur,     outcome: "already_current",    label: "cAlreadyCur" },
    { id: cPartial,        outcome: "partially_refreshed", label: "cPartial" },
    { id: cFailed,         outcome: "failed",             label: "cFailed" },
    { id: cFailedOverride, outcome: "failed",             label: "cFailedOverride (error overrides success)" },
    { id: cNeverRun,       outcome: null,                 label: "cNeverRun" },
    { id: cNoSyncState,    outcome: "already_current",    label: "cNoSyncState (integration-only, no queue rows)" },
  ];

  for (const e of expectedPerClient) {
    const b = bucketFor(e.id);
    assert(b !== undefined,
      `[${e.label}] missing per-client bucket for ${e.id} — every enabled integration must produce a perClient entry`);
    assert(b!.integration !== null,
      `[${e.label}] integration must be populated for an enabled integration row`);
    assert(b!.integration!.outcome === e.outcome,
      `[${e.label}] expected integration.outcome=${e.outcome}, got ${b!.integration!.outcome}`);
  }

  // ---- The disabled-integration client must be absent entirely (no
  // sync-state row, integration filtered by WHERE clause). ----
  assert(bucketFor(cDisabled) === undefined,
    `disabled integration must not appear in perClient (route's WHERE integrationEnabled=true)`);

  // ---- "Clients with no sync-state rows still appear" — explicit
  // assertion. cNoSyncState has zero queue rows but a perClient bucket. ----
  const noSync = bucketFor(cNoSyncState)!;
  assert(noSync.total === 0,
    `cNoSyncState should have total=0 sync-state rows, got ${noSync.total}`);
  assert(noSync.succeeded === 0 && noSync.failed === 0 && noSync.partial === 0,
    `cNoSyncState should have zeroed status counters`);
  assert(noSync.integration?.outcome === "already_current",
    `cNoSyncState integration outcome should still be classified, got ${noSync.integration?.outcome}`);

  // ---- Sort order: failed buckets float to the top (integrationScore +
  // failed*100 weighting). The first per-client entry must be one of the
  // two failed clients. ----
  assert(
    perClient[0]?.integration?.outcome === "failed",
    `expected failed-outcome client to sort first, got ${perClient[0]?.integration?.outcome}`,
  );

  console.log(`[Test2 endToEndRollupFromSeededRows] ✓ (${expectedPerClient.length} per-client mappings, totals match)`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  try {
    testClassifyIntegrationOutcome();
    await testEndToEndRollupFromSeededRows();
    console.log("semrush-console-sync-state-rollup: all cases passed");
  } catch (err) {
    console.error("semrush-console-sync-state-rollup: FAILED", err);
    await cleanup();
    process.exitCode = 1;
  }
  await cleanup();
})();
