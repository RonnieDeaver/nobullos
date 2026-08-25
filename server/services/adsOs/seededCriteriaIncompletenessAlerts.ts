/**
 * Task #4832 — Alert the team when newly-seeded Ads OS criteria docs have
 * not been completed by an operator after 7 days.
 *
 * The schedule-sync prod action (Task #4827) seeds a minimal criteria doc
 * containing only `schedule_days` / `lsa_schedule_days` for clients that had
 * no prior criteria doc. Operators still need to fill in `business_name`,
 * `service_area`, and other fields via the Edit Criteria UI. Without a
 * follow-up alert, seeded stubs can sit indefinitely and silently degrade
 * any feature that reads those fields.
 *
 * Detection: a criteria doc is "seeded-minimal" when it has no
 * `business_name` AND no `service_area` (both absent or empty). The 7-day
 * grace window is measured from `updated_at` in the stored doc (the timestamp
 * written by `patchClientSchedule` at seed time).
 *
 * Firing strategy: at most one Slack alert per UTC calendar day while
 * overdue incomplete docs exist; no "recovery" message (the condition just
 * stops firing once all docs have been completed). Gated by the
 * `ads_os_seeded_criteria_incomplete_alert_enabled` system-setting kill
 * switch (default ON).
 *
 * Channel resolution is owned by the dispatcher (notification id
 * `workflow.ads_os.seeded_criteria_incomplete`).
 */

import { withDbAttribution } from "../../db";
import { getSystemSetting } from "../../storage/settingsStorage";
import { withWorkerSingletonLock } from "../crossInstanceLock";
import { getCriteria } from "./store";
import { SCHEDULE_SYNC_TARGETS } from "../prodActions/platformOpsActions";
import {
  STALE_THRESHOLD_MS,
  isSeededMinimal,
  isOverdue,
} from "./criteriaCompletenessHelpers";

export const NOTIFICATION_ID = "workflow.ads_os.seeded_criteria_incomplete";
export const SETTING_ENABLED = "ads_os_seeded_criteria_incomplete_alert_enabled";

/** Polling interval — hygiene checks do not need sub-minute cadence. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function isAlertEnabled(): Promise<boolean> {
  const row = await getSystemSetting(SETTING_ENABLED).catch(() => null);
  return parseBool(row?.value, true);
}

/** UTC calendar date string for deduplification ("YYYY-MM-DD"). */
function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// isSeededMinimal and isOverdue are re-exported from ./criteriaCompletenessHelpers
// (imported above) to keep their API surface stable for callers.
export { isSeededMinimal, isOverdue } from "./criteriaCompletenessHelpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverdueSeededClient {
  cid: string;
  client: string;
  /** ISO string from `updated_at` in the stored doc. */
  seededAt: string;
}

export type AlertDecision =
  | "alerted"
  | "skipped_disabled"
  | "skipped_none_overdue"
  | "skipped_already_alerted_today"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface AlertCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  overdueClients: OverdueSeededClient[];
  decision: AlertDecision;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

