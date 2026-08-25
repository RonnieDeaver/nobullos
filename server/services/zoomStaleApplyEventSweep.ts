// @db-pool-intent: worker
/**
 * Task #3699 — crash-safe event-level retry for Zoom apply events.
 *
 * The Zoom apply handlers (`handleZoomMeetingApply` /
 * `handleZoomTranscriptApply`) mark the source event `ready_to_apply` and
 * can then die mid-apply. The work_queue job's own retries (maxAttempts=2)
 * exhaust separately, while the event's `attempt_count` stays 0 — so the
 * event is never re-driven and sits `ready_to_apply` forever (35
 * transcript_completed + ~374 recording_completed rows found wedged in
 * production, Apr–Jul 2026).
 *
 * This sweep is the event-level retry loop:
 *   - Finds zoom `recording_completed` / `transcript_completed` events
 *     stuck in `ready_to_apply` (also `received` / `normalized` — a crash
 *     can strand those too) older than the staleness threshold.
 *   - While `attempt_count < max_attempts`: increments `attempt_count`
 *     and re-enqueues the matching apply job (the apply handlers are
 *     idempotent — already-applied work short-circuits as skipped).
 *   - Once attempts are exhausted: marks the event terminally `failed`
 *     with a stored reason (`apply_retries_exhausted`) — never silent
 *     `ready_to_apply` forever.
 *   - Alerts once per streak (`infra.zoom.stale_apply_events`) when stale
 *     events are found, re-arming when a sweep finds none, so a
 *     recurrence can't hide for months again.
 *
 * Runs nightly from the Zoom reconciliation tick and on demand via the
 * `drain_stale_zoom_apply_events` prod-action.
 */
import { workerDb } from "../db";
import { sourceEventLog } from "@shared/models/durablePipeline";
import { and, eq, inArray, lt, sql, asc } from "drizzle-orm";

/** An apply event is considered stale after 6 hours without progress. */
export const ZOOM_APPLY_EVENT_STALE_MS = 6 * 60 * 60 * 1000;

/** Per-sweep cap so one pass stays bounded. */
export const ZOOM_APPLY_SWEEP_LIMIT = 500;

const ZOOM_APPLY_EVENT_TYPES = ["recording_completed", "transcript_completed"] as const;
/**
 * Pre-terminal statuses a crashed apply can strand an event in. The
 * handler walks received → normalized → ready_to_apply before the real
 * write, so a crash at any of those points leaves the event un-driven.
 */
const STUCK_STATUSES = ["received", "normalized", "ready_to_apply"] as const;

const ALERT_STREAK_SETTING = "zoom_stale_apply_alert_active";

export interface ZoomStaleApplySweepResult {
  scanned: number;
  requeued: number;
  terminal: number;
  errors: string[];
}

/** Count zoom apply events stuck pre-apply past the staleness threshold. */
export async function countStaleZoomApplyEvents(
  staleMs: number = ZOOM_APPLY_EVENT_STALE_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const [row] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceEventLog)
    .where(
      and(
        eq(sourceEventLog.sourceSystem, "zoom"),
        inArray(sourceEventLog.sourceEventType, [...ZOOM_APPLY_EVENT_TYPES]),
        inArray(sourceEventLog.status, [...STUCK_STATUSES]),
        lt(sourceEventLog.updatedAt, cutoff),
      ),
    );
  return row?.count ?? 0;
}

function applyQueueForEventType(eventType: string): "zoom_meeting_apply" | "zoom_transcript_apply" {
  return eventType === "recording_completed" ? "zoom_meeting_apply" : "zoom_transcript_apply";
}

function meetingUuidFromEvent(event: {
  payloadJson: unknown;
  sourceObjectId: string;
}): string {
  const p = event.payloadJson as any;
  const obj = p?.object || p;
  return obj?.uuid || event.sourceObjectId;
}

/**
 * One bounded sweep pass. Idempotent and convergent: every stale event
 * either gets a bounded re-drive (attempt_count increments; the enqueued
 * apply job moves it to applied/failed) or is terminally closed with a
 * stored reason once attempts are exhausted.
 */
