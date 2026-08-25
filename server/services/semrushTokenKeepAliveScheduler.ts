// @db-pool-intent: worker
//
// Proactive SEMrush token keep-alive scheduler.
//
// SEMrush OAuth tokens issued via Device Flow last 7 days (access token) with
// a 30-day rotating refresh token. During quiet periods the token is not
// exercised and eventually expires, causing a fleet-wide paused_auth outage
// (confirmed: Jul 1–15 2026 outage caused by this exact mechanism). This
// scheduler ticks on a fixed interval and proactively rotates the token 48 h
// before its expiry so a quiet deployment can never let it silently expire.
//
// Lifecycle mirrors the other deployment-gated, cross-instance-singleton
// schedulers (zoomTokenKeepAliveScheduler / appBackupScheduler):
//   1. Deployment-gated: the deployed app holds the live (prod) SEMrush tokens
//      and is the always-on process whose quiet periods actually matter.
//      Set SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE=1 to run it locally (tests).
//   2. Cross-instance singleton: each tick takes a cluster-wide Postgres
//      advisory lock so exactly ONE autoscale instance rotates per tick
//      (concurrent rotations would race the rotating-refresh-token chain;
//      the lock self-heals when the holder crashes).
//   3. Worker pool: all DB work runs via runWithWorkerDb.
//
// The tick body itself is non-authoritative — a terminal refresh failure here
// never engages the global auth-dead breaker or wipes tokens (see
// runSemrushTokenKeepAliveTick). A keepalive terminal error fires an operator
// in-app/Slack alert via integration.semrush.keepalive_terminal so the admin
// knows to reconnect before the real expiry hits.

import { runWithWorkerDb, withDbAttribution } from "../db";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { runSemrushTokenKeepAliveTick } from "./semrushApi";

const INTERVAL_SETTING = "semrush_token_keepalive_interval_ms";
// Task #3661 — durable last-run/last-success heartbeat so "the keep-alive is
// silently not running in this deployment" is visible in the Integrations
// Hub instead of only discoverable during an outage post-mortem.
export const KEEPALIVE_HEARTBEAT_SETTING = "semrush_token_keepalive_heartbeat";

