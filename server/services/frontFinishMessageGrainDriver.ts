// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx. The heavy work runs through applyFinishFrontMessageGrainCoverage, whose background drain takes its own cross-instance advisory lock.
/**
 * Task #2529 — Automatically finish Front message-grain coverage.
 *
 * Task #2511 shipped `finish_front_message_grain_coverage`, the single
 * one-press operator control that drives every in-scope Front coverage
 * month (at/after the hard-coded `FRONT_ADOPTION_DATE` floor) to a real
 * message-grain (`messages_all`) denominator. It already self-heals on its
 * own cadence via the Task #2086 prod-action self-heal scheduler — but ONLY
 * when the master `enable_prod_action_self_heal` switch is ON, which enrolls
 * EVERY opted-in maintenance action at once.
 *
 * This module is the small, bounded, **default-OFF dedicated driver** that
 * keeps new months at message grain on a cadence WITHOUT requiring the
 * global self-heal master switch — mirroring the Task #2365 scheduled
 * message-grain UPGRADE driver (`front_message_grain_upgrade_enabled`).
 * The two are complementary: #2365 re-probes the denominator gated behind
 * `front_analytics_per_message_enum_enabled` (it never forces enumeration),
 * while this driver invokes the SAME shared apply path the operator presses
 * (`applyFinishFrontMessageGrainCoverage`), which (1) relabels every
 * free-convertible month for zero Front calls and (2) forces the per-message
 * enumeration walk past that switch to re-measure the rest.
 *
 * What each tick does:
 *   1. Honors the same gates as the manual control / its sibling drivers —
 *      its own default-OFF master switch, the queue-drain pause, and
 *      `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 *   2. No-ops with a `blocked` readout while the Front auth breaker is open
 *      (reconnect Front first) — never a failed run.
 *   3. Otherwise calls `applyFinishFrontMessageGrainCoverage(null)` — the
 *      exact shared apply path the panel button uses. The free relabel runs
 *      synchronously; anything still needing a Front re-pull is handed to the
 *      shared worker-pool background drain (which itself takes a cluster-wide
 *      advisory lock, so this tick firing on every autoscale instance is
 *      safe).
 *   4. Persists a last-run JSON summary for the operator readout.
 *
 * GRAIN-ONLY (inherited from the shared apply path): it re-measures the
 * denominator grain, it does NOT drive the recovery numerator (that is
 * `reach_front_coverage_full_message_grain`'s job, Task #1920).
 *
 * No new Front API endpoint is introduced — all Front traffic flows through
 * the shared apply path's existing search-fallback + per-message enumeration
 * (Front **Search Conversations** + **List Conversation Messages**), entirely
 * outside any DB hold and rate-limited + auth-breaker-aware via the shared
 * Front client.
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { frontAuthBreakerActive } from "./frontAuthBreaker";

export const QUEUE_NAME = "front_finish_message_grain";

/** Master enable switch. Default OFF — opt-in because a tick can spawn real
 * Front enumeration HTTP traffic via the shared apply path, not a pure cache
 * read. */
export const SETTING_ENABLED = "front_finish_message_grain_enabled";

/** Persisted JSON summary of the most recent tick for the operator readout
 * (avoids scraping worker logs). */
export const SETTING_LAST_RUN = "front_finish_message_grain_last_run";

