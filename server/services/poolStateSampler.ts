/**
 * Task #861 Phase 4 — Pool state attribution sampler.
 *
 * Periodically snapshots the API and worker pools (utilization, waiting count,
 * top hold-labels) into `pool_state_samples`. Lets the dashboard plot pool
 * saturation and surface the dominant offending route/worker without needing
 * to grep logs.
 *
 * Task #915 (913B): the loops here run under the supervised-sampler runtime
 * (`./supervisedSampler`) so a single failed tick never kills the loop and a
 * watchdog observes that the writer is making progress against
 * `pool_state_samples`.
 */

import {
  getApiPoolSnapshot,
  getWorkerPoolSnapshot,
  getTopDbHoldLabels,
  dbRetry,
  withDbAttribution,
} from "../db";
import * as healthStore from "../storage/healthMetricsStorage";
import type { InsertPoolStateSample } from "@shared/schema";
import {
  startSupervisedSampler,
  stopSupervisedSampler,
} from "./supervisedSampler";

const SAMPLE_INTERVAL_MS = 60_000; // every 60s — enough resolution, low cost
const PRUNE_INTERVAL_MS = 60 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

const POOL_SAMPLER_NAME = "pool_state_samples";
const POOL_PRUNE_NAME = "pool_state_samples_prune";

let started = false;

// Counters reset between samples so each row reflects "since last sample".
let lastSlowAcquireCount = { api: 0, worker: 0 };
let lastSlowHoldCount = { api: 0, worker: 0 };

// We don't pull these from db.ts directly to avoid extra exports — pool stats
// don't expose per-pool slow counters today. We approximate from getTopDbHoldLabels
// totals across the interval.
function diffAndSnapshot(label: "api" | "worker"): { slowAcquires: number; slowHolds: number } {
  const labels = getTopDbHoldLabels(label, 50);
  const total = labels.byCount.reduce((s, e) => s + e.count, 0);
  const prev = lastSlowHoldCount[label];
  lastSlowHoldCount[label] = total;
  const delta = Math.max(0, total - prev);
  return { slowAcquires: 0, slowHolds: delta };
}

export async function captureOnce(now: number = Date.now()): Promise<number> {
  const records: InsertPoolStateSample[] = [];

  for (const [name, snapshot, getter] of [
    ["api", getApiPoolSnapshot(), () => getTopDbHoldLabels("api", 10)],
    ["worker", getWorkerPoolSnapshot(), () => getTopDbHoldLabels("worker", 10)],
  ] as const) {
    try {
      const labels = getter();
      const { slowAcquires, slowHolds } = diffAndSnapshot(name);
      records.push({
        sampledAt: now,
        poolName: name,
        totalCount: snapshot.total,
        idleCount: snapshot.idle,
        waitingCount: snapshot.waiting,
        maxCount: snapshot.max,
        utilizationPct: snapshot.utilizationPct,
        slowAcquiresInInterval: slowAcquires,
        slowHoldsInInterval: slowHolds,
        topHoldLabels: {
          byCount: labels.byCount.slice(0, 5),
          byMaxMs: labels.byMaxMs.slice(0, 5),
          byTotalMs: labels.byTotalMs.slice(0, 5),
        },
        unknownLabelPct: Math.round(labels.unknownPct),
      });
    } catch (err: any) {
      console.warn(`[PoolStateSampler] snapshot ${name} failed:`, err?.message || err);
    }
  }

  if (records.length === 0) return 0;
  await dbRetry(() => healthStore.insertPoolStateSamples(records), "poolStateSampler.insert");
  return records.length;
}

async function prune(now: number = Date.now()): Promise<void> {
  const cutoff = now - RETENTION_MS;
  const removed = await dbRetry(
    () => healthStore.prunePoolStateSamples(cutoff),
    "poolStateSampler.prune",
  );
  if (removed > 0) {
    console.log(`[PoolStateSampler] Pruned ${removed} pool_state_samples older than 7 days`);
  }
}

export function startPoolStateSampler(): void {
  if (started) return;
  started = true;

  // Task #913C: wrap each tick body in `maintenance:` attribution so
  // the sampler's own DB checkouts surface in pool-state snapshots
  // rather than falling through as `unknown`. HEAD's supervised-sampler
  // scaffolding (Task #915/913B) handles tick failures + watchdog.
  startSupervisedSampler({
    name: POOL_SAMPLER_NAME,
    intervalMs: SAMPLE_INTERVAL_MS,
    tick: async () => {
      await withDbAttribution("maintenance:pool-state-sampler-capture", () =>
        captureOnce(),
      );
    },
    // Watchdog: rows are inserted on every tick (no buffering), so allow
    // up to four missed intervals before alerting.
    freshnessProbe: async () => {
      try {
        return await healthStore.getMaxTimestamp("pool_state_samples", "sampled_at");
      } catch {
        return null;
      }
    },
    maxStalenessMs: SAMPLE_INTERVAL_MS * 4,
  });

  startSupervisedSampler({
    name: POOL_PRUNE_NAME,
    intervalMs: PRUNE_INTERVAL_MS,
    initialDelayMs: PRUNE_INTERVAL_MS,
    tick: async () => {
      await withDbAttribution("maintenance:pool-state-sampler-prune", () =>
        prune(),
      );
    },
  });

  console.log(
    `[PoolStateSampler] started — interval ${SAMPLE_INTERVAL_MS / 1000}s, retain 7 days`,
  );
}

export function stopPoolStateSampler(): void {
  if (!started) return;
  started = false;
  stopSupervisedSampler(POOL_SAMPLER_NAME);
  stopSupervisedSampler(POOL_PRUNE_NAME);
}

export const __test = {
  captureOnce,
  SAMPLE_INTERVAL_MS,
};
