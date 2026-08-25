// @db-pool-intent: worker
//
// Task #1969 — Shared background-drain primitive for CEO prod-actions.
//
// Several prod-actions used to be bounded by a per-press safety ceiling
// (5000-row batches × 20 iterations = 100k cap, or "500 dead-letter rows
// per press") and relied on the operator to re-press until status
// flipped to `not-needed`. This helper replaces that pattern with a
// one-and-done press: the operator presses once, the apply path
// returns immediately, and a background worker drains the backlog in
// chunks until exhausted — recording the final outcome in
// `prod_action_runs` when complete.
//
// Contract:
//   • Single-flight per `actionId` via an in-memory Map. Re-pressing
//     while a drain is running is a safe no-op that reports current
//     progress.
//   • The background loop runs on the `worker` pool via
//     `runWithWorkerDb(...)` and stays under the 10s DB-hold cap by
//     delegating chunk-sized writes to caller-supplied `runChunk()`.
//   • The chunk callback returns `{ processed, perKey? }`. A chunk
//     returning `processed=0` ends the drain.
//   • On completion (or error) the helper writes a `prod_action_runs`
//     audit row so the operator can read the final totals from History
//     after the press has returned.
//   • Resumability across restarts: in-memory state is lost on a
//     process restart, but the work is durable in the DB; a re-press
//     after restart will start a fresh drain that picks up wherever
//     the chunk filter (e.g. `WHERE status = 'pending'`) left off.
//
// Task #2293 — CROSS-INSTANCE single-flight. The in-memory `drains` Map
// only collapses concurrent presses on a SINGLE process. The deploy
// target is `autoscale` (multiple instances), so two presses routed to
// two different instances each pass their own (empty) in-memory check
// and would both start a drain — double-processing rows and writing two
// `prod_action_runs` audit rows. A Postgres session-level advisory lock
// keyed by `actionId`, taken with `pg_try_advisory_lock` on a dedicated
// worker-pool connection and HELD for the whole drain, makes exactly one
// instance win cluster-wide. It is self-healing: if the winning instance
// crashes mid-drain, Postgres drops that session and auto-releases the
// lock, so a later press on any instance can take over.
import { runWithWorkerDb, withDbAttribution } from "../db";
import { recordProdActionRun } from "../storage/prodActionRuns";
import {
  acquireProdActionDrainLock,
  type CrossInstanceLockHandle,
  type CrossInstanceLockOptions,
  type CrossInstanceLockWatchdogInfo,
} from "./crossInstanceLock";
import { workerLog } from "./workerLogger";
import { PROD_ACTION_DRAIN_MAX_HOLD_MS } from "./workerConfig";

// Task #2363 — the advisory-lock primitive first shipped here (Task #2293)
// is now the shared `crossInstanceLock` helper so other run-once workers
// can reuse it. The drain lock delegates to `acquireProdActionDrainLock`,
// which keeps the namespace ("DRAI" → 0x44524149) and key hash byte-for-byte
// identical to the original, so existing locks/tests are unchanged.
export type DrainLockHandle = CrossInstanceLockHandle;

/**
 * Try to take the cluster-wide drain lock for `actionId`. Returns a
 * handle (lock held on a dedicated worker-pool connection) when this
 * caller wins, or `null` when another instance already holds it.
 *
 * The connection is held for the entire critical section because
 * `pg_advisory_lock`/`pg_advisory_unlock` are SESSION-scoped — checking
 * the lock out and releasing it must happen on the same Postgres session,
 * which a single pinned `PoolClient` guarantees. The checked-out client
 * is never returned to the pool's idle list mid-drain, so the Task #815
 * idle-connection lifetime sweep cannot recycle it out from under us.
 */
// Test seam (Task #2374): allow a test to override the cross-instance lock
// acquisition so it can simulate the advisory-lock query itself THROWING
// (e.g. a DB blip during `pg_try_advisory_lock`). As the sibling pre-launch
// failure to `countPending()` throwing (Task #2359), this path must also
// leave no stale single-flight reservation and write no `prod_action_runs`
// row. Default `null` = real behavior. Always restore to `null` in a test's
// finally so the override never leaks across the serial runner.
let __lockAcquireOverrideForTest:
  | ((
      actionId: string,
      options: CrossInstanceLockOptions,
    ) => Promise<DrainLockHandle | null>)
  | null = null;

