/* test-registration
{
  "name": "App backup scheduler — async cron stop() rejection is logged, never unhandled (Task #3821)",
  "regression": true,
  "smoke": false,
  "sweepOnlyReason": "Narrow lifecycle-edge coverage: proves a REJECTING node-cron v4 stop() in the app-backup scheduler is caught and logged instead of leaking an unhandled rejection. The invariant only breaks if someone edits the two stop() call sites in appBackupScheduler.ts; the nightly regression sweep is sufficient — it does not guard a merge-frequency regression class worth smoke-gate time.",
  "tier": "small"
}
test-registration */
/**
 * Task #3821 — node-cron v4 made `ScheduledTask.stop()` async, and its
 * declared type (`void | Promise<void>`) allows an implementation that
 * REJECTS (e.g. a background teardown timeout). Both lifecycle paths in
 * `server/services/appBackupScheduler.ts` fire stop() without awaiting it
 * (nothing awaits scheduler teardown), so a rejection there must be caught
 * and logged — never surface as an unhandled promise rejection during a
 * restart/shutdown.
 *
 * Pure, in-memory test: a fake cron is injected via the `__test_setCron`
 * seam whose task's `stop()` always rejects. No real cron timer is created
 * (the fake `schedule` never runs the callback), no DB, no network.
 * `REPLIT_DEPLOYMENT` is pinned to "1" for the duration (the scheduler
 * refuses to schedule outside the deployment) and restored in `finally`.
 */
import assert from "node:assert/strict";
import cron from "node-cron";

import {
  __test_setCron,
  startAppBackupScheduler,
  stopAppBackupScheduler,
} from "../server/services/appBackupScheduler";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function settle(): Promise<void> {
  // Let the stop() rejection + .catch handler run (a macrotask is enough).
  await new Promise((r) => setTimeout(r, 10));
}

async function main(): Promise<void> {
  const priorDeployment = process.env.REPLIT_DEPLOYMENT;
  const priorError = console.error;

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const errorLogs: string[] = [];
  let stopCalls = 0;

  const fakeTask = {
    stop: () => {
      stopCalls++;
      return Promise.reject(new Error("simulated teardown timeout"));
    },
  } as unknown as ReturnType<typeof cron.schedule>;

  const fakeCron: Pick<typeof cron, "schedule"> = {
    // Never invokes the callback — no backup body runs in this test.
    schedule: () => fakeTask,
  };

  try {
    process.env.REPLIT_DEPLOYMENT = "1";
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map(String).join(" "));
    };
    __test_setCron(fakeCron);

    // First start: schedules the fake task (no stop yet).
    startAppBackupScheduler();
    assert.equal(stopCalls, 0);

    // Re-start: the restart path stops the previous task; its rejection must
    // be caught + logged.
    startAppBackupScheduler();
    await settle();
    assert.equal(stopCalls, 1);
    assert.ok(
      errorLogs.some((l) => l.includes("[AppBackupScheduler] cron task stop() failed:")),
      `restart path logged the stop() rejection (got: ${JSON.stringify(errorLogs)})`,
    );
    ok("restart path catches + logs a rejecting cron stop()");

    // Explicit shutdown: same contract on stopAppBackupScheduler().
    errorLogs.length = 0;
    stopAppBackupScheduler();
    await settle();
    assert.equal(stopCalls, 2);
    assert.ok(
      errorLogs.some((l) => l.includes("[AppBackupScheduler] cron task stop() failed:")),
      `shutdown path logged the stop() rejection (got: ${JSON.stringify(errorLogs)})`,
    );
    ok("shutdown path catches + logs a rejecting cron stop()");

    // Neither path leaked an unhandled rejection.
    await settle();
    assert.deepEqual(unhandled, [], "no unhandled promise rejections leaked");
    ok("no unhandled rejection escaped either lifecycle path");
  } finally {
    // Restore module + process state (stopAppBackupScheduler already nulled
    // the task; a second call is a no-op).
    stopAppBackupScheduler();
    __test_setCron(null);
    console.error = priorError;
    process.removeListener("unhandledRejection", onUnhandled);
    if (priorDeployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
    else process.env.REPLIT_DEPLOYMENT = priorDeployment;
  }

  console.log(`App backup scheduler stop-rejection: ${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
  });
