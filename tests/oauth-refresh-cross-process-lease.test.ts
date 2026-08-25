/* test-registration
{
  "name": "Cross-process OAuth refresh lease (Task #2289)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2289 — Cross-process OAuth refresh lease coverage.
 *
 * In-process single-flight (Task #1975) collapses concurrent refreshers
 * WITHIN one process, but prod runs on autoscale (N instances) plus the
 * workspace process. Each has its own in-memory single-flight Map, so two
 * processes still refresh at once; inside Front's last-24h refresh-token
 * rotation window the loser POSTs a consumed token → `invalid_grant`
 * (terminal) → recovery dies. The cross-process lease serializes every
 * process to one refresher at a time.
 *
 * What we assert here (the lease contract wired into the helper):
 *
 *   1. The lease serializes refresh POSTs across "processes" — two callers
 *      sharing one lease never run `refreshOnce` concurrently.
 *   2. The refresh token is read AFTER the lease is held, so a loser picks
 *      up whatever token the winner just rotated (read-after-lease order).
 *   3. `onLeaseAcquiredRecheck` short-circuits the POST when a sibling
 *      already refreshed while we waited for the lease; the lease is still
 *      released.
 *   4. The helper degrades gracefully when the lease is unavailable
 *      (acquire → null): the refresh still proceeds (in-process only).
 *   5. The lease is released on BOTH success and failure.
 *   6. `getDefaultOAuthRefreshLease` is off under NODE_ENV=test and honors
 *      the injected test seam.
 *
 * Pure in-memory test — no DB, no network. Runs via tests/run-all.ts.
 */
import { strict as assert } from "node:assert";
import {
  OAuthRefreshError,
  withSingleFlightOAuthRefresh,
  __resetOAuthRefreshSingleFlightForTest,
} from "../server/services/oauthRefresh";
import {
  type OAuthCrossProcessLease,
  getDefaultOAuthRefreshLease,
  __setOAuthRefreshLeaseForTest,
} from "../server/services/oauthRefreshLease";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A promise-chain mutex masquerading as a cross-process lease: only one
 * holder at a time across ALL integrations, so two distinct "processes"
 * (distinct integration keys) are forced to serialize exactly like the
 * real distributed lease would. */
function makeSerializingLease(): {
  lease: OAuthCrossProcessLease;
  maxConcurrent: () => number;
} {
  let tail: Promise<void> = Promise.resolve();
  let current = 0;
  let maxConcurrent = 0;
  const lease: OAuthCrossProcessLease = {
    async acquire() {
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      const prev = tail;
      tail = prev.then(() => next);
      await prev;
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        current -= 1;
        release();
      };
    },
  };
  return { lease, maxConcurrent: () => maxConcurrent };
}

async function testLeaseSerializesAcrossProcesses(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  const { lease, maxConcurrent } = makeSerializingLease();
  let active = 0;
  let maxActive = 0;
  const refreshOnce = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(20);
    active -= 1;
    return "ok";
  };
  // Distinct integration keys so the in-process single-flight Map does NOT
  // collapse them — they only serialize via the shared lease.
  const mk = (intg: string) =>
    withSingleFlightOAuthRefresh<string>({
      integration: intg,
      crossProcessLease: lease,
      readRefreshToken: async () => "rt",
      refreshOnce,
    });
  await Promise.all([mk("proc-a"), mk("proc-b")]);
  assert.equal(maxActive, 1, "lease must serialize refresh POSTs to one at a time");
  assert.equal(maxConcurrent(), 1, "lease must only ever have one holder");
}

async function testReadRefreshTokenHappensAfterLease(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  const order: string[] = [];
  const lease: OAuthCrossProcessLease = {
    async acquire() {
      order.push("acquire");
      return async () => {
        order.push("release");
      };
    },
  };
  await withSingleFlightOAuthRefresh<string>({
    integration: "read-after-lease",
    crossProcessLease: lease,
    readRefreshToken: async () => {
      order.push("read");
      return "rt";
    },
    refreshOnce: async () => {
      order.push("refresh");
      return "ok";
    },
  });
  assert.deepEqual(
    order,
    ["acquire", "read", "refresh", "release"],
    "refresh token must be read only after the lease is held",
  );
}

