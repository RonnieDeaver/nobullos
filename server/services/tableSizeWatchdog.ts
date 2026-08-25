// @db-pool-intent: worker
/**
 * Task #3814 — Table-size watchdog + trend sampler.
 *
 * Every SAMPLE_INTERVAL_MS this service snapshots
 * `pg_total_relation_size` / `pg_stat_user_tables` for every table covered
 * by `tableMaintenancePolicy.ts` into `table_size_samples` (the admin
 * health dashboard's "Size Trend" view reads those rows), then compares
 * each table's current total size against its expected band and alerts
 * when a covered table grows past it — so unbounded growth is visible
 * BEFORE it slows queue polling, vacuum, and the daily backup again.
 *
 * Alerting: unified dispatcher id `infra.database.table_growth`, one
 * dedupeKey per table (`table_growth:<table>`), so the dispatcher's
 * health-state machinery dedupes a sustained breach (6h reminders) and the
 * watchdog calls `markRecovered` once the table falls back under the
 * re-arm level (90% of band — hysteresis so a size oscillating at the band
 * cannot flap).
 *
 * Gates:
 *   - `table_size_watchdog_enabled` system setting (default "false");
 *     flipped ON via the `enable_table_size_watchdog` registry action.
 *   - `KILL_SWITCH_NON_CRITICAL_SWEEPS` (existing global).
 *
 * Cross-instance: the tick runs under `withWorkerSingletonLock` — sampling
 * writes rows, so exactly one instance per tick must win or the trend
 * table gets N-plicated samples on autoscale.
 */
import { sql } from "drizzle-orm";
import { workerDb, runWithWorkerDb, withDbAttribution } from "../db";
import { bindArrayParam } from "../utils/sqlArray";
import { tableSizeSamples, type InsertTableSizeSample } from "@shared/schema";
import { isKillSwitchEnabled } from "./killSwitches";
import { storage } from "../storage";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import {
  COVERED_TABLES,
  COVERED_TABLE_NAMES,
  TABLE_SIZE_BANDS_SETTING_KEY,
  TABLE_SIZE_WATCHDOG_ENABLED_KEY,
  bytesToMb,
  resolveBandBytes,
} from "./tableMaintenancePolicy";

export const NOTIFICATION_ID = "infra.database.table_growth";
const SINGLETON_KEY = "scheduler:table-size-watchdog";
const SAMPLE_INTERVAL_MS = 6 * 60 * 60_000; // every 6h — plenty for size trends
const MAX_TICK_HOLD_MS = 5 * 60_000;
/** Re-arm (recovered) when size falls below this fraction of the band. */
export const REARM_FRACTION = 0.9;

export interface TableSizeRow {
  tableName: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  liveTuples: number;
  deadTuples: number;
}

/**
 * Read current sizes for `tables` (public schema). Also used by the
 * `deep_prune_reclaim_oversized_tables` prod-action to decide which tables
 * still need space reclamation and to record before/after numbers.
 */
export async function fetchTableSizes(tables: string[]): Promise<Map<string, TableSizeRow>> {
  const res = await withDbAttribution("maintenance:table-size-watchdog-sample", () =>
    workerDb.execute<any>(sql`
      SELECT
        c.relname AS table_name,
        pg_total_relation_size(c.oid)::bigint AS total_bytes,
        pg_relation_size(c.oid)::bigint AS table_bytes,
        pg_indexes_size(c.oid)::bigint AS index_bytes,
        COALESCE(s.n_live_tup, 0)::bigint AS live_tuples,
        COALESCE(s.n_dead_tup, 0)::bigint AS dead_tuples
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r'
        AND c.relname = ANY(${bindArrayParam([...tables], "text")})
    `),
  );
  const out = new Map<string, TableSizeRow>();
  for (const row of ((res as any)?.rows ?? []) as any[]) {
    out.set(String(row.table_name), {
      tableName: String(row.table_name),
      totalBytes: Number(row.total_bytes ?? 0),
      tableBytes: Number(row.table_bytes ?? 0),
      indexBytes: Number(row.index_bytes ?? 0),
      liveTuples: Number(row.live_tuples ?? 0),
      deadTuples: Number(row.dead_tuples ?? 0),
    });
  }
  return out;
}

