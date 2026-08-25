/**
 * Task #3662 — Auth-dead / persistent-failure alert for the Ads OS ClickUp
 * Client List directory. Mirrors the SEMrush global-disconnect pattern
 * (server/services/semrushDisconnectAlert.ts).
 *
 * Why: when production's ClickUp token went stale (deployment secret snapshot
 * frozen at publish), the directory quietly degraded to the legacy label
 * fallback and the team discovered it days later from wrong dashboard names.
 * Nothing alerted. This module fires a Slack + in-app alert the moment the
 * directory goes auth-dead.
 *
 * Design:
 *   - Called from the directory fetch outcome hooks (clickUpDirectory.ts):
 *     every COMPLETED fetch attempt reports success or failure here.
 *   - Auth-class failures (HTTP 401) alert after a short grace window —
 *     anchored at the FIRST 401 of the streak — so a sub-minute blip
 *     (e.g. a rotation racing a fetch) never pages.
 *   - Transient failures (anything else: 5xx, timeouts, network) alert only
 *     after a consecutive-failure threshold.
 *   - AT MOST ONCE per outage streak (per-process flag), re-armed only by a
 *     healthy fetch — same "blocked is deterministic" rule as SEMrush.
 *   - Recovery: the next successful fetch clears counters and, if we had
 *     alerted, calls markRecovered so the NEXT outage re-alerts immediately.
 *   - Kill switch: `kill_switch_clickup_directory_alert` (default ON). When
 *     set to "false" the check still runs and logs, but never notifies.
 *
 * The alert text tells the operator exactly what to do: rotate the token in
 * Integrations Hub → ClickUp → Ads OS company token — NO republish needed.
 * Never includes the token value.
 */
import { notifyByType, markRecovered } from "../notifications/dispatcher";
import { getSystemSetting } from "../../storage/settingsStorage";
import { getClickUpCompanyTokenSnapshot } from "../clickUpCompanyToken";

const NOTIFICATION_ID = "integration.clickup.ads_os_directory_down";
const DEDUPE_KEY = "global";

/**
 * 5-minute grace for auth-class failures. Directory fetch attempts recur at
 * most every 60s (failure backoff) under dashboard traffic, so a genuinely
 * dead token alerts within ~6 minutes of the first 401 — while a one-off
 * rotation race (old token rejected once, next resolve picks up the new one)
 * self-heals silently inside the window.
 */
export const CLICKUP_DIRECTORY_ALERT_AUTH_GRACE_MS = 5 * 60 * 1000;

/** Non-auth failures must persist this many CONSECUTIVE attempts to alert. */
export const CLICKUP_DIRECTORY_ALERT_TRANSIENT_THRESHOLD = 3;

/** Kill switch key — default ON (alert enabled); "false" disables. */
export const KILL_SWITCH_CLICKUP_DIRECTORY_ALERT =
  "kill_switch_clickup_directory_alert";

export interface DirectoryFailureInfo {
  httpStatus: number | null;
  message: string;
  errorClass: string;
  listId: string;
}

let consecutiveFailures = 0;
let firstAuthFailureAt: number | null = null;
let streakAlertFired = false;

// Tunables are mutable for tests only; production uses the exported consts.
let _authGraceMs = CLICKUP_DIRECTORY_ALERT_AUTH_GRACE_MS;
let _transientThreshold = CLICKUP_DIRECTORY_ALERT_TRANSIENT_THRESHOLD;

/** Injectable dispatcher + settings reader (ESM live bindings are read-only;
 *  tests swap these instead of monkey-patching imports). */
let _notifyByType: typeof notifyByType = notifyByType;
let _markRecovered: typeof markRecovered = markRecovered;
let _getSystemSetting: (key: string) => Promise<{ value: string | null } | undefined> = (key) =>
  getSystemSetting(key);

/**
 * Record a FAILED directory fetch attempt and fire the alert when due.
 * Never throws (alerting must never break the directory's stale-serve path).
 */
