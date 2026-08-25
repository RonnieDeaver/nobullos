/* test-registration
{
  "name": "Front historical recovery fatal-error alerts (Task #1282)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1282 regression tests for `frontHistoricalRecoveryFatalAlerts`.
 *
 * Covers the fatal-error-rate watcher that fires a Slack admin
 * notification when the count of NEW fatal jobs in a rolling window
 * crosses the configured threshold. Mirrors the style of
 * `tests/queue-drain-backlog-alerts.test.ts` and
 * `tests/front-recovery-retry-alerts.test.ts`: stubs the dispatcher
 * via `__testHelpers.setDispatcherForTests`, exercises the real
 * settings code path via `storage.setSystemSetting`, and uses
 * `jobsOverride` so the test doesn't depend on persisted recovery
 * state.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkRecentFatalRecoveries,
  isFatalRecoveryJob,
  SETTING_ENABLED,
  SETTING_WINDOW_MINUTES,
  SETTING_THRESHOLD,
  SETTING_COOLDOWN_MINUTES,
} from "../server/services/frontHistoricalRecoveryFatalAlerts";
import type { RecoveryJobState } from "../server/services/frontHistoricalRecovery";

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_WINDOW_MINUTES,
  SETTING_THRESHOLD,
  SETTING_COOLDOWN_MINUTES,
] as const;

const NOW = 1_700_000_000_000;

function makeJob(
  jobId: string,
  overrides: Partial<RecoveryJobState> = {},
): RecoveryJobState {
  return {
    jobId,
    status: "failed",
    statusReason: "fatal_error: boom",
    dryRun: false,
    coverageReport: null,
    windows: [],
    totals: { scanned: 0, ingested: 0, skipped: 0, errors: 0, pages: 0 },
    startedAt: new Date(NOW - 60_000).toISOString(),
    completedAt: new Date(NOW - 30_000).toISOString(),
    error: null,
    requestedCustomWindows: null,
    ...overrides,
  };
}

interface DispatchCall {
  id: string;
  payload: { text: string; preview?: string };
  options: { triggerSource: string; dedupeKey?: string; metadata?: any };
}

function makeDispatcher(result: {
  delivered: boolean;
  status?: string;
  skipReason?: string;
}): { fn: any; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, payload, options });
    return result;
  };
  return { fn, calls };
}

async function resetAll(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
  __testHelpers.resetAlertedCache();
  __testHelpers.setDispatcherForTests(null);
}

async function configure(opts: {
  enabled?: boolean;
  windowMinutes?: number;
  threshold?: number;
  cooldownMinutes?: number;
}): Promise<void> {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_ENABLED,
      opts.enabled ? "true" : "false",
      "system",
    );
  }
  if (opts.windowMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_WINDOW_MINUTES,
      String(opts.windowMinutes),
      "system",
    );
  }
  if (opts.threshold !== undefined) {
    await storage.setSystemSetting(
      SETTING_THRESHOLD,
      String(opts.threshold),
      "system",
    );
  }
  if (opts.cooldownMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_COOLDOWN_MINUTES,
      String(opts.cooldownMinutes),
      "system",
    );
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetAll();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

async function main(): Promise<void> {
  console.log("Front historical recovery fatal-error alerts (Task #1282)");

  // ── isFatalRecoveryJob classifier ────────────────────────────────────
  await step("isFatalRecoveryJob: only failed + fatal_error: counts", async () => {
    assert.equal(
      isFatalRecoveryJob(makeJob("a", { status: "failed", statusReason: "fatal_error: boom" })),
      true,
    );
    // db_pool_contended prefix is fine — the job still hit a fatal_error
    assert.equal(
      isFatalRecoveryJob(
        makeJob("b", {
          status: "failed",
          statusReason: "db_pool_contended:foo | fatal_error: bar",
        }),
      ),
      true,
    );
    // db_pool_saturated is recoverable, not fatal
    assert.equal(
      isFatalRecoveryJob(
        makeJob("c", { status: "failed", statusReason: "db_pool_saturated: oops" }),
      ),
      false,
    );
    // Non-failed statuses never count
    assert.equal(
      isFatalRecoveryJob(makeJob("d", { status: "partial", statusReason: "fatal_error: x" })),
      false,
    );
    assert.equal(
      isFatalRecoveryJob(makeJob("e", { status: "complete", statusReason: null })),
      false,
    );
    // Empty / missing reasons never count
    assert.equal(
      isFatalRecoveryJob(makeJob("f", { status: "failed", statusReason: null })),
      false,
    );
    assert.equal(
      isFatalRecoveryJob(makeJob("g", { status: "failed", statusReason: "some other reason" })),
      false,
    );
  });

  // ── disabled ────────────────────────────────────────────────────────
  await step("skipped_disabled when alert turned off", async () => {
    await configure({ enabled: false });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    const r = await checkRecentFatalRecoveries({
      now: NOW,
      jobsOverride: [
        makeJob("j1"),
        makeJob("j2"),
        makeJob("j3"),
      ],
    });
    assert.equal(r.decision, "skipped_disabled");
    assert.equal(r.alertsSent, 0);
    assert.equal(calls.length, 0);
  });

  // ── below threshold ────────────────────────────────────────────────
  await step("skipped_below_threshold when fewer new fatal jobs than threshold", async () => {
    await configure({ enabled: true, threshold: 3, windowMinutes: 60, cooldownMinutes: 60 });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    const r = await checkRecentFatalRecoveries({
      now: NOW,
      jobsOverride: [makeJob("j1"), makeJob("j2")],
    });
    assert.equal(r.decision, "skipped_below_threshold");
    assert.equal(r.alertsSent, 0);
    assert.equal(r.newFatalCount, 2);
    assert.equal(r.recentFatalCount, 2);
    assert.equal(calls.length, 0);
  });

  // ── outside window ─────────────────────────────────────────────────
  await step("jobs outside the rolling window are excluded", async () => {
    await configure({ enabled: true, threshold: 2, windowMinutes: 10, cooldownMinutes: 60 });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    const recent = makeJob("recent");
    // 30 minutes ago — outside the 10-minute window
    const stale = makeJob("stale", {
      completedAt: new Date(NOW - 30 * 60_000).toISOString(),
      startedAt: new Date(NOW - 31 * 60_000).toISOString(),
    });

    const r = await checkRecentFatalRecoveries({
      now: NOW,
      jobsOverride: [recent, stale],
    });
    assert.equal(r.recentFatalCount, 1);
    assert.equal(r.newFatalCount, 1);
    assert.equal(r.decision, "skipped_below_threshold");
    assert.equal(calls.length, 0);
  });

  // ── alerted, then dedupe ──────────────────────────────────────────
  await step("alerted when threshold crossed, then skipped_no_new_jobs on re-eval", async () => {
    await configure({ enabled: true, threshold: 2, windowMinutes: 60, cooldownMinutes: 60 });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    const jobs = [
      makeJob("j1"),
      makeJob("j2"),
      makeJob("j3", { status: "complete", statusReason: null }), // not fatal
      makeJob("j4", { status: "failed", statusReason: "db_pool_saturated: x" }), // excluded
    ];

    const first = await checkRecentFatalRecoveries({ now: NOW, jobsOverride: jobs });
    assert.equal(first.decision, "alerted");
    assert.equal(first.alertsSent, 1);
    assert.equal(first.newFatalCount, 2);
    assert.equal(first.recentFatalCount, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "integration.front.historical_recovery_fatal_errors");
    assert.equal(calls[0].options.triggerSource, "alert_service");
    assert.deepEqual(
      (calls[0].options.metadata?.newFatalJobIds ?? []).slice().sort(),
      ["j1", "j2"],
    );

    // Re-evaluate with the same jobs — both are already in the alerted set.
    const second = await checkRecentFatalRecoveries({ now: NOW + 1_000, jobsOverride: jobs });
    assert.equal(second.decision, "skipped_no_new_jobs");
    assert.equal(second.alertsSent, 0);
    assert.equal(second.recentFatalCount, 2);
    assert.equal(second.newFatalCount, 0);
    assert.equal(calls.length, 1, "dispatcher must not be called twice for the same jobs");
  });

  // ── lineage dedupe ────────────────────────────────────────────────
  await step("auto-continue lineage retries don't re-alert within cooldown", async () => {
    await configure({ enabled: true, threshold: 2, windowMinutes: 60, cooldownMinutes: 60 });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    // First sweep: two fatal jobs in lineage L1.
    const wave1 = [
      makeJob("L1-a", { autoContinueLineageRootJobId: "L1" }),
      makeJob("L1-b", { autoContinueLineageRootJobId: "L1" }),
    ];
    const r1 = await checkRecentFatalRecoveries({ now: NOW, jobsOverride: wave1 });
    assert.equal(r1.decision, "alerted");
    assert.equal(calls.length, 1);

    // Later sweep: a brand-new fatal in the SAME lineage. Within the
    // cooldown, this must be suppressed without re-alerting.
    const wave2 = [
      ...wave1,
      makeJob("L1-c", { autoContinueLineageRootJobId: "L1" }),
      makeJob("L1-d", { autoContinueLineageRootJobId: "L1" }),
    ];
    const r2 = await checkRecentFatalRecoveries({
      now: NOW + 10 * 60_000, // 10 min later, well within 60 min cooldown
      jobsOverride: wave2,
    });
    assert.equal(r2.decision, "skipped_cooldown");
    assert.equal(r2.alertsSent, 0);
    assert.equal(calls.length, 1, "lineage cooldown must suppress repeat alerts");

    // A NEW lineage joining the new jobs bypasses the cooldown.
    const wave3 = [
      ...wave2,
      makeJob("L2-a", { autoContinueLineageRootJobId: "L2" }),
      makeJob("L2-b", { autoContinueLineageRootJobId: "L2" }),
    ];
    const r3 = await checkRecentFatalRecoveries({
      now: NOW + 11 * 60_000,
      jobsOverride: wave3,
    });
    assert.equal(r3.decision, "alerted");
    assert.equal(r3.alertsSent, 1);
    assert.equal(calls.length, 2, "new lineage must bypass the cooldown");
    // The cooldown-suppressed L1-c/L1-d and the new L2-* should all be
    // included in this alert.
    const ids = (calls[1].options.metadata?.newFatalJobIds ?? []) as string[];
    assert.deepEqual(
      ids.slice().sort(),
      ["L1-c", "L1-d", "L2-a", "L2-b"],
    );
  });

  // ── dispatcher reports not delivered ───────────────────────────────
  await step("skipped_dispatcher_skipped when dispatcher reports not delivered", async () => {
    await configure({ enabled: true, threshold: 2, windowMinutes: 60, cooldownMinutes: 60 });
    const { fn, calls } = makeDispatcher({
      delivered: false,
      status: "skipped_disabled",
      skipReason: "channel disabled",
    });
    __testHelpers.setDispatcherForTests(fn);

    const jobs = [makeJob("j1"), makeJob("j2")];
    const r = await checkRecentFatalRecoveries({ now: NOW, jobsOverride: jobs });
    assert.equal(r.decision, "skipped_dispatcher_skipped");
    assert.equal(r.alertsSent, 0);
    assert.equal(r.skipReason, "channel disabled");
    assert.equal(calls.length, 1);

    // Because the alert wasn't delivered, the jobs were NOT marked
    // alerted. A retry with a working dispatcher should fire.
    __testHelpers.setDispatcherForTests(null);
    const ok = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(ok.fn);
    const retry = await checkRecentFatalRecoveries({
      now: NOW + 1_000,
      jobsOverride: jobs,
    });
    assert.equal(retry.decision, "alerted");
    assert.equal(retry.alertsSent, 1);
    assert.equal(ok.calls.length, 1);
  });

  // ── dispatcher dedupe is honoured ──────────────────────────────────
  await step("dispatcher-side dedupe marks jobs alerted so we don't retry", async () => {
    await configure({ enabled: true, threshold: 2, windowMinutes: 60, cooldownMinutes: 60 });
    const { fn, calls } = makeDispatcher({
      delivered: false,
      status: "skipped_deduped",
      skipReason: "dispatcher dedupe",
    });
    __testHelpers.setDispatcherForTests(fn);

    const jobs = [makeJob("j1"), makeJob("j2")];
    const first = await checkRecentFatalRecoveries({ now: NOW, jobsOverride: jobs });
    assert.equal(first.decision, "skipped_dispatcher_skipped");
    assert.equal(calls.length, 1);

    // The dispatcher-side dedupe pathway treats the jobs as alerted,
    // so a re-evaluation should NOT call the dispatcher again.
    const second = await checkRecentFatalRecoveries({
      now: NOW + 1_000,
      jobsOverride: jobs,
    });
    assert.equal(second.decision, "skipped_no_new_jobs");
    assert.equal(calls.length, 1);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nAll Front historical recovery fatal-error alert tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner crashed:", err);
    process.exitCode = 1;
  });
