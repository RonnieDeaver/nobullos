// @cross-instance-safe: the node-cron job runs an idempotent time-cutoff DELETE
// (deletePendingDigestAlertsOlderThan). node-cron's in-process timer fires on
// every autoscale instance, but concurrent runs target the same already-eligible
// rows, so deletion converges with no double-effect. (Task #2397)
import cron from "node-cron";
import {
  deletePendingDigestAlertsOlderThan,
  ensurePendingDigestAlertsTable,
} from "../storage/pendingDigestAlertsStorage";
import { withDbAttribution } from "../db";

const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
const SETTING_KEY = "pending_digest_alerts_retention_days";

function parseRetentionDays(raw: string | undefined | null): number {
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.min(parsed, MAX_RETENTION_DAYS);
}

export const PENDING_DIGEST_ALERTS_RETENTION_DAYS_FALLBACK = parseRetentionDays(
  process.env.PENDING_DIGEST_ALERTS_RETENTION_DAYS,
);

export function getMaxPendingDigestAlertsRetentionDays(): number {
  return MAX_RETENTION_DAYS;
}

export function getDefaultPendingDigestAlertsRetentionDays(): number {
  return DEFAULT_RETENTION_DAYS;
}

export function getFallbackPendingDigestAlertsRetentionDays(): number {
  return PENDING_DIGEST_ALERTS_RETENTION_DAYS_FALLBACK;
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let pruneRunning = false;

export interface PendingDigestAlertsPruneResult {
  deleted: number;
  retentionDays: number;
  cutoffMs: number;
}

export async function getConfiguredPendingDigestAlertsRetentionDays(): Promise<number> {
  try {
    const { getSystemSetting } = await import("../storage/settingsStorage");
    const row = await getSystemSetting(SETTING_KEY);
    const raw = row?.value?.trim();
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        return Math.min(parsed, MAX_RETENTION_DAYS);
      }
    }
  } catch (err: any) {
    console.error(
      "[PendingDigestAlertsRetention] Failed to read configured retention; falling back:",
      err?.message ?? err,
    );
  }
  return PENDING_DIGEST_ALERTS_RETENTION_DAYS_FALLBACK;
}

export async function setConfiguredPendingDigestAlertsRetentionDays(
  value: number | null,
  updatedBy?: string,
): Promise<number> {
  const { setSystemSetting, deleteSystemSetting } = await import(
    "../storage/settingsStorage"
  );
  if (value === null) {
    await deleteSystemSetting(SETTING_KEY);
    return PENDING_DIGEST_ALERTS_RETENTION_DAYS_FALLBACK;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("retentionDays must be a positive integer");
  }
  if (value > MAX_RETENTION_DAYS) {
    throw new Error(`retentionDays cannot exceed ${MAX_RETENTION_DAYS}`);
  }
  const safe = Math.floor(value);
  await setSystemSetting(SETTING_KEY, String(safe), updatedBy);
  return safe;
}

export async function prunePendingDigestAlerts(
  retentionDays?: number,
): Promise<PendingDigestAlertsPruneResult> {
  await ensurePendingDigestAlertsTable();
  const effective =
    retentionDays ?? (await getConfiguredPendingDigestAlertsRetentionDays());
  const safeRetention = Math.max(1, Math.floor(effective));
  const cutoffMs = Date.now() - safeRetention * 24 * 60 * 60 * 1000;
  const deleted = await deletePendingDigestAlertsOlderThan(cutoffMs);
  return { deleted, retentionDays: safeRetention, cutoffMs };
}

async function runPruneOnce(): Promise<void> {
  if (pruneRunning) {
    console.log(
      "[PendingDigestAlertsRetention] Previous prune still running, skipping",
    );
    return;
  }
  pruneRunning = true;
  try {
    const result = await prunePendingDigestAlerts();
    console.log(
      `[PendingDigestAlertsRetention] Pruned pending_digest_alerts=${result.deleted} ` +
        `(retention=${result.retentionDays}d, cutoff=${new Date(result.cutoffMs).toISOString()})`,
    );
  } catch (err: any) {
    console.error(
      "[PendingDigestAlertsRetention] Prune failed:",
      err?.message ?? err,
    );
  } finally {
    pruneRunning = false;
  }
}

export function startPendingDigestAlertsRetentionScheduler(
  cronExpression = "15 4 * * *",
): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }

  scheduledTask = cron.schedule(
    cronExpression,
    () => {
      void withDbAttribution("scheduler:pending-digest-alerts-retention", () => runPruneOnce());
    },
    { timezone: "America/New_York" },
  );

  console.log(
    `[PendingDigestAlertsRetention] Scheduled prune with cron: ${cronExpression} ` +
      `(America/New_York), fallback retention=${PENDING_DIGEST_ALERTS_RETENTION_DAYS_FALLBACK}d ` +
      `(admin-configurable via system setting "${SETTING_KEY}")`,
  );

  setTimeout(() => {
    void withDbAttribution("startup:pending-digest-alerts-initial-prune", () => runPruneOnce());
  }, 5_000);
}

export function stopPendingDigestAlertsRetentionScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[PendingDigestAlertsRetention] Stopped");
  }
}
