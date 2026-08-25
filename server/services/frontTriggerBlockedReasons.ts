/**
 * Shared plain-English "blocked" reason builders for the Front
 * analytics-coverage operator trigger routes.
 *
 * Task #2135 added plain-English `reason` strings to the four 503
 * "blocked" branches of the outbound gap-close trigger so an operator
 * who pressed the button understands why nothing happened. Task #2211
 * extends the same treatment to the other refresh-gated trigger routes
 * (refresh-month / reprobe-month / recompute), which share the same
 * three gates: the master refresh setting OFF, the queue paused, and
 * the non-critical-sweeps kill switch.
 *
 * Each builder returns BOTH the machine `error` identifier (unchanged,
 * so existing client matchers and tests keep working) and a
 * plain-English `reason` that names the exact switch/queue to flip.
 */

export type BlockedResponse = { error: string; reason: string };

/** Master refresh `system_settings` flag is OFF. */
export function refreshDisabledBlocked(settingName: string): BlockedResponse {
  return {
    error: `${settingName}=false`,
    reason: `Front analytics refresh is turned off, so nothing was run. Turn on the "${settingName}" setting to enable it.`,
  };
}

/** The coverage-refresh queue is paused via `queue_drain_state`. */
export function queuePausedBlocked(queueName: string): BlockedResponse {
  return {
    error: "queue paused via queue_drain_state",
    reason: `The "${queueName}" queue is paused, so nothing was run. Resume it in queue-drain controls to enable it.`,
  };
}

/** The non-critical-sweeps kill switch is ON. */
export function killSwitchBlocked(): BlockedResponse {
  return {
    error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
    reason:
      "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
  };
}

/**
 * Task #2250 — pre-press inline hint. Returns the SAME plain-English
 * `reason` string the matching 503 branch would emit (so the on-screen
 * "why is this disabled" text stays consistent with the after-press
 * toast), or `null` when every gate is clear. Precedence matches the
 * route handlers exactly: master refresh OFF → queue paused → kill
 * switch ON.
 */
export function firstTriggerBlockedReason(gates: {
  refreshEnabled: boolean;
  refreshSetting: string;
  queuePaused: boolean;
  queueName: string;
  killSwitchNonCriticalSweeps: boolean;
}): string | null {
  if (!gates.refreshEnabled) {
    return refreshDisabledBlocked(gates.refreshSetting).reason;
  }
  if (gates.queuePaused) {
    return queuePausedBlocked(gates.queueName).reason;
  }
  if (gates.killSwitchNonCriticalSweeps) {
    return killSwitchBlocked().reason;
  }
  return null;
}
