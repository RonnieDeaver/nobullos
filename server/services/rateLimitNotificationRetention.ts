// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  // @cross-instance-safe: the node-cron job runs an idempotent time-cutoff DELETE
  // (pruneOldRateLimitAlertNotifications). node-cron's in-process timer fires on
  // every autoscale instance, but concurrent runs target the same already-eligible
  // rows; the prune-history rows it writes are advisory observability only.
  // (Task #2397)
  import cron from "node-cron";
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { ensureRateLimitAlertNotificationsTable } from "../storage/rateLimitAlertNotificationsStorage";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const SETTING_KEY = "rate_limit_notification_retention_days";

function parseRetentionDays(raw: string | undefined | null): number {
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.min(parsed, MAX_RETENTION_DAYS);
}

export const RATE_LIMIT_NOTIFICATION_RETENTION_DAYS_FALLBACK = parseRetentionDays(
  process.env.RATE_LIMIT_NOTIFICATION_RETENTION_DAYS,
);

// Backwards-compat export. Reflects the env-var/default fallback value;
// the live retention used by the prune is fetched dynamically.
export const RATE_LIMIT_NOTIFICATION_RETENTION_DAYS =
  RATE_LIMIT_NOTIFICATION_RETENTION_DAYS_FALLBACK;

export function getMaxRateLimitNotificationRetentionDays(): number {
  return MAX_RETENTION_DAYS;
}

export function getDefaultRateLimitNotificationRetentionDays(): number {
  return DEFAULT_RETENTION_DAYS;
}

export function getFallbackRateLimitNotificationRetentionDays(): number {
  return RATE_LIMIT_NOTIFICATION_RETENTION_DAYS_FALLBACK;
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let pruneRunning = false;
let onDemandPruneInFlight = false;

export class OnDemandPruneBusyError extends Error {
  constructor() {
    super("A notification-history cleanup is already running. Try again in a moment.");
    this.name = "OnDemandPruneBusyError";
  }
}

export interface RateLimitNotificationPruneResult {
  deleted: number;
  retentionDays: number;
  cutoffMs: number;
  durationMs: number;
}

export interface RateLimitNotificationPruneContext {
  triggeredBy: string;
  actorId?: string | null;
}

export async function getConfiguredRateLimitNotificationRetentionDays(): Promise<number> {
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
      "[RateLimitNotificationRetention] Failed to read configured retention; falling back:",
      err?.message ?? err,
    );
  }
  return RATE_LIMIT_NOTIFICATION_RETENTION_DAYS_FALLBACK;
}

