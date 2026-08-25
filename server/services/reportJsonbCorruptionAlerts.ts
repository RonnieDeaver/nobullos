/**
 * Task #4197 — operator alerting for corrupted REPORTS JSONB rows.
 *
 * F5 (#4151) made every reports JSONB boundary degrade gracefully on
 * malformed stored data, logging a `[reportJsonbAccessors] Malformed
 * <boundary>...` console warning. Those warnings are invisible in production
 * unless someone tails logs, so a corrupted report_sections.data /
 * ceo_pulses.ai_analysis row would silently surface as an empty section or a
 * missing analysis. This module wires the reportJsonbAccessors
 * malformed-event seam (`setReportJsonbMalformedListener`) into the shared
 * notification dispatcher, mirroring server/services/atsJsonbCorruptionAlerts.ts
 * (Task #4184) exactly.
 *
 * Design points:
 *   - reportJsonbAccessors stays a leaf: it never imports this module; the
 *     listener is installed here (at module load, from
 *     server/routes/reports.ts — the route-level consumer of every reports
 *     accessor call path).
 *   - Dedupe is per boundary: the dispatcher dedupeKey is
 *     `report_jsonb_malformed:<boundary>`, plus an in-process per-boundary
 *     re-alert window so hot read paths don't write a `skipped_deduped`
 *     delivery row on EVERY read of the same bad row.
 *   - NO stored-value preview in the alert body — stored report data can
 *     carry client content. Only the boundary name, an occurrence count, and
 *     sample row IDs when the call site supplied them. The value preview
 *     stays in the server log where warnMalformed already writes it.
 *   - Dispatch is fire-and-forget and never throws into the accessor path.
 *   - Under NODE_ENV=test the real dispatcher is NEVER used: notify defaults
 *     to a no-op unless a test injects a stub, so suites that merely read a
 *     malformed fixture can't write notification_deliveries rows.
 */
import {
  setReportJsonbMalformedListener,
  type ReportJsonbContext,
  type ReportJsonbMalformedEvent,
} from "../lib/reportJsonbAccessors";
import { registerModuleStateResetForTest } from "./moduleStateReset";

export const REPORT_JSONB_ALERT_NOTIFICATION_ID = "infra.reports.jsonb_malformed";
/** Zero-notify tests filter captured dispatches by this dedupeKey prefix. */
export const REPORT_JSONB_ALERT_DEDUPE_PREFIX = "report_jsonb_malformed:";
/** In-process floor between Slack attempts for the SAME boundary. */
export const REPORT_JSONB_REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── notifyByType injection (test seam, same pattern as other infra alerts) ──
type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let _notifyOverride: NotifyByTypeFn | null = null;
export function __setReportJsonbAlertNotifyForTest(fn: NotifyByTypeFn | null): void {
  _notifyOverride = fn;
}

async function resolveNotify(): Promise<NotifyByTypeFn | null> {
  if (_notifyOverride) return _notifyOverride;
  // Hermetic-by-default under test: never touch the real dispatcher (and its
  // db/storage/Slack import chain) unless a test explicitly injected a stub.
  if (process.env.NODE_ENV === "test") return null;
  return (await import("./notifications/dispatcher")).notifyByType;
}

// ── Per-boundary state ──────────────────────────────────────────────────────
interface BoundaryState {
  /** Malformed observations since boot (or since the last test reset). */
  occurrences: number;
  /** Epoch ms of the last notify ATTEMPT for this boundary; 0 = never. */
  lastAlertAt: number;
  /** Last non-empty row context seen — the "sample id" in the alert body. */
  sampleContext?: ReportJsonbContext;
}

const boundaryState = new Map<string, BoundaryState>();
/** In-flight dispatches, awaitable by tests via __drainReportJsonbAlertsForTest. */
const pendingDispatches = new Set<Promise<void>>();

