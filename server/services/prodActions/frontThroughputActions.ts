// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Front pipeline throughput — concurrency ramps, pool-pressure gates, warp-speed switches, and backlog workload-class rewrites.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { sql } from "drizzle-orm";
import { getDb, isApiPoolUnderPressure, runWithWorkerDb, withDbAttribution } from "../../db";
import { storage } from "../../storage";
import { bindArrayParam } from "../../utils/sqlArray";
import { setPoolEpicSwitch } from "../poolEpicKillSwitches";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
} from "../prodActionBackgroundDrain";
import { getLastSuccessfulProdActionRun } from "../../storage/prodActionRuns";
import {
  INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
  INGESTION_CLASS_CONCURRENCY_DEFAULT,
  getIngestionClassConcurrency,
  setIngestionClassConcurrency,
} from "../workloadManager";
import { type ProdAction, type ProdActionDomain } from "./kernel";
import { killSwitchAction, systemSettingAction } from "./helpers";


// Task #1807 — minimum age of the 1 → 2 ramp success before the
// 2 → 3 ramp becomes available. Stays as a constant rather than a
// system_settings knob to keep the watch window deliberate.
const RAMP_2_TO_3_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

const RAMP_1_TO_2_ACTION_ID = "ramp_front_recovery_ingest_concurrency";


// ─── Task #1807: Front recovery ingest concurrency 2 → 3 ─────────────
//
// Identical idempotent shape to the 1 → 2 action, but the press is
// gated: it stays "not-needed" until BOTH (a) `front_recovery_ingest_concurrency`
// is currently exactly "2" AND (b) the last successful run of the 1 → 2
// ramp (`RAMP_1_TO_2_ACTION_ID`) is at least 24h old. The watch window
// is enforced via the `prod_action_runs` audit table — no separate
// `system_settings` knob is introduced for the gate.
export const ramp2to3Action: ProdAction = {
  id: "ramp_front_recovery_ingest_concurrency_3",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Staged concurrency ramp: each rung is an operator judgment call on observed pool headroom after the previous rung's 24h watch window — never auto-fired.",
  },
  title: "Ramp Front recovery ingest concurrency to 3",
  description:
    "Final ramp of the Front historical recovery worker. Bumps `front_recovery_ingest_concurrency` from 2 → 3. Two-gate safety: (1) the 1 → 2 ramp must have been live for at least 24h (auto-checked from the prod-actions audit trail), AND (2) the API pool must currently be healthy (no high utilization, waiters, or recent slow acquires). Either gate failing keeps the action `not-needed`, including under one-click \"Apply all\".",
  change: "Set front_recovery_ingest_concurrency = 3 (gated by 24h watch window)",
  async status() {
    const row = await storage.getSystemSetting("front_recovery_ingest_concurrency");
    const current = row?.value ?? "<unset>";
    if (current === "3") {
      return { state: "not-needed", detail: "Already set to 3." };
    }
    if (current !== "2") {
      return {
        state: "not-needed",
        detail: `Current value is ${current}; ramp the 1 → 2 action first.`,
      };
    }
    const lastRamp = await runWithWorkerDb(() =>
      getLastSuccessfulProdActionRun(RAMP_1_TO_2_ACTION_ID),
    );
    if (!lastRamp) {
      return {
        state: "not-needed",
        detail: "Waiting on a recorded successful 1 → 2 ramp (none in audit trail).",
      };
    }
    const ageMs = Date.now() - new Date(lastRamp.appliedAt).getTime();
    if (ageMs < RAMP_2_TO_3_WATCH_WINDOW_MS) {
      const hoursLeft = Math.ceil((RAMP_2_TO_3_WATCH_WINDOW_MS - ageMs) / (60 * 60 * 1000));
      return {
        state: "not-needed",
        detail: `Watch window not elapsed yet — wait ~${hoursLeft}h after the 1 → 2 ramp.`,
      };
    }
    // Live health gate: even if the 24h watch window has elapsed, refuse
    // to ramp while the API pool is currently under pressure. Operator
    // can re-press once pressure clears.
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      return {
        state: "not-needed",
        detail: `API pool under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}); refusing to ramp 2 → 3 until pressure clears.`,
      };
    }
    return {
      state: "pending",
      detail: `1 → 2 ramp applied ${Math.floor(ageMs / (60 * 60 * 1000))}h ago and API pool healthy; safe to bump to 3.`,
    };
  },
  async apply(actorId) {
    const row = await storage.getSystemSetting("front_recovery_ingest_concurrency");
    const current = row?.value ?? null;
    if (current === "3") {
      return { state: "not-needed", detail: "Already set to 3." };
    }
    if (current !== "2") {
      return {
        state: "not-needed",
        detail: `Current value is ${current ?? "<unset>"}; ramp the 1 → 2 action first.`,
      };
    }
    const lastRamp = await runWithWorkerDb(() =>
      getLastSuccessfulProdActionRun(RAMP_1_TO_2_ACTION_ID),
    );
    if (!lastRamp) {
      return {
        state: "not-needed",
        detail: "Waiting on a recorded successful 1 → 2 ramp.",
      };
    }
    const ageMs = Date.now() - new Date(lastRamp.appliedAt).getTime();
    if (ageMs < RAMP_2_TO_3_WATCH_WINDOW_MS) {
      const hoursLeft = Math.ceil((RAMP_2_TO_3_WATCH_WINDOW_MS - ageMs) / (60 * 60 * 1000));
      return {
        state: "not-needed",
        detail: `Watch window not elapsed yet — wait ~${hoursLeft}h.`,
      };
    }
    // Re-check live pool pressure at apply time — same gate as status(),
    // so an "Apply all" press cannot ramp during a live incident.
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      return {
        state: "not-needed",
        detail: `Refused: API pool under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}). Try again once pressure clears.`,
      };
    }
    await storage.setSystemSetting(
      "front_recovery_ingest_concurrency",
      "3",
      actorId ?? undefined,
    );
    return {
      state: "applied",
      detail: "Set front_recovery_ingest_concurrency = 3 (was 2).",
    };
  },
};


