/**
 * Task #1073 — Shared health sub-check evaluation + degraded-duration
 * tracking.
 *
 * Originally lived inline in the `/api/health` route handler (Task
 * #1070). Extracted here so:
 *   1. The route handler keeps reporting `degradedSince` / `degraded`
 *      to the dashboard exactly as before, AND
 *   2. The new background watcher (`healthDegradedAlerts.ts`) can
 *      independently re-evaluate the same set of sub-checks even when
 *      nobody is hitting `/api/health`, and read durations from the
 *      same first-seen Map so its alert decisions stay aligned with
 *      what the dashboard renders.
 *
 * Task #1074 — first-seen durations are persisted in `system_settings`
 * via `healthDegradedFirstSeen.ts` so they survive a server restart.
 * This module delegates to that persistent store rather than keeping
 * its own in-memory Map; both the route and the watcher therefore read
 * from a single durable source of truth and can never drift apart.
 * Durable per-incident tracking still lives in `health_incidents`;
 * this signal is just the lightweight "right now" duration shown next
 * to each chip and used to gate alert firing.
 */

import { sql } from "drizzle-orm";
// Task #1573 (Audit Track C): background degraded-state tracker — uses the
// worker pool so periodic health probes don't consume request-pool capacity.
import { workerDb as db } from "../db";
import {
  loadDegradedFirstSeen,
  persistDegradedFirstSeen,
  _resetDegradedFirstSeenForTests,
} from "./healthDegradedFirstSeen";

export interface HealthEvaluation {
  checks: Record<string, any>;
  degraded: string[];
}

/**
 * Run every sub-check the `/api/health` endpoint runs and return the
 * `{ checks, degraded[] }` shape. Mirrors the route handler's logic 1:1
 * so the watcher's degradation signal can never drift from the
 * dashboard's degradation signal.
 */
export async function evaluateHealthChecks(): Promise<HealthEvaluation> {
  const checks: Record<string, any> = {};
  const degraded: string[] = [];

  const dbStart = Date.now();
  try {
    await db.execute(sql`SELECT 1 as ok`);
    checks.db = { status: "connected", latencyMs: Date.now() - dbStart };
  } catch {
    checks.db = { status: "failed" };
    degraded.push("db");
  }

  try {
    const { getSchedulerStatus } = await import("./workScheduler");
    const scheduler = getSchedulerStatus();
    checks.scheduler = scheduler;
    if (!scheduler.running && !scheduler.shuttingDown) {
      degraded.push("scheduler");
    }
    if (scheduler.lastCycleAt) {
      const ageMs = Date.now() - new Date(scheduler.lastCycleAt).getTime();
      if (ageMs > scheduler.pollIntervalMs * 6) {
        degraded.push("scheduler_stale");
      }
    }
  } catch {
    checks.scheduler = { status: "unavailable" };
    degraded.push("scheduler");
  }

  try {
    const {
      getClassStatus,
      getTotalActiveSlots,
      TOTAL_BUDGET,
      getWorkloadOriginMetrics,
    } = await import("./workloadManager");
    const { getLocalDominanceSlotMetrics } = await import("./localDominanceSyncWorker");
    const classStatus = getClassStatus();
    const activeSlots = getTotalActiveSlots();
    const ldSlot = getLocalDominanceSlotMetrics();
    const originMetrics = getWorkloadOriginMetrics();
    checks.workers = {
      totalBudget: TOTAL_BUDGET,
      activeSlots,
      classes: Object.fromEntries(
        Object.entries(classStatus).map(([cls, info]) => [
          cls,
          { active: info.activeCount, max: info.maxConcurrency },
        ]),
      ),
      advisoryBypass: { local_dominance_sync: ldSlot },
      origin: originMetrics,
    };
    if (ldSlot.windowBypassRate > 0.1 && ldSlot.windowSamples >= 20) {
      degraded.push("advisory_slot_bypass_high");
    }
  } catch {
    checks.workers = { status: "unavailable" };
    degraded.push("workers");
  }

  try {
    const tableCheck = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('work_queue', 'front_sync_emails', 'raw_communication_records')
    `);
    const foundTables = (tableCheck.rows as any[]).map((r) => r.table_name);
    const expected = ["work_queue", "front_sync_emails", "raw_communication_records"];
    const missing = expected.filter((t) => !foundTables.includes(t));
    checks.tables = { found: foundTables, missing };
    if (missing.length > 0) {
      degraded.push("tables");
    }
  } catch {
    checks.tables = { status: "unavailable" };
    degraded.push("tables");
  }

  return { checks, degraded };
}

/**
 * Reconcile the persisted first-seen Map against the current set of
 * degraded keys. Adds a `now` entry for any new degraded key, drops
 * keys that recovered (so durations reset), and triggers an async
 * persist when anything changed. Returns the resulting `degradedSince`
 * map for the response / alert decision.
 */
export async function recordDegradedSnapshot(
  degraded: readonly string[],
  now: number = Date.now(),
): Promise<Record<string, number>> {
  const map = await loadDegradedFirstSeen();
  const set = new Set(degraded);
  let changed = false;

  for (const key of set) {
    if (!map.has(key)) {
      map.set(key, now);
      changed = true;
    }
  }
  for (const key of Array.from(map.keys())) {
    if (!set.has(key)) {
      map.delete(key);
      changed = true;
    }
  }

  if (changed) {
    void persistDegradedFirstSeen(map);
  }

  if (degraded.length === 0) return {};
  const out: Record<string, number> = {};
  for (const k of degraded) out[k] = map.get(k) ?? now;
  return out;
}

/** Return a snapshot of the first-seen map (key → epoch ms). */
export async function getDegradedFirstSeenSnapshot(): Promise<
  Record<string, number>
> {
  const map = await loadDegradedFirstSeen();
  return Object.fromEntries(map);
}

/** Test-only: clear the persisted first-seen cache between cases. */
export function _resetDegradedTrackerForTests(): void {
  _resetDegradedFirstSeenForTests();
}
