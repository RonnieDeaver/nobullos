/**
 * Generic operator-safety primitive for "resend this alert" admin actions.
 *
 * Goals:
 *  - Cooldown: prevent the same admin (or two admins) from spamming the same
 *    destination by clicking "Resend" repeatedly. The cooldown is keyed by
 *    `(alertType, alertId, destination)` so different destinations for the
 *    same alert can still be tried independently.
 *  - Idempotency: collapse concurrent in-flight resends of the same key into
 *    a single execution so a double-click never produces two outbound sends.
 *  - Trigger metadata: record who triggered each resend (and the source —
 *    typically "admin_ui" or "auto") so the action is auditable.
 *  - Structured outcome: callers receive a tagged result they can render in
 *    the UI / persist into per-alert history rows.
 *
 * State is in-memory; that mirrors how `manualReserveAlerts` and
 * `rateLimitAlertNotifier` already track cooldowns. A process restart simply
 * clears the cooldown which is the safe default (an operator who waits long
 * enough for a restart is not the spam case we are guarding against).
 */

export type ResendChannelStatus = "sent" | "failed" | "skipped";

export interface ResendActor {
  /** User id of the admin who pressed the resend button, or null for system. */
  userId: string | null;
  /** Free-form label (e.g. "admin_ui", "auto_retry"). */
  source: string;
}

export interface ResendChannelOutcome {
  destination: string;
  status: ResendChannelStatus;
  failureReason?: string | null;
}

export interface ResendExecutionResult {
  channels: ResendChannelOutcome[];
}

export interface ResendAttemptOptions<T extends ResendExecutionResult> {
  alertType: string;
  alertId: string;
  /**
   * Destinations being targeted (e.g. ["slack", "email"], or ["channel:C123",
   * "email:foo@bar"]). Each destination gets its own cooldown bucket. If the
   * caller doesn't have a useful per-destination key it can pass a single
   * synthetic destination like ["all"].
   */
  destinations: string[];
  actor: ResendActor;
  /**
   * Per-destination cooldown. Defaults to 60s — long enough to defeat
   * accidental double-clicks but short enough that a real retry after a
   * transient failure isn't blocked indefinitely.
   */
  cooldownMs?: number;
  /**
   * The actual broadcast/send. Only invoked once cooldown + idempotency
   * checks pass.
   */
  execute: () => Promise<T>;
}

export type ResendOutcome<T extends ResendExecutionResult> =
  | {
      status: "executed";
      result: T;
      executedAt: number;
      actor: ResendActor;
    }
  | {
      status: "cooldown";
      cooldownRemainingMs: number;
      lastAttemptAt: number;
      blockedDestinations: string[];
    }
  | {
      status: "in_flight";
    }
  | {
      status: "error";
      error: string;
    };

export interface ResendHistoryEntry {
  alertType: string;
  alertId: string;
  attemptedAt: number;
  actor: ResendActor;
  destinations: string[];
  channels: ResendChannelOutcome[];
}

const DEFAULT_COOLDOWN_MS = 60_000;
const HISTORY_RING_CAPACITY = 200;

// Task #2897 (Reserved VM memory audit) — cooldowns/lastByAlert are keyed
// by alert type+id (unbounded key space over a weeks-long uptime), so both
// are capped with oldest-insertion eviction. Evicting a cooldown merely
// re-allows a resend for a long-dead alert; evicting lastByAlert only
// loses "last resend" metadata for ancient alerts.
const MAX_TRACKED_ENTRIES = 2000;

function evictOldest(map: Map<string, unknown>, cap: number): void {
  while (map.size > cap) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    map.delete(oldestKey);
  }
}

const cooldowns = new Map<string, number>();
const inFlight = new Map<string, Promise<unknown>>();
const history: ResendHistoryEntry[] = [];
const lastByAlert = new Map<string, ResendHistoryEntry>();

function cooldownKey(alertType: string, alertId: string, destination: string): string {
  return `${alertType}::${alertId}::${destination}`;
}

function alertKey(alertType: string, alertId: string): string {
  return `${alertType}::${alertId}`;
}

/**
 * Single-flight key including the destination set. Two concurrent resend
 * attempts collapse only when they target *the same* set of destinations —
 * otherwise an admin retrying email shouldn't be blocked by an in-flight
 * Slack-only resend on the same alert.
 */
function inFlightKey(alertType: string, alertId: string, destinations: string[]): string {
  const normalized = [...destinations].sort().join("|");
  return `${alertType}::${alertId}::${normalized}`;
}

