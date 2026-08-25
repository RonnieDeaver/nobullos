# System Integrity Review — Tasks #253–#281

**Date**: April 14, 2026
**Scope**: Adversarial system integrity audit of everything built across Tasks #253–#281 (fair multi-queue scheduler, durable compute/apply pipeline, Front/Zoom/Semrush pipeline migrations, observability, cutover, and legacy cleanup).
**Files reviewed**: 26 files, ~13,800 lines of code.

---

## 1. Executive Summary

**The system is fundamentally sound.** Tasks #253–#281 produced a coherent, well-architected durable pipeline that handles event ingestion, normalization, application, and replay across three source systems (Front, Zoom, Semrush) with idempotency at every stage.

**No P0 or P1 findings.** All issues are P2 (efficiency/reliability) or P3 (code hygiene).

**Biggest risks:**
1. **Enqueue dedupe race** (P2): SELECT-then-INSERT pattern on dedupe key can cause unique violations under bursty webhook ingestion, creating error log noise.
2. **Dequeue contention** (P2): SELECT-then-UPDATE dequeue pattern is inefficient under multi-process contention. Safe in current single-process production due to `isRunning` guard.
3. **Dead code** (P3): `workQueueLease.ts` (268 lines) is entirely unused — nothing imports it — despite containing the best dequeue pattern (`FOR UPDATE SKIP LOCKED`).

**Top 3 fixes needed right now:**
1. Add `.onConflictDoNothing()` or try/catch on enqueue INSERT to silence unique violation noise under burst.
2. Adopt `FOR UPDATE SKIP LOCKED` atomic CTE in `dequeueForClass()` (becomes critical if scaling to multi-process).
3. Delete `workQueueLease.ts` after extracting its `acquireLease` pattern into the scheduler.

### Critical Questions Answered

| Question | Answer |
|----------|--------|
| **Did #253–#281 produce ONE system or overlapping ones?** | ONE coherent system. The three-table durable pipeline model (`source_event_log → work_result_log → apply_state`) is the single canonical data path for all sources. Front is fully migrated. Zoom and Semrush use the pipeline tables for event logging and are on the legacy write path (by design — durable apply cutover is pending). No competing or overlapping systems exist. |
| **Are any legacy paths still live?** | Yes, intentionally. Zoom and Semrush legacy write paths are active (`DURABLE_APPLY_ENABLED=false`). `getCutoverDecision()` returns `{runLegacy:true, runDurable:false}` for both — this is correct and expected. Front legacy paths are fully disabled (all legacy flags `false`). |
| **Can any source object be processed twice?** | No duplicate side effects. Source events are deduplicated by `dedupe_key` (unique index on `source_event_log`). Apply operations check `isAlreadyApplied()` using `input_hash` before writing. Work queue jobs are deduplicated by `dedupe_key` (unique partial index). All three layers prevent double-processing. |
| **Are retries truly safe?** | Yes. Retry safety is guaranteed by the apply pipeline's idempotency check: `isAlreadyApplied()` compares `input_hash` and returns `already_applied` for identical data, `stale_version` for outdated data. Dead-lettering after `max_attempts` prevents infinite retry loops. |
| **Is Front still bottlenecked somewhere?** | No. The old bottleneck (inline processing blocking cursor advancement) was eliminated by the pipeline split into discovery → normalize → apply jobs. Background job enqueueing decouples cursor advancement from processing. Reconciliation runs independently as a safety net. |
| **Is Zoom actually reliable now or just quieter?** | Reliable. Webhook-first ingestion with durable `source_event_log` provides at-least-once delivery. Transcript backfill correctly gates analysis on `transcript_status=ready`. Nightly reconciliation catches missed webhooks. The quietness reflects genuine reliability — events are captured durably before processing. |
| **Is Semrush doing unnecessary work?** | Minor. `semrushInventorySync` always runs a full inventory fetch and diff regardless of whether anything changed. The diff itself is cheap, but the API call happens on every 6-hour interval. This is acceptable — the inventory is small and the API is not rate-limited aggressively. |
| **Is the scheduler actually fair?** | Yes. `buildFairClassOrder()` promotes starved classes after `MAX_SKIP_CYCLES` consecutive skips. Class budgets (interactive:1, interactive_repair:1, ingestion:2, repair:1, maintenance:1) sum to 6 but are capped at `TOTAL_BUDGET=4`, creating correct oversubscription with priority-based preemption. `checkStarvation()` emits cooldown-limited warnings for repair jobs exceeding age thresholds. |

---

## 2. System Architecture (As Implemented)

### 2.1 Three-Table Durable Pipeline Model

The core architecture is a three-table event-sourcing model defined in `shared/models/durablePipeline.ts`:

```
source_event_log  →  work_result_log  →  apply_state
(raw events)         (normalized data)    (application outcomes)
```

- **`source_event_log`**: Captures raw events from all sources with a unique `dedupe_key`. States: `received → normalized → ready_to_apply → applied | failed | dead_lettered | ignored`. Supports replay via `replayable` boolean and `attempt_count`/`max_attempts`.
- **`work_result_log`**: Stores normalized/transformed results with FK to source event. Multiple results per event (e.g., a Front conversation produces both a communication result and a match result).
- **`apply_state`**: Records the outcome of applying each work result to the system of record. Unique on `(work_result_id, apply_target)`. Uses `input_hash` for idempotency and `ruleset_version`/`applied_version` for version-aware backfill.

