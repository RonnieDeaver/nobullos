// @db-pool-intent: worker
//
// Task #2984 — ClickUp reconciliation sweep + webhook health scheduler.
//
// Runs on a configurable cadence (default 4h), deployment-gated and
// cross-instance singleton. Each tick enqueues:
//   • clickup_reconciliation_sweep — walks connected workspaces, checks
//     mirror drift, enqueues clickup_hierarchy_backfill for stale ones.
//   • clickup_webhook_health_check — polls live ClickUp webhook health,
//     updates stored health, and enqueues clickup_webhook_repair for
//     degraded ones.
//
// Default OFF: the kill switch `clickup_reconciliation_sweep_enabled`
// (system setting) must be "true" / "1" / "yes" / "on" to activate.
// Set CLICKUP_RECONCILIATION_SWEEP_FORCE_ENABLE=1 to bypass both the
// deployment gate and the kill switch locally (tests / manual runs).
//
// Lifecycle mirrors zoomTokenKeepAliveScheduler:
//   1. Deployment-gated — only the deployed app holds production workspace
//      tokens. Set CLICKUP_RECONCILIATION_SWEEP_FORCE_ENABLE=1 to run
//      locally.
//   2. Cross-instance singleton — each tick acquires a cluster-wide Postgres
//      advisory lock (WORKER_STAGGER_OFFSETS.clickup_reconciliation) so
//      exactly one autoscale instance fires per tick. The lock self-heals
//      on crash.
//   3. Worker pool — all DB work runs via runWithWorkerDb.

import { runWithWorkerDb, withDbAttribution, getDb } from "../db";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { workQueue } from "@shared/schema";

const SINGLETON_KEY = "clickup_reconciliation";
const ENABLED_SETTING = "clickup_reconciliation_sweep_enabled";
const INTERVAL_SETTING = "clickup_reconciliation_sweep_interval_ms";
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_INTERVAL_MS = 5 * 60 * 1000; // never tighter than 5 min

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Local escape hatch so the sweep can run in the workspace / tests without
 * a deploy (mirrors ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE).
 */
function isForceEnabled(): boolean {
  const v = process.env.CLICKUP_RECONCILIATION_SWEEP_FORCE_ENABLE;
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
      console.log("[ClickUpReconciliation] Kill switch off — skipping tick");
      return;
    }

    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:clickup-reconciliation", async () => {
        const db = getDb();
        await db.insert(workQueue).values({
          queueName: "clickup_reconciliation_sweep",
          jobType: "clickup_reconciliation_sweep",
          workloadClass: "reporting",
          priority: 100,
          status: "pending",
          payload: {},
        } as any);
        await db.insert(workQueue).values({
          queueName: "clickup_webhook_health_check",
          jobType: "clickup_webhook_health_check",
          workloadClass: "reporting",
          priority: 100,
          status: "pending",
          payload: {},
        } as any);
        console.log("[ClickUpReconciliation] Enqueued clickup_reconciliation_sweep + clickup_webhook_health_check");
      }),
    );
  } catch (err: any) {
    console.warn("[ClickUpReconciliation] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startClickUpReconciliationScheduler(): Promise<void> {
  if (scheduler) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[ClickUpReconciliation] Not in deployment — scheduler disabled " +
        "(set CLICKUP_RECONCILIATION_SWEEP_FORCE_ENABLE=1 to override).",
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
    `[ClickUpReconciliation] Scheduler started (every ${intervalMs / 1000 / 60}min, kill switch: ${ENABLED_SETTING})`,
  );
}

export function stopClickUpReconciliationScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
    console.log("[ClickUpReconciliation] Scheduler stopped");
  }
}
