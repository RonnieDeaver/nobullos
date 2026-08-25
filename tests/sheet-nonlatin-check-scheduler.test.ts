/* test-registration
{
  "name": "Sheet non-Latin check scheduler decision logic (Task #4729)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4729: the weekly non-Latin typing check's alerting is the ONLY automated detector of the 2026-08-11 silent-harness-breakage class; this suite pins the pure decision logic (workspace gating fail-closed, failure-notification day-scoped dedupe, staleness threshold + once-per-day stamp semantics incl. stamp-persists-on-non-null-dispatch) with injected clocks/paths/notify stubs. Sub-second, no DB, no processes — a bug here means either alert floods or a silently dead safety check.",
  "tier": "small"
}
test-registration */
/**
 * Task #4729 — unit coverage of server/services/sheetNonlatinCheckScheduler.ts
 * pure decision functions. The run leg (npm build + puppeteer harness) is
 * deliberately NOT executed here — it is a weekly dev-workspace sweep; this
 * suite proves the gating and alerting decisions around it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  classifySchedulerRefusal,
  classifyWorkspaceRefusal,
  classifyStaleness,
  buildFailureNotification,
  readLastResult,
  readCheckState,
  recordRunResult,
  readWatchdogState,
  writeWatchdogState,
  runSheetNonlatinStalenessWatchdogOnce,
  startSheetNonlatinCheckScheduler,
  stopSheetNonlatinCheckScheduler,
  getSheetNonlatinCheckSchedulerState,
  STALENESS_ALERT_DAYS,
  type CheckRunResult,
} from "../server/services/sheetNonlatinCheckScheduler";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// Injected pinned clock — all staleness math runs against it, never the real
// clock.
const NOW = new Date("2026-08-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function result(overrides: Partial<CheckRunResult>): CheckRunResult {
  return {
    startedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    finishedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    ok: true,
    phase: "harness",
    exitCode: 0,
    logTail: "PASS",
    trigger: "cron",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

test("refuses deployments", () => {
  const r = classifySchedulerRefusal({ inDeployment: true, isSubEnvironment: false });
  assert.match(r ?? "", /deployment/);
});

test("refuses task/sub-environments (fail closed)", () => {
  const r = classifySchedulerRefusal({ inDeployment: false, isSubEnvironment: true });
  assert.match(r ?? "", /sub-environment/);
});

test("kill switch refuses the RUN scheduler but NOT workspace eligibility", () => {
  const env = { SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED: "false" } as NodeJS.ProcessEnv;
  const run = classifySchedulerRefusal({ inDeployment: false, isSubEnvironment: false, env });
  assert.match(run ?? "", /disabled/);
  // The watchdog gates only on workspace eligibility — a kill switch left
  // off is one of the silent-failure classes it must keep catching.
  const ws = classifyWorkspaceRefusal({ inDeployment: false, isSubEnvironment: false });
  assert.equal(ws, null);
});

test("REGRESSION boot wiring: disabled runner still starts the watchdog and dispatches staleness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-boot-"));
  const dispatched: string[] = [];
  try {
    await startSheetNonlatinCheckScheduler({
      inDeployment: false,
      isSubEnvironment: false,
      env: { SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED: "false" } as NodeJS.ProcessEnv,
      watchdogOpts: {
        now: NOW,
        statePath: join(dir, "last.json"), // no run recorded → stale
        watchdogStatePath: join(dir, "wd.json"),
        notifyFn: (async (_id: string, payload: { text: string }) => {
          dispatched.push(payload.text);
          return { outcome: "delivered" };
        }) as any,
      },
    });
    // Boot watchdog tick is fire-and-forget; let its microtasks settle.
    await new Promise((r) => setTimeout(r, 50));
    const state = getSheetNonlatinCheckSchedulerState();
    assert.equal(state.running, false, "cron leg must stay off under the kill switch");
    assert.equal(state.watchdogRunning, true, "watchdog must run despite the kill switch");
    assert.equal(dispatched.length, 1, "boot watchdog dispatches the staleness alert");
    assert.match(dispatched[0], /no successful/);
  } finally {
    stopSheetNonlatinCheckScheduler();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boot wiring: deployment / sub-environment starts NEITHER leg", async () => {
  for (const overrides of [
    { inDeployment: true, isSubEnvironment: false },
    { inDeployment: false, isSubEnvironment: true },
  ]) {
    await startSheetNonlatinCheckScheduler({
      ...overrides,
      watchdogOpts: {
        notifyFn: (async () => {
          throw new Error("must not dispatch");
        }) as any,
      },
    });
    const state = getSheetNonlatinCheckSchedulerState();
    assert.equal(state.running, false);
    assert.equal(state.watchdogRunning, false);
    stopSheetNonlatinCheckScheduler();
  }
});

test("kill switch env disables; default is ON", () => {
  const off = classifySchedulerRefusal({
    inDeployment: false,
    isSubEnvironment: false,
    env: { SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED: "false" },
  });
  assert.match(off ?? "", /SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED/);
  const on = classifySchedulerRefusal({
    inDeployment: false,
    isSubEnvironment: false,
    env: {},
  });
  assert.equal(on, null);
});

// ---------------------------------------------------------------------------
// Failure notification
// ---------------------------------------------------------------------------

test("failure notification names the failed leg and uses a day-scoped dedupe key", () => {
  const n = buildFailureNotification(
    result({ ok: false, phase: "build", exitCode: 1, logTail: "vite exploded" }),
    NOW,
  );
  assert.match(n.text, /production build/);
  assert.match(n.text, /vite exploded/);
  assert.equal(n.dedupeKey, "sheet-nonlatin-check-failed:2026-08-13");
  const h = buildFailureNotification(result({ ok: false, exitCode: 1 }), NOW);
  assert.match(h.text, /typing harness/);
});

// ---------------------------------------------------------------------------
// Staleness decision
// ---------------------------------------------------------------------------

test("fresh success within threshold → no alert", () => {
  const d = classifyStaleness({
    now: NOW,
    lastResult: result({
      finishedAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
    }),
    watchdog: { alertedOn: null },
  });
  assert.equal(d, null);
});

test("success older than threshold → alert with day-scoped dedupe key", () => {
  const d = classifyStaleness({
    now: NOW,
    lastResult: result({
      finishedAt: new Date(
        NOW.getTime() - (STALENESS_ALERT_DAYS + 1) * DAY_MS,
      ).toISOString(),
    }),
    watchdog: { alertedOn: null },
  });
  assert.ok(d);
  assert.match(d!.text, /no successful\s+run within/);
  assert.equal(d!.dedupeKey, "sheet-nonlatin-check-stale:2026-08-13");
});

test("last run failed (never a success) → alert names the failed leg", () => {
  const d = classifyStaleness({
    now: NOW,
    lastResult: result({ ok: false, phase: "harness", exitCode: 1 }),
    watchdog: { alertedOn: null },
  });
  assert.ok(d);
  assert.match(d!.text, /FAILED at the harness leg/);
});

test("REGRESSION: a failed attempt after a fresh success does NOT fake staleness", () => {
  // The success record must survive a later failed attempt — one failed
  // Saturday within the threshold is the failure-alert lane's job, not an
  // immediate "no success on record" staleness alert.
  const d = classifyStaleness({
    now: NOW,
    lastResult: result({ ok: false, phase: "harness", exitCode: 1 }),
    lastSuccessAt: new Date(NOW.getTime() - 5 * DAY_MS).toISOString(),
    watchdog: { alertedOn: null },
  });
  assert.equal(d, null);
});

test("REGRESSION: recordRunResult preserves lastSuccessAt across a later failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-succ-"));
  try {
    const statePath = join(dir, "last.json");
    const ledgerPath = join(dir, "ledger.jsonl");
    const successAt = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    recordRunResult(result({ ok: true, finishedAt: successAt }), { statePath, ledgerPath });
    recordRunResult(result({ ok: false, exitCode: 1 }), { statePath, ledgerPath });
    const state = readCheckState(statePath);
    assert.equal(state.lastResult?.ok, false);
    assert.equal(state.lastSuccessAt, successAt);
    // End-to-end: the watchdog reads this state and stays silent within threshold.
    let called = 0;
    await runSheetNonlatinStalenessWatchdogOnce({
      now: NOW,
      statePath,
      watchdogStatePath: join(dir, "wd.json"),
      notifyFn: (async () => {
        called++;
        return { outcome: "delivered" };
      }) as any,
    });
    assert.equal(called, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy bare-result state file: success implies lastSuccessAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-legacy-"));
  try {
    const statePath = join(dir, "last.json");
    const r = result({});
    writeFileSync(statePath, JSON.stringify(r));
    const state = readCheckState(statePath);
    assert.equal(state.lastResult?.finishedAt, r.finishedAt);
    assert.equal(state.lastSuccessAt, r.finishedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no run ever recorded → alert (a never-scheduled check is the incident class)", () => {
  const d = classifyStaleness({ now: NOW, lastResult: null, watchdog: { alertedOn: null } });
  assert.ok(d);
  assert.match(d!.text, /No run has ever been recorded/);
});

test("already alerted today → silent; a new calendar day re-alerts", () => {
  const stale = result({
    finishedAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString(),
  });
  const today = classifyStaleness({
    now: NOW,
    lastResult: stale,
    watchdog: { alertedOn: "2026-08-13" },
  });
  assert.equal(today, null);
  const nextDay = classifyStaleness({
    now: new Date(NOW.getTime() + DAY_MS),
    lastResult: stale,
    watchdog: { alertedOn: "2026-08-13" },
  });
  assert.ok(nextDay);
  assert.equal(nextDay!.dedupeKey, "sheet-nonlatin-check-stale:2026-08-14");
});

// ---------------------------------------------------------------------------
// Watchdog runner: stamp persistence + state round-trips (tmp-dir paths)
// ---------------------------------------------------------------------------

test("watchdog persists the daily stamp on ANY non-null dispatch result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-wd-"));
  try {
    const statePath = join(dir, "last.json");
    const watchdogStatePath = join(dir, "wd.json");
    const calls: string[] = [];
    // skipped_slack_disconnected is non-null → stamp must persist (flood guard).
    const notifyFn = (async (_id: string, payload: any) => {
      calls.push(payload.text);
      return { outcome: "skipped_slack_disconnected" };
    }) as any;
    await runSheetNonlatinStalenessWatchdogOnce({
      now: NOW,
      statePath,
      watchdogStatePath,
      notifyFn,
    });
    assert.equal(calls.length, 1);
    assert.equal(readWatchdogState(watchdogStatePath).alertedOn, "2026-08-13");
    // Second tick same day: no second dispatch.
    await runSheetNonlatinStalenessWatchdogOnce({
      now: NOW,
      statePath,
      watchdogStatePath,
      notifyFn,
    });
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: a notify throw leaves the stamp unset so the next tick retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-wd-"));
  try {
    const statePath = join(dir, "last.json");
    const watchdogStatePath = join(dir, "wd.json");
    const notifyFn = (async () => {
      throw new Error("transient");
    }) as any;
    await runSheetNonlatinStalenessWatchdogOnce({
      now: NOW,
      statePath,
      watchdogStatePath,
      notifyFn,
    });
    assert.equal(readWatchdogState(watchdogStatePath).alertedOn, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh success clears a stale daily stamp so a future episode alerts again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-wd-"));
  try {
    const statePath = join(dir, "last.json");
    const watchdogStatePath = join(dir, "wd.json");
    recordRunResult(result({}), { statePath, ledgerPath: join(dir, "ledger.jsonl") });
    writeWatchdogState({ alertedOn: "2026-08-10" }, watchdogStatePath);
    let called = 0;
    await runSheetNonlatinStalenessWatchdogOnce({
      now: NOW,
      statePath,
      watchdogStatePath,
      notifyFn: (async () => {
        called++;
        return { outcome: "delivered" };
      }) as any,
    });
    assert.equal(called, 0);
    assert.equal(readWatchdogState(watchdogStatePath).alertedOn, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("result state round-trip + corrupt state reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "nonlatin-state-"));
  try {
    const statePath = join(dir, "last.json");
    const ledgerPath = join(dir, "ledger.jsonl");
    const r = result({ ok: false, phase: "build", exitCode: 2, logTail: "boom" });
    recordRunResult(r, { statePath, ledgerPath });
    assert.deepEqual(readLastResult(statePath), r);
    writeFileSync(statePath, "{not json");
    assert.equal(readLastResult(statePath), null);
    assert.equal(readLastResult(join(dir, "absent.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`not ok - ${t.name}`);
      console.error(err);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${tests.length} tests failed`);
    process.exit(1);
  }
  console.log(`All ${tests.length} tests passed`);
}

void main();