### 2.2 Fair Multi-Queue Scheduler

Two scheduler loops partition work across five workload classes:

- **Primary scheduler** (`workScheduler.ts`): Owns `interactive` (1 slot) and `ingestion` (2 slots). Polls every 5 seconds.
- **Repair dispatcher** (`repairDispatcher.ts`): Owns `interactive_repair` (1 slot), `repair` (1 slot), and `maintenance` (1 slot). Separate polling loop.
- **Workload manager** (`workloadManager.ts`): Enforces `TOTAL_BUDGET=4` global slot limit with per-class maximums. `awaitClassSlot()` provides commit-phase blocking (30s timeout, 50ms poll).

### 2.3 Source-Specific Pipeline Flows

**Front (fully migrated):**
Webhook → `source_event_log` → `front_webhook_normalize` job → `work_result_log` → `front_webhook_apply` job → `raw_communication_records`. Reconciliation cursor scans Front API for missed events.

**Zoom (event logging + legacy write path):**
Webhook → `source_event_log` → `zoom_meeting_apply`/`zoom_transcript_apply` jobs → `raw_communication_records` (direct write, not through apply pipeline). Transcript backfill re-checks `transcript_status=pending`. Nightly reconciliation via Zoom API.

**Semrush (event logging + legacy write path):**
Inventory sync → `source_event_log` + `work_result_log` → `semrush_report_refresh` jobs → heatmap data (direct write via `importHeatmap`). `localDominanceSyncWorker` checks `getCutoverDecision("semrush")` for dual-path control.

### 2.4 Replay Framework

Three replay modes in `replayFramework.ts`:
1. **Event log replay**: Cursor-based chunked replay of `source_event_log` entries (up to 500 per chunk) with continuation via `enqueueRepairJob`.
2. **Vendor reconciliation**: Pluggable `VendorFetcher` pattern — fetches events from external API and deduplicates against existing `source_event_log`.
3. **Ruleset backfill**: Compares `input_hash` to detect convergence — if hash matches, bumps `applied_version` without re-processing.

### 2.5 Cutover Control

`cutoverGuard.ts` provides `getCutoverDecision(source)` returning `{runLegacy, runDurable, shadowMode, reason}`. Current state:
- **Front**: Fully cut over (new pipeline flags all `true`, legacy all `false`).
- **Zoom**: Legacy only (`DURABLE_APPLY_ENABLED=false`, legacy mutation flag `false` → `getCutoverDecision` returns `runLegacy:true`).
- **Semrush**: Same as Zoom. `semrushInventorySync` additionally uses its own `SEMRUSH_*` flags independent of cutover guard.

### 2.6 Startup Sequence

At cold start (`server/index.ts`):
1. Cleanup/decontamination (via repair queue or direct, based on `REPAIR_QUEUE_ENABLED`).
2. DB integrity migrations (idempotent).
3. `registerAllHandlers()` — binds job types to handler functions in both scheduler and dispatcher.
4. `startScheduler()` — ensures `work_queue` table, starts 5s poll loop with `recoverStaleLeases()` on each cycle.
5. `startRepairDispatcher()` — if `REPAIR_DISPATCHER_ENABLED`.
6. Worker stagger: Background workers start with 10–140s offsets + 30s random jitter to prevent resource spikes.

---

## 3. Coverage Map

### Files Reviewed — Function by Function

