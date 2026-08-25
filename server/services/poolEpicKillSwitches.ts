/**
 * DB Pool Stability Epic — Phase 0 safety switches (DB-backed loader).
 *
 * (Task #1727; epic plan: `.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md`)
 *
 * Seven hot-toggleable `system_settings` rows that gate the behavior
 * changes shipped in later phases of the pool-stability epic. Phase 0
 * lands the switches with **behavior-neutral** defaults so the epic can
 * roll back any individual change with a settings flip — not a redeploy.
 *
 * Defaults (rationale per switch in the table below):
 *
 *   db_pool_tenancy_enforcement_enabled                false  (Phase 2 guardrail; enforcement is added later)
 *   notify_user_optimized_path_enabled                 true   (matches existing default; honors NOTIFY_USER_OPTIMIZED_PATH_DISABLED env override)
 *   semrush_persistent_enrichment_cache_enabled        false  (Phase 1.2 feature; opt-in once the persistent cache lands)
 *   semrush_no_external_calls_inside_db_hold_enabled   false  (Phase 1.2/1.4 guard; opt-in once external calls move outside hold)
 *   front_recovery_pool_threshold_tuning_enabled       false  (Phase 3; off keeps current backoffForApiPoolPressure behaviour)
 *   external_call_audit_enabled                        false  (Phase 1.5.1 surface; off avoids any write before the table exists)
 *   db_hold_rollup_enabled                             false  (Phase 1.5 trend rollups; off until the rollup writer ships)
 *
 * Read pattern mirrors `server/services/killSwitches.ts`:
 *   - Sync read (`isPoolEpicSwitchEnabled`, re-exported below) returns
 *     the in-memory cache and kicks off an async load when the state is
 *     missing or stale; callers that need a fresh value should await
 *     `ensurePoolEpicSwitchesLoaded()` first.
 *   - Writes update the in-memory cache and the `system_settings` row in
 *     the same call.
 *
 * Task #3947 — module split: the switch name registry, hard-coded
 * defaults, in-memory state, and the sync read live in
 * `./poolEpicSwitchState.ts`, a dependency-free leaf that infrastructure
 * (`cache/redisCache.ts`) imports directly so its module ring never
 * contains `storage`. THIS module owns everything that touches the DB
 * (load / seed / set / snapshot) and remains the unchanged public import
 * surface — it re-exports the leaf pieces. At module-init it registers
 * the background-refresh trigger into the leaf, which keeps the
 * documented "flip is hot" contract on cache-only read paths. The full
 * Option A vs. Option B comparison is recorded in the leaf's header.
 *
 * Loader fails open: if the settings table is unreachable we fall back
 * to the hard-coded default for that switch.
 */
import { storage } from "../storage";
import {
  POOL_EPIC_SWITCH_DEFAULTS,
  POOL_EPIC_SWITCH_NAMES,
  type PoolEpicSwitchName,
  arePoolEpicSwitchOverridesFresh,
  getPoolEpicSwitchStateSnapshot,
  markPoolEpicSwitchOverridesStale,
  parsePoolEpicSwitchValue,
  registerPoolEpicSwitchRefreshTrigger,
  replacePoolEpicSwitchOverrides,
  setPoolEpicSwitchOverrideInMemory,
  __resetPoolEpicSwitchStateForTest,
} from "./poolEpicSwitchState";

// Public surface (unchanged by the Task #3947 split): every pre-split
// export of this module remains importable from this path.
export type { PoolEpicSwitchName } from "./poolEpicSwitchState";
export { POOL_EPIC_SWITCH_NAMES, isPoolEpicSwitchEnabled } from "./poolEpicSwitchState";

let loadingPromise: Promise<void> | null = null;