export function __setDrainLockAcquireOverrideForTest(
  override:
    | ((
        actionId: string,
        options: CrossInstanceLockOptions,
      ) => Promise<DrainLockHandle | null>)
    | null,
): void {
  __lockAcquireOverrideForTest = override;
}

async function acquireCrossInstanceDrainLock(
  actionId: string,
  options: CrossInstanceLockOptions = {},
): Promise<DrainLockHandle | null> {
  if (__lockAcquireOverrideForTest) {
    return __lockAcquireOverrideForTest(actionId, options);
  }
  return acquireProdActionDrainLock(actionId, options);
}

export interface DrainChunkResult {
  processed: number;
  perKey?: Record<string, number>;
}

export interface DrainSpec {
  actionId: string;
  actionTitle: string;
  attributionLabel: string;
  countPending: () => Promise<number>;
  runChunk: () => Promise<DrainChunkResult>;
  unit?: string;
  // Task #2059 — optional plain-English completion summary. When supplied,
  // the final `prod_action_runs` audit detail (and the "already running"
  // re-press notice) uses this instead of the generic
  // `formatDrainProgress` tally, so the operator can read a human summary
  // of what the drain accomplished straight from the History panel without
  // re-running anything. Falls back to `formatDrainProgress` when omitted.
  formatSummary?: (state: DrainState) => string;
  // Task #2400 — optional per-drain cross-instance-lock watchdog ceiling (ms).
  // When > 0, a hung drain (e.g. an external API call stalls without a
  // timeout) holding the cluster-wide advisory lock past this ceiling is
  // force-released so a later press on any instance can take over. When
  // omitted, the ceiling falls back to `PROD_ACTION_DRAIN_MAX_HOLD_MS[actionId]`
  // and finally to 0 (watchdog OFF — the pre-Task-#2400 behavior). Primarily a
  // test seam; production drains configure their ceiling in `workerConfig.ts`.
  maxHoldMs?: number;
}

export interface DrainState {
  actionId: string;
  startedAt: number;
  finishedAt: number | null;
  totalAtStart: number;
  processed: number;
  perKey: Record<string, number>;
  chunks: number;
  error: string | null;
  actorId: string | null;
  unit: string;
}

const drains = new Map<string, DrainState>();
const MAX_CHUNKS = 10_000;

export function isDrainRunning(actionId: string): boolean {
  const s = drains.get(actionId);
  return !!s && s.finishedAt === null;
}

export function getDrainState(actionId: string): DrainState | undefined {
  return drains.get(actionId);
}

export function formatDrainProgress(state: DrainState): string {
  const tally = Object.entries(state.perKey)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const tallyNote = tally ? ` (${tally})` : "";
  return (
    `${state.processed} / ${state.totalAtStart} ${state.unit}` +
    ` processed across ${state.chunks} chunk(s)${tallyNote}`
  );
}

/**
 * Resolve the human-readable detail for a drain state, preferring the
 * spec's plain-English `formatSummary` when present and falling back to
 * the generic raw-tally `formatDrainProgress`.
 */
function drainDetail(spec: DrainSpec, state: DrainState): string {
  return spec.formatSummary
    ? spec.formatSummary(state)
    : formatDrainProgress(state);
}

export interface StartDrainOutcome {
  state: "started" | "already-running" | "nothing-to-do";
  detail: string;
  totalAtStart: number;
}

/**
 * Kick off (or join) a background drain for `spec.actionId`. Returns
 * immediately. The caller's apply() should translate this into a
 * `ProdActionOutcome`:
 *   • `started`         → state: "applied"
 *   • `already-running` → state: "applied" (safe no-op)
 *   • `nothing-to-do`   → state: "not-needed"
 */
