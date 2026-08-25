/* test-registration
{
  "name": "Slack auth breaker sustained watcher (Task #1610)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1610 regression coverage for the Slack auth circuit-breaker
 * sustained-trip watcher
 * (`server/services/slackAuthBreakerStuckAlerts.ts`).
 *
 * Locks the following behavior in place against future refactors:
 *
 *  1. Disabled via `slack_auth_breaker_alerts_enabled=false` → no alert
 *     (decision = `skipped_disabled`).
 *  2. Breaker open but minutes-since-last-success < threshold → no alert.
 *  3. Breaker open and minutes-since-last-success > threshold → alert
 *     fires exactly once and `lastAlert` is recorded.
 *  4. Second tick inside the cooldown window → `skipped_cooldown` (no
 *     duplicate dispatch).
 *  5. Second tick past the cooldown window with the breaker still stuck
 *     → fires again.
 *  6. Recovery: after a stuck alert, a successful Slack call (advancing
 *     `lastSuccessAt`) + closed breaker → exactly one
 *     `pipeline.slack_auth.breaker_recovered` alert, then quiet.
 *  6b. Repeated retrips on a permanently-broken token still cross
 *     threshold and alert (guards against anchoring the
 *     minutes-since-success clock to the unstable `lastTrippedAt`).
 *  7. Dispatcher-skip (Slack disconnected) does NOT arm `lastAlert`, so
 *     the next tick after the notification subsystem recovers can deliver.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkSlackAuthBreakerStuck,
  SETTING_COOLDOWN_MINUTES,
  SETTING_ENABLED,
  SETTING_THRESHOLD_MINUTES,
} from "../server/services/slackAuthBreakerStuckAlerts";
import {
  __resetSlackAuthBreakerForTest,
  __setSlackAuthStateForTest,
  getSlackAuthState,
} from "../server/services/slackIntegration";

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_THRESHOLD_MINUTES,
  SETTING_COOLDOWN_MINUTES,
] as const;

const THRESHOLD_MIN = 30;
const COOLDOWN_MIN = 360;

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function makeDispatcher(
  outcome: { delivered: boolean; status?: string; skipReason?: string } = {
    delivered: true,
    status: "success",
  },
): { fn: any; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return {
      delivered: outcome.delivered,
      status:
        outcome.status ?? (outcome.delivered ? "success" : "skipped_slack_disconnected"),
      skipReason: outcome.skipReason,
    };
  };
  return { fn, calls };
}

async function configure(opts: {
  enabled?: boolean;
  thresholdMinutes?: number;
  cooldownMinutes?: number;
}): Promise<void> {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(SETTING_ENABLED, opts.enabled ? "true" : "false", "system");
  }
  if (opts.thresholdMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_THRESHOLD_MINUTES,
      String(opts.thresholdMinutes),
      "system",
    );
  }
  if (opts.cooldownMinutes !== undefined) {
    await storage.setSystemSetting(
      SETTING_COOLDOWN_MINUTES,
      String(opts.cooldownMinutes),
      "system",
    );
  }
}

async function resetAll(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
  __resetSlackAuthBreakerForTest();
}

/**
 * Drive the breaker into "open + lastTrippedAt=X, no successes since"
 * by directly invoking the production trip path through a private import.
 * The watcher only reads `getSlackAuthState()` so we can use the
 * already-exported test seam to inspect, but to set state we need to
 * trip via the regular code path. Easiest: re-import the internal
 * `slackApiRequest` is not exported, so we use a tiny direct mutation
 * through the test-only reset + a synthetic dispatch via the public
 * `slackApiPost`? That requires a token. Instead use the existing
 * approach: monkey-patch `getSlackAuthState` for the watcher by
 * intercepting via `__testHelpers` is not available.
 *
 * Practical approach taken below: drive the breaker by invoking the
 * Slack `postMessage` path while stubbing global.fetch to return a
 * terminal auth-error response, then reset before the next scenario.
 * This exercises real control flow (Task #1610 spec point: watcher must
 * not change breaker behaviour).
 */