export async function onClickUpDirectoryFetchFailure(info: DirectoryFailureInfo): Promise<void> {
  try {
    consecutiveFailures++;
    const isAuth = info.httpStatus === 401;
    if (isAuth && firstAuthFailureAt === null) firstAuthFailureAt = Date.now();

    const killSwitch = await _getSystemSetting(KILL_SWITCH_CLICKUP_DIRECTORY_ALERT).catch(
      () => undefined,
    );
    if (killSwitch?.value === "false") {
      console.log(
        `[ClickUpDirectoryAlert] kill switch OFF — skipping (status=${info.httpStatus} failures=${consecutiveFailures})`,
      );
      return;
    }

    // Once-per-streak gate: stay silent until a healthy fetch re-arms us.
    if (streakAlertFired) return;

    const authDue =
      firstAuthFailureAt !== null && Date.now() - firstAuthFailureAt >= _authGraceMs;
    const transientDue = consecutiveFailures >= _transientThreshold;
    if (!authDue && !transientDue) {
      console.log(
        `[ClickUpDirectoryAlert] failure recorded, below alert bar ` +
          `(status=${info.httpStatus} consecutive=${consecutiveFailures}` +
          `${firstAuthFailureAt ? ` authStreakMs=${Date.now() - firstAuthFailureAt}` : ""})`,
      );
      return;
    }

    const tokenSource = getClickUpCompanyTokenSnapshot().source;
    const cause = authDue
      ? `auth-dead (HTTP 401 for ${Math.round((Date.now() - (firstAuthFailureAt ?? Date.now())) / 60000)}+ min)`
      : `${consecutiveFailures} consecutive failed fetches`;
    const text =
      `Ads OS ClickUp Client List directory is DOWN — ${cause}.\n` +
      `Last error: ${info.httpStatus ? `HTTP ${info.httpStatus} — ` : `${info.errorClass} — `}${info.message}\n` +
      `List: ${info.listId}. Active token source: ${tokenSource}.\n` +
      `Impact: Main Dashboard degrades to raw Google Ads account names (legacy label fallback); Doer/Checker and Ads Statuses go missing.\n` +
      `Action: paste a fresh ClickUp token in Integrations Hub → ClickUp → "Ads OS company token" and press Test connection, then Save — it takes effect on all instances within ~1 minute, NO republish needed.`;

    console.warn(
      `[ClickUpDirectoryAlert] firing directory-down alert (${cause}, status=${info.httpStatus}, tokenSource=${tokenSource})`,
    );
    await _notifyByType(NOTIFICATION_ID, { text }, {
      triggerSource: "scheduled",
      dedupeKey: DEDUPE_KEY,
    });
    streakAlertFired = true;
  } catch (err: any) {
    console.warn(
      `[ClickUpDirectoryAlert] failed to record/fire (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Record a SUCCESSFUL directory fetch: clears the streak counters and, when
 * an alert had fired, marks the dispatcher health state recovered so the
 * next outage alerts immediately. Cheap no-op on healthy → healthy.
 */
export async function onClickUpDirectoryFetchSuccess(): Promise<void> {
  try {
    const hadOutage = consecutiveFailures > 0 || firstAuthFailureAt !== null || streakAlertFired;
    const firedBefore = streakAlertFired;
    consecutiveFailures = 0;
    firstAuthFailureAt = null;
    streakAlertFired = false;
    if (!hadOutage) return;
    if (firedBefore) {
      await _markRecovered(NOTIFICATION_ID, DEDUPE_KEY);
      console.log("[ClickUpDirectoryAlert] directory recovered — alert streak re-armed");
    }
  } catch (err: any) {
    console.warn(
      `[ClickUpDirectoryAlert] markRecovered failed (non-fatal): ${err?.message ?? err}`,
    );
  }
}

// ─── Test seams (production never calls these) ───────────────────────────────

export function __getClickUpDirectoryAlertKeysForTest(): {
  notificationId: string;
  dedupeKey: string;
} {
  return { notificationId: NOTIFICATION_ID, dedupeKey: DEDUPE_KEY };
}

export function __getClickUpDirectoryAlertStateForTest(): {
  consecutiveFailures: number;
  firstAuthFailureAt: number | null;
  streakAlertFired: boolean;
} {
  return { consecutiveFailures, firstAuthFailureAt, streakAlertFired };
}

export function __setClickUpDirectoryAlertTuningForTest(t: {
  authGraceMs?: number;
  transientThreshold?: number;
}): void {
  if (t.authGraceMs !== undefined) _authGraceMs = t.authGraceMs;
  if (t.transientThreshold !== undefined) _transientThreshold = t.transientThreshold;
}

export function __resetClickUpDirectoryAlertForTest(): void {
  consecutiveFailures = 0;
  firstAuthFailureAt = null;
  streakAlertFired = false;
  _authGraceMs = CLICKUP_DIRECTORY_ALERT_AUTH_GRACE_MS;
  _transientThreshold = CLICKUP_DIRECTORY_ALERT_TRANSIENT_THRESHOLD;
}

export function __setClickUpDirectoryAlertDispatcherForTest(
  notify: typeof notifyByType,
  recover: typeof markRecovered,
): void {
  _notifyByType = notify;
  _markRecovered = recover;
}

export function __setClickUpDirectoryAlertSettingReaderForTest(
  reader: ((key: string) => Promise<{ value: string | null } | undefined>) | null,
): void {
  _getSystemSetting = reader ?? ((key) => getSystemSetting(key));
}

export function __resetClickUpDirectoryAlertDispatcherForTest(): void {
  _notifyByType = notifyByType;
  _markRecovered = markRecovered;
  _getSystemSetting = (key) => getSystemSetting(key);
}
