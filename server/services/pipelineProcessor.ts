import { workerDb } from "../db";
import {
  sourceEventLog,
  workResultLog,
  applyState,
} from "@shared/models/durablePipeline";
import type {
  InsertSourceEventLog,
} from "@shared/models/durablePipeline";
import { eq, and, sql } from "drizzle-orm";
import { pipelineLog } from "./pipelineLogger";
import { incrementDedupeHits } from "./pipelineObservability";
import { upsertApplyState } from "./applyPipeline";
import { randomUUID } from "crypto";

export async function ingestEvent(
  event: InsertSourceEventLog,
): Promise<{ id: string; deduplicated: boolean }> {
  const correlationId = event.correlationId ?? randomUUID();
  const startMs = Date.now();

  try {
    const [inserted] = await workerDb
      .insert(sourceEventLog)
      .values({
        ...event,
        correlationId,
        status: "received",
        receivedAt: new Date(),
      })
      .onConflictDoNothing({ target: sourceEventLog.dedupeKey })
      .returning({ id: sourceEventLog.id });

    if (!inserted) {
      incrementDedupeHits("sourceEvent");
      pipelineLog({
        event: "duplicate_ignored",
        sourceSystem: event.sourceSystem,
        sourceEventType: event.sourceEventType,
        dedupeKey: event.dedupeKey,
        correlationId,
        durationMs: Date.now() - startMs,
      });
      return { id: "", deduplicated: true };
    }

    pipelineLog({
      event: "event_received",
      sourceSystem: event.sourceSystem,
      sourceEventType: event.sourceEventType,
      dedupeKey: event.dedupeKey,
      sourceEventId: inserted.id,
      correlationId,
      durationMs: Date.now() - startMs,
    });

    return { id: inserted.id, deduplicated: false };
  } catch (err: any) {
    pipelineLog({
      event: "failed",
      sourceSystem: event.sourceSystem,
      sourceEventType: event.sourceEventType,
      dedupeKey: event.dedupeKey,
      correlationId,
      durationMs: Date.now() - startMs,
      errorMessage: err.message,
      outcome: "ingest_failed",
    });
    throw err;
  }
}

export async function markNormalized(
  sourceEventId: string,
  sourceSystem: string,
  sourceEventType: string,
  normalizedKeys: Record<string, unknown>,
): Promise<void> {
  const startMs = Date.now();
  const correlationId = await getCorrelationId(sourceEventId);

  await workerDb
    .update(sourceEventLog)
    .set({
      status: "normalized",
      normalizedIdentityKeysJson: normalizedKeys,
      normalizedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sourceEventLog.id, sourceEventId));

  pipelineLog({
    event: "normalized",
    sourceSystem,
    sourceEventType,
    sourceEventId,
    correlationId,
    durationMs: Date.now() - startMs,
  });
}

export async function markReadyToApply(
  sourceEventId: string,
  sourceSystem: string,
  sourceEventType: string,
): Promise<void> {
  const startMs = Date.now();
  const correlationId = await getCorrelationId(sourceEventId);

  await workerDb
    .update(sourceEventLog)
    .set({
      status: "ready_to_apply",
      updatedAt: new Date(),
    })
    .where(eq(sourceEventLog.id, sourceEventId));

  pipelineLog({
    event: "ready_to_apply",
    sourceSystem,
    sourceEventType,
    sourceEventId,
    correlationId,
    durationMs: Date.now() - startMs,
  });
}

