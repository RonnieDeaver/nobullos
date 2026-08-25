// @db-pool-intent: worker
//
// Task #2740 — proactive Zoom token keep-alive scheduler.
//
// The Zoom OAuth app is currently UNPUBLISHED (Draft), so Zoom invalidates
// the refresh token ~1h after issue (see the long rationale on
// `runZoomTokenKeepAliveTick` in `zoomIntegration.ts`). During quiet periods
// nothing triggers a refresh, the ~1h elapses, and the next real Zoom call
// hits `invalid_grant` and forces an operator reconnect. This scheduler ticks
// on a fixed interval and proactively rotates the token before that cutoff.
//
// Lifecycle mirrors the other deployment-gated, cross-instance-singleton
// schedulers (appBackupScheduler / risAutoPullScheduler):
//   1. Deployment-gated: the deployed app holds the live (prod) Zoom tokens
//      and is the always-on process whose quiet periods actually matter. A
//      workspace run would rotate the dev DB's tokens, not prod's. Set
//      ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE=1 to run it locally (tests).
//   2. Cross-instance singleton: each tick takes a cluster-wide Postgres
//      advisory lock so exactly ONE autoscale instance rotates per tick
//      (concurrent rotations would race the refresh-token chain; the lock
//      self-heals when the holder crashes).
//   3. Worker pool: all DB work runs via runWithWorkerDb.
//
// The tick body itself is non-authoritative — a terminal refresh failure here
// never engages the global auth gate (see runZoomTokenKeepAliveTick).

import { runWithWorkerDb, withDbAttribution } from "../db";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { runZoomTokenKeepAliveTick } from "./zoomIntegration";

const INTERVAL_SETTING = "zoom_token_keepalive_interval_ms";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const MIN_INTERVAL_MS = 60_000; // never tighter than 1 min
const SINGLETON_KEY = "zoom_token_keepalive";

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Local escape hatch so the keep-alive can run in the workspace / tests
 * without a deploy (mirrors FRONT_WORKERS_FORCE_ENABLE).
 */
function isForceEnabled(): boolean {
  const v = process.env.ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE;
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

async function tick(): Promise<void> {
  if (running) return; // never overlap with a previous slow run
  running = true;
  try {
    const result = await runWithWorkerDb(() =>
      withDbAttribution("scheduler:zoom-token-keepalive", () => runZoomTokenKeepAliveTick()),
    );
    switch (result.action) {
      case "refreshed":
        console.log("[ZoomKeepAlive] Proactively rotated the Zoom token before expiry");
        break;
      case "terminal_error":
        console.warn(
          `[ZoomKeepAlive] Proactive refresh hit a terminal error (gate NOT engaged): oauthError=${result.oauthError ?? "?"}`,
        );
        // Fire an operator alert so the admin knows to reconnect before the
        // actual token expiry arrives. Non-blocking, best-effort.
        void (async () => {
          try {
            const { notifyByType } = await import("./notifications/dispatcher");
            await notifyByType(
              "integration.zoom.auth_failed",
              {
                text:
                  `*Zoom keep-alive proactive refresh failed terminally.* ` +
                  `The auth gate has NOT been engaged (non-authoritative path), but the access token ` +
                  `will not be proactively renewed until this is resolved. ` +
                  `Re-authorize Zoom in Settings → Integrations Hub before the token expires. ` +
                  `oauthError: ${result.oauthError ?? "unknown"}`,
              },
              {
                triggerSource: "scheduled",
                dedupeKey: "zoom.keepalive.terminal",
              },
            );
          } catch (alertErr: any) {
            console.warn(
              "[ZoomKeepAlive] Failed to send terminal-error operator alert:",
              alertErr?.message ?? alertErr,
            );
          }
        })();
        break;
      case "transient_error":
        console.warn(`[ZoomKeepAlive] Proactive refresh transient error: ${result.message}`);
        break;
      default:
        // skipped — silent (disabled / gate_engaged / terminal_latched /
        // no_tokens / fresh are all routine no-ops).
        break;
    }
  } catch (err: any) {
    console.warn("[ZoomKeepAlive] tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export async function startZoomTokenKeepAliveScheduler(): Promise<void> {
  if (scheduler) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[ZoomKeepAlive] Not running in deployment — proactive Zoom token keep-alive disabled (set ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE=1 to override).",
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
    `[ZoomKeepAlive] Scheduled proactive Zoom token keep-alive every ${intervalMs}ms`,
  );
}

export function stopZoomTokenKeepAliveScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
  console.log("[ZoomKeepAlive] Stopped");
}
