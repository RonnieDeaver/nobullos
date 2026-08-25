// @cross-instance-safe: in-process supervision engine (guards/heartbeats only); each registered tick's safety is owned by its caller.
/**
 * Task #915 (913B) — Supervised sampler runtime.
 * Task #992 — Watchdog hysteresis, heartbeat-based freshness, tick timeout,
 *             in-process recovery attempt, and rich incident metadata.
 *
 * A reusable wrapper around `setInterval`-style sampler loops that gives every
 * loop independent supervision: non-overlapping ticks, per-tick try/catch,
 * consecutive-failure counting, retry-on-next-interval semantics, and rich
 * runtime state that the admin/API surface can render.
 *
 * Goals:
 *   - A failure inside one supervised sampler can never stop another.
 *   - A single failed tick does not kill its loop — the next interval still
 *     runs.
 *   - Operators get observable, queryable runtime state per sampler — including
 *     the in-memory tick heartbeat, so the dashboard can show "last success
 *     12s ago" without waiting for any DB-side persistence.
 *   - The watchdog uses the in-memory heartbeat as its primary freshness
 *     signal (a per-table MAX(timestamp) probe is at best as fresh as the
 *     flush cadence, which gives false-positive stalls during normal
 *     between-flush windows). Hysteresis (≥3 missed ticks to open an
 *     incident, ≥2 healthy ticks to resolve) plus a startup grace window
 *     prevent flapping. A `freshnessProbe`, if provided, is still recorded
 *     for diagnostics.
 */

export interface SamplerOptions {
  /** Stable identifier — used for logs, runtime state map keys, and incident origin. */
  name: string;
  /** Interval between tick *starts*, in milliseconds. */
  intervalMs: number;
  /** The work to perform per tick. May be sync or async; rejections are caught. */
  tick: () => Promise<void> | void;
  /** Optional initial delay before the first tick (default: 0 — fire immediately). */
  initialDelayMs?: number;
  /**
   * Optional watchdog hook. If provided, the watchdog periodically asks
   * "what is the most recent moment this sampler is known to have produced
   * a useful row?" — typically the MAX(timestamp) of the destination table.
   * Returning `null` disables the staleness check for that interval. The
   * watchdog records the value into runtime state for diagnostics; the
   * actual freshness decision is heartbeat-driven (see module header).
   */
  freshnessProbe?: () => Promise<number | null>;
  /**
   * Maximum allowed staleness before the watchdog raises a stall incident.
   * Defaults to `intervalMs * 4` (i.e. four missed ticks).
   */
  maxStalenessMs?: number;
  /**
   * Optional hard timeout for a single tick. If a tick is still running
   * after this many ms, the wrapper records a *failure* (advancing
   * consecutiveFailures and the failure heartbeat) immediately. The
   * underlying tick promise is left to settle on its own (we cannot
   * abort arbitrary user code), and **the in-flight guard stays held
   * until the original promise actually settles** — this preserves the
   * non-overlap contract. Subsequent interval fires that arrive while
   * the original tick is still running are recorded as skips with
   * reason `previous_tick_still_running`. Defaults to `intervalMs * 2`
   * clamped to [10s, 5min].
   */
  tickTimeoutMs?: number;
}

/**
 * Reasons a scheduled tick may be skipped instead of running. Surfaced
 * in `SamplerRuntimeState.lastSkipReason` so operators can distinguish
 * a healthy heartbeat from a starved one whose interval keeps firing
 * over an in-flight (or hung) prior tick.
 */
export type SamplerSkipReason = "previous_tick_still_running";

