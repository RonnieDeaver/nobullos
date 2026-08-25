import { workerDb } from "../db";
import {
  sourceEventLog,
  workResultLog,
  applyState,
} from "@shared/models/durablePipeline";
import { sql, eq, and, isNull, or } from "drizzle-orm";

const handlerDurations: Map<string, number[]> = new Map();
const MAX_DURATION_SAMPLES = 200;

const dedupeCounters = {
  sourceEvent: 0,
  workQueue: 0,
};

interface StaleLeaseExhaustionEvent {
  jobId: string;
  queueName: string;
  workloadClass: string;
  attemptCount: number;
  maxAttempts: number;
  source: string;
  timestamp: number;
}

const staleLeaseExhaustionEvents: StaleLeaseExhaustionEvent[] = [];
const MAX_EXHAUSTION_EVENTS = 200;
const STALE_EXHAUSTION_ALERT_WINDOW_MS = 600_000;
const STALE_EXHAUSTION_ALERT_THRESHOLD = 5;
let lastStaleExhaustionAlertAt = 0;
const STALE_EXHAUSTION_ALERT_COOLDOWN_MS = 300_000;

export function recordStaleLeaseExhaustion(params: {
  jobId: string;
  queueName: string;
  workloadClass: string;
  attemptCount: number;
  maxAttempts: number;
  source: string;
}): { alert: boolean; countInWindow: number } {
  const now = Date.now();
  staleLeaseExhaustionEvents.push({ ...params, timestamp: now });
  if (staleLeaseExhaustionEvents.length > MAX_EXHAUSTION_EVENTS) {
    staleLeaseExhaustionEvents.splice(0, staleLeaseExhaustionEvents.length - MAX_EXHAUSTION_EVENTS);
  }

  const windowStart = now - STALE_EXHAUSTION_ALERT_WINDOW_MS;
  const countInWindow = staleLeaseExhaustionEvents.filter(e => e.timestamp >= windowStart).length;

  let alert = false;
  if (countInWindow >= STALE_EXHAUSTION_ALERT_THRESHOLD && now - lastStaleExhaustionAlertAt >= STALE_EXHAUSTION_ALERT_COOLDOWN_MS) {
    lastStaleExhaustionAlertAt = now;
    alert = true;
    console.error(
      `[ALERT] Stale lease exhaustion threshold exceeded: ${countInWindow} jobs permanently failed via stale lease recovery in the last ${STALE_EXHAUSTION_ALERT_WINDOW_MS / 1000}s (threshold: ${STALE_EXHAUSTION_ALERT_THRESHOLD})`,
    );
  }

  return { alert, countInWindow };
}

export function getStaleLeaseExhaustionMetrics(): {
  totalCount: number;
  countInWindow: number;
  windowMs: number;
  threshold: number;
  recentEvents: StaleLeaseExhaustionEvent[];
  lastAlertAt: number | null;
} {
  const now = Date.now();
  const windowStart = now - STALE_EXHAUSTION_ALERT_WINDOW_MS;
  const countInWindow = staleLeaseExhaustionEvents.filter(e => e.timestamp >= windowStart).length;
  return {
    totalCount: staleLeaseExhaustionEvents.length,
    countInWindow,
    windowMs: STALE_EXHAUSTION_ALERT_WINDOW_MS,
    threshold: STALE_EXHAUSTION_ALERT_THRESHOLD,
    recentEvents: staleLeaseExhaustionEvents.slice(-20).reverse(),
    lastAlertAt: lastStaleExhaustionAlertAt || null,
  };
}

export function incrementDedupeHits(domain: "sourceEvent" | "workQueue"): void {
  dedupeCounters[domain]++;
}

export function getDedupeHitCounters(): { sourceEvent: number; workQueue: number; total: number } {
  return {
    sourceEvent: dedupeCounters.sourceEvent,
    workQueue: dedupeCounters.workQueue,
    total: dedupeCounters.sourceEvent + dedupeCounters.workQueue,
  };
}

const applyTargetDurations: Map<string, number[]> = new Map();

export function recordApplyTargetDuration(applyTarget: string, durationMs: number): void {
  let samples = applyTargetDurations.get(applyTarget);
  if (!samples) {
    samples = [];
    applyTargetDurations.set(applyTarget, samples);
  }
  samples.push(durationMs);
  if (samples.length > MAX_DURATION_SAMPLES) {
    samples.splice(0, samples.length - MAX_DURATION_SAMPLES);
  }
}