| File | Lines | Key Functions Reviewed | Verdict |
|------|-------|----------------------|---------|
| `server/services/workScheduler.ts` | 838 | `registerHandler`, `enqueueJob`, `dequeueForClass`, `schedulerCycle`, `buildFairClassOrder`, `recoverStaleLeases`, `checkStarvation`, `startScheduler`, `getQueueStatus`, `ensureWorkQueueTable` | ✅ P2: dequeue race, startup DDL |
| `server/services/repairDispatcher.ts` | 474 | `registerRepairHandler`, `enqueueRepairJob`, `dequeueForClass`, `dispatcherCycle`, `startRepairDispatcher`, `getRepairDispatcherStatus`, `isJobActiveInQueue` | ✅ P2: dequeue race, enqueue dedupe |
| `server/services/workloadManager.ts` | 239 | `acquireClassSlot`, `releaseClassSlot`, `awaitClassSlot`, `withClassSlot`, `getClassStatus`, `getTotalActiveSlots`, `getSlotHoldMetrics` | ✅ Clean |
| `server/services/workQueueHandlers.ts` | 500 | `registerAllHandlers`, `submitRepairJob`, all handler registrations | ✅ Clean |
| `server/services/workQueueLease.ts` | 267 | `enqueueJob`, `acquireLease`, `markProcessing`, `heartbeat`, `completeJob`, `failJob`, `releaseLease`, `cancelJob`, `reclaimExpiredLeases`, `saveCursor`, `getJob` | ⚠️ P3: entirely dead code |
| `server/services/applyPipeline.ts` | 486 | `computeInputHash`, `isVersionStale`, `loadWorkResult`, `getOrCreateApplyState`, `isAlreadyApplied`, `recordApplyOutcome`, `runApply`, `runApplyForWorkResult`, `enqueueApplyJob`, `ensureApplyStateTables`, `enqueueApplyJobsForEvent`, `tryMarkSourceEventApplied` | ✅ P2: O(N) completion check |
| `server/services/applyHandlers.ts` | 750 | `communicationApply`, `meetingApply`, `transcriptApply`, `localReportApply`, `matchStateApply`, `inventorySyncApply`, `semrushHeatmapApply`, `getApplyHandler` | ✅ Clean |
| `server/services/replayFramework.ts` | 636 | `handleEventLogReplay`, `handleVendorReconciliation`, `handleRulesetBackfill`, `registerVendorFetcher`, `enqueueReplayJob`, `getReplayStatus` | ✅ P3: hash truncation |
| `server/services/pipelineProcessor.ts` | 275 | `ingestEvent`, `markNormalized`, `markReadyToApply`, `recordApplyOutcome`, `replayEvent`, `reconcileSource` | ✅ Clean |
| `server/services/pipelineObservability.ts` | 592 | `incrementDedupeHits`, `getDedupeHitCounters`, `recordApplyTargetDuration`, `getApplyTargetDurationMetrics`, `recordHandlerDuration`, `getHandlerDurationMetrics`, `getPipelineHealth`, `getSourceSpecificHealth` | ✅ P3: in-memory reset |
| `server/services/pipelineLogger.ts` | 50 | `pipelineLog` | ✅ Clean |
| `server/services/frontPipelineMetrics.ts` | 273 | `emitPipelineEvent`, `recordVersionNoop`, `recordCursorAdvance`, `recordHydrateRetry`, `getPipelineMetrics`, `resetMetrics` | ✅ Clean |
| `server/services/cutoverGuard.ts` | 150 | `getCutoverDecision`, `logShadowComparison`, `getShadowComparisonLog`, `getShadowComparisonSummary` | ✅ P3: dead shadow branch |
| `server/services/workerConfig.ts` | 28 | All constants: `WORKER_SCHEDULE_JITTER_MS`, `WORKER_LOCK_TTL_MS`, `WORKER_BATCH_SIZE`, `WORKER_STAGGER_OFFSETS` | ✅ Clean |
| `server/services/workerLock.ts` | 104 | `acquireLock`, `releaseLock`, `isLocked`, `recoverStaleLocks`, `withWorkerLock` | ✅ Clean |
| `server/services/workerLogger.ts` | 149 | `workerLog`, `SyncInstrumentation` class (`withSlot`, `logSummary`) | ✅ Clean |
| `server/services/frontWebhookIngestion.ts` | 689 | `handleFrontWebhook`, `normalizeFrontWebhookEvent`, `normalizeReconciliationEvent`, `applyFrontWebhookResult`, `runFrontReconciliation` | ✅ Clean |
| `server/services/frontIntegration.ts` | 2330 | `hydrateConversationSnapshot`, `getHydratedSnapshot` (hydrate cache layer) | ✅ Clean |
| `server/services/zoomIntegration.ts` | 2181 | `handleZoomWebhookEvent`, `handleZoomMeetingApply`, `handleZoomTranscriptApply`, `processTranscriptBackfillRecord`, `enqueueTranscriptBackfillBatch`, `runZoomReconciliation`, `matchClientByParticipants` | ✅ Clean |
| `server/services/localDominanceSyncWorker.ts` | 682 | Full sync flow, `getCutoverDecision("semrush")` check, shadow mode ingest | ✅ Clean |
| `server/services/semrushInventorySync.ts` | 801 | `startInventorySyncScheduler`, `fetchInventory`, `diffInventory`, `enqueueRefreshWork`, `handleRefreshJob`, `triggerReportRefresh` | ✅ Clean |
| `shared/models/durablePipeline.ts` | 198 | Table schemas: `sourceEventLog`, `workResultLog`, `applyState`; type exports; status enums | ✅ Clean |
| `shared/models/workQueue.ts` | 80 | Table schema: `workQueue`; `WorkQueueJob` type | ✅ Clean |
| `shared/models/communications.ts` | 429 | `frontHydrateSnapshots` table schema, communication schemas | ✅ Clean |
| `server/perfConfig.ts` | 87 | All `PERF` config constants including cutover flags | ✅ P2: flag ambiguity doc'd |
| `server/index.ts` | 519 | Startup sequence, worker stagger, handler registration | ✅ Clean |

**Total**: 26 files, ~13,800 lines. All exported functions audited for correctness, idempotency, race conditions, and observability.

---

## 4. Critical Findings (P0 / P1 / P2 / P3)

### P0 Findings: None

No data-loss or silent-corruption risks identified.

### P1 Findings: None

No correctness bugs under contention or edge cases. The dequeue race (originally assessed P1) was downgraded to P2 because the `isRunning` guard in both scheduler and dispatcher prevents overlapping cycles in the current single-process production deployment.

### P2 Findings

#### P2-1: Enqueue dedupe race under concurrent callers

**File**: `workScheduler.ts:enqueueJob()` (line 94), `repairDispatcher.ts:enqueueRepairJob()` (line 392)
**Behavior**: Both use SELECT-then-INSERT pattern for dedupe checking. Under bursty webhook ingestion, two callers can pass the SELECT simultaneously, and the second INSERT throws a unique violation on the `work_queue` dedupe key partial index.
**Impact**: Error log noise, potential job loss if caller doesn't retry. No data corruption.
**Fix**: Add `.onConflictDoNothing()` on INSERT or wrap in try/catch, returning existing job ID deterministically.

#### P2-2: Dequeue contention (SELECT-then-UPDATE without `FOR UPDATE SKIP LOCKED`)