export interface SamplerRuntimeState {
  name: string;
  intervalMs: number;
  running: boolean;
  startedAt: number | null;
  lastTickStartedAt: number | null;
  lastTickSucceededAt: number | null;
  lastTickFailedAt: number | null;
  lastTickDurationMs: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalTicks: number;
  totalSuccesses: number;
  totalFailures: number;
  lastErrorSummary: string | null;
  /** Last value reported by the freshness probe (epoch ms), if any. */
  lastFreshnessAt: number | null;
  /** True when the watchdog last classified this sampler as healthy. */
  healthy: boolean;
  /** Free-form reason emitted by the watchdog (e.g. "stalled 17h"). */
  unhealthyReason: string | null;
  maxStalenessMs: number;
  hasFreshnessProbe: boolean;
  /** Tick timeout in ms (resolved default if not explicitly set). */
  tickTimeoutMs: number;
  /** Consecutive watchdog evaluations that observed staleness > threshold. */
  consecutiveMisses: number;
  /** Consecutive watchdog evaluations that observed staleness ≤ threshold. */
  consecutiveHealthy: number;
  /** Number of in-process recovery re-fires the watchdog has attempted. */
  recoveryAttempts: number;
  /** Most recent recovery attempt timestamp (epoch ms). */
  lastRecoveryAt: number | null;
  /** True when the previous tick is still in flight. */
  inFlight: boolean;
  /**
   * Reason the most recent scheduled fire was skipped (e.g. the prior
   * tick was still running). `null` when the most recent fire actually
   * ran. Operators read this to distinguish "heartbeat is fresh because
   * ticks complete fast" from "interval keeps firing but every fire is
   * being skipped over a hung tick".
   */
  lastSkipReason: SamplerSkipReason | null;
  /** Epoch-ms timestamp of the most recent skip, if any. */
  lastSkippedAt: number | null;
  /** Cumulative count of skipped fires since startup. */
  totalSkips: number;
  /** True when a tick exceeded its tickTimeoutMs and is still pending. */
  tickTimedOutPending: boolean;
}

interface SamplerRecord {
  options: SamplerOptions;
  state: SamplerRuntimeState;
  timer: ReturnType<typeof setInterval> | null;
  initialTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** Resolved tick timeout (ms) — kept on the record for hot-path access. */
  tickTimeoutMs: number;
}

const samplers = new Map<string, SamplerRecord>();

// Watchdog hysteresis (Task #992).
//
// An incident opens when EITHER:
//   - the watchdog has observed `MISSES_TO_OPEN_INCIDENT` consecutive
//     missed heartbeats (writer is silent — a soft stall); OR
//   - the sampler has had `FAILURES_TO_OPEN_INCIDENT` consecutive
//     confirmed tick failures (real exceptions thrown by user code or
//     tick-timeouts) — this is a "hard" failure path that should not
//     be gated by the slower miss-counter.
//
// An incident resolves only after `SUCCESSFUL_TICKS_TO_RESOLVE`
// consecutive *real tick successes* (NOT just healthy watchdog
// evaluations). This prevents the watchdog from clearing an open
// incident purely because the heartbeat fell back into the staleness
// budget while the underlying tick code is still failing.
const MISSES_TO_OPEN_INCIDENT = 3;
const FAILURES_TO_OPEN_INCIDENT = 2;
const SUCCESSFUL_TICKS_TO_RESOLVE = 2;
const STARTUP_GRACE_INTERVALS = 2;
const RECOVERY_COOLDOWN_MS = 60_000;
/**
 * Task #992 — bound the number of in-process recovery re-fires we
 * attempt before declaring the sampler unrecoverable from inside the
 * process. Once exceeded, we emit a one-time "restart required" log
 * (suppressed thereafter) and stop firing recovery ticks; the open
 * incident remains so operators see the condition.
 */
const MAX_RECOVERY_ATTEMPTS = 5;
/**
 * Task #992 — incident/log de-dup. While stalled, re-emit the open
 * incident only when one of these signature fields changes; otherwise
 * the open incident already exists and re-emitting just adds noise.
 * The signature also gates the per-cycle warn() log.
 */
type StallSignature = string;
const lastEmittedStallSignature = new Map<string, StallSignature>();
const restartRequiredLogged = new Set<string>();