async function loadOverrides(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const rows = await storage.getSystemSettings(POOL_EPIC_SWITCH_NAMES);
      // Replace the map wholesale so a row deleted out-of-process
      // reverts to its hard-coded default on the next refresh.
      const parsed = new Map<PoolEpicSwitchName, boolean>();
      for (const name of POOL_EPIC_SWITCH_NAMES) {
        const value = parsePoolEpicSwitchValue(rows[name]);
        if (value !== undefined) parsed.set(name, value);
      }
      replacePoolEpicSwitchOverrides(parsed);
    } catch (err: any) {
      console.warn(
        "[PoolEpicKillSwitches] Failed to load overrides:",
        err?.message ?? err,
      );
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

// Wire the leaf's background-refresh trigger at module-init time (design
// note: `./poolEpicSwitchState.ts` header). ESM evaluates this module
// before any importer's code runs, so the trigger is in place before any
// consumer can call the public surface. `__resetPoolEpicSwitchesForTest`
// deliberately leaves it registered so tests keep the production wiring.
registerPoolEpicSwitchRefreshTrigger(() => {
  void loadOverrides();
});

export async function ensurePoolEpicSwitchesLoaded(): Promise<void> {
  if (arePoolEpicSwitchOverridesFresh()) return;
  await loadOverrides();
}

/**
 * Seed every Phase 0 switch as an explicit `system_settings` row using
 * its hard-coded default if (and only if) the row does not already
 * exist. Behavior-neutral: an already-present row is never overwritten,
 * so an operator who flipped a switch before the seeder ran keeps that
 * value. Called at startup from `server/index.ts` so the seven keys are
 * always discoverable in the settings table (and in the admin
 * snapshot endpoint) without manual DDL.
 */
export async function ensurePoolEpicSwitchesSeeded(): Promise<void> {
  try {
    const before = await storage.getSystemSettings(POOL_EPIC_SWITCH_NAMES);
    const missingBefore = POOL_EPIC_SWITCH_NAMES.filter(
      (name) => before[name] === undefined,
    );
    for (const name of missingBefore) {
      // Pass the "system" synthetic actor marker that
      // `settingsStorage.setSystemSetting` coerces to NULL before
      // writing to `updated_by` — anything else would fail the
      // `system_settings_updated_by_users_id_fk` FK.
      await storage.setSystemSetting(
        name,
        POOL_EPIC_SWITCH_DEFAULTS[name] ? "true" : "false",
        "system",
      );
    }
    // Force the next read to pick up anything we just wrote.
    markPoolEpicSwitchOverridesStale();

    // Post-seed assertion: re-read and log the missing-vs-present state
    // so a silent FK failure surfaces immediately in the bootstrap log
    // instead of waiting for an operator to GET the snapshot endpoint.
    const after = await storage.getSystemSettings(POOL_EPIC_SWITCH_NAMES);
    const stillMissing = POOL_EPIC_SWITCH_NAMES.filter(
      (name) => after[name] === undefined,
    );
    if (stillMissing.length > 0) {
      console.warn(
        `[PoolEpicKillSwitches] Seed incomplete — ${stillMissing.length}/${POOL_EPIC_SWITCH_NAMES.length} keys missing from system_settings: ${stillMissing.join(", ")}`,
      );
    } else if (missingBefore.length > 0) {
      console.log(
        `[PoolEpicKillSwitches] Seeded ${missingBefore.length} switch(es) into system_settings: ${missingBefore.join(", ")}`,
      );
    }
  } catch (err: any) {
    console.warn(
      "[PoolEpicKillSwitches] Seed failed (non-fatal):",
      err?.message ?? err,
    );
  }
}

export async function setPoolEpicSwitch(
  name: PoolEpicSwitchName,
  value: boolean,
  updatedBy?: string,
): Promise<void> {
  await ensurePoolEpicSwitchesLoaded();
  setPoolEpicSwitchOverrideInMemory(name, value);
  await storage.setSystemSetting(name, value ? "true" : "false", updatedBy);
}

export async function getPoolEpicSwitchSnapshot(): Promise<
  Record<
    PoolEpicSwitchName,
    { effective: boolean; default: boolean; overridden: boolean; envForced: boolean }
  >
> {
  await ensurePoolEpicSwitchesLoaded();
  return getPoolEpicSwitchStateSnapshot();
}

// Test seam: clears in-memory state so unit tests can simulate a fresh
// process. Not exported through any public registry.
export function __resetPoolEpicSwitchesForTest(): void {
  __resetPoolEpicSwitchStateForTest();
  loadingPromise = null;
}
