// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import type { FrontPipelineState } from "@shared/models/communications";

export type FrontPipelineEventType =
  | "discovered"
  | "version_noop"
  | "triage_dismissed"
  | "hydrate_started"
  | "hydrate_reused"
  | "deterministic_matched"
  | "ai_match_started"
  | "ai_matched"
  | "unmatched"
  | "apply_started"
  | "applied"
  | "failed"
  | "replay_enqueued";

export interface FrontPipelineEvent {
  type: FrontPipelineEventType;
  conversationId: string;
  timestamp: number;
  pipelineState?: FrontPipelineState;
  metadata?: Record<string, unknown>;
}

interface StageCounter {
  total: number;
  last1h: number;
  last5m: number;
}

interface PipelineMetricsSnapshot {
  backlogs: Record<string, number>;
  throughput: Record<FrontPipelineEventType, StageCounter>;
  cursorFreshness: {
    currentCursorTimestamp: number | null;
    cursorAgeSeconds: number | null;
    pageTokenActive: boolean;
    lastCursorAdvanceAt: number | null;
  };
  duplicatePrevention: {
    versionNoops: number;
    versionNoopsLast1h: number;
  };
  cursorIndependence: {
    cursorAdvancesWithoutProcessing: number;
    lastIndependentAdvanceAt: number | null;
  };
  health: {
    oldestUnprocessedAgeSeconds: number | null;
    avgDiscoveryToApplyMs: number | null;
    hydrateRetryCount: number;
    failedCount: number;
    deadLetteredCount: number;
  };
  recentEvents: FrontPipelineEvent[];
  collectedAt: number;
}

const MAX_RECENT_EVENTS = 200;
const MAX_TIMING_SAMPLES = 500;

const recentEvents: FrontPipelineEvent[] = [];

const eventCounters: Record<string, { timestamps: number[]; monotonic: number }> = {};

let versionNoopTimestamps: number[] = [];

let cursorAdvancesWithoutProcessing = 0;
let lastIndependentAdvanceAt: number | null = null;
let lastCursorAdvanceAt: number | null = null;
let hydrateRetryCount = 0;

const discoveryToApplyTimings: number[] = [];

const discoveryTimestamps = new Map<string, number>();

function getOrCreateCounter(eventType: string): { timestamps: number[]; monotonic: number } {
  if (!eventCounters[eventType]) {
    eventCounters[eventType] = { timestamps: [], monotonic: 0 };
  }
  return eventCounters[eventType];
}

function pruneTimestamps(timestamps: number[], maxAgeMs: number): number[] {
  const cutoff = Date.now() - maxAgeMs;
  return timestamps.filter(t => t >= cutoff);
}

function countInWindow(timestamps: number[], windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] >= cutoff) count++;
    else break;
  }
  return count;
}

export function emitPipelineEvent(event: FrontPipelineEvent): void {
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
  }

  const counter = getOrCreateCounter(event.type);
  counter.monotonic++;
  counter.timestamps.push(event.timestamp);
  if (counter.timestamps.length > 2000) {
    counter.timestamps = pruneTimestamps(counter.timestamps, 3600_000);
  }

  if (event.type === "discovered") {
    discoveryTimestamps.set(event.conversationId, event.timestamp);
  }

  const TERMINAL_EVENTS: Set<FrontPipelineEventType> = new Set(["applied", "unmatched", "triage_dismissed", "failed"]);
  if (TERMINAL_EVENTS.has(event.type)) {
    const discoveredAt = discoveryTimestamps.get(event.conversationId);
    if (discoveredAt) {
      if (event.type === "applied") {
        discoveryToApplyTimings.push(event.timestamp - discoveredAt);
        if (discoveryToApplyTimings.length > MAX_TIMING_SAMPLES) {
          discoveryToApplyTimings.splice(0, discoveryToApplyTimings.length - MAX_TIMING_SAMPLES);
        }
      }
      discoveryTimestamps.delete(event.conversationId);
    }
  }

  if (discoveryTimestamps.size > 5000) {
    const cutoff = Date.now() - 3600_000;
    for (const [id, ts] of discoveryTimestamps) {
      if (ts < cutoff) discoveryTimestamps.delete(id);
    }
  }
}

export function recordVersionNoop(): void {
  versionNoopTimestamps.push(Date.now());
  if (versionNoopTimestamps.length > 2000) {
    versionNoopTimestamps = pruneTimestamps(versionNoopTimestamps, 3600_000);
  }
}

export function recordCursorAdvance(hadProcessing: boolean): void {
  lastCursorAdvanceAt = Date.now();
  if (!hadProcessing) {
    cursorAdvancesWithoutProcessing++;
    lastIndependentAdvanceAt = Date.now();
  }
}

export function recordHydrateRetry(): void {
  hydrateRetryCount++;
}

