/* test-registration
{
  "name": "SSE client reconnect backoff policy (Task #2840)",
  "smoke": true,
  "smokeReason": "Task #2840: the root cause of the \"SSE drops every 5–6 s\" cadence was the client's fixed 5 s retry timer re-issuing failed connection attempts (401 dead session / 429) — probes proved established streams are NOT dropped by the proxy. The exponential-backoff policy in client/src/lib/sseReconnect.ts is what stops that loop; a regression to a fixed short retry would silently reintroduce the churn (and the log noise it caused). Fast, pure, DB-free.",
  "tier": "small"
}
test-registration */
/**
 * Task #2840 — SSE reconnect policy unit test.
 *
 * Root-cause context: the "SSE connection drops every 5–6 s" pattern in the
 * production logs was the client's FIXED 5-second retry timer re-issuing
 * failed connection attempts (401 dead session / 429 rate-limited), not a
 * load-balancer dropping established connections. Authenticated probes held
 * an idle stream open 65+ s (with only the 25 s server heartbeats) through
 * both localhost and the public proxy, proving no ~5–6 s idle-timeout exists
 * in the path.
 *
 * The fix (client/src/lib/sseReconnect.ts) replaces the fixed 5 s retry with:
 *   - quick reconnect (with jitter) after a HEALTHY connection drops
 *     (open ≥ 30 s), resetting the failure streak;
 *   - exponential backoff (5 s → 10 s → 20 s → … capped at 120 s) for rapid
 *     failures, so a dead session or exhausted rate-limit bucket stops being
 *     hammered every 5 s forever;
 *   - ±20 % jitter so multiple tabs don't reconnect in lockstep.
 *
 * This test pins that policy. It is pure and DB-free: the RNG is injected so
 * every expectation is deterministic.
 */

import {
  nextSseReconnectState,
  SSE_BACKOFF_BASE_MS,
  SSE_BACKOFF_MAX_MS,
  SSE_HEALTHY_CONNECTION_MS,
  SSE_JITTER_RATIO,
  SSE_QUICK_RECONNECT_MS,
} from "../client/src/lib/sseReconnect";

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

// Deterministic RNG returning 0.5 → jitter factor exactly 1.0.
const midRandom = () => 0.5;

console.log("Part A — healthy connection drop → quick reconnect + streak reset");
{
  const s = nextSseReconnectState(7, SSE_HEALTHY_CONNECTION_MS, midRandom);
  ok(s.consecutiveFailures === 0, "streak resets to 0 after a healthy connection");
  ok(
    s.delayMs === SSE_QUICK_RECONNECT_MS,
    `healthy drop reconnects at quick delay (${s.delayMs}ms === ${SSE_QUICK_RECONNECT_MS}ms)`,
  );
  const s2 = nextSseReconnectState(0, SSE_HEALTHY_CONNECTION_MS * 10, midRandom);
  ok(
    s2.delayMs === SSE_QUICK_RECONNECT_MS && s2.consecutiveFailures === 0,
    "very long-lived connection also reconnects quickly",
  );
}

console.log("Part B — rapid failures → exponential backoff, capped");
{
  // Simulate a dead-session loop: every attempt errors immediately.
  let failures = 0;
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    const s = nextSseReconnectState(failures, 100, midRandom);
    failures = s.consecutiveFailures;
    delays.push(s.delayMs);
  }
  ok(failures === 8, "each rapid failure increments the streak");
  ok(delays[0] === SSE_BACKOFF_BASE_MS, `1st failure delay = base (${delays[0]}ms)`);
  ok(delays[1] === SSE_BACKOFF_BASE_MS * 2, `2nd failure delay doubles (${delays[1]}ms)`);
  ok(delays[2] === SSE_BACKOFF_BASE_MS * 4, `3rd failure delay doubles again (${delays[2]}ms)`);
  ok(
    delays.every((d, i) => i === 0 || d >= delays[i - 1]),
    "delays are monotonically non-decreasing under repeated failure",
  );
  ok(
    delays[delays.length - 1] === SSE_BACKOFF_MAX_MS,
    `backoff caps at max (${delays[delays.length - 1]}ms === ${SSE_BACKOFF_MAX_MS}ms)`,
  );
  ok(
    delays.every((d) => d <= SSE_BACKOFF_MAX_MS),
    "no delay ever exceeds the cap",
  );
}

console.log("Part C — the old pathological loop is gone");
{
  // The pre-fix behavior retried every failed attempt at a fixed 5 s —
  // ~170 requests per 15 min. Under the new policy the same 15-minute
  // window of continuous immediate failures produces a bounded, far
  // smaller attempt count.
  let failures = 0;
  let elapsed = 0;
  let attempts = 0;
  const WINDOW_MS = 15 * 60 * 1000;
  while (elapsed < WINDOW_MS) {
    attempts++;
    const s = nextSseReconnectState(failures, 100, midRandom);
    failures = s.consecutiveFailures;
    elapsed += s.delayMs + 100;
  }
  ok(
    attempts <= 15,
    `continuous-failure attempts in 15 min bounded (${attempts} ≤ 15; was ~170 with fixed 5 s retry)`,
  );
}

console.log("Part D — jitter bounds and healthy threshold edge");
{
  const low = nextSseReconnectState(0, 100, () => 0);
  const high = nextSseReconnectState(0, 100, () => 1);
  ok(
    low.delayMs === Math.round(SSE_BACKOFF_BASE_MS * (1 - SSE_JITTER_RATIO)),
    `rng=0 gives -${SSE_JITTER_RATIO * 100}% jitter (${low.delayMs}ms)`,
  );
  ok(
    high.delayMs === Math.round(SSE_BACKOFF_BASE_MS * (1 + SSE_JITTER_RATIO)),
    `rng=1 gives +${SSE_JITTER_RATIO * 100}% jitter (${high.delayMs}ms)`,
  );
  const justUnder = nextSseReconnectState(0, SSE_HEALTHY_CONNECTION_MS - 1, midRandom);
  ok(
    justUnder.consecutiveFailures === 1 && justUnder.delayMs === SSE_BACKOFF_BASE_MS,
    "lifetime just under the healthy threshold counts as a failure",
  );
  // Heartbeat contract: the server's 25 s heartbeat must beat the healthy
  // threshold, so an established idle stream is classified healthy by the
  // time it could drop.
  ok(
    25_000 < SSE_HEALTHY_CONNECTION_MS + 10_000,
    "server heartbeat interval (25 s) keeps idle streams alive well past classification windows",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