// ─── Task #1816: Ingestion-class concurrency 3 → 4 ───────────────────
//
// Bumps the live `ingestion` workload class budget from 3 → 4
// concurrent jobs so the Front backlog (front_webhook_apply +
// front_webhook_normalize) gets one extra parallel slot. The bump is
// applied two ways: (1) persisted to
// `system_settings.workload_class_ingestion_max_concurrency` so it
// survives redeploys (scheduler boot re-reads it), and (2)
// `setIngestionClassConcurrency()` mutates the in-memory budget so
// the change takes effect on the next scheduler tick without a
// restart. Idempotent: re-running once at 4 returns `not-needed`. Live
// pool-pressure gate (same as the 2 → 3 Front recovery ramp) refuses
// to widen while the API pool is hot.
const TARGET_INGESTION_CONCURRENCY = 4;

export const rampIngestionClassConcurrencyAction: ProdAction = {
  id: "ramp_ingestion_class_concurrency_4",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Staged concurrency ramp: widening a live workload-class budget is an operator judgment call on observed pool headroom — never auto-fired.",
  },
  title: "Ramp ingestion-class concurrency to 4",
  description:
    "Widens the scheduler's `ingestion` workload-class budget from 3 → 4 concurrent jobs so Front webhook apply/normalize gets one extra parallel slot. Independent of `front_recovery_ingest_concurrency` (which controls the historical auto-heal worker — they run in parallel). Persisted to `system_settings.workload_class_ingestion_max_concurrency` AND applied in-memory so the bump takes effect immediately. Refuses to widen while the API pool is under pressure.",
  change: `Set ${INGESTION_CLASS_CONCURRENCY_SETTING_KEY} >= ${TARGET_INGESTION_CONCURRENCY} (no-op if already at or above ${TARGET_INGESTION_CONCURRENCY}; default ${INGESTION_CLASS_CONCURRENCY_DEFAULT})`,
  async status() {
    const row = await storage.getSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY);
    const persisted = row?.value ?? "<unset>";
    const live = getIngestionClassConcurrency();
    // Floor (ramp-up) semantics: this is the 3 → 4 rung. Once a higher
    // rung (4 → 5) or the force-ramp has overshot to >= 4, this rung is
    // satisfied and must NOT perpetually re-flag as pending — and must
    // NEVER downgrade the live budget back to 4 on "Apply all".
    if (Number(persisted) >= TARGET_INGESTION_CONCURRENCY && live >= TARGET_INGESTION_CONCURRENCY) {
      return { state: "not-needed", detail: `Already at ${persisted} (>= ${TARGET_INGESTION_CONCURRENCY}, live = ${live}).` };
    }
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      return {
        state: "not-needed",
        detail: `API pool under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}); refusing to widen ingestion class until pressure clears.`,
      };
    }
    return {
      state: "pending",
      detail: `Persisted=${persisted}, live=${live}; will set persisted=${TARGET_INGESTION_CONCURRENCY} and live=${TARGET_INGESTION_CONCURRENCY}.`,
    };
  },
  async apply(actorId) {
    const row = await storage.getSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY);
    const persisted = row?.value ?? null;
    const live = getIngestionClassConcurrency();
    if (Number(persisted) >= TARGET_INGESTION_CONCURRENCY && live >= TARGET_INGESTION_CONCURRENCY) {
      return { state: "not-needed", detail: `Already at ${persisted} (>= ${TARGET_INGESTION_CONCURRENCY}, live = ${live}).` };
    }
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      return {
        state: "not-needed",
        detail: `Refused: API pool under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}). Try again once pressure clears.`,
      };
    }
    if (persisted !== String(TARGET_INGESTION_CONCURRENCY)) {
      await storage.setSystemSetting(
        INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
        String(TARGET_INGESTION_CONCURRENCY),
        actorId ?? undefined,
      );
    }
    const { previous, applied, clamped } = setIngestionClassConcurrency(TARGET_INGESTION_CONCURRENCY);
    return {
      state: "applied",
      detail: `Set ${INGESTION_CLASS_CONCURRENCY_SETTING_KEY} = ${TARGET_INGESTION_CONCURRENCY} (persisted was ${persisted ?? "<unset>"}). In-memory budget: ${previous} → ${applied}${clamped ? " (clamped)" : ""}.`,
    };
  },
};


// ─── Task #1816 follow-up: Ingestion-class concurrency 4 → 5 ────────
//
// Final widening of the scheduler's `ingestion` workload-class budget.
// Two-gate safety: (1) the 3 → 4 ramp must have been live for at
// least 24h (auto-checked from the prod-actions audit trail), AND
// (2) the API pool must currently be healthy. Mirrors the
// `ramp_front_recovery_ingest_concurrency_3` shape so "Apply all"
// behaves predictably during an incident.
const TARGET_INGESTION_CONCURRENCY_5 = 5;

const RAMP_3_TO_4_ACTION_ID = "ramp_ingestion_class_concurrency_4";

