/* test-registration
{
  "name": "SEMrush ghost-cleanup daily run + kill switch (Task #1223)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1223 — regression coverage for the daily SEMrush ghost cleanup
 * (server/services/semrushGhostCleanup.ts).
 *
 * Two halves:
 *
 *   1. Unit coverage for `isSemrushGhostCleanupEnabled`:
 *      - default-on when the `system_settings` row is missing.
 *      - default-on when present but blank.
 *      - off-tokens (`false`/`0`/`off`/`no`, with surrounding whitespace and
 *        mixed case) flip to disabled.
 *      - any other value (e.g. `true`, `yes`, `1`, gibberish) stays enabled.
 *
 *   2. Integration coverage for `runSemrushGhostCleanup` against the live DB:
 *      - only ghost mappings (locationId no longer in `client_locations`)
 *        are deleted; configured mappings survive.
 *      - the persisted last-run summary (`semrush_ghost_cleanup_last_run`)
 *        matches scanned/ghosts/deleted counts and is JSON-parseable.
 *      - re-running immediately is idempotent: scanned drops to the
 *        configured-only count, ghosts=deleted=0.
 *      - when the kill switch is off, a normal run short-circuits with
 *        `skippedReason="disabled"` and zero deletions.
 *      - `force: true` overrides the disabled flag and still performs the
 *        deletion.
 *
 * Ghost rows are seeded by inserting a normal mapping against a real
 * location and then deleting just the location row with FK cascade
 * suppressed via `session_replication_role = replica` for the duration
 * of the DELETE. This avoids the ON DELETE CASCADE on
 * `semrush_location_campaigns.location_id` that would otherwise wipe
 * the mapping along with its parent.
 */
import { sql, eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  clients,
  clientLocations,
  semrushLocationCampaigns,
  healthDailyRollups,
} from "@shared/schema";
import {
  isSemrushGhostCleanupEnabled,
  runSemrushGhostCleanup,
  getLastSemrushGhostCleanupRun,
  readLastSemrushGhostCleanupRun,
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  HEALTH_METRIC,
} from "../server/services/semrushGhostCleanup";
import { setSystemSetting, deleteSystemSetting, getSystemSetting } from "../server/storage/settingsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_TAG = `sgc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];
const createdMappingIds: string[] = [];

let originalEnabledValue: string | null = null;
let originalLastRunValue: string | null = null;
let savedOriginals = false;

async function saveOriginals(): Promise<void> {
  if (savedOriginals) return;
  const enabled = await getSystemSetting(SETTING_ENABLED);
  originalEnabledValue = enabled?.value ?? null;
  const lastRun = await getSystemSetting(SETTING_LAST_RUN);
  originalLastRunValue = lastRun?.value ?? null;
  savedOriginals = true;
}

async function restoreOriginals(): Promise<void> {
  if (!savedOriginals) return;
  if (originalEnabledValue === null) {
    await deleteSystemSetting(SETTING_ENABLED);
  } else {
    await setSystemSetting(SETTING_ENABLED, originalEnabledValue);
  }
  if (originalLastRunValue === null) {
    await deleteSystemSetting(SETTING_LAST_RUN);
  } else {
    await setSystemSetting(SETTING_LAST_RUN, originalLastRunValue);
  }
}

async function setEnabled(value: string | null): Promise<void> {
  if (value === null) {
    await deleteSystemSetting(SETTING_ENABLED);
  } else {
    await setSystemSetting(SETTING_ENABLED, value);
  }
}

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

async function seedMapping(clientId: string, locationId: string, campaignId: string): Promise<string> {
  const [row] = await db
    .insert(semrushLocationCampaigns)
    .values({
      clientId,
      locationId,
      semrushCampaignId: campaignId,
      semrushCampaignName: `Camp ${campaignId}`,
      isStale: false,
    })
    .returning({ id: semrushLocationCampaigns.id });
  createdMappingIds.push(row.id);
  return row.id;
}