export async function startBackgroundDrain(
  spec: DrainSpec,
  actorId: string | null,
): Promise<StartDrainOutcome> {
  const unit = spec.unit ?? "row(s)";
  const existing = drains.get(spec.actionId);
  if (existing && existing.finishedAt === null) {
    return {
      state: "already-running",
      detail: `Background drain already running — ${drainDetail(spec, existing)}.`,
      totalAtStart: existing.totalAtStart,
    };
  }

  // Task #2056 — reserve the single-flight slot SYNCHRONOUSLY, before the
  // `countPending()` await, so two genuinely concurrent presses cannot both
  // pass the `existing.finishedAt === null` check during that await and both
  // start a drain (double-processing rows + writing two audit rows). JS runs
  // the read-then-set below atomically (no await between `drains.get` above and
  // `drains.set` here), so a second concurrent press observes this running
  // placeholder and returns `already-running`. `totalAtStart` is backfilled
  // after the count resolves; the placeholder is removed again on the
  // nothing-to-do / count-error paths so neither leaves a stale drain or audit
  // row.
  const state: DrainState = {
    actionId: spec.actionId,
    startedAt: Date.now(),
    finishedAt: null,
    totalAtStart: 0,
    processed: 0,
    perKey: {},
    chunks: 0,
    error: null,
    actorId,
    unit,
  };
  drains.set(spec.actionId, state);

  let totalAtStart: number;
  try {
    totalAtStart = await spec.countPending();
  } catch (err) {
    // Release the reservation so a later press can start fresh, then surface
    // the count failure to the caller exactly as before this guard existed.
    drains.delete(spec.actionId);
    throw err;
  }

  if (totalAtStart === 0) {
    // Release the reservation: nothing-to-do must leave no drain state behind
    // (getDrainState stays undefined) and write no prod_action_runs row.
    drains.delete(spec.actionId);
    return {
      state: "nothing-to-do",
      detail: `Nothing to drain — 0 ${unit} pending.`,
      totalAtStart: 0,
    };
  }

  state.totalAtStart = totalAtStart;

  // Task #2400 — finalize-once guard shared by the normal loop end and the
  // hung-holder watchdog. Whichever path runs first writes the single terminal
  // `prod_action_runs` audit row and flips the in-memory `finishedAt`; the
  // other becomes an idempotent no-op. Without this, a drain that HANGS past
  // its ceiling (watchdog force-releases the lock) and then later un-hangs
  // would let runDrainLoop's `finally` ALSO finalize, writing a duplicate
  // audit row and overwriting `finishedAt`.
  let lockHandle: DrainLockHandle | null = null;
  let finalized = false;
  const finalize = async (
    endedAt: number,
    releaseLock: boolean,
  ): Promise<void> => {
    if (finalized) return;
    finalized = true;
    // Task #2234 — write the terminal audit row BEFORE flipping `finishedAt`
    // so a consumer observing the drain status and History together never
    // sees "finished" with no History row yet. `endedAt` measures work time,
    // not the audit-write latency.
    await finalizeAudit(spec, state, endedAt).catch((auditErr: any) => {
      console.error(
        `[prod-actions] background-drain audit insert failed for ${spec.actionId}:`,
        auditErr?.message ?? auditErr,
      );
    });
    // Task #2293 — on the NORMAL path release the cross-instance lock BEFORE
    // flipping the "done" signal so there is no window where the drain looks
    // finished but the lock is still held. On the WATCHDOG path the primitive
    // force-releases the lock itself (right after `onWatchdog` returns), so we
    // skip the release here.
    if (releaseLock && lockHandle) {
      await lockHandle.release();
    }
    state.finishedAt = endedAt;
  };

  // Task #2400 — when the watchdog fires, the drain is presumed hung: the
  // advisory lock is force-released by the primitive so another instance can
  // take over. Record an observable signal and finalize the in-memory/audit
  // bookkeeping here (the hung loop may never reach its own `finally`), so no
  // row is left "running" with a freed lock. Marking `state.error` makes the
  // audit row land in the `error` branch with a plain-English reason.
  const onWatchdog = (info: CrossInstanceLockWatchdogInfo): void => {
    state.error =
      state.error ??
      `Background drain watchdog force-released the cluster lock after ` +
        `${info.heldMs} ms (ceiling ${info.maxHoldMs} ms); the drain is ` +
        `presumed hung so another instance can now take over.`;
    workerLog({
      worker: `prod-action-drain:${spec.actionId}`,
      event: "worker_lock_watchdog_fired",
      lockAge: info.heldMs,
      maxHoldMs: info.maxHoldMs,
    });
    // The primitive releases the lock itself after this callback returns, so
    // finalize without re-releasing. Fire-and-forget: onWatchdog is sync.
    void finalize(Date.now(), false);
  };

  // Resolve the watchdog ceiling: explicit spec override wins, else the
  // per-action config map, else 0 (watchdog OFF — unchanged behavior).
  const maxHoldMs =
    spec.maxHoldMs ?? PROD_ACTION_DRAIN_MAX_HOLD_MS[spec.actionId] ?? 0;

  // Task #2293 — take the cluster-wide drain lock BEFORE launching the loop.
  // The in-memory reservation above only guards this process; on `autoscale`
  // a press routed to a different instance would otherwise start a parallel
  // drain. If another instance already holds the lock, release our in-memory
  // reservation and report the same safe `already-running` no-op as the
  // same-process path.
  try {
    lockHandle = await acquireCrossInstanceDrainLock(spec.actionId, {
      maxHoldMs,
      onWatchdog,
    });
  } catch (err) {
    drains.delete(spec.actionId);
    throw err;
  }
  if (!lockHandle) {
    drains.delete(spec.actionId);
    return {
      state: "already-running",
      detail:
        `Background drain already running on another instance for` +
        ` ${totalAtStart} ${unit}. Re-pressing is a safe no-op; the final` +
        ` totals land in History when that drain finishes.`,
      totalAtStart,
    };
  }

  // Fire-and-forget. The worker-pool + attribution scope is established
  // INSIDE runDrainLoop so we do not inherit the request's api-pool /
  // attribution context. The cross-instance lock is released inside
  // runDrainLoop's finally (or by the watchdog if the drain hangs).
  void runDrainLoop(spec, state, finalize);

  return {
    state: "started",
    detail:
      `Background drain started for ${totalAtStart} ${unit}.` +
      ` Runs on the worker pool; status will flip to "not needed"` +
      ` automatically when complete. Re-pressing in the meantime is a` +
      ` safe no-op that reports current progress, and the final totals` +
      ` land in History when the drain finishes.`,
    totalAtStart,
  };
}