const RAMP_4_TO_5_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export const rampIngestionClassConcurrency5Action: ProdAction = {
  id: "ramp_ingestion_class_concurrency_5",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Final rung of a staged concurrency ramp: an operator judgment call on observed pool headroom after the 3→4 rung's 24h watch window — never auto-fired.",
  },
  title: "Ramp ingestion-class concurrency to 5",
  description:
    "Final ramp of the scheduler's `ingestion` workload-class budget. Bumps `workload_class_ingestion_max_concurrency` from 4 → 5 concurrent jobs so the Front webhook backlog gets one more parallel slot. Two-gate safety: (1) the 3 → 4 ramp must have been live for at least 24h (auto-checked from the prod-actions audit trail), AND (2) the API pool must currently be healthy. Persisted to system_settings AND applied in-memory so the bump takes effect immediately. Independent of the historical auto-heal worker (controlled by `front_recovery_ingest_concurrency`).",
  change: `Set ${INGESTION_CLASS_CONCURRENCY_SETTING_KEY} = ${TARGET_INGESTION_CONCURRENCY_5} (gated by 24h watch window)`,
  async status() {
    const row = await storage.getSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY);
    const persisted = row?.value ?? "<unset>";
    const live = getIngestionClassConcurrency();
    if (persisted === String(TARGET_INGESTION_CONCURRENCY_5) && live === TARGET_INGESTION_CONCURRENCY_5) {
      return { state: "not-needed", detail: `Already set to ${TARGET_INGESTION_CONCURRENCY_5} (live = ${live}).` };
    }
    if (persisted !== "4") {
      return {
        state: "not-needed",
        detail: `Persisted is ${persisted}; ramp the 3 → 4 action first.`,
      };
    }
    const lastRamp = await runWithWorkerDb(() =>
      getLastSuccessfulProdActionRun(RAMP_3_TO_4_ACTION_ID),
    );
    if (!lastRamp) {
      return {
        state: "not-needed",
        detail: "Waiting on a recorded successful 3 → 4 ramp (none in audit trail).",
      };
    }
    const ageMs = Date.now() - new Date(lastRamp.appliedAt).getTime();
    if (ageMs < RAMP_4_TO_5_WATCH_WINDOW_MS) {
      const hoursLeft = Math.ceil((RAMP_4_TO_5_WATCH_WINDOW_MS - ageMs) / (60 * 60 * 1000));
      return {
        state: "not-needed",
        detail: `Watch window not elapsed yet — wait ~${hoursLeft}h after the 3 → 4 ramp.`,
      };
    }
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      return {
        state: "not-needed",
        detail: `API pool under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}); refusing to ramp 4 → 5 until pressure clears.`,
      };
    }
    return {
      state: "pending",
      detail: `3 → 4 ramp applied ${Math.floor(ageMs / (60 * 60 * 1000))}h ago and API pool healthy; safe to bump to ${TARGET_INGESTION_CONCURRENCY_5}.`,
    };
  },
  async apply(actorId) {
    const row = await storage.getSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY);
    const persisted = row?.value ?? null;
    const live = getIngestionClassConcurrency();
    if (persisted === String(TARGET_INGESTION_CONCURRENCY_5) && live === TARGET_INGESTION_CONCURRENCY_5) {
      return { state: "not-needed", detail: `Already set to ${TARGET_INGESTION_CONCURRENCY_5} (live = ${live}).` };
    }
    if (persisted !== "4") {
      return {
        state: "not-needed",
        detail: `Persisted is ${persisted ?? "<unset>"}; ramp the 3 → 4 action first.`,
      };
    }
    const lastRamp = await runWithWorkerDb(() =>
      getLastSuccessfulProdActionRun(RAMP_3_TO_4_ACTION_ID),
    );
    if (!lastRamp) {
      return { state: "not-needed", detail: "Waiting on a recorded successful 3 → 4 ramp." };
    }
    const ageMs = Date.now() - new Date(lastRamp.appliedAt).getTime();
    if (ageMs < RAMP_4_TO_5_WATCH_WINDOW_MS) {
      const hoursLeft = Math.ceil((RAMP_4_TO_5_WATCH_WINDOW_MS - ageMs) / (60 * 60 * 1000));
      return {
        state: "not-needed",
        detail: `Watch window not elapsed yet — wait ~${hoursLeft}h.`,
      };
    }
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      return {
        state: "not-needed",
        detail: `Refused: API pool under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}). Try again once pressure clears.`,
      };
    }
    await storage.setSystemSetting(
      INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
      String(TARGET_INGESTION_CONCURRENCY_5),
      actorId ?? undefined,
    );
    const { previous, applied, clamped } = setIngestionClassConcurrency(TARGET_INGESTION_CONCURRENCY_5);
    return {
      state: "applied",
      detail: `Set ${INGESTION_CLASS_CONCURRENCY_SETTING_KEY} = ${TARGET_INGESTION_CONCURRENCY_5} (persisted was ${persisted ?? "<unset>"}). In-memory budget: ${previous} → ${applied}${clamped ? " (clamped)" : ""}.`,
    };
  },
};


// ─── Force-ramp Front recovery + ingestion concurrency (bypass gates) ───
//
// Operator escape hatch for the gated ramp ladder when the historical
// backlog needs draining and the CEO has eyes on DB health. The
// gated 2 → 3 (front_recovery_ingest_concurrency) and 3 → 4 → 5
// (workload_class_ingestion_max_concurrency) actions refuse to apply
// while `isApiPoolUnderPressure()` returns true OR before their
// 24h watch windows elapse. This action sets both knobs to their
// terminal values in one press WITHOUT consulting the pressure or
// watch-window gates — explicitly an operator override. It is
// idempotent: when both knobs already match the targets, returns
// `not-needed`. It does NOT bypass the env-bound clamp inside
// `setIngestionClassConcurrency()` (still capped at
// `INGESTION_CLASS_CONCURRENCY_MAX`), so the worst-case write stays
// inside the static safety bound.
const FORCE_RAMP_RECOVERY_CONCURRENCY = 3;

const FORCE_RAMP_INGESTION_CONCURRENCY = 5;

