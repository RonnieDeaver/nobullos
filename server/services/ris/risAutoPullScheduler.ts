// @db-pool-intent: worker
//
// Task #2368 — scheduled driver for the RIS BigQuery auto-pull.
//
// Default OFF. The scheduler ticks on a fixed interval but each tick is a
// no-op unless the `enable_ris_bigquery_autopull` system setting is "true"
// — so the feature can be switched on (once BigQuery is ready) without a
// redeploy. All work runs on the worker pool via runWithWorkerDb; the
// remote BigQuery calls inside runRisAutoPull sit outside DB holds.

import { getSystemSetting } from "../../storage/settingsStorage";
import { runWithWorkerDb } from "../../db";
import { runRisAutoPull } from "./risAutoPull";
import { runRisPerformancePull } from "./risPerformancePull";
import { withWorkerSingletonLock } from "../crossInstanceLock";

const ENABLE_SETTING = "enable_ris_bigquery_autopull";
const INTERVAL_SETTING = "ris_bigquery_autopull_interval_ms";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Read the default-OFF master switch. Fail-safe: any read error leaves
 *  the feature OFF (no surprise BigQuery spend on a config blip). */
export async function isRisAutoPullEnabled(): Promise<boolean> {
  try {
    const s = await getSystemSetting(ENABLE_SETTING);
    return s?.value === "true";
  } catch {
    return false;
  }
}

async function resolveIntervalMs(): Promise<number> {
  try {
    const s = await getSystemSetting(INTERVAL_SETTING);
    const n = s?.value ? parseInt(s.value, 10) : NaN;
    if (Number.isFinite(n) && n >= 60_000) return n;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_INTERVAL_MS;
}

async function tick(): Promise<void> {
  if (running) return; // never overlap with a previous slow run
  if (!(await isRisAutoPullEnabled())) return;
  running = true;
  try {
    const summary = await runWithWorkerDb(() => runRisAutoPull());
    console.log(
      `[ris:autopull] scheduled QA pull ${summary.period}: ${summary.written} written, ${summary.needsReview} needs-review, ${summary.skipped} skipped (BigQuery ${summary.bigQueryConfigured ? "configured" : "not configured"})`,
    );
    // Task #2371 — drive the Performance layer on the same tick/gate.
    const perf = await runWithWorkerDb(() => runRisPerformancePull());
    console.log(
      `[ris:autopull] scheduled Performance pull ${perf.period}: ${perf.written} written, ${perf.gray} gray, ${perf.skipped} skipped (BigQuery ${perf.bigQueryConfigured ? "configured" : "not configured"})`,
    );
  } catch (err: any) {
    console.warn("[ris:autopull] scheduled pull failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startRisAutoPullScheduler(): Promise<void> {
  if (scheduler) return;
  const intervalMs = await resolveIntervalMs();
  // Kick a first tick shortly after boot (the bootstrap caller already
  // staggers worker startup), then on the resolved interval. Wrap each tick
  // in the cross-instance singleton lock so only one autoscale instance runs
  // the BigQuery pull per tick (duplicate remote pulls cost money and could
  // race the suggested-status writes); the lock self-heals on crash.
  void withWorkerSingletonLock("ris_bigquery_autopull", () => tick());
  scheduler = setInterval(
    () => void withWorkerSingletonLock("ris_bigquery_autopull", () => tick()),
    intervalMs,
  );
}

export function stopRisAutoPullScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}
