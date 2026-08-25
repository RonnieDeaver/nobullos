/* test-registration
{
  "name": "regression-sweep catch-up arm and crash classifier (Task #4437)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4437: guards the catch-up eligibility classifier and infra-crash detector that keep the committed green baseline fresh. Pure-logic tests — no DB queries, no spawned children, no network — sub-second.",
  "scanPaths": [
    "server/services/regressionSweepScheduler.ts"
  ],
  "tier": "small"
}
test-registration */
// future-date-literal-reviewed: every near-future literal (2026-08-15 etc.) is an explicitly injected pinned clock (NOW / now: parameters) or state stamped and re-read under that pinned clock — no comparison against the real clock; they cannot rot.
/**
 * Task #4437 — Guards for the catch-up arm and telemetry added to the nightly
 * regression-sweep scheduler.
 *
 * The committed tests/green-baseline.json was stuck at 2026-08-08 because the
 * 03:30 ET cron never fires when the dev workspace is offline. The catch-up
 * arm detects a stale baseline at boot + every 6 h and kicks a sweep; the
 * crash classifier distinguishes infra crashes (thread exhaustion, OOM) from
 * genuine red runs so repeated OS crashes don't silence the alert.
 *
 * All tested functions are pure over injected parameters — no DB, no spawned
 * children, no network calls.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ATTEMPT_ORPHAN_THRESHOLD_HOURS,
  ATTEMPT_START_PATH,
  BASELINE_STALENESS_ALERT_DAYS,
  CATCHUP_BASELINE_AGE_THRESHOLD_DAYS,
  CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS,
  CATCHUP_MIN_HOURS_SINCE_LAST_TICK,
  CRASH_STREAK_ALERT_THRESHOLD,
  DEFAULT_WATCHDOG_STALENESS_STATE_PATH,
  LAST_TICK_STATE_PATH,
  TICK_LOG_PATH,
  buildSweepSpawnEnv,
  classifyInfrastructureCrash,
  classifySubEnvironment,
  detectSubEnvironment,
  isPublisherEnabled,
  readAttemptStartState,
  readCommittedBaselineStatus,
  readLastTickState,
  readWatchdogStalenessState,
  readWatchdogStalenessStamp,
  runStalenessWatchdogOnce,
  shouldRunCatchup,
  writeAttemptStartState,
  writeLastTickState,
  writeWatchdogStalenessState,
  writeWatchdogStalenessStamp,
  type LastTickState,
} from "../server/services/regressionSweepScheduler";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-11T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

function makeTickState(over: Partial<LastTickState> = {}): LastTickState {
  return {
    trigger: "cron",
    startedAt: hoursAgo(1),
    finishedAt: hoursAgo(0.5),
    exitCode: 0,
    hardFailed: 0,
    isInfraCrash: false,
    crashSignature: null,
    crashStreak: 0,
    lastCatchupDate: null,
    ...over,
  };
}

// Base shouldRunCatchup params — all gates open for a stale baseline case.
function openParams(over: Partial<Parameters<typeof shouldRunCatchup>[0]> = {}) {
  return {
    now: NOW,
    baselineAgeDays: CATCHUP_BASELINE_AGE_THRESHOLD_DAYS + 0.5, // stale
    lastTickState: makeTickState({ finishedAt: hoursAgo(CATCHUP_MIN_HOURS_SINCE_LAST_TICK + 1) }),
    catchupEnabled: true,
    workspaceSchedulingEnabled: true,
    loadTooHigh: false,
    // Task #4530 S1: publisher gate (ON in tests so the gate is open by default).
    publisherEnabled: true,
    // Task #4530 S3: no recent attempt start.
    lastAttemptStartedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. classifyInfrastructureCrash
// ---------------------------------------------------------------------------

test("classifyInfrastructureCrash: report present → never an infra crash", () => {
  const fakeReport = { hardFailed: 1 } as never; // non-null → completed run
  const r = classifyInfrastructureCrash(fakeReport, 1, "errno=11 pthread_create");
  assert.equal(r.isInfraCrash, false, "a completed report is never an infra crash");
  assert.equal(r.signature, null);
});

test("classifyInfrastructureCrash: exit 0 with no report → not a crash (impossible in practice)", () => {
  const r = classifyInfrastructureCrash(null, 0, "");
  assert.equal(r.isInfraCrash, false);
  assert.equal(r.signature, null);
});

test("classifyInfrastructureCrash: thread-exhaustion signatures", () => {
  for (const snippet of [
    "errno=11",
    "pthread_create failed",
    "runtime: failed to create new OS thread",
  ]) {
    const r = classifyInfrastructureCrash(null, 1, snippet);
    assert.equal(r.isInfraCrash, true, `expected infra crash for: ${snippet}`);
    assert.equal(r.signature, "thread-exhaustion");
  }
});

test("classifyInfrastructureCrash: OOM signatures", () => {
  for (const snippet of ["ENOMEM", "Cannot allocate memory"]) {
    const r = classifyInfrastructureCrash(null, 1, snippet);
    assert.equal(r.isInfraCrash, true, `expected infra crash for: ${snippet}`);
    assert.equal(r.signature, "oom");
  }
});

test("classifyInfrastructureCrash: null report + non-zero exit + no known signature → not classified", () => {
  const r = classifyInfrastructureCrash(null, 1, "something went wrong with esbuild");
  assert.equal(r.isInfraCrash, false, "unknown stderr is not classified as an infra crash");
  assert.equal(r.signature, null);
});

// ---------------------------------------------------------------------------
// 2. shouldRunCatchup
// ---------------------------------------------------------------------------

test("shouldRunCatchup: eligible when baseline stale + no recent tick + catchup enabled", () => {
  const { eligible } = shouldRunCatchup(openParams());
  assert.equal(eligible, true);
});

test("shouldRunCatchup: ineligible when workspace scheduling disabled", () => {
  const { eligible, reason } = shouldRunCatchup(openParams({ workspaceSchedulingEnabled: false }));
  assert.equal(eligible, false);
  assert.ok(reason.includes("disabled"), `reason: ${reason}`);
});

test("shouldRunCatchup: ineligible when catchup kill switch off", () => {
  const { eligible, reason } = shouldRunCatchup(openParams({ catchupEnabled: false }));
  assert.equal(eligible, false);
  assert.ok(reason.includes("REGRESSION_SWEEP_CATCHUP_ENABLED"), `reason: ${reason}`);
});

test("shouldRunCatchup: ineligible when baseline age null (no committed baseline)", () => {
  const { eligible, reason } = shouldRunCatchup(openParams({ baselineAgeDays: null }));
  assert.equal(eligible, false);
  assert.ok(reason.includes("no committed baseline"), `reason: ${reason}`);
});

test("shouldRunCatchup: ineligible when baseline is fresh", () => {
  const { eligible, reason } = shouldRunCatchup(
    openParams({ baselineAgeDays: CATCHUP_BASELINE_AGE_THRESHOLD_DAYS - 0.1 }),
  );
  assert.equal(eligible, false);
  assert.ok(reason.includes("fresh") && reason.includes("threshold"), `reason: ${reason}`);
});

test("shouldRunCatchup: ineligible when already ran catch-up today (once-per-day cap)", () => {
  const todayUtc = NOW.toISOString().slice(0, 10);
  const { eligible, reason } = shouldRunCatchup(
    openParams({ lastTickState: makeTickState({ lastCatchupDate: todayUtc, finishedAt: hoursAgo(CATCHUP_MIN_HOURS_SINCE_LAST_TICK + 1) }) }),
  );
  assert.equal(eligible, false);
  assert.ok(reason.includes("already ran today"), `reason: ${reason}`);
});

test("shouldRunCatchup: ineligible when recent non-crash tick within cooldown", () => {
  const { eligible, reason } = shouldRunCatchup(
    openParams({
      lastTickState: makeTickState({ finishedAt: hoursAgo(CATCHUP_MIN_HOURS_SINCE_LAST_TICK - 2) }),
    }),
  );
  assert.equal(eligible, false);
  assert.ok(reason.includes("cooldown"), `reason: ${reason}`);
});

test("shouldRunCatchup: infra-crash gets a shorter 2h cooldown (retries sooner)", () => {
  // 3h since crash tick — past the 2h crash cooldown, eligible.
  const afterCrash3h = shouldRunCatchup(
    openParams({
      lastTickState: makeTickState({ isInfraCrash: true, finishedAt: hoursAgo(3) }),
    }),
  );
  assert.equal(afterCrash3h.eligible, true, "3h after crash should be eligible (>2h crash cooldown)");

  // 1h since crash tick — still within 2h crash cooldown.
  const afterCrash1h = shouldRunCatchup(
    openParams({
      lastTickState: makeTickState({ isInfraCrash: true, finishedAt: hoursAgo(1) }),
    }),
  );
  assert.equal(afterCrash1h.eligible, false, "1h after crash should be ineligible (<2h cooldown)");
  assert.ok(afterCrash1h.reason.includes("infra-crash"), `reason: ${afterCrash1h.reason}`);
});

test("shouldRunCatchup: ineligible when load too high", () => {
  const { eligible, reason } = shouldRunCatchup(openParams({ loadTooHigh: true }));
  assert.equal(eligible, false);
  assert.ok(reason.includes("load too high") || reason.includes("git lock"), `reason: ${reason}`);
});

test("shouldRunCatchup: null lastTickState (never ran) is eligible", () => {
  const { eligible } = shouldRunCatchup(openParams({ lastTickState: null }));
  assert.equal(eligible, true, "a workspace that has never swept should catch up");
});

test("shouldRunCatchup: crashed catch-up at T0 allows retry at T+2h (lastCatchupDate NOT consumed by crash)", () => {
  // A crashed catch-up run must NOT set lastCatchupDate in the tick state.
  // Only non-crash catch-ups consume the per-day cap. This makes the 2h
  // infra-crash cooldown reachable: without this, stamping lastCatchupDate
  // on a crash blocks all further catch-ups until the next UTC day.
  const todayUtc = NOW.toISOString().slice(0, 10);

  // Correct state: crash tick has lastCatchupDate = null.
  const crashTick = makeTickState({
    trigger: "catchup",
    isInfraCrash: true,
    lastCatchupDate: null, // not consumed: crash doesn't commit the per-day cap
    finishedAt: hoursAgo(3),
  });
  const { eligible, reason } = shouldRunCatchup(openParams({ lastTickState: crashTick }));
  assert.equal(eligible, true, `eligible 3h after crash when cap not consumed; got: ${reason}`);

  // T+1h: still within the 2h crash cooldown — should be ineligible.
  const crashTickRecent = makeTickState({
    trigger: "catchup",
    isInfraCrash: true,
    lastCatchupDate: null,
    finishedAt: hoursAgo(1),
  });
  const { eligible: tooSoon } = shouldRunCatchup(openParams({ lastTickState: crashTickRecent }));
  assert.equal(tooSoon, false, "within 2h crash cooldown: ineligible");

  // Regression: if a crash tick incorrectly sets lastCatchupDate = today,
  // the per-day cap blocks the retry even after the 2h cooldown passes.
  const crashTickWithWrongCap = makeTickState({
    trigger: "catchup",
    isInfraCrash: true,
    lastCatchupDate: todayUtc, // BUG: should never be set on a crash
    finishedAt: hoursAgo(3),
  });
  const { eligible: blockedByBug } = shouldRunCatchup(
    openParams({ lastTickState: crashTickWithWrongCap }),
  );
  assert.equal(
    blockedByBug,
    false,
    "regression proof: setting lastCatchupDate on a crash incorrectly blocks the retry path",
  );
});

// ---------------------------------------------------------------------------
// 3. readLastTickState / writeLastTickState round-trip
// ---------------------------------------------------------------------------

test("readLastTickState / writeLastTickState: round-trip fidelity", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-catchup-test-"));
  const statePath = join(dir, "last-tick.json");
  try {
    assert.equal(readLastTickState(statePath), null, "missing file → null");
    const state = makeTickState({
      trigger: "catchup",
      exitCode: 0,
      hardFailed: 0,
      isInfraCrash: false,
      crashStreak: 0,
      lastCatchupDate: "2026-08-11",
    });
    writeLastTickState(state, statePath);
    const read = readLastTickState(statePath);
    assert.ok(read !== null, "round-trip returns non-null");
    assert.equal(read!.trigger, "catchup");
    assert.equal(read!.lastCatchupDate, "2026-08-11");
    assert.equal(read!.isInfraCrash, false);
    assert.equal(read!.crashStreak, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLastTickState: corrupt file → null (never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-catchup-test-"));
  const statePath = join(dir, "last-tick.json");
  try {
    writeFileSync(statePath, "{ not json at all", "utf8");
    assert.equal(readLastTickState(statePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. watchdog state round-trip
// ---------------------------------------------------------------------------

test("readWatchdogStalenessStamp / writeWatchdogStalenessStamp: round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-watchdog-test-"));
  const statePath = join(dir, "watchdog.json");
  try {
    assert.equal(readWatchdogStalenessStamp(statePath), null, "missing → null");
    const stamp = "2026-08-08T02:39:00.000Z";
    writeWatchdogStalenessStamp(stamp, statePath);
    assert.equal(readWatchdogStalenessStamp(statePath), stamp);
    // Clear (null) also persists.
    writeWatchdogStalenessStamp(null, statePath);
    assert.equal(readWatchdogStalenessStamp(statePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. readCommittedBaselineStatus
// ---------------------------------------------------------------------------

test("readCommittedBaselineStatus: missing file → nulls (never throws)", () => {
  const { publishedAt, ageDays } = readCommittedBaselineStatus(
    NOW,
    "/nonexistent-path/green-baseline.json",
  );
  assert.equal(publishedAt, null);
  assert.equal(ageDays, null);
});

test("readCommittedBaselineStatus: valid publishedAt computes ageDays correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-baseline-test-"));
  const path = join(dir, "green-baseline.json");
  try {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify({ publishedAt: twoDaysAgo }), "utf8");
    const { publishedAt, ageDays } = readCommittedBaselineStatus(NOW, path);
    assert.equal(publishedAt, twoDaysAgo);
    assert.ok(ageDays !== null && Math.abs(ageDays - 2) < 0.01, `ageDays ≈ 2, got ${ageDays}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Structural wiring: exported constants exist and are sensible values
// ---------------------------------------------------------------------------

test("exported constants are in range", () => {
  assert.ok(
    CATCHUP_BASELINE_AGE_THRESHOLD_DAYS > 0 && CATCHUP_BASELINE_AGE_THRESHOLD_DAYS < 7,
    `CATCHUP_BASELINE_AGE_THRESHOLD_DAYS should be 1–7d, got ${CATCHUP_BASELINE_AGE_THRESHOLD_DAYS}`,
  );
  assert.ok(
    CATCHUP_MIN_HOURS_SINCE_LAST_TICK >= 1 && CATCHUP_MIN_HOURS_SINCE_LAST_TICK <= 24,
    `CATCHUP_MIN_HOURS_SINCE_LAST_TICK should be 1–24h, got ${CATCHUP_MIN_HOURS_SINCE_LAST_TICK}`,
  );
  assert.ok(
    CRASH_STREAK_ALERT_THRESHOLD >= 1,
    `CRASH_STREAK_ALERT_THRESHOLD must be ≥1, got ${CRASH_STREAK_ALERT_THRESHOLD}`,
  );
  assert.ok(LAST_TICK_STATE_PATH.endsWith(".json"), "LAST_TICK_STATE_PATH should be a JSON file");
  assert.ok(TICK_LOG_PATH.endsWith(".jsonl"), "TICK_LOG_PATH should be a JSONL file");
  assert.ok(
    DEFAULT_WATCHDOG_STALENESS_STATE_PATH.endsWith(".json"),
    "DEFAULT_WATCHDOG_STALENESS_STATE_PATH should be a JSON file",
  );
  // Task #4530 new constants.
  assert.ok(
    CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS >= 0.5 && CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS <= 4,
    `CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS should be 0.5–4h, got ${CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS}`,
  );
  assert.ok(
    ATTEMPT_ORPHAN_THRESHOLD_HOURS >= 1 && ATTEMPT_ORPHAN_THRESHOLD_HOURS <= 6,
    `ATTEMPT_ORPHAN_THRESHOLD_HOURS should be 1–6h, got ${ATTEMPT_ORPHAN_THRESHOLD_HOURS}`,
  );
  assert.ok(ATTEMPT_START_PATH.endsWith(".json"), "ATTEMPT_START_PATH should be a JSON file");
});

// ---------------------------------------------------------------------------
// 7. Task #4530 S1 — publisher gate
// ---------------------------------------------------------------------------

test("shouldRunCatchup: ineligible when publisherEnabled=false (task-branch env)", () => {
  const { eligible, reason } = shouldRunCatchup(openParams({ publisherEnabled: false }));
  assert.equal(eligible, false);
  assert.ok(
    reason.includes("publisher not enabled") || reason.includes("REGRESSION_SWEEP_PUBLISHER_ENABLED"),
    `reason: ${reason}`,
  );
});

test("shouldRunCatchup: publisher gate checked before baseline age (fail-fast)", () => {
  // Even with a stale baseline, ineligible when publisher is off.
  const { eligible } = shouldRunCatchup(
    openParams({ publisherEnabled: false, baselineAgeDays: 10 }),
  );
  assert.equal(eligible, false);
});

test("isPublisherEnabled: only explicit opt-in values enable it (on the main workspace)", () => {
  const origEnv = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  const MAIN = { isSubEnvironment: false };
  try {
    delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    assert.equal(isPublisherEnabled(MAIN), false, "unset → false (default OFF)");
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "1";
    assert.equal(isPublisherEnabled(MAIN), true);
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "true";
    assert.equal(isPublisherEnabled(MAIN), true);
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "0";
    assert.equal(isPublisherEnabled(MAIN), false);
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "false";
    assert.equal(isPublisherEnabled(MAIN), false);
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "";
    assert.equal(isPublisherEnabled(MAIN), false, "empty string → false");
  } finally {
    if (origEnv === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnv;
  }
});

test("isPublisherEnabled: flag set but sub-environment → DISABLED (structural gate)", () => {
  // The key safety property: Secrets and shared env vars propagate into task
  // environments, so the flag alone cannot be main-only. A task workspace
  // with the flag visible must still resolve publisher-disabled.
  const origEnv = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  try {
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "1";
    assert.equal(
      isPublisherEnabled({ isSubEnvironment: true }),
      false,
      "task sub-environment must resolve publisher-disabled even with the flag inherited",
    );
  } finally {
    if (origEnv === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnv;
  }
});

test("classifySubEnvironment: REPL_ID shape and main-repl remote probe outcomes", () => {
  const NO_REMOTE = { status: 1, stdout: "" }; // git config --get exits 1 when key absent
  const HAS_REMOTE = { status: 0, stdout: "git+ssh://git@example/workspace\n" };
  const GIT_ERROR = { status: null, stdout: "" };

  // Main workspace: bare uuid + no main-repl remote.
  assert.equal(classifySubEnvironment("a1b2c3d4-0000-0000-0000-000000000000", NO_REMOTE), false);
  // Task env tell #1: sub-scoped REPL_ID ("<uuid>:<subid>").
  assert.equal(classifySubEnvironment("a1b2c3d4-0000-0000-0000-000000000000:vi2e84zj", NO_REMOTE), true);
  // Task env tell #2: main-repl remote present (even with bare uuid).
  assert.equal(classifySubEnvironment("a1b2c3d4-0000-0000-0000-000000000000", HAS_REMOTE), true);
  // Fail closed: missing REPL_ID.
  assert.equal(classifySubEnvironment(undefined, NO_REMOTE), true);
  assert.equal(classifySubEnvironment("", NO_REMOTE), true);
  // Fail closed: git broken/unknown probe.
  assert.equal(classifySubEnvironment("a1b2c3d4-0000-0000-0000-000000000000", GIT_ERROR), true);
});

test("detectSubEnvironment: real-signal wiring matches the pure classifier", () => {
  // Consistency check that runs green in BOTH environments: the cached
  // real-signal detection must agree with classifySubEnvironment fed the
  // same live signals. On a task env both come out true; on main both false.
  const probe = spawnSync("git", ["config", "--get", "remote.main-repl.url"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const expected = classifySubEnvironment(process.env.REPL_ID, {
    status: probe.status,
    stdout: probe.stdout ?? "",
  });
  assert.equal(
    detectSubEnvironment(),
    expected,
    "detectSubEnvironment() must agree with classifySubEnvironment() on live signals",
  );
});

test("integration: THIS environment resolves the publisher gate correctly for its type", () => {
  // Live demonstration of the safety property (review-requested): a real task
  // workspace must resolve publisher-disabled even with the opt-in flag set
  // (Secrets and shared env vars propagate into clones), while the main
  // workspace lets the flag govern. Runs against the REAL environment signals
  // (REPL_ID shape + main-repl remote), so wherever this suite executes it
  // proves the gate resolves correctly for that environment type.
  const origEnv = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  try {
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "1";
    const enabled = isPublisherEnabled(); // no opts → real structural detection
    if (detectSubEnvironment()) {
      assert.equal(
        enabled,
        false,
        "real task sub-environment must resolve publisher-disabled even with the flag set",
      );
      const env = buildSweepSpawnEnv(); // real detection path
      assert.equal(
        env.TEST_GREEN_BASELINE_PUBLISH,
        undefined,
        "real task sub-environment must not inject the publish flag into sweep spawn envs",
      );
    } else {
      assert.equal(
        enabled,
        true,
        "main workspace with the flag set must resolve publisher-enabled",
      );
    }
  } finally {
    if (origEnv === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnv;
  }
});

// ---------------------------------------------------------------------------
// 8. Task #4530 S3 — attempt-start min-gap
// ---------------------------------------------------------------------------

test("shouldRunCatchup: ineligible when recent attempt start within min-gap window", () => {
  const recentStart = hoursAgo(CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS * 0.5);
  const { eligible, reason } = shouldRunCatchup(openParams({ lastAttemptStartedAt: recentStart }));
  assert.equal(eligible, false);
  assert.ok(reason.includes("attempt started") && reason.includes("min-gap"), `reason: ${reason}`);
});

test("shouldRunCatchup: eligible when attempt start is older than min-gap", () => {
  const oldStart = hoursAgo(CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS + 0.5);
  const { eligible } = shouldRunCatchup(openParams({ lastAttemptStartedAt: oldStart }));
  assert.equal(eligible, true);
});

test("shouldRunCatchup: eligible when lastAttemptStartedAt is null (no attempt yet)", () => {
  const { eligible } = shouldRunCatchup(openParams({ lastAttemptStartedAt: null }));
  assert.equal(eligible, true);
});

// ---------------------------------------------------------------------------
// 9. Task #4530 S2/S3 — watchdog state round-trip with daily alertedOn field
// ---------------------------------------------------------------------------

test("readWatchdogStalenessState / writeWatchdogStalenessState: round-trips with alertedOn", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-watchdog-daily-"));
  const statePath = join(dir, "watchdog.json");
  try {
    // Missing file → nulls (safe default).
    const empty = readWatchdogStalenessState(statePath);
    assert.equal(empty.publishedAt, null);
    assert.equal(empty.alertedOn, null);

    // Write and read back.
    writeWatchdogStalenessState(
      { publishedAt: "2026-08-08T02:39:00.000Z", alertedOn: "2026-08-11" },
      statePath,
    );
    const back = readWatchdogStalenessState(statePath);
    assert.equal(back.publishedAt, "2026-08-08T02:39:00.000Z");
    assert.equal(back.alertedOn, "2026-08-11");

    // Old-format file (no alertedOn field) → alertedOn is null (re-alerts once on upgrade).
    writeFileSync(statePath, JSON.stringify({ publishedAt: "2026-08-08T02:39:00.000Z" }), "utf8");
    const oldFormat = readWatchdogStalenessState(statePath);
    assert.equal(oldFormat.publishedAt, "2026-08-08T02:39:00.000Z");
    assert.equal(oldFormat.alertedOn, null, "old-format file → alertedOn null → re-alerts once");

    // Corrupt file → nulls (never throws).
    writeFileSync(statePath, "not json", "utf8");
    const corrupt = readWatchdogStalenessState(statePath);
    assert.equal(corrupt.publishedAt, null);
    assert.equal(corrupt.alertedOn, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWatchdogStalenessStamp compat shim returns publishedAt from new state format", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-watchdog-compat-"));
  const statePath = join(dir, "watchdog.json");
  try {
    writeWatchdogStalenessState(
      { publishedAt: "2026-08-08T02:39:00.000Z", alertedOn: "2026-08-11" },
      statePath,
    );
    assert.equal(readWatchdogStalenessStamp(statePath), "2026-08-08T02:39:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Task #4530 S3 — attempt-start state round-trip
// ---------------------------------------------------------------------------

test("readAttemptStartState / writeAttemptStartState: round-trip fidelity", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-attempt-start-"));
  const statePath = join(dir, "attempt.json");
  try {
    assert.equal(readAttemptStartState(statePath), null, "missing file → null");

    writeAttemptStartState({ startedAt: "2026-08-11T16:00:00.000Z", trigger: "catchup" }, statePath);
    const back = readAttemptStartState(statePath);
    assert.ok(back !== null);
    assert.equal(back!.startedAt, "2026-08-11T16:00:00.000Z");
    assert.equal(back!.trigger, "catchup");

    // Corrupt file → null (never throws).
    writeFileSync(statePath, "bad json", "utf8");
    assert.equal(readAttemptStartState(statePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Task #4530 S2 — daily cap persists even when Slack is disconnected
// ---------------------------------------------------------------------------

test("runStalenessWatchdogOnce: persists alertedOn when dispatcher returns skipped_slack_disconnected", async () => {
  // Regression: if alertedOn is only stamped on "delivered"/"skipped_deduped",
  // every 6-hour tick re-dispatches when Slack is disconnected, producing a
  // flood of in-app alerts. The fix: any non-null result stamps alertedOn.
  const dir = mkdtempSync(join(tmpdir(), "watchdog-slack-disconnected-"));
  const baselinePath = join(dir, "green-baseline.json");
  const watchdogStatePath = join(dir, "watchdog-state.json");
  const attemptStartPath = join(dir, "attempt-start.json");
  const now = new Date("2026-08-15T10:00:00.000Z");
  const todayUtc = now.toISOString().slice(0, 10);
  const stalePublishedAt = new Date(
    now.getTime() - (BASELINE_STALENESS_ALERT_DAYS + 1) * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    writeFileSync(baselinePath, JSON.stringify({ publishedAt: stalePublishedAt }), "utf8");

    // Stub dispatcher that simulates Slack being disconnected (non-null result).
    const slackDisconnectedStub: Parameters<typeof runStalenessWatchdogOnce>[0]["notifyFn"] =
      async () => ({ delivered: false, status: "skipped_slack_disconnected" }) as never;

    await runStalenessWatchdogOnce({
      now,
      baselinePath,
      watchdogStatePath,
      attemptStartPath,
      notifyFn: slackDisconnectedStub,
    });

    const state = readWatchdogStalenessState(watchdogStatePath);
    assert.equal(
      state.alertedOn,
      todayUtc,
      "alertedOn must be persisted even when Slack is disconnected (daily cap must hold)",
    );

    // Second call the same day: the cap must fire and NOT call notifyFn again.
    let secondCallCount = 0;
    const countingStub: Parameters<typeof runStalenessWatchdogOnce>[0]["notifyFn"] =
      async () => { secondCallCount++; return { delivered: false, status: "skipped_slack_disconnected" } as never; };

    await runStalenessWatchdogOnce({
      now,
      baselinePath,
      watchdogStatePath,
      attemptStartPath,
      notifyFn: countingStub,
    });

    assert.equal(secondCallCount, 0, "second tick same day must not call notifyFn again (daily cap)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. Task #4530 S1 — buildSweepSpawnEnv: all trigger paths gate the publish flag
// ---------------------------------------------------------------------------

test("buildSweepSpawnEnv: no TEST_GREEN_BASELINE_PUBLISH when publisher disabled", () => {
  const origEnabled = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  const origPublish = process.env.TEST_GREEN_BASELINE_PUBLISH;
  try {
    delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    delete process.env.TEST_GREEN_BASELINE_PUBLISH;
    const env = buildSweepSpawnEnv({ isSubEnvironment: false });
    assert.equal(
      env.TEST_GREEN_BASELINE_PUBLISH,
      undefined,
      "cron/catch-up/manual spawn must NOT include TEST_GREEN_BASELINE_PUBLISH when publisher opt-in absent",
    );
  } finally {
    if (origEnabled === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnabled;
    if (origPublish === undefined) delete process.env.TEST_GREEN_BASELINE_PUBLISH;
    else process.env.TEST_GREEN_BASELINE_PUBLISH = origPublish;
  }
});

test("buildSweepSpawnEnv: strips inherited TEST_GREEN_BASELINE_PUBLISH when publisher disabled", () => {
  // Regression: when the parent process already has TEST_GREEN_BASELINE_PUBLISH=1
  // (e.g. inherited from a CI wrapper), it must be stripped in task-branch envs.
  const origEnabled = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  const origPublish = process.env.TEST_GREEN_BASELINE_PUBLISH;
  try {
    delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    process.env.TEST_GREEN_BASELINE_PUBLISH = "1"; // simulate inherited value
    const env = buildSweepSpawnEnv({ isSubEnvironment: false });
    assert.equal(
      env.TEST_GREEN_BASELINE_PUBLISH,
      undefined,
      "inherited TEST_GREEN_BASELINE_PUBLISH=1 must be stripped when publisher opt-in is absent",
    );
  } finally {
    if (origEnabled === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnabled;
    if (origPublish === undefined) delete process.env.TEST_GREEN_BASELINE_PUBLISH;
    else process.env.TEST_GREEN_BASELINE_PUBLISH = origPublish;
  }
});

test("buildSweepSpawnEnv: includes TEST_GREEN_BASELINE_PUBLISH=1 when publisher enabled on main", () => {
  const origEnabled = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  try {
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "1";
    const env = buildSweepSpawnEnv({ isSubEnvironment: false });
    assert.equal(
      env.TEST_GREEN_BASELINE_PUBLISH,
      "1",
      "main workspace (publisher enabled) must get TEST_GREEN_BASELINE_PUBLISH=1 in spawn env",
    );
  } finally {
    if (origEnabled === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnabled;
  }
});

test("buildSweepSpawnEnv: task-branch env (REGRESSION_SWEEP_PUBLISHER_ENABLED=0) cannot publish", () => {
  const origEnabled = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  try {
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "0";
    const env = buildSweepSpawnEnv({ isSubEnvironment: false });
    assert.equal(
      env.TEST_GREEN_BASELINE_PUBLISH,
      undefined,
      "explicit '0' must not enable publishing",
    );
  } finally {
    if (origEnabled === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnabled;
  }
});

test("buildSweepSpawnEnv: sub-environment with flag inherited cannot publish (structural gate)", () => {
  // The Aug-2026 near-miss scenario: a task env inherits BOTH the opt-in flag
  // (via Secrets propagation) AND TEST_GREEN_BASELINE_PUBLISH=1 from a parent
  // process. The structural gate must strip the publish flag anyway.
  const origEnabled = process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
  const origPublish = process.env.TEST_GREEN_BASELINE_PUBLISH;
  try {
    process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = "1"; // inherited secret
    process.env.TEST_GREEN_BASELINE_PUBLISH = "1"; // inherited publish flag
    const env = buildSweepSpawnEnv({ isSubEnvironment: true });
    assert.equal(
      env.TEST_GREEN_BASELINE_PUBLISH,
      undefined,
      "task sub-environment must never spawn a publishing sweep, even with every flag inherited",
    );
  } finally {
    if (origEnabled === undefined) delete process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED;
    else process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED = origEnabled;
    if (origPublish === undefined) delete process.env.TEST_GREEN_BASELINE_PUBLISH;
    else process.env.TEST_GREEN_BASELINE_PUBLISH = origPublish;
  }
});

// ---------------------------------------------------------------------------
// 13. Task #4541 — the manual trigger (admin on-demand, Task #2625) must not
// open a second publish arm. runRegressionSweepNow("manual") funnels into the
// same runOnce as cron/catch-up, and runOnce's ONLY spawn env source is
// buildSweepSpawnEnv. This source-scan guard pins that structure so a future
// trigger path cannot quietly spawn the runner with a raw process.env (which
// would leak an inherited TEST_GREEN_BASELINE_PUBLISH=1 into a task env).
// ---------------------------------------------------------------------------

test("Task #4541: every sweep spawn in the scheduler routes its env through buildSweepSpawnEnv", () => {
  const source = readFileSync(
    "server/services/regressionSweepScheduler.ts",
    "utf8",
  );

  // (a) The manual trigger shares runOnce with cron/catch-up — no separate
  //     spawn path exists for "manual".
  assert.match(
    source,
    /runRegressionSweepNow\(\s*trigger:\s*"cron"\s*\|\s*"catchup"\s*\|\s*"manual"/,
    "runRegressionSweepNow must accept the manual trigger through the shared entrypoint",
  );

  // (b) Every spawn( call in the scheduler either passes env: buildSweepSpawnEnv()
  //     or passes no env at all is NOT acceptable — count spawn call sites and
  //     buildSweepSpawnEnv env usages and require they match.
  const spawnSites = source.match(/\bspawn\(/g) ?? [];
  const gatedEnvSites = source.match(/env:\s*buildSweepSpawnEnv\(/g) ?? [];
  assert.ok(spawnSites.length >= 1, "expected at least one sweep spawn site");
  assert.equal(
    gatedEnvSites.length,
    spawnSites.length,
    `every spawn( site (${spawnSites.length}) must set env: buildSweepSpawnEnv() ` +
      `(found ${gatedEnvSites.length}) — a raw process.env spawn could publish ` +
      `a diverged baseline from a task environment via an inherited flag`,
  );

  // (c) No literal TEST_GREEN_BASELINE_PUBLISH assignment outside
  //     buildSweepSpawnEnv (comments aside): the only `TEST_GREEN_BASELINE_PUBLISH:`
  //     object-key occurrence must be the one inside buildSweepSpawnEnv.
  const assignmentSites = source.match(/TEST_GREEN_BASELINE_PUBLISH:\s*"1"/g) ?? [];
  assert.equal(
    assignmentSites.length,
    1,
    "TEST_GREEN_BASELINE_PUBLISH must be injected in exactly one place (buildSweepSpawnEnv)",
  );
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
if (failures > 0) {
  console.error(`\n${failures} of ${tests.length} regression-sweep catch-up test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} regression-sweep catch-up tests passed.`);
process.exit(0);