function buildText(clients: OverdueSeededClient[]): string {
  const names = clients.map((c) => c.client);
  const preview =
    names.slice(0, 5).join(", ") +
    (names.length > 5 ? ` (+${names.length - 5} more)` : "");
  const lines: string[] = [
    `:warning: *Ads OS: ${clients.length} seeded criteria doc${clients.length === 1 ? "" : "s"} still incomplete after 7 days*`,
    `These clients have a schedule-only criteria doc (seeded by the schedule sync action) ` +
      `but no operator has filled in \`business_name\` or \`service_area\` yet.`,
    `• Clients: ${preview}`,
    `• Action: open the Ads OS Edit Criteria panel for each client and save the business name and service area.`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Injected dependencies (overridable in tests)
// ---------------------------------------------------------------------------

type ReadFn = (cid: string) => Promise<Record<string, any> | null>;
type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let _readOverride: ReadFn | null = null;
let _dispatcherOverride: NotifyByTypeFn | null = null;
let _isEnabledOverride: (() => Promise<boolean>) | null = null;

/** UTC date ("YYYY-MM-DD") of the last successfully dispatched alert. */
let _lastAlertedDate: string | null = null;

// ---------------------------------------------------------------------------
// Core check (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * One evaluation pass: scan `SCHEDULE_SYNC_TARGETS` for seeded-minimal docs
 * that are older than 7 days and fire a Slack alert if any are found (at
 * most once per UTC calendar day).
 */
export async function checkSeededCriteriaIncompletenessAlert(
  now: number = Date.now(),
): Promise<AlertCheckResult> {
  const evaluatedAt = new Date(now).toISOString();

  // Collect overdue seeded docs.
  const overdueClients: OverdueSeededClient[] = [];
  const read: ReadFn = _readOverride ?? ((cid) => getCriteria(cid));

  await Promise.all(
    SCHEDULE_SYNC_TARGETS.map(async (entry) => {
      try {
        const rawDoc = await read(entry.cid);
        if (rawDoc === null) return; // no doc at all — not yet seeded, skip
        if (!isSeededMinimal(rawDoc)) return; // operator has filled it in
        if (!isOverdue(rawDoc, now)) return; // within grace window, skip
        const seededAt =
          typeof rawDoc.updated_at === "string" ? rawDoc.updated_at : new Date(0).toISOString();
        overdueClients.push({ cid: entry.cid, client: entry.client, seededAt });
      } catch {
        // Best-effort — a single read failure doesn't abort the full scan.
      }
    }),
  );

  const result: AlertCheckResult = {
    evaluatedAt,
    enabled: false,
    overdueClients,
    decision: "skipped_none_overdue",
  };

  if (overdueClients.length === 0) {
    result.enabled = true; // enabled check was never reached, set conservatively
    return result;
  }

  const enabled = await (_isEnabledOverride ? _isEnabledOverride() : isAlertEnabled());
  result.enabled = enabled;

  if (!enabled) {
    result.decision = "skipped_disabled";
    result.skipReason = "alert disabled in system_settings";
    return result;
  }

  // Deduplicate to at most one alert per UTC calendar day.
  const todayKey = utcDate(now);
  if (_lastAlertedDate === todayKey) {
    result.decision = "skipped_already_alerted_today";
    result.skipReason = `already alerted on ${todayKey}`;
    return result;
  }

  // Dispatch.
  const text = buildText(overdueClients);
  let delivered = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      _dispatcherOverride ??
      (await import("../notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: {
          overdueCount: overdueClients.length,
          overdueClients: overdueClients.map((c) => ({
            cid: c.cid,
            client: c.client,
            seededAt: c.seededAt,
          })),
          staleDays: Math.floor(STALE_THRESHOLD_MS / (24 * 60 * 60 * 1000)),
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    _lastAlertedDate = todayKey;
    result.decision = "alerted";
  } else {
    result.decision = skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped";
    result.skipReason = skipReason;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const SINGLETON_KEY = "ads-os-seeded-criteria-incompleteness-alert";

let _interval: ReturnType<typeof setInterval> | null = null;
let _inFlight: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (_inFlight) return;
  _inFlight = (async () => {
    try {
      // Cluster-wide singleton: on autoscale deployments every instance runs
      // setInterval, but only one should evaluate + dispatch per cycle so
      // operators don't receive duplicate Slack alerts.
      await withWorkerSingletonLock(SINGLETON_KEY, async () => {
        const r = await checkSeededCriteriaIncompletenessAlert();
        if (r.decision === "alerted") {
          console.log(
            `[AdsOsSeededCriteriaIncompletenessAlerts] alerted — ${r.overdueClients.length} overdue client(s): ` +
              r.overdueClients
                .slice(0, 5)
                .map((c) => c.client)
                .join(", ") +
              (r.overdueClients.length > 5
                ? ` (+${r.overdueClients.length - 5} more)`
                : ""),
          );
        }
      });
    } catch (err: any) {
      console.warn(
        `[AdsOsSeededCriteriaIncompletenessAlerts] tick failed: ${err?.message}`,
      );
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

export function startAdsOsSeededCriteriaIncompletenessAlertsScheduler(): void {
  if (_interval) return;
  // @lint-cross-instance-locks: tick body runs under withWorkerSingletonLock
  _interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:ads-os-seeded-criteria-incompleteness-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  console.log(
    `[AdsOsSeededCriteriaIncompletenessAlerts] scheduler started (check every ${
      CHECK_INTERVAL_MS / (60 * 60 * 1000)
    }h)`,
  );
}

export function stopAdsOsSeededCriteriaIncompletenessAlertsScheduler(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export const __testHelpers = {
  NOTIFICATION_ID,
  STALE_THRESHOLD_MS,
  resetForTests(): void {
    _lastAlertedDate = null;
    _readOverride = null;
    _dispatcherOverride = null;
  },
  setLastAlertedDate(v: string | null): void {
    _lastAlertedDate = v;
  },
  getLastAlertedDate(): string | null {
    return _lastAlertedDate;
  },
  setReadForTests(fn: ReadFn | null): void {
    _readOverride = fn;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    _dispatcherOverride = fn;
  },
  setIsEnabledForTests(fn: (() => Promise<boolean>) | null): void {
    _isEnabledOverride = fn;
  },
};
