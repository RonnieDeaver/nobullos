// @db-pool-intent: worker
//
// Task #2363 — Shared CROSS-INSTANCE single-flight primitive (Postgres
// session-level advisory lock).
//
// The deploy target is `autoscale` (multiple instances) and almost every
// scheduler/worker starts on EVERY instance (the only exception is the
// deployment-gated Front workers, Task #2289). An in-process guard (a
// boolean, a `Set`, or the in-memory `workerLock` Map) only collapses
// concurrent runs WITHIN one process, so a "run-once" background job
// guarded only by such a flag still runs once PER INSTANCE — double
// crawling external APIs, double-writing rollups, etc.
//
// This generalizes the advisory-lock pattern first shipped for prod-action
// background drains (Task #2293, `prodActionBackgroundDrain.ts`): take
// `pg_try_advisory_lock(namespace, key)` on a dedicated worker-pool
// connection and HOLD it for the whole critical section, so exactly one
// instance runs the job cluster-wide. It is self-healing — if the winning
// instance crashes mid-run, Postgres drops that session and auto-releases
// the lock, so a later run on any instance can take over. No external API
// is involved; the advisory lock is internal to our own Postgres.
//
// Advisory locks are SESSION-scoped, so the checkout and the unlock must
// happen on the SAME Postgres session. A single pinned `PoolClient`
// guarantees that, and because the client is never returned to the pool's
// idle list mid-run the Task #815 idle-connection lifetime sweep cannot
// recycle it out from under us.
import { workerPool } from "../db";

/**
 * int4 namespaces for the two-key `pg_try_advisory_lock(int4, int4)` form.
 * The namespace partitions the lock space by PURPOSE so two unrelated
 * subsystems that happen to hash the same name string can never collide.
 *
 *   • PROD_ACTION_DRAIN — "DRAI" → 0x44524149. Owned by
 *     `prodActionBackgroundDrain.ts`; keyed by `actionId`. Kept identical
 *     to the Task #2293 value so existing locks/tests are unchanged.
 *   • WORKER_SINGLETON  — "WSNG" → 0x57534E47. Owned by run-once
 *     workers/schedulers (Google Drive crawl, Local Dominance sync,
 *     SEMrush inventory sweep, daily-judgment cron, import-ghosts cron);
 *     keyed by a stable job name.
 *
 * Both values are well within the signed-int4 range.
 */
export const PROD_ACTION_DRAIN_LOCK_NAMESPACE = 0x44524149;
export const WORKER_SINGLETON_LOCK_NAMESPACE = 0x57534e47;

/**
 * Deterministic signed-32-bit hash of `name` → the second advisory lock
 * key. Two int4 keys (namespace + this hash) uniquely identify a lock
 * across every instance. This is the SAME hash the Task #2293 drain lock
 * used, so delegating the drain lock here yields identical keys.
 */
export function crossInstanceLockKey(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return h;
}

export interface CrossInstanceLockHandle {
  release: () => Promise<void>;
}

/**
 * Detail handed to `onWatchdog` when the bounded max-hold watchdog fires.
 */
export interface CrossInstanceLockWatchdogInfo {
  namespace: number;
  name: string;
  /** How long the lock had been held when the watchdog fired (ms). */
  heldMs: number;
  /** The configured ceiling that was exceeded (ms). */
  maxHoldMs: number;
}

export interface CrossInstanceLockOptions {
  /**
   * Task #2383 — bounded max-hold watchdog ceiling (ms). The cluster-wide
   * advisory lock self-heals when the winning instance CRASHES (Postgres
   * drops the session), but NOT when the job merely HANGS (e.g. an external
   * API call stalls without a timeout): the process stays alive, the
   * session stays open, and no other instance can take over. When
   * `maxHoldMs > 0`, a watchdog timer force-releases the advisory lock once
   * the hold exceeds the ceiling so another instance can take over (the
   * still-hung job is presumed dead). `<= 0` or omitted disables the
   * watchdog — the pre-Task-#2383 behavior, still used by the prod-action
   * drain, which has its own `finishedAt` lifecycle.
   */
  maxHoldMs?: number;
  /**
   * Invoked exactly once if the watchdog fires, BEFORE the force-release
   * runs, so the caller can route a structured/observable alert (e.g.
   * `workerLog`). When omitted the primitive emits a `console.error` so the
   * event is always observable even if a caller forgets to wire one.
   */
  onWatchdog?: (info: CrossInstanceLockWatchdogInfo) => void;
}

/**
 * Try to take the cluster-wide lock `(namespace, name)`. Returns a handle
 * (lock held on a dedicated worker-pool connection) when this caller wins,
 * or `null` when another instance already holds it. The caller MUST call
 * `release()` when the critical section finishes.
 *
 * Pass `options.maxHoldMs` to arm the Task #2383 watchdog so a hung holder
 * cannot keep the lock forever. The dedicated `PoolClient` pinned here is
 * used ONLY for the advisory lock/unlock — jobs do their real DB work on
 * separate `workerDb`/`getDb()` connections — so the watchdog's unlock
 * query still runs even while the job itself is wedged.
 */
