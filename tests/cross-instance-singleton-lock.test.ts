/* test-registration
{
  "name": "Cross-instance singleton lock + hung-holder watchdog (Task #2363 / #2383)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2363 — cross-instance singleton lock primitive.
 *
 * `server/services/crossInstanceLock.ts` generalizes the Task #2293
 * prod-action drain advisory lock so run-once workers/schedulers (Google
 * Drive crawl, Local Dominance sync, SEMrush inventory sweep, daily-judgment
 * cron, import-ghosts cron) become cluster-wide singletons on the
 * `autoscale` deploy target. The deploy starts these jobs on EVERY instance,
 * so an in-process flag alone lets them run once PER instance.
 *
 * This test runs in ONE process, so to simulate "two instances" it takes the
 * advisory lock TWICE against the shared dev Postgres: the first call models
 * instance A holding the lock, the second models instance B pressing while A
 * holds it. Because both calls open SEPARATE worker-pool sessions, the second
 * `pg_try_advisory_lock` must fail (return null) exactly as it would across
 * two real instances. We assert:
 *   1. holder wins, contender (same name) loses,
 *   2. releasing the holder lets a later acquire win (self-healing release),
 *   3. a DIFFERENT name does not conflict (per-job isolation),
 *   4. the worker-singleton namespace does not collide with the prod-action
 *      drain namespace for the same name string,
 *   5. `withWorkerSingletonLock` runs `fn` for the winner and skips it
 *      (ran:false) for a contender while the lock is held.
 */
import assert from "node:assert/strict";

import {
  acquireWorkerSingletonLock,
  acquireProdActionDrainLock,
  withWorkerSingletonLock,
  crossInstanceLockKey,
  WORKER_SINGLETON_LOCK_NAMESPACE,
  PROD_ACTION_DRAIN_LOCK_NAMESPACE,
  type CrossInstanceLockWatchdogInfo,
} from "../server/services/crossInstanceLock";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

// Unique per-run names so concurrent dev work / re-runs never collide on the
// shared dev Postgres advisory-lock space.
const SUFFIX = `${process.pid}-${Date.now()}`;
const NAME_A = `test:singleton:a:${SUFFIX}`;
const NAME_B = `test:singleton:b:${SUFFIX}`;

async function testHolderWinsContenderLoses(): Promise<void> {
  const holder = await acquireWorkerSingletonLock(NAME_A);
  assert(holder, "holder must win the singleton lock");

  const contender = await acquireWorkerSingletonLock(NAME_A);
  assert.equal(contender, null, "a second instance must lose while the lock is held");

  await holder!.release();

  const afterRelease = await acquireWorkerSingletonLock(NAME_A);
  assert(afterRelease, "after release a later acquire must win (self-healing)");
  await afterRelease!.release();
  ok("holder wins, contender loses, release frees the lock");
}

async function testDifferentNamesDoNotConflict(): Promise<void> {
  const a = await acquireWorkerSingletonLock(NAME_A);
  const b = await acquireWorkerSingletonLock(NAME_B);
  assert(a, "name A must acquire");
  assert(b, "name B must acquire independently of A");
  await a!.release();
  await b!.release();
  ok("two different job names hold their locks independently");
}

async function testNamespaceIsolation(): Promise<void> {
  // Same name string, different namespace → must NOT collide. This proves a
  // run-once worker can never accidentally block a prod-action drain (or vice
  // versa) just because their names happen to hash equal.
  const shared = `shared-name:${SUFFIX}`;
  assert.equal(
    crossInstanceLockKey(shared),
    crossInstanceLockKey(shared),
    "key hash must be deterministic",
  );
  assert.notEqual(
    WORKER_SINGLETON_LOCK_NAMESPACE,
    PROD_ACTION_DRAIN_LOCK_NAMESPACE,
    "the two namespaces must differ",
  );

  const singleton = await acquireWorkerSingletonLock(shared);
  assert(singleton, "singleton lock must win");
  const drain = await acquireProdActionDrainLock(shared);
  assert(drain, "drain lock with the same name must win — different namespace");
  await singleton!.release();
  await drain!.release();
  ok("worker-singleton and prod-action-drain namespaces do not collide");
}

