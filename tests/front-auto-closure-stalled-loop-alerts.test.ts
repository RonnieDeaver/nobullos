/* test-registration
{
  "name": "Front auto-closure loop-stalled watcher (Task #1689)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1689 regression coverage for the Front auto-closure
 * loop-stalled watcher
 * (`server/services/frontAutoClosureStalledLoopAlerts.ts`).
 *
 * Mirrors `tests/slack-auth-breaker-stuck-alerts.test.ts` (Task #1610).
 * Locks the following behavior in place against future refactors:
 *
 *   1. Disabled via `front_auto_closure_stalled_loop_alerts_enabled=false`
 *      → no alert (decision = `skipped_disabled`).
 *   2. Fresh summary + no self-error → no alert
 *      (decision = `skipped_below_threshold`).
 *   3. Stale summary past threshold → alert fires exactly once and
 *      `lastAlert` is recorded.
 *   4. Second tick inside cooldown window → `skipped_cooldown`.
 *   5. Second tick past cooldown window with summary still stale →
 *      fires again.
 *   6. Recovery: after a stuck alert, a fresh summary with
 *      `lastSelfError == null` → exactly one
 *      `pipeline.front_auto_closure.loop_recovered`, then quiet.
 *   7. Dispatcher-skip (Slack disconnected) does NOT arm `lastAlert`,
 *      so the next tick after the notification subsystem recovers can
 *      deliver.
 *   8. Self-error streak: `lastSelfError` non-null on N consecutive
 *      NEW `ranAt` ticks → alert fires; repeated polls of the same
 *      `ranAt` between auto-closer runs do NOT inflate the streak.
 *   9. No summary persisted → `skipped_no_summary` (stays quiet).
 *
 * Task #2200 — the alerter config is driven entirely through the
 * in-memory `setConfigForTests` override (and the status/dispatcher
 * overrides) so the test writes NO shared `system_settings` rows. This
 * makes it immune to the always-on `Start application` scheduler that
 * also reads/writes those rows, without needing a per-test schema or
 * disabling the dev-server scheduler. (Supersedes the Task #1929
 * `runInIsolatedSchema` approach.)
 */
import assert from "node:assert/strict";
import {
  __frontAutoClosureStalledLoopTestHelpers as helpers,
  checkFrontAutoClosureStalledLoop,
  type FrontAutoClosureStalledConfig,
} from "../server/services/frontAutoClosureStalledLoopAlerts";

const THRESHOLD_MIN = helpers.DEFAULTS.thresholdMinutes; // 30
const COOLDOWN_MIN = helpers.DEFAULTS.cooldownMinutes; // 360
const STREAK_DEFAULT = helpers.DEFAULTS.selfErrorStreak; // 3

const STUCK_ID = helpers.STUCK_NOTIFICATION_ID;
const RECOVERED_ID = helpers.RECOVERED_NOTIFICATION_ID;

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
        outcome.status ?? (outcome.delivered ? "success" : "skipped"),
      skipReason: outcome.skipReason,
    };
  };
  return { fn, calls };
}

interface FakeSummary {
  ranAt: string;
  lastSelfError?: string | null;
  skippedReason?: string | null;
}

function makeStatusProvider(opts: {
  summary: FakeSummary | null;
  enabled?: boolean;
}): any {
  return async () => ({
    config: { enabled: opts.enabled ?? true },
    lastSummary: opts.summary
      ? {
          ranAt: opts.summary.ranAt,
          lastSelfError: opts.summary.lastSelfError ?? null,
          skippedReason: opts.summary.skippedReason ?? null,
        }
      : null,
  });
}

// Task #2200 — set the alerter config via the in-memory override
// instead of writing the shared `system_settings` config rows. Each
// scenario already supplies all four fields; unspecified fields fall
// back to the production defaults.
function configure(opts: {
  enabled?: boolean;
  thresholdMinutes?: number;
  cooldownMinutes?: number;
  selfErrorStreak?: number;
}): void {
  const cfg: FrontAutoClosureStalledConfig = {
    enabled: opts.enabled ?? true,
    thresholdMinutes: opts.thresholdMinutes ?? THRESHOLD_MIN,
    cooldownMinutes: opts.cooldownMinutes ?? COOLDOWN_MIN,
    selfErrorStreak: opts.selfErrorStreak ?? STREAK_DEFAULT,
  };
  helpers.setConfigForTests(cfg);
}

async function resetInMemory(): Promise<void> {
  helpers.resetStateForTests();
  helpers.setDispatcherForTests(null);
  helpers.setStatusProviderForTests(null);
  helpers.setConfigForTests(null);
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetInMemory();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetInMemory();
  }
}