export function getApplyTargetDurationMetrics(): Record<string, { avgMs: number; minMs: number; maxMs: number; p95Ms: number; sampleCount: number }> {
  const result: Record<string, { avgMs: number; minMs: number; maxMs: number; p95Ms: number; sampleCount: number }> = {};
  for (const [target, samples] of applyTargetDurations) {
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    result[target] = {
      avgMs: Math.round(sum / sorted.length),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      p95Ms: sorted[p95Idx],
      sampleCount: sorted.length,
    };
  }
  return result;
}

export function recordHandlerDuration(handlerName: string, durationMs: number): void {
  let samples = handlerDurations.get(handlerName);
  if (!samples) {
    samples = [];
    handlerDurations.set(handlerName, samples);
  }
  samples.push(durationMs);
  if (samples.length > MAX_DURATION_SAMPLES) {
    samples.splice(0, samples.length - MAX_DURATION_SAMPLES);
  }
}

export function getHandlerDurationMetrics(): Record<string, { avgMs: number; minMs: number; maxMs: number; p95Ms: number; sampleCount: number }> {
  const result: Record<string, { avgMs: number; minMs: number; maxMs: number; p95Ms: number; sampleCount: number }> = {};
  for (const [handler, samples] of handlerDurations) {
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    result[handler] = {
      avgMs: Math.round(sum / sorted.length),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      p95Ms: sorted[p95Idx],
      sampleCount: sorted.length,
    };
  }
  return result;
}

export async function getPipelineHealth(): Promise<{
  status: "healthy" | "degraded";
  degradedSections: string[];
  ingestion: {
    totalBySource: Record<string, number>;
    totalByEventType: Record<string, number>;
    dedupeHits: { sourceEvent: number; workQueue: number; total: number; dbIgnored: number };
  };
  apply: {
    successCount: number;
    noOpCount: number;
    failedCount: number;
    pendingCount: number;
  };
  replay: {
    backlogBySource: Record<string, number>;
  };
  oldestUnappliedAgeMs: number | null;
  reconciliation: {
    lagBySource: Record<string, number | null>;
  };
  deadLetter: {
    eventCount: number;
    workResultCount: number;
    applyCount: number;
  };
  handlerDurations: Record<string, { avgMs: number; minMs: number; maxMs: number; p95Ms: number; sampleCount: number }>;
  applyTargetDurations: Record<string, { avgMs: number; minMs: number; maxMs: number; p95Ms: number; sampleCount: number }>;
  recentFailures: Array<{
    id: string;
    stage: "event" | "work_result" | "apply";
    sourceSystem: string;
    sourceEventType: string;
    errorCode: string | null;
    errorMessage: string | null;
    status: string;
    timestamp: string;
  }>;
}> {
  const degradedSections: string[] = [];

  const results = await Promise.allSettled([
    getIngestionBySource(),
    getIngestionByEventType(),
    getDedupeHitCount(),
    getApplyOutcomeCounts(),
    getReplayBacklogBySource(),
    getOldestUnappliedAge(),
    getDeadLetterCount("events"),
    getDeadLetterCount("workResults"),
    getDeadLetterCount("apply"),
    getRecentFailures(),
    getReconciliationLagBySource(),
  ]);

  function extract<T>(idx: number, fallback: T, section: string): T {
    const r = results[idx];
    if (r.status === "fulfilled") return r.value as T;
    degradedSections.push(section);
    console.error(`[PipelineHealth] ${section} query failed:`, r.reason);
    return fallback;
  }

  const ingestionBySource = extract(0, {} as Record<string, number>, "ingestion.bySource");
  const ingestionByType = extract(1, {} as Record<string, number>, "ingestion.byEventType");
  const dbIgnoredCount = extract(2, 0, "ingestion.dedupeHits");
  const applyOutcomes = extract(3, { successCount: 0, noOpCount: 0, failedCount: 0, pendingCount: 0 }, "apply");
  const replayBacklog = extract(4, {} as Record<string, number>, "replay");
  const oldestUnapplied = extract(5, null as number | null, "oldestUnapplied");
  const deadLetterEvents = extract(6, 0, "deadLetter.events");
  const deadLetterWorkResults = extract(7, 0, "deadLetter.workResults");
  const deadLetterApply = extract(8, 0, "deadLetter.apply");
  const recentFailureRows = extract(9, [] as Array<{
    id: string;
    stage: "event" | "work_result" | "apply";
    sourceSystem: string;
    sourceEventType: string;
    errorCode: string | null;
    errorMessage: string | null;
    status: string;
    timestamp: string;
  }>, "recentFailures");
  const reconciliationLag = extract(10, {} as Record<string, number | null>, "reconciliation");

  const inMemoryDedupes = getDedupeHitCounters();

  return {
    status: degradedSections.length > 0 ? "degraded" : "healthy",
    degradedSections,
    ingestion: {
      totalBySource: ingestionBySource,
      totalByEventType: ingestionByType,
      dedupeHits: {
        sourceEvent: inMemoryDedupes.sourceEvent,
        workQueue: inMemoryDedupes.workQueue,
        total: inMemoryDedupes.total + dbIgnoredCount,
        dbIgnored: dbIgnoredCount,
      },
    },
    apply: applyOutcomes,
    replay: {
      backlogBySource: replayBacklog,
    },
    oldestUnappliedAgeMs: oldestUnapplied,
    reconciliation: {
      lagBySource: reconciliationLag,
    },
    deadLetter: {
      eventCount: deadLetterEvents,
      workResultCount: deadLetterWorkResults,
      applyCount: deadLetterApply,
    },
    handlerDurations: getHandlerDurationMetrics(),
    applyTargetDurations: getApplyTargetDurationMetrics(),
    recentFailures: recentFailureRows,
  };
}