function pushHistory(entry: ResendHistoryEntry): void {
  history.push(entry);
  if (history.length > HISTORY_RING_CAPACITY) {
    history.splice(0, history.length - HISTORY_RING_CAPACITY);
  }
  lastByAlert.set(alertKey(entry.alertType, entry.alertId), entry);
  evictOldest(lastByAlert, MAX_TRACKED_ENTRIES);
}

/**
 * Attempt a guarded resend. See module docstring for guarantees.
 *
 * Cooldown semantics: if *any* requested destination is still cooling down,
 * the whole attempt is rejected with `status: "cooldown"`. Partial resends
 * (only some destinations cooled down) would defeat idempotency-by-alert and
 * are intentionally not supported here — callers should split into separate
 * `attemptResend` calls if they need per-destination policy.
 */
export async function attemptResend<T extends ResendExecutionResult>(
  opts: ResendAttemptOptions<T>,
): Promise<ResendOutcome<T>> {
  const { alertType, alertId, actor } = opts;
  const destinations = Array.from(new Set(opts.destinations.filter((d) => d.length > 0)));
  if (destinations.length === 0) {
    return { status: "error", error: "No destinations supplied to attemptResend" };
  }
  const cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const now = Date.now();

  // Cooldown check. We report the *largest* remaining cooldown across all
  // blocked destinations so callers don't under-display the wait time —
  // the attempt as a whole isn't eligible until every destination is.
  const blocked: string[] = [];
  let mostRecentBlockedAt = 0;
  let largestRemaining = 0;
  for (const dest of destinations) {
    const lastAt = cooldowns.get(cooldownKey(alertType, alertId, dest));
    if (typeof lastAt === "number") {
      const remaining = cooldownMs - (now - lastAt);
      if (remaining > 0) {
        blocked.push(dest);
        if (lastAt > mostRecentBlockedAt) mostRecentBlockedAt = lastAt;
        if (remaining > largestRemaining) largestRemaining = remaining;
      }
    }
  }
  if (blocked.length > 0) {
    return {
      status: "cooldown",
      cooldownRemainingMs: largestRemaining,
      lastAttemptAt: mostRecentBlockedAt,
      blockedDestinations: blocked,
    };
  }

  // Idempotency / single-flight: collapse concurrent identical attempts.
  // Keyed on the destination set so two admins resending the *same*
  // (alertType, alertId, destinations) collapse to one execution, while a
  // resend targeting a disjoint destination set on the same alert can
  // proceed in parallel.
  const aKey = inFlightKey(alertType, alertId, destinations);
  if (inFlight.has(aKey)) {
    return { status: "in_flight" };
  }

  const promise = (async (): Promise<ResendOutcome<T>> => {
    let result: T;
    try {
      result = await opts.execute();
    } catch (err: any) {
      return { status: "error", error: err?.message ? String(err.message) : String(err) };
    }
    const executedAt = Date.now();
    // Mark cooldowns for every destination we successfully attempted, even
    // ones that ultimately failed — the operator-safety goal is "don't
    // hammer the same target", which applies regardless of outcome.
    for (const dest of destinations) {
      cooldowns.set(cooldownKey(alertType, alertId, dest), executedAt);
    }
    evictOldest(cooldowns, MAX_TRACKED_ENTRIES);
    pushHistory({
      alertType,
      alertId,
      attemptedAt: executedAt,
      actor,
      destinations,
      channels: result.channels,
    });
    return { status: "executed", result, executedAt, actor };
  })();

  inFlight.set(aKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(aKey);
  }
}

/** Last recorded resend for the (alertType, alertId) tuple, if any. */
export function getLastResend(alertType: string, alertId: string): ResendHistoryEntry | null {
  return lastByAlert.get(alertKey(alertType, alertId)) ?? null;
}

/**
 * Recent resends for the given (alertType[, alertId]) tuple, newest first.
 * Used by admin UIs to render "who recently resent this alert".
 */
export function listRecentResends(filter?: {
  alertType?: string;
  alertId?: string;
  limit?: number;
}): ResendHistoryEntry[] {
  const limit = Math.max(1, Math.min(filter?.limit ?? 50, HISTORY_RING_CAPACITY));
  let rows = history;
  if (filter?.alertType) {
    rows = rows.filter((r) => r.alertType === filter.alertType);
  }
  if (filter?.alertId) {
    rows = rows.filter((r) => r.alertId === filter.alertId);
  }
  return rows.slice(-limit).reverse();
}

/** Test-only: wipe all guard state. */
export function __resetAlertResendGuardForTest(): void {
  cooldowns.clear();
  inFlight.clear();
  history.length = 0;
  lastByAlert.clear();
}

export const ALERT_RESEND_GUARD_DEFAULT_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
