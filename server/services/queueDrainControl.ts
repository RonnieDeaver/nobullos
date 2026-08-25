/**
 * Task #987: per-queue drain control. Operators can pause a single
 * queue (e.g. `retroactive_reprocess` when its 2,200-job backlog is
 * pinning the worker pool) without taking the whole workload class
 * down via a kill switch, and can cap the dispatch rate so a backlog
 * is worked off slowly without spiking pool pressure.
 *
 * State is persisted in `system_settings` under `queue_drain_state` as
 * a single JSON document so we get atomic snapshot reads/writes and
 * one row in the audit history per change.
 *
 * Hot-path read API is synchronous (`isQueuePaused`, `canDispatchQueueNow`)
 * so the scheduler can call it on every dequeue cycle without paying a
 * DB round-trip; the very first read kicks off an async load and
 * subsequent reads see the persisted state.
 */
// @db-pool-intent: worker
//
// Task #1878 — `getQueuePendingCount`, `getDrainStateSnapshot`, and
// `cancelPendingJobs` route through `getDb()` (wrapped in
// `runWithWorkerDb`) so the test-only schema sandbox in
// `tests/db-sandbox.ts` can isolate the `work_queue` rows the
// CEO-action / queue-drain code paths touch. In production the
// explicit `runWithWorkerDb` wrap pins the work to the worker pool,
// matching the pre-existing tenancy (these are background-only
// helpers; no API request should burn an `api` pool slot on them).
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { workQueue } from "@shared/schema";
import { storage } from "../storage";
import { and, eq, sql } from "drizzle-orm";
import { workerLog } from "./workerLogger";

const SETTING_KEY = "queue_drain_state";

/**
 * Task #997: drain action history is recorded into the existing
 * `admin_setting_audit` table (the same audit store used for
 * rate-limit thresholds, kill switches, etc) under a dedicated
 * setting key — one row per pause/resume/rate-limit/cancel action,
 * with `scope = queueName` so we can filter by queue cheaply.
 */
const HISTORY_SETTING_KEY = "queue_drain_action";

export const QUEUE_DRAIN_HISTORY_ACTIONS = [
  "queue_paused",
  "queue_resumed",
  "queue_rate_limit_set",
  "queue_pending_cancelled",
] as const;
export type QueueDrainHistoryAction =
  (typeof QUEUE_DRAIN_HISTORY_ACTIONS)[number];

export function isQueueDrainHistoryAction(
  v: string,
): v is QueueDrainHistoryAction {
  return (QUEUE_DRAIN_HISTORY_ACTIONS as readonly string[]).includes(v);
}

export interface QueueDrainPauseDetails {
  paused: { before: boolean; after: boolean };
  pausedAtBacklog?: number;
}
export interface QueueDrainRateLimitDetails {
  ratePerMinute: { before: number | null; after: number | null };
}
export interface QueueDrainCancelDetails {
  cancelled: number;
  limit: number;
}
export type QueueDrainHistoryDetails =
  | QueueDrainPauseDetails
  | QueueDrainRateLimitDetails
  | QueueDrainCancelDetails;

export interface QueueDrainHistoryEntry {
  id: string;
  queueName: string;
  action: QueueDrainHistoryAction;
  actor: string | null;
  at: string;
  details: QueueDrainHistoryDetails;
}

export interface QueueDrainState {
  paused: boolean;
  ratePerMinute: number | null;
  updatedAt: string;
  updatedBy: string | null;
  /**
   * Task #998: ISO timestamp when the queue was most recently transitioned
   * into the paused state (null when not paused). Used by the
   * `queueDrainBacklogAlerts` watcher to compute "paused for X hours".
   */
  pausedAt: string | null;
  /**
   * Task #998: pending-job count captured at the moment the queue was
   * paused. Lets the watcher report "backlog grew by N since pause" and
   * compare against the configurable growth threshold.
   */
  pausedAtBacklog: number | null;
  /**
   * Task #1784: free-form operator-visible note explaining *why* the
   * queue is paused (e.g. "Pool epic — cadence rewrite pending"). Set
   * on a not-paused → paused transition; cleared on resume. Rendered
   * in the Queue Drain Control admin card and included in the
   * `admin_setting_audit` history row for the pause action.
   */
  pauseNote: string | null;
}

interface DrainStateMap {
  [queueName: string]: QueueDrainState;
}

const state: DrainStateMap = {};
let loaded = false;
let loadingPromise: Promise<void> | null = null;

const dispatchTimestamps = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;

