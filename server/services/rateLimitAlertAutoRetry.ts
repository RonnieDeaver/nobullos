// Background auto-retry scheduler for failed rate-limit alert notifications.
// Tick interval is short (1 minute) so we react quickly when destinations
// recover, but the actual retry decision is gated by the configured
// `minIntervalMinutes` and per-chain dedupe in `runAutoRetryPass`. The
// same tick also runs the queued-digest growth check (#648) — both rely
// on a periodic poll of the in-memory queue/DB so they share a timer.
import {
  checkDigestGrowthOnce,
  loadAutoRetryConfig,
  recordDigestGrowthSample,
  runAutoRetryPass,
} from "./rateLimitAlertNotifier";
import { withDbAttribution } from "../db";

const TICK_INTERVAL_MS = 60_000;
let tickTimer: NodeJS.Timeout | null = null;
let running = false;

export async function runAutoRetryTickOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cfg = await loadAutoRetryConfig();
    if (cfg.enabled) {
      try {
        const result = await runAutoRetryPass(null);
        if (result.retried > 0 || result.skipped > 0) {
          console.log(
            `[RateLimitAlertAutoRetry] tick scanned=${result.scanned} retried=${result.retried} skipped=${result.skipped}`,
          );
        }
      } catch (err: any) {
        console.error("[RateLimitAlertAutoRetry] auto-retry pass failed:", err?.message ?? err);
      }
    }
    try {
      recordDigestGrowthSample();
    } catch (err: any) {
      console.error("[RateLimitAlertAutoRetry] digest growth sample failed:", err?.message ?? err);
    }
    try {
      await checkDigestGrowthOnce();
    } catch (err: any) {
      console.error("[RateLimitAlertAutoRetry] digest growth check failed:", err?.message ?? err);
    }
  } finally {
    running = false;
  }
}

export function startRateLimitAlertAutoRetryScheduler(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void withDbAttribution("scheduler:rate-limit-alert-auto-retry", () => runAutoRetryTickOnce());
  }, TICK_INTERVAL_MS);
  if (typeof tickTimer.unref === "function") tickTimer.unref();
  console.log(
    `[RateLimitAlertAutoRetry] Scheduler started (tick=${TICK_INTERVAL_MS / 1000}s)`,
  );
  // Run once shortly after boot so a fresh start can pick up retries
  // without waiting a full tick.
  setTimeout(() => {
    void withDbAttribution("startup:rate-limit-alert-auto-retry-initial", () => runAutoRetryTickOnce());
  }, 10_000);
}

export function stopRateLimitAlertAutoRetryScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log("[RateLimitAlertAutoRetry] Scheduler stopped");
  }
}
