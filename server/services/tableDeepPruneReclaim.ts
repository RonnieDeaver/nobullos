// @db-pool-intent: worker
/**
 * Task #3814 — Deep prune + space reclamation for the oversized operational
 * tables declared in `tableMaintenancePolicy.ts`. Backs the one-press
 * `deep_prune_reclaim_oversized_tables` production action.
 *
 * Why a separate action when the scheduled pruner exists: DELETE only marks
 * rows dead — `front_hydrate_snapshots` proved that (1,050 MB on disk for
 * 31 live rows after months of dutiful row pruning). Reclaiming the space
 * needs `VACUUM (FULL, ANALYZE)`, which rewrites the table to just its live
 * rows and returns the space to the OS, but takes an ACCESS EXCLUSIVE lock —
 * an operator-initiated, once-per-backlog operation, not a scheduled one.
 *
 * Drain shape (background-drain framework):
 *   Phase 1 (prune): unbounded batched deletes per prune unit (5000-row
 *     batches, one batch per chunk) until every unit is exhausted.
 *   Phase 2 (reclaim): one `VACUUM (FULL, ANALYZE)` per covered table per
 *     chunk, on a dedicated worker-pool client with `lock_timeout='5s'` —
 *     if the exclusive lock cannot be taken quickly the table is SKIPPED
 *     and recorded, never blocked on; the connection is destroyed on
 *     release so session settings cannot leak back into the pool.
 *   Completion: per-table reclaim stamps ({at, bytesBefore, bytesAfter})
 *     are written to the `table_reclaim_state` system setting. The
 *     action's status() treats a fresh stamp as "reclaimed recently", so
 *     the action converges to not-needed after a successful run even when
 *     a table's steady-state size sits above a mis-tuned band (the
 *     watchdog then points at the band, not the action).
 */
import { workerPool } from "../db";
import { storage } from "../storage";
import {
  COVERED_TABLES,
  COVERED_TABLE_NAMES,
  PRUNE_UNITS,
  TABLE_RECLAIM_STATE_SETTING_KEY,
  bytesToMb,
  resolveBandBytes,
  type PruneUnit,
} from "./tableMaintenancePolicy";
import {
  countEligible,
  deleteOneBatch,
  readUnitRetentionDays,
} from "./tableRetentionPruner";
import { fetchTableSizes, type TableSizeRow } from "./tableSizeWatchdog";
import type { DrainChunkResult } from "./prodActionBackgroundDrain";

export const DEEP_PRUNE_ACTION_ID = "deep_prune_reclaim_oversized_tables";
/** Backlogs below this are left to the hourly scheduled pruner. */
export const BACKLOG_PENDING_THRESHOLD = 5000;
/** Capped per-unit eligibility count (statement stays cheap on huge backlogs). */
export const BACKLOG_COUNT_CAP = 100_000;
/** Big batches for the one-off drain (scheduled pruner uses 2000). */
export const DEEP_PRUNE_BATCH = 5000;
/** A reclaim stamp younger than this makes the table "recently reclaimed". */
export const RECLAIM_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const VACUUM_LOCK_TIMEOUT = "5s";
const VACUUM_STATEMENT_TIMEOUT = "1800s";

export interface ReclaimStamp {
  at: string;
  bytesBefore: number;
  bytesAfter: number;
}

