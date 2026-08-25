import cron from "node-cron";
import { withDbAttribution, runWithWorkerDb } from "../db";
import { acquireWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { workerLog } from "./workerLogger";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { runAppBackup } from "./appBackup";
import { storage } from "../storage";

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let backupRunning = false;

// Test-only seam: lets a test inject a fake cron whose task's async `stop()`
// REJECTS, proving the lifecycle paths handle stop() rejections (node-cron v4
// made stop() async; a background teardown timeout must be logged, not become
// an unhandled rejection). Production always uses the real `cron`.
let cronImpl: Pick<typeof cron, "schedule"> = cron;
export function __test_setCron(impl: Pick<typeof cron, "schedule"> | null): void {
  cronImpl = impl ?? cron;
}

// Task #2657 — cross-instance singleton key for the daily app-backup cron.
const SINGLETON_KEY = "scheduler:app-backup";

// Any run still `in_progress` longer than this lost its holder (crash/recycle)
// and must be swept to `failed` so the admin page never shows a stuck run.
const STALE_RUN_MS = CROSS_INSTANCE_LOCK_MAX_HOLD_MS.app_backup + 30 * 60_000;

/**
 * Start the daily backup cron (default 04:00 America/New_York). The cron
 * fires on every autoscale instance, so the body:
 *   1. is gated to the deployment (`REPLIT_DEPLOYMENT==="1"`) — the dump
 *      targets prod, and the dev workspace can only read prod, so a workspace
 *      run would not produce a real production backup;
 *   2. takes a cluster-wide Postgres advisory lock so exactly ONE instance
 *      runs the backup (self-heals: the lock releases when the holder
 *      crashes), with a `maxHoldMs` watchdog so a hung run can't hold it
 *      forever.
 *
 * Callers wrap the body in `runWithWorkerDb` so all bookkeeping goes to the
 * worker pool.
 */
export function startAppBackupScheduler(cronExpression = "0 4 * * *"): void {
  if (scheduledTask) {
    // fire-and-forget: node-cron v4 stop() is async; nothing awaits scheduler
    // teardown, but a rejection (e.g. teardown timeout) must be logged, not dropped.
    void Promise.resolve(scheduledTask.stop()).catch((err: unknown) => {
      console.error("[AppBackupScheduler] cron task stop() failed:", err);
    });
  }

  if (!isRunningInDeployment()) {
    console.log(
      "[AppBackupScheduler] Not running in deployment — daily backup scheduler disabled (workspace can only read prod).",
    );
    return;
  }

  scheduledTask = cronImpl.schedule(
    cronExpression,
    () => {
      if (backupRunning) {
        console.log("[AppBackupScheduler] Previous run still in progress, skipping");
        return;
      }
      backupRunning = true;
      console.log("[AppBackupScheduler] Cron triggered at", new Date().toISOString());
      void runWithWorkerDb(() =>
        withDbAttribution("scheduler:app-backup", async () => {
          let lock: { release: () => Promise<void> } | null = null;
          try {
            lock = await acquireWorkerSingletonLock(SINGLETON_KEY, "[AppBackupScheduler]", {
              maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.app_backup,
              onWatchdog: (info) =>
                workerLog({
                  worker: "app_backup",
                  event: "worker_lock_watchdog_fired",
                  lockAge: info.heldMs,
                  maxHoldMs: info.maxHoldMs,
                }),
            });
            if (!lock) {
              console.log("[AppBackupScheduler] Another instance is running this pass, skipping");
              return;
            }
            // Recover any run a prior crashed instance left spinning.
            const recovered = await storage.failStaleInProgressBackupRuns(STALE_RUN_MS);
            if (recovered > 0) {
              console.log(`[AppBackupScheduler] Recovered ${recovered} stale in-progress run(s)`);
            }
            const result = await runAppBackup({ kind: "scheduled", triggeredBy: null });
            console.log(`[AppBackupScheduler] Completed: status=${result.status} runId=${result.runId}`);
          } catch (err: any) {
            console.error("[AppBackupScheduler] Cron job failed:", err?.message ?? err);
          } finally {
            if (lock) await lock.release();
            backupRunning = false;
          }
        }),
      );
    },
    { timezone: "America/New_York" },
  );

  console.log(
    `[AppBackupScheduler] Scheduled daily app backup with cron: ${cronExpression} (America/New_York)`,
  );
}

export function stopAppBackupScheduler(): void {
  if (scheduledTask) {
    // fire-and-forget: node-cron v4 stop() is async; nothing awaits scheduler
    // teardown, but a rejection (e.g. teardown timeout) must be logged, not dropped.
    void Promise.resolve(scheduledTask.stop()).catch((err: unknown) => {
      console.error("[AppBackupScheduler] cron task stop() failed:", err);
    });
    scheduledTask = null;
    console.log("[AppBackupScheduler] Stopped");
  }
}
