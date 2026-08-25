/* test-registration
{
  "name": "Front recovery throughput tuning (Task #1730)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Unit tests for Task #1730 — Pool Epic Phase 3 Front recovery
 * throughput tuning module.
 *
 * Covers the four sub-items in `server/services/frontRecoveryTuning.ts`:
 *   3.1 — `evaluateApiPoolPressureWithHysteresis` requires N consecutive
 *         high samples before tripping; stays pressured until the pool
 *         clears under the (lower) clear threshold; waiters trip
 *         immediately even before N samples accumulate.
 *   3.2 — `getFrontRecoveryTuning()` resolves the saturated page delay
 *         and required-signals knobs from `system_settings` with the
 *         Phase 3 defaults when the Phase 0 kill switch is on.
 *   3.3 — Page delay default drops from PERF (500ms) to 200ms when the
 *         tuning kill switch is on; legacy default preserved when off.
 *   3.4 — Ingest concurrency is live-tunable through the setting.
 */
import { storage } from "../server/storage";
import {
  __resetFrontRecoveryTuningCacheForTest,
  createApiPoolPressureHysteresis,
  evaluateApiPoolPressureWithHysteresis,
  getFrontRecoveryTuning,
} from "../server/services/frontRecoveryTuning";
import {
  __resetPoolEpicSwitchesForTest,
  ensurePoolEpicSwitchesLoaded,
  isPoolEpicSwitchEnabled,
} from "../server/services/poolEpicKillSwitches";
import { PERF } from "../server/perfConfig";

