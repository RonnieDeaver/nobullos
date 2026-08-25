/* test-registration
{
  "name": "Shared OAuth refresh single-flight helper (Task #1975)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1975 — Shared OAuth refresh single-flight helper coverage.
 *
 * What we assert here (the helper's contract — without it, every
 * downstream integration regresses to the SEMrush-flap bug):
 *
 *   1. Concurrent callers for the same integration collapse onto ONE
 *      in-flight POST and share the result.
 *   2. On a terminal classification, the helper RE-READS the stored
 *      refresh token; if it has rotated (cross-process race), it
 *      retries once and resolves with that result. The terminal-cleanup
 *      hook is NOT invoked when the retry succeeds.
 *   3. On terminal classification with no rotation observed, the
 *      terminal-cleanup hook IS invoked exactly once.
 *   4. Transient failures propagate as-is and do NOT invoke the
 *      terminal-cleanup hook (so a 5xx/network blip never wipes
 *      credentials).
 *   5. The single-flight slot is released on both success AND failure
 *      so the next caller is not deadlocked.
 *
 * Pure in-memory test — no DB, no network. Runs via tests/run-all.ts.
 */
import { strict as assert } from "node:assert";
import {
  OAuthRefreshError,
  withSingleFlightOAuthRefresh,
  __resetOAuthRefreshSingleFlightForTest,
  __getOAuthRefreshInFlightCountForTest,
} from "../server/services/oauthRefresh";

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

async function testSingleFlightCollapsesConcurrentCallers(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let calls = 0;
  const gate = deferred<string>();

  const run = () =>
    withSingleFlightOAuthRefresh<string>({
      integration: "test-collapse",
      readRefreshToken: async () => "rt-1",
      refreshOnce: async () => {
        calls += 1;
        return gate.promise;
      },
    });

  const p1 = run();
  const p2 = run();
  const p3 = run();
  // Allow the microtask scheduler to dispatch all three before resolving.
  await new Promise((r) => setImmediate(r));
  assert.equal(
    __getOAuthRefreshInFlightCountForTest(),
    1,
    "exactly one in-flight slot during the burst",
  );
  gate.resolve("access-token-OK");
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  assert.equal(a, "access-token-OK");
  assert.equal(b, "access-token-OK");
  assert.equal(c, "access-token-OK");
  assert.equal(calls, 1, "refreshOnce ran exactly once");
  // Cleanup tick.
  await new Promise((r) => setImmediate(r));
  assert.equal(
    __getOAuthRefreshInFlightCountForTest(),
    0,
    "in-flight slot released after resolution",
  );
}

async function testReReadAndRetryOnTerminalRotation(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  // Simulate cross-process refresh-token rotation: storage returns
  // "rt-old" first, then "rt-new" after the terminal failure.
  const reads = ["rt-old", "rt-new"];
  let onTerminalCalled = 0;
  let attempt2Token: string | null = null;

  const result = await withSingleFlightOAuthRefresh<string>({
    integration: "test-retry",
    readRefreshToken: async () => reads.shift() ?? null,
    refreshOnce: async ({ refreshToken, attempt }) => {
      if (attempt === 1) {
        throw new OAuthRefreshError(
          "test-retry",
          "terminal",
          `invalid_grant against captured token=${refreshToken}`,
        );
      }
      attempt2Token = refreshToken;
      return "access-token-AFTER-RACE";
    },
    onTerminalAfterRetry: async () => {
      onTerminalCalled += 1;
    },
  });

  assert.equal(result, "access-token-AFTER-RACE");
  assert.equal(attempt2Token, "rt-new", "second attempt used freshly-rotated token");
  assert.equal(
    onTerminalCalled,
    0,
    "terminal-cleanup hook must NOT fire when race recovery succeeded",
  );
}

async function testTerminalCleanupFiresWhenNoRotation(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let onTerminalCalled = 0;
  await assert.rejects(
    withSingleFlightOAuthRefresh<string>({
      integration: "test-terminal",
      readRefreshToken: async () => "rt-same",
      refreshOnce: async () => {
        throw new OAuthRefreshError("test-terminal", "terminal", "invalid_grant");
      },
      onTerminalAfterRetry: async () => {
        onTerminalCalled += 1;
      },
    }),
    (err: any) => err instanceof OAuthRefreshError && err.outcome === "terminal",
  );
  assert.equal(onTerminalCalled, 1, "terminal-cleanup hook ran exactly once");
}

async function testTransientFailureDoesNotInvokeCleanup(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let onTerminalCalled = 0;
  await assert.rejects(
    withSingleFlightOAuthRefresh<string>({
      integration: "test-transient",
      readRefreshToken: async () => "rt-1",
      refreshOnce: async () => {
        throw new OAuthRefreshError("test-transient", "transient", "503 Service Unavailable");
      },
      onTerminalAfterRetry: async () => {
        onTerminalCalled += 1;
      },
    }),
    (err: any) => err instanceof OAuthRefreshError && err.outcome === "transient",
  );
  assert.equal(
    onTerminalCalled,
    0,
    "transient failure must NOT wipe credentials — that was the SEMrush flap bug",
  );
}

async function testSingleFlightSlotReleasedOnFailure(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  await assert.rejects(
    withSingleFlightOAuthRefresh<string>({
      integration: "test-release",
      readRefreshToken: async () => "rt-1",
      refreshOnce: async () => {
        throw new OAuthRefreshError("test-release", "transient", "boom");
      },
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(
    __getOAuthRefreshInFlightCountForTest(),
    0,
    "in-flight slot must clear on failure or callers deadlock",
  );
  // Second call must be able to start a fresh refresh.
  let secondCalled = false;
  const v = await withSingleFlightOAuthRefresh<string>({
    integration: "test-release",
    readRefreshToken: async () => "rt-2",
    refreshOnce: async () => {
      secondCalled = true;
      return "ok";
    },
  });
  assert.equal(secondCalled, true);
  assert.equal(v, "ok");
}

async function testMissingRefreshTokenIsTerminalAndInvokesCleanup(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  let onTerminalCalled = 0;
  await assert.rejects(
    withSingleFlightOAuthRefresh<string>({
      integration: "test-missing",
      readRefreshToken: async () => null,
      refreshOnce: async () => "should-not-run",
      onTerminalAfterRetry: async () => {
        onTerminalCalled += 1;
      },
    }),
    (err: any) => err instanceof OAuthRefreshError && err.outcome === "terminal",
  );
  assert.equal(onTerminalCalled, 1);
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["single-flight collapses concurrent callers", testSingleFlightCollapsesConcurrentCallers],
    ["re-read-and-retry recovers when refresh token rotated", testReReadAndRetryOnTerminalRotation],
    ["terminal cleanup fires when no rotation observed", testTerminalCleanupFiresWhenNoRotation],
    ["transient failure does NOT invoke terminal cleanup", testTransientFailureDoesNotInvokeCleanup],
    ["single-flight slot released on failure", testSingleFlightSlotReleasedOnFailure],
    ["missing refresh token is terminal and invokes cleanup", testMissingRefreshTokenIsTerminalAndInvokesCleanup],
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
    throw new Error("oauth-refresh-single-flight test cases failed");
  }
  console.log("oauth-refresh-single-flight: OK");
}

await main();