function buildStallSignature(rec: SamplerRecord): StallSignature {
  // Deliberately excludes `consecutiveMisses`: it advances on every
  // watchdog cycle while the stall persists, which would defeat the
  // dedup gate. We only treat the stall as "meaningfully changed"
  // when an error, timeout flip, or recovery-attempt boundary occurs.
  return [
    rec.state.lastErrorSummary ?? "",
    rec.state.tickTimedOutPending ? "1" : "0",
    rec.state.recoveryAttempts,
  ].join("|");
}

function summarizeError(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) {
    return (err.message || err.name || "Error").slice(0, 240);
  }
  try {
    return String(err).slice(0, 240);
  } catch {
    return "unstringifiable error";
  }
}

function resolveTickTimeoutMs(options: SamplerOptions): number {
  if (
    typeof options.tickTimeoutMs === "number" &&
    Number.isFinite(options.tickTimeoutMs) &&
    options.tickTimeoutMs > 0
  ) {
    return options.tickTimeoutMs;
  }
  const computed = options.intervalMs * 2;
  return Math.max(10_000, Math.min(computed, 5 * 60_000));
}

async function runTick(rec: SamplerRecord): Promise<void> {
  if (rec.inFlight) {
    // Non-overlap contract: the previous tick is still running. Record
    // the skip with a structured reason so operators can see when an
    // interval keeps firing over a hung tick. We deliberately do *not*
    // start a second tick — even after a tick timeout, the underlying
    // promise may still be running, and starting a parallel tick would
    // violate the contract and could pile up DB load.
    rec.state.lastSkipReason = "previous_tick_still_running";
    rec.state.lastSkippedAt = Date.now();
    rec.state.totalSkips++;
    return;
  }
  rec.inFlight = true;
  rec.state.inFlight = true;
  rec.state.lastSkipReason = null;
  rec.state.tickTimedOutPending = false;
  const startedAt = Date.now();
  rec.state.lastTickStartedAt = startedAt;
  rec.state.totalTicks++;
  const t0 = performance.now();

  // Single owner of the in-flight release: an idempotent helper that
  // can be called from any settle path (tick success, tick failure,
  // timeout race winner, late settle after timeout). Whichever path
  // runs first releases — every subsequent caller is a no-op. This
  // makes the release deterministic regardless of the interleaving
  // between the timeout macrotask and the underlying tick's I/O
  // settle, eliminating the "stuck inFlight" race where both the
  // outer finally and the tickPromise.finally could otherwise observe
  // an in-between state and skip the release.
  let released = false;
  const releaseInFlight = (): void => {
    if (released) return;
    released = true;
    rec.inFlight = false;
    rec.state.inFlight = false;
    rec.state.tickTimedOutPending = false;
  };

  let pendingSettled = false;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // Build the underlying tick promise. Every settle path on this
  // promise must release the in-flight guard — including the late
  // settle that follows a tick timeout. The .finally() always calls
  // releaseInFlight(); the idempotency guard above ensures we don't
  // double-release if the racing await already cleaned up.
  const tickPromise: Promise<void> = Promise.resolve()
    .then(() => rec.options.tick())
    .then(
      () => {
        pendingSettled = true;
        if (timedOut) {
          // Late success after a timeout: log but do NOT mark success
          // (we already recorded the failure heartbeat). The release
          // below will let the next scheduled fire run.
          console.warn(
            `[Sampler:${rec.options.name}] late tick settled (success) after timeout`,
          );
        }
      },
      (err: unknown) => {
        pendingSettled = true;
        if (timedOut) {
          console.warn(
            `[Sampler:${rec.options.name}] late tick settled (failure) after timeout: ${summarizeError(err)}`,
          );
        } else {
          // Re-throw so the awaiter below routes through the catch path.
          throw err;
        }
      },
    )
    .finally(() => {
      // Always attempt release — releaseInFlight is idempotent.
      releaseInFlight();
    });

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        // Mark the "pending after timeout" flag synchronously here so
        // any observer sees a consistent state even before the outer
        // finally runs. (The flag is cleared by releaseInFlight when
        // the late settle eventually fires.)
        if (!pendingSettled) {
          rec.state.tickTimedOutPending = true;
        }
        reject(
          new Error(`tick exceeded timeout of ${rec.tickTimeoutMs}ms`),
        );
      }, rec.tickTimeoutMs);
    });
    await Promise.race([tickPromise, timeoutPromise]);
    // Race was won by the tick (or by a late settle that resolved void).
    if (!timedOut) {
      rec.state.lastTickSucceededAt = Date.now();
      rec.state.lastTickDurationMs = Math.round(performance.now() - t0);
      rec.state.consecutiveFailures = 0;
      rec.state.consecutiveSuccesses++;
      rec.state.totalSuccesses++;
      rec.state.lastErrorSummary = null;
    }
  } catch (err) {
    rec.state.lastTickFailedAt = Date.now();
    rec.state.lastTickDurationMs = Math.round(performance.now() - t0);
    rec.state.consecutiveFailures++;
    rec.state.consecutiveSuccesses = 0;
    rec.state.totalFailures++;
    rec.state.lastErrorSummary = summarizeError(err);
    console.warn(
      `[Sampler:${rec.options.name}] tick ${timedOut ? "timed out" : "failed"} (consecutive=${rec.state.consecutiveFailures}): ${rec.state.lastErrorSummary}`,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut && !pendingSettled) {
      // Non-overlap preserved: the underlying tick is still running.
      // Keep `inFlight` true (do NOT release) and rely on the late
      // settle of `tickPromise` to call `releaseInFlight()`. The
      // `tickTimedOutPending` flag is already set by the timeout
      // callback above; the next scheduled fire records a skip with
      // the proper reason via the inFlight guard at the top of
      // runTick.
    } else {
      // Either the tick won the race (success or sync failure) or it
      // already settled after the timeout: release now. Idempotent
      // so a subsequent late-settle .finally() is a no-op.
      releaseInFlight();
    }
  }
}

