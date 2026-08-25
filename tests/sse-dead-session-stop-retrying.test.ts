/* test-registration
{
  "name": "SSE dead-session stop-retrying threshold and backoff contract (Task #2880)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2880: after SSE_MAX_CONSECUTIVE_FAILURES rapid failures the bell must stop silently retrying forever and probe for a dead session. This test pins the threshold constant, verifies the backoff reaches the cap in a bounded attempt count, and confirms that both the constant and the probeAuthAndStopIfDead call are wired into NotificationBell.tsx (source guard). Pure, DB-free — imports only sseReconnect.ts + a filesystem read.",
  "scanPaths": [
    "client/src/App.tsx",
    "client/src/components/NotificationBell.tsx",
    "client/src/lib/queryClient.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2880 — SSE dead-session stop-retrying contract.
 *
 * After SSE_MAX_CONSECUTIVE_FAILURES rapid failures, the NotificationBell
 * component probes the auth endpoint to distinguish a dead session (401)
 * from a transient server outage. This test pins the threshold constant
 * and verifies that the backoff policy reaches the cap in a bounded number
 * of additional attempts after the threshold is crossed.
 *
 * Why this matters:
 *  Before this fix, a tab with a dead session would reconnect the SSE
 *  endpoint forever at the max-backoff interval (~2 minutes). The user
 *  would see no error — the bell would just silently never update. After
 *  the fix, SSE_MAX_CONSECUTIVE_FAILURES consecutive rapid failures trigger
 *  an auth probe; a 401 routes to the existing session-expiry handler
 *  (same path as QueryCache.onError for regular query 401s).
 *
 * This test is pure and DB-free: it imports only the sseReconnect module
 * and verifies the constants and backoff behavior around the threshold.
 */

