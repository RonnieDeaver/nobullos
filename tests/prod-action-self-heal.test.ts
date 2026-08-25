/* test-registration
{
  "name": "Maintenance prod-action self-heal (Task #2086)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2086 — Self-healing for maintenance drains.
 *
 * Pins the default-OFF, master-switch self-heal scheduler that
 * automatically applies the idempotent, recurring maintenance
 * prod-actions opted in via `ProdAction.selfHeal` on each action's own
 * cadence/backoff.
 *
 * The tick is exercised with injected actions + an in-memory audit
 * recorder (the `SelfHealTickOpts` test seams) so the deterministic
 * units never run the real registry applies — those mutate live dev
 * state (e.g. `drain_front_122k_backlog` flips a system setting).
 *
 * Deterministic units (settings are DB-backed; no live integrations):
 *   1. Disabled by default — tick no-ops with a reason, applies nothing,
 *      and records no audit rows.
 *   2. Queue pause and KILL_SWITCH_NON_CRITICAL_SWEEPS each short-circuit
 *      before any action runs.
 *   3. Enabled — only `selfHeal`-tagged actions are eligible; due actions
 *      are applied oldest-due-first, bounded by the per-tick budget.
 *   4. Cadence vs backoff — an `applied` action is spaced by `cadenceMs`,
 *      a `not-needed` / `error` action by the longer `backoffMs`; an
 *      action whose `nextEligibleAt` is in the future is not due.
 *   5. Audit is written for `applied` / `error` only — never `not-needed`.
 *   6. The eligible registry actions are all tagged `selfHeal` and
 *      nothing else is.
 *   7. `loadMaxPerTick` parses + bounds the per-tick budget.
 *
 * All units are nested inside one `describe` so node:test runs them
 * sequentially (top-level tests run concurrently). They share global
 * `system_settings` keys (enabled / max-per-tick / last-run) and the
 * in-memory queue-pause state; concurrent execution would let one unit's
 * `resetSettings()` flip another's `enabled`/`paused` mid-tick.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  isQueuePaused,
  setQueuePause,
} from "../server/services/queueDrainControl";
import { PERF } from "../server/perfConfig";
import {
  runProdActionSelfHealTick,
  getProdActionSelfHealReadout,
  QUEUE_NAME,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  SETTING_LAST_RUN,
  SETTING_FAILURE_ALERT_ENABLED,
  SETTING_FAILURE_ALERT_THRESHOLD,
  SETTING_RECONNECT_ALERT_ENABLED,
  type SelfHealRecordRun,
  type SelfHealScheduleEntry,
  type SelfHealFailureAlert,
  type SelfHealReconnectAlert,
  __prodActionSelfHealTestHelpers,
} from "../server/services/prodActionSelfHeal";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const ELIGIBLE_IDS = [
  "cancel_stale_front_backlog",
  "dedupe_user_notifications_unread",
  "mark_legacy_front_email_pending_terminal",
  "drain_front_122k_backlog",
  "backfill_competitor_location_labels",
  "backfill_competitor_structured_location",
  "refresh_finalized_front_coverage_local_counts",
  "recover_frozen_front_mirror",
  "rerun_stale_semrush_partials",
  "backfill_competitor_locality_relabel",
  "purge_pre_floor_front_coverage_rows",
  "purge_dead_front_adoption_date_setting",
  // Task #2281 — newly enrolled so one "Apply all" press hands off to the
  // auto-healer instead of sitting perpetually in the panel's "remaining".
  "unblock_poisoned_front_recovery_checkpoints",
  "reach_front_coverage_full_message_grain",
  // Later tasks enrolled additional maintenance actions into self-heal:
  "recover_front_plan_limited_messages",
  "finish_front_message_grain_coverage",
  "study_materialized_front_messages",
  "cleanup_legacy_keyword_spellings",
  // Task #2637 — auto re-match dismissed-operational Front backlog.
  "rematch_dismissed_operational_front_backlog",
  // Task #2801 — repair stale Front coverage denominator-floor rows.
  "repair_front_coverage_denominator_floor",
  // Task #4054 / #3889 — enrolled with their tasks but never added to this
  // pinned list (caught while extending it for Task #4762):
  "backfill_front_message_attribution",
  "front_recent_window_message_freshness",
  // Task #4762 — safe converging one-offs now drain themselves (the
  // "zero by default" flip): every new enrollment 6h cadence / 6h backoff.
  "rematch_unmatched_front_backlog",
  "heal_imported_fabricated_zero_metrics",
  "retire_legacy_zoom_oauth_tokens",
  "backfill_seasonal_trend_ai_commentary",
];

type Outcome = "applied" | "not-needed" | "error" | "blocked";

interface FakeSpec {
  id: string;
  outcome: Outcome;
  rowsAffected?: number;
  cadenceMs?: number;
  backoffMs?: number;
  // Task #4840 — blocked-flavor control: default keeps the auth-dead
  // shape (integration "Front"); pass `null` to produce a blocked outcome
  // WITHOUT an integration (a precondition wait-state, e.g. the Zoom
  // legacy-retirement soak).
  blockedIntegration?: string | null;
}

/** Build an injectable fake action that records that it ran. */
function fakeAction(spec: FakeSpec, ran: string[]): any {
  return {
    id: spec.id,
    title: `fake ${spec.id}`,
    description: "test",
    kind: "custom",
    apply: async () => {
      ran.push(spec.id);
      if (spec.outcome === "error") throw new Error(`boom ${spec.id}`);
      if (spec.outcome === "applied") {
        return {
          state: "applied",
          detail: "did work",
          rowsAffected: spec.rowsAffected ?? 1,
        };
      }
      if (spec.outcome === "blocked") {
        if (spec.blockedIntegration === null) {
          // Task #4840 — waiting-blocked: no integration named.
          return {
            state: "blocked",
            detail: "Waiting for soak evidence — preconditions not yet met.",
          };
        }
        return {
          state: "blocked",
          detail: "Front login expired — reconnect Front.",
          integration: spec.blockedIntegration ?? "Front",
        };
      }
      return { state: "not-needed", detail: "nothing to do" };
    },
    selfHeal: {
      cadenceMs: spec.cadenceMs ?? 60_000,
      backoffMs: spec.backoffMs ?? 600_000,
    },
  };
}

