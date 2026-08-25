/**
 * Per-location SEMrush auto-retry worker.
 *
 * Polls `semrush_location_sync_state` for rows whose latest attempt FAILED
 * with a retryable error category, whose backoff (`nextRetryAt`) has elapsed,
 * and whose attempt budget is not yet exhausted, then re-drives each row
 * through `syncSingleClient` with `restrictToLocationId` so a single
 * location can be retried in isolation without disturbing siblings.
 *
 * Bounded by:
 *   - DB-side atomic claim (Workers/queues parity, E-F01): status='failed'
 *     AND nextRetryAt<=now rows are claimed via UPDATE … WHERE id IN
 *     (SELECT … FOR UPDATE SKIP LOCKED) which pushes `nextRetryAt` forward
 *     by the `semrush_location_auto_retry` max-processing lane — a bounded,
 *     self-recovering lease. Terminal failures and `stale` rows are never
 *     picked up; the attempt budget is governed by completeAttempt as before.
 *   - Claim LIMIT = per-tick concurrency cap (default 2) so a wave of
 *     simultaneously-due retries can't saturate the worker pool.
 *   - In-process dedupe set as belt-and-braces against a row still being
 *     driven by this instance when its lease elapses.
 */
import { claimDueAutoRetries } from "./semrushLocationSyncState";
import { dbRetry, withDbAttribution } from "../db";
import type { SemrushLocationSyncState } from "@shared/schema";
import { PERF } from "../perfConfig";
import { isKillSwitchEnabled } from "./killSwitches";
import { backoffForApiPoolPressure } from "./workloadManager";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { getMaxProcessingMs } from "./queueMaxProcessing";
import { workerLog } from "./workerLogger";

const WORKER_NAME = "semrush_location_auto_retry";
const TICK_INTERVAL_MS = PERF.SEMRUSH_LOCATION_AUTO_RETRY_TICK_MS;
const MAX_PARALLEL_PER_TICK = 2;

let timer: NodeJS.Timeout | null = null;
let running = false;
const inFlight = new Set<string>();
// E-F05: log the pre-claim kill-switch skip once per ON transition (the
// tick fires every 30s — logging every skipped tick would be noise).
let killSwitchWasOn = false;

async function runOnce(): Promise<{ picked: number; succeeded: number; failed: number }> {
  if (running) return { picked: 0, succeeded: 0, failed: 0 };
  // Task #836 Phase 2: respect the auto-retry kill switch *and* the
  // generic API-pool back-pressure signal. Without these checks, a wave
  // of retries can pile on top of an already-saturated pool and turn a
  // transient blip into a sustained outage.
  if (isKillSwitchEnabled("auto_retry")) {
    if (!killSwitchWasOn) {
      killSwitchWasOn = true;
      workerLog({
        worker: WORKER_NAME,
        event: "kill_switch_abort",
        killSwitch: "auto_retry",
        detail: "tick skipped - operator kill switch enabled (logged once per transition)",
      });
    }
    return { picked: 0, succeeded: 0, failed: 0 };
  }
  killSwitchWasOn = false;
  await backoffForApiPoolPressure("semrushAutoRetry");
  running = true;
  try {
    // E-F01: atomic claim replaces the old plain SELECT. The pushed
    // `nextRetryAt` is the lease: a crashed claimer's rows simply come
    // due again once the lane's max-processing window elapses.
    const leaseMs = await getMaxProcessingMs(WORKER_NAME).catch(() => 15 * 60_000);
    // Task #813: wrap in dbRetry so a transient Neon recycle on the
    // periodic auto-retry tick is absorbed instead of being charged to
    // dbFailures. The claim is idempotent-safe to retry: a retried claim
    // just claims whatever is still due.
    const due = await dbRetry(
      () => claimDueAutoRetries(MAX_PARALLEL_PER_TICK, leaseMs),
      "semrushAutoRetry.claimDueAutoRetries",
    );
    if (due.length === 0) return { picked: 0, succeeded: 0, failed: 0 };

    // Lazy import the heavy worker module to avoid a require cycle with
    // semrushLocationSyncState (which is imported from the worker module).
    const { syncSingleClient } = await import("./localDominanceSyncWorker");

    const picked: SemrushLocationSyncState[] = [];
    for (const row of due) {
      if (inFlight.has(row.id)) continue;
      picked.push(row);
      inFlight.add(row.id);
    }

    let succeeded = 0;
    let failed = 0;
    await Promise.allSettled(picked.map(async (row) => {
      try {
        // E-F05: recheck between claim and launch. A claimed-but-skipped
        // row self-recovers when its pushed nextRetryAt elapses.
        if (isKillSwitchEnabled("auto_retry")) {
          workerLog({
            worker: WORKER_NAME,
            event: "kill_switch_abort",
            killSwitch: "auto_retry",
            jobId: row.id,
            detail: "operator stop honored after claim - row self-recovers when its lease elapses",
          });
          return;
        }
        workerLog({
          worker: WORKER_NAME,
          event: "job_leased",
          jobId: row.id,
          detail:
            `retry ${row.clientId}/${row.locationId}/${row.campaignId} ` +
            `(attempt ${row.attemptCount}/${row.maxAttempts}, last error: ${row.lastError ?? "n/a"})`,
        });
        const result = await syncSingleClient(row.clientId, {
          origin: "scheduled_background",
          restrictToLocationId: row.locationId,
        });
        if (result.success) {
          succeeded++;
          workerLog({ worker: WORKER_NAME, event: "job_completed", jobId: row.id });
        } else {
          failed++;
          workerLog({ worker: WORKER_NAME, event: "job_failed", jobId: row.id, error: result.error ?? "sync reported failure" });
        }
      } catch (e: any) {
        failed++;
        workerLog({ worker: WORKER_NAME, event: "job_failed", jobId: row.id, error: e?.message || String(e) });
      } finally {
        inFlight.delete(row.id);
      }
    }));

    if (picked.length > 0) {
      workerLog({
        worker: WORKER_NAME,
        event: "worker_completed",
        itemsProcessed: picked.length,
        detail: `tick complete: picked=${picked.length} succeeded=${succeeded} failed=${failed}`,
      });
    }
    return { picked: picked.length, succeeded, failed };
  } finally {
    running = false;
  }
}

export function startSemrushLocationAutoRetryWorker(): void {
  if (timer) return;
  console.log(`[SemrushAutoRetry] Starting auto-retry worker (tick=${TICK_INTERVAL_MS}ms, parallel=${MAX_PARALLEL_PER_TICK})`);
  // Defer first tick so server startup isn't blocked. Wrap each tick in the
  // cross-instance singleton lock so only one autoscale instance drives the
  // due-retry SELECT + syncSingleClient per tick — runOnce calls the SEMrush
  // API directly (no work_queue dedupe), so without the lock every instance
  // would re-drive the same due rows. The lock self-heals on crash.
  timer = setInterval(() => {
    void withDbAttribution("worker:semrush-location-retry", () =>
      withWorkerSingletonLock("semrush_location_auto_retry", () => runOnce())
        .catch(e => console.error(`[SemrushAutoRetry] Tick failed: ${e?.message || e}`)),
    );
  }, TICK_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer.
  if ((timer as any).unref) (timer as any).unref();
}

export function stopSemrushLocationAutoRetryWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exposed for tests + manual operator endpoints.
export const __test = { runOnce };
