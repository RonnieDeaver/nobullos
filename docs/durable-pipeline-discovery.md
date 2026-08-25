# Durable Pipeline Discovery Map

> Pre-migration reference for Task #263 — maps every ingestion entry point, mutation
> path, dedupe key, checkpoint/cursor, replay/backfill path, feature flag, scheduler
> hook, and migration risk area across Front, Zoom, and Semrush integrations.
>
> **Scope:** Read-only discovery. No code changes.
>
> **Companion doc:** `docs/worker-starvation-architecture-map.md` (Task 253A) covers
> lock/slot/timer internals in detail. This document focuses on the data-flow and
> state-management aspects relevant to a durable compute/apply pipeline cutover.

---

## Table of Contents

1. [Front Integration](#1-front-integration)
2. [Zoom Integration](#2-zoom-integration)
3. [Semrush / Local Dominance Integration](#3-semrush--local-dominance-integration)
4. [Shared Infrastructure](#4-shared-infrastructure)
5. [Feature Flags & Runtime Tunables](#5-feature-flags--runtime-tunables)
6. [Cross-Cutting Migration Risk Areas](#6-cross-cutting-migration-risk-areas)
7. [Summary Matrix](#7-summary-matrix)

---

## 1. Front Integration

**Primary file:** `server/services/frontIntegration.ts` (2 231 lines)

### 1.1 Ingestion Entry Points

| Entry point | Trigger | Function | Line ref |
|---|---|---|---|
| Polling sync cycle | `setInterval` every 5 min (`SYNC_INTERVAL_MS`) | `runSyncCycle()` | ~L997 |
| Startup initial sync | Fire-and-forget inside `startAutoSync()` | `runSyncCycle()` | ~L1447 |
| Startup re-evaluation | Fire-and-forget inside `startAutoSync()` | `reEvaluateExistingUnmatched()` | ~L1453 |
| Periodic client matching | `setInterval` every 10 min | `retroactiveReprocess()` via `agentMatchingEngine` | ~L2097 |
| Periodic spam cleanup | `setInterval` every 15 min | `bulkClassifyUnmatched()` | ~L2068 |
| Manual re-match (admin) | HTTP `POST /api/integrations/front/rematch-all` | `rematchAll()` | integrations.ts:789 |
| Manual reprocess (admin) | HTTP `POST /api/integrations/front/reprocess-dismissed` | `reprocessDismissedNonSpam()` | integrations.ts:753 |
| Work-queue handler | `front_rematch_all` queue job | `handleFrontRematchAll()` | workQueueHandlers.ts:54 |
| Work-queue handler | `front_sync_reprocess` queue job | `handleFrontSyncReprocess()` | workQueueHandlers.ts:154 |
| Work-queue handler | `bulk_classify` queue job | `handleBulkClassify()` | workQueueHandlers.ts:105 |
| Work-queue handler | `retroactive_reprocess` queue job | `handleRetroactiveReprocess()` | workQueueHandlers.ts:130 |

### 1.2 Cursors & Checkpoints

| Key | Storage | Format | Semantics |
|---|---|---|---|
| `front_sync_cursor` | `system_settings` table | Unix timestamp (seconds, stringified integer) | Highest `created_at` of processed conversations. Advances monotonically. |
| `front_sync_page_token` | `system_settings` table | Opaque string from Front API `_pagination.next` | Resumption token within a multi-page fetch. Cleared when page set is exhausted. |
| `front_reprocess_cursor_<cohort>` | `system_settings` table | JSON `{ createdAt, id }` | Cohort-scoped keyset cursor for `reprocessDismissedNonSpam()`. Key includes cohort suffix (e.g., `front_reprocess_cursor_dismissed_operational`). Stores the `createdAt` timestamp and `id` of the last processed `front_sync_emails` record for pagination resumption. |

**Cursor lifecycle:**

1. `runSyncCycle()` reads `front_sync_cursor` and `front_sync_page_token` at cycle start.
2. Conversations are fetched via `fetchRecentConversations(cursor, pageToken)`.
3. Every 10 processed conversations (`CURSOR_PERSIST_INTERVAL`), an incremental cursor save writes the highest `created_at` seen so far.
4. At cycle end:
   - If the page set is exhausted (`fetchResult.exhausted === true`), cursor advances by +60 s beyond the highest processed `created_at`.
   - If all conversations were already processed or operationally dismissed, cursor force-advances by +1 to break stall.
   - Page token is saved if more pages remain; cleared otherwise.

**Risk:** The cursor is a timestamp, not an immutable ID. Clock drift in the Front API or out-of-order `created_at` values can cause conversations to be skipped or replayed.

### 1.3 Dedupe Keys

| Layer | Dedupe key | Mechanism |
|---|---|---|
| Sync record | `front_sync_emails.conversation_id` | Unique column. Bulk-skip via `getExistingConversationIds()` before processing loop. |
| Raw communication | `raw_communication_records.external_source_id = conversationId` | Checked via `findRawCommunicationByExternalSourceId()` before `ingestConversation()`. If found, links to sync record without re-ingesting. |

### 1.4 Direct Mutation Paths (Apply Side)

These are the write operations that occur during or after ingestion. Each represents a step that would need to be captured in a durable apply pipeline.

| Step | Table(s) mutated | Transactional? | Notes |
|---|---|---|---|
| Create sync email record | `front_sync_emails` | Single insert | Always written for every new conversation, even if unmatched or dismissed. |
| Ingest conversation | `raw_communication_records` | Single insert via `storage.createRawCommunication()` | Only for matched conversations without an existing raw record. |
| Link sync to raw record | `front_sync_emails.ingestedRecordId` | Single update | Links sync record to raw communication record after ingest. |
| Operational classification | `front_sync_emails.matchStatus` → `dismissed_operational` | Single update | Runs AI classifier (`operationalClassifier.classifyCommunication`). |
| Agent matching engine | `client_agent_memory` reads/writes | Multiple queries per evaluation | `evaluateCommunication()` reads memory, may update confidence scores. |
| Contact enrichment | `client_contacts` | Upsert per participant email | `enrichClientContactsFromParticipants()` — runs outside the main transaction. |
| Cursor persist | `system_settings` | Single upsert | Every 10 conversations and at cycle end. |
| Agent memory seeding | `client_agent_memory` | Batch inserts | `seedAllAgentMemories()` runs at startup; `seedAgentMemoryForClient()` runs on contact changes. |

### 1.5 Operator-Driven Mutation Endpoints

These manual endpoints allow operators to change match state and trigger ingestion outside the automated sync cycle. Each represents a mutation path that a durable pipeline must account for.

| Endpoint | Function | Tables mutated | Side effects |
|---|---|---|---|
| `POST /api/integrations/unmatched/front/:id/assign` | `assignUnmatchedEmail(id, clientId, userId)` | `front_sync_emails` (matchStatus → manually_matched), `raw_communication_records` (ingest), `client_contacts` (enrichment) | Also triggers `learnFromManualMatch()` on agent memory and decision correction/confirmation learning (fire-and-forget). |
| `POST /api/integrations/unmatched/front/:id/dismiss` | `dismissUnmatchedEmail(id, userId)` | `front_sync_emails` (matchStatus → dismissed) | Triggers `learnFromDismiss()` on operational classifier (fire-and-forget learning). |
| `POST /api/integrations/unmatched/front/:id/block` | Direct `storage.updateFrontSyncEmail()` | `front_sync_emails` (matchStatus → blocked) | Triggers `learnFromBlock()` on operational classifier only (fire-and-forget). |
| `POST /api/integrations/unmatched/front/:id/promote` | Direct `storage.updateFrontSyncEmail()` | `front_sync_emails` (matchStatus → unmatched, clears operationalClassificationReason) | Triggers `learnFromPromote()` on operational classifier (fire-and-forget). Resets the record to be re-evaluated by automated matching. |
| `POST /api/integrations/front/reset-sync` | Purges all `front_sync_emails`, resets cursors | `front_sync_emails` (bulk delete), `system_settings` (cursor reset) | Re-seeds agent memory, runs full re-scan and re-evaluation. |

### 1.6 Replay / Backfill Paths (Automated)

| Path | Function | Behavior |
|---|---|---|
| Re-evaluate unmatched | `reEvaluateExistingUnmatched()` | Scans up to 10 000 unmatched `front_sync_emails`, re-runs operational classifier + agent matching, updates status and ingests newly matched conversations. |
| Reprocess dismissed | `reprocessDismissedNonSpam()` | Internal processing chunks of 100 (`REPROCESS_CHUNK_SIZE`); work-queue handler caps job-level `maxItems` at 500 (`CHUNK_SIZE`). Persists keyset cursor `{ createdAt, id }` in `front_reprocess_cursor_<cohort>`. Re-runs matching pipeline on dismissed_operational, unmatched, or all cohorts. |
| Rematch all | `rematchAll()` | Full re-match of all conversations, chunked at 500. Self-enqueues continuation via `enqueueRepairJob()` when chunk is full. |
| Agent decontamination | `decontaminateAgentMemory()` + `cleanupPoisonedMemory()` | Scans agent memory and op-filter entries for contamination, purges, then re-seeds all agent memories. |

### 1.6 Scheduler Hooks

- **Auto-sync startup:** `startAutoSync()` starts the 5-min `setInterval`, runs `seedAllAgentMemories()`, runs initial `runSyncCycle()`, then runs `reEvaluateExistingUnmatched()` — all in a fire-and-forget async IIFE.
- **Sub-workers started from within `initAutoSync()`:** `startSyncHealthCheck()` (1 min), `startPeriodicSpamCleanup()` (15 min), `startPeriodicClientMatching()` (10 min).
- **Staggered startup offset:** `front_sync` has a 10 s base offset + 0–30 s jitter (`workerConfig.ts`).

---

## 2. Zoom Integration

**Primary file:** `server/services/zoomIntegration.ts` (1 664 lines)

### 2.1 Ingestion Entry Points

| Entry point | Trigger | Function | Line ref |
|---|---|---|---|
| Daily sync cycle | Chained `setTimeout` targeting 2 AM (`ZOOM_SYNC_CRON_HOUR`) | `runZoomSyncCycle()` | ~L1032 |
| Transcript backfill (inline) | Called within daily sync cycle | `runTranscriptBackfill()` | ~L1068 |
| Transcript backfill (queue) | `zoom_transcript_backfill` queue job | `handleZoomTranscriptBackfill()` | workQueueHandlers.ts:185 |
| Per-record backfill | Queue sub-job with `recordIds` payload | `processTranscriptBackfillRecord()` | zoomIntegration.ts:1194 |
| Periodic transcript backfill | `setInterval` every 30 min | `startPeriodicTranscriptBackfill()` → enqueues `zoom_transcript_backfill` repair job | zoomIntegration.ts:1607 |
| Manual meeting assignment | HTTP `POST /api/integrations/unmatched/:source/:id/assign` (source=zoom) | `ingestMeeting()` | integrations.ts:350 |
| Startup init | Staggered `setTimeout` (40 s base) | `initZoomAutoSync()` → starts daily sync + periodic backfill | index.ts |

### 2.2 Cursors & Checkpoints

| Aspect | Details |
|---|---|
| **Cursor type** | **None** — Zoom uses a time-window lookback, not a persisted cursor. |
| **Lookback window** | 72 hours (`ZOOM_RECORDING_LOOKBACK_HOURS` from `workerConfig.ts`). |
| **Implication** | Every daily sync re-scans the last 72 hours of recordings. Dedupe is entirely via `external_source_id` uniqueness. No cursor to advance or roll back. |

### 2.3 Dedupe Keys

| Layer | Dedupe key | Mechanism |
|---|---|---|
| Raw communication | `external_source_id = zoom_meeting_<uuid>` | Checked via `findByExternalSourceId()` before inserting. UUID is Zoom's meeting UUID. |
| Transcript backfill | `transcriptStatus` column on `raw_communication_records` | `pending` → `ready` or `failed`. Records with `ready` or `failed` are skipped on backfill scans. |
| Queue-level backfill dedupe | `dedupeKey = zoom_backfill_batch:<parentJobId>:<batchIndex>` | Prevents duplicate batch jobs in the work queue. |

### 2.4 Direct Mutation Paths (Apply Side)

| Step | Table(s) mutated | Transactional? | Notes |
|---|---|---|---|
| Create raw communication | `raw_communication_records` | Single insert via `storage.createRawCommunication()` | Sets `sourceType = "zoom"`, `sourceSubtype = "zoom_meeting"` or `"zoom_transcript"`. |
| Set transcript status | `raw_communication_records.transcriptStatus` | Separate `UPDATE` after insert | Initially `pending` if no transcript, `ready` if transcript present at ingest time. |
| Primary client link | `communication_client_links` | Upsert via `onConflictDoUpdate` on `(rawCommunicationRecordId, clientId)` | Written for matched meetings. |
| Multi-client links | `communication_client_links` | Batch upserts | For meetings with multiple content-matched clients (`allContentMatches`). |
| Auto-populate key call | `command_panel_key_calls` | Upsert via `upsertKeyCall()` | Matches meeting topic against call types (QBR, kick-off, etc.). |
| Transcript backfill update | `raw_communication_records` | Multi-field update | Updates `contentText`, `sourceSubtype`, `rawPayloadJson`, `processingStatus`, `transcriptStatus`. |
| Touchpoint classification | `raw_communication_records.isTouchpoint` (via `finalizeTouchpointClassification`) | Single update | Runs after transcript backfill. |
| Enqueue analysis | `work_queue` | Insert | `analyze_communication` job enqueued after ingest or backfill. |

### 2.5 Operator-Driven Mutation Endpoints

| Endpoint | Function | Tables mutated | Side effects |
|---|---|---|---|
| `POST /api/integrations/unmatched/zoom/:id/assign` | `ingestMeeting()` via assign handler | `raw_communication_records` (create/update with clientId), `communication_client_links` | Triggers `analyzeCommunication()` (fire-and-forget), Google Drive upload if configured (fire-and-forget), and agent memory learning: `learnFromManualMatch()`, `learnFromCorrection()`/`learnFromConfirmation()` for prior decisions (fire-and-forget). Does *not* trigger `retroactiveReprocess`. |
| `POST /api/integrations/unmatched/zoom/:id/dismiss` | Direct `storage.updateRawCommunication()` | `raw_communication_records` (matchStatus → dismissed_operational) | Updates `operationalClassificationReason` to "Dismissed by user". Shares generic handler with Slack source. |
| `POST /api/integrations/unmatched/zoom/:id/block` | Direct `storage.updateRawCommunication()` | `raw_communication_records` (matchStatus → dismissed_operational) | Updates `operationalClassificationReason` to "Blocked by user". Shares generic handler with Slack source. |
| `POST /api/integrations/unmatched/zoom/:id/promote` | Direct `storage.updateRawCommunication()` | `raw_communication_records` (matchStatus → unmatched, processingStatus → pending, clears operationalClassificationReason) | Resets record for re-evaluation by automated matching. Shares generic handler with Slack source. |

### 2.7 Replay / Backfill Paths

| Path | Function | Behavior |
|---|---|---|
| Inline transcript backfill | `runTranscriptBackfill()` | Scans `raw_communication_records` where `sourceType = "zoom"`, `transcriptStatus IN ('pending', NULL)`, `contentText IS NULL/empty`, `createdAt > (now - 72h)`. Fetches transcript from Zoom API per record. |
| Queue-based transcript backfill | `handleZoomTranscriptBackfill()` | Discovers all pending records via `enqueueTranscriptBackfillBatch()`, fans out into batches of 20 (`BACKFILL_BATCH_SIZE`) as sub-jobs with individual `recordIds`. |
| 72-hour lookback re-scan | `discoverUnmatchedRecordings()` | Every daily cycle re-discovers unmatched recordings. Already-ingested ones are skipped via `external_source_id` check. |

### 2.8 Scheduler Hooks

- **Daily schedule:** `initZoomAutoSync()` calculates ms-until-2AM, sets a one-shot `setTimeout`, which runs the cycle then schedules the next day's run. Not a `setInterval`.
- **Periodic transcript backfill:** `startPeriodicTranscriptBackfill()` runs a 30-min `setInterval` that enqueues `zoom_transcript_backfill` repair jobs with `dedupeKey = "periodic:zoom_transcript_backfill"` (prevents duplicate active jobs). Started from `initZoomAutoSync()` when Zoom is connected.
- **Overlap guard:** `zoomSyncRunning` boolean flag + `workerLock("zoom_sync")`.
- **Staggered startup offset:** 40 s base + 0–30 s jitter.

---

## 3. Semrush / Local Dominance Integration

**Primary files:**
- `server/services/localDominanceSyncWorker.ts` (655 lines) — orchestration
- `server/services/heatmapService.ts` (728 lines) — data persistence

### 3.1 Ingestion Entry Points

| Entry point | Trigger | Function | Line ref |
|---|---|---|---|
| Scheduled sync | `setInterval` every 6 hours (`SYNC_INTERVAL_MS`) | `syncAllActiveClients()` | localDominanceSyncWorker.ts:526 |
| Manual single-client sync | HTTP `POST /api/clients/:clientId/semrush-integration/sync` | `syncSingleClient()` | heatmap.ts:460, localDominanceSyncWorker.ts:543 |
| Admin sync-all | HTTP `POST /api/admin/local-dominance/sync-all` | `syncAllActiveClients()` | heatmap.ts:1082 |
| Single keyword heatmap fetch | HTTP `POST /api/semrush/campaigns/:campaignId/fetch-heatmap` | SEMrush API → `importHeatmap()` | heatmap.ts:193 |
| All-keywords heatmap fetch | HTTP `POST /api/semrush/campaigns/:campaignId/fetch-all-heatmaps` | SEMrush API → `importHeatmap()` per keyword | heatmap.ts:289 |
| Direct heatmap import | HTTP `POST /api/heatmaps/import` | `importHeatmap()` | heatmap.ts:1120 |
| Batch heatmap import | HTTP `POST /api/heatmaps/import-batch` | `importHeatmap()` per snapshot | heatmap.ts:1145 |
| Startup init | Staggered `setTimeout` (100 s base) | `startSyncScheduler()` | localDominanceSyncWorker.ts:523 |

### 3.2 Cursors & Checkpoints

| Aspect | Details |
|---|---|
| **Cursor type** | **None** — full re-poll of all active campaigns per sync cycle. |
| **Per-client state** | `client_semrush_integrations.syncStatus` (`idle` / `syncing` / `success` / `error`). |
| **Per-client progress** | `client_semrush_integrations.syncProgress` (JSONB, cleared on start and completion). |
| **Heartbeat** | `client_semrush_integrations.updatedAt` written during long keyword iterations to signal liveness (no dedicated heartbeat column). |
| **Campaign staleness** | `semrush_location_campaigns.isStale` boolean — marks campaigns needing re-sync. |

### 3.3 Dedupe Keys

| Layer | Dedupe key | Mechanism |
|---|---|---|
| Heatmap snapshot | `(campaignId, keywordName, locationId, reportDate day-range)` | **SELECT-before-INSERT inside a DB transaction.** `heatmapService.ts:281` queries for existing snapshot within the same day range before inserting. The snapshot, points, and metrics are all written within the same transaction. |
| Location campaign | `(clientId, semrushCampaignId, locationId)` | Implicit uniqueness in the `semrush_location_campaigns` table. |

**Important:** The snapshot insert, point generation, and metrics computation all run inside a single `db.transaction()` block (`heatmapService.ts:275–383`). However, downstream enrichment steps — derived metrics (`computeAndStoreDerivedMetrics`), SoV computation, and competitor analysis — run *after* the transaction completes (`heatmapService.ts:386+`). A crash during post-transaction enrichment leaves a valid snapshot with incomplete derived data.

### 3.4 Direct Mutation Paths (Apply Side)

| Step | Table(s) mutated | Transactional? | Notes |
|---|---|---|---|
| Import heatmap snapshot | `heatmap_snapshots` | In transaction (with dedupe check, points, and metrics) | Core snapshot data: grid dimensions, rank stats, campaign metadata. |
| Import heatmap points | `heatmap_points` | In same transaction as snapshot | Individual grid-point rank values. Batch-inserted in chunks of 500. |
| Compute heatmap metrics | `heatmap_metrics` | In same transaction as snapshot | Aggregated stats (avg rank, coverage %, etc.). |
| Derived metrics enrichment | Various (derived metrics, SoV, competitors) | **Outside transaction** | `computeAndStoreDerivedMetrics()` and related functions run post-commit. |
| Update sync status | `client_semrush_integrations` | Single update | `syncStatus`, `lastSuccessfulSyncAt`, `lastFailedSyncAt`, `errorMessage`. |
| Update heartbeat | `client_semrush_integrations.updatedAt` | Single update | Written during long keyword iterations to signal liveness (no dedicated heartbeat column). |
| Mark campaign stale/fresh | `semrush_location_campaigns.isStale` | Single update | Toggled based on data freshness checks. |

### 3.5 Replay / Backfill Paths

| Path | Function | Behavior |
|---|---|---|
| Full client re-sync | `syncSingleClient()` | Re-polls all campaigns for a specific client. The SELECT-before-INSERT dedupe in the snapshot import prevents true duplicates, but all API calls are re-executed. |
| Scheduled full re-sync | `syncAllActiveClients()` | Iterates all clients with active Semrush integrations. Each client's campaigns are fully re-polled. |

### 3.6 Scheduler Hooks

- **6-hour `setInterval`:** `startSyncScheduler()` at `localDominanceSyncWorker.ts:523`.
- **Manual sync timeout:** Dynamic timeout calculation based on location count, campaign count, and estimated keywords. Base 5 min + 1 min/location + 35 s/keyword, capped at 15 min.
- **Overlap guard:** `isSyncing` boolean flag + `workerLock("local_dominance_sync")`.
- **Staggered startup offset:** 100 s base + 0–30 s jitter.

---

## 4. Shared Infrastructure

### 4.1 Work Queue (`work_queue` Table)

**Files:** `workScheduler.ts`, `repairDispatcher.ts`, `workQueueHandlers.ts`, `workloadManager.ts`

The `work_queue` table is a DB-backed job queue with lease-based delivery:

| Column | Purpose |
|---|---|
| `queue_name` | Logical queue (e.g., `front_rematch_all`, `bulk_classify`) |
| `workload_class` | Budget class: `interactive`, `interactive_repair`, `ingestion`, `repair`, `maintenance` |
| `priority` | Lower = higher priority (default 5 for scheduler, 100–200 for repair) |
| `status` | `pending` → `leased` → `processing` → `completed` / `failed` / `dead_letter` / `cancelled` |
| `dedupe_key` | Unique index (partial: non-terminal statuses only) — prevents duplicate active jobs |
| `cursor` | Opaque string for handler-managed resumption state |
| `lease_owner` | PID-based owner identifier |
| `lease_expires_at` | Lease expiry for stale-lease recovery |
| `updatedAt` | Last activity timestamp (doubles as heartbeat liveness signal) |
| `attempt_count` / `max_attempts` | Retry tracking |
| `retry_at` | Backoff-delayed retry timestamp |

### 4.2 Workload Class Budgets

| Class | Max concurrency | Purpose | Workers |
|---|---|---|---|
| `interactive` | 1 | User-triggered, scheduler-owned | Scheduler-dispatched interactive jobs |
| `interactive_repair` | 1 | User-triggered repair via UI | Repair dispatcher |
| `ingestion` | 2 | Sync workers | `front_sync`, `zoom_sync`, `local_dominance_sync` |
| `repair` | 1 | Background repair/reprocess | `retroactiveReprocess`, `frontRematchAll`, `frontSyncReprocess`, `agentDecontamination` |
| `maintenance` | 1 | Background maintenance | `bulkClassify`, `startupCleanup` |

**Global cap:** `TOTAL_BUDGET = 4` concurrent slots across all classes. Maintenance class has an effective cap of `TOTAL_BUDGET - 1` (interactive reserve).

### 4.3 Scheduler (`workScheduler.ts`)

- Polls every 5 s (`POLL_INTERVAL_MS`).
- Owns `interactive` and optionally `ingestion` classes (via `getSchedulerOwnedClasses()`).
- When `PERF.REPAIR_DISPATCHER_ENABLED` is true, repair/maintenance classes are owned by the `repairDispatcher` instead.
- Lease duration: 5 min (`MAX_LEASE_MS = 300_000`).
- Stale-lease recovery: jobs leased longer than `MAX_LEASE_MS` are reset to `pending`.

### 4.4 Repair Dispatcher (`repairDispatcher.ts`)

- Polls every 5 s (`PERF.REPAIR_DISPATCHER_POLL_MS`).
- Owns `interactive_repair`, `repair`, `maintenance` classes.
- Fair-scheduling: `buildFairClassOrder()` promotes starved classes after `MAX_SKIP_CYCLES` (default 3) consecutive skips.
- Lease duration: 5 min (`PERF.REPAIR_DISPATCHER_LEASE_MS`).
- Heartbeat interval: 60 s (`PERF.REPAIR_DISPATCHER_HEARTBEAT_MS`).
- Retry: exponential backoff (10 s base, 10 min max), max 5 attempts, then dead-letter.
- Gated by `PERF.REPAIR_DISPATCHER_ENABLED` (default `false`).

### 4.5 Registered Queue Handlers

| Queue name | Handler | Workload class | Chunked? |
|---|---|---|---|
| `analyze_communication` | `handleAnalyzeCommunication` | (varies) | No |
| `zoom_transcript_backfill` | `handleZoomTranscriptBackfill` | `repair` | Yes — fans out batches of 20 |
| `front_rematch_all` | `handleFrontRematchAll` | `repair` | Yes — chunks of 500, self-enqueues continuation |
| `agent_decontamination` | `handleAgentDecontamination` | `repair` | No |
| `bulk_classify` | `handleBulkClassify` | `maintenance` | Yes — chunks of 500, self-enqueues continuation |
| `retroactive_reprocess` | `handleRetroactiveReprocess` | `repair` | No (per-client) |
| `front_sync_reprocess` | `handleFrontSyncReprocess` | `repair` | Yes — chunks of 500, self-enqueues continuation |

All handlers are dual-registered on both the scheduler (`registerHandler`) and the repair dispatcher (`registerRepairHandler`).

### 4.6 Worker Lock System

**File:** `server/services/workerLock.ts`

- In-memory `Map<string, LockEntry>` with 15 min TTL and 30 s heartbeat.
- Used by `front_sync`, `zoom_sync`, `local_dominance_sync`, `google_drive_sync`, `call_analysis_poll`.
- **Not durable** — all locks are lost on restart, enabling immediate re-execution.

### 4.7 Overlap Guard Patterns

All three integrations use the same **two-layer** top-level overlap prevention:

1. **In-memory boolean flag** (`frontSyncCycleRunning`, `zoomSyncRunning`, `isSyncing`)
2. **Worker lock** (`acquireLock(workerName)`)

Workload class slots (`awaitClassSlot`/`releaseClassSlot`) are **not** top-level entry guards for any integration. Instead, they are acquired **granularly per DB write** via `instrumentation.withSlot()` (Front, Semrush) or direct acquire/release calls around individual storage operations (Zoom). This means sync cycles begin without consuming a class slot — slots are acquired momentarily around individual database operations and released immediately after each write.

---

## 5. Feature Flags & Runtime Tunables

**File:** `server/perfConfig.ts`

### 5.1 Boolean Feature Flags

| Flag | Default | Purpose | Migration relevance |
|---|---|---|---|
| `REPAIR_QUEUE_ENABLED` | `false` | Gates whether repair jobs are enqueued to `work_queue` | Must be `true` for durable pipeline to handle repair work |
| `REPAIR_DISPATCHER_ENABLED` | `false` | Gates whether `repairDispatcher` starts and polls | Controls which component owns repair/maintenance classes |
| `INTERACTIVE_REPAIR_ENQUEUE_ENABLED` | `false` | Gates whether interactive repair jobs route through `work_queue` | Determines if UI-triggered repairs use durable delivery |
| `DB_POOL_STATS_LOG_ONLY_WHEN_ACTIVE` | `true` | Suppresses idle pool logging | Observability only |

### 5.2 Numeric Tunables Relevant to Pipeline Migration

| Tunable | Default | Purpose |
|---|---|---|
| `REPAIR_DISPATCHER_POLL_MS` | 5 000 | Dispatcher polling interval |
| `REPAIR_DISPATCHER_LEASE_MS` | 300 000 | Job lease duration (5 min) |
| `REPAIR_DISPATCHER_HEARTBEAT_MS` | 60 000 | Heartbeat interval (1 min) |
| `REPAIR_DISPATCHER_BASE_BACKOFF_MS` | 10 000 | Retry backoff base |
| `REPAIR_DISPATCHER_MAX_BACKOFF_MS` | 600 000 | Retry backoff ceiling (10 min) |
| `REPAIR_DISPATCHER_MAX_SKIP_CYCLES` | 3 | Fair-scheduling starvation threshold |
| `REPAIR_DISPATCHER_MAX_ATTEMPTS` | 5 | Max retries before dead-letter |
| `STARVATION_AGE_THRESHOLD_MS` | 600 000 | Age threshold for starvation warnings (10 min) |
| `SEMRUSH_POLL_INTERVAL_MS` | 8 000 | SEMrush API poll delay per keyword |
| `SEMRUSH_MAX_POLLS` | 45 | Max polls per keyword before timeout |
| `FRONT_HEALTH_CHECK_INTERVAL_MS` | 60 000 | Front sync health check interval |
| `FRONT_SPAM_CLEANUP_INTERVAL_MS` | 900 000 | Spam cleanup interval (15 min) |
| `FRONT_CLIENT_MATCHING_INTERVAL_MS` | 600 000 | Retroactive client matching interval (10 min) |
| `ZOOM_VALIDATION_FAILURE_LIMIT` | 3 | Max consecutive Zoom auth failures before backoff |
| `ZOOM_VALIDATION_BACKOFF_MS` | 1 800 000 | Zoom validation backoff (30 min) |

### 5.3 Hardcoded Constants (Not Runtime-Tunable)

| Constant | Value | File | Purpose |
|---|---|---|---|
| `SYNC_INTERVAL_MS` (Front) | 5 min | frontIntegration.ts:420 | Front polling interval |
| `SYNC_CYCLE_TIMEOUT_MS` | 10 min | frontIntegration.ts:24 | Per-cycle abort timeout |
| `CURSOR_PERSIST_INTERVAL` | 10 | frontIntegration.ts:996 | Conversations between incremental cursor saves |
| `ZOOM_SYNC_CRON_HOUR` | 2 (AM) | workerConfig.ts:8 | Zoom daily sync target hour |
| `ZOOM_RECORDING_LOOKBACK_HOURS` | 72 | workerConfig.ts:9 | Zoom recording scan window |
| `ZOOM_TRANSCRIPT_BACKFILL_HOURS` | 72 | workerConfig.ts:10 | Transcript backfill eligibility window |
| `SYNC_INTERVAL_MS` (Semrush) | 6 hours | localDominanceSyncWorker.ts:9 | Semrush polling interval |
| `WORKER_BATCH_SIZE` | 5 | workerConfig.ts:5 | Front sync per-batch conversation count |
| `WORKER_BATCH_YIELD_MS` | 250 | workerConfig.ts:6 | Yield delay between batches |
| `WORKER_DB_HEAVY_MAX_CONCURRENCY` | 3 | workerConfig.ts:4 | Legacy DB-heavy slot cap |
| `TOTAL_BUDGET` | 4 | workloadManager.ts:37 | Global workload class slot cap |
| `CHUNK_SIZE` | 500 | workQueueHandlers.ts:5 | Chunked handler batch size |
| `BACKFILL_BATCH_SIZE` | 20 | workQueueHandlers.ts:6 | Zoom backfill sub-batch size |
| `SLOT_MAX_WAIT_MS` | 30 000 | workloadManager.ts:159 | Slot acquisition timeout |

---

## 6. Cross-Cutting Migration Risk Areas

### 6.1 Dual-Write Window During Cutover

During a migration from timer-driven sync to a durable pipeline, there will be a window where both the old timer and the new pipeline could run concurrently.

| Integration | Risk level | Mitigating dedupe | Gap |
|---|---|---|---|
| **Front** | HIGH | `front_sync_emails.conversation_id` (unique) + `external_source_id` check | Cursor is a mutable timestamp — two writers could advance it inconsistently. Page token is stored globally and would conflict. |
| **Zoom** | MEDIUM | `external_source_id = zoom_meeting_<uuid>` | No cursor to conflict. Dedupe is robust for record creation. However, transcript backfill could double-process if both old and new paths scan the same `pending` records. |
| **Semrush** | LOW | Transaction-level SELECT-before-INSERT on `(campaignId, keywordName, locationId, day)` | Safe for snapshot dedupe — snapshot, points, and metrics are all transactional. Risk is limited to post-transaction derived enrichment (SoV, competitor analysis) which could run twice if both old and new pipelines complete the same snapshot import. |

### 6.2 Agent Memory Coupling

The `client_agent_memory` table is tightly coupled to Front sync:

- **Seeding:** `seedAllAgentMemories()` runs at Front sync startup and during decontamination.
- **Runtime updates:** Agent memory is updated on every manual match/correction via the UI.
- **Retroactive reprocess:** `retroactiveReprocess()` seeds agent memory for a client before re-evaluating its communications.

A durable pipeline must decide whether agent memory seeding is an **ingestion concern** (runs before first sync cycle) or a **maintenance concern** (runs independently). Currently it is both — which creates ordering dependencies.

### 6.3 Fire-and-Forget Patterns

These patterns currently lose work on restart and must be replaced with durable enqueue:

| Pattern | Location | Current behavior |
|---|---|---|
| Contact enrichment | frontIntegration.ts:1185 | `.catch()` logs error but drops the failure — enrichment is not retried |
| Analysis enqueue | zoomIntegration.ts (multiple sites) | `enqueueAnalysis(recordId)` — failures are logged (`console.error`) but the analysis job is not retried or persisted elsewhere |
| Transcript analysis | zoomIntegration.ts:1281 | Fire-and-forget `(async () => { ... })()` after backfill — errors logged but not retried |
| Agent memory seed on contact add | agents.ts routes | `setImmediate` — no persistence, lost on restart |

### 6.4 Operational Classifier as Ingest Gate

The operational classifier (`operationalClassifier.ts`) makes an AI call during Front sync to classify conversations as operational/non-operational. This is a **synchronous gate** in the ingest path:

- If the classifier is down, processing continues (error is caught and conversation proceeds as non-operational).
- If classification is wrong, `reprocessDismissedNonSpam()` can re-classify.
- In a durable pipeline, this should be a separate **apply step** that can be retried independently of the ingest step.

### 6.5 Multi-Table Mutation Atomicity

Several ingest paths write to multiple tables without wrapping all writes in a single transaction:

| Path | Tables written | Atomic? |
|---|---|---|
| Front sync (matched conv) | `front_sync_emails` → `raw_communication_records` → `front_sync_emails` (update) → `client_contacts` | **No** — each is a separate `dbWrite()` call |
| Zoom ingest (matched meeting) | `raw_communication_records` → `raw_communication_records` (transcriptStatus) → `communication_client_links` (primary) → `communication_client_links` (multi) → `command_panel_key_calls` | **No** — individual writes |
| Zoom transcript backfill | `raw_communication_records` (content update) → `raw_communication_records` (transcriptStatus) → touchpoint classification | **Partially** — content update and status are in same `dbWrite` but touchpoint classification is separate |
| Semrush heatmap import | `heatmap_snapshots` (in tx) → `heatmap_points` (in tx) → `heatmap_metrics` (in tx) → derived enrichment (outside tx) | **Mostly** — core data is transactional; derived metrics/SoV enrichment is not |

### 6.6 No Webhook Support

None of the three integrations currently use webhooks for real-time push:

| Integration | Current model | Webhook available? |
|---|---|---|
| Front | Polling (5 min interval) | Yes — Front supports webhook events for conversations |
| Zoom | Polling (daily + 72h lookback) | Yes — Zoom supports recording.completed webhooks |
| Semrush | Polling (6h interval) | No — SEMrush has no webhook/push API |

A durable pipeline migration could optionally add webhook support for Front and Zoom to reduce polling overhead and improve latency.

### 6.7 In-Memory State Lost on Restart

All concurrency control is in-memory. See `docs/worker-starvation-architecture-map.md` §5 for the full list. Key items for pipeline migration:

| State | Impact on restart |
|---|---|
| Worker locks | All released — sync cycles can start immediately, potentially overlapping with a not-yet-terminated prior instance |
| Workload class slots | Reset to 0 — no awareness of prior instance's active work |
| Sync running flags | Reset to `false` — overlap guard is lost |
| Reprocess cooldowns | Reset — could cause burst re-processing |
| Agent memory enriched cache | Reset — first sync cycle may run with stale/missing cache |

### 6.8 Cursor Stall / Infinite Loop Risks

| Integration | Scenario | Existing mitigation |
|---|---|---|
| **Front** | All conversations in a page are already processed or operationally dismissed → cursor doesn't advance | Force-advance cursor by +1 when `newConvsProcessed === 0 && (bulkSkipped > 0 \|\| operationallyDismissed > 0)` |
| **Front** | Exhausted page set → cursor advances by +60 s to skip past the current batch | `fetchResult.exhausted` flag triggers +60 s advance |
| **Front** | Auth failure or rate limit mid-cycle → cursor partially advanced | `haltCycle` flag breaks processing; cursor reflects only what was processed before halt |
| **Zoom** | No cursor — lookback window naturally moves forward | N/A |
| **Semrush** | No cursor — full re-poll each time | N/A |

---

## 7. Summary Matrix

### 7.1 Ingestion Comparison

| Dimension | Front | Zoom | Semrush |
|---|---|---|---|
| **Trigger** | 5-min `setInterval` | Daily chained `setTimeout` (2 AM) | 6-hour `setInterval` |
| **API model** | Polling (List Conversations) | Polling (List Recordings) | Polling (SEMrush Listing API) |
| **Cursor** | `front_sync_cursor` (Unix timestamp) + `front_sync_page_token` | None (72h lookback window) | None (full re-poll) |
| **Cursor storage** | `system_settings` table | N/A | N/A |
| **Primary dedupe** | `front_sync_emails.conversation_id` (unique) | `external_source_id = zoom_meeting_<uuid>` | `(campaignId, keyword, locationId, day)` in-tx SELECT |
| **Secondary dedupe** | `external_source_id` on `raw_communication_records` | N/A | N/A |
| **Batch size** | 150 conversations per API call, processed in batches of 5 | All recordings in 72h window | All keywords per campaign |
| **Cycle timeout** | 10 min (`SYNC_CYCLE_TIMEOUT_MS`) | None (runs to completion) | Dynamic (5–15 min based on campaign size) |
| **Overlap guard** | 2-layer top-level (flag + lock); class slot per-DB-write | 2-layer top-level (flag + lock); class slot per-DB-write | 2-layer top-level (flag + lock); class slot per-DB-write |
| **Workload class** | `ingestion` (max 2) | `ingestion` (max 2) | `ingestion` (max 2) |
| **Startup offset** | 10 s + jitter | 40 s + jitter | 100 s + jitter |

### 7.2 Apply Pipeline Steps (Per Integration)

**Front:**
1. Fetch conversations from API (cursor-driven)
2. Bulk-skip already-processed conversation IDs
3. Filter warmup spam (subject pattern match)
4. Classify as operational/non-operational (AI call)
5. Run legacy client matching (deterministic: email/domain)
6. Run agent matching engine (AI-powered, reads `client_agent_memory`)
7. Write `front_sync_emails` record
8. If matched: check for existing `raw_communication_records` by `external_source_id`
9. If no existing record: ingest conversation → create `raw_communication_records`
10. Link sync record to raw record
11. Enrich client contacts from participants
12. Persist cursor (every 10 records + at cycle end)

**Zoom:**
1. Fetch recordings via API (72h lookback)
2. Match participants to clients (email/domain + content analysis)
3. Check for existing `raw_communication_records` by `external_source_id`
4. If new: create `raw_communication_records`
5. Set `transcriptStatus` (pending or ready)
6. Create `communication_client_links` (primary + multi-client)
7. Auto-populate key call slots
8. If transcript available: enqueue `analyze_communication` job
9. (Backfill path) Poll for transcript availability on pending records
10. (Backfill path) Download transcript, update record, finalize touchpoint classification

**Semrush:**
1. List active client integrations
2. For each client: list location-campaign mappings
3. For each campaign: fetch keywords from SEMrush API
4. For each keyword: fetch heatmap data (with rate-limit backoff)
5. In transaction: check for existing snapshot by `(campaignId, keyword, locationId, day)`
6. If new (in same transaction): insert `heatmap_snapshots` + `heatmap_points` + `heatmap_metrics` + GeoJSON cache
7. Post-transaction: compute derived metrics, SoV, competitor analysis (non-transactional enrichment)
8. Update `client_semrush_integrations.syncStatus`

### 7.3 Migration Priority Assessment

| Integration | Priority | Rationale |
|---|---|---|
| **Front** | P0 — Highest | Most complex pipeline (12 steps), mutable cursor, AI dependencies in critical path, agent memory coupling, most frequent execution (every 5 min). Highest risk of data inconsistency during cutover. |
| **Zoom** | P1 — High | Simpler pipeline but no cursor (relies entirely on dedupe). Transcript backfill has fire-and-forget patterns. Daily execution reduces urgency. |
| **Semrush** | P2 — Medium | Simplest pipeline, robust in-transaction dedupe. 6-hour interval. Main risk is enrichment steps outside transaction. |

---

*Generated for Task #263 preparation. Last updated: 2026-04-13.*
