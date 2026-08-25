import { workerDb } from "../db";
import {
  sourceEventLog,
  workResultLog,
  applyState,
} from "@shared/models/durablePipeline";
import type {
  SourceEventLogRow,
  SourceSystem,
  WorkResultLogRow,
} from "@shared/models/durablePipeline";
import type { WorkQueueJob } from "@shared/schema";
import { eq, and, sql, gte, lte, inArray, ne, asc } from "drizzle-orm";
import { pipelineLog } from "./pipelineLogger";
import { workerLog } from "./workerLogger";
import { ingestEvent, replayEvent } from "./pipelineProcessor";
import { enqueueRepairJob } from "./repairDispatcher";
import { randomUUID, createHash } from "crypto";

export type ReplayMode = "event_log_replay" | "vendor_reconciliation" | "ruleset_backfill";

export interface ReplayCursor {
  mode: ReplayMode;
  source: SourceSystem;
  runId: string;
  lastProcessedId?: string;
  lastReceivedAt?: string;
  lastCreatedAt?: string;
  chunkIndex: number;
  totalProcessed: number;
  totalSkipped: number;
  totalFailed: number;
  vendorCursor?: string;
  complete: boolean;
}

export interface ReplayJobConfig {
  mode: ReplayMode;
  source: SourceSystem;
  runId?: string;
  dateFrom?: string;
  dateTo?: string;
  chunkSize?: number;
  eventTypes?: string[];
  statuses?: string[];
  rulesetVersion?: string;
  newRulesetVersion?: string;
  vendorCursor?: string;
  maxAttempts?: number;
  dryRun?: boolean;
  _cursor?: ReplayCursor;
}

export interface ReplayChunkResult {
  processed: number;
  skipped: number;
  failed: number;
  cursor: ReplayCursor;
}

const DEFAULT_CHUNK_SIZE = 100;
const MAX_CHUNK_SIZE = 500;

function parseReplayConfig(job: WorkQueueJob): ReplayJobConfig {
  const p = job.payload as Record<string, unknown> | null;
  if (!p) throw new Error("Replay job requires payload with config");
  return {
    mode: p.mode as ReplayMode,
    source: p.source as SourceSystem,
    runId: p.runId as string | undefined,
    dateFrom: p.dateFrom as string | undefined,
    dateTo: p.dateTo as string | undefined,
    chunkSize: p.chunkSize as number | undefined,
    eventTypes: p.eventTypes as string[] | undefined,
    statuses: p.statuses as string[] | undefined,
    rulesetVersion: p.rulesetVersion as string | undefined,
    newRulesetVersion: p.newRulesetVersion as string | undefined,
    vendorCursor: p.vendorCursor as string | undefined,
    maxAttempts: p.maxAttempts as number | undefined,
    dryRun: p.dryRun as boolean | undefined,
    _cursor: p._cursor as ReplayCursor | undefined,
  };
}

function extractCursor(config: ReplayJobConfig): ReplayCursor | null {
  if (config._cursor && typeof config._cursor === "object" && "chunkIndex" in config._cursor) {
    return config._cursor;
  }
  return null;
}