let failed = 0;
async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(
      `  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`,
    );
    failed++;
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// In-memory fake of `storage.getSystemSettings` shared by both the
// tuning module and the pool-epic kill-switch module. Both call the
// same `storage.getSystemSettings(keys: string[])` API.
const settings = new Map<string, string>();
(storage as any).getSystemSettings = async (keys: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = settings.get(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
};

function setSetting(key: string, value: string | null): void {
  if (value === null) settings.delete(key);
  else settings.set(key, value);
}

async function reset(initialSettings: Record<string, string> = {}) {
  settings.clear();
  for (const [k, v] of Object.entries(initialSettings)) settings.set(k, v);
  __resetFrontRecoveryTuningCacheForTest();
  __resetPoolEpicSwitchesForTest();
  // Hydrate the pool-epic kill-switch cache up-front so the
  // synchronous `isPoolEpicSwitchEnabled()` reads inside the tuning
  // module's `defaults()` see the seeded settings on the first call.
  await ensurePoolEpicSwitchesLoaded();
}

// Force the tuning cache to hydrate before we read it synchronously.
// `getFrontRecoveryTuning()` triggers a background refresh; we await
// a microtask cycle plus give the in-flight load a chance to resolve
// by reading once and then awaiting `setImmediate`.
async function primeTuningCache() {
  getFrontRecoveryTuning();
  await new Promise((r) => setImmediate(r));
  // Second read picks up the now-resolved cache.
  return getFrontRecoveryTuning();
}

async function main() {
  console.log("Front recovery tuning (Task #1730)");

  // ----- 3.1 hysteresis -----
  await run(
    "single high sample does NOT trip pressure (requires N=2 by default with switch on)",
    async () => {
      await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
      assert(
        isPoolEpicSwitchEnabled("front_recovery_pool_threshold_tuning_enabled"),
        "kill switch should be ON",
      );
      const tuning = await primeTuningCache();
      assertEq(
        tuning.apiPoolBackoffThresholdPercent,
        90,
        "trigger default with switch ON",
      );
      assertEq(
        tuning.apiPoolBackoffRequiredSamples,
        2,
        "samples default with switch ON",
      );
      const state = createApiPoolPressureHysteresis();
      const first = evaluateApiPoolPressureWithHysteresis(
        state,
        { utilizationPct: 95, waitingCount: 0 },
        tuning,
      );
      assertEq(first.pressured, false, "first high sample below required N");
      assertEq(state.consecutiveHighSamples, 1, "samples counter incremented");
    },
  );

  await run(
    "two consecutive high samples trip pressure; clears only under clear%",
    async () => {
      await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
      const tuning = await primeTuningCache();
      const state = createApiPoolPressureHysteresis();
      evaluateApiPoolPressureWithHysteresis(
        state,
        { utilizationPct: 92, waitingCount: 0 },
        tuning,
      );
      const tripped = evaluateApiPoolPressureWithHysteresis(
        state,
        { utilizationPct: 91, waitingCount: 0 },
        tuning,
      );
      assertEq(tripped.pressured, true, "second sample trips pressure");
      assertEq(tripped.changed, true, "state change flagged");
      // Above clear% but below threshold → still pressured.
      const stillHigh = evaluateApiPoolPressureWithHysteresis(
        state,
        { utilizationPct: 85, waitingCount: 0 },
        tuning,
      );
      assertEq(
        stillHigh.pressured,
        true,
        "stays pressured between clear and threshold",
      );
      assertEq(stillHigh.changed, false, "no change while still pressured");
      // Drop to clear% → flips off.
      const cleared = evaluateApiPoolPressureWithHysteresis(
        state,
        { utilizationPct: 80, waitingCount: 0 },
        tuning,
      );
      assertEq(cleared.pressured, false, "drops to clear at clear%");
      assertEq(cleared.changed, true, "clear flips state");
    },
  );

  await run("any waiter trips pressure immediately (bypasses sample gate)", async () => {
    await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
    const tuning = await primeTuningCache();
    const state = createApiPoolPressureHysteresis();
    const decision = evaluateApiPoolPressureWithHysteresis(
      state,
      { utilizationPct: 50, waitingCount: 1 },
      tuning,
    );
    assertEq(decision.pressured, true, "waiter trips on first sample");
  });

  // ----- 3.2 saturation knobs -----
  await run(
    "Phase 3 defaults: saturated page delay 2000ms, required signals 2",
    async () => {
      await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
      const tuning = await primeTuningCache();
      assertEq(tuning.dbSaturatedPageDelayMs, 2000, "saturated delay default");
      assertEq(
        tuning.dbSaturatedRequiredSignals,
        2,
        "required signals default",
      );
    },
  );

  await run("legacy defaults apply when the kill switch is OFF", async () => {
    await reset({ front_recovery_pool_threshold_tuning_enabled: "false" });
    const tuning = await primeTuningCache();
    assertEq(
      tuning.apiPoolBackoffThresholdPercent,
      PERF.DB_POOL_UTIL_WARN_PCT,
      "legacy trigger = PERF.DB_POOL_UTIL_WARN_PCT",
    );
    assertEq(
      tuning.dbSaturatedPageDelayMs,
      PERF.FRONT_RECOVERY_PAGE_DELAY_SATURATED_MS,
      "legacy saturated delay = PERF default",
    );
    assertEq(
      tuning.dbSaturatedRequiredSignals,
      1,
      "legacy required signals = 1 (sticky)",
    );
    assertEq(
      tuning.pageDelayMs,
      PERF.FRONT_RECOVERY_PAGE_DELAY_MS,
      "legacy page delay = PERF default (500ms)",
    );
    assertEq(
      tuning.ingestConcurrency,
      PERF.FRONT_RECOVERY_INGEST_CONCURRENCY,
      "legacy concurrency = PERF default (1)",
    );
  });

  // ----- 3.3 page delay -----
  await run("page delay default drops to 200ms when tuning enabled", async () => {
    await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
    const tuning = await primeTuningCache();
    assertEq(tuning.pageDelayMs, 200, "tuned page delay default");
  });

  await run("setting override wins regardless of switch state", async () => {
    await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
    setSetting("front_recovery_page_delay_ms", "150");
    const tuning = await primeTuningCache();
    assertEq(tuning.pageDelayMs, 150, "explicit setting wins");
  });

  // ----- 3.4 concurrency -----
  await run("ingest concurrency live-tunable; clamped to [1,5]", async () => {
    await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
    setSetting("front_recovery_ingest_concurrency", "3");
    let tuning = await primeTuningCache();
    assertEq(tuning.ingestConcurrency, 3, "ramp to 3");

    setSetting("front_recovery_ingest_concurrency", "99");
    __resetFrontRecoveryTuningCacheForTest();
    tuning = await primeTuningCache();
    assertEq(tuning.ingestConcurrency, 5, "clamped to upper bound 5");

    setSetting("front_recovery_ingest_concurrency", "0");
    __resetFrontRecoveryTuningCacheForTest();
    tuning = await primeTuningCache();
    assertEq(tuning.ingestConcurrency, 1, "clamped to lower bound 1");
  });

  // ----- safety: clear% can never exceed threshold% -----
  await run("clear% is bounded by threshold% (defense against misconfig)", async () => {
    await reset({ front_recovery_pool_threshold_tuning_enabled: "true" });
    setSetting("front_recovery_api_pool_backoff_threshold_percent", "70");
    setSetting("front_recovery_api_pool_backoff_clear_percent", "85");
    const tuning = await primeTuningCache();
    assertEq(
      tuning.apiPoolBackoffThresholdPercent,
      70,
      "threshold respects setting",
    );
    assertEq(
      tuning.apiPoolBackoffClearPercent,
      70,
      "clear capped at threshold",
    );
  });

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} test(s)`);
    process.exitCode = 1;
  }
  console.log("\nAll Task #1730 front recovery tuning tests passed.");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {
    // Task #1763: explicitly exit so the imported DB pools / scheduler
    // timers (pulled in via `server/storage`) don't keep the event loop
    // alive past the assertions and burn 180s of CI time before SIGTERM.
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
