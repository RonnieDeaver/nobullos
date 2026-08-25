// @db-pool-intent: worker
// @cross-instance-safe: idempotent batched DELETE of expired snapshot rows; converges regardless of how many instances run it.
/**
 * Task #1810 — `front_hydrate_snapshots` retention pruner.
 *
 * The Front Pipeline State Machine's Hydrate Snapshot Layer writes one
 * row to `front_hydrate_snapshots` per (conversationId, versionKey).
 * The table grows unbounded — there is no upstream eviction. This
 * pruner deletes rows older than the retention window in short
 * batches on the `worker` pool.
 *
 * Gates:
 *   - `front_hydrate_snapshots_pruner_enabled` system setting
 *     (default "false"). Operator flips ON via the
 *     `enable_front_hydrate_snapshots_pruner` registry action.
 *   - `KILL_SWITCH_NON_CRITICAL_SWEEPS` (existing global). When ON
 *     the tick logs and exits.
 *
 * Retention:
 *   - `front_hydrate_snapshots_retention_days` (default 30).
 *
 * Hold discipline:
 *   - Each batch is a single labelled DELETE with LIMIT 1000 so the
 *     `worker`-pool hold stays under the 10s warn tier even on a
 *     large initial backlog. Loop continues until a batch returns 0.
 *
 * Idempotent: re-pressing the enable action is a no-op once the
 * timer is registered; subsequent presses just re-confirm the
 * setting flip.
 */
import { sql } from "drizzle-orm";
import { workerDb, withDbAttribution } from "../db";
import { isKillSwitchEnabled } from "./killSwitches";
import { storage } from "../storage";

const DEFAULT_RETENTION_DAYS = 30;
const TICK_INTERVAL_MS = 60 * 60_000; // hourly
const BATCH_LIMIT = 1000;
const MAX_BATCHES_PER_TICK = 50; // safety cap: ≤50k rows / tick

let tickTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function readRetentionDays(): Promise<number> {
  try {
    const row = await storage.getSystemSetting("front_hydrate_snapshots_retention_days");
    const n = Number(row?.value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return DEFAULT_RETENTION_DAYS;
}

async function isEnabled(): Promise<boolean> {
  try {
    const row = await storage.getSystemSetting("front_hydrate_snapshots_pruner_enabled");
    return (row?.value ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

async function pruneTick(): Promise<{ deleted: number; batches: number }> {
  if (!(await isEnabled())) return { deleted: 0, batches: 0 };
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    return { deleted: 0, batches: 0 };
  }
  const retentionDays = await readRetentionDays();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60_000;
  const cutoff = new Date(cutoffMs);

  let total = 0;
  let batches = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    try {
      const res = await withDbAttribution(
        "maintenance:front-hydrate-snapshots-prune",
        () =>
          workerDb.execute<any>(sql`
            DELETE FROM front_hydrate_snapshots
            WHERE id IN (
              SELECT id FROM front_hydrate_snapshots
              WHERE hydrated_at < ${cutoff}
              LIMIT ${BATCH_LIMIT}
            )
          `),
      );
      const removed = Number((res as any)?.rowCount ?? 0);
      batches++;
      total += removed;
      if (removed < BATCH_LIMIT) break;
    } catch (err: any) {
      console.warn(
        "[FrontHydrateSnapshotsPruner] batch delete failed:",
        err?.message ?? err,
      );
      break;
    }
  }
  if (total > 0) {
    console.log(
      `[FrontHydrateSnapshotsPruner] pruned ${total} row(s) in ${batches} batch(es) (retention=${retentionDays}d)`,
    );
  }
  return { deleted: total, batches };
}

export function startFrontHydrateSnapshotsPruner(): void {
  if (tickTimer) return;
  // Initial tick deferred a few seconds so boot isn't blocked.
  setTimeout(() => {
    if (running) return;
    running = true;
    void pruneTick()
      .catch((err) =>
        console.warn(
          "[FrontHydrateSnapshotsPruner] initial tick failed:",
          err?.message ?? err,
        ),
      )
      .finally(() => {
        running = false;
      });
  }, 15_000);
  tickTimer = setInterval(() => {
    if (running) return;
    running = true;
    void pruneTick()
      .catch((err) =>
        console.warn(
          "[FrontHydrateSnapshotsPruner] tick failed:",
          err?.message ?? err,
        ),
      )
      .finally(() => {
        running = false;
      });
  }, TICK_INTERVAL_MS);
  if (typeof (tickTimer as any).unref === "function") {
    (tickTimer as any).unref();
  }
  console.log(
    `[FrontHydrateSnapshotsPruner] started — hourly tick, default retention ${DEFAULT_RETENTION_DAYS}d, batch ${BATCH_LIMIT}, gated by front_hydrate_snapshots_pruner_enabled`,
  );
}

export function stopFrontHydrateSnapshotsPruner(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export const __test = { pruneTick };