function clampChunkSize(requested?: number): number {
  if (!requested || requested <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.min(requested, MAX_CHUNK_SIZE);
}

export async function handleEventLogReplay(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const config = parseReplayConfig(job);
  const existingCursor = extractCursor(config);
  const chunkSize = clampChunkSize(config.chunkSize);
  const runId = config.runId ?? existingCursor?.runId ?? randomUUID();
  const correlationId = randomUUID();

  workerLog({
    worker: "replay_framework",
    event: "replay_started",
    mode: "event_log_replay",
    source: config.source,
    jobId: job.id,
    runId,
  });

  const conditions = [eq(sourceEventLog.sourceSystem, config.source)];

  if (config.dateFrom) {
    conditions.push(gte(sourceEventLog.receivedAt, new Date(config.dateFrom)));
  }
  if (config.dateTo) {
    conditions.push(lte(sourceEventLog.receivedAt, new Date(config.dateTo)));
  }
  if (config.eventTypes && config.eventTypes.length > 0) {
    conditions.push(inArray(sourceEventLog.sourceEventType, config.eventTypes));
  }
  if (config.statuses && config.statuses.length > 0) {
    conditions.push(inArray(sourceEventLog.status, config.statuses));
  } else {
    conditions.push(
      inArray(sourceEventLog.status, ["applied", "failed", "dead_lettered", "received", "normalized", "ready_to_apply"]),
    );
  }
  conditions.push(eq(sourceEventLog.replayable, true));

  if (existingCursor?.lastReceivedAt && existingCursor?.lastProcessedId) {
    conditions.push(
      sql`(${sourceEventLog.receivedAt}, ${sourceEventLog.id}) > (${existingCursor.lastReceivedAt}::timestamp, ${existingCursor.lastProcessedId})`,
    );
  }

  const events = await workerDb
    .select()
    .from(sourceEventLog)
    .where(and(...conditions))
    .orderBy(asc(sourceEventLog.receivedAt), asc(sourceEventLog.id))
    .limit(chunkSize);

  let processed = existingCursor?.totalProcessed ?? 0;
  let skipped = existingCursor?.totalSkipped ?? 0;
  let failed = existingCursor?.totalFailed ?? 0;
  let lastId: string | undefined = existingCursor?.lastProcessedId;
  let lastReceivedAt: string | undefined = existingCursor?.lastReceivedAt;

  for (const evt of events) {
    try {
      if (config.dryRun) {
        skipped++;
        lastId = evt.id;
        lastReceivedAt = evt.receivedAt.toISOString();
        continue;
      }

      await replayEvent(evt.id, evt.sourceSystem, evt.sourceEventType);

      pipelineLog({
        event: "replayed",
        sourceSystem: evt.sourceSystem,
        sourceEventType: evt.sourceEventType,
        sourceEventId: evt.id,
        correlationId,
        outcome: "replay",
        replayJobId: job.id,
        replayRunId: runId,
      });

      processed++;
      lastId = evt.id;
      lastReceivedAt = evt.receivedAt.toISOString();
    } catch (err: any) {
      workerLog({
        worker: "replay_framework",
        event: "replay_event_failed",
        jobId: job.id,
        sourceEventId: evt.id,
        error: err.message,
      });
      failed++;
      lastId = evt.id;
      lastReceivedAt = evt.receivedAt.toISOString();
    }
  }

  const chunkIndex = (existingCursor?.chunkIndex ?? 0) + 1;
  const isComplete = events.length < chunkSize;

  const cursor: ReplayCursor = {
    mode: "event_log_replay",
    source: config.source,
    runId,
    lastProcessedId: lastId,
    lastReceivedAt,
    chunkIndex,
    totalProcessed: processed,
    totalSkipped: skipped,
    totalFailed: failed,
    complete: isComplete,
  };

  workerLog({
    worker: "replay_framework",
    event: isComplete ? "replay_completed" : "replay_chunk_completed",
    mode: "event_log_replay",
    source: config.source,
    jobId: job.id,
    chunkIndex,
    chunkProcessed: events.length,
    totalProcessed: processed,
    totalSkipped: skipped,
    totalFailed: failed,
  });

  if (!isComplete) {
    const continuationPayload: Record<string, unknown> = { ...config, runId, _cursor: cursor };
    delete continuationPayload.vendorCursor;

    await enqueueRepairJob({
      queueName: "replay_event_log",
      workloadClass: "maintenance",
      priority: job.priority ?? 200,
      payload: continuationPayload,
      maxAttempts: config.maxAttempts ?? 3,
      dedupeKey: `replay:${runId}:chunk:${chunkIndex}`,
    });
  }

  return { cursor: serializeCursor(cursor) };
}

export async function handleVendorReconciliation(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const config = parseReplayConfig(job);
  const existingCursor = extractCursor(config);
  const chunkSize = clampChunkSize(config.chunkSize);
  const runId = config.runId ?? existingCursor?.runId ?? randomUUID();
  const correlationId = randomUUID();

  workerLog({
    worker: "replay_framework",
    event: "reconciliation_started",
    mode: "vendor_reconciliation",
    source: config.source,
    jobId: job.id,
    runId,
  });

  const fetcher = getVendorFetcher(config.source);
  if (!fetcher) {
    throw new Error(`No vendor fetcher registered for source "${config.source}"`);
  }

  const vendorCursorInput = existingCursor?.vendorCursor ?? config.vendorCursor;

  const fetchResult = await fetcher({
    source: config.source,
    dateFrom: config.dateFrom,
    dateTo: config.dateTo,
    cursor: vendorCursorInput,
    limit: chunkSize,
    eventTypes: config.eventTypes,
  });

  let ingested = existingCursor?.totalProcessed ?? 0;
  let skippedDupes = existingCursor?.totalSkipped ?? 0;
  let failedCount = existingCursor?.totalFailed ?? 0;

  for (const vendorEvent of fetchResult.events) {
    try {
      const result = await ingestEvent({
        sourceSystem: config.source,
        sourceEventType: vendorEvent.eventType,
        sourceObjectId: vendorEvent.objectId,
        dedupeKey: vendorEvent.dedupeKey,
        payloadJson: vendorEvent.payload,
        correlationId,
      });

      if (result.deduplicated) {
        skippedDupes++;
      } else {
        ingested++;
        pipelineLog({
          event: "reconciled",
          sourceSystem: config.source,
          sourceEventType: vendorEvent.eventType,
          sourceEventId: result.id,
          correlationId,
          outcome: "ingested_missing",
          replayJobId: job.id,
          replayRunId: runId,
        });
      }
    } catch (err: any) {
      workerLog({
        worker: "replay_framework",
        event: "reconciliation_event_failed",
        jobId: job.id,
        objectId: vendorEvent.objectId,
        error: err.message,
      });
      failedCount++;
    }
  }

  const chunkIndex = (existingCursor?.chunkIndex ?? 0) + 1;
  const isComplete = !fetchResult.nextCursor || fetchResult.events.length < chunkSize;

  const cursor: ReplayCursor = {
    mode: "vendor_reconciliation",
    source: config.source,
    runId,
    vendorCursor: fetchResult.nextCursor,
    chunkIndex,
    totalProcessed: ingested,
    totalSkipped: skippedDupes,
    totalFailed: failedCount,
    complete: isComplete,
  };

  workerLog({
    worker: "replay_framework",
    event: isComplete ? "reconciliation_completed" : "reconciliation_chunk_completed",
    mode: "vendor_reconciliation",
    source: config.source,
    jobId: job.id,
    chunkIndex,
    chunkEvents: fetchResult.events.length,
    totalIngested: ingested,
    totalDuplicates: skippedDupes,
    totalFailed: failedCount,
  });

  if (!isComplete) {
    const continuationPayload: Record<string, unknown> = {
      ...config,
      runId,
      vendorCursor: fetchResult.nextCursor,
      _cursor: cursor,
    };

    await enqueueRepairJob({
      queueName: "replay_vendor_reconciliation",
      workloadClass: "maintenance",
      priority: job.priority ?? 200,
      payload: continuationPayload,
      maxAttempts: config.maxAttempts ?? 3,
      dedupeKey: `reconcile:${runId}:chunk:${chunkIndex}`,
    });
  }

  return { cursor: serializeCursor(cursor) };
}

export async function handleRulesetBackfill(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const config = parseReplayConfig(job);
  const existingCursor = extractCursor(config);
  const chunkSize = clampChunkSize(config.chunkSize);
  const runId = config.runId ?? existingCursor?.runId ?? randomUUID();

  if (!config.newRulesetVersion) {
    throw new Error("Ruleset backfill requires newRulesetVersion in payload");
  }

  workerLog({
    worker: "replay_framework",
    event: "backfill_started",
    mode: "ruleset_backfill",
    source: config.source,
    jobId: job.id,
    newRulesetVersion: config.newRulesetVersion,
    runId,
  });

  const conditions = [
    eq(applyState.sourceSystem, config.source),
    eq(applyState.outcome, "success"),
  ];

  if (config.rulesetVersion) {
    conditions.push(eq(applyState.rulesetVersion, config.rulesetVersion));
  }

  conditions.push(
    sql`(${applyState.appliedVersion} IS NULL OR ${applyState.appliedVersion} != ${config.newRulesetVersion})`,
  );

  if (existingCursor?.lastCreatedAt && existingCursor?.lastProcessedId) {
    conditions.push(
      sql`(${applyState.createdAt}, ${applyState.id}) > (${existingCursor.lastCreatedAt}::timestamp, ${existingCursor.lastProcessedId})`,
    );
  }

  const staleApplies = await workerDb
    .select({
      applyId: applyState.id,
      workResultId: applyState.workResultId,
      sourceEventId: applyState.sourceEventId,
      applyTarget: applyState.applyTarget,
      inputHash: applyState.inputHash,
      appliedVersion: applyState.appliedVersion,
      createdAt: applyState.createdAt,
    })
    .from(applyState)
    .where(and(...conditions))
    .orderBy(asc(applyState.createdAt), asc(applyState.id))
    .limit(chunkSize);

  let reapplied = existingCursor?.totalProcessed ?? 0;
  let skippedConverged = existingCursor?.totalSkipped ?? 0;
  let failedCount = existingCursor?.totalFailed ?? 0;
  let lastId: string | undefined = existingCursor?.lastProcessedId;
  let lastCreatedAt: string | undefined = existingCursor?.lastCreatedAt;

  for (const row of staleApplies) {
    try {
      const [workResult] = await workerDb
        .select()
        .from(workResultLog)
        .where(eq(workResultLog.id, row.workResultId))
        .limit(1);

      if (!workResult) {
        skippedConverged++;
        lastId = row.applyId;
        lastCreatedAt = row.createdAt.toISOString();
        continue;
      }

      const currentHash = computeInputHash(workResult.resultJson);
      if (row.inputHash && row.inputHash === currentHash) {
        await workerDb
          .update(applyState)
          .set({
            appliedVersion: config.newRulesetVersion,
            updatedAt: new Date(),
          })
          .where(eq(applyState.id, row.applyId));

        skippedConverged++;
        lastId = row.applyId;
        lastCreatedAt = row.createdAt.toISOString();
        continue;
      }

      if (config.dryRun) {
        reapplied++;
        lastId = row.applyId;
        lastCreatedAt = row.createdAt.toISOString();
        continue;
      }

      const [sourceEvent] = await workerDb
        .select()
        .from(sourceEventLog)
        .where(eq(sourceEventLog.id, row.sourceEventId))
        .limit(1);

      if (!sourceEvent) {
        skippedConverged++;
        lastId = row.applyId;
        lastCreatedAt = row.createdAt.toISOString();
        continue;
      }

      await replayEvent(sourceEvent.id, sourceEvent.sourceSystem, sourceEvent.sourceEventType);

      await workerDb
        .update(applyState)
        .set({
          appliedVersion: config.newRulesetVersion,
          rulesetVersion: config.newRulesetVersion,
          updatedAt: new Date(),
        })
        .where(eq(applyState.id, row.applyId));

      pipelineLog({
        event: "replayed",
        sourceSystem: config.source,
        sourceEventType: "ruleset_backfill",
        sourceEventId: row.sourceEventId,
        outcome: "backfill_reapplied",
        replayJobId: job.id,
        replayRunId: runId,
        newRulesetVersion: config.newRulesetVersion,
      });

      reapplied++;
      lastId = row.applyId;
      lastCreatedAt = row.createdAt.toISOString();
    } catch (err: any) {
      workerLog({
        worker: "replay_framework",
        event: "backfill_record_failed",
        jobId: job.id,
        applyId: row.applyId,
        error: err.message,
      });
      failedCount++;
      lastId = row.applyId;
      lastCreatedAt = row.createdAt.toISOString();
    }
  }

  const chunkIndex = (existingCursor?.chunkIndex ?? 0) + 1;
  const isComplete = staleApplies.length < chunkSize;

  const cursor: ReplayCursor = {
    mode: "ruleset_backfill",
    source: config.source,
    runId,
    lastProcessedId: lastId,
    lastCreatedAt,
    chunkIndex,
    totalProcessed: reapplied,
    totalSkipped: skippedConverged,
    totalFailed: failedCount,
    complete: isComplete,
  };

  workerLog({
    worker: "replay_framework",
    event: isComplete ? "backfill_completed" : "backfill_chunk_completed",
    mode: "ruleset_backfill",
    source: config.source,
    jobId: job.id,
    chunkIndex,
    chunkRecords: staleApplies.length,
    totalReapplied: reapplied,
    totalSkippedConverged: skippedConverged,
    totalFailed: failedCount,
    newRulesetVersion: config.newRulesetVersion,
  });

  if (!isComplete) {
    const continuationPayload: Record<string, unknown> = {
      ...config,
      runId,
      _cursor: cursor,
    };

    await enqueueRepairJob({
      queueName: "replay_ruleset_backfill",
      workloadClass: "maintenance",
      priority: job.priority ?? 200,
      payload: continuationPayload,
      maxAttempts: config.maxAttempts ?? 3,
      dedupeKey: `backfill:${runId}:chunk:${chunkIndex}`,
    });
  }

  return { cursor: serializeCursor(cursor) };
}

function serializeCursor(cursor: ReplayCursor): string {
  return JSON.stringify(cursor);
}

function computeInputHash(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 32);
}