function formatSampleIds(context?: ReportJsonbContext): string {
  const parts: string[] = [];
  if (context?.clientId) parts.push(`client ${context.clientId}`);
  if (context?.reportId) parts.push(`report ${context.reportId}`);
  if (context?.sectionId) parts.push(`section ${context.sectionId}`);
  if (context?.ceoPulseId) parts.push(`ceo pulse ${context.ceoPulseId}`);
  return parts.length > 0
    ? parts.join(", ")
    : "row id not captured — see the [reportJsonbAccessors] server log line";
}

async function dispatchAlert(event: ReportJsonbMalformedEvent, state: BoundaryState): Promise<void> {
  const notifyByType = await resolveNotify();
  if (!notifyByType) return;
  const sample = formatSampleIds(state.sampleContext);
  await notifyByType(
    REPORT_JSONB_ALERT_NOTIFICATION_ID,
    {
      // Deliberately NO stored-value preview here: stored report data can
      // contain client content. The preview lives in the server log.
      text:
        `🔴 Corrupted reports data detected at \`${event.boundary}\`: a stored row is not ${event.expected}. ` +
        `Reads degrade to the boundary's documented fallback (empty section / missing analysis) until the row is repaired. ` +
        `Sample: ${sample}. Occurrences since boot: ${state.occurrences}. ` +
        `Full stored-value details are in the server logs under "[reportJsonbAccessors] Malformed ${event.boundary}".`,
    },
    {
      triggerSource: "alert_service",
      dedupeKey: `${REPORT_JSONB_ALERT_DEDUPE_PREFIX}${event.boundary}`,
      failureType: "malformed",
      metadata: {
        boundary: event.boundary,
        expected: event.expected,
        occurrencesSinceBoot: state.occurrences,
        sampleClientId: state.sampleContext?.clientId ?? null,
        sampleReportId: state.sampleContext?.reportId ?? null,
        sampleSectionId: state.sampleContext?.sectionId ?? null,
        sampleCeoPulseId: state.sampleContext?.ceoPulseId ?? null,
      },
    },
  );
}

/**
 * The listener installed on reportJsonbAccessors' malformed-event seam.
 * Synchronous and throw-safe from the caller's perspective; the Slack
 * dispatch is fire-and-forget (notifyByType itself resolves rather than
 * throws — the dispatcher records skips/failures in notification_deliveries).
 */
export function handleReportJsonbMalformedEvent(event: ReportJsonbMalformedEvent): void {
  let state = boundaryState.get(event.boundary);
  if (!state) {
    state = { occurrences: 0, lastAlertAt: 0 };
    boundaryState.set(event.boundary, state);
  }
  state.occurrences++;
  const ctx = event.context;
  if (ctx && (ctx.reportId || ctx.sectionId || ctx.clientId || ctx.ceoPulseId)) {
    state.sampleContext = ctx;
  }
  const now = Date.now();
  if (now - state.lastAlertAt < REPORT_JSONB_REALERT_INTERVAL_MS) return;
  state.lastAlertAt = now;
  const p = dispatchAlert(event, state)
    .catch((err) => {
      console.error(`[report JSONB alert] dispatch failed for ${event.boundary}:`, err);
    })
    .finally(() => {
      pendingDispatches.delete(p);
    });
  pendingDispatches.add(p);
  void p;
}

/** Await every in-flight dispatch (test helper). */
export async function __drainReportJsonbAlertsForTest(): Promise<void> {
  while (pendingDispatches.size > 0) {
    await Promise.all([...pendingDispatches]);
  }
}

/** Clear per-boundary throttle/counter state and the injected notify stub. */
export function __resetReportJsonbCorruptionAlertsForTest(): void {
  boundaryState.clear();
  _notifyOverride = null;
}

/** Install the listener; idempotent (last install wins, same handler). */
export function installReportJsonbCorruptionAlerts(): void {
  setReportJsonbMalformedListener(handleReportJsonbMalformedEvent);
}

// Self-install at module load: server/routes/reports.ts imports this module,
// so every server context that can read a reports JSONB boundary has the
// listener.
installReportJsonbCorruptionAlerts();

// Batched test runner: clear throttle state between suites so one suite's
// alert doesn't suppress a sibling's expected emission.
registerModuleStateResetForTest("reportJsonbCorruptionAlerts", __resetReportJsonbCorruptionAlertsForTest);