**File**: `workScheduler.ts:dequeueForClass()` (lines 191–226), `repairDispatcher.ts:dequeueForClass()` (lines 146–193)
**Behavior**: Two-step SELECT → UPDATE pattern. Under multi-process contention, two cycles can SELECT the same job; the OCC guard (`WHERE status='pending'`) prevents double-execution, but the losing cycle silently drops its iteration.
**Contrast**: `workQueueLease.ts:acquireLease()` (line 37) uses the correct atomic pattern: `UPDATE...WHERE id IN (SELECT...FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
**Mitigation**: `isRunning` flag prevents overlapping cycles within single process. No data loss possible.
**Impact**: Under multi-process only — a pending job can be skipped for one poll cycle (5 seconds). Single-process production is immune.
**Fix**: Adopt `FOR UPDATE SKIP LOCKED` CTE pattern. Critical if scaling to multiple processes.

#### P2-3: Duplicate enqueue paths with inconsistent instrumentation

**File**: `workScheduler.ts:enqueueJob()`, `repairDispatcher.ts:enqueueRepairJob()`, `workQueueLease.ts:enqueueJob()` (dead)
**Behavior**: Three distinct INSERT paths for `work_queue`. Scheduler path calls `incrementDedupeHits()` and `pipelineLog()` on dedupe matches; dispatcher path does not.
**Impact**: Inconsistent observability — dedupe hits from repair jobs are invisible to pipeline metrics.
**Fix**: Unify into single `enqueueJob()` with discriminated config.

#### P2-4: Redundant ALTER TABLE DDL on every cold start

**File**: `workScheduler.ts:ensureWorkQueueTable()` (lines 509–536)
**Behavior**: ~20 `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements execute on every startup, including legacy `queue_class` column migration.
**Impact**: Low — idempotent DDL, but unnecessary latency (~200ms) on every cold start.
**Fix**: Remove column-add migrations after confirming production schema is stable. Retain only `CREATE TABLE IF NOT EXISTS`.

#### P2-5: O(N) completion check in `tryMarkSourceEventApplied`

**File**: `applyPipeline.ts:tryMarkSourceEventApplied()` (lines 202–249)
**Behavior**: After each successful apply, queries ALL `work_result_log` entries and their `apply_state` records to determine if the source event can be marked `applied`.
**Impact**: Performance concern under high throughput (N queries per event where N = number of result types). Not a correctness issue.
**Fix**: Consider counter-based approach: increment completion count per event and compare against expected count.

#### P2-6: Zoom/Semrush cutover flag documentation gap

**File**: `server/perfConfig.ts`, `cutoverGuard.ts`
**Behavior**: `LEGACY_DIRECT_MUTATION_ZOOM_ENABLED=false` + `DURABLE_APPLY_ENABLED=false` creates a seemingly ambiguous state. `getCutoverDecision("zoom")` correctly returns `{runLegacy:true}` because durable is off. Additionally, `semrushInventorySync` runs independently of `getCutoverDecision()` (gated by its own `SEMRUSH_*` flags).
**Impact**: No functional bug — verified correct. But the flag interaction is confusing for future maintainers.
**Fix**: Document flag semantics. Consider startup assertion validating flag consistency.

### P3 Findings

#### P3-1: `workQueueLease.ts` is dead code

**File**: `workQueueLease.ts` (267 lines)
**Behavior**: No file in the codebase imports this module. All 12 exported functions are unused.
**Fix**: Delete file after extracting `acquireLease` pattern for P2-2 fix.

#### P3-2: Inconsistent hash truncation

**File**: `replayFramework.ts` (line 564) vs `applyPipeline.ts` (line 39)
**Behavior**: Replay framework uses `sha256.slice(0, 16)` (64 bits); apply pipeline uses `sha256.slice(0, 40)` (160 bits).
**Impact**: Higher collision probability in replay convergence detection. A collision causes unnecessary (but harmless) re-apply.
**Fix**: Standardize on 40-char hash.

#### P3-3: Shadow-mode branch unreachable

**File**: `cutoverGuard.ts:getCutoverDecision()`
**Behavior**: Shadow mode requires `DURABLE_APPLY_ENABLED=true` AND `LEGACY_DIRECT_MUTATION_*_ENABLED=true`. No source currently has both enabled. The shadow comparison logging and summary functions are dead code.
**Fix**: Keep for future cutover phases (Zoom/Semrush durable migration) or remove if not planned.

#### P3-4: In-memory metrics reset on process restart

**File**: `pipelineObservability.ts`, `frontPipelineMetrics.ts`
**Behavior**: Handler duration samples, dedupe counters, shadow comparison logs, and starvation warnings are in-memory. Process restart clears all.
**Impact**: Acceptable — `getPipelineHealth()` queries persist in DB. In-memory metrics supplement with high-resolution recent data.

---

## 5. Cross-System Failure Patterns

### Pattern 1: SELECT-then-Mutate Races

The SELECT-then-INSERT (enqueue dedupe) and SELECT-then-UPDATE (dequeue) patterns recur across `workScheduler`, `repairDispatcher`, and both enqueue paths. These are TOCTOU races that are safe under single-process but become problematic at scale.

**Affected files**: `workScheduler.ts`, `repairDispatcher.ts`
**Root cause**: Drizzle ORM doesn't natively support `FOR UPDATE SKIP LOCKED` in query builder, leading to manual two-step patterns.
**Systemic fix**: Extract atomic CTE queries from `workQueueLease.ts:acquireLease()` into a shared utility.

