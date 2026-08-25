// @db-pool-intent: worker
//
// Task #4329 — tags & segments reconciliation sweep scheduler.
//
// Each tick enqueues ONE `tag_segment_reconcile` work-queue job (workload
// class "maintenance") that re-evaluates every rule tag and every segment
// against live records — the healing pass behind the on-write evaluation
// in tagSegmentEngine.ts (import-time hooks, offboarding archives, bulk
// scripts and criteria edits all drift without it).
//
// Default OFF: the kill switch `tags_segments_sweep_enabled` (system
// setting) must be "true" / "1" / "yes" / "on" to activate. Cadence via
// `tags_segments_sweep_interval_ms` (default 15 min, floor 5 min; the
// kill switch is re-read every tick so a flip takes effect within one
// interval — settings-cache staleness ≤300 s is immaterial at this
// cadence). Set TAG_SEGMENT_SWEEP_FORCE_ENABLE=1 to bypass both the
// deployment gate and the kill switch locally (tests / manual runs).
//
// Lifecycle mirrors clickUpReconciliationScheduler:
//   1. Deployment-gated — dev instances don't run background sweeps.
//   2. Cross-instance singleton — each tick acquires a cluster-wide
//      Postgres advisory lock so exactly one autoscale instance fires.
//   3. Worker pool — all DB work runs via runWithWorkerDb.
//   4. Stable dedupeKey — at most one sweep pending/processing at a time
//      (shared with the manual trigger route).

import { runWithWorkerDb } from "../db";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { registerModuleStateResetForTest } from "./moduleStateReset";
import { enqueueJob } from "./workScheduler";
import { TAG_SEGMENT_RECONCILE_QUEUE } from "./tagSegmentEngine";

const SINGLETON_KEY = "tag_segment_reconcile";
export const TAG_SEGMENT_SWEEP_ENABLED_SETTING = "tags_segments_sweep_enabled";
export const TAG_SEGMENT_SWEEP_INTERVAL_SETTING = "tags_segments_sweep_interval_ms";
/** Stable while pending — the work_queue partial unique index on
 * dedupe_key collapses scheduler ticks AND manual triggers into one
 * outstanding sweep. */
export const TAG_SEGMENT_SWEEP_DEDUPE_KEY = "tag_segment_reconcile:sweep";
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_INTERVAL_MS = 5 * 60 * 1000; // never tighter than 5 min

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Local escape hatch so the sweep can run in the workspace / tests without
 * a deploy (mirrors CLICKUP_RECONCILIATION_SWEEP_FORCE_ENABLE).
 */
function isForceEnabled(): boolean {
  const v = process.env.TAG_SEGMENT_SWEEP_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function resolveIntervalMs(): Promise<number> {
  try {
    const s = await getSystemSetting(TAG_SEGMENT_SWEEP_INTERVAL_SETTING);
    const n = s?.value ? parseInt(s.value, 10) : NaN;
    if (Number.isFinite(n) && n >= MIN_INTERVAL_MS) return n;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_INTERVAL_MS;
}

async function isEnabled(): Promise<boolean> {
  if (isForceEnabled()) return true;
  try {
    const s = await getSystemSetting(TAG_SEGMENT_SWEEP_ENABLED_SETTING);
    const v = s?.value ?? "false";
    return v === "true" || v === "1" || v === "yes" || v === "on";
  } catch {
    return false; // default OFF
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const enabled = await isEnabled();
    if (!enabled) {
      console.log("[TagSegmentSweep] Kill switch off — skipping tick");
      return;
    }
    await runWithWorkerDb(() =>
      enqueueJob({
        queueName: TAG_SEGMENT_RECONCILE_QUEUE,
        workloadClass: "maintenance",
        priority: 100,
        payload: { trigger: "scheduler" },
        dedupeKey: TAG_SEGMENT_SWEEP_DEDUPE_KEY,
      }),
    );
  } catch (err: any) {
    console.warn("[TagSegmentSweep] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startTagSegmentScheduler(): Promise<void> {
  if (scheduler) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[TagSegmentSweep] Not in deployment — scheduler disabled " +
        "(set TAG_SEGMENT_SWEEP_FORCE_ENABLE=1 to override).",
    );
    return;
  }
  const intervalMs = await resolveIntervalMs();
  void withWorkerSingletonLock(SINGLETON_KEY, () => tick());
  scheduler = setInterval(
    () => void withWorkerSingletonLock(SINGLETON_KEY, () => tick()),
    intervalMs,
  );
  console.log(
    `[TagSegmentSweep] Scheduler started (every ${intervalMs / 1000 / 60}min, kill switch: ${TAG_SEGMENT_SWEEP_ENABLED_SETTING})`,
  );
}

export function stopTagSegmentScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
    console.log("[TagSegmentSweep] Scheduler stopped");
  }
}

// Between-suite hygiene: the batched test runner sweeps registered resets
// before each suite so a suite that (indirectly) started the scheduler
// can't leak its interval/flag into the next one.
registerModuleStateResetForTest("tagSegmentScheduler", () => {
  stopTagSegmentScheduler();
  running = false;
});
