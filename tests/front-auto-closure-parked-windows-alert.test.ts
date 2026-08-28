/* test-registration
{
  "name": "Front auto closure parked windows alert (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #1904 — Parked recovery windows surface in the daily auto-closure
 * regression digest.
 *
 * Locks in:
 *   1. Newly parked window → fires regardless of reminder cooldown,
 *      payload lists the newly-parked + still-parked months and the
 *      un-park instructions.
 *   2. Same parked set within the reminder window is deduped.
 *   3. Adding a second parked month while inside the reminder window
 *      always re-fires (newly parked since last digest).
 *   4. Empty parked set clears the dedupe so the next parking re-fires
 *      immediately.
 *   5. Kill switch (front_auto_closure_alert_parked_enabled=false)
 *      suppresses the digest entirely.
 *
 * Lives in its own file so it isn't blocked by unrelated pre-existing
 * flake in tests/front-auto-closure-regression-alerts.test.ts (which
 * shares dev-DB state with several background workers).
 */
import assert from "node:assert/strict";
import { type ParkedWindowEntry } from "../server/services/frontAutoClosure";
import { setQueuePause } from "../server/services/queueDrainControl";
import {
  __frontAutoClosureRegressionAlertsTestHelpers as helpers,
  runFrontAutoClosureRegressionAlertCheck,
} from "../server/services/frontAutoClosureRegressionAlerts";

const FUTURE_YEAR = 2999;
// Config + state + snapshot are all overridden in-memory so no
// system_settings keys need a backup/restore for this test.

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function makeDispatcher(): { fn: any; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return { delivered: true, status: "success" };
  };
  return { fn, calls };
}

function setSnapshot(opts: {
  ranAt: string;
  parkedWindows: Record<string, ParkedWindowEntry>;
}): void {
  helpers.setSnapshotOverrideForTests({
    lastSummary: {
      ranAt: opts.ranAt,
      enabled: true,
      monthsInspected: 0,
      errorsRetried: 0,
      errorRetrySuccesses: 0,
      ingestRecoveriesEnqueued: 0,
      applyNudgesEnqueued: 0,
      recoveryDailyCounter: 0,
      skips: {
        unrecoverable: 0,
        cooldown: 0,
        budget: 0,
        in_flight: 0,
        threshold: 0,
        queue_paused: 0,
        auth_failed: 0,
        no_work_items: 0,
        parked: 0,
      },
      errorsByReason: {},
      lastSelfError: null,
      monthsActed: [],
      mode: "daytime" as const,
      effectiveBudgets: { retry: 0, ingestRecovery: 0, applyNudge: 0 },
    } as any,
    cooldowns: {},
    lastOvernightRanAt: null,
    parkedWindows: opts.parkedWindows,
  });
}

function clearState(): void {
  helpers.setStateOverrideForTests(helpers.emptyStateForTests());
}

// Snapshot + state are both injected via in-memory overrides so this
// test is fully insulated from any background worker that runs the same
// alerter on the shared dev DB. The queue pause is belt-and-suspenders.
const PAUSE_ACTOR = "test:front-auto-closure-parked-windows-alert";
let _unpaused = false;
async function unpauseQueue(): Promise<void> {
  if (_unpaused) return;
  _unpaused = true;
  try {
    await setQueuePause("front_analytics_coverage_refresh", false, PAUSE_ACTOR);
  } catch {}
}
// Crash handler must exit explicitly — natural drain (Task #2084) only covers the happy path.
process.once("uncaughtException", async (err) => {
  helpers.setStateOverrideForTests(null);
  helpers.setSnapshotOverrideForTests(null);
  await unpauseQueue();
  console.error(err);
  process.exit(1);
});
await setQueuePause("front_analytics_coverage_refresh", true, PAUSE_ACTOR);

// Seed in-memory state + config so the alerter is fully insulated from
// system_settings — neither the live worker tick nor a concurrent
// A concurrent validation invocation can stomp our scenario by restoring a prior
// SETTING_PARKED_ENABLED value mid-flight.
helpers.setStateOverrideForTests(helpers.emptyStateForTests());
const baseCfg = {
  enabled: true,
  gapGrowthTicks: 3,
  silentMinutes: 60,
  sameGateSkipTicks: 3,
  noConvergenceRuns: 3,
  unrecoveredRetryAttempts: 3,
  selfErrorTicks: 3,
  overnightWindowHours: 8,
  overnightEnabled: false,
  parkedEnabled: true,
  parkedReminderHours: 24,
};
helpers.setConfigOverrideForTests(baseCfg);

