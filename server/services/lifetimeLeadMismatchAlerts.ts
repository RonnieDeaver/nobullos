/**
 * Task #4620 — operator alerting for lifetime-vs-monthly lead mismatches.
 *
 * Task #4592 made the public report's Lifetime Value slide hide its
 * compounding-arc chart and console.warn when the trend window's per-source
 * lead sum (gbp + googleAds + lsa + webinar per month) EXCEEDS the lifetime
 * headline (`lifetimeValue.totalLeads`). That gate only surfaces in the
 * viewer's browser console, so the underlying data problem (bad backfill,
 * edited month, formula drift) goes unnoticed by operators while clients
 * silently lose the chart.
 *
 * This module runs the SAME check server-side at serve time — called from
 * buildReportResponse in server/routes/reports.ts, the shared payload builder
 * behind both GET /api/share/:token and the authenticated preview — and
 * dispatches a deduped operator notification through the shared dispatcher.
 * It mirrors server/services/reportJsonbCorruptionAlerts.ts (Task #4197)
 * exactly:
 *
 *   - The check mirrors the slide's gates: it only evaluates when the slide
 *     would even attempt the arc (totalLeads > 0, trendData with ≥2 months,
 *     every month carrying a per-source breakdown) and flags only
 *     windowTotal > totalLeads — the exact condition that hides the chart.
 *   - Dedupe is per report: dispatcher dedupeKey
 *     `lifetime_lead_mismatch:<reportId>`, plus an in-process per-report
 *     re-alert window so a hot share link doesn't write a `skipped_deduped`
 *     delivery row on EVERY view of the same inconsistent report.
 *   - No client content in the alert body — report/client ids, month, and
 *     the two numbers only.
 *   - Dispatch is fire-and-forget and never throws into the serve path.
 *   - Under NODE_ENV=test the real dispatcher is NEVER used: notify defaults
 *     to a no-op unless a test injects a stub, so share-route suites serving
 *     inconsistent fixtures can't write notification_deliveries rows.
 */
import { registerModuleStateResetForTest } from "./moduleStateReset";

export const LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID = "infra.reports.lifetime_lead_mismatch";
/** Zero-notify tests filter captured dispatches by this dedupeKey prefix. */
export const LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX = "lifetime_lead_mismatch:";
/** In-process floor between dispatch attempts for the SAME report. */
export const LIFETIME_LEAD_MISMATCH_REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The slide's per-source month sum (LifetimeValueSlide.tsx, Task #4592). */
export interface LeadsBySourceEntry {
  gbp?: number;
  googleAds?: number;
  lsa?: number;
  webinar?: number;
}

export interface LifetimeLeadMismatchInput {
  reportId: string;
  clientId: string;
  reportMonth: string;
  /** The served lifetimeValue.totalLeads headline. */
  totalLeads: number;
  /** The served trendData months' marketing.leadsBySource (undefined on legacy months). */
  monthlyLeadsBySource: Array<LeadsBySourceEntry | undefined>;
}

// ── notifyByType injection (test seam, same pattern as other infra alerts) ──
type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let _notifyOverride: NotifyByTypeFn | null = null;
export function __setLifetimeLeadMismatchNotifyForTest(fn: NotifyByTypeFn | null): void {
  _notifyOverride = fn;
}

async function resolveNotify(): Promise<NotifyByTypeFn | null> {
  if (_notifyOverride) return _notifyOverride;
  // Hermetic-by-default under test: never touch the real dispatcher (and its
  // db/storage/Slack import chain) unless a test explicitly injected a stub.
  if (process.env.NODE_ENV === "test") return null;
  return (await import("./notifications/dispatcher")).notifyByType;
}

/** Epoch ms of the last dispatch ATTEMPT per report id. */
const lastAlertAtByReport = new Map<string, number>();
/** In-flight dispatches, awaitable by tests via __drainLifetimeLeadMismatchAlertsForTest. */
const pendingDispatches = new Set<Promise<void>>();

/**
 * Compute the trend window's per-source lead sum using the slide's exact
 * formula, or null when the slide wouldn't reconcile at all (fewer than two
 * months, or any month missing the per-source breakdown — the slide's
 * legacy-payload gate).
 */
