/**
 * Task #4184 — operator alerting for corrupted ATS JSONB rows.
 *
 * F4 (#4150) made every ATS JSONB boundary degrade gracefully on malformed
 * stored data, logging a `[ATS JSONB] <table.column>: expected <shape>...`
 * console warning. Those warnings are invisible in production unless someone
 * tails logs, so a corrupted ai_score_json/assessment_json would silently
 * surface as a missing score or a shorter assessment. This module wires the
 * atsJsonb malformed-event seam (`setAtsJsonbMalformedListener`) into the
 * shared notification dispatcher so the team learns about stored-data
 * corruption when it first appears.
 *
 * Design points:
 *   - atsJsonb stays a leaf: it never imports this module; the listener is
 *     installed here (at module load, from server/routes/ats.ts — the only
 *     importer of every atsJsonb consumer).
 *   - Dedupe is per table.column boundary: the dispatcher dedupeKey is
 *     `ats_jsonb_malformed:<boundary>`, so one bad row read in a loop can't
 *     spam Slack. An in-process per-boundary re-alert window additionally
 *     keeps hot read paths from writing a `skipped_deduped` delivery row on
 *     EVERY read of the same bad row.
 *   - NO candidate PII and NO stored-value preview in the alert body — only
 *     the boundary name, the expected shape, an occurrence count, and sample
 *     row IDs (UUIDs) when the call site supplied them. The value preview
 *     stays in the server log where warnMalformed already writes it.
 *   - Dispatch is fire-and-forget and never throws into the accessor path.
 *   - Under NODE_ENV=test the real dispatcher is NEVER used: notify defaults
 *     to a no-op unless a test injects a stub, so suites that merely read a
 *     malformed fixture can't write notification_deliveries rows.
 */
import {
  setAtsJsonbMalformedListener,
  type AtsJsonbContext,
  type AtsJsonbMalformedEvent,
} from "./atsJsonb";
import { registerModuleStateResetForTest } from "./moduleStateReset";

export const ATS_JSONB_ALERT_NOTIFICATION_ID = "infra.ats.jsonb_malformed";
/** Zero-notify tests filter captured dispatches by this dedupeKey prefix. */
export const ATS_JSONB_ALERT_DEDUPE_PREFIX = "ats_jsonb_malformed:";
/** In-process floor between Slack attempts for the SAME boundary. */
export const ATS_JSONB_REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── notifyByType injection (test seam, same pattern as other infra alerts) ──
type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let _notifyOverride: NotifyByTypeFn | null = null;
export function __setAtsJsonbAlertNotifyForTest(fn: NotifyByTypeFn | null): void {
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
  sampleContext?: AtsJsonbContext;
}

const boundaryState = new Map<string, BoundaryState>();
/** In-flight dispatches, awaitable by tests via __drainAtsJsonbAlertsForTest. */
const pendingDispatches = new Set<Promise<void>>();

function formatSampleIds(context?: AtsJsonbContext): string {
  const parts: string[] = [];
  if (context?.jobId) parts.push(`job ${context.jobId}`);
  if (context?.candidateId) parts.push(`candidate ${context.candidateId}`);
  if (context?.interviewId) parts.push(`interview ${context.interviewId}`);
  return parts.length > 0 ? parts.join(", ") : "row id not captured — see the [ATS JSONB] server log line";
}

async function dispatchAlert(event: AtsJsonbMalformedEvent, state: BoundaryState): Promise<void> {
  const notifyByType = await resolveNotify();
  if (!notifyByType) return;
  const sample = formatSampleIds(state.sampleContext);
  await notifyByType(
    ATS_JSONB_ALERT_NOTIFICATION_ID,
    {
      // Deliberately NO stored-value preview here: previews can contain
      // candidate-supplied content. The preview lives in the server log.
      text:
        `🔴 Corrupted ATS data detected at \`${event.boundary}\`: a stored row is not ${event.expected}. ` +
        `Reads degrade to the boundary's documented fallback (missing score / shorter assessment) until the row is repaired. ` +
        `Sample: ${sample}. Occurrences since boot: ${state.occurrences}. ` +
        `Full stored-value preview is in the server logs under "[ATS JSONB] ${event.boundary}".`,
    },
    {
      triggerSource: "alert_service",
      dedupeKey: `${ATS_JSONB_ALERT_DEDUPE_PREFIX}${event.boundary}`,
      failureType: "malformed",
      metadata: {
        boundary: event.boundary,
        expected: event.expected,
        occurrencesSinceBoot: state.occurrences,
        sampleJobId: state.sampleContext?.jobId ?? null,
        sampleCandidateId: state.sampleContext?.candidateId ?? null,
        sampleInterviewId: state.sampleContext?.interviewId ?? null,
      },
    },
  );
}

/**
 * The listener installed on atsJsonb's malformed-event seam. Synchronous and
 * throw-safe from the caller's perspective; the Slack dispatch is
 * fire-and-forget (notifyByType itself resolves rather than throws — the
 * dispatcher records skips/failures in notification_deliveries).
 */
export function handleAtsJsonbMalformedEvent(event: AtsJsonbMalformedEvent): void {
  let state = boundaryState.get(event.boundary);
  if (!state) {
    state = { occurrences: 0, lastAlertAt: 0 };
    boundaryState.set(event.boundary, state);
  }
  state.occurrences++;
  const ctx = event.context;
  if (ctx && (ctx.jobId || ctx.candidateId || ctx.interviewId)) {
    state.sampleContext = ctx;
  }
  const now = Date.now();
  if (now - state.lastAlertAt < ATS_JSONB_REALERT_INTERVAL_MS) return;
  state.lastAlertAt = now;
  const p = dispatchAlert(event, state)
    .catch((err) => {
      console.error(`[ATS JSONB alert] dispatch failed for ${event.boundary}:`, err);
    })
    .finally(() => {
      pendingDispatches.delete(p);
    });
  pendingDispatches.add(p);
  void p;
}

/** Await every in-flight dispatch (test helper). */
export async function __drainAtsJsonbAlertsForTest(): Promise<void> {
  while (pendingDispatches.size > 0) {
    await Promise.all([...pendingDispatches]);
  }
}

/** Clear per-boundary throttle/counter state and the injected notify stub. */
export function __resetAtsJsonbCorruptionAlertsForTest(): void {
  boundaryState.clear();
  _notifyOverride = null;
}

/** Install the listener; idempotent (last install wins, same handler). */
export function installAtsJsonbCorruptionAlerts(): void {
  setAtsJsonbMalformedListener(handleAtsJsonbMalformedEvent);
}

// Self-install at module load: server/routes/ats.ts imports this module, so
// every server context that can read an ATS JSONB boundary has the listener.
installAtsJsonbCorruptionAlerts();

// Batched test runner: clear throttle state between suites so one suite's
// alert doesn't suppress a sibling's expected emission.
registerModuleStateResetForTest("atsJsonbCorruptionAlerts", __resetAtsJsonbCorruptionAlertsForTest);
