/* test-registration
{
  "name": "Supervised sampler hysteresis (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #992 — supervised-sampler hysteresis & dedup contract tests.
 *
 * These are deliberately in-memory: they spin up real samplers with
 * tiny intervals and drive the watchdog directly via the test hook,
 * with `healthIncidents` stubbed via dynamic-import indirection (we
 * just observe `stallIncidentIds` membership through the runtime
 * state's `healthy` flag and the on-disk emit-count via a wrapped
 * console.warn).
 */

import {
  startSupervisedSampler,
  stopSupervisedSampler,
  getSupervisedSamplerState,
  __test,
} from "../server/services/supervisedSampler";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface WarnCounter {
  watchdogWarns: number;
  restartRequired: number;
  recoveryAttempts: number;
  restore: () => void;
}
function instrumentConsole(samplerName: string): WarnCounter {
  const origWarn = console.warn;
  const origError = console.error;
  const counter: WarnCounter = {
    watchdogWarns: 0,
    restartRequired: 0,
    recoveryAttempts: 0,
    restore: () => {
      console.warn = origWarn;
      console.error = origError;
    },
  };
  console.warn = (...args: any[]) => {
    const s = args.map(String).join(" ");
    if (s.includes(`[Sampler:${samplerName}] watchdog:`)) {
      if (s.includes("in-process recovery attempt")) counter.recoveryAttempts++;
      else if (!s.includes("probe failed") && !s.includes("failed to")) counter.watchdogWarns++;
    }
    origWarn(...args);
  };
  console.error = (...args: any[]) => {
    const s = args.map(String).join(" ");
    if (s.includes(`[Sampler:${samplerName}]`) && s.includes("RESTART REQUIRED")) {
      counter.restartRequired++;
    }
    origError(...args);
  };
  return counter;
}

async function testOpenOnConfirmedFailures(): Promise<void> {
  __test.reset();
  const name = "test_hysteresis_failures";
  const counter = instrumentConsole(name);
  let throwCount = 0;
  startSupervisedSampler({
    name,
    intervalMs: 30,
    initialDelayMs: 0,
    tickTimeoutMs: 1_000,
    tick: async () => {
      throwCount++;
      throw new Error("boom");
    },
  });
  // Let several real ticks fire and fail.
  await sleep(200);
  const state = getSupervisedSamplerState(name)!;
  assert(state.consecutiveFailures >= 2, `expected ≥2 failures, got ${state.consecutiveFailures}`);

  // Drive the watchdog manually (real watchdog runs every 60s).
  await __test.watchdogTickNow();
  const afterFirstWatchdog = getSupervisedSamplerState(name)!;
  assert(
    !afterFirstWatchdog.healthy,
    "expected sampler to be marked unhealthy after confirmed-failure escalation",
  );

  // Second & third watchdog passes with no state change → must NOT
  // re-emit the warning every cycle (Task #992 dedup).
  const warnsAfterOpen = counter.watchdogWarns;
  await __test.watchdogTickNow();
  await __test.watchdogTickNow();
  assert(
    counter.watchdogWarns === warnsAfterOpen,
    `dedup violated: warns went ${warnsAfterOpen} → ${counter.watchdogWarns} on identical state`,
  );

  stopSupervisedSampler(name);
  counter.restore();
  console.log("✓ opens on ≥2 confirmed failures and dedups identical re-emissions");
}

async function testResolveRequiresRealTickSuccesses(): Promise<void> {
  __test.reset();
  const name = "test_hysteresis_resolve";
  const counter = instrumentConsole(name);
  let mode: "fail" | "ok" = "fail";
  startSupervisedSampler({
    name,
    intervalMs: 30,
    initialDelayMs: 0,
    tickTimeoutMs: 1_000,
    tick: async () => {
      if (mode === "fail") throw new Error("still down");
    },
  });

  // Burn enough failures to confirm.
  await sleep(200);
  await __test.watchdogTickNow();
  assert(
    !getSupervisedSamplerState(name)!.healthy,
    "expected unhealthy after confirmed failures",
  );

  // Flip to success — but only fire ONE successful tick.
  mode = "ok";
  await __test.runTickNow(name);
  assert(
    getSupervisedSamplerState(name)!.consecutiveSuccesses === 1,
    "expected exactly 1 consecutive success",
  );
  await __test.watchdogTickNow();
  assert(
    !getSupervisedSamplerState(name)!.healthy,
    "must NOT resolve on a single success — requires ≥2 consecutive successes",
  );

  // Second successful tick — now we cross the threshold.
  await __test.runTickNow(name);
  await __test.watchdogTickNow();
  assert(
    getSupervisedSamplerState(name)!.healthy,
    "expected resolve after 2 consecutive real-tick successes",
  );

  stopSupervisedSampler(name);
  counter.restore();
  console.log("✓ resolves only after ≥2 consecutive real-tick successes");
}

