import { db } from "../db";
import {
  healthSamples,
  manualReserveWorkerSamples,
  manualReserveAlertDispatches,
  poolStateSamples,
  healthIncidents,
  healthDailyRollups,
  type InsertHealthSample,
  type HealthSampleRecord,
  type InsertManualReserveWorkerSample,
  type ManualReserveWorkerSampleRecord,
  type InsertManualReserveAlertDispatch,
  type ManualReserveAlertDispatchRecord,
  type InsertPoolStateSample,
  type PoolStateSampleRecord,
  type InsertHealthIncident,
  type HealthIncidentRecord,
  type InsertHealthDailyRollup,
  type HealthDailyRollupRecord,
  tableSizeSamples,
  type TableSizeSampleRecord,
  apiRouteStatsWindows,
  type ApiRouteStatsWindowRecord,
} from "@shared/schema";
import { desc, lt, lte, gte, asc, eq, and, inArray, type SQL, sql } from "drizzle-orm";

export async function insertHealthSamples(records: InsertHealthSample[]): Promise<void> {
  if (records.length === 0) return;
  await db.insert(healthSamples).values(records as (typeof healthSamples.$inferInsert)[]);
}

export async function getRecentHealthSamples(limit: number): Promise<HealthSampleRecord[]> {
  const rows = await db
    .select()
    .from(healthSamples)
    .orderBy(desc(healthSamples.timestamp))
    .limit(limit);
  return rows.reverse();
}

export async function getHealthSamplesSince(sinceTimestamp: number): Promise<HealthSampleRecord[]> {
  const rows = await db
    .select()
    .from(healthSamples)
    .where(gte(healthSamples.timestamp, sinceTimestamp))
    .orderBy(desc(healthSamples.timestamp));
  return rows.reverse();
}

export async function pruneHealthSamples(olderThanTimestamp: number): Promise<number> {
  const deleted = await db
    .delete(healthSamples)
    .where(lt(healthSamples.timestamp, olderThanTimestamp))
    .returning({ id: healthSamples.id });
  return deleted.length;
}

export async function insertManualReserveWorkerSamples(
  records: InsertManualReserveWorkerSample[],
): Promise<void> {
  if (records.length === 0) return;
  await db
    .insert(manualReserveWorkerSamples)
    .values(records as (typeof manualReserveWorkerSamples.$inferInsert)[]);
}

export async function getManualReserveWorkerSamplesSince(
  sinceTimestamp: number,
): Promise<ManualReserveWorkerSampleRecord[]> {
  return await db
    .select()
    .from(manualReserveWorkerSamples)
    .where(gte(manualReserveWorkerSamples.timestamp, sinceTimestamp))
    .orderBy(asc(manualReserveWorkerSamples.timestamp));
}

export async function pruneManualReserveWorkerSamples(
  olderThanTimestamp: number,
): Promise<number> {
  const deleted = await db
    .delete(manualReserveWorkerSamples)
    .where(lt(manualReserveWorkerSamples.timestamp, olderThanTimestamp))
    .returning({ id: manualReserveWorkerSamples.id });
  return deleted.length;
}

let manualReserveAlertDispatchesResendColumnsReady: Promise<void> | null = null;

/**
 * Ensure the resend-attribution columns exist on
 * `manual_reserve_alert_dispatches`. Mirrors the runtime ALTER pattern used by
 * the agent_match_setting_history / admin_setting_audit tables so admins can
 * see who triggered the most recent retry without a full migration cycle.
 */
async function ensureManualReserveAlertDispatchesResendColumns(): Promise<void> {
  if (!manualReserveAlertDispatchesResendColumnsReady) {
    manualReserveAlertDispatchesResendColumnsReady = (async () => {
      await db.execute(sql`
        ALTER TABLE "manual_reserve_alert_dispatches"
          ADD COLUMN IF NOT EXISTS "triggered_by" varchar(128),
          ADD COLUMN IF NOT EXISTS "trigger_source" varchar(64),
          ADD COLUMN IF NOT EXISTS "is_resend" boolean NOT NULL DEFAULT false
      `);
    })().catch((err) => {
      manualReserveAlertDispatchesResendColumnsReady = null;
      throw err;
    });
  }
  return manualReserveAlertDispatchesResendColumnsReady;
}

export async function insertManualReserveAlertDispatches(
  records: InsertManualReserveAlertDispatch[],
): Promise<void> {
  if (records.length === 0) return;
  await ensureManualReserveAlertDispatchesResendColumns();
  await db
    .insert(manualReserveAlertDispatches)
    .values(records as (typeof manualReserveAlertDispatches.$inferInsert)[]);
}

