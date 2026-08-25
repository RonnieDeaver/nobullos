/**
 * Task #3672 — Once-per-streak alert for a rejected SEMrush v4 API key.
 *
 * In key mode (Task #3670) the OAuth disconnect alert and auth-dead breaker
 * are dormant by design. If SEMrush revokes or expires the v4 API key, every
 * call fails with `SemrushApiKeyRejectedError` but nothing pages anyone —
 * the only symptom would be quietly stale heatmap data. This module mirrors
 * `semrushDisconnectAlert.ts`'s once-per-streak dedupe pattern for the key
 * path:
 *
 *   - `recordSemrushKeyModeRejection` is called from the key-mode 401/403
 *     throw sites in `semrushApi.ts`. After
 *     `SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD` CONSECUTIVE rejections (a single
 *     401 can be a SEMrush-side blip; a streak is deterministic), it fires
 *     ONE notification telling the operator to rotate `SEMRUSH_V4_API_KEY`
 *     and republish. Subsequent rejections within the same streak are
 *     suppressed by the per-process `streakAlertFired` flag — the gate lives
 *     here, not in the dispatcher's reminder machinery.
 *   - `onSemrushKeyModeCallSucceeded` is called from the key-mode success
 *     paths. It resets the consecutive counter and — when an alert had fired —
 *     calls `markRecovered` so the NEXT rejection streak re-alerts
 *     immediately.
 *   - Dormant outside key mode: OAuth-path failures have their own alert
 *     (`semrushDisconnectAlert.ts`); this module must never double-page.
 *
 * Kill switch: `kill_switch_semrush_key_rejected_alert` (default ON). When
 * OFF the check still runs and logs, but no notify call is made.
 */
import { notifyByType, markRecovered } from "./notifications/dispatcher";
import { getSystemSetting } from "../storage/settingsStorage";
import { isSemrushKeyMode } from "./semrushAuthMode";

const NOTIFICATION_ID = "integration.semrush.api_key_rejected";
const DEDUPE_KEY = "global";

/**
 * Consecutive key-mode 401/403 responses required before the alert fires.
 * One rejection can be a transient SEMrush-side auth blip; three in a row
 * with zero successes in between is a revoked/expired key.
 */
export const SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD = 3;

/** Kill switch key — default ON (alert enabled). */
export const KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT =
  "kill_switch_semrush_key_rejected_alert";

/** Consecutive key-mode 401/403s with no intervening success. */
let consecutiveRejections = 0;

/**
 * Per-process streak gate. Set after the first delivery within a rejection
 * streak; cleared only when a key-mode call succeeds. Prevents the
 * dispatcher's reminder interval from re-firing during a sustained outage.
 */
let streakAlertFired = false;

/** ISO timestamp of the most recent key-mode rejection in the current streak. */
let lastRejectionAt: string | null = null;

/** HTTP status of the most recent key-mode rejection in the current streak. */
let lastRejectionStatus: number | null = null;

/**
 * In-flight recovery promise from the last `onSemrushKeyModeCallSucceeded`
 * kick, so tests can drain the fire-and-forget `markRecovered` call
 * deterministically (see async-fire-and-forget-test-drain pattern).
 */
let pendingRecovery: Promise<void> | null = null;

/**
 * Injectable dispatcher references. Tests swap these via
 * `__setKeyModeDispatcherForTest` to avoid ESM live-binding read-only errors.
 */
let _notifyByType: typeof notifyByType = notifyByType;
let _markRecovered: typeof markRecovered = markRecovered;

/**
 * Record a key-mode 401/403 from a live SEMrush call. Fires the operator
 * alert once per streak after the consecutive threshold is reached.
 * Never throws — the caller is already on an error path and must surface
 * its own `SemrushApiKeyRejectedError`, not an alerting failure.
 */
