/* test-registration
{
  "name": "SEMrush stale-warning auto-clear (Task #1208)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1208 — Auto-clear the "campaign no longer in SEMrush" warning once
 * the operator has reconfigured the stale mapping.
 *
 * The sibling test (semrush-stale-and-incomplete-inventory.test.ts) pins the
 * *creation* of `clientSemrushIntegrations.warningMessage` when a mapping is
 * flipped to stale. This test pins the *clearing* side: once the operator
 * un-stales (or replaces) the mapping and no other stale rows remain on the
 * integration, the warning must be cleared without waiting for the next
 * sync wave to overwrite it.
 *
 * Coverage:
 *   1. Helper clears warning when no stale rows remain.
 *   2. Helper leaves warning intact when at least one stale row remains.
 *   3. Helper leaves warning intact when the message has nothing to do with
 *      stale campaigns (e.g. "incomplete keyword inventory") — we don't
 *      want to wipe unrelated operator signals.
 *   4. End-to-end: invoking the inventory-apply handler with `isStale=false`
 *      on a previously-stale mapping clears the warning.
 */
import { db } from "../server/db";
import {
  clients,
  clientLocations,
  clientSemrushIntegrations,
  semrushLocationCampaigns,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { clearStaleWarningIfResolved } from "../server/services/semrushStaleWarningClear";
import { inventorySyncApply } from "../server/services/applyHandlers";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `swc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const STALE_WARNING =
  "Partial sync — 0 freshly imported, 1 stale. 1 campaign(s) marked stale";
const INCOMPLETE_WARNING =
  "Sync complete — 1 freshly imported. 1 campaign(s) had incomplete keyword inventory — stale-keyword cleanup skipped";

const createdMappingIds: string[] = [];
const createdIntegrationIds: string[] = [];
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

async function seedMapping(
  clientId: string,
  locationId: string,
  campaignId: string,
  isStale: boolean,
): Promise<string> {
  const [row] = await db
    .insert(semrushLocationCampaigns)
    .values({
      clientId,
      locationId,
      semrushCampaignId: campaignId,
      semrushCampaignName: `Camp ${campaignId}`,
      isStale,
      staleSince: isStale ? new Date() : null,
    })
    .returning({ id: semrushLocationCampaigns.id });
  createdMappingIds.push(row.id);
  return row.id;
}

async function seedIntegration(clientId: string, warningMessage: string | null): Promise<string> {
  const [row] = await db
    .insert(clientSemrushIntegrations)
    .values({
      clientId,
      integrationEnabled: true,
      isActive: true,
      syncStatus: "success",
      warningMessage,
    })
    .returning({ id: clientSemrushIntegrations.id });
  createdIntegrationIds.push(row.id);
  return row.id;
}

async function readWarning(integrationId: string): Promise<string | null> {
  const [row] = await db
    .select({ warningMessage: clientSemrushIntegrations.warningMessage })
    .from(clientSemrushIntegrations)
    .where(eq(clientSemrushIntegrations.id, integrationId));
  return row?.warningMessage ?? null;
}

// ----------------------------------------------------------------------------
// Test 1 — Reconfiguring the only stale mapping clears the warning.
// ----------------------------------------------------------------------------
async function testHelperClearsWarningWhenNoStaleRemains(): Promise<void> {
  const clientId = await seedClient(`SWC Cleared ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const mapId = await seedMapping(clientId, locId, `camp-${TEST_TAG}-a`, true);
  const integrationId = await seedIntegration(clientId, STALE_WARNING);

  // Operator reconfigures the mapping (un-stales it).
  await db
    .update(semrushLocationCampaigns)
    .set({ isStale: false, staleSince: null })
    .where(eq(semrushLocationCampaigns.id, mapId));

  const result = await clearStaleWarningIfResolved(clientId);
  assert(result.cleared === true, `expected cleared=true, got ${JSON.stringify(result)}`);
  assert(result.reason === "cleared", `expected reason=cleared, got ${result.reason}`);

  const after = await readWarning(integrationId);
  assert(after === null, `expected warningMessage=null after reconfiguration, got: ${after}`);
  console.log("[Test1 HelperClearsWarningWhenNoStaleRemains] ✓");
}

