// @db-pool-intent: worker
//
// Task #2686 — Hourly Live Data scheduler.
//
// Default OFF. Mirrors the RIS auto-pull scheduler pattern:
//   • Gated by the `enable_live_data_autopull` system setting (fail-safe: OFF on error).
//   • Cross-instance singleton via withWorkerSingletonLock so only ONE autoscale
//     instance runs the pull per tick (duplicate BQ pulls cost money).
//   • All BigQuery network calls happen inside runLiveDataPull which keeps them
//     outside any DB hold.

import { getSystemSetting } from "../../storage/settingsStorage";
import { runWithWorkerDb } from "../../db";
import { runLiveDataPull, liveDataPreviousPeriod } from "./liveDataPull";
import { listActiveClientIdsMissingFinalSnapshot } from "../../storage/liveDataStorage";
import { withWorkerSingletonLock } from "../crossInstanceLock";

const ENABLE_SETTING = "enable_live_data_autopull";
const INTERVAL_SETTING = "live_data_autopull_interval_ms";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Read the default-OFF master switch. Any read error leaves the feature OFF. */
export async function isLiveDataAutoPullEnabled(): Promise<boolean> {
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
    /* fall through */
  }
  return DEFAULT_INTERVAL_MS;
}

async function tick(): Promise<void> {
  if (running) return;
  if (!(await isLiveDataAutoPullEnabled())) return;
  running = true;
  try {
    const summary = await runWithWorkerDb(() => runLiveDataPull());
    console.log(
      `[liveData:scheduler] pull ${summary.period}: ${summary.snapshotsWritten} snapshots written, ${summary.clientsProcessed} clients (BigQuery ${summary.bigQueryConfigured ? "configured" : "not configured"})`,
    );

    // Task #4766 — completed-month close-out: once the calendar rolls
    // over, the just-closed period needs ONE final (post-close) snapshot
    // per active client so the tier gate's measured-stability fallback has
    // a trustworthy total (a mid-month partial can never read as a
    // collapse). Pull only clients still missing that final snapshot, so
    // after one successful pass this is a no-op until the next month
    // closes. Runs under the same default-OFF switch and singleton lock.
    const prevPeriod = liveDataPreviousPeriod();
    const missing = await runWithWorkerDb(() =>
      listActiveClientIdsMissingFinalSnapshot(prevPeriod),
    );
    if (missing.length > 0) {
      const closeout = await runWithWorkerDb(() =>
        runLiveDataPull({ period: prevPeriod, clientIds: missing }),
      );
      console.log(
        `[liveData:scheduler] close-out ${prevPeriod}: ${closeout.snapshotsWritten} final snapshots written for ${missing.length} client(s) missing one`,
      );
    }
  } catch (err: any) {
    console.warn("[liveData:scheduler] pull failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startLiveDataScheduler(): Promise<void> {
  if (scheduler) return;
  const intervalMs = await resolveIntervalMs();
  void withWorkerSingletonLock("live_data_autopull", () => tick());
  scheduler = setInterval(
    () => void withWorkerSingletonLock("live_data_autopull", () => tick()),
    intervalMs,
  );
}

export function stopLiveDataScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}
