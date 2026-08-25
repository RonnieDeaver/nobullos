/* test-registration
{
  "name": "Front finish message grain driver (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2529 — Automatic finishing of Front message-grain coverage.
 *
 * Pins the bounded, default-OFF dedicated driver
 * (`frontFinishMessageGrainDriver`) that keeps every in-scope Front coverage
 * month at message grain on a cadence WITHOUT requiring the global
 * `enable_prod_action_self_heal` master switch — the automated counterpart to
 * the Task #2511 one-press `finish_front_message_grain_coverage` control.
 *
 * Unlike the Task #2365 UPGRADE driver, this one does no selection of its own:
 * each tick simply invokes the SAME shared apply path the operator presses
 * (`applyFinishFrontMessageGrainCoverage`). The real apply path issues live
 * Front HTTP traffic, so the test injects a deterministic stand-in via the
 * driver's test seam and pins the GATING + outcome bookkeeping without a live
 * Front:
 *
 *   1. Master switch OFF (default) → no-op with a `disabled` reason; the apply
 *      path is never invoked.
 *   2. Enabled + Front auth breaker OPEN → outcome `blocked` (reconnect Front);
 *      the apply path is never invoked, and it is NOT a failed run.
 *   3. Enabled + breaker closed → the apply path runs exactly once; its
 *      outcome (`applied` + `rowsAffected`) is propagated and the last-run
 *      summary is persisted.
 *   4. Enabled + the apply path THROWS → outcome `error` carrying the message;
 *      non-throwing by contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  setSystemSetting,
  getSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";
import {
  runFinishMessageGrainTick,
  readLastFinishMessageGrainRun,
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  __frontFinishMessageGrainTestHelpers as H,
} from "../server/services/frontFinishMessageGrainDriver";

test("Task #2529 finish-message-grain driver gating", async (t) => {
  H.setApplyOverride(null);
  __resetFrontAuthBreakerForTest();

  // Snapshot + restore every setting this driver reads/writes so a loaded dev
  // DB is left exactly as we found it.
  const saved: Record<string, string | undefined> = {};
  for (const k of [SETTING_ENABLED, SETTING_LAST_RUN]) {
    saved[k] = (await getSystemSetting(k).catch(() => null))?.value;
  }

  t.after(async () => {
    H.setApplyOverride(null);
    __resetFrontAuthBreakerForTest();
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) await deleteSystemSetting(k);
      else await setSystemSetting(k, v, "system");
    }
  });

  // ── 1. Master switch OFF (default) → no-op, never invokes apply. ──────
  await t.test("disabled → reason, no apply", async () => {
    await setSystemSetting(SETTING_ENABLED, "false", "system");
    __resetFrontAuthBreakerForTest();
    let applied = false;
    H.setApplyOverride(async () => {
      applied = true;
      return { state: "applied" as const };
    });
    const r = await runFinishMessageGrainTick();
    assert.equal(r.enabled, false);
    assert.equal(r.applied, false, "never invokes apply while disabled");
    assert.match(r.reason ?? "", /disabled/);
    assert.equal(applied, false);
  });

  // ── 2. Enabled + breaker OPEN → blocked, never invokes apply. ─────────
  await t.test("breaker open → blocked, no apply", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    tripFrontAuthBreaker("front_not_connected");
    let applied = false;
    H.setApplyOverride(async () => {
      applied = true;
      return { state: "applied" as const };
    });
    const r = await runFinishMessageGrainTick();
    assert.equal(r.enabled, true);
    assert.equal(r.breakerOpen, true);
    assert.equal(r.outcomeState, "blocked");
    assert.equal(r.applied, false, "never invokes apply while breaker is open");
    assert.match(r.reason ?? "", /breaker|reconnect/i);
    assert.equal(applied, false);
    __resetFrontAuthBreakerForTest();
  });

  // ── 3. Enabled + breaker closed → apply runs once; outcome propagated. ─
  await t.test("enabled + breaker closed → apply invoked, outcome propagated", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    __resetFrontAuthBreakerForTest();
    let calls = 0;
    H.setApplyOverride(async (actorId) => {
      calls += 1;
      assert.equal(actorId, null, "scheduled tick runs as the system actor");
      return { state: "applied" as const, detail: "did work", rowsAffected: 7 };
    });
    const r = await runFinishMessageGrainTick();
    assert.equal(r.applied, true);
    assert.equal(calls, 1, "apply invoked exactly once");
    assert.equal(r.outcomeState, "applied");
    assert.equal(r.rowsAffected, 7);
    assert.equal(r.detail, "did work");
    // Persisted last-run summary reflects the tick.
    const last = await readLastFinishMessageGrainRun();
    assert.equal(last.status, "ok");
    assert.ok(last.lastRun && last.lastRun.outcomeState === "applied");
  });

  // ── 4. Enabled + apply THROWS → outcome `error`, non-throwing. ────────
  await t.test("apply throws → error outcome, never throws", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    __resetFrontAuthBreakerForTest();
    H.setApplyOverride(async () => {
      throw new Error("front blew up");
    });
    const r = await runFinishMessageGrainTick();
    assert.equal(r.applied, true);
    assert.equal(r.outcomeState, "error");
    assert.match(r.detail ?? "", /front blew up/);
  });
});