/**
 * Delete a `client_locations` row WITHOUT triggering the
 * `semrush_location_campaigns.location_id` ON DELETE CASCADE, so the
 * mapping is left behind as a ghost. `session_replication_role = replica`
 * suppresses user-mode triggers (FK enforcement included) for the
 * duration of the statement.
 */
async function orphanLocation(locationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM client_locations WHERE id = ${locationId}`);
  });
  // Drop from cleanup tracker — it's already gone from the table.
  const idx = createdLocationIds.indexOf(locationId);
  if (idx >= 0) createdLocationIds.splice(idx, 1);
}

// ─── Test 1 — isSemrushGhostCleanupEnabled token coverage ───────────────────
async function testEnabledFlagTokens(): Promise<void> {
  // Default-on when unset.
  await setEnabled(null);
  assert((await isSemrushGhostCleanupEnabled()) === true,
    "default-on when system setting is unset");

  // Default-on when present but blank.
  await setEnabled("");
  assert((await isSemrushGhostCleanupEnabled()) === true,
    "default-on when value is blank");
  await setEnabled("   ");
  assert((await isSemrushGhostCleanupEnabled()) === true,
    "default-on when value is whitespace-only");

  // Off-tokens (case-insensitive, whitespace-tolerant).
  for (const token of ["false", "0", "off", "no", "FALSE", "Off", "  no  "]) {
    await setEnabled(token);
    assert(
      (await isSemrushGhostCleanupEnabled()) === false,
      `expected token "${token}" to disable cleanup`,
    );
  }

  // Anything else stays enabled.
  for (const token of ["true", "1", "yes", "on", "enabled", "anything"]) {
    await setEnabled(token);
    assert(
      (await isSemrushGhostCleanupEnabled()) === true,
      `expected non-off token "${token}" to leave cleanup enabled`,
    );
  }

  console.log("[Test1 EnabledFlagTokens] ✓");
}

// ─── Test 2 — runSemrushGhostCleanup against the seeded DB ──────────────────
async function testRunCleanupBehavior(): Promise<void> {
  // Three clients so we can prove targeted-only deletion across rows
  // unrelated to the test, plus per-client ghost vs configured behavior.
  const clientId = await seedClient(`SGC Cleanup ${TEST_TAG}`);

  const liveLocId = await seedLocation(clientId, "LiveLoc");
  const ghostLocAId = await seedLocation(clientId, "GhostLocA");
  const ghostLocBId = await seedLocation(clientId, "GhostLocB");

  const liveMapId = await seedMapping(clientId, liveLocId, `${TEST_TAG}-live`);
  const ghostMapAId = await seedMapping(clientId, ghostLocAId, `${TEST_TAG}-ghostA`);
  const ghostMapBId = await seedMapping(clientId, ghostLocBId, `${TEST_TAG}-ghostB`);

  // Orphan two of the three locations so their mappings become ghosts.
  await orphanLocation(ghostLocAId);
  await orphanLocation(ghostLocBId);

  // Sanity: all three mappings still exist before the cleanup runs.
  const before = await db
    .select({ id: semrushLocationCampaigns.id })
    .from(semrushLocationCampaigns)
    .where(inArray(semrushLocationCampaigns.id, [liveMapId, ghostMapAId, ghostMapBId]));
  assert(before.length === 3, `expected 3 seeded mappings before cleanup, got ${before.length}`);

  // Make sure the kill switch is on for this run.
  await setEnabled(null);

  const result = await runSemrushGhostCleanup();

  // The run scans the whole table, so ghosts/deleted are the test-relevant
  // figures to assert exactly. scanned only has to be ≥ 3 (live + 2 ghosts).
  assert(result.skippedReason === undefined,
    `expected no skippedReason on enabled run, got ${result.skippedReason}`);
  assert(result.scanned >= 3, `expected scanned >= 3, got ${result.scanned}`);
  assert(result.ghosts >= 2, `expected ghosts >= 2 (we seeded 2), got ${result.ghosts}`);
  assert(result.deleted === result.ghosts,
    `expected deleted (${result.deleted}) === ghosts (${result.ghosts})`);
  assert(result.durationMs >= 0, `durationMs should be non-negative, got ${result.durationMs}`);

  // The two ghost mappings must be gone; the live mapping must survive.
  const afterLive = await db
    .select({ id: semrushLocationCampaigns.id })
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.id, liveMapId));
  assert(afterLive.length === 1, "live (configured) mapping must survive cleanup");

  const afterGhosts = await db
    .select({ id: semrushLocationCampaigns.id })
    .from(semrushLocationCampaigns)
    .where(inArray(semrushLocationCampaigns.id, [ghostMapAId, ghostMapBId]));
  assert(afterGhosts.length === 0,
    `expected both ghost mappings deleted, ${afterGhosts.length} survived`);
  // Drop deleted ids from the cleanup tracker so the final cleanup pass
  // doesn't issue redundant DELETEs.
  for (const id of [ghostMapAId, ghostMapBId]) {
    const i = createdMappingIds.indexOf(id);
    if (i >= 0) createdMappingIds.splice(i, 1);
  }

  // Persisted last-run summary must match the in-memory result.
  const persisted = await getLastSemrushGhostCleanupRun();
  assert(persisted !== null, "expected persisted last-run summary to exist");
  assert(persisted!.scanned === result.scanned,
    `persisted scanned ${persisted!.scanned} !== result ${result.scanned}`);
  assert(persisted!.ghosts === result.ghosts,
    `persisted ghosts ${persisted!.ghosts} !== result ${result.ghosts}`);
  assert(persisted!.deleted === result.deleted,
    `persisted deleted ${persisted!.deleted} !== result ${result.deleted}`);
  assert(persisted!.scannedAt === result.scannedAt,
    `persisted scannedAt ${persisted!.scannedAt} !== result ${result.scannedAt}`);
  assert(persisted!.skippedReason === undefined,
    `persisted skippedReason should be undefined, got ${persisted!.skippedReason}`);

  // ── Idempotency: re-running immediately must perform 0 deletions. ──
  const second = await runSemrushGhostCleanup();
  assert(second.skippedReason === undefined,
    "second run must not be skipped (kill switch still on)");
  assert(second.deleted === 0,
    `expected idempotent second run deleted=0, got ${second.deleted}`);
  // Only the originally-seeded ghosts on this client should be gone.
  // Scanned drops by exactly the 2 we removed (other rows in the table
  // are unrelated test/data noise but the delta must hold).
  assert(second.scanned === result.scanned - result.deleted,
    `expected scanned to drop by deleted count (${result.scanned} - ${result.deleted}), got ${second.scanned}`);
  // Ghost count on the second run can be > 0 only if pre-existing
  // unrelated ghosts exist; but it must not include ours (we just
  // verified our two are gone), and deleted=0 still holds, so the
  // contract "re-running is safe" is met regardless.

  // ── Disabled run (force=false) short-circuits with skippedReason. ──
  await setEnabled("off");
  const skipped = await runSemrushGhostCleanup();
  assert(skipped.skippedReason === "disabled",
    `expected skippedReason="disabled", got ${skipped.skippedReason}`);
  assert(skipped.scanned === 0 && skipped.ghosts === 0 && skipped.deleted === 0,
    `expected zeroed counters on disabled run, got ${JSON.stringify(skipped)}`);
  assert(skipped.durationMs === 0,
    `expected durationMs=0 on disabled short-circuit, got ${skipped.durationMs}`);

  // The persisted last-run row must have been overwritten with the
  // skipped summary so the Health dashboard can render the "disabled"
  // state.
  const persistedSkipped = await getLastSemrushGhostCleanupRun();
  assert(persistedSkipped !== null && persistedSkipped.skippedReason === "disabled",
    `expected persisted last-run to reflect disabled skip, got ${JSON.stringify(persistedSkipped)}`);

  // ── force=true overrides the disabled flag and runs for real. ──
  // Seed one fresh ghost so we have something to delete.
  const forceLocId = await seedLocation(clientId, "ForceGhostLoc");
  const forceMapId = await seedMapping(clientId, forceLocId, `${TEST_TAG}-force`);
  await orphanLocation(forceLocId);

  const forced = await runSemrushGhostCleanup({ force: true });
  assert(forced.skippedReason === undefined,
    `force=true must override disabled flag, got skippedReason=${forced.skippedReason}`);
  assert(forced.deleted >= 1,
    `force=true run must perform deletions, deleted=${forced.deleted}`);

  const forcedAfter = await db
    .select({ id: semrushLocationCampaigns.id })
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.id, forceMapId));
  assert(forcedAfter.length === 0,
    "force=true run must have deleted the freshly-seeded ghost mapping");
  const j = createdMappingIds.indexOf(forceMapId);
  if (j >= 0) createdMappingIds.splice(j, 1);

  console.log("[Test2 RunCleanupBehavior] ✓");
}

// ─── Test 3 — readLastSemrushGhostCleanupRun classify (Task #2198) ──────────
// The classify-then-surface reader must tell "never ran" (no setting row)
// apart from "stored value was unreadable" (parse failure / non-object).
async function testReadLastRunClassify(): Promise<void> {
  // never_run — no persisted setting row.
  await deleteSystemSetting(SETTING_LAST_RUN);
  const neverRun = await readLastSemrushGhostCleanupRun();
  assert(neverRun.status === "never_run",
    `expected status="never_run" when unset, got "${neverRun.status}"`);
  assert(neverRun.lastRun === null, "never_run must carry null lastRun");
  assert(neverRun.error === undefined, "never_run must not carry an error");

  // unreadable — stored value is not valid JSON.
  await setSystemSetting(SETTING_LAST_RUN, "{not json");
  const corruptParse = await readLastSemrushGhostCleanupRun();
  assert(corruptParse.status === "unreadable",
    `expected status="unreadable" on parse failure, got "${corruptParse.status}"`);
  assert(corruptParse.lastRun === null, "unreadable must carry null lastRun");
  assert(typeof corruptParse.error === "string" && corruptParse.error.length > 0,
    "unreadable must carry a plain-English error");

  // unreadable — valid JSON but not an object (e.g. a bare number).
  await setSystemSetting(SETTING_LAST_RUN, "42");
  const corruptShape = await readLastSemrushGhostCleanupRun();
  assert(corruptShape.status === "unreadable",
    `expected status="unreadable" on non-object JSON, got "${corruptShape.status}"`);
  assert(corruptShape.lastRun === null, "non-object unreadable must carry null lastRun");

  // The back-compat wrapper still collapses both to null.
  await deleteSystemSetting(SETTING_LAST_RUN);
  assert((await getLastSemrushGhostCleanupRun()) === null,
    "getLastSemrushGhostCleanupRun wrapper returns null when unset");

  console.log("[Test3 ReadLastRunClassify] ✓");
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  try {
    if (createdMappingIds.length > 0) {
      await db
        .delete(semrushLocationCampaigns)
        .where(inArray(semrushLocationCampaigns.id, createdMappingIds));
    }
    if (createdLocationIds.length > 0) {
      await db
        .delete(clientLocations)
        .where(inArray(clientLocations.id, createdLocationIds));
    }
    if (createdClientIds.length > 0) {
      await db.delete(clients).where(inArray(clients.id, createdClientIds));
    }
    // Wipe any health rollup row this test wrote for today so we don't
    // pollute long-window dashboards. The (metric, date) upsert key
    // makes this safe to delete by metric + today's UTC date.
    const today = new Date();
    const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    await db
      .delete(healthDailyRollups)
      .where(sql`${healthDailyRollups.metric} = ${HEALTH_METRIC} AND ${healthDailyRollups.date} = ${dateStr}`);
  } catch (err) {
    console.error("[semrush-ghost-cleanup] cleanup error:", err);
  }
  await restoreOriginals();
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  try {
    await saveOriginals();
    await testEnabledFlagTokens();
    await testRunCleanupBehavior();
    await testReadLastRunClassify();
    console.log("semrush-ghost-cleanup: all cases passed");
  } catch (err) {
    console.error("semrush-ghost-cleanup: FAILED", err);
    await cleanup();
    process.exitCode = 1;
  }
  await cleanup();
})();