export interface VendorEvent {
  eventType: string;
  objectId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface VendorFetchResult {
  events: VendorEvent[];
  nextCursor?: string;
}

export interface VendorFetchParams {
  source: SourceSystem;
  dateFrom?: string;
  dateTo?: string;
  cursor?: string;
  limit: number;
  eventTypes?: string[];
}

type VendorFetcher = (params: VendorFetchParams) => Promise<VendorFetchResult>;

const vendorFetchers = new Map<SourceSystem, VendorFetcher>();

export function registerVendorFetcher(source: SourceSystem, fetcher: VendorFetcher): void {
  vendorFetchers.set(source, fetcher);
  workerLog({
    worker: "replay_framework",
    event: "vendor_fetcher_registered",
    source,
  });
}

function getVendorFetcher(source: SourceSystem): VendorFetcher | undefined {
  return vendorFetchers.get(source);
}

export async function enqueueReplayJob(config: ReplayJobConfig): Promise<string> {
  const queueMap: Record<ReplayMode, string> = {
    event_log_replay: "replay_event_log",
    vendor_reconciliation: "replay_vendor_reconciliation",
    ruleset_backfill: "replay_ruleset_backfill",
  };

  const runId = config.runId ?? randomUUID();
  const queueName = queueMap[config.mode];
  const dedupeKey = `replay:${runId}:initial`;

  return enqueueRepairJob({
    queueName,
    workloadClass: "maintenance",
    priority: 200,
    payload: { ...config, runId } as unknown as Record<string, unknown>,
    maxAttempts: config.maxAttempts ?? 3,
    dedupeKey,
  });
}

export function getReplayStatus(cursorString: string): ReplayCursor | null {
  try {
    return JSON.parse(cursorString) as ReplayCursor;
  } catch {
    return null;
  }
}