export const forceRampFrontDrainAction: ProdAction = {
  id: "force_ramp_front_drain_concurrency",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Emergency bypass of the pool-pressure gate and 24h watch windows — only an operator with direct DB-pool visibility may decide to force this ramp.",
  },
  title: "FORCE ramp Front recovery + ingestion concurrency (bypass gates)",
  description: `Sets front_recovery_ingest_concurrency = ${FORCE_RAMP_RECOVERY_CONCURRENCY} and workload_class_ingestion_max_concurrency = ${FORCE_RAMP_INGESTION_CONCURRENCY} in one press, bypassing the API-pool-pressure gate AND the 24h watch windows that the staged ramp actions enforce. Use only when (a) the historical Front backlog needs urgent drain AND (b) the operator has direct visibility into DB pool health (the gated ramps remain the default path). Still respects the static INGESTION_CLASS_CONCURRENCY_MAX clamp inside setIngestionClassConcurrency. Idempotent: returns not-needed when both knobs are already at target.`,
  change: `Set front_recovery_ingest_concurrency = ${FORCE_RAMP_RECOVERY_CONCURRENCY} AND ${INGESTION_CLASS_CONCURRENCY_SETTING_KEY} = ${FORCE_RAMP_INGESTION_CONCURRENCY} (no gates)`,
  async status() {
    const recRow = await storage.getSystemSetting(
      "front_recovery_ingest_concurrency",
    );
    const recCur = recRow?.value ?? "<unset>";
    const ingRow = await storage.getSystemSetting(
      INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
    );
    const ingPersisted = ingRow?.value ?? "<unset>";
    const ingLive = getIngestionClassConcurrency();
    const recOk = recCur === String(FORCE_RAMP_RECOVERY_CONCURRENCY);
    const ingOk =
      ingPersisted === String(FORCE_RAMP_INGESTION_CONCURRENCY) &&
      ingLive === FORCE_RAMP_INGESTION_CONCURRENCY;
    if (recOk && ingOk) {
      return {
        state: "not-needed",
        detail: `Already at target (recovery=${recCur}, ingestion persisted=${ingPersisted} live=${ingLive}).`,
      };
    }
    const pressure = isApiPoolUnderPressure();
    const pressureNote = pressure.underPressure
      ? ` API pool currently flagged under pressure (${pressure.reasons.join(", ")}, util=${pressure.utilizationPct}%, waiters=${pressure.waitingCount}) — this action will bypass that gate.`
      : "";
    return {
      state: "pending",
      detail: `Will set recovery ${recCur} → ${FORCE_RAMP_RECOVERY_CONCURRENCY} and ingestion persisted ${ingPersisted}/live ${ingLive} → ${FORCE_RAMP_INGESTION_CONCURRENCY}.${pressureNote}`,
    };
  },
  async apply(actorId) {
    const recRow = await storage.getSystemSetting(
      "front_recovery_ingest_concurrency",
    );
    const recBefore = recRow?.value ?? null;
    const ingRow = await storage.getSystemSetting(
      INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
    );
    const ingPersistedBefore = ingRow?.value ?? null;
    const ingLiveBefore = getIngestionClassConcurrency();

    if (
      recBefore === String(FORCE_RAMP_RECOVERY_CONCURRENCY) &&
      ingPersistedBefore === String(FORCE_RAMP_INGESTION_CONCURRENCY) &&
      ingLiveBefore === FORCE_RAMP_INGESTION_CONCURRENCY
    ) {
      return {
        state: "not-needed",
        detail: `Already at target (recovery=${recBefore}, ingestion persisted=${ingPersistedBefore} live=${ingLiveBefore}).`,
      };
    }

    const steps: string[] = [];
    if (recBefore !== String(FORCE_RAMP_RECOVERY_CONCURRENCY)) {
      await storage.setSystemSetting(
        "front_recovery_ingest_concurrency",
        String(FORCE_RAMP_RECOVERY_CONCURRENCY),
        actorId ?? undefined,
      );
      steps.push(
        `front_recovery_ingest_concurrency: ${recBefore ?? "<unset>"} → ${FORCE_RAMP_RECOVERY_CONCURRENCY}`,
      );
    }
    if (
      ingPersistedBefore !== String(FORCE_RAMP_INGESTION_CONCURRENCY) ||
      ingLiveBefore !== FORCE_RAMP_INGESTION_CONCURRENCY
    ) {
      if (ingPersistedBefore !== String(FORCE_RAMP_INGESTION_CONCURRENCY)) {
        await storage.setSystemSetting(
          INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
          String(FORCE_RAMP_INGESTION_CONCURRENCY),
          actorId ?? undefined,
        );
      }
      const { previous, applied, clamped } = setIngestionClassConcurrency(
        FORCE_RAMP_INGESTION_CONCURRENCY,
      );
      steps.push(
        `${INGESTION_CLASS_CONCURRENCY_SETTING_KEY}: persisted ${ingPersistedBefore ?? "<unset>"} → ${FORCE_RAMP_INGESTION_CONCURRENCY}, live ${previous} → ${applied}${clamped ? " (clamped by INGESTION_CLASS_CONCURRENCY_MAX)" : ""}`,
      );
    }
    return {
      state: "applied",
      detail: steps.join("; "),
    };
  },
};


// ─── Loosen API-pool pressure-gate thresholds (Neon-realistic) ───────
//
// Why this exists: the recovery worker's `backoffForApiPoolPressure`
// gate trips during business hours even though the API pool sits at
// ~8% util (1-2 active conns of 18) all day. The actual trip wire is
// `slow_acquires >= 5 in 60s` where "slow" is any acquire taking
// >100ms. Over a network-attached Neon pool, 100ms is normal jitter
// and the absolute slow-acquire COUNT scales with traffic volume
// rather than pool stress. Result: daytime recovery throughput
// collapses to ~50/hour while overnight hits 5k/hour at the same
// concurrency. See the README explainer added with this action.
//
// This action flips four `system_settings` rows that
// `apiPoolPressureTuning.ts` reads with PERF.* fallback. Empty
// settings = legacy PERF behavior (full rollback = delete the rows
// or reset them to the PERF defaults from the same admin page).
//
// Idempotent: returns `not-needed` when every row already matches the
// proposed value.
const PRESSURE_GATE_LOOSEN_TARGETS = {
  db_pool_util_warn_pct: "85",
  db_pool_waiting_warn_count: "2",
  db_api_slow_acquire_backoff_count: "10",
  db_acquire_wait_warn_ms: "500",
  // Flip the Phase 3 Front recovery hysteresis switch ON in the same
  // press so the recovery worker's per-page pressure check
  // (frontRecoveryTuning.ts) stops using legacyDefaults() — which
  // hard-reads PERF.DB_POOL_UTIL_WARN_PCT and would otherwise stay on
  // the pre-loosen 80% threshold even after the four db_* knobs above
  // are bumped. TUNED_DEFAULTS (90%/80% with 2-sample required, 200ms
  // page delay) are the intended companion behavior.
  front_recovery_pool_threshold_tuning_enabled: "true",
} as const;