function scheduleSampler(rec: SamplerRecord): void {
  const fire = () => {
    // We deliberately do not await. The interval fires on a fixed cadence;
    // tick overlap is handled by the in-flight guard inside `runTick`.
    void runTick(rec);
  };
  const installInterval = () => {
    if (!rec.state.running) return;
    rec.timer = setInterval(fire, rec.options.intervalMs);
  };
  const delay = Math.max(0, rec.options.initialDelayMs ?? 0);
  rec.state.running = true;
  rec.state.startedAt = Date.now();
  if (delay === 0) {
    // Fire immediately, then install the interval. Avoids the
    // "initialDelay === intervalMs" double-fire window that would occur
    // if we started the interval in parallel with a setTimeout-backed
    // first tick.
    fire();
    installInterval();
  } else {
    rec.initialTimer = setTimeout(() => {
      rec.initialTimer = null;
      fire();
      installInterval();
    }, delay);
  }
  console.log(
    `[Sampler:${rec.options.name}] started — interval=${rec.options.intervalMs}ms, ` +
      `initialDelay=${delay}ms, tickTimeout=${rec.tickTimeoutMs}ms, ` +
      `watchdog=${rec.options.freshnessProbe ? "probe+heartbeat" : "heartbeat"}`,
  );
}

/**
 * Register and start a supervised sampler. Idempotent per `name`: calling
 * twice with the same name is a no-op (and returns the existing record's
 * runtime state). Use `stopSupervisedSampler(name)` to tear down.
 */