export async function recordApplyOutcome(
  params: {
    sourceEventId: string;
    workResultId: string;
    sourceSystem: string;
    sourceEventType: string;
    applyTarget: string;
    outcome: "success" | "partial" | "conflict" | "failed" | "skipped";
    rulesetVersion?: string;
    appliedVersion?: string;
    inputHash?: string;
    responseJson?: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<string> {
  const startMs = Date.now();
  const correlationId = await getCorrelationId(params.sourceEventId);

  // Task #1836 — route through the canonical writer so we get
  // ON CONFLICT (work_result_id, apply_target) DO UPDATE semantics.
  // Plain .insert(applyState) here previously dead-lettered when a
  // pending row had already been seeded by applyPipeline's
  // getOrCreateApplyState or by a concurrent worker.
  const row = await upsertApplyState({
    sourceEventId: params.sourceEventId,
    workResultId: params.workResultId,
    sourceSystem: params.sourceSystem,
    applyTarget: params.applyTarget,
    outcome: params.outcome,
    rulesetVersion: params.rulesetVersion ?? null,
    appliedVersion: params.appliedVersion ?? null,
    inputHash: params.inputHash ?? null,
    responseJson: params.responseJson ?? null,
    errorCode: params.errorCode ?? null,
    errorMessage: params.errorMessage ?? null,
  });

  const isNoOp = params.outcome === "skipped";
  const isFailed = params.outcome === "failed" || params.outcome === "conflict";

  pipelineLog({
    event: isNoOp ? "no_op" : isFailed ? "failed" : "applied",
    sourceSystem: params.sourceSystem,
    sourceEventType: params.sourceEventType,
    sourceEventId: params.sourceEventId,
    correlationId,
    durationMs: Date.now() - startMs,
    outcome: params.outcome,
    applyTarget: params.applyTarget,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  });

  // Task #3699: `skipped` is also a fully-handled outcome (duplicate /
  // already-applied) — previously only `success` advanced the event, so
  // skipped applies left source_event_log rows wedged at `ready_to_apply`
  // forever (~374 zoom recording_completed rows in production).
  if (params.outcome === "success" || params.outcome === "skipped") {
    await markEventApplied(params.sourceEventId, params.sourceSystem, params.sourceEventType);
  }

  return row.id;
}

/**
 * Task #3699 — terminal event-level failure with a stored reason. Used
 * when an apply path determines the event can never succeed (e.g. Zoom
 * deleted the recording so the transcript is permanently gone) or when event-level
 * retries are exhausted. Never leaves an event silently `ready_to_apply`.
 */
export async function markEventTerminalFailed(
  sourceEventId: string,
  sourceSystem: string,
  sourceEventType: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const correlationId = await getCorrelationId(sourceEventId);
  await workerDb
    .update(sourceEventLog)
    .set({
      status: "failed",
      errorCode,
      errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(sourceEventLog.id, sourceEventId));

  pipelineLog({
    event: "failed",
    sourceSystem,
    sourceEventType,
    sourceEventId,
    correlationId,
    outcome: "terminal_failed",
    errorCode,
    errorMessage,
  });
}

export async function replayEvent(
  sourceEventId: string,
  sourceSystem: string,
  sourceEventType: string,
): Promise<void> {
  const startMs = Date.now();
  const correlationId = await getCorrelationId(sourceEventId);

  await workerDb
    .update(sourceEventLog)
    .set({
      status: "received",
      attemptCount: sql`${sourceEventLog.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sourceEventLog.id, sourceEventId),
        eq(sourceEventLog.replayable, true),
      ),
    );

  pipelineLog({
    event: "replayed",
    sourceSystem,
    sourceEventType,
    sourceEventId,
    correlationId,
    durationMs: Date.now() - startMs,
  });
}

export function reconcileSource(
  sourceSystem: string,
  reconciledCount: number,
  deltaFound: number,
): Promise<void> {
  const startMs = Date.now();

  pipelineLog({
    event: "reconciled",
    sourceSystem,
    sourceEventType: "reconciliation",
    durationMs: Date.now() - startMs,
    reconciledCount,
    deltaFound,
  });
  return Promise.resolve();
}

async function markEventApplied(
  sourceEventId: string,
  sourceSystem: string,
  sourceEventType: string,
): Promise<void> {
  const [pendingApplies] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(applyState)
    .where(
      and(
        eq(applyState.sourceEventId, sourceEventId),
        eq(applyState.outcome, "pending"),
      ),
    );

  if ((pendingApplies?.count ?? 0) === 0) {
    await workerDb
      .update(sourceEventLog)
      .set({
        status: "applied",
        appliedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceEventLog.id, sourceEventId));
  }
}

async function getCorrelationId(sourceEventId: string): Promise<string | undefined> {
  try {
    const [row] = await workerDb
      .select({ correlationId: sourceEventLog.correlationId })
      .from(sourceEventLog)
      .where(eq(sourceEventLog.id, sourceEventId))
      .limit(1);
    return row?.correlationId ?? undefined;
  } catch {
    return undefined;
  }
}