async function tripBreakerNow(errorCode = "invalid_auth"): Promise<void> {
  const realFetch = (globalThis as any).fetch;
  // Task #1820: route Upstash Redis REST calls back to the real fetch
  // so the system_settings read-through cache (which fires `cacheDel`
  // on every `storage.setSystemSetting` below) does not try to call
  // `.headers.get(...)` on the plain object we return for Slack and
  // crash with `[RedisCache] del error ns=system_settings: Cannot
  // read properties of undefined (reading 'get')`.
  const { isUpstashRedisUrl, makeUpstashPassthroughResponse } = await import(
    "./helpers/upstashFetchStub"
  );
  (globalThis as any).fetch = async (input: any, init?: any) => {
    if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: errorCode }),
    };
  };
  try {
    await storage.setSystemSetting("slack_bot_token", "xoxb-stub-test-token", "system");
    const { postMessage } = await import("../server/services/slackIntegration");
    try {
      await postMessage("C_TEST", "synthetic trip");
    } catch {
      // expected — terminal auth error throws after tripping breaker
    }
  } finally {
    (globalThis as any).fetch = realFetch;
    try {
      await storage.deleteSystemSetting("slack_bot_token");
    } catch {}
  }
}

async function recordSuccessNow(): Promise<void> {
  const realFetch = (globalThis as any).fetch;
  // Task #1820: same Upstash passthrough as `tripBreakerNow` so the
  // system_settings cache does not crash on the stubbed plain-object
  // response.
  const { isUpstashRedisUrl, makeUpstashPassthroughResponse } = await import(
    "./helpers/upstashFetchStub"
  );
  (globalThis as any).fetch = async (input: any, init?: any) => {
    if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, channel: "C_TEST", ts: "1.0" }),
    };
  };
  try {
    await storage.setSystemSetting("slack_bot_token", "xoxb-stub-test-token", "system");
    const { postMessage } = await import("../server/services/slackIntegration");
    await postMessage("C_TEST", "synthetic success");
  } finally {
    (globalThis as any).fetch = realFetch;
    try {
      await storage.deleteSystemSetting("slack_bot_token");
    } catch {}
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetAll();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

async function main(): Promise<void> {
  console.log("Slack auth breaker sustained-trip watcher regression (Task #1610)");

  // ── Scenario 1 — disabled → no alert ────────────────────────────────
  await step("disabled → skipped_disabled", async () => {
    await configure({ enabled: false, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    await tripBreakerNow();
    const { fn, calls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(fn);
    const r = await checkSlackAuthBreakerStuck(new Date(Date.now() + (THRESHOLD_MIN + 5) * 60_000));
    assert.equal(r.decision, "skipped_disabled");
    assert.equal(calls.length, 0);
  });

  // ── Scenario 2 — breaker open, below threshold → no alert ───────────
  await step("breaker open below threshold → skipped_below_threshold", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    await tripBreakerNow();
    const state = getSlackAuthState();
    assert.ok(state.breakerOpen, "precondition: breaker should be open after trip");
    assert.ok(state.lastTrippedAt, "precondition: lastTrippedAt should be set");
    const { fn, calls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(fn);
    // now = trip + 5 min, threshold = 30 min → below threshold
    const now = new Date(new Date(state.lastTrippedAt!).getTime() + 5 * 60_000);
    const r = await checkSlackAuthBreakerStuck(now);
    assert.equal(r.decision, "skipped_below_threshold", `decision=${r.decision} skipReason=${r.skipReason}`);
    assert.equal(calls.length, 0);
  });

  // ── Scenario 3 — breaker open past threshold → exactly one alert ────
  await step("breaker open past threshold → alerts exactly once", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    await tripBreakerNow("token_revoked");
    const state = getSlackAuthState();
    const now = new Date(new Date(state.lastTrippedAt!).getTime() + (THRESHOLD_MIN + 5) * 60_000);
    const { fn, calls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(fn);

    const r = await checkSlackAuthBreakerStuck(now);
    assert.equal(r.decision, "alerted", `decision=${r.decision} skipReason=${r.skipReason}`);
    assert.equal(r.alertsSent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, __testHelpers.STUCK_NOTIFICATION_ID);
    assert.match(calls[0].text, /token_revoked/);
    assert.ok(__testHelpers.getLastAlertForTests(), "lastAlert must be recorded");
  });

  // ── Scenario 4 — second tick inside cooldown → skipped_cooldown ─────
  await step("second tick inside cooldown → skipped_cooldown", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    await tripBreakerNow();
    const state = getSlackAuthState();
    const trippedAt = new Date(state.lastTrippedAt!).getTime();
    const { fn, calls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(fn);

    const first = await checkSlackAuthBreakerStuck(new Date(trippedAt + (THRESHOLD_MIN + 5) * 60_000));
    assert.equal(first.decision, "alerted");
    assert.equal(calls.length, 1);

    const insideCooldown = new Date(trippedAt + (THRESHOLD_MIN + 5 + COOLDOWN_MIN - 1) * 60_000);
    const second = await checkSlackAuthBreakerStuck(insideCooldown);
    assert.equal(second.decision, "skipped_cooldown", `decision=${second.decision}`);
    assert.match(second.skipReason ?? "", /cooldown/);
    assert.equal(calls.length, 1);
  });

  // ── Scenario 5 — past cooldown the watcher fires again ──────────────
  await step("past cooldown with still-stuck breaker → fires again", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    await tripBreakerNow();
    const state = getSlackAuthState();
    const trippedAt = new Date(state.lastTrippedAt!).getTime();
    const { fn, calls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(fn);

    const first = await checkSlackAuthBreakerStuck(new Date(trippedAt + (THRESHOLD_MIN + 5) * 60_000));
    assert.equal(first.decision, "alerted");
    assert.equal(calls.length, 1);

    const pastCooldown = new Date(trippedAt + (THRESHOLD_MIN + 5 + COOLDOWN_MIN + 1) * 60_000);
    const second = await checkSlackAuthBreakerStuck(pastCooldown);
    assert.equal(second.decision, "alerted", `decision=${second.decision}`);
    assert.equal(calls.length, 2);
  });

  // ── Scenario 6 — recovery alert exactly once ────────────────────────
  await step("recovery → recovered alert exactly once, then quiet", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    // Synthesize a "tripped N min ago, breaker still open" state via the
    // test seam so we can drive the stuck → recovered transition without
    // wall-clock waits and without depending on stub fetch state across
    // both branches.
    const T0 = Date.now();
    __setSlackAuthStateForTest({
      lastTrippedAtMs: T0,
      lastTrippedCode: "token_revoked",
      lastSuccessAtMs: null,
      breakerOpenUntilMs: T0 + 5 * 60_000,
      tripCount: 1,
    });
    const stuckNow = new Date(T0 + (THRESHOLD_MIN + 5) * 60_000);
    const { fn: stuckFn, calls: stuckCalls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(stuckFn);

    const stuck = await checkSlackAuthBreakerStuck(stuckNow);
    assert.equal(stuck.decision, "alerted", `decision=${stuck.decision}`);
    assert.equal(stuckCalls.length, 1);
    assert.equal(stuckCalls[0].id, __testHelpers.STUCK_NOTIFICATION_ID);

    // Simulate Slack auth recovery: lastSuccessAt advances past the
    // stuck alert's alertedAt, and the breaker has closed.
    const recoveryAt = stuckNow.getTime() + 2 * 60_000;
    __setSlackAuthStateForTest({
      lastSuccessAtMs: recoveryAt,
      breakerOpenUntilMs: 0,
    });

    const { fn: recFn, calls: recCalls } = makeDispatcher();
    __testHelpers.setDispatcherForTests(recFn);

    const r = await checkSlackAuthBreakerStuck(new Date(recoveryAt + 60_000));
    assert.equal(r.decision, "recovered", `decision=${r.decision} skipReason=${r.skipReason}`);
    assert.equal(r.alertsSent, 1);
    assert.equal(recCalls.length, 1);
    assert.equal(recCalls[0].id, __testHelpers.RECOVERED_NOTIFICATION_ID);

    // A second tick should be quiet — lastAlert was cleared by recovery.
    const r2 = await checkSlackAuthBreakerStuck(new Date(recoveryAt + 120_000));
    assert.notEqual(r2.decision, "recovered", "must not re-emit recovery");
    assert.equal(recCalls.length, 1, "no second recovery dispatch");
  });

  // ── Scenario 6b — repeated retrips on a permanently broken token ────
  // Guard against regression to the pre-fix behavior where
  // `referenceSuccess` was anchored to `lastTrippedAt`. If the breaker
  // re-trips every cycle (real "token revoked, nobody re-auths"
  // scenario) the clock used to never advance past threshold. With the
  // safer fallback ordering (lastSuccessAt → slackSetupAt → bootTime
  // → lastTrippedAt) the watcher must still cross threshold and fire.
  await step(
    "repeated retrips on permanently-broken token still cross threshold and alert",
    async () => {
      await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
      // No successes ever recorded; lastTrippedAt was just retripped a
      // minute ago (this is the unstable anchor the fix is guarding
      // against — under the buggy ordering, minutesSinceSuccess would
      // be ~1 here and the watcher would never fire). The integration
      // setup time / boot time anchor must take precedence.
      const NOW = Date.now();
      __setSlackAuthStateForTest({
        lastTrippedAtMs: NOW - 60_000,
        lastTrippedCode: "invalid_auth",
        lastSuccessAtMs: null,
        breakerOpenUntilMs: NOW + 4 * 60_000,
        tripCount: 10,
      });

      // Ensure no slack_bot_token row exists in this dev DB so the
      // setupAt anchor falls back to boot time (which, in this test
      // run, is well past THRESHOLD_MIN ago — node has been alive
      // long enough). If a token row IS present (workspace state),
      // its updatedAt is almost certainly older than THRESHOLD_MIN
      // too — either way the watcher must fire.
      const { fn, calls } = makeDispatcher();
      __testHelpers.setDispatcherForTests(fn);

      // Force a far-past boot anchor by waiting a tiny bit then
      // calling at "now + THRESHOLD_MIN + 10 min" — the real anchor
      // (boot or setupAt) is even further in the past, so we just
      // sanity-check that lastTrippedAt is NOT the chosen anchor.
      const evalNow = new Date(NOW + (THRESHOLD_MIN + 10) * 60_000);
      const r = await checkSlackAuthBreakerStuck(evalNow);
      assert.equal(
        r.decision,
        "alerted",
        `decision=${r.decision} skipReason=${r.skipReason} — watcher must NOT anchor to lastTrippedAt`,
      );
      assert.equal(r.alertsSent, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, __testHelpers.STUCK_NOTIFICATION_ID);
    },
  );

  await step("dispatcher-skip does NOT arm lastAlert; next healthy tick delivers", async () => {
    await configure({ enabled: true, thresholdMinutes: THRESHOLD_MIN, cooldownMinutes: COOLDOWN_MIN });
    await tripBreakerNow();
    const state = getSlackAuthState();
    const trippedAt = new Date(state.lastTrippedAt!).getTime();
    const now = new Date(trippedAt + (THRESHOLD_MIN + 5) * 60_000);

    const skipped = makeDispatcher({
      delivered: false,
      status: "skipped_slack_disconnected",
      skipReason: "slack_breaker_open",
    });
    __testHelpers.setDispatcherForTests(skipped.fn);
    const r1 = await checkSlackAuthBreakerStuck(now);
    assert.equal(r1.decision, "skipped_dispatcher_skipped", `decision=${r1.decision}`);
    assert.equal(r1.alertsSent, 0);
    assert.equal(skipped.calls.length, 1, "dispatcher SHOULD have been called");
    assert.equal(__testHelpers.getLastAlertForTests(), null, "lastAlert must NOT be set");

    const healthy = makeDispatcher({ delivered: true, status: "success" });
    __testHelpers.setDispatcherForTests(healthy.fn);
    const r2 = await checkSlackAuthBreakerStuck(now);
    assert.equal(r2.decision, "alerted", `decision=${r2.decision} skipReason=${r2.skipReason}`);
    assert.equal(r2.alertsSent, 1);
    assert.equal(healthy.calls.length, 1);
  });

  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
  console.log("\nAll Slack auth breaker sustained-trip watcher tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