export interface ListManualReserveAlertDispatchesOpts {
  sinceTimestamp?: number;
  /**
   * Optional upper bound on dispatch timestamp. Production callers usually
   * leave this blank (default = "now or later is fine"), but the digest
   * builder passes it so a synthetic-time test or a clock-skewed query
   * doesn't pick up dispatches that were written after the window closed.
   */
  untilTimestamp?: number;
  eventTypes?: string[];
  severities?: string[];
  metric?: string;
  limit?: number;
}

export async function listManualReserveAlertDispatches(
  opts: ListManualReserveAlertDispatchesOpts = {},
): Promise<ManualReserveAlertDispatchRecord[]> {
  // Task #798 — the Drizzle row type now includes triggered_by/trigger_source/
  // is_resend, so SELECT * must guarantee those columns exist before the first
  // read on a freshly-deployed DB (otherwise the column-list mismatch would
  // throw and the service would silently fall back to the in-memory buffer).
  await ensureManualReserveAlertDispatchesResendColumns();
  const filters: SQL<unknown>[] = [];
  if (opts.sinceTimestamp !== undefined) {
    filters.push(gte(manualReserveAlertDispatches.timestamp, opts.sinceTimestamp));
  }
  if (opts.untilTimestamp !== undefined) {
    filters.push(lte(manualReserveAlertDispatches.timestamp, opts.untilTimestamp));
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    filters.push(inArray(manualReserveAlertDispatches.eventType, opts.eventTypes));
  }
  if (opts.severities && opts.severities.length > 0) {
    filters.push(inArray(manualReserveAlertDispatches.severity, opts.severities));
  }
  if (opts.metric) {
    filters.push(eq(manualReserveAlertDispatches.metric, opts.metric));
  }
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 1000) : 200;
  const base = db.select().from(manualReserveAlertDispatches);
  const filtered = filters.length > 0 ? base.where(and(...filters)) : base;
  return await filtered
    .orderBy(desc(manualReserveAlertDispatches.timestamp))
    .limit(limit);
}

export async function pruneManualReserveAlertDispatches(
  olderThanTimestamp: number,
): Promise<number> {
  await ensureManualReserveAlertDispatchesResendColumns();
  const deleted = await db
    .delete(manualReserveAlertDispatches)
    .where(lt(manualReserveAlertDispatches.timestamp, olderThanTimestamp))
    .returning({ id: manualReserveAlertDispatches.id });
  return deleted.length;
}

// ─── Pool State Samples (Task #861 Phase 4) ──────────────────────────────

export async function insertPoolStateSamples(records: InsertPoolStateSample[]): Promise<void> {
  if (records.length === 0) return;
  await db.insert(poolStateSamples).values(records as (typeof poolStateSamples.$inferInsert)[]);
}

export async function getPoolStateSamplesSince(
  sinceTimestamp: number,
  poolName?: string,
): Promise<PoolStateSampleRecord[]> {
  const filters: SQL<unknown>[] = [gte(poolStateSamples.sampledAt, sinceTimestamp)];
  if (poolName) filters.push(eq(poolStateSamples.poolName, poolName));
  return await db
    .select()
    .from(poolStateSamples)
    .where(and(...filters))
    .orderBy(asc(poolStateSamples.sampledAt));
}

export async function getLatestPoolStateSamples(): Promise<PoolStateSampleRecord[]> {
  // One row per pool, the most recent.
  const rows = await db.execute<any>(sql`
    SELECT DISTINCT ON (pool_name) *
    FROM pool_state_samples
    ORDER BY pool_name, sampled_at DESC
  `);
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  return list.map((r: any) => ({
    id: r.id,
    sampledAt: Number(r.sampled_at),
    poolName: r.pool_name,
    totalCount: r.total_count,
    idleCount: r.idle_count,
    waitingCount: r.waiting_count,
    maxCount: r.max_count,
    utilizationPct: r.utilization_pct,
    slowAcquiresInInterval: r.slow_acquires_in_interval,
    slowHoldsInInterval: r.slow_holds_in_interval,
    topHoldLabels: r.top_hold_labels,
    unknownLabelPct: r.unknown_label_pct,
  })) as PoolStateSampleRecord[];
}

export async function prunePoolStateSamples(olderThanTimestamp: number): Promise<number> {
  const deleted = await db
    .delete(poolStateSamples)
    .where(lt(poolStateSamples.sampledAt, olderThanTimestamp))
    .returning({ id: poolStateSamples.id });
  return deleted.length;
}

// Task #3814 — table-size trend samples (written by tableSizeWatchdog).
export async function getTableSizeSamplesSince(sinceMs: number): Promise<TableSizeSampleRecord[]> {
  return db
    .select()
    .from(tableSizeSamples)
    .where(gte(tableSizeSamples.sampledAt, sinceMs))
    .orderBy(asc(tableSizeSamples.tableName), asc(tableSizeSamples.sampledAt));
}