### Pattern 2: Dual-Path Flag Complexity

Multiple flag systems control the same behavior:
- Cutover guard flags (`DURABLE_APPLY_ENABLED`, `LEGACY_DIRECT_MUTATION_*`)
- Front pipeline flags (8 flags, all in final state)
- Repair queue flags (`REPAIR_QUEUE_ENABLED`, `REPAIR_DISPATCHER_ENABLED`, `INTERACTIVE_REPAIR_ENQUEUE_ENABLED`)
- Semrush-specific flags (`SEMRUSH_INVENTORY_SYNC_ENABLED`, `SEMRUSH_REPORT_REFRESH_ENABLED`)

**Risk**: Flag interaction is complex. The Zoom/Semrush ambiguity (P2-6) demonstrates how `false`+`false` flag combinations can appear contradictory even when behavior is correct.
**Mitigation**: `GET /api/integrations/pipeline/cutover-status` and `GET /api/integrations/work-queue/status` expose flag state for operational visibility.

### Pattern 3: In-Memory State Fragility

Worker locks, pipeline metrics, dequeue histories, shadow comparison logs, and starvation counters are all in-memory. The system correctly handles this via:
- DB-backed persistent queries for critical metrics (`getPipelineHealth()`)
- `recoverStaleLeases()` on scheduler cycle for crash recovery
- `recoverStaleLocks()` on lock acquisition for abandoned workers

**Risk profile**: Low in single-process. Would require externalization (Redis/DB) for multi-process.

---

## 6. End-to-End Behavior Validation

### Workflow 1: New Front Conversation — Unmatched Then Later Matched

1. **Webhook arrives** → `handleFrontWebhook()` validates signature, calls `ingestEvent()` → record created in `source_event_log` with `dedupe_key = "front:conversation:{id}:{version}"`, status `received`.
2. **Normalize job enqueued** → `front_webhook_normalize` job created in `work_queue`.
3. **Normalization runs** → `normalizeFrontWebhookEvent()` extracts participants, direction, subject. `hydrateConversationSnapshot()` fetches full conversation from Front API (cached in `front_hydrate_snapshots`). Result stored in `work_result_log`. Source event marked `normalized`.
4. **Apply job enqueued** → `front_webhook_apply` job created.
5. **Apply runs** → `applyFrontWebhookResult()` checks `findRawCommunicationByExternalSourceId()` for duplicates. None found → `createRawCommunication()` with `matchStatus: "unmatched"`. Source event marked `applied`.
6. **Later matched** → Agent matching engine evaluates unmatched records, updates `matchStatus` and links to client.
- **Dedupe**: `dedupe_key` prevents re-ingestion of same conversation version. `externalSourceId` check in apply prevents duplicate `raw_communication_records`.
- **Retry safety**: `isAlreadyApplied()` returns `already_applied` on retry with same `input_hash`.
- **Observability**: `emitPipelineEvent('discovered')`, `emitPipelineEvent('applied')` tracked in `frontPipelineMetrics`.

### Workflow 2: Front Matched Conversation — Full Ingest

1. Same flow as Workflow 1 through step 5.
2. During normalization, if conversation participants match a known client contact/domain, `matchStatus` is set to `matched` with client ID.
3. Apply creates `raw_communication_records` with `matchStatus: "matched"`, `clientId` populated.
4. `classifyTouchpoint()` determines if this is a meaningful human interaction.
- **Dedupe**: Identical to Workflow 1.
- **Duplication risk**: None — `externalSourceId` uniqueness enforced.

### Workflow 3: Conversation Dismissed Then Replayed

1. Original conversation processed normally → status `applied` in `source_event_log`.
2. Admin triggers replay → `enqueueReplayJob({ mode: "event_log_replay", sourceSystem: "front", ... })`.
3. `handleEventLogReplay()` loads source events in cursor-based chunks (up to 500).
4. For each event: `replayEvent()` resets status to `received`, increments `attempt_count`.
5. Normalize and apply jobs re-enqueued. Normalization re-runs with current logic.
6. Apply runs → `isAlreadyApplied()` checks `input_hash`. If data unchanged → returns `already_applied` (no-op). If data changed → re-applies with new version.
- **Replay safety**: `attempt_count` capped by `max_attempts`. Dead-lettering prevents infinite loops.
- **Observability**: `replay_enqueued` event emitted per replayed item.

### Workflow 4: Zoom Meeting With Transcript Later Available

1. **Webhook** `recording.completed` → `handleZoomWebhookEvent()` → `ingestEvent()` → `source_event_log` entry → enqueue `zoom_meeting_apply`.
2. **Meeting apply** → `handleZoomMeetingApply()` creates `raw_communication_records` with `transcriptStatus: "pending"`. Participant matching via `matchClientByParticipants()`.
3. **Transcript webhook** `recording.transcript_completed` → same ingest flow → enqueue `zoom_transcript_apply`.
4. **Transcript apply** → `handleZoomTranscriptApply()` fetches VTT content, parses via `parseVttTranscript()`, updates record with `transcriptStatus: "ready"`, attaches transcript text.
5. **Analysis enqueued** → `enqueueAnalysis()` creates `analyze_communication` job (only fires when `transcript_status=ready`).
6. **Backfill safety** → If transcript webhook is missed, periodic `enqueueTranscriptBackfillBatch()` finds `pending` records within 72-hour lookback and re-checks Zoom API.
- **Dedupe**: `meetingUuid` used as `externalSourceId` — prevents duplicate records.
- **Retry safety**: Transcript apply checks current `transcriptStatus` before updating.

