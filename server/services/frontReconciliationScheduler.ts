// @db-pool-intent: worker
// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Task #1825 — Front reconciliation enqueue scheduler.
 *
 * Periodically enqueues a `front_reconciliation` job so the in-app
 * sweep (`runFrontReconciliation` in `frontWebhookIngestion.ts`)
 * actually runs on a cadence. Prior to this scheduler, the queue had
 * a handler but no producer — when the live Front webhook stream
 * silently dropped events (e.g. the May 18 → May 21 outage), the
 * auto-heal path that pulls missed conversations off Front's REST API
 * never fired and the `front_webhook_normalize` backlog kept growing
 * until an operator noticed.
 *
 * Two enqueue surfaces, both go through `enqueueWithGate` which runs
 * EVERY check (kill switches + in-flight pre-check) and the enqueue
 * itself inside a single `runWithWorkerDb` scope:
 *   - `enqueueScheduledFrontReconciliation()` — the timer tick.
 *   - `enqueueManualFrontReconciliation()` — the CEO action.
 *
 * Duplicate-prevention has two layers:
 *   1. Dedupe key on `enqueueJob` (per-bucket; scheduler vs manual
 *      buckets are independent so a manual kick inside the same
 *      scheduler interval still goes through).
 *   2. DB pre-check: if ANY `front_reconciliation` row is in
 *      `pending` / `processing` / `leased`, BOTH paths no-op.
 *      Required because the dedupe key alone changes each bucket and
 *      cannot prevent a fresh enqueue from overlapping a long-running
 *      or stuck in-flight job.
 *
 * Runtime controls (read fresh on every tick / press):
 *   - `system_settings.front_reconciliation_scheduler_enabled`
 *     (default ON; missing row treated as ON; set to "false" to
 *     disable without restarting). Mirrors the
 *     `PERF.FRONT_RECONCILIATION_ENABLED` env switch — env OFF wins.
 *   - `system_settings.front_reconciliation_interval_minutes`
 *     (default falls back to `PERF.FRONT_RECONCILIATION_INTERVAL_MS`;
 *     valid integer 1..1440, otherwise the PERF default is used). The
 *     interval is re-resolved on every tick so an operator change
 *     takes effect within one scheduler cadence.
 *   - `queue_drain_state` pause for the `front_reconciliation` queue.
 *   - `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 *   - Front access token presence.
 */
import { sql } from "drizzle-orm";
import { PERF } from "../perfConfig";
import { runWithWorkerDb, getDb, withDbAttribution } from "../db";
import { storage } from "../storage";
import { enqueueJob } from "./workScheduler";
import { isQueuePaused, ensureQueueDrainStateLoaded } from "./queueDrainControl";
import { isKillSwitchEnabled, ensureKillSwitchesLoaded } from "./killSwitches";

export const FRONT_RECONCILIATION_QUEUE = "front_reconciliation";
const SETTINGS_KEY_ACCESS = "front_access_token";
export const SCHEDULER_ENABLED_SETTING = "front_reconciliation_scheduler_enabled";
export const SCHEDULER_INTERVAL_SETTING = "front_reconciliation_interval_minutes";
const MANUAL_DEDUPE_BUCKET_MS = 60_000;
const RESCHEDULE_CHECK_MS = 60_000;

export type FrontReconciliationGateReason =
  | "perf_flag_disabled"
  | "scheduler_setting_disabled"
  | "queue_paused"
  | "non_critical_sweeps_killed"
  | "front_not_connected"
  | "inflight_job_present"
  | "error";

export type FrontReconciliationGateState =
  | { open: true }
  | { open: false; reason: FrontReconciliationGateReason; detail?: string };

async function isFrontReconciliationInFlight(): Promise<boolean> {
  // Caller asserts `runWithWorkerDb` context (enqueueWithGate +
  // evaluateFrontReconciliationGates always wrap). `getDb()` therefore
  // resolves to the worker pool.
  return withDbAttribution(
    "ingestion:front-reconciliation-scheduler-inflight-check",
    async () => {
      const res: any = await getDb().execute(sql`
        SELECT 1
        FROM work_queue
        WHERE queue_name = ${FRONT_RECONCILIATION_QUEUE}
          AND status IN ('pending', 'processing', 'leased')
        LIMIT 1
      `);
      const rows = Array.isArray(res) ? res : res?.rows ?? [];
      return rows.length > 0;
    },
  );
}

/**
 * Evaluate every gate. Worker-pool tenant: callers MUST wrap in
 * `runWithWorkerDb`. The scheduler tick + the CEO `status()` both use
 * this so the panel state matches what `apply()` will actually do.
 *
 * `trigger`: `"scheduled"` (the timer tick) honors every gate including
 * `front_reconciliation_scheduler_enabled`. `"manual"` (the CEO panel
 * button) is an operator override — it intentionally SKIPS the
 * scheduler-enable setting so an operator can force a one-off sweep
 * when the periodic cadence is disabled. All other safety gates
 * (PERF env, queue pause, KILL_SWITCH_NON_CRITICAL_SWEEPS, Front
 * token, in-flight pre-check) still apply to manual.
 */
export async function evaluateFrontReconciliationGates(
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<FrontReconciliationGateState> {
  if (!PERF.FRONT_RECONCILIATION_ENABLED) {
    return { open: false, reason: "perf_flag_disabled" };
  }
  try {
    if (trigger === "scheduled") {
      const schedSetting = await storage.getSystemSetting(SCHEDULER_ENABLED_SETTING);
      if (schedSetting?.value === "false") {
        return { open: false, reason: "scheduler_setting_disabled" };
      }
    }
    await ensureQueueDrainStateLoaded();
    if (isQueuePaused(FRONT_RECONCILIATION_QUEUE)) {
      return { open: false, reason: "queue_paused" };
    }
    // Use the canonical kill-switch path so operator toggles via
    // `kill_switch_non_critical_sweeps` (runtime store) AND the env
    // `KILL_SWITCH_NON_CRITICAL_SWEEPS` env both gate this scheduler.
    await ensureKillSwitchesLoaded();
    if (isKillSwitchEnabled("non_critical_sweeps")) {
      return { open: false, reason: "non_critical_sweeps_killed" };
    }
    const token = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
    if (!token?.value) {
      return { open: false, reason: "front_not_connected" };
    }
    if (await isFrontReconciliationInFlight()) {
      return { open: false, reason: "inflight_job_present" };
    }
    return { open: true };
  } catch (err: any) {
    return { open: false, reason: "error", detail: err?.message ?? String(err) };
  }
}

export type FrontReconciliationEnqueueOutcome =
  | { enqueued: true; bucket: number; trigger: "scheduled" | "manual" }
  | { enqueued: false; reason: FrontReconciliationGateReason | "dedupe" | "error"; detail?: string };

async function enqueueWithGate(
  trigger: "scheduled" | "manual",
  bucketMs: number,
): Promise<FrontReconciliationEnqueueOutcome> {
  return runWithWorkerDb(async () => {
    const gate = await evaluateFrontReconciliationGates(trigger);
    if (!gate.open) {
      return { enqueued: false, reason: gate.reason, detail: gate.detail };
    }
    try {
      const bucket = Math.floor(Date.now() / bucketMs);
      await enqueueJob({
        queueName: FRONT_RECONCILIATION_QUEUE,
        workloadClass: "front_ingestion",
        priority: 250,
        payload: { trigger, bucket },
        dedupeKey: `${FRONT_RECONCILIATION_QUEUE}:${trigger}:${bucket}`,
        maxAttempts: 2,
      });
      return { enqueued: true, bucket, trigger };
    } catch (err: any) {
      console.warn(
        `[FrontReconciliationScheduler] enqueue (${trigger}) failed: ${
          err?.message ?? err
        }`,
      );
      return { enqueued: false, reason: "error", detail: err?.message ?? String(err) };
    }
  });
}

export function enqueueScheduledFrontReconciliation(): Promise<FrontReconciliationEnqueueOutcome> {
  return enqueueWithGate("scheduled", resolveIntervalMsSync());
}

export function enqueueManualFrontReconciliation(): Promise<FrontReconciliationEnqueueOutcome> {
  return enqueueWithGate("manual", MANUAL_DEDUPE_BUCKET_MS);
}

let cachedIntervalMs: number = PERF.FRONT_RECONCILIATION_INTERVAL_MS;

function resolveIntervalMsSync(): number {
  return cachedIntervalMs;
}

async function refreshIntervalMs(): Promise<number> {
  try {
    const row = await storage.getSystemSetting(SCHEDULER_INTERVAL_SETTING);
    if (row?.value) {
      const minutes = Number(row.value);
      if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) {
        cachedIntervalMs = Math.floor(minutes * 60_000);
        return cachedIntervalMs;
      }
    }
  } catch {
    // fall through to PERF default
  }
  cachedIntervalMs = PERF.FRONT_RECONCILIATION_INTERVAL_MS;
  return cachedIntervalMs;
}

let tickTimer: NodeJS.Timeout | null = null;
let rescheduleTimer: NodeJS.Timeout | null = null;
let currentTickMs: number | null = null;
let started = false;

async function scheduleNextTick(): Promise<void> {
  await runWithWorkerDb(() => refreshIntervalMs());
  if (tickTimer && currentTickMs === cachedIntervalMs) return;
  if (tickTimer) clearInterval(tickTimer);
  currentTickMs = cachedIntervalMs;
  tickTimer = setInterval(() => {
    void enqueueScheduledFrontReconciliation();
  }, currentTickMs);
  console.log(
    `[FrontReconciliationScheduler] tick interval set to ${
      currentTickMs / 60_000
    } min`,
  );
}

export function startFrontReconciliationScheduler(): void {
  if (started) return;
  if (!PERF.FRONT_RECONCILIATION_ENABLED) {
    console.log(
      "[FrontReconciliationScheduler] disabled via FRONT_RECONCILIATION_ENABLED=false",
    );
    return;
  }
  started = true;
  void scheduleNextTick();
  // Cheap watchdog: every minute re-read the interval setting so an
  // operator change to `front_reconciliation_interval_minutes` takes
  // effect within ~60s without a restart.
  rescheduleTimer = setInterval(() => {
    void scheduleNextTick();
  }, RESCHEDULE_CHECK_MS);
  console.log(
    `[FrontReconciliationScheduler] started (queue=${FRONT_RECONCILIATION_QUEUE}, class=ingestion, priority=250)`,
  );
}

export function stopFrontReconciliationScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (rescheduleTimer) {
    clearInterval(rescheduleTimer);
    rescheduleTimer = null;
  }
  started = false;
  currentTickMs = null;
}

export const __frontReconciliationSchedulerTestHelpers = {
  refreshIntervalMs,
  resolveIntervalMsSync,
  isFrontReconciliationInFlight: async () =>
    runWithWorkerDb(() => isFrontReconciliationInFlight()),
};