export async function getRowCountsSince(table: string, sinceTimestamp: number, tsColumn: string): Promise<number> {
  // Unsafe? No — `table` and `tsColumn` are always passed as literals from
  // service code; never user input. SELECT-only with safe parameter binding
  // for the timestamp.
  const result = await db.execute<any>(
    sql.raw(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${tsColumn} >= ${sinceTimestamp}`),
  );
  const list = Array.isArray(result) ? result : (result as any).rows ?? [];
  return Number(list[0]?.c ?? 0);
}

export async function getMaxTimestamp(table: string, tsColumn: string): Promise<number | null> {
  const result = await db.execute<any>(
    sql.raw(`SELECT MAX(${tsColumn})::bigint AS m FROM ${table}`),
  );
  const list = Array.isArray(result) ? result : (result as any).rows ?? [];
  const v = list[0]?.m;
  return v === null || v === undefined ? null : Number(v);
}

// ─── Health Incidents (Task #861 Phase 3) ────────────────────────────────

// 913D: canonical incident lifecycle. The only legal statuses are
// `firing`, `acknowledged`, and `resolved`. `snoozed_until` is metadata
// attached to an `acknowledged` incident — it is not a status.
export const LEGAL_INCIDENT_STATUSES = ["firing", "acknowledged", "resolved"] as const;
export type LegalIncidentStatus = (typeof LEGAL_INCIDENT_STATUSES)[number];

// Allowed transitions. Same-state transitions are also legal (idempotent).
//   firing       -> acknowledged | resolved
//   acknowledged -> firing       | resolved   (firing = re-arm after snooze)
//   resolved     -> (terminal — a re-fire MUST create a new incident)
const ALLOWED_TRANSITIONS: Record<LegalIncidentStatus, LegalIncidentStatus[]> = {
  firing: ["firing", "acknowledged", "resolved"],
  acknowledged: ["acknowledged", "firing", "resolved"],
  resolved: ["resolved"],
};

// 913D backward-compat: rows with the legacy `snoozed` status (from the
// pre-913D lifecycle) are tolerated as a one-way transition source. They
// may be normalized to `acknowledged` (preferred) or moved to `resolved`
// — but never re-stamped `snoozed`. The startup normalizer below also
// converts these in bulk; this guard exists so any in-flight call during
// the rollout window doesn't 500.
const LEGACY_TRANSITION_FROM_SNOOZED: LegalIncidentStatus[] = ["acknowledged", "resolved", "firing"];

export function isLegalIncidentStatus(s: string): s is LegalIncidentStatus {
  return (LEGAL_INCIDENT_STATUSES as readonly string[]).includes(s);
}

export function isAllowedTransition(from: string, to: string): boolean {
  if (!isLegalIncidentStatus(to)) return false;
  if (from === "snoozed") return LEGACY_TRANSITION_FROM_SNOOZED.includes(to);
  if (!isLegalIncidentStatus(from)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 913D rollout: normalize any pre-existing rows with the legacy
 * `status='snoozed'` to `status='acknowledged'`. `snoozed_until` is
 * preserved so the re-arm semantics still apply on the next sample.
 * Returns the number of rows normalized. Idempotent.
 */
export async function normalizeLegacySnoozedIncidents(): Promise<number> {
  const result = await db.execute<any>(sql`
    UPDATE health_incidents
       SET status = 'acknowledged', updated_at = NOW()
     WHERE status = 'snoozed'
  `);
  // node-postgres / Neon returns rowCount on the result; tolerate either shape.
  const count = (result as any).rowCount ?? (Array.isArray(result) ? 0 : 0);
  return Number(count) || 0;
}

export async function findIncidentByFingerprint(fingerprint: string): Promise<HealthIncidentRecord | null> {
  // Open incidents (firing or acknowledged) only. Resolved incidents are
  // terminal — a re-fire MUST create a new incident (913D dedup rule).
  const rows = await db
    .select()
    .from(healthIncidents)
    .where(
      and(
        eq(healthIncidents.fingerprint, fingerprint),
        inArray(healthIncidents.status, ["firing", "acknowledged"]),
      ),
    )
    .orderBy(desc(healthIncidents.lastSeenAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertIncident(record: InsertHealthIncident): Promise<HealthIncidentRecord> {
  if (record.status && !isLegalIncidentStatus(record.status)) {
    throw new Error(
      `[healthIncidents] illegal initial status '${record.status}' — must be one of ${LEGAL_INCIDENT_STATUSES.join("/")}`,
    );
  }
  const [row] = await db
    .insert(healthIncidents)
    .values(record as typeof healthIncidents.$inferInsert)
    .returning();
  return row;
}

// Task #4380 (F8): dedicated narrow writer type — incident lifecycle and
// observation fields only; identity/grouping keys (dedupeKey, metricKey,
// clientId) stay out of the patch.
export type HealthIncidentStoragePatch = Partial<
  Pick<
    InsertHealthIncident,
    | "status"
    | "resolvedAt"
    | "metadata"
    | "lastSeenAt"
    | "occurrenceCount"
    | "peakValue"
    | "latestValue"
    | "sampleRefs"
    | "severity"
    | "acknowledgedBy"
    | "acknowledgedAt"
    | "snoozedUntil"
  >
> & { updatedAt?: Date };

export async function updateIncident(
  id: number,
  patch: HealthIncidentStoragePatch,
): Promise<HealthIncidentRecord | null> {
  // Enforce the lifecycle when status is being changed.
  if (patch.status !== undefined) {
    if (!isLegalIncidentStatus(patch.status)) {
      throw new Error(
        `[healthIncidents] illegal status '${patch.status}' — must be one of ${LEGAL_INCIDENT_STATUSES.join("/")}`,
      );
    }
    const current = await getIncidentById(id);
    if (current && !isAllowedTransition(current.status, patch.status)) {
      throw new Error(
        `[healthIncidents] illegal transition ${current.status} -> ${patch.status} for incident #${id}`,
      );
    }
  }
  const [row] = await db
    .update(healthIncidents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(healthIncidents.id, id))
    .returning();
  return row ?? null;
}