export function startSupervisedSampler(options: SamplerOptions): SamplerRuntimeState {
  if (!options.name || typeof options.name !== "string") {
    throw new Error("supervised sampler requires a non-empty name");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error(`supervised sampler '${options.name}' requires a positive intervalMs`);
  }
  const existing = samplers.get(options.name);
  if (existing) {
    return existing.state;
  }
  const maxStalenessMs = options.maxStalenessMs ?? options.intervalMs * 4;
  const tickTimeoutMs = resolveTickTimeoutMs(options);
  const state: SamplerRuntimeState = {
    name: options.name,
    intervalMs: options.intervalMs,
    running: false,
    startedAt: null,
    lastTickStartedAt: null,
    lastTickSucceededAt: null,
    lastTickFailedAt: null,
    lastTickDurationMs: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    totalTicks: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastErrorSummary: null,
    lastFreshnessAt: null,
    healthy: true,
    unhealthyReason: null,
    maxStalenessMs,
    hasFreshnessProbe: typeof options.freshnessProbe === "function",
    tickTimeoutMs,
    consecutiveMisses: 0,
    consecutiveHealthy: 0,
    recoveryAttempts: 0,
    lastRecoveryAt: null,
    inFlight: false,
    lastSkipReason: null,
    lastSkippedAt: null,
    totalSkips: 0,
    tickTimedOutPending: false,
  };
  const rec: SamplerRecord = {
    options,
    state,
    timer: null,
    initialTimer: null,
    inFlight: false,
    tickTimeoutMs,
  };
  samplers.set(options.name, rec);
  scheduleSampler(rec);
  return state;
}

export function stopSupervisedSampler(name: string): void {
  const rec = samplers.get(name);
  if (!rec) return;
  if (rec.timer) clearInterval(rec.timer);
  if (rec.initialTimer) clearTimeout(rec.initialTimer);
  rec.timer = null;
  rec.initialTimer = null;
  rec.state.running = false;
  samplers.delete(name);
}

export function getSupervisedSamplerStates(): SamplerRuntimeState[] {
  return Array.from(samplers.values()).map((r) => ({ ...r.state }));
}

export function getSupervisedSamplerState(name: string): SamplerRuntimeState | null {
  const rec = samplers.get(name);
  return rec ? { ...rec.state } : null;
}

// ─── Watchdog ────────────────────────────────────────────────────────────

const STALL_INCIDENT_METRIC = "health_sampler_stalled";
const stallIncidentIds = new Map<string, number>();

/**
 * Task #992 — swappable indirection over `healthIncidents` so unit
 * tests can observe the watchdog's incident emit / heartbeat / resolve
 * calls without going to the database. Production wires through
 * `await import("./healthIncidents")` lazily (matches the historical
 * dynamic-import behavior); tests can swap via `__test.setIncidentSink`.
 */
type IncidentSink = {
  ingestAlert: (typeof import("./healthIncidents"))["ingestAlert"];
  resolveIncident: (typeof import("./healthIncidents"))["resolveIncident"];
  touchIncidentHeartbeat: (typeof import("./healthIncidents"))["touchIncidentHeartbeat"];
};
let incidentSinkOverride: Partial<IncidentSink> | null = null;
async function getIncidentSink(): Promise<IncidentSink> {
  const real = await import("./healthIncidents");
  if (!incidentSinkOverride) return real;
  return {
    ingestAlert: incidentSinkOverride.ingestAlert ?? real.ingestAlert,
    resolveIncident: incidentSinkOverride.resolveIncident ?? real.resolveIncident,
    touchIncidentHeartbeat:
      incidentSinkOverride.touchIncidentHeartbeat ?? real.touchIncidentHeartbeat,
  };
}

function buildIncidentMetadata(
  rec: SamplerRecord,
  ageMs: number,
  reason: string,
): Record<string, unknown> {
  const lastSuccessAt = rec.state.lastTickSucceededAt;
  return {
    message: `Sampler '${rec.options.name}' ${reason}`,
    origin: rec.options.name,
    sampler_name: rec.options.name,
    sampler_interval_seconds: Math.round(rec.options.intervalMs / 1000),
    watchdog_threshold_seconds: Math.round(rec.state.maxStalenessMs / 1000),
    last_success_at: lastSuccessAt,
    last_success_iso: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
    seconds_since_last_success: lastSuccessAt
      ? Math.round((Date.now() - lastSuccessAt) / 1000)
      : null,
    seconds_since_observed_freshness: Math.round(ageMs / 1000),
    consecutive_misses: rec.state.consecutiveMisses,
    consecutive_failures: rec.state.consecutiveFailures,
    last_error_message: rec.state.lastErrorSummary,
    recovery_attempts: rec.state.recoveryAttempts,
    last_skip_reason: rec.state.lastSkipReason,
    last_skipped_at: rec.state.lastSkippedAt,
    total_skips: rec.state.totalSkips,
    tick_timed_out_pending: rec.state.tickTimedOutPending,
    last_recovery_at: rec.state.lastRecoveryAt,
    in_flight: rec.state.inFlight,
    last_freshness_probe_at: rec.state.lastFreshnessAt,
  };
}