function buildThroughputForType(eventType: FrontPipelineEventType): StageCounter {
  const counter = eventCounters[eventType];
  if (!counter) return { total: 0, last1h: 0, last5m: 0 };
  return {
    total: counter.monotonic,
    last1h: countInWindow(counter.timestamps, 3600_000),
    last5m: countInWindow(counter.timestamps, 300_000),
  };
}

export async function getPipelineMetrics(): Promise<PipelineMetricsSnapshot> {
  const { getDb } = await import("../db");
  const { frontSyncEmails } = await import("@shared/models/communications");
  const { sourceEventLog } = await import("@shared/models/durablePipeline");
  const { sql, eq, min, max } = await import("drizzle-orm");

  const db = getDb();

  const backlogRows = await db
    .select({
      pipelineState: frontSyncEmails.pipelineState,
      count: sql<number>`count(*)::int`,
    })
    .from(frontSyncEmails)
    .groupBy(frontSyncEmails.pipelineState);

  const backlogs: Record<string, number> = {};
  for (const row of backlogRows) {
    backlogs[row.pipelineState] = row.count;
  }

  const [oldestRow] = await db
    .select({
      oldest: min(frontSyncEmails.stateChangedAt),
    })
    .from(frontSyncEmails)
    .where(
      sql`${frontSyncEmails.pipelineState} NOT IN ('applied', 'triage_dismissed', 'dead_lettered')`
    );

  let oldestUnprocessedAgeSeconds: number | null = null;
  if (oldestRow?.oldest) {
    oldestUnprocessedAgeSeconds = Math.floor((Date.now() - new Date(oldestRow.oldest).getTime()) / 1000);
  }

  // Task #2413: the old on-demand sync's `front_sync_cursor` /
  // `front_sync_page_token` settings froze at the 2026-04-14 webhook cutover
  // and nothing advances them anymore. Re-source "cursor freshness" to the
  // live webhook heartbeat — the most-recent Front event landed in
  // `source_event_log` — so the metric reflects real Front activity (time
  // since the last webhook) instead of a frozen value. The page-token concept
  // belonged to the retired pull loop, so it is permanently inactive now.
  const [heartbeatRow] = await db
    .select({ latest: max(sourceEventLog.receivedAt) })
    .from(sourceEventLog)
    .where(eq(sourceEventLog.sourceSystem, "front"));
  const lastWebhookAt = heartbeatRow?.latest ? new Date(heartbeatRow.latest) : null;
  const currentCursorTs = lastWebhookAt ? Math.floor(lastWebhookAt.getTime() / 1000) : null;

  let cursorAgeSeconds: number | null = null;
  if (currentCursorTs && currentCursorTs > 0) {
    cursorAgeSeconds = Math.floor(Date.now() / 1000 - currentCursorTs);
  }

  const allEventTypes: FrontPipelineEventType[] = [
    "discovered", "version_noop", "triage_dismissed",
    "hydrate_started", "hydrate_reused", "deterministic_matched",
    "ai_match_started", "ai_matched", "unmatched",
    "apply_started", "applied", "failed", "replay_enqueued",
  ];
  const throughput: Record<string, StageCounter> = {};
  for (const t of allEventTypes) {
    throughput[t] = buildThroughputForType(t);
  }

  let avgDiscoveryToApplyMs: number | null = null;
  if (discoveryToApplyTimings.length > 0) {
    const sum = discoveryToApplyTimings.reduce((a, b) => a + b, 0);
    avgDiscoveryToApplyMs = Math.round(sum / discoveryToApplyTimings.length);
  }

  const failedCount = backlogs["failed"] || 0;
  const deadLetteredCount = backlogs["dead_lettered"] || 0;

  return {
    backlogs,
    throughput: throughput as Record<FrontPipelineEventType, StageCounter>,
    cursorFreshness: {
      currentCursorTimestamp: currentCursorTs,
      cursorAgeSeconds,
      pageTokenActive: false,
      lastCursorAdvanceAt,
    },
    duplicatePrevention: {
      versionNoops: versionNoopTimestamps.length,
      versionNoopsLast1h: countInWindow(versionNoopTimestamps, 3600_000),
    },
    cursorIndependence: {
      cursorAdvancesWithoutProcessing,
      lastIndependentAdvanceAt,
    },
    health: {
      oldestUnprocessedAgeSeconds,
      avgDiscoveryToApplyMs,
      hydrateRetryCount,
      failedCount,
      deadLetteredCount,
    },
    recentEvents: recentEvents.slice(-50),
    collectedAt: Date.now(),
  };
}

export function resetMetrics(): void {
  recentEvents.length = 0;
  for (const key of Object.keys(eventCounters)) {
    delete eventCounters[key];
  }
  versionNoopTimestamps = [];
  cursorAdvancesWithoutProcessing = 0;
  lastIndependentAdvanceAt = null;
  lastCursorAdvanceAt = null;
  hydrateRetryCount = 0;
  discoveryToApplyTimings.length = 0;
  discoveryTimestamps.clear();
}
