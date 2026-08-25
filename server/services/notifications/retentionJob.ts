// @cross-instance-safe: idempotent retention DELETE by cutoff; converges regardless of how many instances run it.
/**
 * Task #994 — Daily delivery-history retention.
 *
 * Keeps 30 days of delivery attempts AND at most 500 rows per notification id,
 * whichever is smaller. Runs once per process shortly after boot, then every
 * 24h. Idempotent and safe to call manually from a route.
 */

import { withDbAttribution } from "../../db";
import { pruneOldDeliveries } from "../../storage/notificationsStorage";

const RETENTION_DAYS = 30;
const KEEP_PER_NOTIFICATION = 500;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

export async function runDeliveryRetentionPass(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return withDbAttribution("notifications:retention", async () => {
    const deleted = await pruneOldDeliveries({
      olderThan: cutoff,
      keepPerNotification: KEEP_PER_NOTIFICATION,
    });
    if (deleted > 0) {
      console.log(`[notifications/retention] pruned ${deleted} delivery rows`);
    }
    return { deleted };
  });
}

export function startNotificationRetentionScheduler(): void {
  if (timer || interval) return;
  timer = setTimeout(() => {
    runDeliveryRetentionPass().catch((err) =>
      console.warn("[notifications/retention] startup pass failed:", err?.message ?? err),
    );
    interval = setInterval(() => {
      runDeliveryRetentionPass().catch((err) =>
        console.warn("[notifications/retention] daily pass failed:", err?.message ?? err),
      );
    }, DAILY_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
  console.log(
    `[notifications/retention] scheduler started — first pass in ${STARTUP_DELAY_MS / 60000}min, then every 24h`,
  );
}

export function stopNotificationRetentionScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
