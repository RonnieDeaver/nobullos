/* test-registration
{
  "name": "Work-queue kill-switch abort + sub-attribution (Task #988)",
  "tier": "small"
}
test-registration */
/**
 * Task #988 Phase 7: regression coverage for the two work-queue
 * surfaces not yet covered by `work-queue-scheduler.test.ts` or
 * `workload-backoff-killswitch.test.ts`:
 *
 *   1. The kill-switch abort path — handlers must short-circuit with
 *      a deterministic `kill_switch:<name>:aborted` cursor when the
 *      operator-toggleable kill switch is on, and run normally when
 *      it is off. This exercises the same contract used by the four
 *      production handlers (retroactive_reprocess,
 *      front_sync_reprocess, semrush_background_refresh).
 *
 *   2. Sub-attribution label propagation — `withDbHoldLabel` /
 *      `withDbAttribution` must surface the current label inside the
 *      callback (so the pool wrapper records DB checkouts under the
 *      right key) and nested substep labels must override the outer
 *      one inside their own scope without leaking back out.
 */
import assert from "node:assert/strict";
import {
  withDbHoldLabel,
  withDbAttribution,
  getCurrentDbHoldLabel,
  setCurrentDbHoldLabel,
} from "../server/db";
import {
  ensureKillSwitchesLoaded,
  isKillSwitchEnabled,
  setKillSwitch,
} from "../server/services/killSwitches";
import { storage } from "../server/storage";
import { getRegisteredHandler } from "../server/services/workScheduler";
import { registerAllHandlers } from "../server/services/workQueueHandlers";
import type { WorkQueueJob } from "@shared/schema";