export async function readReclaimStamps(): Promise<Record<string, ReclaimStamp>> {
  try {
    const row = await storage.getSystemSetting(TABLE_RECLAIM_STATE_SETTING_KEY);
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isStampFresh(stamp: ReclaimStamp | undefined, now: number): boolean {
  if (!stamp) return false;
  const at = Date.parse(stamp.at);
  return Number.isFinite(at) && now - at < RECLAIM_COOLDOWN_MS;
}

/** Capped total of prune-eligible rows across every unit. */
export async function countPruneBacklog(): Promise<{ total: number; perUnit: Record<string, number> }> {
  const perUnit: Record<string, number> = {};
  let total = 0;
  for (const unit of PRUNE_UNITS) {
    const n = await countEligible(unit, BACKLOG_COUNT_CAP);
    perUnit[unit.key] = n;
    total += n;
  }
  return { total, perUnit };
}

export interface OverBandTable {
  table: string;
  totalBytes: number;
  bandBytes: number;
  stampFresh: boolean;
}

/**
 * Tables currently over their size band, split by whether a fresh reclaim
 * stamp exists (fresh stamp ⇒ the deep prune already did its job — the
 * band, not the action, is what needs attention).
 */
export async function findOverBandTables(now: number = Date.now()): Promise<OverBandTable[]> {
  const sizes = await fetchTableSizes(COVERED_TABLE_NAMES);
  const stamps = await readReclaimStamps();
  let overridesJson: string | null = null;
  try {
    const row = await storage.getSystemSetting("table_size_watchdog_bands_mb");
    overridesJson = row?.value ?? null;
  } catch {}
  const out: OverBandTable[] = [];
  for (const covered of COVERED_TABLES) {
    const size = sizes.get(covered.table);
    if (!size) continue;
    const bandBytes = resolveBandBytes(covered.table, overridesJson);
    if (size.totalBytes > bandBytes) {
      out.push({
        table: covered.table,
        totalBytes: size.totalBytes,
        bandBytes,
        stampFresh: isStampFresh(stamps[covered.table], now),
      });
    }
  }
  return out;
}

/**
 * Run VACUUM (FULL, ANALYZE) on one covered table using a dedicated
 * worker-pool client. Returns "done" or "lock_skipped" (someone held the
 * table longer than the lock timeout — safe to retry later). The client is
 * DESTROYED on release so the session lock/statement timeouts can never
 * leak back into the pool.
 *
 * `table` must be one of COVERED_TABLE_NAMES (asserted) — never caller
 * input — so the identifier interpolation is safe.
 */
export async function vacuumFullTable(
  table: string,
): Promise<{ outcome: "done" | "lock_skipped"; error?: string }> {
  if (!COVERED_TABLE_NAMES.includes(table)) {
    throw new Error(`vacuumFullTable: ${table} is not a covered table`);
  }
  const client = await workerPool.connect();
  try {
    await client.query(`SET lock_timeout = '${VACUUM_LOCK_TIMEOUT}'`);
    await client.query(`SET statement_timeout = '${VACUUM_STATEMENT_TIMEOUT}'`);
    await client.query(`VACUUM (FULL, ANALYZE) "${table}"`);
    return { outcome: "done" };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // 55P03 lock_not_available / "canceling statement due to lock timeout"
    if (err?.code === "55P03" || /lock timeout/i.test(msg)) {
      return { outcome: "lock_skipped", error: msg };
    }
    throw err;
  } finally {
    // true ⇒ destroy the connection instead of returning it to the pool.
    client.release(true);
  }
}

// ── Drain state machine ─────────────────────────────────────────────────────

interface DeepPruneRunState {
  phase: "prune" | "vacuum";
  unitIdx: number;
  retentionByUnit: Map<string, number | null>;
  vacuumQueue: string[];
  sizesBefore: Map<string, TableSizeRow>;
  vacuumed: Record<string, { bytesBefore: number; bytesAfter: number }>;
  lockSkipped: Record<string, string>;
  actorId: string | null;
}

let runState: DeepPruneRunState | null = null;

export function resetDeepPruneRunState(): void {
  runState = null;
}

export function getDeepPruneRunSnapshot(): {
  vacuumed: Record<string, { bytesBefore: number; bytesAfter: number }>;
  lockSkipped: Record<string, string>;
} | null {
  if (!runState) return null;
  return { vacuumed: { ...runState.vacuumed }, lockSkipped: { ...runState.lockSkipped } };
}

async function initRunState(actorId: string | null): Promise<DeepPruneRunState> {
  const retentionByUnit = new Map<string, number | null>();
  for (const unit of PRUNE_UNITS) {
    retentionByUnit.set(unit.key, await readUnitRetentionDays(unit));
  }
  const sizesBefore = await fetchTableSizes(COVERED_TABLE_NAMES);
  return {
    phase: "prune",
    unitIdx: 0,
    retentionByUnit,
    // Vacuum every covered table that exists in this DB — reclaiming a
    // freshly-pruned table is the entire point, and FULL on an
    // already-small table costs almost nothing (it copies live rows only).
    vacuumQueue: COVERED_TABLE_NAMES.filter((t) => sizesBefore.has(t)),
    sizesBefore,
    vacuumed: {},
    lockSkipped: {},
    actorId,
  };
}

async function stampReclaimState(state: DeepPruneRunState): Promise<void> {
  if (Object.keys(state.vacuumed).length === 0) return;
  const existing = await readReclaimStamps();
  const at = new Date().toISOString();
  for (const [table, sizes] of Object.entries(state.vacuumed)) {
    existing[table] = { at, bytesBefore: sizes.bytesBefore, bytesAfter: sizes.bytesAfter };
  }
  await storage.setSystemSetting(
    TABLE_RECLAIM_STATE_SETTING_KEY,
    JSON.stringify(existing),
    state.actorId ?? undefined,
  );
}

/**
 * One background-drain chunk. Phase 1 deletes one 5000-row batch from the
 * first non-exhausted prune unit; phase 2 vacuums one table. Returning
 * processed=0 ends the drain (stamps are written in the same final chunk,
 * before that return).
 */
export async function runDeepPruneChunk(actorId: string | null): Promise<DrainChunkResult> {
  if (!runState) {
    runState = await initRunState(actorId);
  }
  const state = runState;

  if (state.phase === "prune") {
    while (state.unitIdx < PRUNE_UNITS.length) {
      const unit: PruneUnit = PRUNE_UNITS[state.unitIdx];
      const removed = await deleteOneBatch(unit, {
        retentionDays: state.retentionByUnit.get(unit.key) ?? unit.defaultRetentionDays,
        batchLimit: DEEP_PRUNE_BATCH,
      });
      if (removed > 0) {
        return { processed: removed, perKey: { [`pruned:${unit.key}`]: removed } };
      }
      state.unitIdx++;
    }
    state.phase = "vacuum";
  }

  // Vacuum phase: one table per chunk.
  const table = state.vacuumQueue.shift();
  if (table) {
    const before = state.sizesBefore.get(table)?.totalBytes ?? 0;
    const result = await vacuumFullTable(table);
    if (result.outcome === "done") {
      const after = (await fetchTableSizes([table])).get(table)?.totalBytes ?? 0;
      state.vacuumed[table] = { bytesBefore: before, bytesAfter: after };
      console.log(
        `[DeepPruneReclaim] VACUUM FULL ${table}: ${bytesToMb(before)} MB → ${bytesToMb(after)} MB`,
      );
      return { processed: 1, perKey: { [`reclaimed:${table}`]: 1 } };
    }
    state.lockSkipped[table] = result.error ?? "lock timeout";
    console.warn(
      `[DeepPruneReclaim] VACUUM FULL ${table} skipped (lock not available within ${VACUUM_LOCK_TIMEOUT}) — retryable later`,
    );
    return { processed: 1, perKey: { [`lock_skipped:${table}`]: 1 } };
  }

  // Nothing left: write stamps, clear state, end the drain.
  await stampReclaimState(state);
  runState = null;
  return { processed: 0 };
}

export function formatDeepPruneSummary(perKey: Record<string, number>): string {
  const pruned = Object.entries(perKey)
    .filter(([k]) => k.startsWith("pruned:"))
    .reduce((a, [, v]) => a + v, 0);
  const reclaimed = Object.entries(perKey)
    .filter(([k]) => k.startsWith("reclaimed:"))
    .map(([k]) => k.slice("reclaimed:".length));
  const skipped = Object.entries(perKey)
    .filter(([k]) => k.startsWith("lock_skipped:"))
    .map(([k]) => k.slice("lock_skipped:".length));
  const parts = [
    `Pruned ${pruned.toLocaleString()} expired row(s)`,
    `reclaimed space on ${reclaimed.length} table(s)${reclaimed.length ? ` (${reclaimed.join(", ")})` : ""}`,
  ];
  if (skipped.length > 0) {
    parts.push(
      `skipped ${skipped.length} locked table(s) (${skipped.join(", ")}) — safe to run the action again later for those`,
    );
  }
  return parts.join("; ") + ".";
}