export async function acquireCrossInstanceLock(
  namespace: number,
  name: string,
  logPrefix = "[cross-instance-lock]",
  options: CrossInstanceLockOptions = {},
): Promise<CrossInstanceLockHandle | null> {
  const key2 = crossInstanceLockKey(name);
  const client = await workerPool.connect();
  try {
    const res: any = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [namespace, key2],
    );
    const locked = res?.rows?.[0]?.locked === true;
    if (!locked) {
      client.release();
      return null;
    }

    let released = false;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const acquiredAt = Date.now();

    const doRelease = async (): Promise<void> => {
      if (released) return;
      released = true;
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [namespace, key2]);
      } catch (err: any) {
        console.warn(
          `${logPrefix} failed to release lock for "${name}": ${err?.message ?? err}`,
        );
      } finally {
        client.release();
      }
    };

    const maxHoldMs = options.maxHoldMs ?? 0;
    if (maxHoldMs > 0) {
      watchdogTimer = setTimeout(() => {
        if (released) return;
        const heldMs = Date.now() - acquiredAt;
        const info: CrossInstanceLockWatchdogInfo = { namespace, name, heldMs, maxHoldMs };
        if (options.onWatchdog) {
          try {
            options.onWatchdog(info);
          } catch (cbErr: any) {
            console.error(
              `${logPrefix} watchdog callback threw for "${name}": ${cbErr?.message ?? cbErr}`,
            );
          }
        } else {
          console.error(
            `${logPrefix} WATCHDOG: cross-instance lock "${name}" held ${heldMs}ms ` +
              `(ceiling ${maxHoldMs}ms) — force-releasing so another instance can ` +
              `take over (job presumed hung)`,
          );
        }
        // Force-release the advisory lock. The hung job's own eventual
        // `release()` becomes an idempotent no-op via the `released` flag.
        void doRelease();
      }, maxHoldMs);
      // Never let the watchdog timer keep the event loop alive.
      watchdogTimer.unref?.();
    }

    return { release: doRelease };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Convenience wrapper for the prod-action drain namespace, keyed by
 * `actionId`. `prodActionBackgroundDrain.ts` delegates here so the lock
 * key stays byte-for-byte identical to the Task #2293 implementation.
 */
export function acquireProdActionDrainLock(
  actionId: string,
  options: CrossInstanceLockOptions = {},
): Promise<CrossInstanceLockHandle | null> {
  return acquireCrossInstanceLock(
    PROD_ACTION_DRAIN_LOCK_NAMESPACE,
    actionId,
    "[prod-actions]",
    options,
  );
}

/**
 * Task #4812 — READ-ONLY probe: is the cluster-wide lock `(namespace,
 * name)` currently held by ANY session (this instance or another)?
 *
 * Motivation: on `autoscale`, a prod-action background drain runs in
 * memory on whichever instance won the press, so `isDrainRunning()` on a
 * DIFFERENT instance answers false and a status/board read served there
 * would show a running re-score as idle — exactly the "did the press even
 * work?" confusion. The advisory lock is the one cluster-wide fact every
 * instance can see, so status surfaces probe it instead of guessing.
 *
 * This reads `pg_locks` directly and never calls `pg_try_advisory_lock`,
 * so it cannot race a real press by transiently acquiring the lock. The
 * two-int4 advisory form surfaces as classid=namespace / objid=key /
 * objsubid=2, scoped to the current database; both int4s are compared
 * through their unsigned (oid) representation.
 */
export async function isCrossInstanceLockHeld(
  namespace: number,
  name: string,
): Promise<boolean> {
  const key2 = crossInstanceLockKey(name);
  const res: any = await workerPool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = $1::oid
         AND objid = $2::oid
         AND objsubid = 2
         AND granted
     ) AS held`,
    [namespace >>> 0, key2 >>> 0],
  );
  return res?.rows?.[0]?.held === true;
}

/**
 * Read-only probe for the prod-action drain lock keyed by `actionId` —
 * true while a drain for that action is running on ANY instance.
 */
export function isProdActionDrainLockHeld(actionId: string): Promise<boolean> {
  return isCrossInstanceLockHeld(PROD_ACTION_DRAIN_LOCK_NAMESPACE, actionId);
}

/**
 * Convenience wrapper for run-once workers/schedulers. Returns a handle
 * when this instance wins the cluster-wide singleton lock for `name`, or
 * `null` when another instance is already running that job. Pass
 * `options.maxHoldMs` (Task #2383) to bound how long a hung holder can keep
 * the lock before the watchdog force-releases it.
 */
export function acquireWorkerSingletonLock(
  name: string,
  logPrefix = "[worker-singleton]",
  options: CrossInstanceLockOptions = {},
): Promise<CrossInstanceLockHandle | null> {
  return acquireCrossInstanceLock(
    WORKER_SINGLETON_LOCK_NAMESPACE,
    name,
    logPrefix,
    options,
  );
}

/**
 * Run `fn` under the cluster-wide singleton lock for `name`. When this
 * instance wins, `fn` runs and `{ ran: true, result }` is returned; when
 * another instance already holds the lock, `fn` is skipped and
 * `{ ran: false }` is returned. The lock is always released afterwards.
 * Pass `options.maxHoldMs` (Task #2383) to arm the hung-holder watchdog.
 */
export async function withWorkerSingletonLock<T>(
  name: string,
  fn: () => Promise<T>,
  logPrefix = "[worker-singleton]",
  options: CrossInstanceLockOptions = {},
): Promise<{ ran: boolean; result?: T }> {
  const handle = await acquireWorkerSingletonLock(name, logPrefix, options);
  if (!handle) {
    return { ran: false };
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await handle.release();
  }
}
