import type { WorkloadClass } from "@shared/schema";
import { workerLog } from "./workerLogger";
import { PERF } from "../perfConfig";
import { isApiPoolUnderPressure } from "../db";
import { isKillSwitchEnabled } from "./killSwitches";

// Task #1816 — live-tunable ingestion class concurrency cap.
// Read from `system_settings.workload_class_ingestion_max_concurrency`
// at scheduler startup AND mutated in-memory by the
// `ramp_ingestion_class_concurrency_*` CEO actions so a bump takes
// effect immediately without a redeploy. Bounded [1, 10] to keep an
// operator press from accidentally starving the worker pool.
export const INGESTION_CLASS_CONCURRENCY_SETTING_KEY =
  "workload_class_ingestion_max_concurrency";
export const INGESTION_CLASS_CONCURRENCY_MIN = 1;
export const INGESTION_CLASS_CONCURRENCY_MAX = 10;
export const INGESTION_CLASS_CONCURRENCY_DEFAULT = 3;

interface ClassBudget {
  maxConcurrency: number;
  activeCount: number;
  activeWorkers: string[];
}

interface SlotHoldRecord {
  worker: string;
  workloadClass: WorkloadClass;
  acquiredAt: number;
  releasedAt?: number;
  durationMs?: number;
}

const slotHoldHistory: SlotHoldRecord[] = [];
const activeSlotHolds = new Map<string, SlotHoldRecord>();
const MAX_HOLD_HISTORY = 100;
let slotHoldSeq = 0;

function slotHoldKey(worker: string): string {
  return `${worker}:${++slotHoldSeq}`;
}

const workerToHoldKey = new Map<string, string[]>();

// Task #836 Phase 2: explicit per-workload-class concurrency caps. Held
// at the same defaults as before for `interactive`/`ingestion` because
// those represent user-facing or short-lived ingestion work — but
// repair/maintenance are now hard-capped at 1 active job each. The
// originally named offender (`retroactive_reprocess` → repair) cannot
// run in parallel with itself under this budget.
// `front_sync_reprocess` (mapped to
// `interactive_repair`) shares its 1 slot with other repair-tagged
// flows and is required to back off via `backoffForApiPoolPressure`
// before each batch.
// Task #1025: lift the `repair` and `interactive_repair` class caps to
// `RETROACTIVE_REPROCESS_CONCURRENCY` so distinct-client retroactive
// reprocess jobs can run in parallel. Repair-tagged queues
// (`front_rematch_all`, `front_sync_reprocess`) already self-throttle
// via `backoffForApiPoolPressure`, so the wider class slot is safe.
const classBudgets: Record<WorkloadClass, ClassBudget> = {
  interactive:        { maxConcurrency: 1, activeCount: 0, activeWorkers: [] },
  interactive_repair: { maxConcurrency: PERF.RETROACTIVE_REPROCESS_CONCURRENCY, activeCount: 0, activeWorkers: [] },
  // Post-#1787 throughput follow-up: ingestion class cap raised 2 → 3
  // alongside worker-pool bump (8 → 10) and global slot cap bump
  // (7 → 9). This is the cap on concurrent `front_webhook_apply` jobs
  // (the live Front webhook path) — separate from the
  // `front_recovery_ingest_concurrency` setting that controls inner
  // page-fan-out inside one recovery job.
  // Task #1816: now live-tunable via
  // `system_settings.workload_class_ingestion_max_concurrency`. Default
  // remains 3 if the setting is unset. Bumped via the
  // `ramp_ingestion_class_concurrency_*` CEO actions, which call
  // `setIngestionClassConcurrency()` so the change takes effect
  // immediately without a redeploy.
  ingestion:          { maxConcurrency: INGESTION_CLASS_CONCURRENCY_DEFAULT, activeCount: 0, activeWorkers: [] },
  // Task #1829 — dedicated `front_ingestion` class so Front pipeline
  // queues can multi-dispatch without competing with the rest of
  // `ingestion`. Default cap matches `front_ingestion_class_concurrency`
  // (4). Live-tunable via `setFrontIngestionClassConcurrency()`.
  front_ingestion:    { maxConcurrency: 4, activeCount: 0, activeWorkers: [] },
  repair:             { maxConcurrency: PERF.RETROACTIVE_REPROCESS_CONCURRENCY, activeCount: 0, activeWorkers: [] },
  maintenance:        { maxConcurrency: 1, activeCount: 0, activeWorkers: [] },
};