async function getIngestionBySource(): Promise<Record<string, number>> {
  const rows = await workerDb
    .select({
      sourceSystem: sourceEventLog.sourceSystem,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceEventLog)
    .groupBy(sourceEventLog.sourceSystem);
  const result: Record<string, number> = {};
  for (const r of rows) result[r.sourceSystem] = r.count;
  return result;
}

async function getIngestionByEventType(): Promise<Record<string, number>> {
  const rows = await workerDb
    .select({
      key: sql<string>`${sourceEventLog.sourceSystem} || ':' || ${sourceEventLog.sourceEventType}`,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceEventLog)
    .groupBy(sourceEventLog.sourceSystem, sourceEventLog.sourceEventType);
  const result: Record<string, number> = {};
  for (const r of rows) result[r.key] = r.count;
  return result;
}

async function getDedupeHitCount(): Promise<number> {
  const [row] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceEventLog)
    .where(eq(sourceEventLog.status, "ignored"));
  return row?.count ?? 0;
}

async function getApplyOutcomeCounts(): Promise<{ successCount: number; noOpCount: number; failedCount: number; pendingCount: number }> {
  const rows = await workerDb
    .select({
      outcome: applyState.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(applyState)
    .groupBy(applyState.outcome);
  let successCount = 0, noOpCount = 0, failedCount = 0, pendingCount = 0;
  for (const r of rows) {
    if (r.outcome === "success" || r.outcome === "partial") successCount += r.count;
    else if (r.outcome === "skipped") noOpCount += r.count;
    else if (r.outcome === "failed" || r.outcome === "conflict") failedCount += r.count;
    else if (r.outcome === "pending") pendingCount += r.count;
  }
  return { successCount, noOpCount, failedCount, pendingCount };
}

async function getReplayBacklogBySource(): Promise<Record<string, number>> {
  const rows = await workerDb
    .select({
      sourceSystem: sourceEventLog.sourceSystem,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceEventLog)
    .where(
      and(
        eq(sourceEventLog.replayable, true),
        or(
          eq(sourceEventLog.status, "failed"),
          eq(sourceEventLog.status, "received"),
          eq(sourceEventLog.status, "normalized"),
          eq(sourceEventLog.status, "ready_to_apply"),
        ),
      ),
    )
    .groupBy(sourceEventLog.sourceSystem);
  const result: Record<string, number> = {};
  for (const r of rows) result[r.sourceSystem] = r.count;
  return result;
}

async function getOldestUnappliedAge(): Promise<number | null> {
  const [row] = await workerDb
    .select({ oldest: sql<Date>`min(${sourceEventLog.receivedAt})` })
    .from(sourceEventLog)
    .where(
      and(
        isNull(sourceEventLog.appliedAt),
        or(
          eq(sourceEventLog.status, "received"),
          eq(sourceEventLog.status, "normalized"),
          eq(sourceEventLog.status, "ready_to_apply"),
        ),
      ),
    );
  if (!row?.oldest) return null;
  return Date.now() - new Date(row.oldest).getTime();
}

async function getDeadLetterCount(target: "events" | "workResults" | "apply"): Promise<number> {
  if (target === "events") {
    const [row] = await workerDb
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceEventLog)
      .where(eq(sourceEventLog.status, "dead_lettered"));
    return row?.count ?? 0;
  }
  if (target === "workResults") {
    const [row] = await workerDb
      .select({ count: sql<number>`count(*)::int` })
      .from(workResultLog)
      .where(eq(workResultLog.status, "dead_lettered"));
    return row?.count ?? 0;
  }
  const [row] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(applyState)
    .where(
      and(
        eq(applyState.outcome, "failed"),
        sql`${applyState.attemptCount} >= ${applyState.maxAttempts}`,
      ),
    );
  return row?.count ?? 0;
}

async function getRecentFailures(): Promise<Array<{
  id: string;
  stage: "event" | "work_result" | "apply";
  sourceSystem: string;
  sourceEventType: string;
  errorCode: string | null;
  errorMessage: string | null;
  status: string;
  timestamp: string;
}>> {
  const [eventFailures, workResultFailures, applyFailures] = await Promise.all([
    workerDb
      .select({
        id: sourceEventLog.id,
        sourceSystem: sourceEventLog.sourceSystem,
        sourceEventType: sourceEventLog.sourceEventType,
        errorCode: sourceEventLog.errorCode,
        errorMessage: sourceEventLog.errorMessage,
        status: sourceEventLog.status,
        receivedAt: sourceEventLog.receivedAt,
      })
      .from(sourceEventLog)
      .where(
        or(
          eq(sourceEventLog.status, "failed"),
          eq(sourceEventLog.status, "dead_lettered"),
        ),
      )
      .orderBy(sql`${sourceEventLog.receivedAt} DESC`)
      .limit(10),
    workerDb
      .select({
        id: workResultLog.id,
        sourceSystem: workResultLog.sourceSystem,
        resultType: workResultLog.resultType,
        errorCode: workResultLog.errorCode,
        errorMessage: workResultLog.errorMessage,
        status: workResultLog.status,
        createdAt: workResultLog.createdAt,
      })
      .from(workResultLog)
      .where(
        or(
          eq(workResultLog.status, "failed"),
          eq(workResultLog.status, "dead_lettered"),
        ),
      )
      .orderBy(sql`${workResultLog.createdAt} DESC`)
      .limit(10),
    workerDb
      .select({
        id: applyState.id,
        sourceSystem: applyState.sourceSystem,
        applyTarget: applyState.applyTarget,
        errorCode: applyState.errorCode,
        errorMessage: applyState.errorMessage,
        outcome: applyState.outcome,
        attemptedAt: applyState.attemptedAt,
      })
      .from(applyState)
      .where(
        or(
          eq(applyState.outcome, "failed"),
          eq(applyState.outcome, "conflict"),
        ),
      )
      .orderBy(sql`${applyState.attemptedAt} DESC NULLS LAST`)
      .limit(10),
  ]);

  const combined: Array<{
    id: string;
    stage: "event" | "work_result" | "apply";
    sourceSystem: string;
    sourceEventType: string;
    errorCode: string | null;
    errorMessage: string | null;
    status: string;
    timestamp: string;
  }> = [];

  for (const r of eventFailures) {
    combined.push({
      id: r.id,
      stage: "event",
      sourceSystem: r.sourceSystem,
      sourceEventType: r.sourceEventType,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      status: r.status,
      timestamp: r.receivedAt.toISOString(),
    });
  }
  for (const r of workResultFailures) {
    combined.push({
      id: r.id,
      stage: "work_result",
      sourceSystem: r.sourceSystem,
      sourceEventType: r.resultType,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      status: r.status,
      timestamp: r.createdAt.toISOString(),
    });
  }
  for (const r of applyFailures) {
    combined.push({
      id: r.id,
      stage: "apply",
      sourceSystem: r.sourceSystem,
      sourceEventType: r.applyTarget,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      status: r.outcome,
      timestamp: r.attemptedAt?.toISOString() ?? new Date().toISOString(),
    });
  }

  combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return combined.slice(0, 25);
}

async function getReconciliationLagBySource(): Promise<Record<string, number | null>> {
  const sources = ["front", "zoom", "semrush"];
  const result: Record<string, number | null> = {};
  for (const src of sources) {
    const [row] = await workerDb
      .select({
        latestReceived: sql<Date>`max(${sourceEventLog.receivedAt})`,
        latestApplied: sql<Date>`max(${sourceEventLog.appliedAt})`,
      })
      .from(sourceEventLog)
      .where(eq(sourceEventLog.sourceSystem, src));
    if (row?.latestReceived && row?.latestApplied) {
      const receivedMs = new Date(row.latestReceived).getTime();
      const appliedMs = new Date(row.latestApplied).getTime();
      result[src] = Math.max(0, receivedMs - appliedMs);
    } else if (row?.latestReceived && !row?.latestApplied) {
      result[src] = Date.now() - new Date(row.latestReceived).getTime();
    } else {
      result[src] = null;
    }
  }
  return result;
}

export async function getSourceSpecificHealth(): Promise<{
  status: "healthy" | "degraded";
  degradedSources: string[];
  front: {
    webhookHealthy: boolean;
    lastWebhookEventAge: number | null;
    reconciliationDelta: number;
  };
  zoom: {
    transcriptPendingBacklog: number;
  };
  semrush: {
    inventoryFreshness: number | null;
    latestReportDate: string | null;
  };
}> {
  const degradedSources: string[] = [];
  const results = await Promise.allSettled([
    getFrontWebhookHealth(),
    getZoomTranscriptBacklog(),
    getSemrushInventoryHealth(),
  ]);

  const front = results[0].status === "fulfilled"
    ? results[0].value
    : (degradedSources.push("front"), { webhookHealthy: false, lastWebhookEventAge: null, reconciliationDelta: 0 });
  const zoom = results[1].status === "fulfilled"
    ? results[1].value
    : (degradedSources.push("zoom"), { transcriptPendingBacklog: 0 });
  const semrush = results[2].status === "fulfilled"
    ? results[2].value
    : (degradedSources.push("semrush"), { inventoryFreshness: null, latestReportDate: null });

  return {
    status: degradedSources.length > 0 ? "degraded" : "healthy",
    degradedSources,
    front,
    zoom,
    semrush,
  };
}

async function getFrontWebhookHealth(): Promise<{
  webhookHealthy: boolean;
  lastWebhookEventAge: number | null;
  reconciliationDelta: number;
}> {
  const [row] = await workerDb
    .select({
      latest: sql<Date>`max(${sourceEventLog.receivedAt})`,
    })
    .from(sourceEventLog)
    .where(eq(sourceEventLog.sourceSystem, "front"));

  const lastWebhookEventAge = row?.latest
    ? Date.now() - new Date(row.latest).getTime()
    : null;

  const webhookHealthy = lastWebhookEventAge !== null && lastWebhookEventAge < 86400_000;

  const [appliedCount] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceEventLog)
    .where(
      and(
        eq(sourceEventLog.sourceSystem, "front"),
        eq(sourceEventLog.status, "applied"),
      ),
    );
  const [totalCount] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceEventLog)
    .where(eq(sourceEventLog.sourceSystem, "front"));

  const reconciliationDelta = (totalCount?.count ?? 0) - (appliedCount?.count ?? 0);

  return { webhookHealthy, lastWebhookEventAge, reconciliationDelta };
}

async function getZoomTranscriptBacklog(): Promise<{ transcriptPendingBacklog: number }> {
  const [row] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceEventLog)
    .where(
      and(
        eq(sourceEventLog.sourceSystem, "zoom"),
        or(
          eq(sourceEventLog.status, "received"),
          eq(sourceEventLog.status, "normalized"),
          eq(sourceEventLog.status, "ready_to_apply"),
        ),
      ),
    );
  return { transcriptPendingBacklog: row?.count ?? 0 };
}

async function getSemrushInventoryHealth(): Promise<{
  inventoryFreshness: number | null;
  latestReportDate: string | null;
}> {
  const [row] = await workerDb
    .select({
      latestReceived: sql<Date>`max(${sourceEventLog.receivedAt})`,
    })
    .from(sourceEventLog)
    .where(eq(sourceEventLog.sourceSystem, "semrush"));

  const inventoryFreshness = row?.latestReceived
    ? Date.now() - new Date(row.latestReceived).getTime()
    : null;

  const latestReportDate = row?.latestReceived
    ? new Date(row.latestReceived).toISOString()
    : null;

  return { inventoryFreshness, latestReportDate };
}