async function testWithWorkerSingletonLock(): Promise<void> {
  // Hold the lock manually to simulate instance A, then prove the wrapper
  // skips `fn` for instance B and reports ran:false.
  const holder = await acquireWorkerSingletonLock(NAME_A);
  assert(holder, "setup — holder must win");

  let bRan = false;
  const contended = await withWorkerSingletonLock(NAME_A, async () => {
    bRan = true;
    return "should-not-run";
  });
  assert.equal(contended.ran, false, "contender wrapper must report ran:false");
  assert.equal(bRan, false, "contender fn must NOT execute while the lock is held");
  assert.equal(contended.result, undefined, "contender must return no result");

  await holder!.release();

  let winnerRan = false;
  const winner = await withWorkerSingletonLock(NAME_A, async () => {
    winnerRan = true;
    return 42;
  });
  assert.equal(winner.ran, true, "after release the wrapper must run fn");
  assert.equal(winnerRan, true, "winner fn must execute");
  assert.equal(winner.result, 42, "winner must return fn's result");
  ok("withWorkerSingletonLock runs fn for the winner, skips it for a contender");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testWatchdogForceReleasesHungHolder(): Promise<void> {
  // Task #2383 — the cluster-wide lock self-heals on CRASH (Postgres drops
  // the session) but NOT on a HANG: a job that never returns keeps the lock
  // forever and no other instance can take over. The bounded max-hold
  // watchdog must force-release the advisory lock after `maxHoldMs` so a
  // contender can win even though the original holder NEVER called release().
  let fired: CrossInstanceLockWatchdogInfo | null = null;
  const holder = await acquireWorkerSingletonLock(NAME_A, "[worker-singleton]", {
    maxHoldMs: 150,
    onWatchdog: (info) => {
      fired = info;
    },
  });
  assert(holder, "holder must win the singleton lock");

  // Simulate a hung holder: it NEVER calls release(). A contender pressing
  // immediately must still lose while the lock is genuinely held.
  const earlyContender = await acquireWorkerSingletonLock(NAME_A);
  assert.equal(
    earlyContender,
    null,
    "a contender must lose while the holder still legitimately holds the lock",
  );

  // Wait past the watchdog ceiling. The watchdog must fire and force-release.
  await sleep(450);

  assert(fired, "watchdog must have fired after the ceiling elapsed");
  const info = fired as unknown as CrossInstanceLockWatchdogInfo;
  assert.equal(info.name, NAME_A, "watchdog info must carry the lock name");
  assert.equal(info.maxHoldMs, 150, "watchdog info must carry the configured ceiling");
  // Node timers can fire a hair early (timer rounding), so allow a small
  // tolerance below the ceiling rather than asserting an exact floor.
  assert(info.heldMs >= 130, "watchdog heldMs must be roughly the ceiling");

  // Now a contender can take over even though the hung holder never released.
  const takeover = await acquireWorkerSingletonLock(NAME_A);
  assert(takeover, "after the watchdog force-release another instance must win");
  await takeover!.release();

  // The hung holder's eventual release() must be an idempotent no-op (it must
  // not blow up nor double-release the already-recycled connection).
  await holder!.release();
  ok("watchdog force-releases a hung holder so a contender can take over");
}

async function testWatchdogDoesNotFireOnNormalRelease(): Promise<void> {
  // A run that finishes well within its ceiling must NOT trip the watchdog —
  // interrupting a healthy long run would let a second instance start a
  // duplicate run, defeating the singleton.
  let fired = false;
  const holder = await acquireWorkerSingletonLock(NAME_B, "[worker-singleton]", {
    maxHoldMs: 10_000,
    onWatchdog: () => {
      fired = true;
    },
  });
  assert(holder, "holder must win the singleton lock");
  await holder!.release();
  await sleep(100);
  assert.equal(fired, false, "watchdog must NOT fire when release() happens before the ceiling");

  // The cleared watchdog must not fire later either.
  await sleep(200);
  assert.equal(fired, false, "a released lock's watchdog timer must stay cleared");
  ok("watchdog never fires when the lock is released before its ceiling");
}

async function main(): Promise<void> {
  await testHolderWinsContenderLoses();
  await testDifferentNamesDoNotConflict();
  await testNamespaceIsolation();
  await testWithWorkerSingletonLock();
  await testWatchdogForceReleasesHungHolder();
  await testWatchdogDoesNotFireOnNormalRelease();
  console.log(`\ncross-instance-singleton-lock: ${passed} assertions passed`);
}

main().then(
  () => {
    console.log("cross-instance-singleton-lock: all checks verified");
  },
  (err) => {
    console.error("cross-instance-singleton-lock: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