### Workflow 5: Semrush Campaign Update Triggering Report Refresh

1. **Inventory sync** runs every 6 hours → `fetchInventory()` from Semrush API.
2. **Diff** → `diffInventory()` compares against stored snapshot. New campaigns or report dates detected.
3. **Durable logging** → `source_event_log` entry with `sourceEventType: "inventory_sync"`. Diff stored in `work_result_log` with `resultType: "inventory_diff"`.
4. **Refresh enqueue** → `enqueueRefreshWork()` creates `semrush_report_refresh` jobs for new report dates.
5. **Refresh execute** → `handleRefreshJob()` fetches heatmap data per keyword → stores in `work_result_log` → enqueues `semrush_heatmap_apply`.
6. **Apply** → `semrushHeatmapApply` handler delegates to `importHeatmap()` service for snapshot/points/metrics.
- **Dedupe**: Inventory diff prevents re-processing unchanged campaigns.
- **Unnecessary work**: Full API fetch on every interval (acceptable — small payload).

### Workflow 6: Repair Job — Retry Then Success

1. **Job fails** → handler throws → scheduler catches → increments `attempt_count`, sets `status: "pending"`, computes exponential backoff for `run_after`.
2. **Retry cycle** → scheduler's `dequeueForClass()` only selects jobs where `run_after <= now()` → job waits for backoff period.
3. **Retry succeeds** → handler returns → job marked `completed`.
4. **Max retries exceeded** → if `attempt_count >= max_attempts` → job marked `failed`, dead-lettered.
- **Safety**: `isRunning` guard prevents overlapping scheduler cycles from double-leasing the retry.
- **Observability**: `workerLog({ event: "job_failed", retryable: true })` and `workerLog({ event: "job_completed" })`.

### Workflow 7: Same Object Processed Twice — Unchanged

1. Duplicate event ingested (e.g., Front reconciliation discovers already-processed conversation).
2. `ingestEvent()` → `dedupe_key` unique index violation → returns existing event (dedupe hit counted via `incrementDedupeHits()`).
3. No normalize/apply jobs enqueued — the event was already processed.
4. If bypassed to apply stage: `isAlreadyApplied()` computes `input_hash`, finds matching existing `apply_state` → returns `already_applied`. No side effects.
- **Duplication risk**: Zero — three-layer dedupe (source event, work queue, apply state).

### Workflow 8: Same Object Processed Twice — Changed

1. Updated event arrives with new version (e.g., Front conversation edited → new `version_key`).
2. `ingestEvent()` → different `dedupe_key` (includes version) → new `source_event_log` entry created.
3. Full normalize → apply flow runs.
4. Apply: `isAlreadyApplied()` computes new `input_hash` (different from original). If `isVersionStale()` returns false → new apply proceeds. Old `apply_state` remains as historical record.
5. Result: updated data applied, old version preserved in audit trail.
- **Version handling**: Numeric, date, and string version comparison supported by `isVersionStale()`.

### Workflow 9: Scheduler Under Contention

1. Multiple job types pending across classes: `interactive` (user-triggered), `ingestion` (webhook batch), `repair` (background fix).
2. `buildFairClassOrder()` → orders classes by priority with starvation promotion. If `repair` has been skipped for `MAX_SKIP_CYCLES`, it gets promoted ahead of `ingestion`.
3. `schedulerCycle()` → iterates classes in fair order. For each: checks `acquireClassSlot()` → if available, `dequeueForClass()` → lease and execute.
4. `TOTAL_BUDGET=4` enforced globally — at most 4 concurrent jobs regardless of class budgets summing to 6.
5. `interactive` class always gets priority (budget of 1, always available) — user-triggered actions never starved.
6. If all slots occupied → cycle completes with no new jobs started → next cycle in 5s.
- **Fairness**: Verified — starvation detection with configurable thresholds.
- **Contention behavior**: Single-process `isRunning` prevents overlapping cycles. Multi-process would cause benign dequeue skip (P2-2).

---

## 7. Runtime Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **Backlog growth under sustained burst** | Medium | Low | 5s poll interval with class-based dequeue processes backlog proportional to handler speed. `checkStarvation()` alerts on aging jobs. Ingestion class budget of 2 limits webhook processing rate. |
| **API/AI cost explosion from replay** | Medium | Low | Replay is admin-initiated only (not automatic). `dryRun` flag supported. Chunk size capped at 500. No auto-replay on failure. |
| **Retry storm from systematic handler failure** | Low | Low | Exponential backoff with `max_attempts` (default 5). Dead-lettering prevents infinite loops. `run_after` timestamp prevents immediate re-processing. |
| **Replay loop (replay triggers replay)** | Low | Very Low | Replayed events use fresh `attempt_count`. Continuation chunks use `dedupeKey` with chunk index — duplicate chunks rejected. |
| **Deploy/restart behavior** | Low | Certain | `recoverStaleLeases()` on every scheduler cycle reclaims jobs from crashed processes. Worker stagger (10–140s + 30s jitter) prevents thundering herd. In-memory metrics lost but DB-backed metrics persist. |
| **Process-local state issues** | Low | Low | Worker locks are in-memory — a second process could acquire the same lock. Mitigated by single-process deployment. Locks have TTL (15min) with heartbeat (30s) and `recoverStaleLocks()`. |
| **Stale hydrate cache serving outdated data** | Low | Low | `front_hydrate_snapshots` cached by `version_key` — version changes invalidate cache. Only used for Front conversations. |
| **Semrush inventory API rate limiting** | Low | Low | Inventory sync runs every 6 hours. Small payload. No aggressive retry on API failure. |
| **Zoom transcript backfill racing with webhook** | Low | Medium | Both paths check `transcript_status` before updating. If webhook arrives while backfill is running, the later writer wins (last-write-wins on the same record). No duplicate records created. |