export const loosenApiPoolPressureGateAction: ProdAction = {
  id: "loosen_api_pool_pressure_gate",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Loosens a live safety gate on the API pool (five thresholds at once) — a deliberate operator tradeoff between drain speed and pool protection, never auto-fired.",
  },
  title: "Loosen API-pool pressure-gate thresholds (Neon-realistic)",
  description: `Sets five rows that together loosen the API-pool pressure gate to Neon-realistic values AND flip the matching Front recovery hysteresis switch in one press: (1) db_pool_util_warn_pct=85 (was 80), (2) db_pool_waiting_warn_count=2 (was 1; brief queueing is not stress), (3) db_api_slow_acquire_backoff_count=10 (was 5; allow more genuine slow acquires before backing off), (4) db_acquire_wait_warn_ms=500ms (was 100ms; 100ms is Neon network jitter, not pool exhaustion), and (5) front_recovery_pool_threshold_tuning_enabled=true so frontRecoveryTuning.ts switches from legacyDefaults() (which hard-reads PERF.DB_POOL_UTIL_WARN_PCT and would otherwise stay on the pre-loosen behavior) to TUNED_DEFAULTS (90%/80% with 2-sample required, 200ms page delay). Targets the symptom that recovery throughput collapses daytime even though the API pool is at ~8% util — the gate was tripping on slow-acquire COUNT, which scales with traffic volume rather than pool stress. Rollback: lower the targets and apply again, or delete the five system_settings rows to restore PERF / kill-switch defaults. Idempotent: not-needed when all five rows already match.`,
  change: `Set db_pool_util_warn_pct=85, db_pool_waiting_warn_count=2, db_api_slow_acquire_backoff_count=10, db_acquire_wait_warn_ms=500, front_recovery_pool_threshold_tuning_enabled=true`,
  async status() {
    const rows = await storage.getSystemSettings(
      Object.keys(PRESSURE_GATE_LOOSEN_TARGETS),
    );
    const diffs: string[] = [];
    for (const [key, target] of Object.entries(PRESSURE_GATE_LOOSEN_TARGETS)) {
      const current = rows[key] ?? "<unset>";
      if (current !== target) diffs.push(`${key}: ${current} → ${target}`);
    }
    if (diffs.length === 0) {
      return {
        state: "not-needed",
        detail: "All four thresholds already at target values.",
      };
    }
    return {
      state: "pending",
      detail: `Will update ${diffs.length} of 4 thresholds: ${diffs.join("; ")}.`,
    };
  },
  async apply(actorId) {
    const rows = await storage.getSystemSettings(
      Object.keys(PRESSURE_GATE_LOOSEN_TARGETS),
    );
    const steps: string[] = [];
    for (const [key, target] of Object.entries(PRESSURE_GATE_LOOSEN_TARGETS)) {
      const current = rows[key] ?? null;
      if (current === target) continue;
      await storage.setSystemSetting(key, target, actorId ?? undefined);
      steps.push(`${key}: ${current ?? "<unset>"} → ${target}`);
    }
    if (steps.length === 0) {
      return {
        state: "not-needed",
        detail: "All four thresholds already at target values.",
      };
    }
    return {
      state: "applied",
      detail: `Updated ${steps.length} of 4 thresholds: ${steps.join("; ")}. New values take effect within ~30s (cache TTL in apiPoolPressureTuning.ts).`,
    };
  },
};


// ─── Front recovery active-inbox filter disable (2026-05-26) ─────────
//
// Emergency fix for the "ingesting 0 messages per recovery job" bug
// observed in prod 2026-05-26: every recovery window for historical
// months (2025-09, etc.) was returning scanned=25,000 / skipped=25,000
// / ingested=0 because the active-inbox filter in
// frontHistoricalRecovery.ts:2189-2212 loads inboxes from `/inboxes`
// (live list) and drops any conversation whose inbox IDs don't
// intersect that set. Historical months are full of conversations
// from inboxes that have since been archived or deleted in Front, so
// every conv fails the filter and the window completes with zero
// ingest.
//
// The filter is fine for the live webhook hot-path but actively
// harmful for historical backfill. This action flips the kill switch
// `front_recovery_active_inbox_filter_enabled` to false. The setting
// is read by `isPoolEpicSwitchEnabled()` per window-entry
// (frontHistoricalRecovery.ts:2015), so the next window picks up the
// change without a redeploy (the 60s cache TTL applies but
// setPoolEpicSwitch() also primes the in-memory map immediately for
// the current process).
export const disableFrontRecoveryActiveInboxFilterAction: ProdAction = {
  id: "disable_front_recovery_active_inbox_filter",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deliberate recovery-scope widening: dropping the active-inbox filter changes what historical recovery ingests — an operator policy flip, never auto-fired.",
  },
  title: "Disable Front recovery active-inbox filter (drain historical gap)",
  description:
    "Flips the kill switch front_recovery_active_inbox_filter_enabled to false. Fixes the bug observed 2026-05-26 where every recovery window for historical months (e.g. 2025-09) was returning scanned=25,000 / skipped=25,000 / ingested=0. The filter drops any conversation whose inbox IDs don't intersect the live /inboxes list — historical conversations from archived inboxes always fail this check, so the entire backfill produces zero ingest. Filter is appropriate for live webhook ingestion but harmful for historical recovery. Takes effect on the NEXT window-entry (per-window read at frontHistoricalRecovery.ts:2015), no redeploy required. Idempotent: not-needed when the switch is already off. Rollback: flip the row back to true via the admin pool-epic switches surface.",
  change:
    "Set front_recovery_active_inbox_filter_enabled=false (in-memory override + system_settings row).",
  async status() {
    // Read via getPoolEpicSwitchSnapshot — same source the recovery
    // worker uses (isPoolEpicSwitchEnabled). Reading via
    // storage.getSystemSettings caused a false "already false" in
    // production on 2026-05-26 because that path was returning a
    // stale value while the row was still "true".
    const { getPoolEpicSwitchSnapshot } = await import("../poolEpicKillSwitches");
    const snap = await getPoolEpicSwitchSnapshot();
    const effective = snap["front_recovery_active_inbox_filter_enabled"]?.effective;
    if (effective === false) {
      return {
        state: "not-needed",
        detail: "front_recovery_active_inbox_filter_enabled is already false.",
      };
    }
    return {
      state: "pending",
      detail: `front_recovery_active_inbox_filter_enabled is effective=${effective} — will set to false.`,
    };
  },
  async apply(actorId) {
    // Idempotence: return not-needed only when BOTH the runtime-effective
    // value AND the authoritative system_settings row say `false`. If
    // either disagrees (the bug observed 2026-05-26), write through via
    // setPoolEpicSwitch so the row and the in-memory override map
    // converge.
    const { setPoolEpicSwitch, getPoolEpicSwitchSnapshot } = await import(
      "../poolEpicKillSwitches"
    );
    const effectiveBefore = (await getPoolEpicSwitchSnapshot())[
      "front_recovery_active_inbox_filter_enabled"
    ]?.effective;
    const rowsBefore = await storage.getSystemSettings([
      "front_recovery_active_inbox_filter_enabled",
    ]);
    const rowBefore = (
      rowsBefore["front_recovery_active_inbox_filter_enabled"] ?? "true"
    ).toLowerCase();
    if (effectiveBefore === false && rowBefore === "false") {
      return {
        state: "not-needed",
        detail: `front_recovery_active_inbox_filter_enabled is already false (effective=false, row="false").`,
      };
    }
    await setPoolEpicSwitch(
      "front_recovery_active_inbox_filter_enabled",
      false,
      actorId ?? undefined,
    );
    return {
      state: "applied",
      detail:
        `Wrote front_recovery_active_inbox_filter_enabled=false (in-memory + system_settings row). Effective-before=${effectiveBefore}, row-before="${rowBefore}". Next recovery window will skip the inbox filter and ingest every conversation Front returns. Other Front recovery instances pick up the change within ~60s (pool-epic switch cache TTL).`,
    };
  },
};