async function testRecheckSkipsPostWhenSiblingRefreshed(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let refreshCalls = 0;
  let released = 0;
  const lease: OAuthCrossProcessLease = {
    async acquire() {
      return async () => {
        released += 1;
      };
    },
  };
  const result = await withSingleFlightOAuthRefresh<string>({
    integration: "recheck",
    crossProcessLease: lease,
    onLeaseAcquiredRecheck: async () => "fresh-from-sibling",
    readRefreshToken: async () => {
      throw new Error("readRefreshToken must not run when recheck short-circuits");
    },
    refreshOnce: async () => {
      refreshCalls += 1;
      return "should-not-run";
    },
  });
  assert.equal(result, "fresh-from-sibling");
  assert.equal(refreshCalls, 0, "POST must be skipped when a sibling already refreshed");
  assert.equal(released, 1, "lease must be released even when the POST is skipped");
}

async function testDegradesWhenLeaseUnavailable(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let refreshCalls = 0;
  const lease: OAuthCrossProcessLease = {
    async acquire() {
      return null; // contention / DB error
    },
  };
  const result = await withSingleFlightOAuthRefresh<string>({
    integration: "degrade",
    crossProcessLease: lease,
    readRefreshToken: async () => "rt",
    refreshOnce: async () => {
      refreshCalls += 1;
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(
    refreshCalls,
    1,
    "refresh must proceed (in-process only) when the lease is unavailable",
  );
}

async function testLeaseReleasedOnFailure(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let released = 0;
  const lease: OAuthCrossProcessLease = {
    async acquire() {
      return async () => {
        released += 1;
      };
    },
  };
  await assert.rejects(
    withSingleFlightOAuthRefresh<string>({
      integration: "fail-release",
      crossProcessLease: lease,
      readRefreshToken: async () => "rt",
      refreshOnce: async () => {
        throw new OAuthRefreshError("fail-release", "transient", "boom");
      },
    }),
  );
  assert.equal(released, 1, "lease must be released on refresh failure");
}

async function testDefaultLeaseSeam(): Promise<void> {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  __setOAuthRefreshLeaseForTest(undefined);
  assert.equal(
    getDefaultOAuthRefreshLease(),
    undefined,
    "default lease must be OFF under NODE_ENV=test so existing suites never hit system_settings",
  );
  const stub: OAuthCrossProcessLease = {
    async acquire() {
      return async () => {};
    },
  };
  __setOAuthRefreshLeaseForTest(stub);
  assert.equal(getDefaultOAuthRefreshLease(), stub, "injected stub must override the default");
  __setOAuthRefreshLeaseForTest(null);
  assert.equal(
    getDefaultOAuthRefreshLease(),
    undefined,
    "explicit null must disable the lease even outside test env",
  );
  __setOAuthRefreshLeaseForTest(undefined);
  process.env.NODE_ENV = prevEnv;
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["lease serializes refresh POSTs across processes", testLeaseSerializesAcrossProcesses],
    ["refresh token is read after the lease is held", testReadRefreshTokenHappensAfterLease],
    ["recheck skips POST when sibling already refreshed", testRecheckSkipsPostWhenSiblingRefreshed],
    ["degrades to in-process-only when lease unavailable", testDegradesWhenLeaseUnavailable],
    ["lease released on refresh failure", testLeaseReleasedOnFailure],
    ["default lease seam: off under test env, honors override", testDefaultLeaseSeam],
  ];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("oauth-refresh-cross-process-lease test cases failed");
  }
  console.log("oauth-refresh-cross-process-lease: OK");
}

await main();