async function runDrainLoop(
  spec: DrainSpec,
  state: DrainState,
  finalize: (endedAt: number, releaseLock: boolean) => Promise<void>,
): Promise<void> {
  try {
    await runWithWorkerDb(() =>
      withDbAttribution(spec.attributionLabel, async () => {
        for (let i = 0; i < MAX_CHUNKS; i++) {
          let chunk: DrainChunkResult;
          try {
            chunk = await spec.runChunk();
          } catch (err: any) {
            state.error = err?.message ?? String(err);
            break;
          }
          if (chunk.processed === 0) break;
          state.chunks += 1;
          state.processed += chunk.processed;
          if (chunk.perKey) {
            for (const [k, v] of Object.entries(chunk.perKey)) {
              state.perKey[k] = (state.perKey[k] ?? 0) + v;
            }
          }
        }
      }),
    );
  } catch (err: any) {
    state.error = state.error ?? (err?.message ?? String(err));
  } finally {
    // Normal completion: finalize (audit + release lock + flip `finishedAt`).
    // If the watchdog already finalized this drain (it hung past its ceiling
    // and was force-released), `finalize` is an idempotent no-op.
    await finalize(Date.now(), true);
  }
}

async function finalizeAudit(
  spec: DrainSpec,
  state: DrainState,
  endedAt: number,
): Promise<void> {
  const durMs = endedAt - state.startedAt;
  const progress = drainDetail(spec, state);
  if (state.error) {
    await recordProdActionRun({
      actionId: spec.actionId,
      actionTitle: spec.actionTitle,
      actorUserId: state.actorId ?? null,
      outcomeState: "error",
      detail: `Background drain failed after ${progress} in ${durMs} ms.`,
      rowsAffected: state.processed,
      errorMessage: state.error,
    });
    return;
  }
  if (state.processed === 0) {
    await recordProdActionRun({
      actionId: spec.actionId,
      actionTitle: spec.actionTitle,
      actorUserId: state.actorId ?? null,
      outcomeState: "not-needed",
      detail: `Background drain found nothing to process (${durMs} ms).`,
      rowsAffected: 0,
      errorMessage: null,
    });
    return;
  }
  await recordProdActionRun({
    actionId: spec.actionId,
    actionTitle: spec.actionTitle,
    actorUserId: state.actorId ?? null,
    outcomeState: "applied",
    detail: `Background drain complete — ${progress} in ${durMs} ms.`,
    rowsAffected: state.processed,
    errorMessage: null,
  });
}

export function __resetDrainsForTest(): void {
  drains.clear();
}

/**
 * Test seam (Task #2293): take the cross-instance drain lock directly,
 * WITHOUT touching the in-memory `drains` Map. This lets a single test
 * process simulate "another instance" already draining `actionId` — its
 * in-memory state is invisible (it lives in a different process), but its
 * DB-held advisory lock is the shared guard a second instance must lose
 * on. Returns the handle to release when the simulated instance finishes,
 * or `null` if the lock is already held.
 */
export async function __acquireDrainLockForTest(
  actionId: string,
): Promise<DrainLockHandle | null> {
  return acquireCrossInstanceDrainLock(actionId);
}
