/* test-registration
{
  "name": "Per-user OAuth refresh single-flight + lease scoping (Task #2396)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2396 — Per-user OAuth refresh single-flight + lease scoping.
 *
 * Task #2377 added a per-subject key to the shared OAuth refresh helper so
 * PER-USER integrations (Google Calendar — each user holds their OWN
 * rotating refresh token) scope BOTH the in-process single-flight slot AND
 * the cross-process lease by `<integration>:<subjectKey>` instead of just
 * `integration`. The system-scoped contract (Front/Zoom/Google Ads/SEMrush
 * — no subjectKey) is covered by oauth-refresh-single-flight.test.ts and
 * oauth-refresh-cross-process-lease.test.ts, but nothing pins the per-user
 * scoping: a bug in scopedKey that dropped subjectKey would silently
 * collapse EVERY user onto one slot/lease (a throughput regression where
 * user B's refresh blocks waiting on user A) and no test would catch it.
 *
 * What we assert here:
 *
 *   1. With subjectKey set, the in-flight Map key and the lease acquire key
 *      are BOTH `<integration>:<subjectKey>` (per-user scoping).
 *   2. Two DIFFERENT subjects refresh concurrently — distinct slots, two
 *      POSTs, two distinct lease keys (they do NOT collapse onto one slot).
 *   3. Two SAME-subject concurrent callers collapse — one slot, one POST,
 *      one lease acquire (the single-flight contract still holds per user).
 *
 * Pure in-memory test — no DB, no network. Runs via tests/run-all.ts.
 */
import { strict as assert } from "node:assert";
import {
  withSingleFlightOAuthRefresh,
  __resetOAuthRefreshSingleFlightForTest,
  __getOAuthRefreshInFlightCountForTest,
  __getOAuthRefreshInFlightKeysForTest,
} from "../server/services/oauthRefresh";
import { type OAuthCrossProcessLease } from "../server/services/oauthRefreshLease";

type Resolver<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function deferred<T>(): Resolver<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A non-blocking lease that records every key passed to `acquire`, so a
 * test can assert the helper acquires on the SCOPED (per-subject) key. */
function makeKeyRecordingLease(): {
  lease: OAuthCrossProcessLease;
  acquiredKeys: () => string[];
} {
  const keys: string[] = [];
  const lease: OAuthCrossProcessLease = {
    async acquire(key: string) {
      keys.push(key);
      return async () => {};
    },
  };
  return { lease, acquiredKeys: () => keys };
}

async function testSameSubjectCollapsesAndScopesKey(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  const { lease, acquiredKeys } = makeKeyRecordingLease();
  let calls = 0;
  const gate = deferred<string>();

  const run = () =>
    withSingleFlightOAuthRefresh<string>({
      integration: "google_calendar",
      subjectKey: "user-1",
      crossProcessLease: lease,
      readRefreshToken: async () => "rt-user-1",
      refreshOnce: async () => {
        calls += 1;
        return gate.promise;
      },
    });

  const p1 = run();
  const p2 = run();
  // Let all callers dispatch before resolving the gate.
  await new Promise((r) => setImmediate(r));

  assert.equal(
    __getOAuthRefreshInFlightCountForTest(),
    1,
    "same-subject concurrent callers must share exactly one in-flight slot",
  );
  assert.deepEqual(
    __getOAuthRefreshInFlightKeysForTest(),
    ["google_calendar:user-1"],
    "in-flight slot must be keyed by <integration>:<subjectKey>",
  );

  gate.resolve("token-user-1");
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, "token-user-1");
  assert.equal(b, "token-user-1");
  assert.equal(calls, 1, "same-subject callers must collapse onto ONE refresh POST");
  assert.deepEqual(
    acquiredKeys(),
    ["google_calendar:user-1"],
    "lease must be acquired on the per-subject key exactly once for the same subject",
  );

  await new Promise((r) => setImmediate(r));
  assert.equal(
    __getOAuthRefreshInFlightCountForTest(),
    0,
    "in-flight slot released after resolution",
  );
}

async function testDifferentSubjectsDoNotCollapse(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  const { lease, acquiredKeys } = makeKeyRecordingLease();
  let active = 0;
  let maxActive = 0;
  const perUserCalls = new Map<string, number>();
  const gate = deferred<string>();

  const run = (subjectKey: string) =>
    withSingleFlightOAuthRefresh<string>({
      integration: "google_calendar",
      subjectKey,
      crossProcessLease: lease,
      readRefreshToken: async () => `rt-${subjectKey}`,
      refreshOnce: async () => {
        perUserCalls.set(subjectKey, (perUserCalls.get(subjectKey) ?? 0) + 1);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const v = await gate.promise;
        active -= 1;
        return `${v}-${subjectKey}`;
      },
    });

  const p1 = run("user-1");
  const p2 = run("user-2");
  await new Promise((r) => setImmediate(r));

  assert.equal(
    __getOAuthRefreshInFlightCountForTest(),
    2,
    "distinct subjects must NOT collapse — each gets its own in-flight slot",
  );
  assert.deepEqual(
    [...__getOAuthRefreshInFlightKeysForTest()].sort(),
    ["google_calendar:user-1", "google_calendar:user-2"],
    "each subject's slot must be keyed by its own <integration>:<subjectKey>",
  );
  assert.equal(
    maxActive,
    2,
    "both subjects' refreshes must run concurrently, not serialize on one slot",
  );

  gate.resolve("token");
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, "token-user-1");
  assert.equal(b, "token-user-2");
  assert.equal(perUserCalls.get("user-1"), 1, "user-1 refreshed exactly once");
  assert.equal(perUserCalls.get("user-2"), 1, "user-2 refreshed exactly once");
  assert.deepEqual(
    [...acquiredKeys()].sort(),
    ["google_calendar:user-1", "google_calendar:user-2"],
    "lease must be acquired on a DISTINCT per-subject key for each subject",
  );

  await new Promise((r) => setImmediate(r));
  assert.equal(__getOAuthRefreshInFlightCountForTest(), 0, "both slots released");
}

async function testNoSubjectKeyUsesBareIntegrationKey(): Promise<void> {
  // Guard the system-scoped fallback so a future change to scopedKey that
  // always appends a subject can't silently change Front/Zoom/etc keying.
  __resetOAuthRefreshSingleFlightForTest();
  const { lease, acquiredKeys } = makeKeyRecordingLease();
  const gate = deferred<string>();

  const p = withSingleFlightOAuthRefresh<string>({
    integration: "front",
    crossProcessLease: lease,
    readRefreshToken: async () => "rt",
    refreshOnce: async () => gate.promise,
  });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(
    __getOAuthRefreshInFlightKeysForTest(),
    ["front"],
    "without subjectKey the slot must be keyed by the bare integration name",
  );
  assert.deepEqual(
    acquiredKeys(),
    ["front"],
    "without subjectKey the lease must be acquired on the bare integration name",
  );

  gate.resolve("ok");
  assert.equal(await p, "ok");
  await new Promise((r) => setImmediate(r));
  assert.equal(__getOAuthRefreshInFlightCountForTest(), 0, "slot released");
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["same subject collapses and scopes slot+lease to <integration>:<subjectKey>", testSameSubjectCollapsesAndScopesKey],
    ["different subjects do NOT collapse (per-user slots + leases)", testDifferentSubjectsDoNotCollapse],
    ["no subjectKey falls back to the bare integration key", testNoSubjectKeyUsesBareIntegrationKey],
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
    throw new Error("oauth-refresh-per-user-subject-key test cases failed");
  }
  console.log("oauth-refresh-per-user-subject-key: OK");
}

await main();
