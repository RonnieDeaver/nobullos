import { WORKER_LOCK_TTL_MS, WORKER_LOCK_HEARTBEAT_MS } from "./workerConfig";
import { workerLog } from "./workerLogger";

interface LockEntry {
  worker: string;
  acquiredAt: number;
  expiresAt: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

const locks = new Map<string, LockEntry>();

export function acquireLock(
  worker: string,
  ttlMs: number = WORKER_LOCK_TTL_MS,
  heartbeatMs: number = WORKER_LOCK_HEARTBEAT_MS,
): boolean {
  recoverStaleLocks();

  const existing = locks.get(worker);
  if (existing && existing.expiresAt > Date.now()) {
    workerLog({
      worker,
      event: "worker_skipped_overlap",
      lockHolder: worker,
      lockAge: Date.now() - existing.acquiredAt,
    });
    return false;
  }

  const now = Date.now();
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
        const entry = locks.get(worker);
        if (entry) {
          entry.expiresAt = Date.now() + ttlMs;
          workerLog({ worker, event: "worker_heartbeat" });
        }
      }, heartbeatMs)
    : null;

  locks.set(worker, {
    worker,
    acquiredAt: now,
    expiresAt: now + ttlMs,
    heartbeatTimer,
  });

  workerLog({ worker, event: "worker_lock_acquired" });
  return true;
}

export function releaseLock(worker: string): void {
  const entry = locks.get(worker);
  if (entry) {
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
    }
    locks.delete(worker);
  }
}

export function isLocked(worker: string): boolean {
  const entry = locks.get(worker);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    releaseLock(worker);
    return false;
  }
  return true;
}

export function recoverStaleLocks(): void {
  const now = Date.now();
  for (const [name, entry] of locks.entries()) {
    if (entry.expiresAt <= now) {
      workerLog({
        worker: name,
        event: "worker_lock_recovered",
        lockAge: now - entry.acquiredAt,
      });
      if (entry.heartbeatTimer) {
        clearInterval(entry.heartbeatTimer);
      }
      locks.delete(name);
    }
  }
}

export async function withWorkerLock<T>(
  worker: string,
  fn: () => Promise<T>,
  ttlMs?: number,
  heartbeatMs?: number,
): Promise<T | null> {
  if (!acquireLock(worker, ttlMs, heartbeatMs)) {
    return null;
  }
  try {
    return await fn();
  } finally {
    releaseLock(worker);
  }
}

/**
 * Task #2363 — CROSS-INSTANCE worker lock. The in-memory `locks` Map above
 * only guards ONE process; on the `autoscale` deploy target every instance
 * starts these workers, so a run-once worker guarded only by `acquireLock`
 * still runs once PER INSTANCE. This combines the fast in-process guard
 * with a Postgres advisory lock (via `crossInstanceLock`) so exactly one
 * instance runs the worker cluster-wide.
 *
 * Order matters: take the cheap in-memory lock first (it short-circuits an
 * overlapping run in this same process without a DB round-trip), then the
 * advisory lock. If the advisory lock is lost (another instance is running)
 * the in-memory lock is released again so this process is left clean.
 *
 * Returns a handle whose `release()` frees BOTH locks, or `null` when the
 * worker is already running in this process or on another instance.
 *
 * NOTE: this is for run-once workers that must be a cluster-wide singleton
 * (Google Drive crawl, Local Dominance sync, SEMrush inventory sweep). Do
 * NOT use it for `work_queue` pollers (e.g. call-analysis) — those claim
 * rows with `FOR UPDATE SKIP LOCKED` and WANT every instance polling in
 * parallel; a cluster-wide lock there would serialize the whole cluster.
 */
export async function acquireDistributedLock(
  worker: string,
  ttlMs?: number,
  heartbeatMs?: number,
  maxHoldMs?: number,
): Promise<{ release: () => Promise<void> } | null> {
  if (!acquireLock(worker, ttlMs, heartbeatMs)) {
    return null;
  }
  const { acquireWorkerSingletonLock } = await import("./crossInstanceLock");
  let crossLock: { release: () => Promise<void> } | null;
  try {
    // Task #2383 — bound the cross-instance hold so a HUNG holder can't keep
    // the cluster-wide advisory lock forever. When the watchdog fires it
    // emits an observable `worker_lock_watchdog_fired` event and force-
    // releases the advisory lock so another instance can take over.
    crossLock = await acquireWorkerSingletonLock(worker, "[workerLock]", {
      maxHoldMs,
      onWatchdog:
        maxHoldMs && maxHoldMs > 0
          ? (info) =>
              workerLog({
                worker,
                event: "worker_lock_watchdog_fired",
                lockAge: info.heldMs,
                maxHoldMs: info.maxHoldMs,
              })
          : undefined,
    });
  } catch (err) {
    releaseLock(worker);
    throw err;
  }
  if (!crossLock) {
    workerLog({ worker, event: "worker_skipped_overlap", lockHolder: "other_instance" });
    releaseLock(worker);
    return null;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await crossLock!.release();
      } finally {
        releaseLock(worker);
      }
    },
  };
}