export async function sweepStaleZoomApplyEvents(opts?: {
  staleMs?: number;
  limit?: number;
  /** Test seam — replaces the real work-queue enqueue. */
  enqueue?: (params: {
    queueName: string;
    payload: Record<string, unknown>;
    dedupeKey: string;
  }) => Promise<unknown>;
  /** Skip the once-per-streak alert (prod-action path alerts itself). */
  skipAlert?: boolean;
}): Promise<ZoomStaleApplySweepResult> {
  const staleMs = opts?.staleMs ?? ZOOM_APPLY_EVENT_STALE_MS;
  const limit = opts?.limit ?? ZOOM_APPLY_SWEEP_LIMIT;
  const cutoff = new Date(Date.now() - staleMs);
  const errors: string[] = [];

  const stale = await workerDb
    .select({
      id: sourceEventLog.id,
      sourceEventType: sourceEventLog.sourceEventType,
      sourceObjectId: sourceEventLog.sourceObjectId,
      payloadJson: sourceEventLog.payloadJson,
      attemptCount: sourceEventLog.attemptCount,
      maxAttempts: sourceEventLog.maxAttempts,
      updatedAt: sourceEventLog.updatedAt,
    })
    .from(sourceEventLog)
    .where(
      and(
        eq(sourceEventLog.sourceSystem, "zoom"),
        inArray(sourceEventLog.sourceEventType, [...ZOOM_APPLY_EVENT_TYPES]),
        inArray(sourceEventLog.status, [...STUCK_STATUSES]),
        lt(sourceEventLog.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(sourceEventLog.updatedAt))
    .limit(limit);

  let requeued = 0;
  let terminal = 0;

  let enqueue = opts?.enqueue;
  if (!enqueue && stale.length > 0) {
    const { enqueueJob } = await import("./workScheduler");
    enqueue = (params) =>
      enqueueJob({
        queueName: params.queueName,
        workloadClass: "ingestion",
        priority: 200,
        payload: params.payload,
        dedupeKey: params.dedupeKey,
        maxAttempts: 2,
      });
  }

  for (const event of stale) {
    try {
      if (event.attemptCount >= event.maxAttempts) {
        // Bounded retries exhausted — terminal close with a stored reason.
        await workerDb
          .update(sourceEventLog)
          .set({
            status: "failed",
            errorCode: "apply_retries_exhausted",
            errorMessage: `Zoom ${event.sourceEventType} apply never completed after ${event.attemptCount} event-level retries; last progress ${event.updatedAt?.toISOString?.() ?? "unknown"}. Closed by stale-apply sweep (Task #3699).`,
            updatedAt: new Date(),
          })
          .where(eq(sourceEventLog.id, event.id));
        terminal++;
        console.warn(
          `[ZoomStaleApplySweep] Event ${event.id} (${event.sourceEventType}) terminally failed after ${event.attemptCount} retries`,
        );
        continue;
      }

      // Increment the event-level attempt counter FIRST (crash-safe: if we
      // die between the update and the enqueue, the next sweep re-drives).
      const attempt = event.attemptCount + 1;
      await workerDb
        .update(sourceEventLog)
        .set({
          attemptCount: attempt,
          updatedAt: new Date(),
        })
        .where(eq(sourceEventLog.id, event.id));

      const meetingUuid = meetingUuidFromEvent(event);
      const queueName = applyQueueForEventType(event.sourceEventType);
      await enqueue!({
        queueName,
        payload: {
          sourceEventId: event.id,
          meetingUuid,
          meetingId: meetingUuid,
          eventType: event.sourceEventType,
          source: "stale_apply_sweep",
        },
        // Attempt-scoped dedupe key: never collides with the original
        // webhook/reconciliation enqueue (`<queue>:<eventId>`) or an
        // earlier sweep retry that may still be active in the queue.
        dedupeKey: `${queueName}:${event.id}:retry${attempt}`,
      });
      requeued++;
    } catch (err: any) {
      errors.push(`${event.id}: ${err?.message ?? err}`);
    }
  }

  if (!opts?.skipAlert) {
    await maybeAlertStaleApplyEvents(stale.length, { requeued, terminal });
  }

  if (stale.length > 0) {
    console.log(
      `[ZoomStaleApplySweep] scanned=${stale.length} requeued=${requeued} terminal=${terminal} errors=${errors.length}`,
    );
  }

  return { scanned: stale.length, requeued, terminal, errors };
}

/**
 * Once-per-streak ops alert: fires when a sweep finds stale apply events
 * and the previous sweep did not; re-arms when a sweep finds none.
 * (Deterministic condition → no consecutive-failure threshold, per the
 * blocked-vs-error alerting convention.)
 */
async function maybeAlertStaleApplyEvents(
  staleCount: number,
  detail: { requeued: number; terminal: number },
): Promise<void> {
  try {
    const { storage } = await import("../storage");
    const active = (await storage.getSystemSetting(ALERT_STREAK_SETTING))?.value === "true";
    if (staleCount === 0) {
      if (active) {
        await storage.setSystemSetting(ALERT_STREAK_SETTING, "false", "system");
      }
      return;
    }
    if (active) return; // already alerted this streak
    const { notifyByType } = await import("./notifications/dispatcher");
    await notifyByType(
      "infra.zoom.stale_apply_events",
      {
        text:
          `Zoom apply-event sweep found ${staleCount} event(s) stuck pre-apply past ` +
          `${Math.round(ZOOM_APPLY_EVENT_STALE_MS / 3600000)}h (requeued ${detail.requeued}, ` +
          `terminally closed ${detail.terminal}). These are Zoom recordings/transcripts whose ` +
          `attach-to-meeting apply crashed; the sweep is re-driving them with bounded retries.`,
      },
      { triggerSource: "scheduled", dedupeKey: "zoom_stale_apply_events" },
    );
    await storage.setSystemSetting(ALERT_STREAK_SETTING, "true", "system");
  } catch (err: any) {
    console.warn(
      `[ZoomStaleApplySweep] alert bookkeeping failed (sweep result unaffected): ${err?.message ?? err}`,
    );
  }
}