async function emitStallIncident(rec: SamplerRecord, ageMs: number): Promise<void> {
  const lastSuccessAt = rec.state.lastTickSucceededAt;
  const sinceSuccess = lastSuccessAt
    ? `${Math.round((Date.now() - lastSuccessAt) / 1000)}s since last success`
    : "no success since startup";
  const reason = rec.state.lastErrorSummary
    ? `${sinceSuccess} (${rec.state.consecutiveMisses} consecutive missed checks); last error: ${rec.state.lastErrorSummary}`
    : `${sinceSuccess} (${rec.state.consecutiveMisses} consecutive missed checks)`;
  rec.state.healthy = false;
  rec.state.unhealthyReason = reason;

  // Task #992 — dedup. While the stall persists with unchanged
  // metadata, do NOT re-emit the incident or re-log the warning every
  // watchdog cycle. We only emit/log on the *transition* into stall
  // and on subsequent meaningful changes (new error, additional
  // recovery attempt, tick-timeout flip).
  //
  // CRITICAL: even when dedup'd we must still refresh the open
  // incident's `last_seen_at` heartbeat — the auto-stale-resolve
  // sweep would otherwise silently close an actively stalled
  // sampler after RESOLVE_AFTER_QUIET_MS / STALE_MAX_AGE_MS,
  // violating the "resolve only on real recovery" contract.
  const signature = buildStallSignature(rec);
  const prevSignature = lastEmittedStallSignature.get(rec.options.name);
  if (prevSignature === signature && stallIncidentIds.has(rec.options.name)) {
    try {
      const incidents = await getIncidentSink();
      await incidents.touchIncidentHeartbeat(
        {
          metric: STALL_INCIDENT_METRIC,
          value: Math.round(ageMs / 1000),
          threshold: Math.round(rec.state.maxStalenessMs / 1000),
          severity: "critical",
          message: `Sampler '${rec.options.name}' ${reason}`,
          origin: rec.options.name,
        },
        Date.now(),
      );
    } catch (err: any) {
      // A failed heartbeat is non-fatal; the next watchdog cycle
      // will retry. Log at debug-only volume to avoid the very
      // noise the dedup gate is here to prevent.
    }
    return;
  }
  lastEmittedStallSignature.set(rec.options.name, signature);

  console.warn(`[Sampler:${rec.options.name}] watchdog: ${reason}`);
  try {
    const incidents = await getIncidentSink();
    const metadata = buildIncidentMetadata(rec, ageMs, reason);
    const result = await incidents.ingestAlert({
      alert: {
        metric: STALL_INCIDENT_METRIC,
        value: Math.round(ageMs / 1000),
        threshold: Math.round(rec.state.maxStalenessMs / 1000),
        severity: "critical",
        message: `Sampler '${rec.options.name}' ${reason}`,
        origin: rec.options.name,
      },
      value: Math.round(ageMs / 1000),
      sampleTimestamp: Date.now(),
      metadata,
    });
    stallIncidentIds.set(rec.options.name, result.id);
  } catch (err: any) {
    console.warn(
      `[Sampler:${rec.options.name}] watchdog: failed to emit stall incident: ${summarizeError(err)}`,
    );
  }
}

