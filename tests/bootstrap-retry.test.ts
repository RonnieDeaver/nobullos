/* test-registration
{
  "name": "Bootstrap retry helper + classifier (Task #1630)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1630 — Unit coverage for the bootstrap retry helper and the
 * transient-error classifier.
 *
 * All cases inject a fake-clock `sleep` so the test runs instantly even
 * though the real backoff sums to 31 s.
 */
import { isTransientDbError, retryTransientDbStep } from "../server/lib/bootstrapRetry";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function expectEq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeFakeSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    calls.push(ms);
  };
  return { sleep, calls };
}

const silentLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// T1 — Retries transient and eventually succeeds.
// ---------------------------------------------------------------------------
console.log("bootstrap-retry T1: retries transient and eventually succeeds");
{
  let calls = 0;
  const step = async () => {
    calls++;
    if (calls < 4) {
      throw Object.assign(new Error("Authentication timed out"), { code: "08P01" });
    }
    return "ok";
  };
  const { sleep, calls: sleepCalls } = makeFakeSleep();
  const result = await retryTransientDbStep("durable_pipeline_tables", step, {
    sleep,
    logger: silentLogger,
  });
  expectEq(result, "ok", "helper resolves successfully on attempt 4");
  expectEq(calls, 4, "step called exactly 4 times");
  expectEq(sleepCalls, [1000, 2000, 4000], "sleep called with [1000, 2000, 4000]");
}

// ---------------------------------------------------------------------------
// T2 — Non-transient structural error fails fast.
// ---------------------------------------------------------------------------
console.log("bootstrap-retry T2: non-transient structural error fails fast");
{
  let calls = 0;
  const fatal = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  const step = async () => {
    calls++;
    throw fatal;
  };
  const { sleep, calls: sleepCalls } = makeFakeSleep();
  let thrown: unknown;
  try {
    await retryTransientDbStep("durable_pipeline_tables", step, {
      sleep,
      logger: silentLogger,
    });
  } catch (e) {
    thrown = e;
  }
  assert(thrown === fatal, "helper rethrows the original structural error");
  expectEq(calls, 1, "step called exactly once (no retry)");
  expectEq(sleepCalls, [], "sleep never called for fatal error");
}

// ---------------------------------------------------------------------------
// T3 — Transient error exhausts retry budget.
// ---------------------------------------------------------------------------
console.log("bootstrap-retry T3: transient error exhausts retry budget");
{
  let calls = 0;
  let lastErr: Error | null = null;
  const step = async () => {
    calls++;
    lastErr = Object.assign(new Error("Authentication timed out"), { code: "08P01" });
    throw lastErr;
  };
  const { sleep, calls: sleepCalls } = makeFakeSleep();
  let thrown: unknown;
  try {
    await retryTransientDbStep("scheduler_start", step, {
      sleep,
      logger: silentLogger,
    });
  } catch (e) {
    thrown = e;
  }
  // maxAttempts=5 means 5 retries beyond the initial attempt = 6 total
  // fn() invocations and 5 sleeps summing to 31_000ms (worst case).
  expectEq(calls, 6, "step called exactly 6 times (initial + 5 retries)");
  expectEq(
    sleepCalls,
    [1000, 2000, 4000, 8000, 16000],
    "sleep called with [1000, 2000, 4000, 8000, 16000] (cumulative 31000ms)",
  );
  assert(thrown === lastErr, "helper rethrows the final transient error");
}

// ---------------------------------------------------------------------------
// T4 — Message-based transient classification.
// ---------------------------------------------------------------------------
console.log("bootstrap-retry T4: message-based transient classification");
{
  const transientMessages = [
    "Authentication timed out",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
  ];
  for (const msg of transientMessages) {
    assert(
      isTransientDbError(new Error(msg)),
      `isTransientDbError(Error("${msg}")) === true`,
    );
  }
}

// ---------------------------------------------------------------------------
// T5 — Fatal classification does not over-match.
// ---------------------------------------------------------------------------
console.log("bootstrap-retry T5: fatal classification does not over-match");
{
  const fatalMessages = [
    "relation does not exist",
    "syntax error",
    "permission denied",
    "column does not exist",
  ];
  for (const msg of fatalMessages) {
    assert(
      !isTransientDbError(new Error(msg)),
      `isTransientDbError(Error("${msg}")) === false`,
    );
  }
}

if (failed > 0) {
  console.error(`bootstrap-retry: FAILED (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`bootstrap-retry: PASSED (${passed} assertions)`);