// Task #1025: TOTAL_BUDGET grows alongside the retroactive reprocess
// concurrency so a fully-saturated repair class cannot starve
// interactive / ingestion / maintenance work. Reserves at least 3
// non-repair slots beyond the configured retroactive concurrency.
export const TOTAL_BUDGET = Math.max(4, PERF.RETROACTIVE_REPROCESS_CONCURRENCY + 3);

export type WorkOrigin = "user_manual" | "scheduled_background";

const INGESTION_MANUAL_RESERVE = 1;
// Task #1829 — keep one front_ingestion slot reserved for
// user-manual / reconciliation work so background apply jobs cannot
// fully saturate the class. Live-tunable via
// `setFrontIngestionManualReserve()`.
let FRONT_INGESTION_MANUAL_RESERVE = 1;

interface OriginMetrics {
  manualWaitSamples: number[];
  manualWaitMaxSamples: number;
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  backgroundIngestionSaturationCount: number;
}

interface PerWorkerOriginMetrics {
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  manualWaitSamples: number[];
}

const PER_WORKER_MAX_SAMPLES = 100;

const originMetrics: OriginMetrics = {
  manualWaitSamples: [],
  manualWaitMaxSamples: 200,
  manualAcquires: 0,
  manualDelayedByBackgroundCount: 0,
  manualTimeoutCount: 0,
  backgroundIngestionSaturationCount: 0,
};

const perWorkerMetrics: Map<string, PerWorkerOriginMetrics> = new Map();

function getOrCreateWorkerMetrics(worker: string): PerWorkerOriginMetrics {
  let m = perWorkerMetrics.get(worker);
  if (!m) {
    m = {
      manualAcquires: 0,
      manualDelayedByBackgroundCount: 0,
      manualTimeoutCount: 0,
      manualWaitSamples: [],
    };
    perWorkerMetrics.set(worker, m);
  }
  return m;
}

function recordManualWait(worker: string, waitMs: number, delayedByBackground: boolean): void {
  originMetrics.manualAcquires++;
  if (delayedByBackground) originMetrics.manualDelayedByBackgroundCount++;
  originMetrics.manualWaitSamples.push(waitMs);
  if (originMetrics.manualWaitSamples.length > originMetrics.manualWaitMaxSamples) {
    originMetrics.manualWaitSamples.shift();
  }

  const m = getOrCreateWorkerMetrics(worker);
  m.manualAcquires++;
  if (delayedByBackground) m.manualDelayedByBackgroundCount++;
  m.manualWaitSamples.push(waitMs);
  if (m.manualWaitSamples.length > PER_WORKER_MAX_SAMPLES) {
    m.manualWaitSamples.shift();
  }
}

function recordManualTimeout(worker: string): void {
  originMetrics.manualTimeoutCount++;
  const m = getOrCreateWorkerMetrics(worker);
  m.manualTimeoutCount++;
}