function makeMockJob(
  queueName: string,
  payload: Record<string, unknown>,
): WorkQueueJob {
  // The production handlers we exercise (`retroactive_reprocess`) only
  // read `payload` and `id`. The rest of the WorkQueueJob shape is
  // filled with safe defaults so we don't have to insert a row to
  // exercise the in-process abort guard.
  const now = new Date();
  const job: WorkQueueJob = {
    id: `t988_mock_${process.pid}_${Date.now()}`,
    queueName,
    jobType: queueName,
    workloadClass: "maintenance",
    priority: 100,
    status: "pending",
    payload,
    payloadJson: null,
    dedupeKey: null,
    cursor: null,
    cursorJson: null,
    attemptCount: 0,
    maxAttempts: 1,
    retryAt: null,
    leasedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  return job;
}

async function run(): Promise<void> {
  await ensureKillSwitchesLoaded();

  // Register the real production handlers so `getRegisteredHandler`
  // returns the same closures the live scheduler dispatches to. This
  // is the test-seam path (#988 Phase 7): we call the actual handler
  // function rather than a synthetic mirror, so a regression in the
  // production guard (deleted check, changed cursor format, swapped
  // switch name) fails this test.
  registerAllHandlers();

  // ── 1. Kill-switch abort path on the REAL production handler ────
  // We use `retroactive_reprocess` because its OFF path throws a
  // deterministic, side-effect-free error when `clientId` is absent
  // (`retroactive_reprocess job requires clientId in payload`). That
  // gives us a clean way to confirm the OFF path actually executes
  // past the kill-switch guard without doing any real DB writes.
  const switchName = "retroactive_reprocess" as const;
  const handler = getRegisteredHandler("retroactive_reprocess");
  assert.ok(
    handler,
    "registerAllHandlers must register the retroactive_reprocess handler",
  );

  // Make sure we start from a clean state — a previous test run that
  // crashed before reset could have left the override set.
  await setKillSwitch(switchName, false, "system");
  await storage.setSystemSetting(`kill_switch_${switchName}`, "false", "system");
  assert.equal(isKillSwitchEnabled(switchName), false, "switch must start OFF");

  // OFF path: invoking the real handler must NOT short-circuit. The
  // payload deliberately omits clientId so the handler throws after
  // it has cleared the kill-switch + backoff guards, proving control
  // actually reached the real work body. (If the kill switch had
  // fired, we would get the abort cursor, not the throw.)
  const offJob = makeMockJob("retroactive_reprocess", {});
  let offError: Error | null = null;
  let offCursor: { cursor?: string } | void = undefined;
  try {
    offCursor = await handler!(offJob);
  } catch (err) {
    offError = err as Error;
  }
  assert.ok(
    offError,
    `OFF path must reach the real handler body (and throw on missing clientId), got cursor=${JSON.stringify(offCursor)}`,
  );
  assert.match(
    offError!.message,
    /clientId/,
    `OFF path must throw on missing clientId, got: ${offError!.message}`,
  );

  // ON path: flip the kill switch and confirm the real handler
  // short-circuits with the operator-facing
  // `kill_switch:<name>:aborted` cursor before any real work runs.
  // Operators grep on this exact string in `work_queue.cursor` to
  // confirm an abort happened at a safe boundary — a regression to
  // the format would silently break dashboards.
  await setKillSwitch(switchName, true, "system");
  assert.equal(
    isKillSwitchEnabled(switchName),
    true,
    "setKillSwitch must take effect for the next sync read",
  );

  const onJob = makeMockJob("retroactive_reprocess", {});
  const onResult = await handler!(onJob);
  assert.ok(onResult, "ON path must return a cursor object, not throw");
  assert.equal(
    (onResult as { cursor?: string })?.cursor,
    `kill_switch:${switchName}:aborted`,
    "abort cursor format is the operator-facing contract",
  );

  // Reset so subsequent tests in the shared suite are not poisoned.
  await setKillSwitch(switchName, false, "system");
  await storage.setSystemSetting(`kill_switch_${switchName}`, "false", "system");
  assert.equal(isKillSwitchEnabled(switchName), false, "reset must clear the override");

  // ── 2. Sub-attribution label propagation ─────────────────────────
  // Outside any scope the label is the literal "unknown" sentinel —
  // this is the value the InstrumentedPool records when a DB
  // checkout has no `withDbAttribution` ancestor, and is what the
  // Task #897 work was trying to drive to zero on the worker pool.
  assert.equal(
    getCurrentDbHoldLabel(),
    "unknown",
    "outside any scope the label must be the 'unknown' sentinel",
  );

  // Outer scope: this is exactly the wrapper `processJob` installs in
  // workScheduler.ts (`worker:${job.queueName}`). Anything the
  // handler does without its own wrapper inherits this label, which
  // was the whole point of Phase 4.
  await withDbHoldLabel("worker:test_queue", async () => {
    assert.equal(
      getCurrentDbHoldLabel(),
      "worker:test_queue",
      "outer label must be visible inside withDbHoldLabel",
    );

    // Nested substep: this is the pattern handlers use to refine
    // attribution (e.g. `worker:retroactive_reprocess:seed` vs
    // `…:run`). The substep must override the outer label inside its
    // own scope.
    await withDbAttribution("worker:test_queue:substep", async () => {
      assert.equal(
        getCurrentDbHoldLabel(),
        "worker:test_queue:substep",
        "substep label must override the outer label inside its scope",
      );
    });

    // After the substep returns the outer label must be restored —
    // a label leak here would mis-attribute every subsequent DB
    // checkout in the same job.
    assert.equal(
      getCurrentDbHoldLabel(),
      "worker:test_queue",
      "outer label must be restored after the nested substep returns",
    );

    // setCurrentDbHoldLabel mutates the live ref (used by the API
    // request middleware after route matching). The mutation must
    // be visible synchronously, but must NOT survive past the outer
    // `withDbHoldLabel` boundary — the next assertion outside this
    // block confirms that.
    setCurrentDbHoldLabel("worker:test_queue:after_route_match");
    assert.equal(
      getCurrentDbHoldLabel(),
      "worker:test_queue:after_route_match",
      "setCurrentDbHoldLabel must mutate the live ref",
    );
  });

  // After the outer scope returns we are back to the sentinel —
  // confirms AsyncLocalStorage isolation works as advertised and a
  // mid-handler `setCurrentDbHoldLabel` does not poison sibling
  // requests on the same event loop.
  assert.equal(
    getCurrentDbHoldLabel(),
    "unknown",
    "label must reset to 'unknown' once the outer scope exits",
  );

  // Concurrent independent scopes must not see each other's labels.
  // This guarantees a slow worker holding `worker:slow` cannot
  // contaminate a fast API request running `api:GET /things` on the
  // same Node thread.
  const observed: string[] = [];
  await Promise.all([
    withDbAttribution("worker:concurrent_a", async () => {
      await new Promise((r) => setTimeout(r, 10));
      observed.push(`a=${getCurrentDbHoldLabel()}`);
    }),
    withDbAttribution("worker:concurrent_b", async () => {
      await new Promise((r) => setTimeout(r, 5));
      observed.push(`b=${getCurrentDbHoldLabel()}`);
    }),
  ]);
  assert.ok(
    observed.includes("a=worker:concurrent_a"),
    `scope A must see its own label (got ${observed.join(",")})`,
  );
  assert.ok(
    observed.includes("b=worker:concurrent_b"),
    `scope B must see its own label (got ${observed.join(",")})`,
  );

  console.log("work-queue-kill-switch-attribution.test.ts: OK");
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once run() settles — no manual process.exit() (Task #2084).
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