export function computeTrendWindowLeadTotal(
  monthlyLeadsBySource: Array<LeadsBySourceEntry | undefined>,
): number | null {
  if (monthlyLeadsBySource.length < 2) return null;
  if (monthlyLeadsBySource.some((s) => !s)) return null;
  return monthlyLeadsBySource.reduce(
    (total, s) => total + ((s!.gbp || 0) + (s!.googleAds || 0) + (s!.lsa || 0) + (s!.webinar || 0)),
    0,
  );
}

async function dispatchAlert(input: LifetimeLeadMismatchInput, windowTotal: number): Promise<void> {
  const notifyByType = await resolveNotify();
  if (!notifyByType) return;
  await notifyByType(
    LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID,
    {
      text:
        `🔴 Report data inconsistency: the trend window's per-source lead sum (${windowTotal}) ` +
        `exceeds the lifetime headline lifetimeValue.totalLeads (${input.totalLeads}) for report ` +
        `${input.reportId} (client ${input.clientId}, month ${input.reportMonth}). ` +
        `The Lifetime Value slide is hiding its compounding-arc chart for viewers until the data is repaired ` +
        `(likely a bad backfill, an edited month, or formula drift between the monthly and lifetime sums).`,
    },
    {
      triggerSource: "alert_service",
      dedupeKey: `${LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX}${input.reportId}`,
      failureType: "malformed",
      metadata: {
        reportId: input.reportId,
        clientId: input.clientId,
        reportMonth: input.reportMonth,
        totalLeads: input.totalLeads,
        trendWindowLeadTotal: windowTotal,
      },
    },
  );
}

/**
 * Serve-time check: mirrors the slide's arc gates and dispatches a deduped
 * operator alert when the window sum exceeds the lifetime headline.
 * Synchronous and throw-safe from the caller's perspective.
 */
export function checkLifetimeLeadMismatch(input: LifetimeLeadMismatchInput): void {
  try {
    // Mirror the slide's gates: no headline, or an arc the slide would never
    // attempt, means no reconciliation claim to violate.
    if (!(input.totalLeads > 0)) return;
    const windowTotal = computeTrendWindowLeadTotal(input.monthlyLeadsBySource);
    if (windowTotal === null || windowTotal <= input.totalLeads) return;

    console.warn(
      `[LifetimeLeadMismatch] report ${input.reportId} (${input.reportMonth}): trend-window lead sum ` +
        `(${windowTotal}) exceeds lifetimeValue.totalLeads (${input.totalLeads}) — the slide hides the ` +
        `compounding arc for this payload; dispatching operator alert.`,
    );

    const now = Date.now();
    const lastAt = lastAlertAtByReport.get(input.reportId) ?? 0;
    if (now - lastAt < LIFETIME_LEAD_MISMATCH_REALERT_INTERVAL_MS) return;
    lastAlertAtByReport.set(input.reportId, now);

    const p = dispatchAlert(input, windowTotal)
      .catch((err) => {
        console.error(`[LifetimeLeadMismatch] alert dispatch failed for report ${input.reportId}:`, err);
      })
      .finally(() => {
        pendingDispatches.delete(p);
      });
    pendingDispatches.add(p);
    void p;
  } catch (err) {
    // Never let the consistency check break a client-facing serve.
    console.error("[LifetimeLeadMismatch] check failed (report still served):", err);
  }
}

/** Await every in-flight dispatch (test helper). */
export async function __drainLifetimeLeadMismatchAlertsForTest(): Promise<void> {
  while (pendingDispatches.size > 0) {
    await Promise.all([...pendingDispatches]);
  }
}

/** Clear per-report throttle state and the injected notify stub. */
export function __resetLifetimeLeadMismatchAlertsForTest(): void {
  lastAlertAtByReport.clear();
  _notifyOverride = null;
}

// Batched test runner: clear throttle state between suites so one suite's
// alert doesn't suppress a sibling's expected emission.
registerModuleStateResetForTest("lifetimeLeadMismatchAlerts", __resetLifetimeLeadMismatchAlertsForTest);