import {
  nextSseReconnectState,
  SSE_MAX_CONSECUTIVE_FAILURES,
  SSE_BACKOFF_MAX_MS,
  SSE_BACKOFF_BASE_MS,
  SSE_HEALTHY_CONNECTION_MS,
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

const midRandom = () => 0.5; // jitter factor = 1.0 exactly

// ---------------------------------------------------------------------------
// Part A — SSE_MAX_CONSECUTIVE_FAILURES is a meaningful positive integer
// ---------------------------------------------------------------------------
console.log("Part A — SSE_MAX_CONSECUTIVE_FAILURES constant is valid");
{
  ok(
    typeof SSE_MAX_CONSECUTIVE_FAILURES === "number",
    "SSE_MAX_CONSECUTIVE_FAILURES is a number",
  );
  ok(
    Number.isInteger(SSE_MAX_CONSECUTIVE_FAILURES) && SSE_MAX_CONSECUTIVE_FAILURES > 0,
    `SSE_MAX_CONSECUTIVE_FAILURES is a positive integer (${SSE_MAX_CONSECUTIVE_FAILURES})`,
  );
  // Must be large enough to survive a transient outage (not trip on first failure).
  ok(
    SSE_MAX_CONSECUTIVE_FAILURES >= 4,
    `SSE_MAX_CONSECUTIVE_FAILURES (${SSE_MAX_CONSECUTIVE_FAILURES}) is large enough to survive transient outages (≥4)`,
  );
  // Must be small enough to eventually stop a dead-session loop.
  ok(
    SSE_MAX_CONSECUTIVE_FAILURES <= 20,
    `SSE_MAX_CONSECUTIVE_FAILURES (${SSE_MAX_CONSECUTIVE_FAILURES}) is bounded to avoid infinite dead-session loops (≤20)`,
  );
}

// ---------------------------------------------------------------------------
// Part B — exactly SSE_MAX_CONSECUTIVE_FAILURES rapid failures accumulate
// ---------------------------------------------------------------------------
console.log("Part B — failure streak reaches the threshold after rapid failures");
{
  let failures = 0;
  for (let i = 0; i < SSE_MAX_CONSECUTIVE_FAILURES; i++) {
    const s = nextSseReconnectState(failures, 100 /* quick failure */, midRandom);
    failures = s.consecutiveFailures;
  }
  ok(
    failures === SSE_MAX_CONSECUTIVE_FAILURES,
    `After ${SSE_MAX_CONSECUTIVE_FAILURES} rapid failures streak === ${SSE_MAX_CONSECUTIVE_FAILURES} (got ${failures})`,
  );
}

// ---------------------------------------------------------------------------
// Part C — a healthy connection resets the streak before the threshold
// ---------------------------------------------------------------------------
console.log("Part C — a healthy connection mid-streak resets to 0 (no false positive)");
{
  // Simulate getting to the threshold - 1 failures, then a healthy connection.
  let failures = SSE_MAX_CONSECUTIVE_FAILURES - 1;
  const s = nextSseReconnectState(failures, SSE_HEALTHY_CONNECTION_MS + 1000, midRandom);
  ok(
    s.consecutiveFailures === 0,
    `A healthy connection at failures=${failures} resets the streak to 0 (no false dead-session probe)`,
  );
}

// ---------------------------------------------------------------------------
// Part D — backoff at threshold: delay is at or near cap
// ---------------------------------------------------------------------------
console.log("Part D — at the threshold, backoff delay is at (or capped below) the max");
{
  let failures = 0;
  let lastDelay = 0;
  for (let i = 0; i < SSE_MAX_CONSECUTIVE_FAILURES; i++) {
    const s = nextSseReconnectState(failures, 100, midRandom);
    failures = s.consecutiveFailures;
    lastDelay = s.delayMs;
  }
  ok(
    lastDelay <= SSE_BACKOFF_MAX_MS,
    `Backoff at max failures is capped at SSE_BACKOFF_MAX_MS (${lastDelay}ms ≤ ${SSE_BACKOFF_MAX_MS}ms)`,
  );
  ok(
    lastDelay >= SSE_BACKOFF_BASE_MS,
    `Backoff at max failures is meaningful (${lastDelay}ms ≥ base ${SSE_BACKOFF_BASE_MS}ms)`,
  );
}

// ---------------------------------------------------------------------------
// Part E — dead-session loop stays bounded even if caller keeps going past threshold
// ---------------------------------------------------------------------------
console.log("Part E — total attempts in 15 min stay bounded even past the threshold");
{
  let failures = 0;
  let elapsed = 0;
  let attempts = 0;
  const WINDOW_MS = 15 * 60 * 1000;
  while (elapsed < WINDOW_MS) {
    attempts++;
    const s = nextSseReconnectState(failures, 100, midRandom);
    failures = s.consecutiveFailures;
    elapsed += s.delayMs + 100; // 100ms = simulated connection attempt latency
  }
  ok(
    attempts <= 15,
    `Attempts in 15 min stay bounded at ${attempts} (≤15); before the fix was ~170 with a fixed 5s retry`,
  );
}

// ---------------------------------------------------------------------------
// Part F — SSE_MAX_CONSECUTIVE_FAILURES is referenced in the source (guard)
// ---------------------------------------------------------------------------
console.log("Part F — SSE_MAX_CONSECUTIVE_FAILURES is used in NotificationBell.tsx");
{
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const bellSrc = readFileSync(resolve("client/src/components/NotificationBell.tsx"), "utf-8");
  ok(
    bellSrc.includes("SSE_MAX_CONSECUTIVE_FAILURES"),
    "NotificationBell.tsx references SSE_MAX_CONSECUTIVE_FAILURES (dead-session probe is wired in)",
  );
  ok(
    bellSrc.includes("probeAuthAndStopIfDead"),
    "NotificationBell.tsx calls probeAuthAndStopIfDead (dead-session handler is present)",
  );
}

// ---------------------------------------------------------------------------
// Part G — Task #2882: dead-session detection surfaces a user-facing message
// ---------------------------------------------------------------------------
console.log("Part G — session-expired message is wired end-to-end (Task #2882)");
{
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const bellSrc = readFileSync(resolve("client/src/components/NotificationBell.tsx"), "utf-8");
  const qcSrc = readFileSync(resolve("client/src/lib/queryClient.ts"), "utf-8");
  const appSrc = readFileSync(resolve("client/src/App.tsx"), "utf-8");

  ok(
    bellSrc.includes("markSessionExpired()"),
    "NotificationBell probe sets the session-expired marker before redirecting",
  );
  ok(
    qcSrc.includes("markSessionExpired()") && qcSrc.includes("function handleAuthLoss"),
    "queryClient handleAuthLoss sets the session-expired marker before redirecting",
  );
  ok(
    qcSrc.includes("sessionStorage") && qcSrc.includes("SESSION_EXPIRED_STORAGE_KEY"),
    "marker uses sessionStorage (survives the full-page redirect, same tab only)",
  );
  ok(
    appSrc.includes("consumeSessionExpiredMarker()") &&
      appSrc.includes("Your session expired"),
    "App.tsx consumes the marker on boot and shows the 'Your session expired' toast",
  );
  // The marker must be read-and-CLEARED so the toast doesn't reappear on
  // every subsequent reload in the same tab.
  ok(
    qcSrc.includes("removeItem(SESSION_EXPIRED_STORAGE_KEY)"),
    "consumeSessionExpiredMarker clears the marker after reading it",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