try {
  {
    const T0 = Date.UTC(FUTURE_YEAR, 8, 1, 12, 0, 0);
    const TICK_MS = 30 * 60_000;
    const monthA = `${FUTURE_YEAR}-01`;
    const monthB = `${FUTURE_YEAR}-02`;
    const entryA: ParkedWindowEntry = {
      parkedAt: new Date(T0).toISOString(),
      reason: "dead_run_streak:3_runs_safety_max_pages_reached",
      deadRuns: 3,
      lastCheckpointAt: new Date(T0 - 60_000).toISOString(),
    };

    // ── 1. Baseline tick with empty parked set seeds state. ─────────
    clearState();
    await setSnapshot({ ranAt: new Date(T0).toISOString(), parkedWindows: {} });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      const r = await runFrontAutoClosureRegressionAlertCheck(T0 + 1);
      assert.equal(r.decision, "skipped_baseline_seeded");
      assert.equal(
        d.calls.filter((c) => c.text.includes("windows_parked")).length,
        0,
        "baseline tick does not fire windows_parked",
      );
    }

    // ── 2. Month A becomes parked → fires with newly + still + un-park lines.
    await setSnapshot({
      ranAt: new Date(T0 + TICK_MS).toISOString(),
      parkedWindows: { [monthA]: entryA },
    });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      const r = await runFrontAutoClosureRegressionAlertCheck(
        T0 + TICK_MS + 1,
      );
      const fire = r.fired.find((f) => f.condition === "windows_parked");
      assert.ok(fire, "windows_parked fires when a new month is parked");
      const call = d.calls.find((c) => c.text.includes("windows_parked"));
      assert.ok(call, "dispatcher received parked-window digest");
      assert.match(call!.text, new RegExp(`Newly parked.*${monthA}`));
      assert.match(call!.text, new RegExp(`Still parked.*${monthA}`));
      assert.match(call!.text, /unpark/i);
      assert.match(call!.text, /dead run/);
    }

    // ── 3. Same parked set within reminder window → deduped. ────────
    await setSnapshot({
      ranAt: new Date(T0 + 2 * TICK_MS).toISOString(),
      parkedWindows: { [monthA]: entryA },
    });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      await runFrontAutoClosureRegressionAlertCheck(T0 + 2 * TICK_MS + 1);
      assert.equal(
        d.calls.filter((c) => c.text.includes("windows_parked")).length,
        0,
        "same parked set within reminder window is deduped",
      );
    }

    // ── 4. Adding month B → newly parked, re-fires inside cooldown. ─
    const entryB: ParkedWindowEntry = {
      ...entryA,
      parkedAt: new Date(T0 + 3 * TICK_MS).toISOString(),
    };
    await setSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
      parkedWindows: { [monthA]: entryA, [monthB]: entryB },
    });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      await runFrontAutoClosureRegressionAlertCheck(T0 + 3 * TICK_MS + 1);
      const call = d.calls.find((c) => c.text.includes("windows_parked"));
      assert.ok(call, "newly parked month re-fires within reminder window");
      assert.match(call!.text, new RegExp(`Newly parked.*${monthB}`));
      assert.match(call!.text, new RegExp(`Still parked.*${monthA}.*${monthB}`));
    }

    // ── 5. Empty parked set → no fire, dedupe cleared. ──────────────
    await setSnapshot({
      ranAt: new Date(T0 + 4 * TICK_MS).toISOString(),
      parkedWindows: {},
    });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      await runFrontAutoClosureRegressionAlertCheck(T0 + 4 * TICK_MS + 1);
      assert.equal(
        d.calls.filter((c) => c.text.includes("windows_parked")).length,
        0,
        "empty parked set produces no parked-window digest",
      );
    }

    // ── 6. Month A parks again → must re-fire (dedupe was cleared). ─
    await setSnapshot({
      ranAt: new Date(T0 + 5 * TICK_MS).toISOString(),
      parkedWindows: { [monthA]: entryA },
    });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      await runFrontAutoClosureRegressionAlertCheck(T0 + 5 * TICK_MS + 1);
      assert.ok(
        d.calls.some((c) => c.text.includes("windows_parked")),
        "re-parking after a clear period fires again",
      );
    }

    // ── 7. Kill switch off → suppresses digest entirely. ────────────
    helpers.setConfigOverrideForTests({ ...baseCfg, parkedEnabled: false });
    clearState();
    await setSnapshot({
      ranAt: new Date(T0 + 6 * TICK_MS).toISOString(),
      parkedWindows: { [monthA]: entryA },
    });
    {
      const d = makeDispatcher();
      helpers.setDispatcherForTests(d.fn);
      // First tick is baseline; second proves the kill switch.
      await runFrontAutoClosureRegressionAlertCheck(T0 + 6 * TICK_MS + 1);
      await setSnapshot({
        ranAt: new Date(T0 + 7 * TICK_MS).toISOString(),
        parkedWindows: { [monthA]: entryA },
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + 7 * TICK_MS + 1);
      assert.equal(
        d.calls.filter((c) => c.text.includes("windows_parked")).length,
        0,
        "kill switch suppresses parked-window digest",
      );
    }

    helpers.setDispatcherForTests(null);
    helpers.setSnapshotOverrideForTests(null);
    helpers.setConfigOverrideForTests(null);
    clearState();
  }
} finally {
  helpers.setSnapshotOverrideForTests(null);
  helpers.setConfigOverrideForTests(null);
  helpers.setStateOverrideForTests(null);
  await unpauseQueue();
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("✓ front-auto-closure-parked-windows-alert tests passed");
