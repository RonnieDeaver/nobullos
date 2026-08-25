// @db-pool-intent: worker
//
// Task #3059 — Service Desk overdue sweep + delivered auto-close scheduler.
//
// Runs on a configurable cadence (default 6h), deployment-gated and
// cross-instance singleton. Each tick enqueues:
//   • sd_overdue_sweep   — walks open tickets with committedDate in the past
//     and fires notifyUser to owner + requester for each overdue ticket.
//   • sd_delivered_autoclose — finds tickets in "delivered" status older than
//     sd_delivered_review_period_days (default 3) and transitions them to "closed".
//
// Default OFF: the kill switch `sd_scheduler_enabled` (system setting) must
// be "true" / "1" / "yes" / "on" to activate.
// Set SD_SCHEDULER_FORCE_ENABLE=1 to bypass both the deployment gate and the
// kill switch locally (tests / manual runs).
//
// Lifecycle mirrors clickUpReconciliationScheduler:
//   1. Deployment-gated — only the deployed app holds production workspace
//      tokens. Set SD_SCHEDULER_FORCE_ENABLE=1 to run locally.
//   2. Cross-instance singleton — each tick acquires a cluster-wide Postgres
//      advisory lock (WORKER_STAGGER_OFFSETS.sd_scheduler) so exactly one
//      autoscale instance fires per tick. The lock self-heals on crash.
//   3. Worker pool — all DB work runs via runWithWorkerDb.

import { runWithWorkerDb, withDbAttribution, getDb } from "../db";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { workQueue } from "@shared/schema";

const SINGLETON_KEY = "sd_scheduler";
const ENABLED_SETTING = "sd_scheduler_enabled";
const INTERVAL_SETTING = "sd_scheduler_interval_ms";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_INTERVAL_MS = 5 * 60 * 1000; // never tighter than 5 min

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

function isForceEnabled(): boolean {
  const v = process.env.SD_SCHEDULER_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function resolveIntervalMs(): Promise<number> {
  try {
    const s = await getSystemSetting(INTERVAL_SETTING);
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
    const s = await getSystemSetting(ENABLED_SETTING);
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
      console.log("[SdScheduler] Kill switch off — skipping tick");
      return;
    }

    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:sd", async () => {
        const db = getDb();
        await db.insert(workQueue).values({
          queueName: "sd_overdue_sweep",
          jobType: "sd_overdue_sweep",
          workloadClass: "reporting",
          priority: 100,
          status: "pending",
          payload: {},
        } as any);
        await db.insert(workQueue).values({
          queueName: "sd_delivered_autoclose",
          jobType: "sd_delivered_autoclose",
          workloadClass: "reporting",
          priority: 100,
          status: "pending",
          payload: {},
        } as any);
        console.log("[SdScheduler] Enqueued sd_overdue_sweep + sd_delivered_autoclose");
      }),
    );
  } catch (err: any) {
    console.warn("[SdScheduler] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startSdScheduler(): Promise<void> {
  if (scheduler) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[SdScheduler] Not in deployment — scheduler disabled " +
        "(set SD_SCHEDULER_FORCE_ENABLE=1 to override).",
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
    `[SdScheduler] Scheduler started (every ${intervalMs / 1000 / 60}min, kill switch: ${ENABLED_SETTING})`,
  );
}

export function stopSdScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
    console.log("[SdScheduler] Scheduler stopped");
  }
}