async function loadState(): Promise<void> {
  if (loaded) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const row = await storage.getSystemSetting(SETTING_KEY);
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value) as DrainStateMap;
          for (const k of Object.keys(state)) delete state[k];
          for (const [name, entry] of Object.entries(parsed)) {
            if (entry && typeof entry === "object") {
              const e = entry as Partial<QueueDrainState>;
              state[name] = {
                paused: !!e.paused,
                ratePerMinute:
                  typeof e.ratePerMinute === "number" && e.ratePerMinute > 0
                    ? e.ratePerMinute
                    : null,
                updatedAt: e.updatedAt ?? new Date().toISOString(),
                updatedBy: e.updatedBy ?? null,
                pausedAt:
                  typeof e.pausedAt === "string" && e.pausedAt
                    ? e.pausedAt
                    : null,
                pausedAtBacklog:
                  typeof e.pausedAtBacklog === "number" &&
                  Number.isFinite(e.pausedAtBacklog)
                    ? e.pausedAtBacklog
                    : null,
                pauseNote:
                  typeof e.pauseNote === "string" && e.pauseNote
                    ? e.pauseNote
                    : null,
              };
            }
          }
        } catch (err: any) {
          console.warn(`[QueueDrain] Failed to parse persisted state: ${err?.message}`);
        }
      }
      loaded = true;
    } catch (err: any) {
      console.warn(`[QueueDrain] Failed to load state: ${err?.message}`);
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

export async function ensureQueueDrainStateLoaded(): Promise<void> {
  if (loaded) return;
  await loadState();
}

async function persistState(): Promise<void> {
  await storage.setSystemSetting(SETTING_KEY, JSON.stringify(state), "system");
}

// ── Task #997: audit-backed drain action history. ──
//
// `recordDrainAction` writes one row to `admin_setting_audit` per
// pause/resume/rate-limit/cancel action. Failures are swallowed (with
// a warning) so audit-write problems can never block the actual drain
// action — the worker log already records every transition.
async function recordDrainAction(params: {
  queueName: string;
  action: QueueDrainHistoryAction;
  actor: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown>;
}): Promise<void> {
  try {
    await storage.recordAdminSettingChange({
      settingKey: HISTORY_SETTING_KEY,
      scope: params.queueName,
      // `recordAdminSettingChange` callers across the codebase pass `null`
      // for system-initiated changes (the FK only accepts real user ids),
      // so we mirror that convention.
      changedBy: params.actor && params.actor !== "system" ? params.actor : null,
      oldValues: params.oldValues,
      newValues: { action: params.action, ...params.newValues },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[QueueDrain] Failed to record drain action: ${msg}`);
  }
}

export interface ListQueueDrainHistoryOpts {
  queueName?: string;
  action?: QueueDrainHistoryAction;
  limit?: number;
}

/**
 * Maximum number of audit rows the route + storage layer agree to return
 * in a single call (mirrors the `Math.min(..., 100)` clamp inside
 * `listAdminSettingAudit`).
 */
export const QUEUE_DRAIN_HISTORY_MAX_LIMIT = 100;

/**
 * Safety cap on how many audit rows we'll scan in total when filtering
 * by action — `admin_setting_audit` doesn't have a `new_values->>action`
 * index, so we page through (`changedBefore` cursor) until we either
 * collect `limit` matches or hit this scan cap. Five pages of the
 * storage-layer max (5 × 100) is plenty for a UI showing the last 100
 * matching entries.
 */
const QUEUE_DRAIN_HISTORY_MAX_SCAN = 500;

/**
 * Read drain action history from `admin_setting_audit`. When an `action`
 * filter is set we page through the audit rows (newest first, using
 * `changedBefore` as a cursor) so the caller still gets the most recent
 * `limit` matches even when non-matching events dominate the head of the
 * stream — capped by `QUEUE_DRAIN_HISTORY_MAX_SCAN` to keep latency bounded.
 */
export async function listQueueDrainHistory(
  opts: ListQueueDrainHistoryOpts = {},
): Promise<QueueDrainHistoryEntry[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, QUEUE_DRAIN_HISTORY_MAX_LIMIT));
  const out: QueueDrainHistoryEntry[] = [];
  const seenIds = new Set<string>();
  let cursor: Date | undefined;
  let scanned = 0;

  while (out.length < limit && scanned < QUEUE_DRAIN_HISTORY_MAX_SCAN) {
    const pageSize = Math.min(
      QUEUE_DRAIN_HISTORY_MAX_LIMIT,
      QUEUE_DRAIN_HISTORY_MAX_SCAN - scanned,
    );
    const rows = await storage.listAdminSettingAudit({
      settingKey: HISTORY_SETTING_KEY,
      scope: opts.queueName,
      changedBefore: cursor,
      limit: pageSize,
    });
    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      const newValues = row.newValues;
      if (!newValues || typeof newValues !== "object") continue;
      const newObj = newValues as Record<string, unknown>;
      const actionRaw = typeof newObj.action === "string" ? newObj.action : "";
      if (!isQueueDrainHistoryAction(actionRaw)) continue;
      if (opts.action && actionRaw !== opts.action) continue;
      const { action: _ignored, ...rest } = newObj;
      void _ignored;
      const details = coerceHistoryDetails(actionRaw, rest);
      if (!details) continue;
      const at =
        row.changedAt instanceof Date
          ? row.changedAt.toISOString()
          : String(row.changedAt);
      out.push({
        id: row.id,
        queueName: row.scope ?? "",
        action: actionRaw,
        actor: row.changedBy ?? null,
        at,
        details,
      });
      if (out.length >= limit) break;
    }

    // No more pages possible: short-circuit when storage gave us fewer
    // than we asked for, or when we're not filtering (single page is
    // enough for the unfiltered case).
    if (rows.length < pageSize) break;
    if (!opts.action) break;
    const lastChangedAt = rows[rows.length - 1]?.changedAt;
    if (!(lastChangedAt instanceof Date)) break;
    // Use the boundary timestamp directly — `changedBefore` is inclusive
    // (`<=`), and the `seenIds` dedup above skips the boundary row on the
    // next page. This is critical when many rows share the same
    // millisecond (tight insert loops); stepping the cursor back by 1 ms
    // would silently skip them.
    if (cursor && cursor.getTime() === lastChangedAt.getTime()) {
      // Defensive: every row in this page shared a timestamp with the
      // previous page's boundary. Without a tiebreaker column on the
      // storage helper we can't make further progress here — bail.
      break;
    }
    cursor = lastChangedAt;
  }

  return out;
}

function coerceHistoryDetails(
  action: QueueDrainHistoryAction,
  raw: Record<string, unknown>,
): QueueDrainHistoryDetails | null {
  if (action === "queue_paused" || action === "queue_resumed") {
    const paused = raw.paused as
      | { before?: unknown; after?: unknown }
      | undefined;
    if (
      !paused ||
      typeof paused.before !== "boolean" ||
      typeof paused.after !== "boolean"
    ) {
      return null;
    }
    const out: QueueDrainPauseDetails = {
      paused: { before: paused.before, after: paused.after },
    };
    if (typeof raw.pausedAtBacklog === "number") {
      out.pausedAtBacklog = raw.pausedAtBacklog;
    }
    return out;
  }
  if (action === "queue_rate_limit_set") {
    const rate = raw.ratePerMinute as
      | { before?: unknown; after?: unknown }
      | undefined;
    if (!rate) return null;
    const before =
      rate.before === null || typeof rate.before === "number"
        ? (rate.before as number | null)
        : null;
    const after =
      rate.after === null || typeof rate.after === "number"
        ? (rate.after as number | null)
        : null;
    return { ratePerMinute: { before, after } };
  }
  // queue_pending_cancelled
  const cancelled = typeof raw.cancelled === "number" ? raw.cancelled : 0;
  const limit = typeof raw.limit === "number" ? raw.limit : 0;
  return { cancelled, limit };
}

/**
 * Synchronous hot-path check. The first call kicks off an async load
 * and returns false (not paused); subsequent calls see persisted
 * state. The scheduler bootstraps `ensureQueueDrainStateLoaded()`
 * before its first cycle so the cold-cache window is sub-second.
 */
export function isQueuePaused(queueName: string): boolean {
  if (!loaded && !loadingPromise) {
    void loadState();
  }
  return state[queueName]?.paused === true;
}

/**
 * Returns true if the per-minute rate limit (if any) for this queue
 * has not been exceeded in the current rolling 60s window. Always
 * returns true when no rate limit is configured.
 */
export function canDispatchQueueNow(queueName: string): boolean {
  if (!loaded && !loadingPromise) {
    void loadState();
  }
  const cfg = state[queueName];
  if (!cfg || !cfg.ratePerMinute || cfg.ratePerMinute <= 0) return true;
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  let stamps = dispatchTimestamps.get(queueName) ?? [];
  // Drop entries outside the rolling window.
  stamps = stamps.filter((ts) => ts > cutoff);
  dispatchTimestamps.set(queueName, stamps);
  return stamps.length < cfg.ratePerMinute;
}

/**
 * Record a dispatch for rate-limit accounting. Must be called whenever
 * the scheduler successfully claims a job for a queue that has a rate
 * limit configured (calling on every job is fine — the function is a
 * no-op when no limit is set).
 */
export function recordQueueDispatch(queueName: string): void {
  const cfg = state[queueName];
  if (!cfg || !cfg.ratePerMinute || cfg.ratePerMinute <= 0) return;
  const stamps = dispatchTimestamps.get(queueName) ?? [];
  stamps.push(Date.now());
  dispatchTimestamps.set(queueName, stamps);
}

export interface SetQueuePauseOptions {
  /**
   * Task #1784: optional free-form note explaining *why* the queue is
   * being paused. Stored alongside the pause flag and surfaced in the
   * Queue Drain Control admin card + audit history. Ignored on resume
   * (cleared along with `pausedAt` / `pausedAtBacklog`).
   */
  note?: string | null;
}

export async function setQueuePause(
  queueName: string,
  paused: boolean,
  actor: string | null,
  options: SetQueuePauseOptions = {},
): Promise<QueueDrainState> {
  await ensureQueueDrainStateLoaded();
  const existing: QueueDrainState = state[queueName] ?? {
    paused: false,
    ratePerMinute: null,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    pausedAt: null,
    pausedAtBacklog: null,
    pauseNote: null,
  };

  // Task #998: capture pause-time metadata so the backlog-growth watcher
  // can compute "paused for X hours" and "grew by N since pause". We only
  // refresh these on a real not-paused → paused transition; toggling pause
  // a second time while already paused must not reset the baseline (that
  // would silently mask a growing backlog).
  let pausedAt = existing.pausedAt;
  let pausedAtBacklog = existing.pausedAtBacklog;
  if (paused && !existing.paused) {
    pausedAt = new Date().toISOString();
    try {
      pausedAtBacklog = await getQueuePendingCount(queueName);
    } catch (err: any) {
      console.warn(
        `[QueueDrain] Failed to capture pause-time backlog for ${queueName}: ${err?.message}`,
      );
      pausedAtBacklog = null;
    }
  } else if (!paused) {
    pausedAt = null;
    pausedAtBacklog = null;
  }

  // Task #1784: persist optional pause note on a real pause transition;
  // ignore it on resume so the cleared state stays clean.
  let pauseNote = existing.pauseNote;
  if (paused) {
    if (options.note !== undefined) {
      const trimmed =
        typeof options.note === "string" ? options.note.trim() : "";
      pauseNote = trimmed.length > 0 ? trimmed.slice(0, 500) : null;
    }
  } else {
    pauseNote = null;
  }

  const before = {
    paused: existing.paused,
    pauseNote: existing.pauseNote,
  };
  state[queueName] = {
    ...existing,
    paused,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
    pausedAt,
    pausedAtBacklog,
    pauseNote,
  };
  await persistState();
  workerLog({
    worker: queueName,
    event: paused ? "queue_paused" : "queue_resumed",
    workloadClass: "maintenance",
    actor: actor ?? "unknown",
  });
  // Task #997: only record an entry when the paused flag actually changed
  // so toggling pause-while-paused doesn't spam the history.
  if (before.paused !== paused) {
    const newValues: Record<string, unknown> = {
      paused: { before: before.paused, after: paused },
    };
    if (paused && pausedAtBacklog != null) {
      newValues.pausedAtBacklog = pausedAtBacklog;
    }
    if (paused && pauseNote) {
      newValues.pauseNote = pauseNote;
    }
    await recordDrainAction({
      queueName,
      action: paused ? "queue_paused" : "queue_resumed",
      actor,
      oldValues: { paused: before.paused, pauseNote: before.pauseNote },
      newValues,
    });
  }
  return state[queueName];
}

/**
 * Task #998: pending-job count for a single queue. Used by `setQueuePause`
 * to capture the baseline backlog at pause time and by the backlog-growth
 * watcher to read the current count on each tick.
 */
export async function getQueuePendingCount(queueName: string): Promise<number> {
  return runWithWorkerDb(() =>
    withDbAttribution("queueDrainControl:getQueuePendingCount", async () => {
      const result = await getDb().execute<{ cnt: number }>(sql`
        SELECT COUNT(*)::int AS cnt
        FROM work_queue
        WHERE status = 'pending' AND queue_name = ${queueName}
      `);
      const row = result.rows[0] as { cnt: number } | undefined;
      return row ? Number(row.cnt) : 0;
    }),
  );
}

export async function setQueueRateLimit(
  queueName: string,
  ratePerMinute: number | null,
  actor: string | null,
): Promise<QueueDrainState> {
  if (ratePerMinute !== null && (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0)) {
    throw new Error("ratePerMinute must be a positive number or null");
  }
  await ensureQueueDrainStateLoaded();
  const existing: QueueDrainState = state[queueName] ?? {
    paused: false,
    ratePerMinute: null,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    pausedAt: null,
    pausedAtBacklog: null,
    pauseNote: null,
  };
  const beforeRate = existing.ratePerMinute;
  state[queueName] = {
    ...existing,
    ratePerMinute,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  // Reset the rolling window so the new limit takes effect cleanly.
  dispatchTimestamps.delete(queueName);
  await persistState();
  workerLog({
    worker: queueName,
    event: "queue_rate_limit_set",
    workloadClass: "maintenance",
    ratePerMinute: ratePerMinute ?? 0,
    actor: actor ?? "unknown",
  });
  if (beforeRate !== ratePerMinute) {
    await recordDrainAction({
      queueName,
      action: "queue_rate_limit_set",
      actor,
      oldValues: { ratePerMinute: beforeRate },
      newValues: {
        ratePerMinute: { before: beforeRate, after: ratePerMinute },
      },
    });
  }
  return state[queueName];
}

export interface QueueDrainSnapshotEntry extends QueueDrainState {
  queueName: string;
  pendingJobs: number;
  recentDispatches: number;
}

export async function getDrainStateSnapshot(): Promise<QueueDrainSnapshotEntry[]> {
  await ensureQueueDrainStateLoaded();
  const queueNames = Object.keys(state).sort();
  const out: QueueDrainSnapshotEntry[] = [];
  if (queueNames.length === 0) return out;

  const counts = await runWithWorkerDb(() =>
    withDbAttribution("queueDrainControl:getDrainStateSnapshot", () =>
      getDb().execute<{ queue_name: string; cnt: number }>(sql`
    SELECT queue_name, COUNT(*)::int AS cnt
    FROM work_queue
    WHERE status = 'pending'
      AND queue_name IN (${sql.join(queueNames.map((n) => sql`${n}`), sql`, `)})
    GROUP BY queue_name
  `)),
  );
  const byName = new Map<string, number>();
  for (const r of counts.rows as Array<{ queue_name: string; cnt: number }>) {
    byName.set(r.queue_name, Number(r.cnt));
  }
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const name of queueNames) {
    const cfg = state[name]!;
    const stamps = (dispatchTimestamps.get(name) ?? []).filter((t) => t > cutoff);
    out.push({
      queueName: name,
      ...cfg,
      pendingJobs: byName.get(name) ?? 0,
      recentDispatches: stamps.length,
    });
  }
  return out;
}

/**
 * Bulk-cancel up to `limit` pending jobs in this queue. Returns the
 * number of jobs cancelled. Does not touch jobs that are already
 * leased, processing, completed, failed, or dead-lettered.
 */
export async function cancelPendingJobs(
  queueName: string,
  limit: number,
  actor: string | null,
): Promise<{ cancelled: number }> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  const result = await runWithWorkerDb(() =>
    withDbAttribution("queueDrainControl:cancelPendingJobs", () =>
      getDb().execute<{ id: string }>(sql`
        UPDATE work_queue
        SET
          status = 'cancelled',
          error_message = ${"cancelled_by_drain_control:" + (actor ?? "system")},
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id IN (
          SELECT id FROM work_queue
          WHERE queue_name = ${queueName}
            AND status = 'pending'
          ORDER BY priority ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING id
      `)),
  );
  const cancelled = result.rows.length;
  workerLog({
    worker: queueName,
    event: "queue_pending_cancelled",
    workloadClass: "maintenance",
    cancelled,
    actor: actor ?? "unknown",
  });
  // Task #997: record cancel actions even when zero rows matched so
  // operators can see the attempt (e.g. someone hammered the button on
  // an already-drained queue).
  await recordDrainAction({
    queueName,
    action: "queue_pending_cancelled",
    actor,
    oldValues: null,
    newValues: { cancelled, limit },
  });
  return { cancelled };
}

/**
 * Test/diagnostic helper. Resets all in-memory state without touching
 * the persisted row. Used by the work-queue scheduler tests so each
 * scenario starts from a clean slate.
 */
export function _resetQueueDrainStateForTests(): void {
  for (const k of Object.keys(state)) delete state[k];
  dispatchTimestamps.clear();
  loaded = false;
}

// Suppress unused-import warnings — `workQueue`/`and`/`eq` are kept for
// future use (e.g. cancelling by id range) but the current API only
// needs `sql`.
void workQueue;
void and;
void eq;