// ─── Front backlog workload-class rewrite (2026-05-24) ───────────────
//
// Companion to the in-code re-tag of the four reconciliation /
// full-backfill enqueue sites in frontWebhookIngestion.ts +
// frontHistoricalRecovery.ts. Those edits stop new rows from inheriting
// `workload_class = 'maintenance'`, but pre-existing pending rows still
// carry the old class and remain throttled by the maintenance cap=1.
//
// This action rewrites those existing pending rows to `ingestion` so
// they drain through the cap=3 class alongside live Front webhooks.
// Strict guardrails:
//   - Only touches status='pending' (never processing/failed/dead_letter
//     /completed/cancelled).
//   - Only touches the two Front queues affected by the re-tag
//     (front_webhook_normalize, front_webhook_apply).
//   - Only flips workload_class='maintenance' → 'ingestion'; rows
//     already on `ingestion` (e.g. live webhooks) are untouched.
//   - Priority and dedupe_key are preserved, so the scheduler's
//     priority-ordered claim still favors live webhooks (priority 50)
//     over reconciliation rows (priority 200/300).
// Idempotent: re-running after a successful apply finds zero matches.
const FRONT_BACKLOG_REWRITE_QUEUES = [
  "front_webhook_normalize",
  "front_webhook_apply",
] as const;


