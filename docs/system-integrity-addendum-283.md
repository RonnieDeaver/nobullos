# System Integrity Addendum — Task #283

**Date**: April 14, 2026
**Scope**: Focused addendum review of four confidence gaps from the #282 system integrity review. Proof-oriented, not broad architecture re-audit.
**Prior review**: `docs/system-integrity-review-253-281.md`

---

## 1. Executive Verdict

**One new finding upgraded. Two new findings identified. No P0 issues. Two P2 repair tasks required.**

The #282 review's conclusions were largely correct, but three gaps were confirmed:

1. **Deploy overlap is a present-day concern, not future-only.** The `isRunning` guard and in-memory worker locks do NOT protect across deploy overlap. Two processes CAN briefly coexist during Replit deployments. However, the OCC guard on dequeue, dedupe keys on ingestion, and application-level duplicate checks prevent data corruption. The risk is limited to redundant work and log noise — not correctness. **Verdict: P2, not elevated.**

2. **`tryMarkSourceEventApplied()` has a latent correctness bug for Semrush refresh events.** This is NOT merely an O(N) performance concern as stated in #282. The function can prematurely mark a source event as `applied` when work results are still being created. This affects ONLY Semrush `report_refresh` events (variable work-result cardinality per event). Front and Zoom are not affected (1:1 event-to-result mapping). **Verdict: P2, new finding, repair task required.**

3. **`raw_communication_records.external_source_id` has no unique constraint.** The Zoom duplicate-safety check (`findRawCommunicationByExternalSourceId`) is application-level only, with no DB-level uniqueness enforcement as a safety net. Under deploy overlap, two processes could race past the SELECT check and both INSERT. **Verdict: P2, new finding, repair task recommended.**

4. **Front is genuinely no longer bottlenecked.** Confirmed by architecture (cursor-based discovery decoupled from processing via background job enqueue). The old inline processing path is fully disabled. No runtime evidence of backlog buildup.

5. **Zoom is genuinely reliable.** Triple-layer dedupe (source_event_log dedupe_key + work_queue dedupe_key + application-level findByExternalSourceId) prevents duplicates across webhook, reconciliation, and backfill paths.

6. **Scheduler fairness is working as designed.** Runtime logs confirm all 5 classes cycle on each 5-second interval with 1–3ms slot hold durations, no starvation warnings.

---

## 2. Questions Re-Evaluated

| # | Question from #282 | Prior Conclusion | Evidence Needed | Outcome |
|---|-------------------|-----------------|-----------------|---------|
| Q1 | Is deploy overlap truly future-only? | "Single-process production is immune due to `isRunning`" | Process shutdown behavior, startup order, coexistence window | **Partially overturned**: two processes CAN coexist, but data safety holds |
| Q2 | Is `tryMarkSourceEventApplied` only O(N)? | "Performance concern, not correctness" | Work-result cardinality analysis per source | **Overturned for Semrush**: variable cardinality creates premature-marking race |
| Q3 | Is Zoom duplicate-safe on legacy path? | "Application-level check is sufficient" | Schema constraints, race window analysis | **Weakened**: no unique constraint on `external_source_id`, race possible |
| Q4 | Is Front no longer bottlenecked? | "Pipeline split eliminated bottleneck" | Architecture + log evidence | **Confirmed** |
| Q5 | Is Zoom reliable or just quieter? | "Genuinely reliable — triple-layer dedupe" | Dedupe mechanism trace | **Confirmed** |
| Q6 | Is Semrush doing unnecessary work? | "Minor — full inventory fetch is acceptable" | Diff logic, refresh dedupe | **Confirmed** |
| Q7 | Is scheduler fair in practice? | "Starvation detection with promotion" | Runtime slot acquire/release patterns | **Confirmed** |

---

## 3. Findings

### Finding 1: Deploy Overlap Exposes In-Memory Guards (P2)

**File**: `server/index.ts` (no SIGTERM/SIGINT handlers), `server/services/workerLock.ts`, `server/services/workScheduler.ts`