async function main(): Promise<void> {
  console.log(
    "Front auto-closure loop-stalled watcher regression (Task #1689)",
  );

  // Task #2200 — scenarios run directly (no isolated schema): config,
  // status, dispatcher and alerter state are all in-memory overrides, so
  // there are no shared `system_settings` writes left to isolate.
  {
      // ── Scenario 1 — disabled → no alert ──────────────────────────────
      await step("disabled → skipped_disabled", async () => {
        await configure({
          enabled: false,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const now = new Date("2026-05-21T10:00:00Z");
        helpers.setStatusProviderForTests(
          makeStatusProvider({
            summary: {
              ranAt: new Date(now.getTime() - 90 * 60_000).toISOString(),
            },
          }),
        );
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r = await checkFrontAutoClosureStalledLoop(now);
        assert.equal(r.decision, "skipped_disabled");
        assert.equal(calls.length, 0);
      });

      // ── Scenario 2 — fresh + no self-error → no alert ─────────────────
      await step("fresh summary → skipped_below_threshold", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const now = new Date("2026-05-21T10:00:00Z");
        helpers.setStatusProviderForTests(
          makeStatusProvider({
            summary: {
              ranAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
            },
          }),
        );
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r = await checkFrontAutoClosureStalledLoop(now);
        assert.equal(r.decision, "skipped_below_threshold");
        assert.equal(calls.length, 0);
      });

      // ── Scenario 3 — stale past threshold → alert once ────────────────
      await step("stale past threshold → alerted once", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const now = new Date("2026-05-21T10:00:00Z");
        helpers.setStatusProviderForTests(
          makeStatusProvider({
            summary: {
              ranAt: new Date(
                now.getTime() - (THRESHOLD_MIN + 15) * 60_000,
              ).toISOString(),
            },
          }),
        );
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r = await checkFrontAutoClosureStalledLoop(now);
        assert.equal(r.decision, "alerted");
        assert.equal(r.alertsSent, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].id, STUCK_ID);
        assert.equal((calls[0].metadata as any).reason, "stale_summary");
        assert.ok(r.lastAlert);
        assert.equal(r.lastAlert!.reason, "stale_summary");
      });

      // ── Scenario 4 — second tick inside cooldown → skipped ────────────
      await step("inside cooldown → skipped_cooldown", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const t1 = new Date("2026-05-21T10:00:00Z");
        helpers.setStatusProviderForTests(
          makeStatusProvider({
            summary: {
              ranAt: new Date(
                t1.getTime() - (THRESHOLD_MIN + 15) * 60_000,
              ).toISOString(),
            },
          }),
        );
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r1 = await checkFrontAutoClosureStalledLoop(t1);
        assert.equal(r1.decision, "alerted");
        const t2 = new Date(t1.getTime() + 5 * 60_000);
        const r2 = await checkFrontAutoClosureStalledLoop(t2);
        assert.equal(r2.decision, "skipped_cooldown");
        assert.equal(calls.length, 1);
      });

      // ── Scenario 5 — past cooldown + still stale → re-fires ───────────
      await step("past cooldown still stale → fires again", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const t1 = new Date("2026-05-21T10:00:00Z");
        helpers.setStatusProviderForTests(
          makeStatusProvider({
            summary: {
              ranAt: new Date(
                t1.getTime() - (THRESHOLD_MIN + 15) * 60_000,
              ).toISOString(),
            },
          }),
        );
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r1 = await checkFrontAutoClosureStalledLoop(t1);
        assert.equal(r1.decision, "alerted");
        const t2 = new Date(t1.getTime() + (COOLDOWN_MIN + 5) * 60_000);
        const r2 = await checkFrontAutoClosureStalledLoop(t2);
        assert.equal(r2.decision, "alerted");
        assert.equal(calls.length, 2);
      });

      // ── Scenario 6 — recovery alert fires once then quiet ─────────────
      await step("recovery → loop_recovered fires once then quiet", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const t1 = new Date("2026-05-21T10:00:00Z");
        let staleRanAt = new Date(
          t1.getTime() - (THRESHOLD_MIN + 15) * 60_000,
        ).toISOString();
        let currentSummary: FakeSummary | null = { ranAt: staleRanAt };
        helpers.setStatusProviderForTests(async () => ({
          config: { enabled: true },
          lastSummary: currentSummary,
        }));
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r1 = await checkFrontAutoClosureStalledLoop(t1);
        assert.equal(r1.decision, "alerted");
        assert.equal(calls[0].id, STUCK_ID);
        const t2 = new Date(t1.getTime() + 60_000);
        currentSummary = {
          ranAt: new Date(t2.getTime() - 30_000).toISOString(),
          lastSelfError: null,
        };
        const r2 = await checkFrontAutoClosureStalledLoop(t2);
        assert.equal(r2.decision, "recovered");
        assert.equal(calls.length, 2);
        assert.equal(calls[1].id, RECOVERED_ID);
        assert.equal(r2.lastAlert, null);
        const t3 = new Date(t2.getTime() + 5 * 60_000);
        currentSummary = {
          ranAt: new Date(t3.getTime() - 30_000).toISOString(),
          lastSelfError: null,
        };
        const r3 = await checkFrontAutoClosureStalledLoop(t3);
        assert.equal(r3.decision, "skipped_below_threshold");
        assert.equal(calls.length, 2);
      });

      // ── Scenario 7 — dispatcher skip does NOT arm cooldown ────────────
      await step("dispatcher skip → no lastAlert, retried next tick", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        const t1 = new Date("2026-05-21T10:00:00Z");
        helpers.setStatusProviderForTests(
          makeStatusProvider({
            summary: {
              ranAt: new Date(
                t1.getTime() - (THRESHOLD_MIN + 15) * 60_000,
              ).toISOString(),
            },
          }),
        );
        const skipDisp = makeDispatcher({
          delivered: false,
          status: "skipped_slack_disconnected",
          skipReason: "slack_not_connected",
        });
        helpers.setDispatcherForTests(skipDisp.fn);
        const r1 = await checkFrontAutoClosureStalledLoop(t1);
        assert.equal(r1.decision, "skipped_dispatcher_skipped");
        assert.equal(r1.lastAlert, null);
        assert.equal(skipDisp.calls.length, 1);
        const okDisp = makeDispatcher({ delivered: true });
        helpers.setDispatcherForTests(okDisp.fn);
        const t2 = new Date(t1.getTime() + 60_000);
        const r2 = await checkFrontAutoClosureStalledLoop(t2);
        assert.equal(r2.decision, "alerted");
        assert.equal(okDisp.calls.length, 1);
      });

      // ── Scenario 8 — self-error streak fires after N NEW ticks ────────
      await step(
        "self-error streak fires after N consecutive NEW ticks (polls don't inflate)",
        async () => {
          await configure({
            enabled: true,
            thresholdMinutes: THRESHOLD_MIN,
            cooldownMinutes: COOLDOWN_MIN,
            selfErrorStreak: 3,
          });
          const t0 = new Date("2026-05-21T10:00:00Z");
          let summary: FakeSummary = {
            ranAt: new Date(t0.getTime() - 60_000).toISOString(),
            lastSelfError: "boom-1",
          };
          helpers.setStatusProviderForTests(async () => ({
            config: { enabled: true },
            lastSummary: summary,
          }));
          const { fn, calls } = makeDispatcher();
          helpers.setDispatcherForTests(fn);

          let r = await checkFrontAutoClosureStalledLoop(t0);
          assert.equal(r.decision, "skipped_below_threshold");

          r = await checkFrontAutoClosureStalledLoop(
            new Date(t0.getTime() + 60_000),
          );
          assert.equal(r.decision, "skipped_below_threshold");

          summary = {
            ranAt: new Date(t0.getTime() + 2 * 60_000).toISOString(),
            lastSelfError: "boom-2",
          };
          r = await checkFrontAutoClosureStalledLoop(
            new Date(t0.getTime() + 3 * 60_000),
          );
          assert.equal(r.decision, "skipped_below_threshold");

          summary = {
            ranAt: new Date(t0.getTime() + 4 * 60_000).toISOString(),
            lastSelfError: "boom-3",
          };
          r = await checkFrontAutoClosureStalledLoop(
            new Date(t0.getTime() + 5 * 60_000),
          );
          assert.equal(r.decision, "alerted");
          assert.equal(calls.length, 1);
          assert.equal(calls[0].id, STUCK_ID);
          assert.equal(
            (calls[0].metadata as any).reason,
            "self_error_streak",
          );
          assert.equal((calls[0].metadata as any).selfErrorStreak, 3);
        },
      );

      // ── Scenario 9 — no summary persisted → quiet ─────────────────────
      await step("no summary persisted → skipped_no_summary", async () => {
        await configure({
          enabled: true,
          thresholdMinutes: THRESHOLD_MIN,
          cooldownMinutes: COOLDOWN_MIN,
          selfErrorStreak: STREAK_DEFAULT,
        });
        helpers.setStatusProviderForTests(
          makeStatusProvider({ summary: null }),
        );
        const { fn, calls } = makeDispatcher();
        helpers.setDispatcherForTests(fn);
        const r = await checkFrontAutoClosureStalledLoop(
          new Date("2026-05-21T10:00:00Z"),
        );
        assert.equal(r.decision, "skipped_no_summary");
        assert.equal(calls.length, 0);
      });

      if (failures > 0) {
        throw new Error(`${failures} test(s) failed`);
      }
      console.log("\nAll Task #1689 scenarios passed.");
  }
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error(err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
