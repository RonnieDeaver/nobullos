/* test-registration
{
  "name": "Zoom stale-apply event sweep (Task #3699)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy: seeds shared-dev-DB source_event_log rows; runs in full sweep, not the gate",
  "tier": "small"
}
test-registration */
/**
 * Task #3699 — Zoom stale-apply event sweep.
 *
 * Production had 35 transcript_completed + ~374 recording_completed
 * source_event_log rows wedged at status='ready_to_apply' with
 * attempt_count=0: the apply handler marked the event ready_to_apply and
 * crashed; the work_queue job's own retries exhausted separately and
 * nothing ever re-drove the event.
 *
 * Asserts:
 *  (1) A stale ready_to_apply zoom event under its retry budget is
 *      re-driven: attempt_count increments and the matching apply job is
 *      enqueued with an attempt-scoped dedupe key.
 *  (2) A stale event whose attempt_count >= max_attempts is terminally
 *      closed: status='failed' with errorCode='apply_retries_exhausted'.
 *  (3) A fresh (non-stale) ready_to_apply event is left alone.
 *  (4) recordApplyOutcome with outcome='skipped' now marks the source
 *      event applied (previously only 'success' did — the root cause of
 *      the ~374 recording_completed wedges via the already-exists skip).
 *  (5) countStaleZoomApplyEvents counts only stale pre-apply zoom rows.
 *
 * Isolation: seeds rows with run-unique ids into the shared dev DB via
 * workerDb (matches the sweep's own pool) and deletes them in `finally`.
 * The enqueue seam is stubbed — no real work_queue rows are created.
 *
 * Usage: tsx tests/zoom-stale-apply-event-sweep.test.ts
 */
