// @db-pool-intent: worker
// @cross-instance-safe: idempotent time-cutoff batched DELETEs of terminal/expired rows — concurrent instances target the same already-eligible rows, so deletion is convergent with no double-effect (same rationale as auditRetention.ts / frontHydrateSnapshotsPruner.ts).
/**
 * Task #3814 — Scheduled retention pruner for the high-churn operational
 * tables declared in `tableMaintenancePolicy.ts` (work_queue terminal rows,
 * source_event_log terminal rows [+ CASCADE to work_result_log/apply_state],
 * call_analysis_jobs terminal rows, expired mcu_cache rows, old
 * table_size_samples rows).
 *
 * Production tables grew forever where lifecycle rules were missing —
 * measured 2026-08-05: work_queue 809,610 rows / 693 MB, source_event_log
 * 399 MB, work_result_log 294 MB, call_analysis_jobs 238 MB, apply_state
 * 128 MB, mcu_cache 56 MB. This pruner keeps them near steady-state once
 * the `deep_prune_reclaim_oversized_tables` prod-action clears the initial
 * backlog.
 *
 * Gates (mirrors the Task #1810 front_hydrate_snapshots pruner):
 *   - `table_retention_pruner_enabled` system setting (default "false");
 *     operator flips ON via the `enable_table_retention_pruner` registry
 *     action.
 *   - `KILL_SWITCH_NON_CRITICAL_SWEEPS` (existing global). When ON the
 *     tick exits without deleting.
 *
 * Retention windows: per-unit system settings with conservative defaults
 * (see policy). Hold discipline: every batch is one labelled DELETE of at
 * most BATCH_LIMIT rows via a pk IN (SELECT … LIMIT n) subselect on the
 * `worker` pool, so no single statement holds a connection long. A per-tick
 * per-unit batch cap bounds tick duration; the scheduled tick only needs to
 * keep up with daily churn (the deep-prune action owns backlogs).
 */
import { sql, type SQL } from "drizzle-orm";
import { workerDb, withDbAttribution } from "../db";
import { isKillSwitchEnabled } from "./killSwitches";
import { storage } from "../storage";
import {
  PRUNE_UNITS,
  TABLE_RETENTION_PRUNER_ENABLED_KEY,
  type PruneUnit,
} from "./tableMaintenancePolicy";

const TICK_INTERVAL_MS = 60 * 60_000; // hourly
export const BATCH_LIMIT = 2000;
const MAX_BATCHES_PER_UNIT_PER_TICK = 25; // ≤50k rows / unit / tick

let tickTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function readUnitRetentionDays(unit: PruneUnit): Promise<number | null> {
  if (!unit.retentionSettingKey || unit.defaultRetentionDays === null) return null;
  try {
    const row = await storage.getSystemSetting(unit.retentionSettingKey);
    const n = Number(row?.value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return unit.defaultRetentionDays;
}

/**
 * Build the eligibility predicate for a unit with the cutoff bound as a
 * parameter. Table/predicate text comes from the fixed in-code policy
 * (never user input); only the cutoff is dynamic.
 */
function buildPredicate(unit: PruneUnit, retentionDays: number | null, now: number): SQL {
  if (unit.cutoffKind === "none") {
    return sql.raw(unit.wherePredicate);
  }
  const days = retentionDays ?? unit.defaultRetentionDays ?? 0;
  const cutoffMs = now - days * 24 * 60 * 60_000;
  const parts = unit.wherePredicate.split("$CUTOFF");
  if (parts.length !== 2) {
    throw new Error(`PruneUnit ${unit.key} predicate must contain exactly one $CUTOFF`);
  }
  const bound = unit.cutoffKind === "epoch_ms" ? cutoffMs : new Date(cutoffMs);
  return sql`${sql.raw(parts[0])}${bound}${sql.raw(parts[1])}`;
}

/**
 * Delete one batch of eligible rows for `unit`. Returns rows removed.
 * Exported for the deep-prune prod-action, which drains backlogs through
 * the same statement shape.
 */
export async function deleteOneBatch(
  unit: PruneUnit,
  opts: { retentionDays: number | null; batchLimit?: number; now?: number },
): Promise<number> {
  const limit = opts.batchLimit ?? BATCH_LIMIT;
  const predicate = buildPredicate(unit, opts.retentionDays, opts.now ?? Date.now());
  const res = await withDbAttribution(
    `maintenance:table-retention-prune:${unit.key}`,
    () =>
      workerDb.execute<any>(sql`
        DELETE FROM ${sql.raw(unit.table)}
        WHERE ${sql.raw(unit.pkColumn)} IN (
          SELECT ${sql.raw(unit.pkColumn)} FROM ${sql.raw(unit.table)}
          WHERE ${predicate}
          LIMIT ${limit}
        )
      `),
  );
  return Number((res as any)?.rowCount ?? 0);
}

/**
 * Count rows currently eligible for a unit, capped at `cap` (a capped count
 * keeps the statement cheap on big backlogs — callers only need "0",
 * "small", or ">= cap").
 */
export async function countEligible(
  unit: PruneUnit,
  cap: number,
  opts?: { retentionDays?: number | null; now?: number },
): Promise<number> {
  const retentionDays =
    opts?.retentionDays !== undefined ? opts.retentionDays : await readUnitRetentionDays(unit);
  const predicate = buildPredicate(unit, retentionDays, opts?.now ?? Date.now());
  const res = await withDbAttribution(
    `maintenance:table-retention-count:${unit.key}`,
    () =>
      workerDb.execute<any>(sql`
        SELECT COUNT(*)::int AS n FROM (
          SELECT 1 FROM ${sql.raw(unit.table)}
          WHERE ${predicate}
          LIMIT ${cap}
        ) capped
      `),
  );
  return Number((res as any)?.rows?.[0]?.n ?? 0);
}

export interface UnitPruneResult {
  unitKey: string;
  table: string;
  deleted: number;
  batches: number;
  /** True when the last batch came back short — no more eligible rows. */
  exhausted: boolean;
  error?: string;
}

/**
 * Run batched deletes for one unit until exhausted or `maxBatches` reached.
 */
export async function pruneUnit(
  unit: PruneUnit,
  opts?: { batchLimit?: number; maxBatches?: number; now?: number },
): Promise<UnitPruneResult> {
  const batchLimit = opts?.batchLimit ?? BATCH_LIMIT;
  const maxBatches = opts?.maxBatches ?? MAX_BATCHES_PER_UNIT_PER_TICK;
  const retentionDays = await readUnitRetentionDays(unit);
  let deleted = 0;
  let batches = 0;
  let exhausted = false;
  for (let i = 0; i < maxBatches; i++) {
    let removed: number;
    try {
      removed = await deleteOneBatch(unit, {
        retentionDays,
        batchLimit,
        now: opts?.now,
      });
    } catch (err: any) {
      console.warn(
        `[TableRetentionPruner] ${unit.key} batch delete failed:`,
        err?.message ?? err,
      );
      return { unitKey: unit.key, table: unit.table, deleted, batches, exhausted, error: String(err?.message ?? err) };
    }
    batches++;
    deleted += removed;
    if (removed < batchLimit) {
      exhausted = true;
      break;
    }
  }
  return { unitKey: unit.key, table: unit.table, deleted, batches, exhausted };
}

async function isEnabled(): Promise<boolean> {
  try {
    const row = await storage.getSystemSetting(TABLE_RETENTION_PRUNER_ENABLED_KEY);
    return (row?.value ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * One scheduled pass over every prune unit (gated). Exported for tests via
 * `__test`; the deep-prune prod-action does NOT go through this (it calls
 * `pruneUnit`/`deleteOneBatch` directly so it can run before the scheduler
 * setting is flipped and without per-tick batch caps).
 */
async function pruneTick(): Promise<UnitPruneResult[]> {
  if (!(await isEnabled())) return [];
  if (isKillSwitchEnabled("non_critical_sweeps")) return [];
  const results: UnitPruneResult[] = [];
  for (const unit of PRUNE_UNITS) {
    const r = await pruneUnit(unit);
    results.push(r);
    if (r.deleted > 0) {
      console.log(
        `[TableRetentionPruner] ${unit.key}: pruned ${r.deleted} row(s) in ${r.batches} batch(es)${r.exhausted ? "" : " (cap hit — more remain)"}`,
      );
    }
  }
  return results;
}

export function startTableRetentionPruner(): void {
  if (tickTimer) return;
  // Initial tick deferred so boot isn't blocked.
  setTimeout(() => {
    if (running) return;
    running = true;
    void pruneTick()
      .catch((err) =>
        console.warn("[TableRetentionPruner] initial tick failed:", err?.message ?? err),
      )
      .finally(() => {
        running = false;
      });
  }, 25_000);
  tickTimer = setInterval(() => {
    if (running) return;
    running = true;
    void pruneTick()
      .catch((err) =>
        console.warn("[TableRetentionPruner] tick failed:", err?.message ?? err),
      )
      .finally(() => {
        running = false;
      });
  }, TICK_INTERVAL_MS);
  if (typeof (tickTimer as any).unref === "function") {
    (tickTimer as any).unref();
  }
  console.log(
    `[TableRetentionPruner] started — hourly tick over ${PRUNE_UNITS.length} prune units, batch ${BATCH_LIMIT}, gated by ${TABLE_RETENTION_PRUNER_ENABLED_KEY}`,
  );
}

export function stopTableRetentionPruner(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export const __test = { pruneTick, buildPredicate };