**Why #282 was incomplete**: The review stated "single-process production is immune due to `isRunning` guard" without analyzing what happens during deployment. On Replit, deployments start the new process before the old one is fully terminated.

**Analysis**:
- **No graceful shutdown**: Lines 11–16 of `server/index.ts` only handle `uncaughtException` and `unhandledRejection` — no SIGTERM, SIGINT, or beforeExit handlers. The old process's scheduler timer, worker intervals, and heartbeat timers run until the OS kills it.
- **`isRunning` is process-local**: Each process has its own `isRunning = false` (line 23 of `workScheduler.ts`). Both processes poll independently.
- **Worker locks are in-memory**: `workerLock.ts` uses `const locks = new Map()` (line 11). The new process starts with an empty map and can acquire the same lock names as the old process.
- **`LEASE_OWNER` includes PID**: `scheduler-${process.pid}` (line 17 of `workScheduler.ts`) — different per process.

**What CAN happen during deploy overlap (10–30s window)**:
1. Both processes' schedulers poll `work_queue` — OCC guard (`WHERE status='pending'`) prevents double-leasing. Losing process gets null, no harm.
2. Background workers (front_sync, zoom_sync, etc.) could overlap — both processes acquire in-memory locks independently. But: stagger offsets (10–140s + 30s jitter) mean most workers haven't started on the new process before the old one dies.
3. Old process could be mid-job when killed — job stays in `leased`/`processing` with expired lease, recovered by new process after `MAX_LEASE_MS` (300s).
4. Redundant API calls possible if both processes run reconciliation.

**What CANNOT happen**:
- Duplicate job execution: OCC guard on dequeue prevents it.
- Duplicate source event ingestion for Front/Zoom: `dedupe_key` unique index on `source_event_log` with deterministic keys.
- Duplicate work queue entries: `dedupe_key` partial unique index.

**Caveat — Semrush timestamped dedupe keys**: Semrush refresh events use `Date.now()` in their dedupe keys (e.g., `semrush:refresh_result:${campaignId}:${reportDate}:${Date.now()}`). This means the same logical refresh can produce distinct dedupe keys if triggered by both processes during overlap. However, `importHeatmap`'s get-or-create pattern (Finding 6) prevents duplicate data writes even if duplicate events are ingested.

**Additional caveat — `raw_communication_records`**: `external_source_id` has no unique constraint (see Finding 3).

**Verdict**: REAL but LOW SEVERITY. Deploy overlap can cause redundant work and a 300s job recovery delay, but not data corruption under current dedupe architecture. The missing graceful shutdown deserves a hardening task but is not urgent.

