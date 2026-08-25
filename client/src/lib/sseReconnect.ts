/**
 * Task #2840 — shared SSE reconnect policy.
 *
 * Root-cause finding: the "SSE connection drops every 5–6 s" pattern in the
 * production logs was NOT a load-balancer/proxy idle-timeout dropping
 * established connections. Direct probes (authenticated EventSource held
 * against both localhost and the public replit.dev proxy) kept the stream
 * open for 65+ s with only the 25 s server heartbeats — no in-process or
 * proxy drop. The ~5–6 s cadence in the logs was the client's own FIXED
 * 5-second retry timer re-issuing FAILED connection attempts (401 dead
 * session, 429 rate-limited): each attempt logs one request line, spaced
 * ~5–6 s apart (5 s timer + request latency), which reads exactly like "the
 * connection drops every 5–6 seconds".
 *
 * Policy:
 *  - A connection that stayed open ≥ HEALTHY_CONNECTION_MS before erroring
 *    was genuinely established and then dropped (network blip, deploy,
 *    proxy recycling). Reconnect quickly and reset the failure streak.
 *  - A connection that errored quickly (non-200 response, network refuse)
 *    is a failure loop — back off exponentially so a dead session or an
 *    exhausted rate-limit bucket is retried at 5 s → 10 s → 20 s → … capped,
 *    instead of hammering every 5 s forever.
 *  - Jitter (±20 %) prevents multiple tabs from reconnecting in lockstep.
 */

export const SSE_HEALTHY_CONNECTION_MS = 30_000;
export const SSE_QUICK_RECONNECT_MS = 1_000;
export const SSE_BACKOFF_BASE_MS = 5_000;
export const SSE_BACKOFF_MAX_MS = 120_000;
export const SSE_JITTER_RATIO = 0.2;
// Task #2880 — dead-session stop-retrying threshold. After this many
// consecutive rapid failures, the caller should probe for a 401 (dead
// session) and, if confirmed, stop reconnecting and surface a re-login
// prompt instead of hammering the endpoint forever at the max backoff.
// At the max backoff cap (120 s) with jitter ≈ 144 s per attempt, the
// threshold represents ~20 minutes of silent retries before giving up —
// long enough to survive a transient outage, short enough not to loop
// forever on a dead session.
export const SSE_MAX_CONSECUTIVE_FAILURES = 8;

export interface SseReconnectState {
  /** Consecutive rapid failures (connections that died before
   *  SSE_HEALTHY_CONNECTION_MS). Reset to 0 after a healthy connection. */
  consecutiveFailures: number;
  /** Delay before the next connection attempt, jitter already applied. */
  delayMs: number;
}

/**
 * Compute the next reconnect state after an EventSource error.
 *
 * @param prevConsecutiveFailures failure streak before this error
 * @param connectionLifetimeMs    how long the connection was open (ms)
 * @param random                  injectable RNG (0..1) for deterministic tests
 */
export function nextSseReconnectState(
  prevConsecutiveFailures: number,
  connectionLifetimeMs: number,
  random: () => number = Math.random,
): SseReconnectState {
  if (connectionLifetimeMs >= SSE_HEALTHY_CONNECTION_MS) {
    // Healthy connection that dropped — reconnect fast, reset the streak.
    return {
      consecutiveFailures: 0,
      delayMs: applyJitter(SSE_QUICK_RECONNECT_MS, random),
    };
  }
  const failures = prevConsecutiveFailures + 1;
  const raw = Math.min(
    SSE_BACKOFF_BASE_MS * 2 ** (failures - 1),
    SSE_BACKOFF_MAX_MS,
  );
  return { consecutiveFailures: failures, delayMs: applyJitter(raw, random) };
}

function applyJitter(baseMs: number, random: () => number): number {
  // Uniform in [1 - r, 1 + r] where r = SSE_JITTER_RATIO.
  const factor = 1 - SSE_JITTER_RATIO + random() * SSE_JITTER_RATIO * 2;
  return Math.round(baseMs * factor);
}
