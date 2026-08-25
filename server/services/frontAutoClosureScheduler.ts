// @db-pool-intent: worker
// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Front auto-closure tick scheduler.
 *
 * Periodically enqueues a `front_auto_closure_tick` job so the self-heal
 * loop (`runFrontAutoClosureTick` in `frontAutoClosure.ts`) actually runs
 * on its own cadence. Prior to this scheduler the tick was only invoked
 * as a side-effect of the `front_analytics_coverage_refresh` handler,
 * which the Task #1787 cadence rewrite de-cadenced to a finalized-aware
 * due-check. In practice that meant the warp self-heal knobs (recovery
 * budget, cooldown, retry budget, concurrency cap) had nothing reading
 * them in production — confirmed by `front_auto_closure_tick` having
 * zero rows ever in the work queue.
 *
 * Two enqueue surfaces, both via `enqueueWithGate` running inside a
 * single `runWithWorkerDb` scope:
 *   - `enqueueScheduledFrontAutoClosureTick()` — the timer tick.
 *   - `enqueueManualFrontAutoClosureTick()` — the CEO action.
 *
 * Duplicate-prevention:
 *   1. Per-bucket dedupe key on `enqueueJob` (scheduler vs manual
 *      buckets are independent so a manual press inside the same
 *      scheduler interval still goes through).
 *   2. DB pre-check: if ANY `front_auto_closure_tick` row is in
 *      `pending` / `processing` / `leased`, BOTH paths no-op.
 *
 * Runtime controls (read fresh on every tick / press):
 *   - `system_settings.front_auto_closure_scheduler_enabled` (default
 *     ON; set to `"false"` to disable without a restart).
 *   - `system_settings.front_auto_closure_tick_interval_seconds`
 *     (default falls back to PERF; valid 10..3600).
 *   - `queue_drain_state` pause for `front_auto_closure_tick`.
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

export const FRONT_AUTO_CLOSURE_TICK_QUEUE = "front_auto_closure_tick";
const SETTINGS_KEY_ACCESS = "front_access_token";
export const SCHEDULER_ENABLED_SETTING = "front_auto_closure_scheduler_enabled";
export const SCHEDULER_INTERVAL_SETTING = "front_auto_closure_tick_interval_seconds";
export const MANUAL_DEDUPE_BUCKET_MS = 30_000;
const RESCHEDULE_CHECK_MS = 60_000;

export type FrontAutoClosureGateReason =
  | "perf_flag_disabled"
  | "scheduler_setting_disabled"
  | "queue_paused"
  | "non_critical_sweeps_killed"
  | "front_not_connected"
  | "inflight_job_present"
  | "error";

export type FrontAutoClosureGateState =
  | { open: true }
  | { open: false; reason: FrontAutoClosureGateReason; detail?: string };

