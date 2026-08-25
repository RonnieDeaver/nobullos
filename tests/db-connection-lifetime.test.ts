/* test-registration
{
  "name": "DB connection max-lifetime recycle (Task #815/#1256)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1256 — Regression coverage for the Task #815 connection
 * max-lifetime policy.
 *
 * The policy lives in `installConnectionLifetime` and the
 * `InstrumentedPool.wrapHoldOnce` release path in `server/db.ts`. It
 * has two enforcement points:
 *
 *   (a) On release: a client that has lived past its max lifetime is
 *       returned to pg-pool via `release(err)` so pg-pool destroys it
 *       instead of returning it to the idle list.
 *   (b) Periodic sweep: idle clients past their max lifetime are removed
 *       through pg-pool's internal `_remove` before the host kills
 *       them.
 *
 * Both paths depend on pg-pool internals (`_idle`, `_remove`) and on
 * the per-pool `connect` event firing for new clients. If pg-pool ever
 * changes those internals — or if a future refactor drops the
 * lifetime install on one of the pools — these tests fail loudly.
 */
import assert from "node:assert";
import { Pool, PoolClient } from "pg";
import {
  __installConnectionLifetimeForTest,
  __makeInstrumentedPoolForTest,
  getConnectionRecycleCount,
} from "../server/db";

// `processID` is exposed by node-postgres on a connected client but is
// not part of the public `PoolClient` type. Narrow once here so the
// test can read it without scattering casts.
type PgClientWithPid = PoolClient & { processID: number };
const pidOf = (c: PoolClient): number => (c as PgClientWithPid).processID;

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run this test");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run() {
  let passed = 0;
  let failed = 0;

  // ─── Test 1: release-time recycle ────────────────────────────────
  // Pool with min=0/max=1, lifetime 200ms. Sweep interval is set very
  // high (60s) so the sweep cannot run inside the test — we are
  // strictly exercising the release-time recycle path inside
  // `InstrumentedPool.wrapHoldOnce`. After holding a client past the
  // lifetime and releasing, the next acquire must hand back a *fresh*
  // client (different reference, different processID).
  console.log("\n[Test 1] Release-time recycle when client is expired at release");
  const releasePool = __makeInstrumentedPoolForTest(
    {
      connectionString: process.env.DATABASE_URL,
      min: 0,
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    },
    "test-release",
  );
  const releaseHandle = __installConnectionLifetimeForTest(releasePool, "test-release", {
    maxLifetimeMs: 200,
    sweepIntervalMs: 60_000,
  });
  try {
    const recyclesBefore = getConnectionRecycleCount();

    const clientA = await releasePool.connect();
    const pidA = pidOf(clientA);
    // Hold past the lifetime, then release.
    await sleep(350);
    clientA.release();

    // pg-pool destroys the client asynchronously after a release(err).
    // Give the event loop a tick to actually drop it before the next
    // acquire so we don't race with `_remove`.
    await sleep(50);

    const clientB = await releasePool.connect();
    const pidB = pidOf(clientB);
    clientB.release();

    assert.notStrictEqual(
      clientA,
      clientB,
      "expected next checkout to be a fresh client object after expired release",
    );
    assert.notStrictEqual(
      pidA,
      pidB,
      `expected fresh backend processID; got pidA=${pidA} pidB=${pidB}`,
    );
    assert.ok(
      getConnectionRecycleCount() > recyclesBefore,
      "connection recycle counter must increment on release-time retire",
    );
    console.log("  ✓ release-time recycle handed back a fresh client");
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ release-time recycle: ${errMessage(e)}`);
    failed++;
  } finally {
    releaseHandle.stop();
    await releasePool.end().catch(() => {});
  }

  // ─── Test 2: idle sweep retires expired clients ───────────────────
  // Pool with min=0/max=1, lifetime 200ms, sweep every 100ms. A plain
  // pg `Pool` is enough — the periodic sweep does not need the
  // release-time hook in `wrapHoldOnce` to fire. After releasing the
  // client (which goes to the idle list), wait long enough for the
  // lifetime to elapse and at least one sweep tick to run, then assert
  // pg-pool no longer has any clients.
  console.log("\n[Test 2] Periodic sweep retires idle clients past lifetime");
  // lint-hermetic-db-ok: bare pg pool over the injected (hermetic) env; exercises pg-pool sweep mechanics, not app data
  const sweepPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    min: 0,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const sweepHandle = __installConnectionLifetimeForTest(sweepPool, "test-sweep", {
    maxLifetimeMs: 200,
    sweepIntervalMs: 100,
  });
  try {
    const recyclesBefore = getConnectionRecycleCount();

    const client = await sweepPool.connect();
    const pidC = pidOf(client);
    client.release();
    // After release the client sits idle in pg-pool's `_idle` list.
    assert.strictEqual(
      sweepPool.totalCount,
      1,
      "after release, the idle pool should hold exactly 1 client",
    );

    // Wait long enough for: (a) the 200ms lifetime to elapse and (b)
    // at least one 100ms sweep tick to run after that.
    await sleep(500);

    assert.strictEqual(
      sweepPool.totalCount,
      0,
      `sweep should have retired the idle expired client; totalCount=${sweepPool.totalCount}`,
    );
    assert.ok(
      getConnectionRecycleCount() > recyclesBefore,
      "connection recycle counter must increment after sweep retires a client",
    );

    // After the sweep retired the client, the next acquire must spin
    // up a fresh backend connection (different processID).
    const clientD = await sweepPool.connect();
    const pidD = pidOf(clientD);
    clientD.release();
    assert.notStrictEqual(
      pidC,
      pidD,
      `expected fresh backend processID after sweep; got pidC=${pidC} pidD=${pidD}`,
    );
    console.log("  ✓ periodic sweep retired the idle expired client");
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ idle sweep: ${errMessage(e)}`);
    failed++;
  } finally {
    sweepHandle.stop();
    await sweepPool.end().catch(() => {});
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().catch((e) => {
  console.error("Unhandled error:", e);
  process.exitCode = 1;
});