async function isEnabled(): Promise<boolean> {
  try {
    const row = await storage.getSystemSetting(TABLE_SIZE_WATCHDOG_ENABLED_KEY);
    return (row?.value ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

async function readBandOverridesJson(): Promise<string | null> {
  try {
    const row = await storage.getSystemSetting(TABLE_SIZE_BANDS_SETTING_KEY);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// ── test seams (memoryWatchdog pattern) ─────────────────────────────────────
type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: unknown },
  options: Record<string, unknown>,
) => Promise<{ delivered: boolean; skipped?: boolean; status?: string; skipReason?: string }>;
type MarkRecoveredFn = (notificationId: string, dedupeKey: string) => Promise<void>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let markRecoveredOverride: MarkRecoveredFn | null = null;
let sizesOverride: ((tables: string[]) => Map<string, TableSizeRow>) | null = null;

export type TableGrowthDecision =
  | "ok"
  | "alerted"
  | "alert_deduped_or_skipped"
  | "recovered"
  | "in_hysteresis_band";

export interface TableEvaluation {
  table: string;
  totalBytes: number;
  bandBytes: number;
  decision: TableGrowthDecision;
}

export interface WatchdogTickResult {
  ran: boolean;
  skippedReason?: string;
  sampled: number;
  evaluations: TableEvaluation[];
}

function buildBreachText(row: TableSizeRow, bandBytes: number, retentionNote: string): string {
  return [
    `:warning: *DB table over size band* — \`${row.tableName}\` is *${bytesToMb(row.totalBytes)} MB* (band ${bytesToMb(bandBytes)} MB)`,
    `• table ${bytesToMb(row.tableBytes)} MB + indexes ${bytesToMb(row.indexBytes)} MB · ~${row.liveTuples.toLocaleString()} live / ${row.deadTuples.toLocaleString()} dead tuples`,
    `• Row retention: ${retentionNote}`,
    `• If rows are already pruned, space needs reclaiming — run the \`deep_prune_reclaim_oversized_tables\` production action. If growth is legitimate, raise the band via system_settings \`${TABLE_SIZE_BANDS_SETTING_KEY}\` (JSON, MB per table).`,
  ].join("\n");
}

/**
 * One watchdog evaluation: fetch sizes, persist trend samples, evaluate
 * bands, alert/recover. Exported for tests (seams above) and reused by the
 * interval tick under the cluster-wide singleton lock.
 */
export async function captureAndEvaluateOnce(now: number = Date.now()): Promise<WatchdogTickResult> {
  if (!(await isEnabled())) {
    return { ran: false, skippedReason: "disabled", sampled: 0, evaluations: [] };
  }
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    return { ran: false, skippedReason: "kill_switch", sampled: 0, evaluations: [] };
  }

  const sizes = sizesOverride
    ? sizesOverride(COVERED_TABLE_NAMES)
    : await fetchTableSizes(COVERED_TABLE_NAMES);

  // Persist one trend row per covered table that exists in this DB.
  const records: InsertTableSizeSample[] = [];
  for (const t of COVERED_TABLE_NAMES) {
    const row = sizes.get(t);
    if (!row) continue; // table missing in this environment (e.g. pre-publish prod)
    records.push({
      sampledAt: now,
      tableName: row.tableName,
      totalBytes: row.totalBytes,
      tableBytes: row.tableBytes,
      indexBytes: row.indexBytes,
      liveTuples: row.liveTuples,
      deadTuples: row.deadTuples,
    });
  }
  if (records.length > 0 && !sizesOverride) {
    await withDbAttribution("maintenance:table-size-watchdog-insert", () =>
      workerDb.insert(tableSizeSamples).values(records as (typeof tableSizeSamples.$inferInsert)[]),
    );
  }

  const overridesJson = await readBandOverridesJson();
  const evaluations: TableEvaluation[] = [];
  for (const covered of COVERED_TABLES) {
    const row = sizes.get(covered.table);
    if (!row) continue;
    const bandBytes = resolveBandBytes(covered.table, overridesJson);
    const dedupeKey = `table_growth:${covered.table}`;
    let decision: TableGrowthDecision;
    if (row.totalBytes > bandBytes) {
      const notify =
        dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
      try {
        const r = await notify(
          NOTIFICATION_ID,
          {
            text: buildBreachText(row, bandBytes, covered.retentionNote),
            preview: {
              table: covered.table,
              totalBytes: row.totalBytes,
              bandBytes,
            },
          },
          {
            triggerSource: "alert_service",
            // Sustained-breach dedupe lives in the dispatcher health-state
            // machinery (6h reminders while unhealthy).
            dedupeKey,
            failureType: "over_band",
            metadata: {
              table: covered.table,
              totalBytes: row.totalBytes,
              bandBytes,
              liveTuples: row.liveTuples,
              deadTuples: row.deadTuples,
            },
          },
        );
        decision = r.delivered ? "alerted" : "alert_deduped_or_skipped";
      } catch (err: any) {
        console.error(`[TableSizeWatchdog] dispatch failed for ${covered.table}: ${err?.message ?? err}`);
        decision = "alert_deduped_or_skipped";
      }
    } else if (row.totalBytes < bandBytes * REARM_FRACTION) {
      // Fully under the re-arm level → clear the dedupe gate (no-op when
      // the state is already healthy).
      const markRecovered =
        markRecoveredOverride ?? (await import("./notifications/dispatcher")).markRecovered;
      try {
        await markRecovered(NOTIFICATION_ID, dedupeKey);
      } catch {}
      decision = "ok";
    } else {
      decision = "in_hysteresis_band";
    }
    evaluations.push({ table: covered.table, totalBytes: row.totalBytes, bandBytes, decision });
  }

  const over = evaluations.filter((e) => e.decision === "alerted" || e.decision === "alert_deduped_or_skipped");
  console.log(
    `[TableSizeWatchdog] sampled ${records.length} table(s); ${over.length} over band${over.length ? ` (${over.map((e) => e.table).join(", ")})` : ""}`,
  );
  return { ran: true, sampled: records.length, evaluations };
}

// ── Admin trend summary (health dashboard "Size Trend" tab) ────────────────

export interface TableSizeTrendEntry {
  table: string;
  bandMb: number;
  rowRetention: string;
  retentionNote: string;
  latest: {
    sampledAt: number;
    totalMb: number;
    tableMb: number;
    indexMb: number;
    liveTuples: number;
    deadTuples: number;
  } | null;
  /** Change in total size across the window (null until ≥2 samples). */
  deltaMb: number | null;
  sampleCount: number;
  overBand: boolean;
}

export interface TableSizeTrendSummary {
  windowMs: number;
  enabled: boolean;
  tables: TableSizeTrendEntry[];
}

/**
 * Assemble the per-table size trend for the admin dashboard from persisted
 * `table_size_samples` rows (api-pool read via the ambient storage module —
 * this is a request-path read, not watchdog work).
 */
export async function buildTableSizeTrendSummary(
  windowMs: number = 14 * 24 * 60 * 60_000,
): Promise<TableSizeTrendSummary> {
  const { getTableSizeSamplesSince } = await import("../storage/healthMetricsStorage");
  const since = Date.now() - windowMs;
  const samples = await getTableSizeSamplesSince(since);
  const overridesJson = await readBandOverridesJson();
  const byTable = new Map<string, typeof samples>();
  for (const s of samples) {
    const list = byTable.get(s.tableName) ?? [];
    list.push(s);
    byTable.set(s.tableName, list);
  }
  const tables: TableSizeTrendEntry[] = COVERED_TABLES.map((covered) => {
    const list = byTable.get(covered.table) ?? [];
    const first = list[0];
    const last = list[list.length - 1];
    const bandBytes = resolveBandBytes(covered.table, overridesJson);
    return {
      table: covered.table,
      bandMb: bytesToMb(bandBytes),
      rowRetention: covered.rowRetention,
      retentionNote: covered.retentionNote,
      latest: last
        ? {
            sampledAt: last.sampledAt,
            totalMb: bytesToMb(last.totalBytes),
            tableMb: bytesToMb(last.tableBytes),
            indexMb: bytesToMb(last.indexBytes),
            liveTuples: last.liveTuples,
            deadTuples: last.deadTuples,
          }
        : null,
      deltaMb: first && last && first.id !== last.id ? bytesToMb(last.totalBytes - first.totalBytes) : null,
      sampleCount: list.length,
      overBand: last ? last.totalBytes > bandBytes : false,
    };
  });
  return { windowMs, enabled: await isEnabled(), tables };
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Cheap gate checks happen inside captureAndEvaluateOnce, but check the
    // setting BEFORE taking the cluster lock so a disabled watchdog costs
    // one settings read per tick, not a lock round-trip.
    if (!(await isEnabled())) return;
    await runWithWorkerDb(() =>
      withWorkerSingletonLock(
        SINGLETON_KEY,
        () => captureAndEvaluateOnce(),
        "[TableSizeWatchdog]",
        { maxHoldMs: MAX_TICK_HOLD_MS },
      ),
    );
  } catch (err: any) {
    console.warn(`[TableSizeWatchdog] tick failed: ${err?.message ?? err}`);
  } finally {
    inFlight = false;
  }
}

export function startTableSizeWatchdog(): void {
  if (tickTimer) return;
  setTimeout(() => {
    void tick();
  }, 45_000);
  tickTimer = setInterval(() => {
    void tick();
  }, SAMPLE_INTERVAL_MS);
  if (typeof (tickTimer as any).unref === "function") {
    (tickTimer as any).unref();
  }
  console.log(
    `[TableSizeWatchdog] started — sample every ${SAMPLE_INTERVAL_MS / 60_000} min over ${COVERED_TABLE_NAMES.length} covered tables, gated by ${TABLE_SIZE_WATCHDOG_ENABLED_KEY}`,
  );
}

export function stopTableSizeWatchdog(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export const __testHelpers = {
  setSizesForTests(fn: ((tables: string[]) => Map<string, TableSizeRow>) | null): void {
    sizesOverride = fn;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setMarkRecoveredForTests(fn: MarkRecoveredFn | null): void {
    markRecoveredOverride = fn;
  },
};