export const TICK_INTERVAL_MS = Number(
  process.env.FRONT_FINISH_MESSAGE_GRAIN_INTERVAL_MS || 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

/**
 * Test seam. The tick invokes the real
 * `applyFinishFrontMessageGrainCoverage`, which relabels rows and can start a
 * live Front-backed background drain. Tests inject a deterministic stand-in so
 * the gating + outcome bookkeeping can be pinned without a live Front.
 * Production leaves it null and uses the real shared apply path.
 */
type ApplyFn = (
  actorId: string | null,
) => Promise<{
  state: "applied" | "not-needed" | "blocked" | "error";
  detail?: string;
  rowsAffected?: number;
  integration?: string;
}>;
let applyOverride: ApplyFn | null = null;
async function doApply(actorId: string | null): ReturnType<ApplyFn> {
  if (applyOverride) return applyOverride(actorId);
  const { applyFinishFrontMessageGrainCoverage } = await import(
    "./prodActionsRegistry"
  );
  return applyFinishFrontMessageGrainCoverage(actorId);
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export interface FinishMessageGrainTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  killSwitch: boolean;
  breakerOpen: boolean;
  /** True when the shared apply path was actually invoked this tick. */
  applied: boolean;
  /** Outcome state from the shared apply path (absent when a gate short-circuited). */
  outcomeState?: "applied" | "not-needed" | "blocked" | "error";
  /** Plain-English detail from the shared apply path or the gate that fired. */
  detail?: string;
  /** Rows relabeled by the free phase (when reported by the apply path). */
  rowsAffected?: number;
  /** Reason a tick was a no-op (gate that fired). */
  reason?: string;
}

/**
 * Persist the most recent tick summary so the operator status route can
 * surface what the driver last did. Never throws — a persistence failure must
 * not fail the tick.
 */
async function persistLastRun(
  result: FinishMessageGrainTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[FrontFinishMessageGrain] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

export type LastFinishRunStatus = "ok" | "never_run" | "unreadable";

export interface LastFinishRunRead {
  lastRun: FinishMessageGrainTickResult | null;
  status: LastFinishRunStatus;
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so a status
 * readout can tell "never ran" (normal on a fresh deploy) apart from "stored
 * value unreadable" (a persistence regression). Never throws.
 */
export async function readLastFinishMessageGrainRun(): Promise<LastFinishRunRead> {
  let raw: string | undefined;
  try {
    raw = (await getSystemSetting(SETTING_LAST_RUN))?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FrontFinishMessageGrain] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
  if (!raw) return { lastRun: null, status: "never_run" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as FinishMessageGrainTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[FrontFinishMessageGrain] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FrontFinishMessageGrain] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * One finish pass. Evaluates the gates in order (any failure is a logged
 * no-op, never a thrown error), then invokes the SAME shared apply path the
 * operator button uses. Persists the summary as the last-run readout before
 * returning. Non-throwing by contract.
 */
export async function runFinishMessageGrainTick(opts?: {
  now?: Date;
}): Promise<FinishMessageGrainTickResult> {
  const result = await computeFinishMessageGrainTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeFinishMessageGrainTick(opts?: {
  now?: Date;
}): Promise<FinishMessageGrainTickResult> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const killSwitch = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
  const breakerOpen = frontAuthBreakerActive();
  const result: FinishMessageGrainTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    killSwitch,
    breakerOpen,
    applied: false,
  };

  if (!enabled) {
    result.reason = "driver disabled in system_settings";
    return result;
  }
  if (paused) {
    result.reason = "queue paused via queue_drain_state";
    return result;
  }
  if (killSwitch) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    return result;
  }
  if (breakerOpen) {
    // Mirror the manual control: while Front auth is dead, report `blocked`
    // (reconnect Front first) rather than firing a run that cannot succeed.
    result.outcomeState = "blocked";
    result.reason = "front auth breaker open — reconnect Front first";
    return result;
  }

  // All gates passed — invoke the shared apply path the panel button uses.
  // Non-throwing by contract: a failure is captured as an `error` outcome so
  // the next tick retries.
  try {
    const outcome = await doApply(null);
    result.applied = true;
    result.outcomeState = outcome.state;
    if (outcome.detail != null) result.detail = outcome.detail;
    if (typeof outcome.rowsAffected === "number") {
      result.rowsAffected = outcome.rowsAffected;
    }
  } catch (err: any) {
    result.applied = true;
    result.outcomeState = "error";
    result.detail = err?.message ?? String(err);
    console.warn(
      `[FrontFinishMessageGrain] tick apply failed: ${err?.message ?? err}`,
    );
  }
  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FrontFinishMessageGrain] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    // Cheap due-check: skip enqueue entirely when disabled so a default-OFF
    // deploy never piles up no-op jobs.
    const enabled = parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
    if (!enabled) return;
    const { enqueueJob } = await import("./workScheduler");
    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);
    await enqueueJob({
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket },
      dedupeKey: `${QUEUE_NAME}:scheduled:${bucket}`,
      maxAttempts: 2,
    });
  } catch (err: any) {
    console.warn(
      `[FrontFinishMessageGrain] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFrontFinishMessageGrainScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FrontFinishMessageGrain] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFrontFinishMessageGrainScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __frontFinishMessageGrainTestHelpers = {
  enqueueScheduledTick,
  /** Inject a deterministic apply stand-in (or null to restore the real
   * shared apply path) so tests can pin gating + outcome bookkeeping without
   * a live Front. */
  setApplyOverride(fn: ApplyFn | null): void {
    applyOverride = fn;
  },
};