async function isAutoClosureTickInFlight(): Promise<boolean> {
  return withDbAttribution(
    "maintenance:front-auto-closure-scheduler-inflight-check",
    async () => {
      const res: any = await getDb().execute(sql`
        SELECT 1
        FROM work_queue
        WHERE queue_name = ${FRONT_AUTO_CLOSURE_TICK_QUEUE}
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
 * `runWithWorkerDb`. `trigger="manual"` skips the scheduler-enable
 * setting so an operator can force a one-off tick even when the
 * periodic cadence is off; every other safety gate still applies.
 */
export async function evaluateFrontAutoClosureGates(
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<FrontAutoClosureGateState> {
  if (!PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED) {
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
    if (isQueuePaused(FRONT_AUTO_CLOSURE_TICK_QUEUE)) {
      return { open: false, reason: "queue_paused" };
    }
    await ensureKillSwitchesLoaded();
    if (isKillSwitchEnabled("non_critical_sweeps")) {
      return { open: false, reason: "non_critical_sweeps_killed" };
    }
    const token = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
    if (!token?.value) {
      return { open: false, reason: "front_not_connected" };
    }
    if (await isAutoClosureTickInFlight()) {
      return { open: false, reason: "inflight_job_present" };
    }
    return { open: true };
  } catch (err: any) {
    return { open: false, reason: "error", detail: err?.message ?? String(err) };
  }
}

export type FrontAutoClosureEnqueueOutcome =
  | { enqueued: true; bucket: number; trigger: "scheduled" | "manual" }
  | { enqueued: false; reason: FrontAutoClosureGateReason | "dedupe" | "error"; detail?: string };

async function enqueueWithGate(
  trigger: "scheduled" | "manual",
  bucketMs: number,
): Promise<FrontAutoClosureEnqueueOutcome> {
  return runWithWorkerDb(async () => {
    const gate = await evaluateFrontAutoClosureGates(trigger);
    if (!gate.open) {
      return { enqueued: false, reason: gate.reason, detail: gate.detail };
    }
    try {
      const bucket = Math.floor(Date.now() / bucketMs);
      await enqueueJob({
        queueName: FRONT_AUTO_CLOSURE_TICK_QUEUE,
        workloadClass: "maintenance",
        // Priority 200 keeps the tick ahead of typical maintenance
        // backlog (semrush_background_refresh) so a
        // long-running maintenance backlog cannot starve the self-heal
        // loop and re-introduce the "knobs not being read on cadence"
        // failure mode. Stays behind live Front webhook normalize/apply
        // (priority 50–100) which run on a different workload class
        // anyway.
        priority: 200,
        payload: { trigger, bucket },
        dedupeKey: `${FRONT_AUTO_CLOSURE_TICK_QUEUE}:${trigger}:${bucket}`,
        maxAttempts: 2,
      });
      return { enqueued: true, bucket, trigger };
    } catch (err: any) {
      console.warn(
        `[FrontAutoClosureScheduler] enqueue (${trigger}) failed: ${
          err?.message ?? err
        }`,
      );
      return { enqueued: false, reason: "error", detail: err?.message ?? String(err) };
    }
  });
}

export function enqueueScheduledFrontAutoClosureTick(): Promise<FrontAutoClosureEnqueueOutcome> {
  return enqueueWithGate("scheduled", resolveIntervalMsSync());
}

export function enqueueManualFrontAutoClosureTick(): Promise<FrontAutoClosureEnqueueOutcome> {
  return enqueueWithGate("manual", MANUAL_DEDUPE_BUCKET_MS);
}

let cachedIntervalMs: number = PERF.FRONT_AUTO_CLOSURE_TICK_INTERVAL_MS;

function resolveIntervalMsSync(): number {
  return cachedIntervalMs;
}

async function refreshIntervalMs(): Promise<number> {
  try {
    const row = await storage.getSystemSetting(SCHEDULER_INTERVAL_SETTING);
    if (row?.value) {
      const seconds = Number(row.value);
      if (Number.isFinite(seconds) && seconds >= 10 && seconds <= 3600) {
        cachedIntervalMs = Math.floor(seconds * 1000);
        return cachedIntervalMs;
      }
    }
  } catch {
    // fall through to PERF default
  }
  cachedIntervalMs = PERF.FRONT_AUTO_CLOSURE_TICK_INTERVAL_MS;
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
    void enqueueScheduledFrontAutoClosureTick();
  }, currentTickMs);
  console.log(
    `[FrontAutoClosureScheduler] tick interval set to ${
      currentTickMs / 1000
    }s`,
  );
}

export function startFrontAutoClosureScheduler(): void {
  if (started) return;
  if (!PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED) {
    console.log(
      "[FrontAutoClosureScheduler] disabled via FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED=false",
    );
    return;
  }
  started = true;
  void scheduleNextTick();
  rescheduleTimer = setInterval(() => {
    void scheduleNextTick();
  }, RESCHEDULE_CHECK_MS);
  console.log(
    `[FrontAutoClosureScheduler] started (queue=${FRONT_AUTO_CLOSURE_TICK_QUEUE}, class=maintenance, priority=400)`,
  );
}

export function stopFrontAutoClosureScheduler(): void {
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

export const __frontAutoClosureSchedulerTestHelpers = {
  refreshIntervalMs,
  resolveIntervalMsSync,
  isAutoClosureTickInFlight: async () =>
    runWithWorkerDb(() => isAutoClosureTickInFlight()),
  // Drive the live re-cadence path directly (Task #2574). scheduleNextTick
  // already wraps its setting read in runWithWorkerDb, so callers need not.
  scheduleNextTick,
  // Inspect the module's timer state without waiting on real wall-clock
  // delays: the resolved cadence the active timer is running at, and the
  // timer handle itself so a test can assert identity (churn vs no-op).
  getCurrentTickMs: () => currentTickMs,
  getTickTimer: () => tickTimer,
  // Start/stop lifecycle inspection (Task #2586): the 60s reschedule-check
  // timer handle and the re-entrancy `started` flag, so a test can assert
  // start arms BOTH timers, a double-start is a no-op, and stop tears both
  // down + resets state — all without real wall-clock waits.
  getRescheduleTimer: () => rescheduleTimer,
  getStarted: () => started,
  RESCHEDULE_CHECK_MS,
};