import { workerDb } from "../server/db";
import {
  sourceEventLog,
  workResultLog,
  applyState,
} from "@shared/models/durablePipeline";
import { eq, inArray } from "drizzle-orm";
import {
  sweepStaleZoomApplyEvents,
  countStaleZoomApplyEvents,
} from "../server/services/zoomStaleApplyEventSweep";
import { recordApplyOutcome } from "../server/services/pipelineProcessor";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const runId = `3699-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const seededIds: string[] = [];

const STALE = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
const FRESH = new Date();

async function seedEvent(opts: {
  suffix: string;
  eventType: "recording_completed" | "transcript_completed";
  status: string;
  attemptCount: number;
  maxAttempts?: number;
  updatedAt: Date;
}): Promise<string> {
  const id = `sev-${runId}-${opts.suffix}`;
  seededIds.push(id);
  await workerDb.insert(sourceEventLog).values({
    id,
    sourceSystem: "zoom",
    sourceEventType: opts.eventType,
    sourceObjectId: `uuid-${runId}-${opts.suffix}`,
    dedupeKey: `zoom:test:${runId}:${opts.suffix}`,
    payloadJson: { object: { uuid: `uuid-${runId}-${opts.suffix}` } },
    status: opts.status,
    attemptCount: opts.attemptCount,
    maxAttempts: opts.maxAttempts ?? 5,
    receivedAt: STALE,
    updatedAt: opts.updatedAt,
  });
  return id;
}

async function readEvent(id: string) {
  const [row] = await workerDb
    .select()
    .from(sourceEventLog)
    .where(eq(sourceEventLog.id, id))
    .limit(1);
  return row;
}

async function main(): Promise<void> {
  console.log("Zoom stale-apply event sweep (Task #3699)");
  const enqueued: Array<{ queueName: string; payload: any; dedupeKey: string }> = [];
  const enqueue = async (p: any) => {
    enqueued.push(p);
  };

  try {
    // Baseline stale count for our rows only (shared dev DB may have others).
    const baselineStale = await countStaleZoomApplyEvents();

    const retryable = await seedEvent({
      suffix: "retryable",
      eventType: "transcript_completed",
      status: "ready_to_apply",
      attemptCount: 0,
      updatedAt: STALE,
    });
    const exhausted = await seedEvent({
      suffix: "exhausted",
      eventType: "recording_completed",
      status: "ready_to_apply",
      attemptCount: 5,
      maxAttempts: 5,
      updatedAt: STALE,
    });
    const fresh = await seedEvent({
      suffix: "fresh",
      eventType: "transcript_completed",
      status: "ready_to_apply",
      attemptCount: 0,
      updatedAt: FRESH,
    });

    // (5) counting
    const staleNow = await countStaleZoomApplyEvents();
    check(
      "countStaleZoomApplyEvents counts the 2 stale seeds (not the fresh one)",
      staleNow === baselineStale + 2,
      `baseline=${baselineStale} now=${staleNow}`,
    );

    // Run the sweep with a stubbed enqueue; no alert bookkeeping.
    const result = await sweepStaleZoomApplyEvents({ enqueue, skipAlert: true });
    check("sweep ran without per-event errors on our seeds",
      result.errors.filter((e) => e.includes(runId)).length === 0,
      result.errors.slice(0, 2).join("; ") || "no errors");

    // (1) retryable event: attempt incremented + job enqueued
    const r = await readEvent(retryable);
    check("retryable event attempt_count incremented to 1", r?.attemptCount === 1);
    check("retryable event stays ready_to_apply (job will advance it)", r?.status === "ready_to_apply");
    const job = enqueued.find((j) => j.payload?.sourceEventId === retryable);
    check("apply job enqueued for retryable event", !!job);
    check(
      "job routed to zoom_transcript_apply with attempt-scoped dedupe key",
      job?.queueName === "zoom_transcript_apply" &&
        job?.dedupeKey === `zoom_transcript_apply:${retryable}:retry1`,
      job?.dedupeKey,
    );
    check(
      "job payload carries meetingUuid from payload_json",
      job?.payload?.meetingUuid === `uuid-${runId}-retryable`,
    );

    // (2) exhausted event: terminal close with stored reason
    const x = await readEvent(exhausted);
    check("exhausted event terminally failed", x?.status === "failed");
    check(
      "exhausted event stores errorCode apply_retries_exhausted",
      x?.errorCode === "apply_retries_exhausted",
    );
    check(
      "exhausted event stores a human-readable reason",
      typeof x?.errorMessage === "string" && x.errorMessage.length > 0,
    );
    check(
      "no apply job enqueued for the exhausted event",
      !enqueued.some((j) => j.payload?.sourceEventId === exhausted),
    );

    // (3) fresh event untouched
    const f = await readEvent(fresh);
    check(
      "fresh event untouched (still ready_to_apply, attempt 0)",
      f?.status === "ready_to_apply" && f?.attemptCount === 0,
    );

    // (4) recordApplyOutcome 'skipped' marks the event applied.
    const skippedEvent = await seedEvent({
      suffix: "skipped",
      eventType: "recording_completed",
      status: "ready_to_apply",
      attemptCount: 0,
      updatedAt: STALE,
    });
    const [wr] = await workerDb
      .insert(workResultLog)
      .values({
        sourceEventId: skippedEvent,
        sourceSystem: "zoom",
        resultType: "meeting_metadata",
        resultJson: { action: "already_exists" },
        status: "completed",
      })
      .returning({ id: workResultLog.id });
    await recordApplyOutcome({
      sourceEventId: skippedEvent,
      workResultId: wr.id,
      sourceSystem: "zoom",
      sourceEventType: "recording_completed",
      applyTarget: "raw_communication_records",
      outcome: "skipped",
      responseJson: { reason: "already_exists" },
    });
    const s = await readEvent(skippedEvent);
    check(
      "skipped apply outcome marks the source event applied",
      s?.status === "applied" && s?.appliedAt != null,
      `status=${s?.status}`,
    );
  } finally {
    // Cascades delete work_result_log + apply_state rows.
    if (seededIds.length > 0) {
      await workerDb
        .delete(sourceEventLog)
        .where(inArray(sourceEventLog.id, seededIds));
    }
  }

  console.log(`\nTest summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Test crashed:", err);
    process.exitCode = 1;
  })
  .then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
