/**
 * Task #2877 — Once-per-streak global-disconnect alert for SEMrush.
 *
 * When the global SEMrush tokens are absent OR the auth-dead breaker stays
 * open beyond a short grace window, operators need to know immediately — the
 * June 2026 outage sat silent for three weeks because nothing surfaced it.
 *
 * Design:
 *   - Alert fires AT MOST ONCE per outage streak (deterministic, no threshold —
 *     a missing token is not ambiguous, so there is no reason to wait for
 *     consecutive occurrences). This mirrors the self-heal blocked-vs-error
 *     memory pattern: `blocked` = alert on first detection, de-dupe while it
 *     persists, re-arm only on a healthy run.
 *   - De-duplication is backed by a per-process `streakAlertFired` flag that
 *     is set on the FIRST delivery and cleared only when `onSemrushAuthRestored`
 *     is called. This prevents the dispatcher's 6h REMINDER_INTERVAL from
 *     re-firing on a sustained outage — the gate is in this module, not in the
 *     dispatcher's health-state machine.
 *   - Recovery: `onSemrushAuthRestored` clears the streak flag and calls
 *     `markRecovered` so the NEXT disconnect re-alerts immediately.
 *   - Grace window: the alert is gated on the breaker having been open for
 *     at least GRACE_WINDOW_MS. This avoids noise on a transient blip that
 *     self-heals in seconds (e.g. a rotation-race that clears on the next
 *     sweep tick).
 *
 * Callers:
 *   - `localDominanceSyncWorker.syncAllActiveClients` — whenever the sweep
 *     detects the auth gate is open (paused_auth short-circuit path).
 *   - `localDominanceSyncWorker.syncAllActiveClients` — on successful
 *     `recoverPausedAuthRows`, calls `onSemrushAuthRestored`.
 *
 * Kill switch: `kill_switch_semrush_disconnect_alert` (default ON). When OFF
 * the check still runs and logs, but no notify call is made — this lets
 * operators silence the pager during a planned maintenance re-auth without
 * touching code.
 */
import { notifyByType, markRecovered } from "./notifications/dispatcher";
import { getSemrushAuthState, semrushAuthBreakerActive } from "./semrushAuthBreaker";
import { getSystemSetting } from "../storage/settingsStorage";

const NOTIFICATION_ID = "integration.semrush.auth_or_circuit_open";
const DEDUPE_KEY = "global";

/**
 * 30-minute grace window. The Local-Dominance sweep runs roughly every hour,
 * so an alert firing on the FIRST sweep where the auth gate is open gives the
 * operator a notification within ~1h of the disconnect — fast enough to avoid
 * a 3-week silent outage while not paging on a sub-minute rotation-race blip.
 */
export const SEMRUSH_DISCONNECT_ALERT_GRACE_MS = 30 * 60 * 1000;

/** Kill switch key — default ON (alert enabled). */
export const KILL_SWITCH_SEMRUSH_DISCONNECT_ALERT =
  "kill_switch_semrush_disconnect_alert";

/**
 * Per-process streak gate. Set to true after the first delivery within an
 * outage streak; cleared only by onSemrushAuthRestored(). This prevents the
 * dispatcher's 6h REMINDER_INTERVAL_MS from re-firing during a sustained
 * outage — once we've told the operator, we go silent until they fix it.
 */
let streakAlertFired = false;

/**
 * Injectable dispatcher references. Tests swap these via
 * __setDispatcherForTest to avoid ESM live-binding read-only errors.
 * Production always uses the real dispatcher imports.
 */
let _notifyByType: typeof notifyByType = notifyByType;
let _markRecovered: typeof markRecovered = markRecovered;

/**
 * Check whether the global SEMrush disconnect alert should fire.
 *
 * Called from the sweep worker's paused_auth short-circuit path.
 * Idempotent: the in-process streak flag suppresses re-delivery within the
 * same outage streak; `onSemrushAuthRestored` re-arms it.
 *
 * @param reason - Human-readable reason for the alert (e.g. "breaker_open",
 *   "tokens_absent"). Included in the notification body for triage.
 */