async function clearStallIncident(rec: SamplerRecord): Promise<void> {
  const id = stallIncidentIds.get(rec.options.name);
  rec.state.healthy = true;
  rec.state.unhealthyReason = null;
  // Task #992 — reset dedup signature + restart-required gate so a
  // future stall correctly emits a fresh open incident and a fresh
  // first-warning log.
  lastEmittedStallSignature.delete(rec.options.name);
  restartRequiredLogged.delete(rec.options.name);
  rec.state.recoveryAttempts = 0;
  if (!id) return;
  try {
    const incidents = await getIncidentSink();
    await incidents.resolveIncident(id, `watchdog:${rec.options.name}`);
  } catch (err: any) {
    console.warn(
      `[Sampler:${rec.options.name}] watchdog: failed to resolve stall incident: ${summarizeError(err)}`,
    );
  } finally {
    stallIncidentIds.delete(rec.options.name);
  }
}

/**
 * In-process recovery attempt. If a sampler is observed stale and is not
 * currently in flight, fire a tick directly so we don't have to wait for
 * the next interval. Bounded by RECOVERY_COOLDOWN_MS so we don't spam the
 * tick on every watchdog pass while a tick is still in flight.
 */
function attemptRecovery(rec: SamplerRecord, now: number): void {
  if (!rec.state.running) return;
  if (rec.inFlight) return;
  if (
    rec.state.lastRecoveryAt !== null &&
    now - rec.state.lastRecoveryAt < RECOVERY_COOLDOWN_MS
  ) {
    return;
  }
  // Task #992 — bounded in-process recovery. Once we've burned the
  // attempts budget without progress, emit a one-time "restart
  // required" log and stop firing recovery ticks. The open incident
  // remains so operators see the condition on the dashboard / Slack.
  if (rec.state.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    if (!restartRequiredLogged.has(rec.options.name)) {
      restartRequiredLogged.add(rec.options.name);
      console.error(
        `[Sampler:${rec.options.name}] watchdog: in-process recovery exhausted ` +
          `after ${rec.state.recoveryAttempts} attempts — RESTART REQUIRED. ` +
          `Open stall incident remains until a fresh process succeeds two consecutive ticks.`,
      );
    }
    return;
  }
  rec.state.recoveryAttempts++;
  rec.state.lastRecoveryAt = now;
  console.warn(
    `[Sampler:${rec.options.name}] watchdog: in-process recovery attempt #${rec.state.recoveryAttempts}`,
  );
  // Fire-and-forget; runTick has its own try/catch and timeout.
  void runTick(rec);
}

async function evaluateSampler(rec: SamplerRecord, now: number): Promise<void> {
  if (!rec.state.running) return;

  // Run the optional freshness probe for diagnostics — record the value
  // but do not let probe failures themselves drive the watchdog.
  const probe = rec.options.freshnessProbe;
  if (probe) {
    try {
      const { withDbAttribution } = await import("../db");
      await withDbAttribution(
        `scheduler:supervised-sampler-watchdog:${rec.options.name}`,
        async () => {
          const v = await probe();
          if (typeof v === "number" && Number.isFinite(v)) {
            rec.state.lastFreshnessAt = v;
          }
        },
      );
    } catch (err: any) {
      console.warn(
        `[Sampler:${rec.options.name}] watchdog probe failed: ${summarizeError(err)}`,
      );
    }
  }

  // Startup grace: don't evaluate staleness for the first STARTUP_GRACE_INTERVALS.
  const startedAt = rec.state.startedAt ?? now;
  const graceMs = rec.options.intervalMs * STARTUP_GRACE_INTERVALS;
  if (now - startedAt < graceMs && rec.state.lastTickSucceededAt === null) {
    return;
  }

  // Heartbeat-driven freshness: prefer the in-memory tick heartbeat as the
  // primary signal. Fall back to the probe result if no tick has succeeded
  // yet (cold start with a slow first probe).
  const referenceTime =
    rec.state.lastTickSucceededAt ?? rec.state.lastFreshnessAt ?? startedAt;
  const ageMs = now - referenceTime;

  const isStale = ageMs > rec.state.maxStalenessMs;
  // Confirmed-failure escalation: opening an incident is not gated solely
  // on the slow miss-counter — a sampler whose ticks are throwing or
  // timing out has actually failed, regardless of heartbeat budget.
  const confirmedFailure =
    rec.state.consecutiveFailures >= FAILURES_TO_OPEN_INCIDENT;
  if (isStale) {
    rec.state.consecutiveMisses++;
    rec.state.consecutiveHealthy = 0;
    // Try to nudge the loop back to life before paging the operator.
    attemptRecovery(rec, now);
  } else {
    rec.state.consecutiveHealthy++;
    rec.state.consecutiveMisses = 0;
  }

  const shouldOpen =
    rec.state.consecutiveMisses >= MISSES_TO_OPEN_INCIDENT || confirmedFailure;
  const hadOpenIncident = stallIncidentIds.has(rec.options.name);

  if (shouldOpen) {
    await emitStallIncident(rec, ageMs);
  } else if (isStale) {
    // Soft-stall below hysteresis threshold: incident stays closed but
    // record the reason locally so /api/health/samplers consumers see
    // the degraded heartbeat.
    rec.state.healthy = false;
    rec.state.unhealthyReason = `soft-stall: ${Math.round(ageMs / 1000)}s since last success (miss ${rec.state.consecutiveMisses}/${MISSES_TO_OPEN_INCIDENT})`;
  } else {
    // Resolution requires REAL tick successes after the open, not just
    // a freshness-budget recovery — `consecutiveSuccesses` only advances
    // on a successful runTick, while `consecutiveHealthy` counts watchdog
    // evaluations and could be inflated by a probe-only freshness signal.
    if (
      hadOpenIncident &&
      rec.state.consecutiveSuccesses >= SUCCESSFUL_TICKS_TO_RESOLVE
    ) {
      await clearStallIncident(rec);
    } else if (!hadOpenIncident) {
      rec.state.healthy = true;
      rec.state.unhealthyReason = null;
    }
  }
}