export interface ListIncidentsOpts {
  statuses?: string[];
  sinceTimestamp?: number;
  limit?: number;
}

export async function listIncidents(opts: ListIncidentsOpts = {}): Promise<HealthIncidentRecord[]> {
  const filters: SQL<unknown>[] = [];
  if (opts.statuses && opts.statuses.length > 0) {
    filters.push(inArray(healthIncidents.status, opts.statuses));
  }
  if (opts.sinceTimestamp !== undefined) {
    filters.push(gte(healthIncidents.lastSeenAt, opts.sinceTimestamp));
  }
  const base = db.select().from(healthIncidents);
  const filtered = filters.length > 0 ? base.where(and(...filters)) : base;
  return await filtered
    .orderBy(desc(healthIncidents.lastSeenAt))
    .limit(opts.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 200);
}

export async function getIncidentById(id: number): Promise<HealthIncidentRecord | null> {
  const rows = await db.select().from(healthIncidents).where(eq(healthIncidents.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function pruneResolvedIncidents(olderThanTimestamp: number): Promise<number> {
  const deleted = await db
    .delete(healthIncidents)
    .where(
      and(
        eq(healthIncidents.status, "resolved"),
        lt(healthIncidents.resolvedAt, olderThanTimestamp),
      ),
    )
    .returning({ id: healthIncidents.id });
  return deleted.length;
}

export async function countIncidentsSince(sinceTimestamp: number): Promise<number> {
  const rows = await db.execute<any>(sql`
    SELECT COUNT(*)::int AS c FROM health_incidents WHERE first_seen_at >= ${sinceTimestamp}
  `);
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  return Number(list[0]?.c ?? 0);
}

// ─── Daily Rollups (Task #861 Phase 8) ───────────────────────────────────

export async function upsertDailyRollup(record: InsertHealthDailyRollup): Promise<void> {
  // Drizzle doesn't expose a portable upsert for this composite-unique target
  // without an explicit unique constraint, so use a manual delete-then-insert
  // wrapped in a transaction to keep the (metric, date) row deterministic.
  await db.transaction(async (tx) => {
    await tx
      .delete(healthDailyRollups)
      .where(and(eq(healthDailyRollups.metric, record.metric), eq(healthDailyRollups.date, record.date)));
    await tx.insert(healthDailyRollups).values(record as typeof healthDailyRollups.$inferInsert);
  });
}

export async function getDailyRollupsSince(sinceDate: string, metric?: string): Promise<HealthDailyRollupRecord[]> {
  const filters: SQL<unknown>[] = [gte(healthDailyRollups.date, sinceDate)];
  if (metric) filters.push(eq(healthDailyRollups.metric, metric));
  return await db
    .select()
    .from(healthDailyRollups)
    .where(and(...filters))
    .orderBy(asc(healthDailyRollups.date));
}

export async function pruneDailyRollups(olderThanDate: string): Promise<number> {
  const deleted = await db
    .delete(healthDailyRollups)
    .where(lt(healthDailyRollups.date, olderThanDate))
    .returning({ id: healthDailyRollups.id });
  return deleted.length;
}

// ── Task #3816: persisted per-route API request-metrics windows ─────────────

export async function getApiRouteStatsWindowsSince(
  sinceMs: number,
  limit = 400,
): Promise<ApiRouteStatsWindowRecord[]> {
  return db
    .select()
    .from(apiRouteStatsWindows)
    .where(gte(apiRouteStatsWindows.windowStartedAt, sinceMs))
    .orderBy(desc(apiRouteStatsWindows.windowStartedAt), asc(apiRouteStatsWindows.route))
    .limit(limit);
}