---

## 8. Recommended Fix Tasks

### Task F1: Fix Enqueue Dedupe Race (P2)

- **Title**: Add conflict handling to work queue enqueue INSERT
- **Problem**: SELECT-then-INSERT dedupe check in `enqueueJob()` and `enqueueRepairJob()` causes unique violations under burst.
- **Scope**: `workScheduler.ts:enqueueJob()`, `repairDispatcher.ts:enqueueRepairJob()`
- **Rationale**: Prevents error noise in production logs and eliminates potential job loss on unhandled exception.
- **Acceptance criteria**: Concurrent enqueue of same dedupe key returns existing job ID without error. Unit-testable with concurrent calls.
- **Files affected**: `server/services/workScheduler.ts`, `server/services/repairDispatcher.ts`
- **Execution**: Parallel with F2–F4.

### Task F2: Atomic Dequeue with FOR UPDATE SKIP LOCKED (P2)

- **Title**: Replace SELECT-then-UPDATE dequeue with atomic CTE
- **Problem**: Non-atomic dequeue causes throughput loss under multi-process contention.
- **Scope**: `dequeueForClass()` in both `workScheduler.ts` and `repairDispatcher.ts`
- **Rationale**: Becomes critical if scaling to multiple processes. Pattern already exists in `workQueueLease.ts:acquireLease()`.
- **Acceptance criteria**: Dequeue uses single `UPDATE...WHERE id IN (SELECT...FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` query. No wasted cycles under contention.
- **Files affected**: `server/services/workScheduler.ts`, `server/services/repairDispatcher.ts`
- **Execution**: Parallel with F1, F3, F4.

### Task F3: Unify Enqueue Paths (P2)

- **Title**: Consolidate enqueue functions into single implementation
- **Problem**: Three enqueue implementations with inconsistent instrumentation.
- **Scope**: Merge `workScheduler.enqueueJob()` and `repairDispatcher.enqueueRepairJob()` into shared utility. Delete dead `workQueueLease.enqueueJob()`.
- **Rationale**: Ensures consistent dedupe hit tracking and pipeline logging across all job types.
- **Acceptance criteria**: Single `enqueueJob()` function used by both scheduler and dispatcher. All enqueue paths emit `pipelineLog()` and `incrementDedupeHits()`.
- **Files affected**: `server/services/workScheduler.ts`, `server/services/repairDispatcher.ts`, `server/services/workQueueLease.ts`
- **Execution**: Sequential after F1 (builds on conflict handling fix).

### Task F4: Clean Up Startup DDL (P2)