export async function checkSemrushGlobalDisconnectAlert(
  reason: string,
): Promise<void> {
  try {
    // Task #3670 — dormant in API-key mode: OAuth state (tokens/breaker) is
    // irrelevant while SEMRUSH_V4_API_KEY authenticates every call, so a
    // stale "tokens_absent"/"breaker_open" signal must never page anyone.
    const { isSemrushKeyMode } = await import("./semrushAuthMode");
    if (isSemrushKeyMode()) {
      console.log(
        `[SemrushDisconnectAlert] API-key mode active — OAuth disconnect alert dormant (reason=${reason})`,
      );
      return;
    }
    const killSwitch = await getSystemSetting(
      KILL_SWITCH_SEMRUSH_DISCONNECT_ALERT,
    ).catch(() => undefined);
    if (killSwitch?.value === "false") {
      console.log(
        `[SemrushDisconnectAlert] kill switch OFF — skipping alert (reason=${reason})`,
      );
      return;
    }

    const state = getSemrushAuthState();
    const breakerOpen = semrushAuthBreakerActive();
    const lastTrippedAt = state.lastTrippedAt
      ? new Date(state.lastTrippedAt).getTime()
      : null;
    const ageMs =
      lastTrippedAt !== null ? Date.now() - lastTrippedAt : Infinity;

    if (ageMs < SEMRUSH_DISCONNECT_ALERT_GRACE_MS) {
      console.log(
        `[SemrushDisconnectAlert] inside grace window (ageMs=${ageMs} < ${SEMRUSH_DISCONNECT_ALERT_GRACE_MS}) — suppressing (reason=${reason})`,
      );
      return;
    }

    // Once-per-streak gate: if we already alerted for this outage streak,
    // stay silent until onSemrushAuthRestored() re-arms us.
    if (streakAlertFired) {
      console.log(
        `[SemrushDisconnectAlert] alert already fired for this streak — suppressing repeat (reason=${reason})`,
      );
      return;
    }

    const code = state.lastTrippedCode ?? reason;
    const text =
      `SEMrush is globally disconnected and the Local Dominance sync is paused fleet-wide.\n` +
      `Reason: ${reason} (error code: ${code}).\n` +
      `Action required: re-authorize SEMrush in Settings → Integrations Hub, then ` +
      `the existing recoverPausedAuthRows() path will automatically clear all paused_auth rows.\n` +
      (breakerOpen
        ? `Auth breaker is OPEN (opened at: ${state.openedUntil ?? "unknown"}).\n`
        : "") +
      `Trip count: ${state.tripCount}. Last healthy: ${state.lastSuccessAt ?? "never"}.`;

    console.warn(
      `[SemrushDisconnectAlert] Firing global-disconnect alert (reason=${reason} code=${code} ageMs=${ageMs})`,
    );

    await _notifyByType(NOTIFICATION_ID, { text }, {
      triggerSource: "scheduled",
      dedupeKey: DEDUPE_KEY,
    });

    // Mark the streak as alerted so subsequent sweep calls within the same
    // outage are suppressed at the module level, regardless of dispatcher
    // reminder scheduling.
    streakAlertFired = true;
  } catch (err: any) {
    console.warn(
      `[SemrushDisconnectAlert] Failed to fire alert (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Called when SEMrush auth is restored (operator reconnected, breaker reset,
 * and paused_auth rows were cleared). Clears the streak flag and marks the
 * health state as recovered so the next disconnect re-arms the alert
 * immediately rather than staying silenced by the previous streak's de-dupe.
 */
export async function onSemrushAuthRestored(): Promise<void> {
  try {
    streakAlertFired = false;
    await _markRecovered(NOTIFICATION_ID, DEDUPE_KEY);
    console.log(
      "[SemrushDisconnectAlert] Auth restored — disconnect alert streak re-armed",
    );
  } catch (err: any) {
    console.warn(
      `[SemrushDisconnectAlert] markRecovered failed (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Test-only: returns the notification ID and dedupe key so tests can assert
 * the correct arguments without hard-coding strings.
 */
export function __getSemrushDisconnectAlertKeysForTest(): {
  notificationId: string;
  dedupeKey: string;
} {
  return { notificationId: NOTIFICATION_ID, dedupeKey: DEDUPE_KEY };
}

/**
 * Test-only: resets the per-process streak flag so Group 9 test steps are
 * isolated from each other. Production never calls this.
 */
export function __resetSemrushDisconnectAlertStreakForTest(): void {
  streakAlertFired = false;
}

/**
 * Test-only: swaps the dispatcher functions used by this module so tests can
 * intercept calls without hitting the ESM live-binding read-only restriction.
 * Call __resetDispatcherForTest() in finally to restore production behaviour.
 */
export function __setDispatcherForTest(
  notify: typeof notifyByType,
  recover: typeof markRecovered,
): void {
  _notifyByType = notify;
  _markRecovered = recover;
}

/**
 * Test-only: restores the real dispatcher references after a test overrides them.
 */
export function __resetDispatcherForTest(): void {
  _notifyByType = notifyByType;
  _markRecovered = markRecovered;
}