async function testRestartRequiredLoggedOnce(): Promise<void> {
  __test.reset();
  const name = "test_hysteresis_restart";
  const counter = instrumentConsole(name);
  // Use an enormous interval so the natural interval timer does not
  // fire during the test window — it would otherwise race against
  // our manual watchdog calls (a natural tick mid-flight makes
  // attemptRecovery short-circuit on `inFlight`).
  startSupervisedSampler({
    name,
    intervalMs: 60_000,
    initialDelayMs: 60_000,
    tickTimeoutMs: 1_000,
    tick: async () => {
      throw new Error("permaboom");
    },
  });

  // Directly exhaust the in-process recovery budget by mutating live
  // state. `getSupervisedSamplerState` returns a copy, so we use the
  // dedicated `__test.mutateState` helper to write through.
  __test.mutateState(name, {
    startedAt: Date.now() - 10 * 60_000,
    recoveryAttempts: 5,
    lastRecoveryAt: null,
    consecutiveFailures: 5,
  });

  // First watchdog after exhaustion → must log RESTART REQUIRED.
  await __test.watchdogTickNow();
  await sleep(20);
  // Second watchdog → must NOT re-log.
  __test.mutateState(name, { lastRecoveryAt: null });
  await __test.watchdogTickNow();
  await sleep(20);
  __test.mutateState(name, { lastRecoveryAt: null });
  await __test.watchdogTickNow();

  assert(
    counter.restartRequired === 1,
    `expected exactly one RESTART REQUIRED log, got ${counter.restartRequired}`,
  );

  stopSupervisedSampler(name);
  counter.restore();
  console.log("✓ logs 'restart required' exactly once after recovery exhaustion");
}

async function testDedupedStallStillHeartbeats(): Promise<void> {
  // Task #992 — even when the dedup gate suppresses re-emission of
  // the stall incident, the watchdog must still refresh the open
  // incident's `last_seen_at` so the auto-stale-resolve sweep does
  // not silently close an actively stalled sampler. We exercise this
  // through the public surface: call emitStallIncident's dedup path
  // (via two watchdog ticks with unchanged signature) and confirm
  // touchIncidentHeartbeat was called.
  __test.reset();
  const name = "test_dedup_heartbeat";
  let touchCalls = 0;
  let ingestCalls = 0;
  __test.setIncidentSink({
    ingestAlert: (async () => {
      ingestCalls++;
      return { id: 12345 } as any;
    }) as any,
    resolveIncident: (async () => null) as any,
    touchIncidentHeartbeat: (async () => {
      touchCalls++;
      return null;
    }) as any,
  });

  try {
    startSupervisedSampler({
      name,
      intervalMs: 60_000,
      initialDelayMs: 60_000,
      tickTimeoutMs: 1_000,
      tick: async () => {
        throw new Error("permaboom");
      },
    });
    // Push past startup grace and into a stall with confirmed failures.
    __test.mutateState(name, {
      startedAt: Date.now() - 10 * 60_000,
      consecutiveFailures: 5,
    });

    // First watchdog: opens incident (real ingestAlert path, stubbed).
    await __test.watchdogTickNow();
    // Subsequent watchdog ticks with unchanged signature: dedup path
    // must call touchIncidentHeartbeat instead of re-ingesting.
    await __test.watchdogTickNow();
    await __test.watchdogTickNow();
    await __test.watchdogTickNow();

    assert(
      ingestCalls >= 1,
      `first stall watchdog tick must ingest the incident; got ${ingestCalls}`,
    );
    assert(
      touchCalls >= 2,
      `dedup path must heartbeat the incident; got ${touchCalls} touch calls`,
    );

    stopSupervisedSampler(name);
    console.log("✓ deduped stall keeps incident alive via heartbeat");
  } finally {
    __test.setIncidentSink(null);
  }
}

async function run(): Promise<void> {
  await testOpenOnConfirmedFailures();
  await testResolveRequiresRealTickSuccesses();
  await testRestartRequiredLoggedOnce();
  await testDedupedStallStillHeartbeats();
  console.log("✓ supervised-sampler hysteresis & dedup");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