async function watchdogTick(): Promise<void> {
  const now = Date.now();
  for (const rec of samplers.values()) {
    // Don't supervise the watchdog itself.
    if (rec.options.name === "supervised_sampler_watchdog") continue;
    try {
      await evaluateSampler(rec, now);
    } catch (err: any) {
      console.warn(
        `[Sampler:${rec.options.name}] watchdog evaluation crashed: ${summarizeError(err)}`,
      );
    }
  }
}

let watchdogStarted = false;

/**
 * Start the supervised-sampler watchdog. The watchdog itself runs *under*
 * a supervised sampler so it gets the same supervision guarantees (a probe
 * failure cannot kill the watchdog loop).
 */
export function startSamplerWatchdog(intervalMs: number = 60_000): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  startSupervisedSampler({
    name: "supervised_sampler_watchdog",
    intervalMs,
    initialDelayMs: intervalMs,
    tick: async () => {
      const { withDbAttribution } = await import("../db");
      await withDbAttribution("scheduler:supervised-sampler-watchdog", () =>
        watchdogTick(),
      );
    },
  });
}

// ─── Test-only helpers ───────────────────────────────────────────────────

export const __test = {
  reset(): void {
    for (const name of Array.from(samplers.keys())) {
      stopSupervisedSampler(name);
    }
    stallIncidentIds.clear();
    lastEmittedStallSignature.clear();
    restartRequiredLogged.clear();
    watchdogStarted = false;
  },
  runTickNow(name: string): Promise<void> {
    const rec = samplers.get(name);
    if (!rec) return Promise.resolve();
    return runTick(rec);
  },
  watchdogTickNow(): Promise<void> {
    return watchdogTick();
  },
  mutateState(name: string, patch: Partial<SamplerRuntimeState>): void {
    const rec = samplers.get(name);
    if (!rec) return;
    Object.assign(rec.state, patch);
  },
  hysteresis: {
    MISSES_TO_OPEN_INCIDENT,
    FAILURES_TO_OPEN_INCIDENT,
    SUCCESSFUL_TICKS_TO_RESOLVE,
    STARTUP_GRACE_INTERVALS,
    RECOVERY_COOLDOWN_MS,
  },
  setIncidentSink(override: Partial<IncidentSink> | null): void {
    incidentSinkOverride = override;
  },
};