- **Title**: Remove redundant ALTER TABLE migrations from cold start
- **Problem**: ~20 `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements run on every startup.
- **Scope**: `workScheduler.ts:ensureWorkQueueTable()` (lines 509–536)
- **Rationale**: Eliminates unnecessary DDL latency (~200ms per cold start).
- **Acceptance criteria**: Only `CREATE TABLE IF NOT EXISTS` and index creation remain. Legacy column migrations removed.
- **Files affected**: `server/services/workScheduler.ts`
- **Execution**: Parallel with F1–F3.

### Task F5: Delete Dead Code — `workQueueLease.ts` (P3)

- **Title**: Remove unused `workQueueLease.ts`
- **Problem**: 267 lines of dead code. No imports anywhere in codebase.
- **Scope**: Delete file entirely.
- **Rationale**: Code hygiene. Extract `acquireLease` pattern into F2 before deleting.
- **Acceptance criteria**: File removed. No import errors. F2 has adopted the pattern.
- **Files affected**: `server/services/workQueueLease.ts`
- **Execution**: Sequential after F2 (pattern extraction first).

### Task F6: Standardize Hash Length (P3)

- **Title**: Align `computeInputHash` truncation across replay and apply
- **Problem**: Replay uses 16-char hash, apply uses 40-char hash for same conceptual operation.
- **Scope**: `replayFramework.ts:computeInputHash()`
- **Rationale**: Reduces collision probability in convergence detection from 2^-64 to 2^-160.
- **Acceptance criteria**: Both files use same hash length (40 chars).
- **Files affected**: `server/services/replayFramework.ts`
- **Execution**: Parallel with any task.

---

## 9. Safe-to-Defer Items

These findings are tracked but require no immediate action:

| Item | Reason to Defer |
|------|----------------|
| **Shadow-mode branch in `cutoverGuard.ts`** (P3-3) | Will be useful during Zoom/Semrush durable apply cutover. Keep for rollback capability. Remove only if durable cutover is abandoned. |
| **In-memory metrics reset on restart** (P3-4) | DB-backed `getPipelineHealth()` provides persistent metrics. In-memory supplements with recent high-resolution data. Only a concern if deploying with frequent restarts or autoscaling. |
| **`tryMarkSourceEventApplied` O(N) check** (P2-5) | Current N is small (1–3 result types per event). Only becomes a concern at >>10 result types per event or >>1000 events/minute throughput. Monitor before optimizing. |
| **Semrush full inventory fetch on every interval** | Payload is small, API is not aggressively rate-limited, and diff logic skips unchanged campaigns. Optimization (conditional fetch / ETag) is premature. |
| **Zoom/Semrush cutover flag documentation** (P2-6) | No functional bug exists. Flag semantics are correct but confusing. Document in `docs/cutover-migration-notes.md` when planning durable cutover for these sources. |
| **Front pipeline cutover flag cleanup** | All 8 flags are in final state. Could be hardcoded and flags removed. But keeping flags provides zero-downtime rollback path. Remove only after extended stability (>30 days). |

---

## 10. Evidence Appendix

All findings reference specific files, functions, and line numbers. This appendix consolidates the evidence backing each claim.

### Schema Correctness

| Claim | Evidence |
|-------|----------|
| `source_event_log` unique index on `dedupe_key` | `shared/models/durablePipeline.ts`: `uniqueIndex` on `dedupeKey` column |
| `apply_state` unique constraint on `(work_result_id, apply_target)` | `shared/models/durablePipeline.ts`: composite unique index |
| `work_queue` partial unique index on `dedupe_key` | `workScheduler.ts:ensureWorkQueueTable()` — `CREATE UNIQUE INDEX ... WHERE status NOT IN (...)` |

### Idempotency Guarantees

| Claim | Evidence |
|-------|----------|
| `isAlreadyApplied()` checks `input_hash` | `applyPipeline.ts:120` — compares `computeInputHash(resultJson)` against stored `input_hash` |
| `getOrCreateApplyState()` handles concurrent creation | `applyPipeline.ts:73` — uses `onConflictDoNothing()` with fallback `SELECT` |
| `communicationApply` deduplicates by `externalSourceId` | `applyHandlers.ts:36` — calls `findRawCommunicationByExternalSourceId()` before insert |
| `meetingApply` deduplicates by `meetingUuid` | `applyHandlers.ts:117` — same pattern |

### Race Conditions

| Claim | Evidence |
|-------|----------|
| Dequeue uses SELECT-then-UPDATE | `workScheduler.ts:191–226` — `select().from(workQueue).where(...)` then `update(workQueue).set({status:'leased'})` |
| `workQueueLease.ts` has atomic pattern | `workQueueLease.ts:37` — `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` |
| `isRunning` prevents overlapping cycles | `workScheduler.ts:schedulerCycle()` — `if (isRunning) return; isRunning = true; try { ... } finally { isRunning = false; }` |
| Enqueue dedupe is SELECT-then-INSERT | `workScheduler.ts:94` — `select().from(workQueue).where(eq(dedupeKey, ...))` then `insert(workQueue).values({...})` |

### Dead Code

| Claim | Evidence |
|-------|----------|
| `workQueueLease.ts` is unused | `grep -r "workQueueLease" --include="*.ts"` returns zero import matches outside the file itself |
| Shadow-mode branch unreachable | `cutoverGuard.ts:getCutoverDecision()` — `shadowMode: true` requires both `DURABLE_APPLY_ENABLED=true` AND `LEGACY_DIRECT_MUTATION_*=true`. No source has both enabled. |

### Cutover Flag State

| Flag | Default | Current Effect | Evidence |
|------|---------|---------------|----------|
| `DURABLE_APPLY_ENABLED` | `false` | Zoom/Semrush skip durable apply | `perfConfig.ts` |
| `LEGACY_DIRECT_MUTATION_ZOOM_ENABLED` | `false` | Not read directly by Zoom paths | `perfConfig.ts`, `cutoverGuard.ts:getCutoverDecision("zoom")` returns `{runLegacy:true}` |
| `LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED` | `false` | Not read directly by Semrush paths | Same as above |
| `FRONT_PIPELINE_*` (6 new flags) | All `true` | Full new pipeline active | `perfConfig.ts` |
| `FRONT_LEGACY_*` (2 legacy flags) | All `false` | Legacy paths disabled | `perfConfig.ts` |

### Scheduler Fairness

| Claim | Evidence |
|-------|----------|
| Starvation promotion after `MAX_SKIP_CYCLES` | `workScheduler.ts:buildFairClassOrder()` — tracks skip counts per class, promotes when threshold exceeded |
| `TOTAL_BUDGET=4` enforced | `workloadManager.ts:37` — `export const TOTAL_BUDGET = 4` |
| Class budgets: interactive:1, ingestion:2, repair:1, maintenance:1 | `workloadManager.ts` — `CLASS_BUDGETS` constant |
| `awaitClassSlot()` 30s timeout | `workloadManager.ts:167` — `awaitClassSlot` with configurable timeout defaulting to 30s |

### Worker Lifecycle

| Claim | Evidence |
|-------|----------|
| Stagger offsets 10–140s | `workerConfig.ts:15` — `WORKER_STAGGER_OFFSETS` object with per-worker delays |
| 30s jitter | `workerConfig.ts:1` — `WORKER_SCHEDULE_JITTER_MS = 30_000` |
| Lease recovery on each cycle | `workScheduler.ts:schedulerCycle()` — calls `recoverStaleLeases()` at start of every cycle |
| Lock TTL 15min with 30s heartbeat | `workerConfig.ts:2–3` — `WORKER_LOCK_TTL_MS = 900_000`, `WORKER_LOCK_HEARTBEAT_MS = 30_000` |