export const rewritePendingFrontBacklogToIngestionAction: ProdAction = {
  id: "rewrite_pending_front_backlog_to_ingestion",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot legacy-queue migration already applied in production — if this re-arms, new maintenance-class Front rows appeared, which is a feeder regression to investigate, not silently auto-rewrite.",
  },
  title: "[SUPERSEDED by front_warp_class_backfill] Reclassify pending Front backlog as ingestion",
  description:
    "Companion to the 2026-05-24 in-code re-tag of Front reconciliation enqueues. Rewrites pending front_webhook_normalize + front_webhook_apply rows from workload_class='maintenance' → 'ingestion' so the existing backlog drains through the cap=3 ingestion class instead of the cap=1 maintenance class. Only touches status='pending' rows; processing/failed/dead_letter/completed/cancelled are never modified. Priority is preserved so live webhooks (priority 50) still preempt reconciliation (priority 200/300). One-and-done: a single press kicks off a background drain on the worker pool that processes the entire backlog in 5000-row chunks (FOR UPDATE SKIP LOCKED, well under the 10s DB-hold cap) and writes the final tally to History when complete.",
  change:
    "UPDATE work_queue SET workload_class='ingestion' WHERE queue_name IN (front_webhook_normalize, front_webhook_apply) AND status='pending' AND workload_class='maintenance' — chunked into 5000-row background-drain batches.",
  async status() {
    if (isDrainRunning("rewrite_pending_front_backlog_to_ingestion")) {
      const s = getDrainState("rewrite_pending_front_backlog_to_ingestion")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const result = await withDbAttribution(
      "maintenance:prod-actions-front-backlog-reclassify-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM work_queue
          WHERE queue_name = ANY(${bindArrayParam([...FRONT_BACKLOG_REWRITE_QUEUES], "text")})
            AND status = 'pending'
            AND workload_class = 'maintenance'
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No pending Front backlog rows still tagged maintenance.",
      };
    }
    return {
      state: "pending",
      detail: `${n} pending Front backlog row(s) would be reclassified maintenance → ingestion via background drain.`,
    };
  },
  async apply(actorId) {
    // One-and-done: kick a background drain that processes 5000-row
    // chunks until exhausted. Returns immediately; the final tally is
    // recorded in `prod_action_runs` when the drain completes.
    const BATCH_SIZE = 5000;
    const out = await startBackgroundDrain(
      {
        actionId: "rewrite_pending_front_backlog_to_ingestion",
        actionTitle: "Reclassify pending Front backlog as ingestion",
        attributionLabel: "maintenance:prod-actions-front-backlog-reclassify",
        countPending: async () => {
          const r = await withDbAttribution(
            "maintenance:prod-actions-front-backlog-reclassify-count",
            () => getDb().execute(sql`
              SELECT COUNT(*)::int AS n
              FROM work_queue
              WHERE queue_name = ANY(${bindArrayParam([...FRONT_BACKLOG_REWRITE_QUEUES], "text")})
                AND status = 'pending'
                AND workload_class = 'maintenance'
            `),
          );
          return Number((r.rows as any[])[0]?.n ?? 0);
        },
        runChunk: async () => {
          const updated = await withDbAttribution(
            "maintenance:prod-actions-front-backlog-reclassify",
            () => getDb().execute(sql`
              UPDATE work_queue AS wq
              SET workload_class = 'ingestion',
                  updated_at = NOW()
              FROM (
                SELECT id
                FROM work_queue
                WHERE queue_name = ANY(${bindArrayParam([...FRONT_BACKLOG_REWRITE_QUEUES], "text")})
                  AND status = 'pending'
                  AND workload_class = 'maintenance'
                ORDER BY id
                LIMIT ${BATCH_SIZE}
                FOR UPDATE SKIP LOCKED
              ) AS target
              WHERE wq.id = target.id
              RETURNING wq.queue_name
            `),
          );
          const processed = updated.rowCount ?? (updated.rows as any[]).length;
          const perKey: Record<string, number> = {};
          for (const r of updated.rows as any[]) {
            perKey[r.queue_name] = (perKey[r.queue_name] ?? 0) + 1;
          }
          return { processed, perKey };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #1829: Front warp-speed class backfill ────────────────────
//
// Production counterpart to `scripts/front-warp-class-backfill.ts`.
// Promotes every Front-queue row from legacy `workload_class='ingestion'`
// to the modern `workload_class='front_ingestion'` so the fast-poll
// loop drains all of them — and so the ON→OFF rollback path no
// longer leaves rows stranded. One-and-done (Task #1969): a single
// press kicks a background drain on the worker pool that processes
// 5000-row chunks (FOR UPDATE SKIP LOCKED) until exhausted, stays
// under the 10s DB-hold cap per chunk, and writes the final tally
// to History on completion. Idempotent.
const FRONT_WARP_BACKFILL_QUEUES = [
  "front_webhook_normalize",
  "front_webhook_apply",
  "front_reconciliation",
] as const;

const FRONT_WARP_BACKFILL_STATUSES = [
  "pending",
  "processing",
  "leased",
  "failed",
  "dead_letter",
] as const;

export const frontWarpClassBackfillAction: ProdAction = {
  id: "front_warp_class_backfill",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Part of the operator's warp-speed cutover choreography (pairs with the master-switch flip) — a re-armed pending row means legacy-class rows re-appeared and warrants investigation, not an auto-rewrite.",
  },
  title: "Backfill Front backlog → workload_class='front_ingestion' (Task #1829)",
  description:
    "Modernizes every existing Front-queue row (front_webhook_normalize, front_webhook_apply, front_reconciliation) from legacy workload_class='ingestion' → 'front_ingestion' so the warp-speed fast-poll loop drains all of them uniformly and the rollback path (master switch OFF) doesn't strand legacy rows. One-and-done: a single press starts a background drain that processes 5000-row chunks (FOR UPDATE SKIP LOCKED) on the worker pool, well under the 10s DB-hold cap, until exhausted. Only touches pending/processing/leased/failed/dead_letter rows — terminal rows (completed/cancelled) are left alone. Pure metadata: no payload, dedupe_key, attempt_count, or priority touched. Idempotent.",
  change:
    "UPDATE work_queue SET workload_class='front_ingestion' WHERE queue_name IN (front_webhook_normalize, front_webhook_apply, front_reconciliation) AND workload_class='ingestion' AND status IN (pending, processing, leased, failed, dead_letter) — chunked into 5000-row background-drain batches.",
  async status() {
    if (isDrainRunning("front_warp_class_backfill")) {
      const s = getDrainState("front_warp_class_backfill")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const result = await withDbAttribution(
      "maintenance:prod-actions-front-warp-backfill-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM work_queue
          WHERE queue_name = ANY(${bindArrayParam([...FRONT_WARP_BACKFILL_QUEUES], "text")})
            AND workload_class = 'ingestion'
            AND status = ANY(${bindArrayParam([...FRONT_WARP_BACKFILL_STATUSES], "text")})
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return {
        state: "not-needed",
        detail:
          "No legacy Front rows remain — every Front-queue row is already on workload_class='front_ingestion'.",
      };
    }
    return {
      state: "pending",
      detail: `${n} legacy Front row(s) would be reclassified ingestion → front_ingestion via background drain.`,
    };
  },
  async apply(actorId) {
    const BATCH_SIZE = 5000;
    const out = await startBackgroundDrain(
      {
        actionId: "front_warp_class_backfill",
        actionTitle: "Backfill Front backlog → workload_class='front_ingestion'",
        attributionLabel: "maintenance:prod-actions-front-warp-backfill",
        countPending: async () => {
          const r = await withDbAttribution(
            "maintenance:prod-actions-front-warp-backfill-count",
            () => getDb().execute(sql`
              SELECT COUNT(*)::int AS n
              FROM work_queue
              WHERE queue_name = ANY(${bindArrayParam([...FRONT_WARP_BACKFILL_QUEUES], "text")})
                AND workload_class = 'ingestion'
                AND status = ANY(${bindArrayParam([...FRONT_WARP_BACKFILL_STATUSES], "text")})
            `),
          );
          return Number((r.rows as any[])[0]?.n ?? 0);
        },
        runChunk: async () => {
          const updated = await withDbAttribution(
            "maintenance:prod-actions-front-warp-backfill",
            () => getDb().execute(sql`
              UPDATE work_queue AS wq
              SET workload_class = 'front_ingestion',
                  updated_at = NOW()
              FROM (
                SELECT id
                FROM work_queue
                WHERE queue_name = ANY(${bindArrayParam([...FRONT_WARP_BACKFILL_QUEUES], "text")})
                  AND workload_class = 'ingestion'
                  AND status = ANY(${bindArrayParam([...FRONT_WARP_BACKFILL_STATUSES], "text")})
                ORDER BY id
                LIMIT ${BATCH_SIZE}
                FOR UPDATE SKIP LOCKED
              ) AS target
              WHERE wq.id = target.id
              RETURNING wq.queue_name
            `),
          );
          const processed = updated.rowCount ?? (updated.rows as any[]).length;
          const perKey: Record<string, number> = {};
          for (const r of updated.rows as any[]) {
            perKey[r.queue_name] = (perKey[r.queue_name] ?? 0) + 1;
          }
          return { processed, perKey };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Registry ────────────────────────────────────────────────────────

// ─── Front gap-drain warp action (2026-05-26) ─────────────────────────
//
// One-press flipper that puts the Front auto-heal loop
// (`runFrontAutoClosureTick`) into warp-drain mode by writing three
// `system_settings` rows in lockstep. The auto-closure tick runs every
// ~17s as a `front_auto_closure_tick` work-queue job and inspects every
// month with a non-zero ingest_gap. Out of the box it enqueues only
// **1** historical-backfill recovery per tick and then puts that month
// on a **6-hour cooldown**, so a 13-month / 100k+ message gap takes
// weeks to drain. The warp values below let every gap month get a
// recovery enqueued each tick (subject to the per-queue worker
// concurrency cap of 2) and re-enqueue every 20 min if still incomplete.
// Safe because the Front rate-limit guard, same-response suppression,
// active-inbox filter, and pool-pressure backoff in the historical
// recovery worker already protect against API hammering.
const FRONT_GAP_DRAIN_WARP_TARGETS: { key: string; value: string }[] = [
  { key: "front_auto_closure_ingest_recovery_budget", value: "25" },
  { key: "front_auto_closure_reenqueue_cooldown_minutes", value: "20" },
  { key: "front_auto_closure_retry_budget", value: "10" },
  { key: "front_recovery_max_concurrent_jobs", value: "3" },
];


export const enableFrontGapDrainWarpAction: ProdAction = {
  id: "enable_front_gap_drain_warp",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deliberate operator mode flip: puts the Front auto-heal loop into continuous-drain warp (three settings at once) — a throughput policy decision, never auto-fired.",
  },
  title: "Enable Front gap-drain warp mode",
  description:
    "Puts the Front auto-heal loop into continuous-drain mode so known ingest gaps close without operator intervention. Sets ingest_recovery_budget=25 (up from 1 — enqueue every gap month each tick), reenqueue_cooldown_minutes=20 (down from 360 — re-attempt every 20 min instead of every 6 hours), retry_budget=10 (up from 2). Idempotent: applying it again reports `not-needed` once all three match. Safe because the Front recovery worker is already throttled by concurrency=2, Front rate-limit guard, same-response suppression, and pool-pressure backoff.",
  change: FRONT_GAP_DRAIN_WARP_TARGETS.map(
    (t) => `Set ${t.key} = ${t.value}`,
  ).join("; "),
  async status() {
    const diffs: string[] = [];
    for (const t of FRONT_GAP_DRAIN_WARP_TARGETS) {
      const row = await storage.getSystemSetting(t.key);
      const current = row?.value ?? "<unset>";
      if (current !== t.value) diffs.push(`${t.key}: ${current} → ${t.value}`);
    }
    if (diffs.length === 0) {
      return { state: "not-needed", detail: "All three warp-drain settings already in place." };
    }
    return {
      state: "pending",
      detail: `${diffs.length} setting(s) to flip — ${diffs.join("; ")}.`,
    };
  },
  async apply(actorId) {
    const flipped: string[] = [];
    for (const t of FRONT_GAP_DRAIN_WARP_TARGETS) {
      const row = await storage.getSystemSetting(t.key);
      const current = row?.value ?? null;
      if (current === t.value) continue;
      await storage.setSystemSetting(t.key, t.value, actorId ?? undefined);
      flipped.push(`${t.key}: ${current ?? "<unset>"} → ${t.value}`);
    }
    if (flipped.length === 0) {
      return { state: "not-needed", detail: "All three warp-drain settings already in place." };
    }
    return {
      state: "applied",
      detail: `Flipped ${flipped.length} setting(s) — ${flipped.join("; ")}.`,
    };
  },
};

// ─── Inline PROD_ACTIONS entries hoisted to named consts (F7) ────────
// These were inline `killSwitchAction({...})` / object-literal entries in
// the monolithic PROD_ACTIONS array; hoisting is argument-verbatim so the
// composition root can reference them by name.

export const enableFrontRecoveryPoolTuningAction = killSwitchAction({
  id: "enable_front_recovery_pool_tuning",
  switchName: "front_recovery_pool_threshold_tuning_enabled",
  targetValue: true,
  title: "Enable Front recovery pool-threshold tuning",
  description:
    "Activates the hysteresis-aware pool-pressure check and the 500ms→200ms inter-page sleep so Front recovery can ramp safely.",
});

export const rampFrontRecoveryIngestConcurrencyAction = systemSettingAction({
  id: "ramp_front_recovery_ingest_concurrency",
  key: "front_recovery_ingest_concurrency",
  targetValue: "2",
  satisfiedWhenAtLeast: true,
  title: "Ramp Front recovery ingest concurrency to 2",
  description:
    "Bumps the Front historical recovery worker's ingest concurrency from 1 → 2 (floor: a no-op once it is already at 2 or higher). The 1 → 3 ramp ships as a separate follow-up after the 24h watch window.",
});

export const enableFrontWarpSpeedAction = killSwitchAction({
  id: "enable_front_warp_speed",
  switchName: "front_warp_speed_enabled",
  targetValue: true,
  title: "Enable Front warp-speed throughput (Task #1829)",
  description:
    "Master switch for the Front pipeline warp-speed throughput epic. Flipping ON activates: (1) the dedicated `front_ingestion` workload class scheduler (multi-dispatch fast-poll loop in workScheduler.ts), (2) the enqueueJob remap that promotes Front-queue rows to `front_ingestion` at enqueue time, and (3) the fast-poll inter-cycle timer. Inner safety guards (`front_ingestion_api_waiter_backoff_enabled`, `front_ingestion_front_rate_limit_guard_enabled`) default ON so flipping the master switch on does NOT unlock unsafe behavior. Without this switch the front_ingestion class is dormant and rows drain through the regular scheduler only. Pair with `front_warp_class_backfill` to promote any legacy `workload_class='ingestion'` Front rows after flipping.",
});

// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const frontThroughputDomain: ProdActionDomain = {
  name: "frontThroughput",
  actions: [
    enableFrontRecoveryPoolTuningAction,
    rampFrontRecoveryIngestConcurrencyAction,
    ramp2to3Action,
    rampIngestionClassConcurrencyAction,
    rampIngestionClassConcurrency5Action,
    forceRampFrontDrainAction,
    loosenApiPoolPressureGateAction,
    disableFrontRecoveryActiveInboxFilterAction,
    rewritePendingFrontBacklogToIngestionAction,
    frontWarpClassBackfillAction,
    enableFrontGapDrainWarpAction,
    enableFrontWarpSpeedAction,
  ],
};