function summarizeWaitSamples(samples: number[]): { count: number; avgMs: number | null; maxMs: number | null; p95Ms: number | null } {
  let avg: number | null = null;
  let max: number | null = null;
  let p95: number | null = null;
  if (samples.length > 0) {
    avg = Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
    max = samples.reduce((m, v) => Math.max(m, v), 0);
    const sorted = [...samples].sort((a, b) => a - b);
    p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  return { count: samples.length, avgMs: avg, maxMs: max, p95Ms: p95 };
}

export type WorkloadOriginMetrics = {
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  backgroundIngestionSaturationCount: number;
  manualWait: { count: number; avgMs: number | null; maxMs: number | null; p95Ms: number | null };
  byWorker: Array<{
    worker: string;
    workloadClass: WorkloadClass;
    manualAcquires: number;
    manualDelayedByBackgroundCount: number;
    manualTimeoutCount: number;
    manualWait: { count: number; avgMs: number | null; maxMs: number | null; p95Ms: number | null };
  }>;
};

export function getWorkloadOriginMetrics(): WorkloadOriginMetrics {
  const byWorker = Array.from(perWorkerMetrics.entries())
    .map(([worker, m]) => ({
      worker,
      workloadClass: getWorkerClass(worker),
      manualAcquires: m.manualAcquires,
      manualDelayedByBackgroundCount: m.manualDelayedByBackgroundCount,
      manualTimeoutCount: m.manualTimeoutCount,
      manualWait: summarizeWaitSamples(m.manualWaitSamples),
    }))
    .sort((a, b) => b.manualAcquires - a.manualAcquires);

  return {
    manualAcquires: originMetrics.manualAcquires,
    manualDelayedByBackgroundCount: originMetrics.manualDelayedByBackgroundCount,
    manualTimeoutCount: originMetrics.manualTimeoutCount,
    backgroundIngestionSaturationCount: originMetrics.backgroundIngestionSaturationCount,
    manualWait: summarizeWaitSamples(originMetrics.manualWaitSamples),
    byWorker,
  };
}

const workerClassMap: Record<string, WorkloadClass> = {
  front_sync: "ingestion",
  zoom_sync: "ingestion",
  local_dominance_sync: "ingestion",
  retroactiveReprocess: "repair",
  frontRematchAll: "interactive_repair",
  frontSyncReprocess: "interactive_repair",
  startupCleanup: "maintenance",
  communication_apply: "ingestion",
  meeting_apply: "ingestion",
  transcript_apply: "ingestion",
  local_report_apply: "ingestion",
  match_state_apply: "ingestion",
  inventory_sync_apply: "maintenance",
  semrush_inventory_sync: "ingestion",
};

export function getWorkerClass(worker: string): WorkloadClass {
  if (worker.startsWith("scheduler:")) {
    const cls = worker.slice("scheduler:".length) as WorkloadClass;
    if (cls in classBudgets) return cls;
  }
  if (worker.startsWith("repair-dispatch:")) {
    const cls = worker.slice("repair-dispatch:".length) as WorkloadClass;
    if (cls in classBudgets) return cls;
  }
  return workerClassMap[worker] || "maintenance";
}

export function registerWorkerClass(worker: string, cls: WorkloadClass): void {
  workerClassMap[worker] = cls;
}

function getTotalActive(): number {
  let total = 0;
  for (const budget of Object.values(classBudgets)) {
    total += budget.activeCount;
  }
  return total;
}

export function acquireClassSlot(worker: string, options?: { origin?: WorkOrigin }): boolean {
  const cls = getWorkerClass(worker);
  const budget = classBudgets[cls];
  const origin: WorkOrigin = options?.origin ?? "scheduled_background";

  // Reserve 1 ingestion slot for user_manual work so background ingestion
  // (semrush_report_refresh, local_dominance_sync, front_sync, etc.) cannot
  // fully saturate the class against an interactive user-triggered sync.
  let effectiveClassMax = budget.maxConcurrency;
  if (cls === "ingestion" && origin !== "user_manual") {
    effectiveClassMax = Math.max(0, budget.maxConcurrency - INGESTION_MANUAL_RESERVE);
  }
  // Task #1829 — mirror the ingestion manual-reserve rule for the new
  // `front_ingestion` class so a background apply backlog can't
  // starve a reconciliation/manual sweep.
  if (cls === "front_ingestion" && origin !== "user_manual") {
    effectiveClassMax = Math.max(0, budget.maxConcurrency - FRONT_INGESTION_MANUAL_RESERVE);
  }

  if (budget.activeCount >= effectiveClassMax) {
    if (cls === "ingestion" && origin !== "user_manual") {
      originMetrics.backgroundIngestionSaturationCount++;
    }
    workerLog({
      worker,
      event: "worker_skipped_class_limit",
      concurrentCount: budget.activeCount,
      workloadClass: cls,
    });
    return false;
  }

  const totalActive = getTotalActive();
  const interactiveReserve = 1;
  const effectiveCap = cls === "maintenance"
    ? TOTAL_BUDGET - interactiveReserve
    : cls === "interactive_repair"
      ? TOTAL_BUDGET
      : TOTAL_BUDGET;

  if (totalActive >= effectiveCap) {
    workerLog({
      worker,
      event: "worker_skipped_global_limit",
      concurrentCount: totalActive,
      workloadClass: cls,
    });
    return false;
  }

  budget.activeCount++;
  budget.activeWorkers.push(worker);

  const key = slotHoldKey(worker);
  const holdRecord: SlotHoldRecord = {
    worker,
    workloadClass: cls,
    acquiredAt: Date.now(),
  };
  activeSlotHolds.set(key, holdRecord);
  const keys = workerToHoldKey.get(worker) ?? [];
  keys.push(key);
  workerToHoldKey.set(worker, keys);

  workerLog({ worker, event: "slot_acquired", workloadClass: cls });
  return true;
}

export function releaseClassSlot(worker: string): void {
  const cls = getWorkerClass(worker);
  const budget = classBudgets[cls];
  const idx = budget.activeWorkers.indexOf(worker);
  if (idx !== -1) {
    budget.activeWorkers.splice(idx, 1);
    budget.activeCount = Math.max(0, budget.activeCount - 1);
  }

  const keys = workerToHoldKey.get(worker);
  const key = keys?.shift();
  if (keys && keys.length === 0) workerToHoldKey.delete(worker);

  if (key) {
    const holdRecord = activeSlotHolds.get(key);
    if (holdRecord) {
      holdRecord.releasedAt = Date.now();
      holdRecord.durationMs = holdRecord.releasedAt - holdRecord.acquiredAt;
      activeSlotHolds.delete(key);
      slotHoldHistory.push(holdRecord);
      if (slotHoldHistory.length > MAX_HOLD_HISTORY) {
        slotHoldHistory.splice(0, slotHoldHistory.length - MAX_HOLD_HISTORY);
      }
      workerLog({
        worker,
        event: "slot_released",
        workloadClass: cls,
        slotHoldDurationMs: holdRecord.durationMs,
      });
    }
  }
}

const SLOT_POLL_MS = 50;
const SLOT_MAX_WAIT_MS = 30_000;

export async function awaitClassSlot(worker: string, options?: { origin?: WorkOrigin }): Promise<void> {
  const origin: WorkOrigin = options?.origin ?? "scheduled_background";
  const cls = getWorkerClass(worker);
  const isManualIngestion = origin === "user_manual" && cls === "ingestion";
  // Snapshot how many ingestion slots background work was holding when the
  // manual request arrived. If background was at or above the non-reserved
  // budget, then any acquisition we manage to make is using reserved capacity.
  const backgroundBudget = isManualIngestion
    ? Math.max(0, classBudgets.ingestion.maxConcurrency - INGESTION_MANUAL_RESERVE)
    : 0;
  const startedSaturated = isManualIngestion
    ? classBudgets.ingestion.activeCount >= backgroundBudget
    : false;
  const start = Date.now();

  if (acquireClassSlot(worker, options)) {
    if (origin === "user_manual") {
      recordManualWait(worker, 0, startedSaturated);
      if (startedSaturated) logManualReserveGrant(worker, 0);
    }
    return;
  }

  while (Date.now() - start < SLOT_MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, SLOT_POLL_MS));
    if (acquireClassSlot(worker, options)) {
      if (origin === "user_manual") {
        const waited = Date.now() - start;
        recordManualWait(worker, waited, true);
        if (isManualIngestion) logManualReserveGrant(worker, waited);
      }
      return;
    }
  }
  if (origin === "user_manual") recordManualTimeout(worker);
  throw new Error(`[WorkloadManager] awaitClassSlot("${worker}") timed out after ${SLOT_MAX_WAIT_MS}ms — class budget exhausted`);
}

