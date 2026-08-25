// @db-pool-intent: worker
//
// Task #4333 — nightly deal/lead score recompute scheduler.
//
// Each tick enqueues ONE `score_recompute` work-queue job (workload class
// "maintenance") that re-scores every scorable entity — the healing pass
// behind the on-write bumps in scoringEngine.ts. The sweep is what keeps
// ENGAGEMENT scores honest: activity-window rules ("inbound email in the
// last 14 days") decay purely with the passage of time, with no write
// anywhere to hook a bump onto.
//
// Default ON — a deliberate divergence from the tags/segments sweep
// (default OFF). Rationale (Impact Review §8): without the sweep, every
// engagement score silently rots within days of the window edge; the
// operator-visible computed-at timestamp would claim freshness the data
// no longer has. Kill switch `scoring_sweep_enabled` (system setting) —
// set to "false" / "0" / "no" / "off" to pause. Cadence via
// `scoring_sweep_interval_ms` (default 24 h, floor 5 min; both settings
// re-read every tick, so a flip takes effect within one interval —
// settings-cache staleness ≤300 s is immaterial at this cadence). Set
// SCORING_SWEEP_FORCE_ENABLE=1 to bypass both the deployment gate and the
// kill switch locally (tests / manual runs).
//
// Lifecycle mirrors tagSegmentScheduler:
//   1. Deployment-gated — dev instances don't run background sweeps.
//   2. Cross-instance singleton — each tick acquires a cluster-wide
//      Postgres advisory lock so exactly one autoscale instance fires.
//   3. Worker pool — all DB work runs via runWithWorkerDb.
//   4. Stable dedupeKey — at most one sweep pending/processing at a time.
//      (The manual recompute route runs synchronously, not through the
//      queue, so this key belongs to the scheduler alone.)

import { runWithWorkerDb } from "../db";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { registerModuleStateResetForTest } from "./moduleStateReset";
import { enqueueJob } from "./workScheduler";
import { SCORE_RECOMPUTE_QUEUE } from "./scoringEngine";

const SINGLETON_KEY = "score_recompute";
export const SCORING_SWEEP_ENABLED_SETTING = "scoring_sweep_enabled";
export const SCORING_SWEEP_INTERVAL_SETTING = "scoring_sweep_interval_ms";
/** Stable while pending — the work_queue partial unique index on
 * dedupe_key collapses overlapping scheduler ticks into one outstanding
 * sweep. (The manual recompute route runs synchronously, not via the
 * queue.) */
export const SCORING_SWEEP_DEDUPE_KEY = "score_recompute:sweep";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly
const MIN_INTERVAL_MS = 5 * 60 * 1000; // never tighter than 5 min

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Local escape hatch so the sweep can run in the workspace / tests without
 * a deploy (mirrors TAG_SEGMENT_SWEEP_FORCE_ENABLE).
 */
function isForceEnabled(): boolean {
  const v = process.env.SCORING_SWEEP_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function resolveIntervalMs(): Promise<number> {
  try {
    const s = await getSystemSetting(SCORING_SWEEP_INTERVAL_SETTING);
    const n = s?.value ? parseInt(s.value, 10) : NaN;
    if (Number.isFinite(n) && n >= MIN_INTERVAL_MS) return n;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_INTERVAL_MS;
}

/** Default ON (see file header) — only an explicit falsy value pauses. */
async function isEnabled(): Promise<boolean> {
  if (isForceEnabled()) return true;
  try {
    const s = await getSystemSetting(SCORING_SWEEP_ENABLED_SETTING);
    const v = (s?.value ?? "true").toLowerCase();
    return !(v === "false" || v === "0" || v === "no" || v === "off");
  } catch {
    return true; // default ON — a settings-read hiccup must not stall decay healing
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const enabled = await isEnabled();
    if (!enabled) {
      console.log("[ScoringSweep] Kill switch off — skipping tick");
      return;
    }
    await runWithWorkerDb(() =>
      enqueueJob({
        queueName: SCORE_RECOMPUTE_QUEUE,
        workloadClass: "maintenance",
        priority: 100,
        payload: { trigger: "scheduler" },
        dedupeKey: SCORING_SWEEP_DEDUPE_KEY,
      }),
    );
  } catch (err: any) {
    console.warn("[ScoringSweep] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startScoringScheduler(): Promise<void> {
  if (scheduler) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[ScoringSweep] Not in deployment — scheduler disabled " +
        "(set SCORING_SWEEP_FORCE_ENABLE=1 to override).",
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
    `[ScoringSweep] Scheduler started (every ${intervalMs / 1000 / 60}min, kill switch: ${SCORING_SWEEP_ENABLED_SETTING})`,
  );
}

export function stopScoringScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
    console.log("[ScoringSweep] Scheduler stopped");
  }
}

// Between-suite hygiene: the batched test runner sweeps registered resets
// before each suite so a suite that (indirectly) started the scheduler
// can't leak its interval/flag into the next one.
registerModuleStateResetForTest("scoringScheduler", () => {
  stopScoringScheduler();
  running = false;
});