/** In-memory audit recorder seam. */
function makeRecorder(): {
  fn: SelfHealRecordRun;
  rows: Array<{ actionId: string; outcomeState: Outcome }>;
} {
  const rows: Array<{ actionId: string; outcomeState: Outcome }> = [];
  const fn: SelfHealRecordRun = async (entry) => {
    rows.push({ actionId: entry.actionId, outcomeState: entry.outcomeState });
  };
  return { fn, rows };
}

async function resetSettings(): Promise<void> {
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
}

describe("task-2086: maintenance prod-action self-heal", () => {
  test("disabled by default — no-op, applies nothing, no audit", async () => {
    await resetSettings();
    const ran: string[] = [];
    const rec = makeRecorder();
    const r = await runProdActionSelfHealTick({
      actions: [fakeAction({ id: "a", outcome: "applied" }, ran)],
      recordRun: rec.fn,
    });
    assert.equal(r.enabled, false);
    assert.equal(r.applied, 0);
    assert.equal(r.attempted.length, 0);
    assert.match(r.reason ?? "", /disabled/i);
    assert.deepEqual(ran, []);
    assert.equal(rec.rows.length, 0);
    await resetSettings();
  });

  test("queue pause short-circuits before any action runs", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    await setQueuePause(QUEUE_NAME, true, "task-2086-test");
    try {
      assert.equal(isQueuePaused(QUEUE_NAME), true);
      const ran: string[] = [];
      const rec = makeRecorder();
      const r = await runProdActionSelfHealTick({
        actions: [fakeAction({ id: "a", outcome: "applied" }, ran)],
        recordRun: rec.fn,
      });
      assert.equal(r.paused, true);
      assert.match(r.reason ?? "", /paused/i);
      assert.deepEqual(ran, []);
      assert.equal(rec.rows.length, 0);
    } finally {
      await setQueuePause(QUEUE_NAME, false, "task-2086-test");
      await resetSettings();
    }
  });

  test("KILL_SWITCH_NON_CRITICAL_SWEEPS short-circuits", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    const prior = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
    (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
    try {
      const ran: string[] = [];
      const rec = makeRecorder();
      const r = await runProdActionSelfHealTick({
        actions: [fakeAction({ id: "a", outcome: "applied" }, ran)],
        recordRun: rec.fn,
      });
      assert.match(r.reason ?? "", /KILL_SWITCH_NON_CRITICAL_SWEEPS/);
      assert.deepEqual(ran, []);
      assert.equal(rec.rows.length, 0);
    } finally {
      (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = prior;
      await resetSettings();
    }
  });

  test("enabled — only selfHeal actions eligible; due applied within budget", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "2");
    try {
      const ran: string[] = [];
      const rec = makeRecorder();
      const actions = [
        fakeAction({ id: "z1", outcome: "applied" }, ran),
        fakeAction({ id: "z2", outcome: "not-needed" }, ran),
        fakeAction({ id: "z3", outcome: "applied" }, ran),
        // Not tagged selfHeal → must be ignored entirely.
        {
          id: "z4-manual",
          title: "manual only",
          kind: "custom",
          apply: async () => {
            ran.push("z4-manual");
            return { state: "applied", detail: "x", rowsAffected: 0 };
          },
        } as any,
      ];
      const r = await runProdActionSelfHealTick({ actions, recordRun: rec.fn });
      assert.equal(r.enabled, true);
      assert.deepEqual(r.eligibleActionIds.sort(), ["z1", "z2", "z3"]);
      // All three are due (never run), but budget caps at 2 (oldest-due
      // tiebreak by id → z1, z2).
      assert.deepEqual(r.dueActionIds.sort(), ["z1", "z2", "z3"]);
      assert.equal(r.attempted.length, 2);
      assert.deepEqual(ran.sort(), ["z1", "z2"]);
      assert.ok(!ran.includes("z4-manual"), "manual action never auto-runs");
      // Audit only for the applied one (z1), not the not-needed (z2).
      assert.deepEqual(rec.rows, [
        { actionId: "z1", outcomeState: "applied" },
      ]);
    } finally {
      await resetSettings();
    }
  });

  test("cadence vs backoff spacing + future nextEligibleAt is not due", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    try {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const nowMs = now.getTime();
      const ran: string[] = [];
      const rec = makeRecorder();
      const actions = [
        fakeAction(
          { id: "applied1", outcome: "applied", cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
        fakeAction(
          { id: "noop1", outcome: "not-needed", cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
      ];
      // Thread the schedule across ticks via the `priorSchedule` seam and
      // skip persistence (`persist: false`) so this multi-tick unit never
      // depends on the shared global `SETTING_LAST_RUN` key.
      const r = await runProdActionSelfHealTick({
        actions,
        recordRun: rec.fn,
        now,
        persist: false,
      });
      const appliedEntry = r.schedule["applied1"];
      const noopEntry = r.schedule["noop1"];
      assert.ok(appliedEntry && noopEntry);
      assert.equal(
        Date.parse(appliedEntry.nextEligibleAt) - nowMs,
        60_000,
        "applied uses cadenceMs",
      );
      assert.equal(
        Date.parse(noopEntry.nextEligibleAt) - nowMs,
        600_000,
        "not-needed uses backoffMs",
      );

      // tick1 ran both (never-run → due).
      assert.deepEqual(ran.slice().sort(), ["applied1", "noop1"]);

      // A second tick 30s later: both are still inside their spacing → not
      // due → nothing runs (the shared `ran` array does not grow).
      const rec2 = makeRecorder();
      const later = new Date(nowMs + 30_000);
      const ranBeforeTick2 = ran.length;
      const r2 = await runProdActionSelfHealTick({
        actions,
        recordRun: rec2.fn,
        now: later,
        priorSchedule: r.schedule,
        persist: false,
      });
      assert.deepEqual(r2.dueActionIds, []);
      assert.equal(ran.length, ranBeforeTick2, "no action runs on tick2");
      assert.equal(rec2.rows.length, 0);

      // A third tick past the cadence (90s later): applied1 is due again,
      // noop1 (10min backoff) still is not.
      const rec3 = makeRecorder();
      const muchLater = new Date(nowMs + 90_000);
      const ranBeforeTick3 = ran.length;
      const r3 = await runProdActionSelfHealTick({
        actions,
        recordRun: rec3.fn,
        now: muchLater,
        priorSchedule: r2.schedule,
        persist: false,
      });
      assert.deepEqual(r3.dueActionIds, ["applied1"]);
      assert.deepEqual(ran.slice(ranBeforeTick3), ["applied1"]);
    } finally {
      await resetSettings();
    }
  });

  test("error outcome is audited and backed off, tick never throws", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    try {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const ran: string[] = [];
      const rec = makeRecorder();
      const actions = [
        fakeAction(
          { id: "err1", outcome: "error", cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
      ];
      const r = await runProdActionSelfHealTick({
        actions,
        recordRun: rec.fn,
        now,
        persist: false,
      });
      assert.equal(r.errors, 1);
      assert.deepEqual(ran, ["err1"]);
      assert.deepEqual(rec.rows, [{ actionId: "err1", outcomeState: "error" }]);
      // Errors back off (not cadence).
      assert.equal(
        Date.parse(r.schedule["err1"].nextEligibleAt) - now.getTime(),
        600_000,
      );
    } finally {
      await resetSettings();
    }
  });

  test("task-2111: blocked outcome is not an error — counted separately, not audited, backed off", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    try {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const ran: string[] = [];
      const rec = makeRecorder();
      const actions = [
        fakeAction(
          { id: "blk1", outcome: "blocked", cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
      ];
      const r = await runProdActionSelfHealTick({
        actions,
        recordRun: rec.fn,
        now,
        persist: false,
      });
      // Blocked is its own counter and must NOT inflate errors.
      assert.equal(r.blocked, 1);
      assert.equal(r.errors, 0);
      assert.equal(r.applied, 0);
      assert.equal(r.notNeeded, 0);
      assert.deepEqual(ran, ["blk1"]);
      // Benign reconnect-required runs are not audited (no History flood).
      assert.deepEqual(rec.rows, []);
      // Blocked backs off (not cadence), like a no-op.
      assert.equal(
        Date.parse(r.schedule["blk1"].nextEligibleAt) - now.getTime(),
        600_000,
      );
      assert.equal(r.schedule["blk1"].lastOutcome, "blocked");
    } finally {
      await resetSettings();
    }
  });

  // ── Task #2096 — persistent-failure alerting ──────────────────────
  function makeAlertSink(): {
    fn: SelfHealFailureAlert;
    alerts: Array<{
      actionId: string;
      consecutiveFailures: number;
      threshold: number;
    }>;
  } {
    const alerts: Array<{
      actionId: string;
      consecutiveFailures: number;
      threshold: number;
    }> = [];
    const fn: SelfHealFailureAlert = async (e) => {
      alerts.push({
        actionId: e.actionId,
        consecutiveFailures: e.consecutiveFailures,
        threshold: e.threshold,
      });
    };
    return { fn, alerts };
  }

  test("task-2096: alert fires once after N consecutive errors, deduped on backoff, re-arms on recovery", async () => {
    await resetSettings();
    await deleteSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => {});
    await deleteSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => {});
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    await setSystemSetting(SETTING_FAILURE_ALERT_ENABLED, "true");
    await setSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD, "3");
    try {
      const sink = makeAlertSink();
      const errAction = (ran: string[]) =>
        fakeAction(
          { id: "stuck", outcome: "error", cadenceMs: 1_000, backoffMs: 1_000 },
          ran,
        );
      const ran: string[] = [];
      const t0 = Date.parse("2026-06-01T00:00:00.000Z");
      const step = 5_000; // > backoff so the action is due every tick

      let schedule: Record<string, SelfHealScheduleEntry> = {};
      // tick1 (cf=1) and tick2 (cf=2): below threshold → no alert.
      for (let i = 0; i < 2; i++) {
        const r = await runProdActionSelfHealTick({
          actions: [errAction(ran)],
          recordRun: makeRecorder().fn,
          alertFailure: sink.fn,
          now: new Date(t0 + i * step),
          priorSchedule: schedule,
          persist: false,
        });
        schedule = r.schedule;
        assert.deepEqual(r.failureAlertsSent, [], `tick${i + 1} no alert`);
      }
      assert.equal(sink.alerts.length, 0, "no alert below threshold");
      assert.equal(schedule["stuck"].consecutiveFailures, 2);

      // tick3 (cf=3): crosses threshold → exactly one alert.
      const r3 = await runProdActionSelfHealTick({
        actions: [errAction(ran)],
        recordRun: makeRecorder().fn,
        alertFailure: sink.fn,
        now: new Date(t0 + 2 * step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r3.schedule;
      assert.deepEqual(r3.failureAlertsSent, ["stuck"]);
      assert.equal(sink.alerts.length, 1);
      assert.equal(sink.alerts[0].consecutiveFailures, 3);
      assert.equal(sink.alerts[0].threshold, 3);
      assert.equal(schedule["stuck"].failureAlertSent, true);

      // tick4 (cf=4): still failing but already alerted → suppressed.
      const r4 = await runProdActionSelfHealTick({
        actions: [errAction(ran)],
        recordRun: makeRecorder().fn,
        alertFailure: sink.fn,
        now: new Date(t0 + 3 * step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r4.schedule;
      assert.deepEqual(r4.failureAlertsSent, [], "deduped on backoff tick");
      assert.equal(sink.alerts.length, 1, "no second alert while still failing");
      assert.equal(schedule["stuck"].consecutiveFailures, 4);

      // recovery: a healthy outcome resets the streak + the alert flag.
      const r5 = await runProdActionSelfHealTick({
        actions: [
          fakeAction(
            { id: "stuck", outcome: "not-needed", cadenceMs: 1_000, backoffMs: 1_000 },
            ran,
          ),
        ],
        recordRun: makeRecorder().fn,
        alertFailure: sink.fn,
        now: new Date(t0 + 4 * step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r5.schedule;
      assert.equal(schedule["stuck"].consecutiveFailures, 0, "streak reset");
      assert.equal(schedule["stuck"].failureAlertSent, false, "alert re-armed");

      // failing again past the threshold pages a second time.
      for (let i = 0; i < 3; i++) {
        const r = await runProdActionSelfHealTick({
          actions: [errAction(ran)],
          recordRun: makeRecorder().fn,
          alertFailure: sink.fn,
          now: new Date(t0 + (5 + i) * step),
          priorSchedule: schedule,
          persist: false,
        });
        schedule = r.schedule;
      }
      assert.equal(sink.alerts.length, 2, "re-armed alert fires after recovery");
    } finally {
      await deleteSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => {});
      await deleteSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => {});
      await resetSettings();
    }
  });

  test("task-2096: a single one-off error never alerts; non-error breaks the streak", async () => {
    await resetSettings();
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    await setSystemSetting(SETTING_FAILURE_ALERT_ENABLED, "true");
    await setSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD, "3");
    try {
      const sink = makeAlertSink();
      const ran: string[] = [];
      const t0 = Date.parse("2026-06-01T00:00:00.000Z");
      const step = 5_000;

      // error, error, then not-needed → streak resets before threshold.
      let schedule: Record<string, SelfHealScheduleEntry> = {};
      const outcomes: Array<"error" | "not-needed"> = [
        "error",
        "error",
        "not-needed",
      ];
      for (let i = 0; i < outcomes.length; i++) {
        const r = await runProdActionSelfHealTick({
          actions: [
            fakeAction(
              { id: "blip", outcome: outcomes[i], cadenceMs: 1_000, backoffMs: 1_000 },
              ran,
            ),
          ],
          recordRun: makeRecorder().fn,
          alertFailure: sink.fn,
          now: new Date(t0 + i * step),
          priorSchedule: schedule,
          persist: false,
        });
        schedule = r.schedule;
      }
      assert.equal(sink.alerts.length, 0, "transient errors broken by recovery never page");
      assert.equal(schedule["blip"].consecutiveFailures, 0);
    } finally {
      await deleteSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => {});
      await deleteSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => {});
      await resetSettings();
    }
  });

  test("task-2096: alert disabled by default — streak tracked but nobody paged", async () => {
    await resetSettings();
    await deleteSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => {});
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    await setSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD, "2");
    try {
      const sink = makeAlertSink();
      const ran: string[] = [];
      const t0 = Date.parse("2026-06-01T00:00:00.000Z");
      const step = 5_000;
      let schedule: Record<string, SelfHealScheduleEntry> = {};
      for (let i = 0; i < 4; i++) {
        const r = await runProdActionSelfHealTick({
          actions: [
            fakeAction(
              { id: "silent", outcome: "error", cadenceMs: 1_000, backoffMs: 1_000 },
              ran,
            ),
          ],
          recordRun: makeRecorder().fn,
          alertFailure: sink.fn,
          now: new Date(t0 + i * step),
          priorSchedule: schedule,
          persist: false,
        });
        schedule = r.schedule;
      }
      // Alerting is OFF (default) → no pages even well past the threshold,
      // but the streak is still tracked so it works once enabled.
      assert.equal(sink.alerts.length, 0, "default-OFF means no alert");
      assert.equal(schedule["silent"].consecutiveFailures, 4);
      assert.notEqual(schedule["silent"].failureAlertSent, true);
    } finally {
      await deleteSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => {});
      await resetSettings();
    }
  });

  test("task-2096: loadFailureAlert* parse + bound helpers", async () => {
    const { loadFailureAlertEnabled, loadFailureAlertThreshold } =
      __prodActionSelfHealTestHelpers;

    await deleteSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => {});
    assert.equal(await loadFailureAlertEnabled(), false, "default OFF");
    await setSystemSetting(SETTING_FAILURE_ALERT_ENABLED, "true");
    assert.equal(await loadFailureAlertEnabled(), true);

    await deleteSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => {});
    assert.equal(await loadFailureAlertThreshold(), 3, "default when unset");
    await setSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD, "5");
    assert.equal(await loadFailureAlertThreshold(), 5);
    await setSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD, "0");
    assert.equal(await loadFailureAlertThreshold(), 3, "non-positive → default");
    await setSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD, "100000");
    assert.equal(await loadFailureAlertThreshold(), 50, "capped");

    await deleteSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => {});
    await deleteSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => {});
  });

  // ── Task #2124 — reconnect-required (auth-dead) alerting ──────────
  function makeReconnectSink(): {
    fn: SelfHealReconnectAlert;
    alerts: Array<{ actionId: string; integration: string | null }>;
  } {
    const alerts: Array<{ actionId: string; integration: string | null }> = [];
    const fn: SelfHealReconnectAlert = async (e) => {
      alerts.push({ actionId: e.actionId, integration: e.integration });
    };
    return { fn, alerts };
  }

  test("task-2124: reconnect alert fires once on blocked, deduped while blocked, re-arms on recovery", async () => {
    await resetSettings();
    await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    await setSystemSetting(SETTING_RECONNECT_ALERT_ENABLED, "true");
    try {
      const sink = makeReconnectSink();
      const ran: string[] = [];
      const t0 = Date.parse("2026-06-01T00:00:00.000Z");
      const step = 700_000; // > backoff so the action is due every tick
      const blocked = () =>
        fakeAction(
          { id: "frontblk", outcome: "blocked", cadenceMs: 1_000, backoffMs: 600_000 },
          ran,
        );

      let schedule: Record<string, SelfHealScheduleEntry> = {};

      // tick1: first blocked detection → exactly one reconnect alert.
      const r1 = await runProdActionSelfHealTick({
        actions: [blocked()],
        recordRun: makeRecorder().fn,
        alertReconnect: sink.fn,
        now: new Date(t0),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r1.schedule;
      assert.deepEqual(r1.reconnectAlertsSent, ["frontblk"]);
      assert.equal(sink.alerts.length, 1);
      assert.equal(sink.alerts[0].integration, "Front");
      assert.equal(schedule["frontblk"].reconnectAlertSent, true);
      // Blocked must not inflate errors.
      assert.equal(r1.errors, 0);
      assert.equal(r1.blocked, 1);

      // tick2: still blocked → already paged → suppressed.
      const r2 = await runProdActionSelfHealTick({
        actions: [blocked()],
        recordRun: makeRecorder().fn,
        alertReconnect: sink.fn,
        now: new Date(t0 + step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r2.schedule;
      assert.deepEqual(r2.reconnectAlertsSent, [], "deduped while still blocked");
      assert.equal(sink.alerts.length, 1, "no second page while still blocked");

      // recovery: a healthy outcome re-arms the reconnect flag.
      const r3 = await runProdActionSelfHealTick({
        actions: [
          fakeAction(
            { id: "frontblk", outcome: "not-needed", cadenceMs: 1_000, backoffMs: 600_000 },
            ran,
          ),
        ],
        recordRun: makeRecorder().fn,
        alertReconnect: sink.fn,
        now: new Date(t0 + 2 * step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r3.schedule;
      assert.equal(schedule["frontblk"].reconnectAlertSent, false, "re-armed");

      // blocked again after recovery → pages a second time.
      const r4 = await runProdActionSelfHealTick({
        actions: [blocked()],
        recordRun: makeRecorder().fn,
        alertReconnect: sink.fn,
        now: new Date(t0 + 3 * step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r4.schedule;
      assert.deepEqual(r4.reconnectAlertsSent, ["frontblk"]);
      assert.equal(sink.alerts.length, 2, "re-armed alert fires after recovery");
    } finally {
      await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
      await resetSettings();
    }
  });

  // Task #4840 — the two blocked flavors: only outcomes that NAME an
  // integration (auth-dead) page; blocked-without-integration is a
  // precondition wait-state (e.g. the Zoom legacy-retirement soak) that
  // keeps its backoff/streak semantics but never alerts.
  test("task-4840: blocked without integration never pages; named integration still does", async () => {
    await resetSettings();
    await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    await setSystemSetting(SETTING_RECONNECT_ALERT_ENABLED, "true");
    try {
      const sink = makeReconnectSink();
      const ran: string[] = [];
      const t0 = Date.parse("2026-06-01T00:00:00.000Z");
      const step = 700_000; // > backoff so both actions are due every tick
      const waiting = () =>
        fakeAction(
          {
            id: "zoomwait",
            outcome: "blocked",
            blockedIntegration: null,
            cadenceMs: 1_000,
            backoffMs: 600_000,
          },
          ran,
        );
      const authDead = () =>
        fakeAction(
          { id: "frontauth", outcome: "blocked", cadenceMs: 1_000, backoffMs: 600_000 },
          ran,
        );

      let schedule: Record<string, SelfHealScheduleEntry> = {};

      // tick1: both blocked — only the integration-named one pages.
      const r1 = await runProdActionSelfHealTick({
        actions: [waiting(), authDead()],
        recordRun: makeRecorder().fn,
        alertReconnect: sink.fn,
        now: new Date(t0),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r1.schedule;
      assert.deepEqual(
        r1.reconnectAlertsSent,
        ["frontauth"],
        "only the auth-dead (integration-named) block pages",
      );
      assert.equal(sink.alerts.length, 1);
      assert.equal(sink.alerts[0].actionId, "frontauth");
      assert.equal(sink.alerts[0].integration, "Front");
      // Both still count as blocked (never as errors), and both keep
      // their backoff/streak bookkeeping.
      assert.equal(r1.blocked, 2);
      assert.equal(r1.errors, 0);
      assert.equal(
        schedule["zoomwait"].reconnectAlertSent,
        false,
        "waiting-blocked must never latch the reconnect-page flag",
      );
      assert.equal(schedule["frontauth"].reconnectAlertSent, true);
      assert.ok(
        Date.parse(schedule["zoomwait"].nextEligibleAt) === t0 + 600_000,
        "waiting-blocked keeps normal backoff spacing",
      );

      // tick2: still blocked → the waiting action stays silent (no page,
      // flag still false), the auth-dead one stays deduped.
      const r2 = await runProdActionSelfHealTick({
        actions: [waiting(), authDead()],
        recordRun: makeRecorder().fn,
        alertReconnect: sink.fn,
        now: new Date(t0 + step),
        priorSchedule: schedule,
        persist: false,
      });
      schedule = r2.schedule;
      assert.deepEqual(r2.reconnectAlertsSent, []);
      assert.equal(sink.alerts.length, 1, "waiting-blocked never pages, even on repeat ticks");
      assert.equal(schedule["zoomwait"].reconnectAlertSent, false);
    } finally {
      await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
      await resetSettings();
    }
  });

  test("task-2124: reconnect alert disabled by default — blocked tracked but nobody paged", async () => {
    await resetSettings();
    await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    try {
      const sink = makeReconnectSink();
      const ran: string[] = [];
      const t0 = Date.parse("2026-06-01T00:00:00.000Z");
      let schedule: Record<string, SelfHealScheduleEntry> = {};
      for (let i = 0; i < 3; i++) {
        const r = await runProdActionSelfHealTick({
          actions: [
            fakeAction(
              { id: "silentblk", outcome: "blocked", cadenceMs: 1_000, backoffMs: 1_000 },
              ran,
            ),
          ],
          recordRun: makeRecorder().fn,
          alertReconnect: sink.fn,
          now: new Date(t0 + i * 5_000),
          priorSchedule: schedule,
          persist: false,
        });
        schedule = r.schedule;
        assert.deepEqual(r.reconnectAlertsSent, []);
      }
      assert.equal(sink.alerts.length, 0, "default-OFF means no reconnect page");
      assert.notEqual(schedule["silentblk"].reconnectAlertSent, true);
    } finally {
      await resetSettings();
    }
  });

  test("task-2124: loadReconnectAlertEnabled parses default OFF and opt-in", async () => {
    const { loadReconnectAlertEnabled } = __prodActionSelfHealTestHelpers;
    await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
    assert.equal(await loadReconnectAlertEnabled(), false, "default OFF");
    await setSystemSetting(SETTING_RECONNECT_ALERT_ENABLED, "true");
    assert.equal(await loadReconnectAlertEnabled(), true);
    await deleteSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => {});
  });

  test("admin readout surfaces master switch + durable per-action last run / outcome / rows", async () => {
    await resetSettings();
    // Disabled + nothing persisted yet → readout is OFF with no actions.
    const empty = await getProdActionSelfHealReadout();
    assert.equal(empty.enabled, false);
    assert.equal(empty.ranAt, null);
    assert.equal(empty.lastRun, null, "no tick summary before first run");
    assert.deepEqual(empty.actions, {});

    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "10");
    try {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const ran: string[] = [];
      const rec = makeRecorder();
      const actions = [
        fakeAction(
          { id: "ap", outcome: "applied", rowsAffected: 7, cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
        fakeAction(
          { id: "np", outcome: "not-needed", cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
        fakeAction(
          { id: "er", outcome: "error", cadenceMs: 60_000, backoffMs: 600_000 },
          ran,
        ),
      ];
      // persist:true (default) so the readout reads the durable last-run.
      await runProdActionSelfHealTick({ actions, recordRun: rec.fn, now });

      const readout = await getProdActionSelfHealReadout();
      assert.equal(readout.enabled, true, "master switch reflected");
      assert.equal(readout.ranAt, now.toISOString(), "tick time surfaced");

      // Tick-level summary: when it ran + aggregate outcome counts.
      assert.ok(readout.lastRun, "tick summary present after a run");
      assert.equal(readout.lastRun!.ranAt, now.toISOString());
      assert.equal(readout.lastRun!.applied, 1, "one applied");
      assert.equal(readout.lastRun!.notNeeded, 1, "one not-needed");
      assert.equal(readout.lastRun!.errors, 1, "one error");
      assert.equal(readout.lastRun!.eligibleCount, 3);
      assert.equal(readout.lastRun!.dueCount, 3);

      // applied action: durable last run / outcome / rows-affected trio.
      const ap = readout.actions["ap"];
      assert.ok(ap, "applied action present in readout");
      assert.equal(ap.lastOutcome, "applied");
      assert.equal(ap.lastRowsAffected, 7);
      assert.equal(ap.lastRunAt, now.toISOString());
      assert.equal(Date.parse(ap.nextEligibleAt) - now.getTime(), 60_000);
      // Task #2153 — healthy outcome → no failing streak.
      assert.equal(ap.consecutiveFailures, 0);
      assert.equal(ap.failureAlertSent, false);
      // Task #2179 — healthy outcome → no error detail.
      assert.equal(ap.lastErrorDetail, null, "applied → no error detail");

      // not-needed: rows null, backoff spacing.
      const np = readout.actions["np"];
      assert.ok(np);
      assert.equal(np.lastOutcome, "not-needed");
      assert.equal(np.lastRowsAffected, null);
      assert.equal(Date.parse(np.nextEligibleAt) - now.getTime(), 600_000);
      assert.equal(np.consecutiveFailures, 0);
      assert.equal(np.lastErrorDetail, null, "not-needed → no error detail");

      // error: rows null, backoff spacing.
      const er = readout.actions["er"];
      assert.ok(er);
      assert.equal(er.lastOutcome, "error");
      assert.equal(er.lastRowsAffected, null);
      assert.equal(Date.parse(er.nextEligibleAt) - now.getTime(), 600_000);
      // Task #2153 — one error this tick → streak of 1, no alert yet.
      assert.equal(er.consecutiveFailures, 1, "single error → streak of 1");
      assert.equal(er.failureAlertSent, false);
      // Task #2179 — the error detail (thrown message) is surfaced so the
      // panel can show *why* it failed, not just the count.
      assert.equal(er.lastErrorDetail, "boom er", "error detail surfaced");
    } finally {
      await resetSettings();
    }
  });

  test("exactly the eligible maintenance actions are tagged selfHeal", () => {
    const tagged = PROD_ACTIONS.filter((a) => a.selfHeal != null).map((a) => a.id);
    assert.deepEqual(tagged.sort(), [...ELIGIBLE_IDS].sort());
    for (const a of PROD_ACTIONS) {
      if (a.selfHeal != null) {
        assert.ok(
          a.selfHeal.cadenceMs > 0 && a.selfHeal.backoffMs > 0,
          `${a.id}: cadence/backoff must be positive`,
        );
      }
    }
  });

  test("loadMaxPerTick parses and bounds the per-tick budget", async () => {
    const { loadMaxPerTick } = __prodActionSelfHealTestHelpers;

    await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
    assert.equal(await loadMaxPerTick(), 2, "default when unset");

    await setSystemSetting(SETTING_MAX_PER_TICK, "5");
    assert.equal(await loadMaxPerTick(), 5);

    await setSystemSetting(SETTING_MAX_PER_TICK, "100000");
    assert.equal(await loadMaxPerTick(), 10, "capped at MAX_PER_TICK_CAP");

    await setSystemSetting(SETTING_MAX_PER_TICK, "0");
    assert.equal(await loadMaxPerTick(), 2, "non-positive falls back to default");

    await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  });
});

// Touch the imported types so unused-import lint stays quiet.
const _typeTouch: SelfHealScheduleEntry | null = null;
void _typeTouch;