function logManualReserveGrant(worker: string, waitedMs: number): void {
  workerLog({
    worker,
    event: "manual_reserve_slot_acquired",
    workloadClass: "ingestion",
    waitMs: waitedMs,
    backgroundActive: classBudgets.ingestion.activeCount - 1,
    reserveSize: INGESTION_MANUAL_RESERVE,
  });
}

export async function withClassSlot<T>(
  worker: string,
  fn: () => Promise<T>,
  options?: { origin?: WorkOrigin },
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  if (!acquireClassSlot(worker, options)) {
    return { acquired: false };
  }
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    releaseClassSlot(worker);
  }
}

export function getClassStatus(): Record<WorkloadClass, { maxConcurrency: number; activeCount: number; activeWorkers: string[] }> {
  const result: Record<string, any> = {};
  for (const [cls, budget] of Object.entries(classBudgets)) {
    result[cls] = {
      maxConcurrency: budget.maxConcurrency,
      activeCount: budget.activeCount,
      activeWorkers: [...budget.activeWorkers],
    };
  }
  return result as Record<WorkloadClass, { maxConcurrency: number; activeCount: number; activeWorkers: string[] }>;
}

export function getTotalActiveSlots(): number {
  return getTotalActive();
}

// Task #1829 — live setters for the `front_ingestion` class budget and
// manual reserve. Called by `frontWarpSettings.ts` whenever the
// settings module re-resolves its values from `system_settings`.
const FRONT_INGESTION_CLASS_CONCURRENCY_MIN = 1;
const FRONT_INGESTION_CLASS_CONCURRENCY_MAX = 8;

