/**
 * Task #3711 — daily client-offboarding scheduler.
 *
 * Runs the offboarding sweep (clientOffboardingSweep.ts) every morning at
 * 06:30 America/New_York — same daily-driver convention as the daily
 * judgment scheduler (06:00), staggered so the two never wake on the same
 * tick. Deployment-gated with a force-enable escape hatch, cross-instance
 * singleton (advisory lock, self-heals on crash, watchdogged on hangs).
 *
 * Kill switch: `client_offboarding_sweep_disabled` (system setting).
 * DELIBERATELY inverted from the `*_enabled` default-OFF settings the
 * maintenance schedulers use: this sweep executes explicit operator intent
 * (a scheduled offboarding placed through the UI), so it must work in
 * production without anyone flipping a hidden enable flag — otherwise every
 * scheduled offboard would silently never fire. The switch exists to stop
 * the sweep during an incident.
 *
 * Boot catch-up: on scheduler start (deployment only) a one-shot tick runs
 * ~45s later. Combined with the sweep's `final_service_date <= today`
 * predicate, an app that was down at 06:30 still archives everything due
 * as soon as it comes back up, instead of waiting for the next morning.
 */
import cron from "node-cron";
import { withDbAttribution } from "../db";
import { acquireWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { workerLog } from "./workerLogger";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { runClientOffboardingSweep } from "./clientOffboardingSweep";

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let bootCatchupTimer: NodeJS.Timeout | null = null;
let sweepRunning = false;

const SINGLETON_KEY = "scheduler:client-offboarding";
export const OFFBOARDING_SWEEP_KILL_SETTING = "client_offboarding_sweep_disabled";

function isForceEnabled(): boolean {
  const v = process.env.CLIENT_OFFBOARDING_SWEEP_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function isKilled(): Promise<boolean> {
  try {
    const s = await getSystemSetting(OFFBOARDING_SWEEP_KILL_SETTING);
    const v = s?.value ?? "false";
    return v === "true" || v === "1" || v === "yes" || v === "on";
  } catch {
    // Kill switch semantics: an unreadable setting must not stop the sweep.
    return false;
  }
}

async function tick(trigger: string): Promise<void> {
  if (sweepRunning) {
    console.log("[ClientOffboardingScheduler] Previous sweep still in progress, skipping");
    return;
  }
  sweepRunning = true;
  try {
    await withDbAttribution("scheduler:client-offboarding", async () => {
      if (await isKilled()) {
        console.log(
          `[ClientOffboardingScheduler] Kill switch ${OFFBOARDING_SWEEP_KILL_SETTING} is on — skipping ${trigger} sweep`,
        );
        return;
      }
      let lock: { release: () => Promise<void> } | null = null;
      try {
        lock = await acquireWorkerSingletonLock(SINGLETON_KEY, "[ClientOffboardingScheduler]", {
          maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.client_offboarding_sweep,
          onWatchdog: (info) =>
            workerLog({
              worker: "client_offboarding_sweep",
              event: "worker_lock_watchdog_fired",
              lockAge: info.heldMs,
              maxHoldMs: info.maxHoldMs,
            }),
        });
        if (!lock) {
          console.log("[ClientOffboardingScheduler] Another instance is running this sweep, skipping");
          return;
        }
        const result = await runClientOffboardingSweep();
        if (result.due > 0 || result.errors > 0) {
          console.log(
            `[ClientOffboardingScheduler] Sweep (${trigger}) done: ${result.due} due, ` +
              `${result.completed} completed, ${result.skipped} skipped, ${result.errors} errors`,
          );
        }
      } catch (err: any) {
        console.error("[ClientOffboardingScheduler] Sweep failed:", err?.message ?? err);
      } finally {
        if (lock) await lock.release();
      }
    });
  } finally {
    sweepRunning = false;
  }
}

export function startClientOffboardingScheduler(cronExpression = "30 6 * * *"): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
  }
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[ClientOffboardingScheduler] Not in deployment — scheduler disabled " +
        "(set CLIENT_OFFBOARDING_SWEEP_FORCE_ENABLE=1 to override).",
    );
    return;
  }

  scheduledTask = cron.schedule(
    cronExpression,
    () => {
      console.log("[ClientOffboardingScheduler] Cron triggered at", new Date().toISOString());
      void tick("cron");
    },
    { timezone: "America/New_York" },
  );

  bootCatchupTimer = setTimeout(() => void tick("boot-catchup"), 45_000);
  bootCatchupTimer.unref?.();

  console.log(
    `[ClientOffboardingScheduler] Scheduled daily offboarding sweep with cron: ${cronExpression} ` +
      `(America/New_York; kill switch: ${OFFBOARDING_SWEEP_KILL_SETTING})`,
  );
}

export function stopClientOffboardingScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
  }
  if (bootCatchupTimer) {
    clearTimeout(bootCatchupTimer);
    bootCatchupTimer = null;
  }
  console.log("[ClientOffboardingScheduler] Stopped");
}