// ----------------------------------------------------------------------------
// Test 2 — Helper does NOT clear when another stale mapping is still around.
// ----------------------------------------------------------------------------
async function testHelperLeavesWarningWhenStaleRemains(): Promise<void> {
  const clientId = await seedClient(`SWC StaleRemains ${TEST_TAG}`);
  const locA = await seedLocation(clientId, "LocA");
  const locB = await seedLocation(clientId, "LocB");
  const mapA = await seedMapping(clientId, locA, `camp-${TEST_TAG}-a`, true);
  await seedMapping(clientId, locB, `camp-${TEST_TAG}-b`, true);
  const integrationId = await seedIntegration(clientId, STALE_WARNING);

  // Operator only reconfigures one of the two stale mappings.
  await db
    .update(semrushLocationCampaigns)
    .set({ isStale: false, staleSince: null })
    .where(eq(semrushLocationCampaigns.id, mapA));

  const result = await clearStaleWarningIfResolved(clientId);
  assert(result.cleared === false, `expected cleared=false, got ${JSON.stringify(result)}`);
  assert(
    result.reason === "stale_remaining",
    `expected reason=stale_remaining, got ${result.reason}`,
  );

  const after = await readWarning(integrationId);
  assert(
    after === STALE_WARNING,
    `expected warningMessage to be unchanged when stale rows remain, got: ${after}`,
  );
  console.log("[Test2 HelperLeavesWarningWhenStaleRemains] ✓");
}

// ----------------------------------------------------------------------------
// Test 3 — Helper does NOT touch warnings unrelated to stale campaigns.
// ----------------------------------------------------------------------------
async function testHelperLeavesUnrelatedWarning(): Promise<void> {
  const clientId = await seedClient(`SWC UnrelatedWarn ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  await seedMapping(clientId, locId, `camp-${TEST_TAG}-c`, false);
  const integrationId = await seedIntegration(clientId, INCOMPLETE_WARNING);

  const result = await clearStaleWarningIfResolved(clientId);
  assert(result.cleared === false, `expected cleared=false, got ${JSON.stringify(result)}`);
  assert(
    result.reason === "no_stale_warning",
    `expected reason=no_stale_warning, got ${result.reason}`,
  );

  const after = await readWarning(integrationId);
  assert(
    after === INCOMPLETE_WARNING,
    `expected non-stale warning to be preserved, got: ${after}`,
  );
  console.log("[Test3 HelperLeavesUnrelatedWarning] ✓");
}

// ----------------------------------------------------------------------------
// Test 4 — End-to-end: inventory-apply un-stale flip clears the warning via
// the integrated callsite (not just a direct helper call).
// ----------------------------------------------------------------------------
async function testInventoryApplyUnstaleClearsWarning(): Promise<void> {
  const clientId = await seedClient(`SWC ApplyUnstale ${TEST_TAG}`);
  const locId = await seedLocation(clientId, "Loc1");
  const campaignId = `camp-${TEST_TAG}-d`;
  const mapId = await seedMapping(clientId, locId, campaignId, true);
  const integrationId = await seedIntegration(clientId, STALE_WARNING);

  const result = await inventorySyncApply.handle({
    resultJson: {
      clientId,
      locationCampaigns: [
        {
          clientId,
          locationId: locId,
          semrushCampaignId: campaignId,
          isStale: false,
        },
      ],
    },
  } as any);

  assert(result.outcome !== "error", `inventory-apply should not error: ${JSON.stringify(result)}`);

  const [mapping] = await db
    .select()
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.id, mapId));
  assert(mapping.isStale === false, `expected mapping.isStale=false after un-stale flip, got ${mapping.isStale}`);

  const after = await readWarning(integrationId);
  assert(
    after === null,
    `expected warningMessage to be cleared after inventory-apply un-stale flip, got: ${after}`,
  );
  console.log("[Test4 InventoryApplyUnstaleClearsWarning] ✓");
}

// ----------------------------------------------------------------------------
// Cleanup
// ----------------------------------------------------------------------------
async function cleanup(): Promise<void> {
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
    await testHelperClearsWarningWhenNoStaleRemains();
    await testHelperLeavesWarningWhenStaleRemains();
    await testHelperLeavesUnrelatedWarning();
    await testInventoryApplyUnstaleClearsWarning();
    console.log("semrush-stale-warning-auto-clear: all cases passed");
  } catch (err) {
    console.error("semrush-stale-warning-auto-clear: FAILED", err);
    await cleanup();
    process.exitCode = 1;
  }
  await cleanup();
})();