export function getFrontIngestionClassConcurrency(): number {
  return classBudgets.front_ingestion.maxConcurrency;
}

export function setFrontIngestionClassConcurrency(next: number): {
  previous: number;
  applied: number;
  clamped: boolean;
} {
  const previous = classBudgets.front_ingestion.maxConcurrency;
  const applied = Math.max(
    FRONT_INGESTION_CLASS_CONCURRENCY_MIN,
    Math.min(FRONT_INGESTION_CLASS_CONCURRENCY_MAX, Math.floor(next)),
  );
  classBudgets.front_ingestion.maxConcurrency = applied;
  if (applied !== previous) {
    workerLog({
      worker: "workloadManager",
      event: "front_ingestion_class_concurrency_changed",
      workloadClass: "front_ingestion",
      previous,
      applied,
    } as any);
  }
  return { previous, applied, clamped: applied !== next };
}

export function getFrontIngestionManualReserve(): number {
  return FRONT_INGESTION_MANUAL_RESERVE;
}

export function setFrontIngestionManualReserve(next: number): number {
  const applied = Math.max(0, Math.min(4, Math.floor(next)));
  FRONT_INGESTION_MANUAL_RESERVE = applied;
  return applied;
}

// Task #1816 — live ingestion-class cap setter. Called by the
// `ramp_ingestion_class_concurrency_*` CEO actions after persisting
// the new value to `system_settings` so the bump takes effect on the
// next scheduler tick without a redeploy. Bounded to keep an operator
// press from accidentally starving the worker pool.
export function getIngestionClassConcurrency(): number {
  return classBudgets.ingestion.maxConcurrency;
}

export function setIngestionClassConcurrency(next: number): {
  previous: number;
  applied: number;
  clamped: boolean;
} {
  const previous = classBudgets.ingestion.maxConcurrency;
  const applied = Math.max(
    INGESTION_CLASS_CONCURRENCY_MIN,
    Math.min(INGESTION_CLASS_CONCURRENCY_MAX, Math.floor(next)),
  );
  classBudgets.ingestion.maxConcurrency = applied;
  workerLog({
    worker: "workloadManager",
    event: "ingestion_class_concurrency_changed",
    workloadClass: "ingestion",
    previous,
    applied,
  } as any);
  return { previous, applied, clamped: applied !== next };
}

// Settings-driven boot loader. Imported lazily in scheduler startup
// so this module stays free of the `storage` import cycle.
export async function loadIngestionClassConcurrencyFromSettings(): Promise<void> {
  try {
    // Pool-tenancy: scheduler boot runs in worker context, so route this
    // settings read through the worker pool explicitly via
    // `runWithWorkerDb`. Without the wrapper, `storage.getSystemSetting`
    // falls through to the default API pool, which violates the
    // documented tenancy rule (api pool = user-facing requests only).
    const [{ storage }, { runWithWorkerDb, withDbAttribution }] = await Promise.all([
      import("../storage"),
      import("../db"),
    ]);
    const row = await runWithWorkerDb(() =>
      withDbAttribution(
        "workload_manager:boot:load_ingestion_class_concurrency",
        () => storage.getSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY),
      ),
    );
    if (!row?.value) return;
    const parsed = Number.parseInt(row.value, 10);
    if (!Number.isFinite(parsed)) return;
    setIngestionClassConcurrency(parsed);
  } catch (err: any) {
    // Best-effort: a settings-read failure during boot must not block
    // scheduler startup. The default (3) stays in effect until the
    // next press of the CEO ramp action calls setIngestionClassConcurrency.
    console.warn(
      "[WorkloadManager] failed to load ingestion class concurrency from settings:",
      err?.message ?? err,
    );
  }
}

export function getActiveWorkersList(): string[] {
  const workers: string[] = [];
  for (const budget of Object.values(classBudgets)) {
    workers.push(...budget.activeWorkers);
  }
  return workers;
}