export async function recordSemrushKeyModeRejection(
  status: number,
  endpoint: string,
): Promise<void> {
  try {
    // Dormant outside key mode: a Bearer-path 401 belongs to the OAuth
    // breaker + disconnect alert, never to this module.
    if (!isSemrushKeyMode()) return;

    consecutiveRejections++;
    lastRejectionAt = new Date().toISOString();
    lastRejectionStatus = status;
    console.warn(
      `[SemrushKeyModeAlert] key-mode rejection (HTTP ${status}) on ${endpoint} — consecutive=${consecutiveRejections}/${SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD} streakAlertFired=${streakAlertFired}`,
    );

    if (consecutiveRejections < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD) return;

    // Once-per-streak gate: after the first delivery, stay silent until a
    // successful key-mode call re-arms via onSemrushKeyModeCallSucceeded().
    if (streakAlertFired) return;

    // lint-probe-swallow-ok: kill-switch read, not a credential probe — a thrown read defaults to "alert enabled" (fail-open toward alerting), the safe direction for an outage pager.
    const killSwitch = await getSystemSetting(
      KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT,
    ).catch(() => undefined);
    if (killSwitch?.value === "false") {
      console.log(
        `[SemrushKeyModeAlert] kill switch OFF — skipping alert (status=${status} endpoint=${endpoint})`,
      );
      return;
    }

    const text =
      `The SEMrush v4 API key is being rejected (HTTP ${status}) — ${consecutiveRejections} consecutive key-mode calls failed, ` +
      `so heatmap / Local Dominance data will silently go stale.\n` +
      `Latest endpoint: ${endpoint}.\n` +
      `Action required: obtain a fresh key from SEMrush, rotate the SEMRUSH_V4_API_KEY secret, and republish the deployment ` +
      `so the new secret is picked up. This is NOT an OAuth problem — do not use the Integrations Hub reconnect flow.`;

    console.warn(
      `[SemrushKeyModeAlert] Firing API-key-rejected alert (status=${status} endpoint=${endpoint} consecutive=${consecutiveRejections})`,
    );

    await _notifyByType(NOTIFICATION_ID, { text }, {
      triggerSource: "scheduled",
      dedupeKey: DEDUPE_KEY,
    });

    streakAlertFired = true;
  } catch (err: any) {
    console.warn(
      `[SemrushKeyModeAlert] Failed to fire alert (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Called from the key-mode success paths. Synchronously resets the
 * consecutive-rejection counter; when an alert had fired for the previous
 * streak, kicks a fire-and-forget `markRecovered` so the next streak
 * re-alerts immediately. Synchronous so the hot API path never awaits
 * dispatcher I/O on success.
 */
export function onSemrushKeyModeCallSucceeded(): void {
  consecutiveRejections = 0;
  lastRejectionAt = null;
  lastRejectionStatus = null;
  if (!streakAlertFired) return;
  streakAlertFired = false;
  console.log(
    "[SemrushKeyModeAlert] key-mode call succeeded — rejection streak cleared, alert re-armed",
  );
  pendingRecovery = _markRecovered(NOTIFICATION_ID, DEDUPE_KEY)
    .catch((err: any) => {
      console.warn(
        `[SemrushKeyModeAlert] markRecovered failed (non-fatal): ${err?.message ?? err}`,
      );
    })
    .finally(() => {
      pendingRecovery = null;
    });
}

/**
 * Task #3690 — live rejection-streak state for the Integrations Hub SEMrush
 * card. Per-process (mirrors the alert's own state); `keyRejected` is true
 * once the consecutive threshold is reached, giving operators a persistent
 * "rotate SEMRUSH_V4_API_KEY and republish" signal beyond the one Slack
 * alert. Clears automatically when a key-mode call succeeds (the same reset
 * that re-arms the alert).
 */
export function getSemrushKeyModeRejectionState(): {
  consecutiveRejections: number;
  keyRejected: boolean;
  streakAlertFired: boolean;
  lastRejectionAt: string | null;
  lastRejectionStatus: number | null;
} {
  return {
    consecutiveRejections,
    keyRejected: consecutiveRejections >= SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD,
    streakAlertFired,
    lastRejectionAt,
    lastRejectionStatus,
  };
}

/** Test-only: drain the fire-and-forget recovery kick before asserting. */
export async function __drainSemrushKeyModeAlertForTest(): Promise<void> {
  if (pendingRecovery) await pendingRecovery;
}

/** Test-only: notification ID + dedupe key so tests never hard-code strings. */
export function __getSemrushKeyModeAlertKeysForTest(): {
  notificationId: string;
  dedupeKey: string;
} {
  return { notificationId: NOTIFICATION_ID, dedupeKey: DEDUPE_KEY };
}

/** Test-only: reset the per-process streak state between test steps. */
export function __resetSemrushKeyModeAlertForTest(): void {
  consecutiveRejections = 0;
  streakAlertFired = false;
  lastRejectionAt = null;
  lastRejectionStatus = null;
  pendingRecovery = null;
}

/**
 * Test-only: swaps the dispatcher functions so tests can intercept calls
 * without the ESM live-binding read-only restriction. Restore via
 * `__resetKeyModeDispatcherForTest()` in finally.
 */
export function __setKeyModeDispatcherForTest(
  notify: typeof notifyByType,
  recover: typeof markRecovered,
): void {
  _notifyByType = notify;
  _markRecovered = recover;
}

/** Test-only: restores the real dispatcher references. */
export function __resetKeyModeDispatcherForTest(): void {
  _notifyByType = notifyByType;
  _markRecovered = markRecovered;
}