**Severity**: P2 (unchanged from #282, but with better-understood risk profile).

---

### Finding 2: `tryMarkSourceEventApplied()` Premature Marking for Semrush (P2 — NEW)

**File**: `server/services/applyPipeline.ts:202–249`, `server/services/semrushInventorySync.ts:564–640`

**Why #282 was incomplete**: The review classified this as "O(N) performance concern." It is also a correctness concern for sources with variable work-result cardinality.

**Analysis**: `tryMarkSourceEventApplied()` (line 202) queries `work_result_log` for all completed results linked to the source event, then checks if all have terminal `apply_state` entries. It has **no knowledge of how many work results are expected**.

**Per-source cardinality**:

| Source | Work Results per Event | Created When | Risk |
|--------|----------------------|-------------|------|
| **Front** | Always 1 (`communication_result`) | During `normalizeFrontWebhookEvent`, before apply job | **None** — 1:1 mapping, result always exists before apply |
| **Zoom** | Always 1 (meeting or transcript) | During `handleZoomMeetingApply`/`handleZoomTranscriptApply` | **None** — result created within the apply handler itself |
| **Semrush refresh** | **Variable** (1 per active keyword) | Sequentially in `handleRefreshJob` loop (line 564–640) | **Real race** — apply job for keyword #1 can run before keyword #N's work result exists |

**Proof of the Semrush race**:
1. `handleRefreshJob` creates source event (line 528).
2. Loop: for each keyword, call `getHeatmapData()` (slow API call, line 575), insert `work_result_log` (line 612), enqueue `semrush_heatmap_apply` job (line 624).
3. The enqueued apply job for keyword #1 enters `work_queue`. The scheduler can pick it up on the next 5s cycle.
4. If the keyword loop takes >5s (likely with multiple API calls), the apply for keyword #1 runs while keywords #2–N haven't had their work results created yet.
5. `tryMarkSourceEventApplied` sees only the work results that exist SO FAR. If keyword #1's work result is the only one, and it has a terminal apply state → source event is marked `applied` prematurely.

**Impact**: Source event status is bookkeeping metadata. No downstream logic gates on this status. The heatmap data for all keywords still gets imported correctly. `handleRefreshJob` also overwrites the status to `ready_to_apply` at line 643–658 after the loop, so the premature `applied` gets corrected (though the status oscillates: `received → applied → ready_to_apply → applied`).

**Why this is still a bug**: The event tracking audit trail is corrupted (premature `applied` status), and the design is fragile — if any future logic gates on source event status, it would break silently.

**Severity**: P2 — correctness bug for event tracking, but no data loss or downstream impact.

---

### Finding 3: No Unique Constraint on `raw_communication_records.external_source_id` (P2 — NEW)

**File**: `shared/models/communications.ts:37,67`

**Why #282 was incomplete**: The review stated Zoom "deduplicates by `externalSourceId` before insert" but did not verify whether a DB-level unique constraint exists as a safety net.

**Evidence**:
- Line 37: `externalSourceId: text("external_source_id")` — no `.unique()`.
- Line 67: `externalSourceIdx: index("raw_comm_external_source_id_idx").on(table.externalSourceId)` — regular index, NOT unique.

**Consequence**: The duplicate check `findRawCommunicationByExternalSourceId` is a SELECT followed by a conditional INSERT. Under deploy overlap (Finding 1), two processes could:
1. Both SELECT and find no existing record.
2. Both INSERT, creating duplicate `raw_communication_records`.

**Practical likelihood**: Low. Requires deploy overlap to coincide with webhook + reconciliation processing the same meeting simultaneously. The dedupe keys on `source_event_log` and `work_queue` make this unlikely (the second process would be rejected at ingestion).

**Impact**: If it occurs, a duplicate communication record would appear in the CRM. Not data corruption per se, but data quality degradation.

**Severity**: P2 — defense-in-depth gap. Adding a unique partial index on `external_source_id WHERE external_source_id IS NOT NULL` would close this permanently.

---

### Finding 4: Front Pipeline — Confirmed No Longer Bottlenecked (DISPROVEN CONCERN)

**File**: `server/services/frontWebhookIngestion.ts`

**Why re-evaluated**: #282 concluded "pipeline split eliminated bottleneck" based on code-path reasoning alone.

**Evidence**:
1. **Architectural proof**: `handleFrontWebhook` (webhook receipt) → `ingestEvent` → enqueue `front_webhook_normalize` job. The webhook handler returns immediately after enqueueing. Cursor advancement in reconciliation is independent of processing.
2. **Legacy path disabled**: `FRONT_LEGACY_INLINE_PROCESSING_ENABLED = false`, `FRONT_LEGACY_DOUBLE_FETCH_ENABLED = false`. The old monolithic processing path is fully gated off.
3. **Background job pattern**: `FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED = true` — jobs are enqueued as backlog producers. Each stage (normalize, apply) runs as a separate work_queue job.
4. **Hydrate cache**: `front_hydrate_snapshots` table prevents redundant API calls for the same conversation version.

**Verdict**: DISPROVEN — no bottleneck remains. The cursor-first, job-second design means discovery always makes forward progress regardless of processing backlog.

---

### Finding 5: Zoom Legacy Path — Confirmed Duplicate-Safe (CONFIRMED)

**File**: `server/services/zoomIntegration.ts`

**Trace of duplicate-safety across all paths**:

| Scenario | Dedupe Mechanism | Evidence |
|----------|-----------------|---------|
| Webhook then reconciliation for same meeting | `ingestEvent` dedupe_key: `zoom:recording_completed:{meetingUuid}:{recordingId}` | Line 1347 (webhook), line 1482 (reconciliation) — second call returns `deduplicated: true` |
| Transcript webhook then backfill for same meeting | Backfill checks `transcriptStatus` — skips if `ready` or `failed` | Line 1120–1126 |
| Apply handler duplicate check | `findByExternalSourceId(zoom_meeting_${meetingUuid})` before INSERT | Line 1704 |
| Same object twice, unchanged | `ingestEvent` dedupe_key rejects second ingestion | Unique index on `source_event_log.dedupe_key` |
| Same object twice, changed transcript | Transcript apply checks `hadNoTranscript` before updating | Line 1994 |

**Gap**: No unique constraint on `external_source_id` (Finding 3) — but this is the last-resort safety net, and three prior layers must fail simultaneously.

**Verdict**: CONFIRMED safe. Triple-layer dedupe (source_event_log, work_queue, application-level) provides adequate protection. The missing unique constraint (Finding 3) is a defense-in-depth gap but not a functional risk.

---

### Finding 6: Semrush Legacy Path — Confirmed Safe and Minimal (CONFIRMED)

**File**: `server/services/semrushInventorySync.ts`, `server/services/heatmapService.ts`

**Trace of duplicate-safety**:

| Scenario | Safety Mechanism | Evidence |
|----------|-----------------|---------|
| Inventory sync sees unchanged campaign | `diffInventory` returns empty diff → no refresh enqueued | Line 254–259 |
| Report refresh job runs twice | `importHeatmap` checks for existing snapshot (campaignId + keywordName + locationId + reportDate) → returns existing if found | `heatmapService.ts:281–318` |
| Replay/retry of same campaign | Work queue dedupe_key: `semrush:refresh:{campaignId}:report:{date}` | Line 353 |
| Inventory diff false positive | Diff against restored `previousInventory` — only new dates and campaigns trigger refresh | Line 189 |

**Freshness safety**: `importHeatmap` uses "get-or-create" pattern — it does NOT overwrite existing data. Once a heatmap snapshot for a specific campaign/keyword/date exists, it is immutable. This prevents stale data from overwriting fresher data.

**Cost**: Full inventory API fetch on every 6-hour interval regardless of changes. Payload is small (campaign list), and the diff is computed locally. No unnecessary heatmap data fetches unless the diff detects new report dates.

**Verdict**: CONFIRMED safe. `importHeatmap`'s get-or-create pattern prevents duplicates and overwrites. The variable work-result cardinality issue (Finding 2) affects only source event status tracking, not data integrity.

---

### Finding 7: Scheduler Fairness — Confirmed Working (CONFIRMED)

**Runtime evidence from dev logs** (`/tmp/logs/Start_application_*.log`):

```
[WorkScheduler] Starting scheduler (poll every 5000ms, owned classes: interactive, ingestion, interactive_repair, repair, maintenance)
[Worker] slot_acquired worker=scheduler:interactive  {"workloadClass":"interactive"}
[Worker] slot_released worker=scheduler:interactive  {"slotHoldDurationMs":2}
[Worker] slot_acquired worker=scheduler:ingestion    {"workloadClass":"ingestion"}
[Worker] slot_released worker=scheduler:ingestion    {"slotHoldDurationMs":2}
[Worker] slot_acquired worker=scheduler:interactive_repair {"workloadClass":"interactive_repair"}
[Worker] slot_released worker=scheduler:interactive_repair {"slotHoldDurationMs":2}
[Worker] slot_acquired worker=scheduler:repair       {"workloadClass":"repair"}
[Worker] slot_released worker=scheduler:repair       {"slotHoldDurationMs":2}
[Worker] slot_acquired worker=scheduler:maintenance  {"workloadClass":"maintenance"}
[Worker] slot_released worker=scheduler:maintenance  {"slotHoldDurationMs":1}
```

Pattern repeats every 5 seconds. All 5 classes acquire and release slots in sequence. Slot hold durations are 1–3ms (empty queue, no jobs to process).

**Analysis**:
- All classes are serviced on every cycle — no starvation visible.
- No starvation warnings in logs.
- `RepairDispatcher` is disabled in dev (`REPAIR_DISPATCHER_ENABLED=false`), so the main scheduler owns all 5 classes.
- Budget validation confirms correct configuration: `interactive:1, ingestion:2, interactive_repair:1, repair:1, maintenance:1`, global cap `4`.

**Limitation**: This is dev-environment evidence (empty queue). Production under sustained load would be a stronger test. The fairness mechanism (starvation promotion after `MAX_SKIP_CYCLES=3`) is structurally sound — if a class is skipped 3 times, it gets promoted to the front of the processing order. However, structural soundness is not a substitute for runtime proof under contention.

**Verdict**: CONFIRMED STRUCTURALLY — fairness design is correct and functioning in idle conditions. Production validation under real contention should be done via `GET /api/integrations/work-queue/status` monitoring. No code change needed, but this remains a monitoring gap rather than a proven-safe conclusion.

---

## 4. Runtime Evidence

| Evidence | Source | Observation |
|----------|--------|-------------|
| Scheduler cycles every 5s, all classes serviced | Dev startup logs | 5-class cycle with 1–3ms slot holds, no skips |
| No starvation warnings | Dev startup logs | `starvation_warning` event absent from logs |
| No `stale_lease_recovered` events | Dev startup logs | No stale leases detected (clean environment) |
| Budget validation passes | Dev startup logs | `DB worker pool max: 7, global slot cap: 4, sum of class maxConcurrency: 6` |
| No SIGTERM/SIGINT handlers in server | `server/index.ts:11–16` | Only `uncaughtException` and `unhandledRejection` handlers |
| No duplicate Front processing in production logs | Deployment logs | No `duplicate` or `double` processing errors found |
| `pipeline_state` column missing (dev-only) | Dev startup logs | `OperationalClassifier` cleanup error — schema drift in dev, not related to pipeline |

**Production log limitation**: Deployment logs showed only `CallAnalysis` Whisper errors (recurring 404 from disabled API deployment) and occasional Front sync warnings. Scheduler-level structured logs are not surfaced in Replit's deployment log viewer (they use `console.log`, not `console.error`). Full scheduler observability in production requires the admin endpoints (`GET /api/integrations/work-queue/status`, `GET /api/integrations/front/pipeline-metrics`).

---

## 5. Required Repair Tasks

### Task R1: Fix `tryMarkSourceEventApplied()` Premature Marking for Variable-Cardinality Events (P2)

- **Title**: Prevent premature source event completion for multi-result events
- **Summary**: `tryMarkSourceEventApplied()` can mark a source event as `applied` before all expected work results exist, because it has no knowledge of expected result count. This affects Semrush refresh events, which create variable numbers of work results per event.
- **What & Why**: The function checks if all EXISTING completed work results have terminal apply states. If some work results haven't been created yet (still in the `handleRefreshJob` loop), the function sees a complete set and marks the event `applied` prematurely. While no data loss occurs (heatmap imports proceed correctly), the event audit trail is corrupted and the design is fragile.
- **Scope**: Two possible approaches:
  1. **Expected-count approach**: Add an `expected_result_count` column to `source_event_log`. Set it when the event is created (for fixed-cardinality sources like Front/Zoom, set to 1; for Semrush refresh, set after the keyword count is known). `tryMarkSourceEventApplied` checks `completed_count >= expected_count`.
  2. **Deferred-marking approach**: Don't call `tryMarkSourceEventApplied` from `runApply`. Instead, have the source handler (e.g., `handleRefreshJob`) explicitly mark the event after all work results are created and enqueued.
- **Non-goals**: Do not change the apply pipeline's idempotency logic. Do not change Front or Zoom flows (they are 1:1 and unaffected).
- **Acceptance criteria**: Semrush refresh events are only marked `applied` after ALL keyword work results have been applied. Event status never oscillates.
- **Files affected**: `server/services/applyPipeline.ts`, `server/services/semrushInventorySync.ts`, `shared/models/durablePipeline.ts` (if adding column)
- **Parallel**: Yes — independent of all other tasks.

### Task R2: Add Unique Partial Index on `raw_communication_records.external_source_id` (P2)

- **Title**: Add defense-in-depth unique constraint for communication record deduplication
- **Summary**: `external_source_id` has a regular (non-unique) index. Application-level duplicate checks can race under deploy overlap. A unique partial index would provide a DB-level safety net.
- **What & Why**: Under deploy overlap, two processes could SELECT `findRawCommunicationByExternalSourceId`, both find nothing, and both INSERT — creating a duplicate record. While upstream dedupe layers (source_event_log, work_queue) make this extremely unlikely, a unique constraint would make it impossible.
- **Scope**: Add `CREATE UNIQUE INDEX raw_comm_external_source_id_uniq ON raw_communication_records (external_source_id) WHERE external_source_id IS NOT NULL` via schema migration. Update insert callers to handle unique violation gracefully.
- **Non-goals**: Do not change the application-level dedupe logic. Do not modify the Front, Zoom, or Semrush write paths.
- **Acceptance criteria**: Unique partial index exists in production. Concurrent inserts with the same `external_source_id` result in one success and one conflict (handled gracefully).
- **Files affected**: `shared/models/communications.ts`, potentially `server/storage.ts` (insert error handling)
- **Parallel**: Yes — independent of all other tasks.

---

## 6. Safe to Leave As-Is

| Item | Reason |
|------|--------|
| **Deploy overlap without graceful shutdown** | OCC guards, dedupe keys, and lease recovery provide adequate safety for current single-process deployments. The overlap window (10–30s) is brief, and worker stagger offsets (10–140s) prevent most background worker overlap. **Recommended**: Add a SIGTERM handler that stops scheduler/dispatcher timers and drains active jobs. Not safety-critical but improves operational hygiene and reduces 300s recovery delays. |
| **`isRunning` only preventing in-process overlap** | The scheduler's OCC guard (`WHERE status='pending'` on UPDATE) is the real safety mechanism, not `isRunning`. Two processes dequeuing the same job results in one success and one null — no duplicate execution. |
| **In-memory worker locks not surviving restart** | Locks are used for background workers (sync intervals), all of which have idempotent operations. A second process acquiring the same lock causes redundant work, not data corruption. |
| **No DB-backed lease coordination** | `LEASE_OWNER = scheduler-${process.pid}` differentiates processes. Stale lease recovery (300s timeout + `recoverStaleLeases` on every cycle) handles abandoned leases after process death. |
| **Front hydrate cache correctness** | Cache is keyed by `version_key` — version changes create new cache entries. No stale data served for changed conversations. |
| **Semrush full inventory fetch on every interval** | Payload is small (campaign metadata), diff is local. No unnecessary heatmap data fetches. Acceptable cost. |
| **Scheduler fairness under load** | Structurally sound: starvation promotion after 3 skipped cycles, cooldown-limited warnings, per-class budgets with global cap. Dev logs confirm all classes serviced under empty-queue conditions. **Caveat**: Dev environment evidence (empty queue) is insufficient to prove fairness under sustained production load. Starvation promotion and per-class budgets are well-designed, but production monitoring via `GET /api/integrations/work-queue/status` should be used to validate fairness under real contention. No structural concern found — this is a monitoring gap, not a code gap. |

---

## 7. Evidence Appendix

### Deploy Overlap Evidence

| Claim | Evidence |
|-------|----------|
| No SIGTERM/SIGINT handlers | `server/index.ts:11–16` — only `uncaughtException` and `unhandledRejection` |
| `isRunning` is process-local | `workScheduler.ts:23` — `let isRunning = false` in module scope |
| Worker locks are in-memory | `workerLock.ts:11` — `const locks = new Map<string, LockEntry>()` |
| `LEASE_OWNER` includes PID | `workScheduler.ts:17` — `` `scheduler-${process.pid}` `` |
| OCC guard on dequeue | `workScheduler.ts:218–223` — `WHERE eq(workQueue.id, job.id), eq(workQueue.status, "pending")` |
| Stale lease recovery | `workScheduler.ts:347–386` — `recoverStaleLeases()` resets expired leases to `pending` |
| `MAX_LEASE_MS = 300_000` (5 min) | `workScheduler.ts:12` |
| Worker stagger offsets | `workerConfig.ts:15` — `WORKER_STAGGER_OFFSETS` (10–140s per worker) |
| Semrush timestamped dedupe keys | `semrushInventorySync.ts:527` — `semrush:refresh_result:${campaignId}:${selectedReportDate}:${Date.now()}` uses `Date.now()`, making keys non-deterministic |

### `tryMarkSourceEventApplied` Evidence

| Claim | Evidence |
|-------|----------|
| Function checks only EXISTING completed results | `applyPipeline.ts:203–211` — queries `workResultLog WHERE sourceEventId AND status='completed'` |
| No expected result count | No column or parameter for expected count in `source_event_log` schema or function signature |
| Semrush creates variable work results per event | `semrushInventorySync.ts:564–640` — loop creates 1 work result per active keyword |
| Work results created sequentially with slow API calls | `semrushInventorySync.ts:575` — `getHeatmapData()` is an external API call inside the loop |
| Apply jobs enqueued inside the loop | `semrushInventorySync.ts:624–630` — `enqueueJob` called per keyword after work result creation |
| Scheduler can pick up apply jobs during the loop | Scheduler polls every 5s (`POLL_INTERVAL_MS = 5_000`), loop can take >5s with multiple API calls |
| Status overwritten after loop | `semrushInventorySync.ts:643–658` — sets status to `ready_to_apply` regardless of current status |
| `tryMarkSourceEventApplied` has status guard | `applyPipeline.ts:246` — `WHERE status != 'applied'` prevents re-marking |
| Front is 1:1 | `frontWebhookIngestion.ts` — `normalizeFrontWebhookEvent` creates exactly 1 work result |
| Zoom is 1:1 | `zoomIntegration.ts` — each apply handler creates 1 work result per event |

### Zoom Dedupe Evidence

| Claim | Evidence |
|-------|----------|
| Source event dedupe_key format | `zoomIntegration.ts:1347` — `zoom:${eventType}:${meetingUuid}:${recordingId}` |
| Reconciliation uses same dedupe_key | `zoomIntegration.ts:1482` — same format, `ingestEvent` returns `deduplicated: true` |
| Application-level duplicate check | `zoomIntegration.ts:1704` — `findByExternalSourceId(zoom_meeting_${meetingUuid})` |
| Transcript backfill skip logic | `zoomIntegration.ts:1120–1126` — checks `transcriptStatus` and `contentText` |
| Transcript update idempotency | `zoomIntegration.ts:1994` — checks `hadNoTranscript` before updating |
| `external_source_id` NOT unique | `shared/models/communications.ts:37` — `text("external_source_id")` without `.unique()` |
| `external_source_id` has regular index | `shared/models/communications.ts:67` — `index(...)` not `uniqueIndex(...)` |

### Semrush Dedupe Evidence

| Claim | Evidence |
|-------|----------|
| `importHeatmap` get-or-create pattern | `heatmapService.ts:281–318` — checks existing snapshot before inserting |
| Work queue dedupe_key for refresh | `semrushInventorySync.ts:353` — `semrush:refresh:${campaignId}:report:${date}` |
| Inventory diff against stored snapshot | `semrushInventorySync.ts:189` — `diffInventory` compares against `previousInventory` |
| Worker lock prevents concurrent inventory sync | `semrushInventorySync.ts:686–689` — `acquireLock(WORKER_NAME)` |

### Scheduler Fairness Evidence

| Claim | Evidence |
|-------|----------|
| All 5 classes serviced every cycle | Dev logs — `slot_acquired`/`slot_released` for all classes per 5s interval |
| Slot hold durations 1–3ms | Dev logs — `slotHoldDurationMs: 1–3` on all releases |
| No starvation warnings | Dev logs — no `starvation_warning` events |
| Starvation promotion at 3 skips | `workScheduler.ts:34` — `MAX_SKIP_CYCLES = 3` |
| Budget validation correct | Dev logs — `DB worker pool max: 7, global slot cap: 4, sum of class maxConcurrency: 6` |