// Task #836 Phase 2: API-pool pressure-aware backoff helper.
//
// Background workloads (`front_sync_reprocess:batch`,
// `retroactive_reprocess:run`, auto-retry workers, periodic sweeps,
// non-urgent backfills) call this helper between batches / per record.
// When API pool utilization is above the warn threshold, waiters are
// queued, or we recently logged slow API acquires, the helper sleeps
// for `WORKLOAD_BACKOFF_SLEEP_MS` and emits a single backoff log line
// keyed on the worker. Repeated calls at the same pressure level are
// sampled (`backoffLogCooldownMs`) so a tight loop does not flood
// production logs. The total amount slept per call is bounded by
// `WORKLOAD_BACKOFF_MAX_SLEEP_MS`.
const backoffLogCooldownMs = 60_000;
const lastBackoffLogAt = new Map<string, number>();

export interface BackoffResult {
  backedOff: boolean;
  sleptMs: number;
  reasons: string[];
  utilizationPct: number;
  waitingCount: number;
}

export async function backoffForApiPoolPressure(worker: string): Promise<BackoffResult> {
  const initial = isApiPoolUnderPressure();
  if (!initial.underPressure) {
    return {
      backedOff: false,
      sleptMs: 0,
      reasons: [],
      utilizationPct: initial.utilizationPct,
      waitingCount: initial.waitingCount,
    };
  }

  const now = Date.now();
  const lastLog = lastBackoffLogAt.get(worker) ?? 0;
  if (now - lastLog >= backoffLogCooldownMs) {
    workerLog({
      worker,
      event: "workload_backoff_api_pressure",
      workloadClass: getWorkerClass(worker),
      reasons: initial.reasons,
      utilizationPct: initial.utilizationPct,
      waitingCount: initial.waitingCount,
    });
    lastBackoffLogAt.set(worker, now);
  }

  const sleepMs = Math.min(PERF.WORKLOAD_BACKOFF_SLEEP_MS, PERF.WORKLOAD_BACKOFF_MAX_SLEEP_MS);
  await new Promise((r) => setTimeout(r, sleepMs));
  const after = isApiPoolUnderPressure();
  return {
    backedOff: true,
    sleptMs: sleepMs,
    reasons: initial.reasons,
    utilizationPct: after.utilizationPct,
    waitingCount: after.waitingCount,
  };
}

// Task #836 Phase 2: snapshot of current background concurrency for
// dashboards. Reuses class-budget data so no extra bookkeeping is
// needed.
export function getBackgroundConcurrencySnapshot(): {
  totalActive: number;
  totalBudget: number;
  byClass: Array<{ workloadClass: WorkloadClass; activeCount: number; maxConcurrency: number; activeWorkers: string[] }>;
} {
  return {
    totalActive: getTotalActive(),
    totalBudget: TOTAL_BUDGET,
    byClass: (Object.entries(classBudgets) as Array<[WorkloadClass, ClassBudget]>).map(
      ([cls, budget]) => ({
        workloadClass: cls,
        activeCount: budget.activeCount,
        maxConcurrency: budget.maxConcurrency,
        activeWorkers: [...budget.activeWorkers],
      }),
    ),
  };
}

// Task #836 Phase 2: kill switch read-side helper. Centralized so
// both the dashboard and the handlers see the same shape. Now reads
// through `isKillSwitchEnabled` so persisted runtime overrides take
// effect without a redeploy.
export function getKillSwitchStatus(): Record<string, boolean> {
  return {
    retroactive_reprocess: isKillSwitchEnabled("retroactive_reprocess"),
    front_sync_reprocess: isKillSwitchEnabled("front_sync_reprocess"),
    auto_retry: isKillSwitchEnabled("auto_retry"),
    non_critical_sweeps: isKillSwitchEnabled("non_critical_sweeps"),
    large_backfills: isKillSwitchEnabled("large_backfills"),
  };
}

export function getSlotHoldMetrics(): {
  activeHolds: Array<{ worker: string; workloadClass: WorkloadClass; heldForMs: number }>;
  recentHistory: SlotHoldRecord[];
  averageHoldDurationMs: number | null;
} {
  const now = Date.now();
  const activeHolds = Array.from(activeSlotHolds.values()).map(h => ({
    worker: h.worker,
    workloadClass: h.workloadClass,
    heldForMs: now - h.acquiredAt,
  }));

  const completedHolds = slotHoldHistory.filter(h => h.durationMs != null);
  const avgDuration = completedHolds.length > 0
    ? Math.round(completedHolds.reduce((sum, h) => sum + (h.durationMs ?? 0), 0) / completedHolds.length)
    : null;

  return {
    activeHolds,
    recentHistory: [...slotHoldHistory].reverse().slice(0, 20),
    averageHoldDurationMs: avgDuration,
  };
}
