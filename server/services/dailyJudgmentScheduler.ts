import cron from "node-cron";
import { runDailyJudgmentCron } from "./dailyJudgment";
import { runGoingQuietSweep } from "./goingQuiet";
import { withDbAttribution } from "../db";
import { acquireWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { workerLog } from "./workerLogger";

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let judgmentRunning = false;

// Task #2363 — cross-instance singleton key for the daily-judgment cron.
const SINGLETON_KEY = "scheduler:daily-judgment";

export function startDailyJudgmentScheduler(cronExpression = "0 6 * * *"): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }

  scheduledTask = cron.schedule(cronExpression, () => {
    if (judgmentRunning) {
      console.log("[DailyJudgmentScheduler] Previous run still in progress, skipping");
      return;
    }
    judgmentRunning = true;
    console.log("[DailyJudgmentScheduler] Cron triggered at", new Date().toISOString());
    void withDbAttribution("scheduler:daily-judgment", async () => {
      // Task #2363 — on `autoscale` this cron fires on every instance.
      // The advisory lock makes exactly one instance run the judgment pass
      // so we don't double-process clients or double-write health rows.
      let lock: { release: () => Promise<void> } | null = null;
      try {
        lock = await acquireWorkerSingletonLock(SINGLETON_KEY, "[DailyJudgmentScheduler]", {
          // Task #2383 — bound the cluster-wide hold so a hung run can't
          // keep the lock forever (self-heals only on crash, not on a hang).
          maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.daily_judgment,
          onWatchdog: (info) =>
            workerLog({
              worker: "daily_judgment",
              event: "worker_lock_watchdog_fired",
              lockAge: info.heldMs,
              maxHoldMs: info.maxHoldMs,
            }),
        });
        if (!lock) {
          console.log("[DailyJudgmentScheduler] Another instance is running this pass, skipping");
          return;
        }
        // Task #3695 — the judgment pass and the going-quiet sweep each get
        // their own try/catch: a judgment failure must not skip the sweep
        // (and vice versa). Both run under the same singleton lock.
        try {
          const result = await runDailyJudgmentCron();
          console.log(`[DailyJudgmentScheduler] Completed: ${result.processed} generated, ${result.carriedForward} carried forward, ${result.skipped} skipped (no usable data), ${result.errors} errors`);
        } catch (err: any) {
          console.error("[DailyJudgmentScheduler] Judgment pass failed:", err.message);
        }
        try {
          const sweep = await runGoingQuietSweep();
          console.log(
            `[DailyJudgmentScheduler] Going-quiet sweep (${sweep.snapshotDate}): ${sweep.processed} processed, ${sweep.flagged} flagged (${sweep.newlyFlagged} new), ${sweep.reengaged} re-engaged, ${sweep.insufficient} insufficient history, ${sweep.errors} errors`,
          );
        } catch (err: any) {
          console.error("[DailyJudgmentScheduler] Going-quiet sweep failed:", err.message);
        }
      } catch (err: any) {
        console.error("[DailyJudgmentScheduler] Cron job failed:", err.message);
      } finally {
        if (lock) await lock.release();
        judgmentRunning = false;
      }
    });
  }, {
    timezone: "America/New_York",
  });

  console.log(`[DailyJudgmentScheduler] Scheduled daily judgments with cron: ${cronExpression} (America/New_York)`);
}

export function stopDailyJudgmentScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[DailyJudgmentScheduler] Stopped");
  }
}
