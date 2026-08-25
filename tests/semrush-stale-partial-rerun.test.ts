/* test-registration
{
  "name": "SEMrush stale-partial / paused_auth re-drive (Task #2265)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2265 — coverage for the stale-partial / paused_auth re-drive surface
 * that backs the CEO "Re-run stale Semrush partial / paused locations"
 * prod-action.
 *
 * Two pure-DB contracts the worker, dashboard, and prod-action all depend on:
 *
 *   1. `listStalePartialAndPausedAuth(staleBeforeMs, now?)` selects ONLY the
 *      two non-terminal re-drivable states (`partial`, `paused_auth`) and ONLY
 *      rows older than the staleness cutoff — never `succeeded` / `failed`, and
 *      never a fresh partial that is still in-flight.
 *   2. `markPausedAuth(key, reason, { resetAttempts: true })` hands a mid-sweep
 *      paused row back with a CLEAN retry budget (attemptCount → 0) so the auth
 *      pause is not counted as a burned attempt (Step 2 of the task).
 *
 * Plus a registry shape check: the prod-action is wired with the breaker-aware
 * self-heal cadence and carries no banned multi-press language.
 *
 * Runs against the shared dev DB with a per-run TEST_TAG (the sync-state
 * helpers are pinned to the worker pool / public schema, so isolated-schema
 * sandboxing would not see their writes — same pattern as
 * local-dominance-multi-location-isolation.test.ts). Every seeded row is
 * cleaned up at the end.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  semrushLocationCampaigns,
  semrushLocationSyncState,
} from "@shared/schema";
import { inArray } from "drizzle-orm";
import {
  beginAttempt,
  completeAttempt,
  markPausedAuth,
  getSyncState,
  listStalePartialAndPausedAuth,
} from "../server/services/semrushLocationSyncState";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

const TEST_TAG = `spr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

async function cleanup(): Promise<void> {
  if (createdClientIds.length) {
    // sync_state and campaigns FK to client; delete state first, then mappings,
    // then locations, then clients.
    await db.delete(semrushLocationSyncState).where(inArray(semrushLocationSyncState.clientId, createdClientIds));
    await db.delete(semrushLocationCampaigns).where(inArray(semrushLocationCampaigns.clientId, createdClientIds));
    if (createdLocationIds.length) {
      await db.delete(clientLocations).where(inArray(clientLocations.id, createdLocationIds));
    }
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

// ---------------------------------------------------------------------------
// Test 1: listStalePartialAndPausedAuth — status filter + staleness cutoff.
// ---------------------------------------------------------------------------
async function testListStalePartialAndPausedAuth(): Promise<void> {
  const clientId = await seedClient(`SPR List ${TEST_TAG}`);
  const locPartial = await seedLocation(clientId, "Loc partial");
  const locPaused = await seedLocation(clientId, "Loc paused");
  const locSucceeded = await seedLocation(clientId, "Loc succeeded");
  const locFailed = await seedLocation(clientId, "Loc failed");
  const camp = (id: string) => `camp-${TEST_TAG}-${id}`;
  await seedMapping(clientId, locPartial, camp("partial"));
  await seedMapping(clientId, locPaused, camp("paused"));
  await seedMapping(clientId, locSucceeded, camp("succeeded"));
  await seedMapping(clientId, locFailed, camp("failed"));

  const runId = `run-${TEST_TAG}-list`;

  // partial row
  await beginAttempt({ clientId, locationId: locPartial, campaignId: camp("partial"), runId, triggeredBy: "scheduled" });
  await completeAttempt({
    clientId, locationId: locPartial, campaignId: camp("partial"),
    status: "partial", importedKeywordCount: 4, expectedKeywordCount: 17, durationMs: 8_000,
  });

  // paused_auth row
  await markPausedAuth({ clientId, locationId: locPaused, campaignId: camp("paused") }, "no SEMrush auth");

  // succeeded row (must be excluded)
  await beginAttempt({ clientId, locationId: locSucceeded, campaignId: camp("succeeded"), runId, triggeredBy: "scheduled" });
  await completeAttempt({
    clientId, locationId: locSucceeded, campaignId: camp("succeeded"),
    status: "succeeded", importedKeywordCount: 17, expectedKeywordCount: 17, durationMs: 9_000,
  });

  // failed row (must be excluded — these are the false 'failed' pills, NOT in scope of the re-run)
  await beginAttempt({ clientId, locationId: locFailed, campaignId: camp("failed"), runId, triggeredBy: "scheduled" });
  await completeAttempt({
    clientId, locationId: locFailed, campaignId: camp("failed"),
    status: "failed", errorCategory: "timeout", lastError: "budget", message: "budget", durationMs: 60_000,
  });

  const mineIds = new Set(
    (await db.select().from(semrushLocationSyncState).where(inArray(semrushLocationSyncState.clientId, createdClientIds)))
      .map((r) => r.id),
  );

  // staleBeforeMs=0 with a far-future `now` → everything just-written is "stale".
  const far = new Date(Date.now() + 60_000);
  const stale = (await listStalePartialAndPausedAuth(0, far)).filter((r) => mineIds.has(r.id));
  const statuses = stale.map((r) => r.status).sort();
  assert(stale.length === 2, `expected 2 stale rows, got ${stale.length} (${statuses.join(",")})`);
  assert(
    statuses.join(",") === "partial,paused_auth",
    `expected exactly partial + paused_auth, got ${statuses.join(",")}`,
  );
  ok("lists partial + paused_auth, excludes succeeded + failed");

  // ordered oldest-first
  for (let i = 1; i < stale.length; i++) {
    assert(
      new Date(stale[i - 1].updatedAt).getTime() <= new Date(stale[i].updatedAt).getTime(),
      "stale rows must be ordered oldest-first",
    );
  }
  ok("stale rows ordered oldest-first");

  // A big cutoff with `now` = the present excludes all just-written rows
  // (none are older than ~1h) — the in-flight/recent protection.
  const recent = (await listStalePartialAndPausedAuth(60 * 60_000)).filter((r) => mineIds.has(r.id));
  assert(recent.length === 0, `fresh rows must be excluded by the staleness cutoff, got ${recent.length}`);
  ok("staleness cutoff excludes fresh partial/paused rows");
}

// ---------------------------------------------------------------------------
// Test 2: markPausedAuth({ resetAttempts }) hands the row back clean.
// ---------------------------------------------------------------------------
async function testMarkPausedAuthResetAttempts(): Promise<void> {
  const clientId = await seedClient(`SPR Reset ${TEST_TAG}`);
  const loc = await seedLocation(clientId, "Loc mid-sweep pause");
  const campId = `camp-${TEST_TAG}-midsweep`;
  await seedMapping(clientId, loc, campId);
  const key = { clientId, locationId: loc, campaignId: campId };
  const runId = `run-${TEST_TAG}-reset`;

  // Two begins bump attemptCount to 2 — simulating a mid-sweep where the run
  // already consumed retry budget before auth turned out to be missing.
  await beginAttempt({ ...key, runId, triggeredBy: "scheduled" });
  await beginAttempt({ ...key, runId, triggeredBy: "scheduled" });
  const before = await getSyncState(key);
  assert(before?.attemptCount === 2, `expected attemptCount 2 before pause, got ${before?.attemptCount}`);

  // Default pause keeps the consumed attempts...
  await markPausedAuth(key, "no SEMrush auth");
  const kept = await getSyncState(key);
  assert(kept?.status === "paused_auth", `expected paused_auth, got ${kept?.status}`);
  assert(kept?.attemptCount === 2, `default pause must NOT reset attempts, got ${kept?.attemptCount}`);
  ok("default markPausedAuth preserves attemptCount");

  // ...resetAttempts hands it back with a clean budget.
  await markPausedAuth(key, "no SEMrush auth", { resetAttempts: true });
  const reset = await getSyncState(key);
  assert(reset?.status === "paused_auth", `expected paused_auth, got ${reset?.status}`);
  assert(reset?.attemptCount === 0, `resetAttempts must zero attemptCount, got ${reset?.attemptCount}`);
  ok("markPausedAuth({ resetAttempts }) zeroes attemptCount (no burned attempt)");
}

// ---------------------------------------------------------------------------
// Test 3: prod-action registry shape.
// ---------------------------------------------------------------------------
async function testProdActionRegistered(): Promise<void> {
  const action = PROD_ACTIONS.find((a) => a.id === "rerun_stale_semrush_partials");
  assert(!!action, "rerun_stale_semrush_partials must be registered in PROD_ACTIONS");
  assert(typeof action!.status === "function", "action must expose status()");
  assert(typeof action!.apply === "function", "action must expose apply()");
  assert(!!action!.selfHeal, "action must opt into self-heal");
  assert(
    typeof action!.selfHeal!.cadenceMs === "number" && action!.selfHeal!.cadenceMs > 0,
    "self-heal cadenceMs must be a positive number",
  );
  // Guard against banned multi-press phrasing (mirrors lint-prod-actions-no-re-press).
  const text = `${action!.title} ${action!.description ?? ""} ${(action as any).change ?? ""}`.toLowerCase();
  for (const banned of ["re-press", "press again", "press until"]) {
    assert(!text.includes(banned), `prod-action copy must not contain banned phrase "${banned}"`);
  }
  ok("prod-action registered with breaker-aware self-heal cadence + clean copy");
}

async function main(): Promise<void> {
  try {
    await testListStalePartialAndPausedAuth();
    await testMarkPausedAuthResetAttempts();
    await testProdActionRegistered();
    console.log(`\n${passed} assertion group(s) passed`);
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