export async function setConfiguredRateLimitNotificationRetentionDays(
  value: number | null,
  updatedBy?: string,
): Promise<number> {
  const { setSystemSetting, deleteSystemSetting } = await import(
    "../storage/settingsStorage"
  );
  if (value === null) {
    await deleteSystemSetting(SETTING_KEY);
    return RATE_LIMIT_NOTIFICATION_RETENTION_DAYS_FALLBACK;
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

export async function pruneOldRateLimitAlertNotificationsOnDemand(
  retentionDays?: number,
  context?: RateLimitNotificationPruneContext,
): Promise<RateLimitNotificationPruneResult> {
  if (onDemandPruneInFlight) {
    throw new OnDemandPruneBusyError();
  }
  onDemandPruneInFlight = true;
  try {
    return await pruneOldRateLimitAlertNotifications(retentionDays, context);
  } finally {
    onDemandPruneInFlight = false;
  }
}

export async function pruneOldRateLimitAlertNotifications(
  retentionDays?: number,
  context?: RateLimitNotificationPruneContext,
): Promise<RateLimitNotificationPruneResult> {
  const db = getDb();
  await ensureRateLimitAlertNotificationsTable();

  const effective =
    retentionDays ?? (await getConfiguredRateLimitNotificationRetentionDays());
  const safeRetention = Math.max(1, Math.floor(effective));
  const cutoffMs = Date.now() - safeRetention * 24 * 60 * 60 * 1000;

  const startedAt = Date.now();
  let deleted = 0;
  let errorMessage: string | null = null;
  try {
    // Use a raw DELETE so we get rowCount from the driver without materializing
    // every deleted id into memory (the table can have a large historical backlog).
    const result: any = await db.execute(sql`
      DELETE FROM "rate_limit_alert_notifications"
      WHERE "attempted_at" < ${cutoffMs}
    `);
    deleted =
      typeof result?.rowCount === "number"
        ? result.rowCount
        : typeof result?.count === "number"
          ? result.count
          : 0;
  } catch (err: any) {
    errorMessage = err?.message ? String(err.message) : String(err);
    const durationMs = Date.now() - startedAt;
    await recordPruneHistory({
      triggeredBy: context?.triggeredBy ?? "unknown",
      actorId: context?.actorId ?? null,
      retentionDays: safeRetention,
      cutoffMs,
      deletedRows: 0,
      durationMs,
      status: "error",
      errorMessage,
    });
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  await recordPruneHistory({
    triggeredBy: context?.triggeredBy ?? "unknown",
    actorId: context?.actorId ?? null,
    retentionDays: safeRetention,
    cutoffMs,
    deletedRows: deleted,
    durationMs,
    status: "ok",
    errorMessage: null,
  });

  return {
    deleted,
    retentionDays: safeRetention,
    cutoffMs,
    durationMs,
  };
}

async function recordPruneHistory(row: {
  triggeredBy: string;
  actorId: string | null;
  retentionDays: number;
  cutoffMs: number;
  deletedRows: number;
  durationMs: number;
  status: "ok" | "error";
  errorMessage: string | null;
}): Promise<void> {
  try {
    const { insertRateLimitNotificationPruneHistory } = await import(
      "../storage/rateLimitNotificationPruneHistoryStorage"
    );
    await insertRateLimitNotificationPruneHistory(row);
  } catch (err: any) {
    console.error(
      "[RateLimitNotificationRetention] Failed to write prune-history row:",
      err?.message ?? err,
    );
  }
}

async function runPruneOnce(triggeredBy: string = "scheduler"): Promise<void> {
  if (pruneRunning) {
    console.log(
      "[RateLimitNotificationRetention] Previous prune still running, skipping",
    );
    return;
  }
  pruneRunning = true;
  try {
    const result = await pruneOldRateLimitAlertNotifications(undefined, {
      triggeredBy,
    });
    console.log(
      `[RateLimitNotificationRetention] Pruned rate_limit_alert_notifications=${result.deleted} ` +
      `(retention=${result.retentionDays}d, cutoff=${new Date(result.cutoffMs).toISOString()}, ` +
      `duration=${result.durationMs}ms, triggeredBy=${triggeredBy})`,
    );
  } catch (err: any) {
    console.error(
      "[RateLimitNotificationRetention] Prune failed:",
      err?.message ?? err,
    );
  } finally {
    pruneRunning = false;
  }
}

export function startRateLimitNotificationRetentionScheduler(
  cronExpression = "45 3 * * *",
): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }

  scheduledTask = cron.schedule(cronExpression, () => {
    void withDbAttribution("scheduler:rate-limit-notification-retention", () =>
      runPruneOnce("scheduler"),
    );
  }, {
    timezone: "America/New_York",
  });

  console.log(
    `[RateLimitNotificationRetention] Scheduled prune with cron: ${cronExpression} ` +
    `(America/New_York), fallback retention=${RATE_LIMIT_NOTIFICATION_RETENTION_DAYS_FALLBACK}d ` +
    `(admin-configurable via system setting "${SETTING_KEY}")`,
  );

  setTimeout(() => {
    void withDbAttribution("startup:rate-limit-notification-retention-initial-prune", () =>
      runPruneOnce("startup"),
    );
  }, 5_000);
}

export function stopRateLimitNotificationRetentionScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[RateLimitNotificationRetention] Stopped");
  }
}