export interface SemrushKeepAliveHeartbeat {
  lastRunAt: string;
  lastAction: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

async function writeHeartbeat(action: string, error: string | null): Promise<void> {
  try {
    const prevRow = await getSystemSetting(KEEPALIVE_HEARTBEAT_SETTING).catch(() => undefined);
    let prev: SemrushKeepAliveHeartbeat | null = null;
    try {
      prev = prevRow?.value ? (JSON.parse(prevRow.value) as SemrushKeepAliveHeartbeat) : null;
    } catch {
      prev = null;
    }
    const now = new Date().toISOString();
    // "Success" = the tick ran to a non-error conclusion (refreshed, or a
    // routine skip such as token-still-fresh/disabled). Errors keep the last
    // success timestamp so the operator can see how stale it is.
    const isSuccess = action !== "terminal_error" && action !== "transient_error" && action !== "tick_failed";
    const hb: SemrushKeepAliveHeartbeat = {
      lastRunAt: now,
      lastAction: action,
      lastSuccessAt: isSuccess ? now : prev?.lastSuccessAt ?? null,
      lastError: error ? error.slice(0, 300) : null,
    };
    await setSystemSetting(KEEPALIVE_HEARTBEAT_SETTING, JSON.stringify(hb), "system");
  } catch (err: any) {
    console.warn("[SemrushKeepAlive] heartbeat write failed:", err?.message ?? err);
  }
}

export async function getSemrushKeepAliveHeartbeat(): Promise<SemrushKeepAliveHeartbeat | null> {
  try {
    const row = await getSystemSetting(KEEPALIVE_HEARTBEAT_SETTING);
    if (!row?.value) return null;
    return JSON.parse(row.value) as SemrushKeepAliveHeartbeat;
  } catch {
    return null;
  }
}
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h (token lasts 7 days)
const MIN_INTERVAL_MS = 60_000; // never tighter than 1 min
const SINGLETON_KEY = "semrush_token_keepalive";

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Local escape hatch so the keep-alive can run in the workspace / tests
 * without a deploy (mirrors ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE).
 */
function isForceEnabled(): boolean {
  const v = process.env.SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function resolveIntervalMs(): Promise<number> {
  try {
    const s = await getSystemSetting(INTERVAL_SETTING);
    const n = s?.value ? parseInt(s.value, 10) : NaN;
    if (Number.isFinite(n) && n >= MIN_INTERVAL_MS) return n;
  } catch {
    /* fall through to default */
  }
  return DEFAULT_INTERVAL_MS;
}

/**
 * Task #4762 — the loop's own cadence, exported so status predicates (the
 * `semrush_keepalive_rotate_now` prod-action) judge heartbeat staleness
 * relative to the CONFIGURED interval instead of a hard-coded window. The
 * old 4h predicate against a 6h loop re-armed the row between every pair
 * of healthy ticks — a perpetual amber.
 */
export async function getSemrushKeepAliveIntervalMs(): Promise<number> {
  return resolveIntervalMs();
}

/**
 * Task #4762 — whether the scheduler would actually run in THIS
 * environment: deployments, or the local force-enable escape hatch.
 * Key-mode dormancy is a separate, earlier check (isSemrushKeyMode).
 */
export function isSemrushKeepAliveSchedulerEligibleHere(): boolean {
  return isRunningInDeployment() || isForceEnabled();
}

async function tick(): Promise<void> {
  if (running) return; // never overlap with a previous slow run
  running = true;
  try {
    const result = await runWithWorkerDb(() =>
      withDbAttribution("scheduler:semrush-token-keepalive", () => runSemrushTokenKeepAliveTick()),
    );
    // Task #3661 — persist the heartbeat for every tick outcome.
    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:semrush-token-keepalive-heartbeat", () =>
        writeHeartbeat(
          result.action,
          result.action === "terminal_error"
            ? (result as any).oauthError ?? null
            : result.action === "transient_error"
              ? (result as any).message ?? null
              : null,
        ),
      ),
    );
    switch (result.action) {
      case "refreshed":
        console.log("[SemrushKeepAlive] Proactively rotated the SEMrush token before expiry");
        break;
      case "terminal_error":
        console.warn(
          `[SemrushKeepAlive] Proactive refresh hit a terminal error (breaker NOT engaged — keep-alive is non-authoritative): ${result.oauthError ?? "?"}`,
        );
        // Fire an operator alert so the admin knows to reconnect before the
        // actual token expiry arrives. Non-blocking, best-effort.
        void (async () => {
          try {
            const { notifyByType } = await import("./notifications/dispatcher");
            await notifyByType(
              "integration.semrush.keepalive_terminal",
              {
                text:
                  `*SEMrush keep-alive proactive refresh failed terminally.* ` +
                  `The breaker has NOT been engaged yet (non-authoritative path), but the access token ` +
                  `will not be proactively renewed until this is resolved. ` +
                  `Re-authorize SEMrush in Settings → Integrations Hub before the token expires. ` +
                  `Error: ${result.oauthError ?? "unknown"}`,
              },
              {
                triggerSource: "scheduled",
                dedupeKey: "semrush.keepalive.terminal",
              },
            );
          } catch (alertErr: any) {
            console.warn(
              "[SemrushKeepAlive] Failed to send terminal-error operator alert:",
              alertErr?.message ?? alertErr,
            );
          }
        })();
        break;
      case "transient_error":
        console.warn(`[SemrushKeepAlive] Proactive refresh transient error: ${result.message}`);
        break;
      default:
        // skipped — silent (disabled / breaker_open / no_tokens / fresh are
        // all routine no-ops).
        break;
    }
  } catch (err: any) {
    console.warn("[SemrushKeepAlive] tick failed:", err?.message ?? err);
    // Best-effort heartbeat so a crashing tick is still visible in the Hub.
    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:semrush-token-keepalive-heartbeat", () =>
        writeHeartbeat("tick_failed", String(err?.message ?? err)),
      ),
    ).catch(() => {});
  } finally {
    running = false;
  }
}

export async function startSemrushTokenKeepAliveScheduler(): Promise<void> {
  if (scheduler) return;
  // Task #3670 — v4 API-key mode: nothing to keep alive (the key has no
  // 7-day expiry), so the scheduler stays dormant entirely. The tick body
  // also guards itself (skipped/key_mode) in case the mode flips at runtime.
  {
    const { isSemrushKeyMode } = await import("./semrushAuthMode");
    if (isSemrushKeyMode()) {
      console.log(
        "[SemrushKeepAlive] API-key mode active (SEMRUSH_V4_API_KEY set) — OAuth token keep-alive dormant.",
      );
      return;
    }
  }
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[SemrushKeepAlive] Not running in deployment — proactive SEMrush token keep-alive disabled (set SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE=1 to override).",
    );
    return;
  }
  const intervalMs = await resolveIntervalMs();
  // Kick a first tick shortly after boot (the bootstrap caller already
  // staggers worker startup), then on the resolved interval. Each tick runs
  // under the cross-instance singleton lock so only one instance rotates.
  void withWorkerSingletonLock(SINGLETON_KEY, () => tick());
  scheduler = setInterval(
    () => void withWorkerSingletonLock(SINGLETON_KEY, () => tick()),
    intervalMs,
  );
  console.log(
    `[SemrushKeepAlive] Scheduled proactive SEMrush token keep-alive every ${intervalMs}ms`,
  );
}

export function stopSemrushTokenKeepAliveScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
  console.log("[SemrushKeepAlive] Stopped");
}
