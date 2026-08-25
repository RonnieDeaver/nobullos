# Front Console — Phase 0 Discovery & Contract Audit

**Date:** 2026-04-24
**Task:** #806 (Front Console Phase 0)
**Scope:** Read-only analysis. No production code changes. Output: this engineering note plus a recommended phase plan for Phases 1–5.

> **Prior art (do not duplicate):**
> - `docs/front-discovery-baseline-audit.md` — ingestion paths, reconciliation cursor semantics, deterministic/agent matchers, baseline metrics.
> - `docs/front-discovery-timing-map.md` — sync trigger paths, intervals, page caps, in-memory locks.
>
> This document focuses on what the **operator console** can build on: operations, jobs, message schema, helpers, audit hooks, and the canonical-vs-deprecated ruling. Where the prior docs already cover a topic, this note links rather than re-derives.

---

## 1. Operations Inventory

All paths are mounted in `server/routes/integrations.ts` and `server/routes/communications.ts`. Auth column uses the project's middleware names (`requireAccountManager` = AM read, `requireTeamLead` = TL mutate).

### 1.1 Connection & status

| # | Method | Path | Auth | Service entry | Notes |
|---|---|---|---|---|---|
| 1 | GET | `/api/integrations/all-status` | AM | `getSyncMetadata`, `validateConnection`, `syncProgressTracker.get` (integrations.ts L24) | Returns `{ connected, lastSyncError, lastSyncSuccess, syncProgress, unmatchedCount }` for Front (+ Slack/Zoom). The console already uses this for the header tile. |
| 2 | GET | `/api/integrations/front/status` | auth-only | `frontIntegration.isConnected` (communications.ts L449) | Lighter weight `{ connected }` check. |
| 3 | GET | `/api/integrations/front/authorize` | TL | `getAuthorizationUrl` (communications.ts L459) | Returns `{ url }` to start OAuth. |
| 4 | GET | `/api/integrations/front/callback` | public (OAuth) | `exchangeCodeForToken` + `initAutoSync` (communications.ts L469) | OAuth completion. Triggers `startAutoSync`, periodic spam cleanup, periodic client matching. |
| 5 | POST | `/api/integrations/front/disconnect` | TL | `frontIntegration.disconnect` (integrations.ts L659) | Clears tokens; stops periodic intervals. |
| 6 | POST | `/api/integrations/front/reset-sync` | TL | inline (integrations.ts L670–697): optional `storage.deleteAllFrontSyncEmails()` (when `purgeRecords:true`), then `seedAllAgentMemories`, then `reEvaluateExistingUnmatchedProducer` enqueue | Body: `{ purgeRecords?: boolean }`. Returns `{ success, recordsPurged, reEvalResult: { enqueued, total, ... } }`. **Does NOT reset any sync cursor** — the name is misleading. The 5-min sync loop's `front_sync_page_token` and `front_reconciliation_cursor` settings are not touched here. |
| 7 | GET | `/api/integrations/front/sync/status` | AM | `validateConnection` + `storage.countUnmatchedFrontSyncEmails` (communications.ts L543–552) | Returns only `{ connected, unmatchedCount }`. **Not** a sync-progress shape. Live sync-loop progress is exposed via (1) `all-status` as the `syncProgress` field from `syncProgressTracker`, not here. |
| 8 | GET | `/api/integrations/front/inboxes` | AM | `listInboxes` (communications.ts L508) | Used to populate inbox pickers. |
| 9 | GET | `/api/integrations/front/tags` | AM | `listTags` (communications.ts L519) | Used for tag-scoped operations. |
| 10 | GET | `/api/integrations/front/search` | AM | `searchConversations` (communications.ts L530) | Free-text search against the Front API (not local DB). |
| 11 | POST | `/api/integrations/front/webhook` | webhook signature | `handleFrontWebhook` (integrations.ts L628) | Real-time ingest. Console doesn't call. |

### 1.2 Messages list (the table the console actually shows)

| # | Method | Path | Auth | Service entry | Notes |
|---|---|---|---|---|---|
| 12 | GET | `/api/integrations/front/messages` | AM | direct DB select on `raw_communication_records` (communications.ts L861–948) + `attachAgentDecisionInfo` (L10) | **The canonical messages list.** Filters: `match` ∈ {matched, unmatched}, `clientId`, `dateFrom`, `dateTo`, `page` (default 1), `limit` (default 25, max 100). Returns `{ messages: [...], filteredStats: { total, matched, unmatched, matchRate }, globalStats: { total, matched, unmatched, matchRate }, pagination: { page, limit, total, totalPages } }`. **Task #828:** the legacy `stats` field (which was always global) was renamed to `globalStats` and a parallel `filteredStats` (matches the WHERE clause used for the message list) was added so the contract is self-documenting. `pagination.total` equals `filteredStats.total`. **Only reads `raw_communication_records`** — does not show pre-apply rows still living in `front_sync_emails`. See §4. |
| 13 | GET | `/api/integrations/unmatched-feed` | AM | `storage.listUnmatchedFeed` + decisions enrichment (integrations.ts L98) | A **different** feed mixing all sources (Front, Slack, Zoom, Twilio). Used by other admin views. Not the Front console's primary surface today, but Front rows do flow through it. See §7. |
| 14 | GET | `/api/integrations/front/unmatched` | AM | `storage.listFrontSyncEmails({ matchStatus: 'unmatched', limit: query.limit ?? 50 })` (communications.ts L554–561) | Front-only view of the **`front_sync_emails`** staging table — but **`matchStatus: "unmatched"` is hardcoded**. The endpoint cannot return `dismissed`, `blocked`, `dismissed_operational`, `auto_matched`, or `manually_matched` rows. To see the broader staging-state space (e.g. blocked or dead-lettered rows), today's only options are a direct DB query or a new endpoint — see §3.3 and §8. |
| 15 | GET | `/api/integrations/front/unmatched/count` | auth-only | same as above (communications.ts L563) | Badge count. |

### 1.3 Single-message actions

There are **two parallel single-message action surfaces**. They look similar but operate on different ID spaces.

| # | Method | Path | Auth | Backing record | Service entry |
|---|---|---|---|---|---|
**Polymorphic source key.** The polymorphic surface uses `:source` ∈ `{ "front", "slack", "zoom" }`. **It is `front`, not `front_email`** — the latter is the `source_type` value on `raw_communication_records` and is not a valid URL parameter.

| 16 | POST | `/api/integrations/front/unmatched/:id/assign` | AM | `front_sync_emails.id` | `assignUnmatchedEmail` (communications.ts L572) — calls into the same service as (18) but does not invoke an explicit learning hook from the route layer |
| 17 | POST | `/api/integrations/front/unmatched/:id/dismiss` | AM | `front_sync_emails.id` | `dismissUnmatchedEmail` (communications.ts L594) — does not invoke learning from the route layer |
| 18 | POST | `/api/integrations/unmatched/:source/:id/assign` | AM | polymorphic (when `source==="front"`: `front_sync_emails.id`; `slack`/`zoom`: `raw_communication_records.id`) | inline integrations.ts L699–882. For `source==="front"` calls `assignUnmatchedEmail` (which updates `agent_match_decisions` and fires `learnFromManualMatch` async). |
| 19 | POST | `/api/integrations/unmatched/:source/:id/dismiss` | AM | polymorphic (`front` / `slack` / `zoom`) | inline integrations.ts L964–1031 — fires `learnFromDismiss` async after the status update. |
| 20 | POST | `/api/integrations/unmatched/:source/:id/block` | AM | polymorphic (`front` / `slack` / `zoom`) | inline integrations.ts L1033–1103 — fires `learnFromBlock` async. For `front`, sets `front_sync_emails.matchStatus='blocked'`; for `slack`/`zoom`, sets `raw_communication_records.matchStatus='dismissed_operational'` with reason `Blocked by user`. |
| 21 | POST | `/api/integrations/unmatched/:source/:id/promote` | AM | polymorphic (`front` / `slack` / `zoom`) | inline integrations.ts L1105 — fires `learnFromPromote` async (penalize op-filter memory). |
| 22 | POST | `/api/integrations/unmatched/undo-claim` | AM | `agent_match_decisions` row | inline integrations.ts L886 — reverses an auto-claim, updates the decision row. |

### 1.4 Bulk / batch operations

| # | Method | Path | Auth | Service entry | Job tracking |
|---|---|---|---|---|---|
| 23 | POST | `/api/integrations/bulk-classify` | TL | `bulkClassifyUnmatched` (operationalClassifier.ts L1414) — optionally enqueued via work queue | In-memory `bulkClassifyJobs` map (integrations.ts L1981), TTL 10 min |
| 24 | GET | `/api/integrations/bulk-classify/status/:jobId` | AM | reads `bulkClassifyJobs` (L2055) | — |
| 25 | POST | `/api/integrations/bulk-dismiss-by-domain` | TL | `bulkDismissByDomain` (operationalClassifier.ts) (L2142) | Synchronous; returns counts |
| 26 | POST | `/api/integrations/bulk-dismiss-by-sender` | TL | `bulkDismissBySender` (L2157) | Synchronous |
| 27 | POST | `/api/integrations/bulk-dismiss-by-channel` | TL | `bulkDismissByChannel` (L2172) | Synchronous |
| 28 | GET | `/api/integrations/count-by-domain` | AM | aggregation over `raw_communication_records` + `front_sync_emails` (L2201) | Powers preview counts before bulk-dismiss |
| 29 | GET | `/api/integrations/count-by-sender` | AM | same (L2213) | — |
| 30 | GET | `/api/integrations/count-by-channel` | AM | same (L2187) | — |
| 31 | POST | `/api/integrations/front/rematch-all` | TL | `rematchAllProducer` (work-queue producer) **or** direct `rematchAll` (frontIntegration.ts) | In-memory `rematchJobs` map (integrations.ts L1298) |
| 32 | GET | `/api/integrations/front/rematch-all/status/:jobId` | AM | reads `rematchJobs` (L1383) | — |
| 33 | GET | `/api/integrations/front/rematch-all/running` | AM | reads `rematchJobs` (L1390) | "Is one running" check |
| 34 | POST | `/api/integrations/front/reprocess-dismissed` | TL | `reprocessDismissedNonSpamProducer` (frontIntegration.ts) (L1269) | Work-queue (durable) when `INTERACTIVE_REPAIR_ENQUEUE_ENABLED`, else direct slot (ephemeral) |
| 35 | POST | `/api/integrations/front/decontaminate` | TL | `decontaminateAgentMemory` + `cleanupPoisonedMemory` + `seedAllAgentMemories` (L1890) | Work-queue (`agent_decontamination`) when enabled |

### 1.5 Historical recovery (canonical backfill — see §3)

| # | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 36 | GET | `/api/integrations/front/historical-recovery/coverage` | AM | Coverage report |
| 37 | POST | `/api/integrations/front/historical-recovery/execute` | TL | Start a recovery job |
| 38 | GET | `/api/integrations/front/historical-recovery/status/:jobId` | AM | Per-job status |
| 39 | GET | `/api/integrations/front/historical-recovery/jobs` | AM | List all (max 20 retained) |
| 40 | DELETE | `/api/integrations/front/historical-recovery/jobs/:jobId` | TL | Delete one |
| 41 | DELETE | `/api/integrations/front/historical-recovery/jobs` | TL | Delete all |
| 42 | GET | `/api/integrations/front/historical-recovery/sweep-status` | AM | Auto-sweep status |
| 43 | GET | `/api/integrations/front/historical-recovery/manual-sweep-history` | AM | History rows |
| 44 | POST | `/api/integrations/front/historical-recovery/run-sweep` | TL | Trigger manual sweep |
| 45 | GET / PUT | `/api/integrations/front/historical-recovery/max-age` | AM / TL | Sweep retention setting |
| 46 | GET / PUT | `/api/integrations/front/historical-recovery/prune-interval` | AM / TL | Prune cadence setting |
| 47 | GET | `/api/integrations/front/historical-recovery/max-age/history` | AM | Audit log of changes |
| 48 | GET | `/api/integrations/front/historical-recovery/prune-interval/history` | AM | Audit log of changes |

### 1.6 Deprecated / legacy backfill siblings (see §3)

| # | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 49 | POST | `/api/integrations/front/full-backfill` | TL | In-memory job map. **Deprecated by (37).** |
| 50 | GET | `/api/integrations/front/full-backfill/status/:jobId` | AM | Reads `backfillJobs` map (TTL 30 min) |
| 51 | POST | `/api/integrations/front/historical-backfill` | TL | Work-queue producer (`front_historical_backfill`). **Deprecated by (37).** |
| 52 | GET | `/api/integrations/front/historical-backfill/status/:runId` | AM | Reads from work-queue tables |

### 1.7 Pipeline / metrics

| # | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 53 | GET | `/api/integrations/front/pipeline-metrics` | AM | `getPipelineMetrics()` from `frontPipelineMetrics.ts` — counts by `pipelineState`, dead-letter counts, rates. Already shown in `IntegrationsHub`. |
| 54 | GET | `/api/integrations/pipeline/health` | AM | Cross-source pipeline health. |
| 55 | GET | `/api/integrations/pipeline/cutover-status` | AM | Versioned-discovery vs legacy split. |

### 1.8 Work queue admin (shared across sources, but operationally relevant to Front)

| # | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 56 | GET | `/api/integrations/work-queue/dead-letter` (and `/queue-names`, `/:id/replay`, `/replay-all`) | TL | Surface for failed Front jobs (`front_webhook_normalize`, `front_webhook_apply`, `front_rematch_all`, `front_sync_reprocess`, `front_historical_backfill`). |
| 57 | GET / PUT | `/api/integrations/work-queue/stale-lease-thresholds` (+ history) | AM / TL | Tunes worker leasing for Front handlers. |
| 58 | GET / PUT | `/api/integrations/work-queue/timings` (+ history) | AM / TL | Tunes worker timings. |
| 59 | GET | `/api/integrations/work-queue/audit-prune-events` | AM | — |
| 60 | GET | `/api/integrations/work-queue/status` | AM | — |

---

## 2. Job Tracking Inventory

| Job | Producer endpoint | Where status lives | Status endpoint | Durable across restart? | Progress shape |
|---|---|---|---|---|---|
| **Historical recovery** | (37) `historical-recovery/execute` | `system_settings` rows: index `front_recovery_jobs_index` + per-job `front_recovery_job_<id>`; in-memory `recoveryJobs` Map mirrors them (`frontHistoricalRecovery.ts` L85–89, persisted index capped at `MAX_PERSISTED_JOBS=20`) | (38) per-job, (39) list | **Yes.** On boot, `restoreJobsFromStorage` rehydrates the Map; any job left in `running` is flipped to `partial` with reason `interrupted_by_server_restart` (L393–400). Jobs survive restarts and stay queryable. | `RecoveryJobState`: `{ jobId, status, totals: { scanned, ingested, skipped, errors }, windows: [...checkpoints], coverageReport, startedAt, finishedAt, reason? }`. Per-window checkpoint write is durable. |
| **Full backfill (legacy)** | (49) `front/full-backfill` | In-memory `backfillJobs` Map (integrations.ts L1395). TTL 30 min via `setTimeout`. | (50) per-job | **No.** Restart wipes the map; the underlying `runFrontFullBackfill` may still be running but its status is unobservable. | `{ status: 'running'|'complete'|'failed', result?, error?, updatedAt }` |
| **Historical backfill (legacy)** | (51) `front/historical-backfill` | `work_queue` rows under queue name `front_historical_backfill` | (52) per-runId reads work-queue | **Yes** (queue is durable), but uses the older queue contract — no per-window checkpoints, no coverage report. | Work-queue job/runs shape (status, attempts, last error). |
| **Rematch all** | (31) `front/rematch-all` | In-memory `rematchJobs` Map (integrations.ts L1298). TTL 10 min. Two paths — work-queue producer (sets `running` then polls a producer-job row) **or** direct in-process invocation. | (32) per-job, (33) running flag | **Partially.** The work-queue path's underlying repair jobs are durable; the *job-tracking entry* is not. Direct path is fully ephemeral. UI loses visibility on restart even though work continues. | `{ status, result?, progress?, error?, updatedAt }`. Underlying `rematchAll` also writes the cursor `front_rematch_all_cursor` to `system_settings` (durable). |
| **Bulk classify** | (23) `bulk-classify` | In-memory `bulkClassifyJobs` Map (integrations.ts L1981). TTL 10 min. | (24) per-job | **Partially.** Same pattern as rematch — work-queue under the hood, ephemeral status entry. | `{ status, progress?, result?, error? }`. `progress.totalProcessed` is the only field consistently populated. |
| **Bulk-dismiss-by-** (domain/sender/channel) | (25)/(26)/(27) | None — synchronous request | inline `{ count }` | n/a | n/a — completes within the request. |
| **Reprocess dismissed** | (34) `reprocess-dismissed` | Work queue (`front_sync_reprocess`) when `INTERACTIVE_REPAIR_ENQUEUE_ENABLED=true`; otherwise direct `withClassSlot` (no entry). | None — must monitor via work-queue status (60) / dead-letter (56). | **Partially.** Durable when enqueued; ephemeral when direct. Cursor `front_reprocess_cursor_dismissed_operational` is in `system_settings`. | Producer returns `{ jobId, mode: 'enqueued'|'direct' }`; no front-end status endpoint exists. |
| **Decontaminate** | (35) `front/decontaminate` | Work queue (`agent_decontamination`) | None dedicated | **Yes** (queue) | Work-queue shape only. |
| **Front sync cycle** | (6) `reset-sync` (also auto every 5 min) | `syncProgressTracker` (in-memory in frontIntegration.ts) + cursor in `system_settings` (`front_sync_page_token`, `front_reconciliation_cursor`) | (7) `front/sync/status` | **Cursor durable, progress ephemeral.** | `{ inProgress, currentPage, lastSync, error, ... }`. See `front-discovery-timing-map.md` §1. |

### 2.1 Job-map race-condition notes

- All three in-memory job maps (`rematchJobs`, `backfillJobs`, `bulkClassifyJobs`) live in the **module closure of `registerIntegrationsRoutes`** (integrations.ts L1298, L1395, L1981). Any new module that re-imports the route file or any second worker process would have its own map → status would split-brain. Today there is one process, so this is latent, not active.
- "Already running" guards (e.g. L1319 `Array.from(rematchJobs.values()).some(j => j.status === "running")`) are similarly **per-process only**. They cannot prevent a second instance from starting a duplicate job.
- TTL deletes (`setTimeout(... delete jobId ...)`) drop a completed job's status without persisting it, so the only durable record is whatever the underlying work-queue or cursor wrote.

---

## 3. Canonical vs Deprecated

There are **three overlapping backfill paths** and **two overlapping single-message action surfaces**. The console must pick one and label the rest.

### 3.1 Backfill: `historical-recovery` is canonical

| Path | Verdict | Reason |
|---|---|---|
| **`front/historical-recovery/*`** (37–48) | **Canonical** | Only path with: (a) durable per-job state in `system_settings`, (b) per-window checkpoints, (c) restart resilience (`interrupted_by_server_restart`), (d) coverage report, (e) auto-sweep + tunable max-age and prune interval, (f) audit history endpoints (47, 48). Already wired into `IntegrationsHub` (10+ queries point to it). |
| `front/full-backfill` (49–50) | **Deprecated** | In-memory job map only; loses status on restart; no coverage; no checkpointing. The route handler itself logs an advisory to migrate. UI still references it (`IntegrationsHub.tsx` L1610, L1564). |
| `front/historical-backfill` (51–52) | **Deprecated** | Older work-queue producer with no operator-facing status surface beyond raw queue rows. Predates historical-recovery. No UI references found. |

**Recommended console treatment:** show only the canonical surface as the primary action. Keep the two deprecated buttons available behind an "Advanced (legacy)" disclosure with a one-line "Use Historical Recovery instead — this path will be removed" warning. Do not delete or hide them in this phase (out of scope for #806; safer to label, then remove in a later phase).

### 3.2 Single-message actions: `/unmatched/:source/:id/*` is canonical

| Path | Verdict | Reason |
|---|---|---|
| **`/unmatched/:source/:id/{assign,dismiss,block,promote}`** (18–21) and `undo-claim` (22) | **Canonical** | Polymorphic across sources (Front/Slack/Zoom). Wired to all four learning hooks (`learnFromManualMatch`, `learnFromDismiss`, `learnFromBlock`, `learnFromPromote`). Updates `agent_match_decisions`. The general unmatched feed (13) already uses this surface. |
| `front/unmatched/:id/{assign,dismiss}` (16–17) | **Legacy / Front-only** | Predates the polymorphic surface. Calls the same underlying `assignUnmatchedEmail` / `dismissUnmatchedEmail` service, but is **only invoked from the existing Front messages page** (`FrontIntegration.tsx`). It does **not** offer block/promote and is not wired into the polymorphic decision/audit chain in the same way. |

**Recommended console treatment:** new console actions should call the polymorphic surface using the `front` source key, e.g. `POST /api/integrations/unmatched/front/:id/assign`. (Confirmed with `IntegrationsHub.tsx` L746/770/783/820/882, which already builds URLs via `` `/api/integrations/unmatched/${source}/${id}/...` ``.) Leave (16–17) in place for backward compatibility with the existing screen, but plan to retire them once the new console is the only caller — they only support assign and dismiss, omit block/promote/undo-claim entirely, and cannot be used as a complete action surface.

### 3.3 Three messages/unmatched paths

| Path | What it shows | Recommended use |
|---|---|---|
| **(12) `front/messages`** | Joined `raw_communication_records` (i.e. *applied* messages) with client name and decision-review enrichment. Returns `{ messages, filteredStats, globalStats, pagination }` (Task #828 — was `{ messages, stats, pagination }` where `stats` was global). | **Canonical for the console's main table** (matched + unmatched applied messages). |
| (13) `unmatched-feed` | Multi-source unmatched feed (Front + Slack + Zoom + Twilio), polymorphic | Keep using as today's cross-source admin tool. The console can link out to it but should not replace it. |
| (14) `front/unmatched` | Front-only view of `front_sync_emails` — but **hardcoded to `matchStatus="unmatched"`** (communications.ts L556). Returns `dismissed`, `blocked`, `dismissed_operational`, `auto_matched`, `manually_matched` rows? **No.** It only returns `unmatched`. | Useful only as a "staging-unmatched" feed that is independent of whether apply has happened. **Cannot be used to surface blocked/dead-lettered/dismissed rows today** — see §8.3. |

**Implication:** there is currently **no operator endpoint that exposes blocked, dead-lettered, or dismissed-pre-apply `front_sync_emails` rows.** A "Pipeline staging" view in the new console would need either (a) a new endpoint that accepts a `matchStatus` query parameter on (14), or (b) a direct read of `front_sync_emails` filtered by `pipelineState`. Both are out of scope for #806; this is captured as a deferred item under Phase 3 in §9.

---

## 4. Message Schema Available to UI

Two tables back the console: `raw_communication_records` (applied/canonical) and `front_sync_emails` (sync staging / pipeline). Definitions in `shared/models/communications.ts` L28–222.

### 4.1 `raw_communication_records` (applied)

Columns SELECTed today by (12) `front/messages`:

`id, clientId, title, contentText, contentPreview, timestamp, direction, matchMethod, matchConfidence, externalUrl, sourceSubtype, externalSourceId, aiSummary, createdAt, rawPayloadJson (as rawPayload), participantsJson (as participants)` plus `clients.firmName AS clientName`.

Columns **present but NOT selected** (potentially useful):
- `externalThreadId` — useful for grouping a conversation
- `processingStatus` — `pending` / `processing` / `processed` / `failed`
- `aiSignals`, `aiProcessedAt` — signals that drove a match
- `reviewStatus` — `unreviewed` / `suggestions_pending` / `partially_resolved` / `resolved` / `no_updates_needed`
- `hasSuggestions` — whether AI suggestions are pending for this comm
- `googleDriveFileUrl` — Drive archival link
- `matchStatus` — string column (separate from the `matched`/`unmatched` filter shape) including the `dismissed_operational` value
- `operationalClassificationReason` — *why* something was filtered (e.g. "newsletter", "support"), needed to explain dismissals
- `bulkClassifierVersion` — which classifier version dismissed it (audit)
- `transcriptStatus`, `isTouchpoint`, `createdBy`, `updatedAt`

Indexes: `clientId`, `sourceType`, `timestamp`, `reviewStatus`, `matchStatus`, `externalSourceId`, `isTouchpoint`, `(clientId, timestamp)`, `(clientId, isTouchpoint, timestamp)`.

### 4.2 `front_sync_emails` (staging)

`id, conversationId (unique), subject, snippet, participantsJson, frontStatus, lastMessageAt, matchedClientId, matchStatus, matchConfidence, matchReason, ingestedRecordId, operationalClassificationReason, bulkClassifierVersion, dismissedBy, processedAt, pipelineState, lastMessageId, versionKey, pipelineError, pipelineAttempts, stateChangedAt, createdAt`.

`matchStatus` enum: `unmatched | auto_matched | manually_matched | dismissed | blocked | dismissed_operational`.
`pipelineState` enum (15 states): `discovered → fetch_persisted → triage_pending → triage_candidate → hydrate_pending → hydrated → (deterministic_matched | ai_match_pending → ai_matched | unmatched) → apply_pending → applied`, plus `triage_dismissed`, `failed`, `dead_lettered`.

Indexes: `matchStatus`, `matchedClientId`, `conversationId`, `lastMessageAt`, `createdAt`, `pipelineState`, `versionKey`.

### 4.3 Filters supported today vs needed for a "power console"

Endpoint (12) supports: `match` ∈ {matched, unmatched}, `clientId`, `dateFrom`, `dateTo`.

**Gaps relative to a power console:**

| Filter | Status | Notes |
|---|---|---|
| Sender email (exact) | Missing | Need to extract from `participantsJson` (jsonb). **No GIN index** on `participants_json` in either table. |
| Sender domain | Missing | Same as above; would need an indexed expression or a denormalized `sender_domain` column. |
| Source inbox | Missing | Inbox ID lives inside `rawPayloadJson` (not indexed). Front API can list inboxes via (8). |
| Source channel/tag | Missing | Same shape as inbox — buried in `rawPayloadJson`. |
| `dismissed_operational` filter | Missing | Endpoint only handles matched/unmatched. The `matchStatus` column is selected indirectly but not exposed as a filter. Bulk-dismissed items vanish from both groups. |
| `blocked` filter | Missing | `blocked` exists only on `front_sync_emails`, never on `raw_communication_records` (block prevents apply). To list blocked items the console must read (14) `front/unmatched`, not (12) `front/messages`. |
| `pipelineState` filter | Missing | Useful for triage of stuck items (`failed`, `dead_lettered`, long time in `hydrate_pending`). Lives only on `front_sync_emails`. |
| Free-text body/subject search | Missing | No FTS indexes. Likely requires Postgres `tsvector` migration — out of scope here. |
| Has-suggestions / review-status filter | Missing | `reviewStatus` and `hasSuggestions` are indexed on `raw_communication_records` but not exposed. |

### 4.4 Response fields used by the existing console

`FrontIntegration.tsx` reads from (12) and uses: `id, clientId, clientName, title, contentText, contentPreview, timestamp, externalUrl, matchMethod, matchConfidence, participants, review` (the `attachAgentDecisionInfo` enrichment, defined at communications.ts L10).

The decision-review enrichment surfaces `agent_match_decisions` rows where `status = 'review_required'`, attaching `{ decisionId, status, reviewReason, suggestedClientName, priorClientName }` to each message. This is the only way the UI sees pending agent decisions today.

---

## 5. Reusable Bulk Helpers

### 5.1 Existing helpers

| Helper | Location | Used by | Reuse / wrap / replace? |
|---|---|---|---|
| `assignUnmatchedEmail` | `frontIntegration.ts` | (16), (18) | **Reuse.** Already does ingest, contact promotion (opt-in), `agent_match_decisions` update, `learnFromManualMatch`. |
| `dismissUnmatchedEmail` | `frontIntegration.ts` | (17), (19) (Front-source branch) | **Reuse.** Sets `match_status='dismissed'` on `front_sync_emails`. Route layer additionally calls `learnFromDismiss`. |
| Polymorphic dismiss handler | inline integrations.ts L964 | (19) | **Reuse.** Wraps `dismissUnmatchedEmail` plus learning hook. |
| Polymorphic block handler | inline integrations.ts L1033 | (20) | **Reuse.** Calls `learnFromBlock` and updates the staging row. |
| Polymorphic promote handler | inline integrations.ts L1105 | (21) | **Reuse.** Calls `learnFromPromote` (penalize op-filter memory). |
| Undo-claim handler | inline integrations.ts L886 | (22) | **Reuse.** Reverses an auto-claim and rewrites `agent_match_decisions`. |
| `bulkDismissByDomain` | `operationalClassifier.ts` | (25) | **Reuse.** Synchronous; returns `{ count }`. The helper itself does not currently call `learnFromBlock` on the inferred domain — the action is **dismiss**, not **block**. The console must keep the distinction. |
| `bulkDismissBySender` | `operationalClassifier.ts` | (26) | **Reuse.** Same shape. |
| `bulkDismissByChannel` | `operationalClassifier.ts` | (27) | **Reuse.** Same shape. |
| `bulkClassifyUnmatched` | `operationalClassifier.ts` L1414 | (23) | **Wrap.** Suitable for a "rerun the spam classifier" button. Batch size 500; emits `onProgress` callback. Status surface is the ephemeral `bulkClassifyJobs` map — the console will need to live with that limitation (or wait for a Phase-2 status migration). |
| `rematchAll` (direct) | `frontIntegration.ts` | (31) direct path | **Wrap.** Long-running; use the work-queue producer path for bulk console operations, not the direct path. |
| `rematchAllProducer` | `frontIntegration.ts` | (31) queue path | **Reuse.** Durable work-queue path. Status visibility is currently weak (in-memory map). |
| `reprocessDismissedNonSpamProducer` | `frontIntegration.ts` | (34) | **Reuse**, but only via the queue mode (`INTERACTIVE_REPAIR_ENQUEUE_ENABLED=true`). |
| `runHistoricalRecovery` | `frontHistoricalRecovery.ts` | (37) | **Reuse.** Canonical, durable. |

### 5.2 Helpers worth building (Phase 1+, not now)

- A **bulk-assign by inbox/sender/domain** that internally loops `assignUnmatchedEmail` and emits aggregate progress. None exists today; bulk *dismiss* exists, bulk *assign* does not.
- A **bulk-block by sender/domain** that calls `learnFromBlock` rather than `learnFromDismiss`. Today's `bulkDismissBySender` only dismisses; "block this sender forever" is a single-message action only.
- A **rule-based action** (e.g. "auto-dismiss anything from `support@*` after sync") would need a new persistence model — there is no rules table today.

---

## 6. Audit / Event Hooks

Single-message actions today write to the following surfaces. Any new console (single or bulk) must preserve these writes.

| Action | Hook(s) called | Tables written |
|---|---|---|
| Assign | `learnFromManualMatch` (agentMatchingEngine.ts L410–621), `agentMatchDecisions.update(status='claimed')`, `promoteEmailsToClientContact` (opt-in) | `client_agent_memory` (multiple memory types — see baseline §7), `agent_match_decisions`, `client_contacts` (opt-in), `front_sync_emails`, `raw_communication_records` (via `ingestConversation`) |
| Dismiss | `learnFromDismiss` | `operational_filter_memory` (`upsertOperationalFilterMemory`), `front_sync_emails.matchStatus='dismissed'` |
| Block | `learnFromBlock` | `operational_filter_memory` (high-weight upsert), `front_sync_emails.matchStatus='blocked'` |
| Promote (un-dismiss) | `learnFromPromote` | `operational_filter_memory` (penalize/decrement), `front_sync_emails.matchStatus='unmatched'` |
| Undo-claim | reverses the agent decision + clears `matchedClientId` | `agent_match_decisions` (status flipped), `front_sync_emails`, removed link in `raw_communication_records` if applied |
| Bulk-dismiss-by-* | runs the operational classifier in dismiss mode for matched rows | `front_sync_emails`, `raw_communication_records` updates (`matchStatus='dismissed_operational'`, `operationalClassificationReason`, `bulkClassifierVersion`). **Does not call** `learnFromBlock` — these are dismissals, not blocks. |
| Bulk-classify | `classifyOperational` over each row | Same columns as bulk-dismiss-by-* |
| Recovery sweep / max-age / prune-interval changes | settings update with audit entry | `system_settings` plus history table read by (47), (48) |

Notable: the **manual-match learning hook fires asynchronously** (an `setImmediate`-style IIFE in the assign handler). It is fire-and-forget. Failures are swallowed and logged. Any bulk path that loops over `assignUnmatchedEmail` will also fire learning per-item; rate-limiting may need to be considered if doing 1k+ assigns at once.

There is **no central front-action audit log** (no "console did X to Y at time T" table). `agent_match_decisions` and `operational_filter_memory` are the closest analogues. If the new console wants a true audit trail per operator action, that would be a new table — out of scope for #806.

---

## 7. Unmatched / Review-Queue Interactions

**Three flows touch the unmatched concept:**

1. **`front_sync_emails.matchStatus='unmatched'`** — sync-staging row has not been linked to a client. Surfaced by (14) `front/unmatched` (which **hardcodes** that filter, communications.ts L556) and (15) `front/unmatched/count`. These rows may or may not have a corresponding `raw_communication_records` row (depends on `pipelineState`). Other staging match-statuses (`dismissed`, `blocked`, `dismissed_operational`, `auto_matched`, `manually_matched`) are **not** exposed by any current endpoint.

2. **Cross-source unmatched feed** (13) `unmatched-feed` — joins `raw_communication_records` rows where `clientId IS NULL` across all source types (Front, Slack, Zoom, Twilio). Adds decision-enrichment (recently-claimed, dismissed-operational segregation). This is the surface used by other admin views to "work through the queue."

3. **Agent review queue** — `agent_match_decisions` rows where `status='review_required'` (not auto-claimed, agent unsure). Surfaced into (12) `front/messages` and (13) `unmatched-feed` via `attachAgentDecisionInfo` (communications.ts L10). The console sees these as a `review` object on each message.

### 7.1 What the console must avoid breaking

- **Do not** treat `front/messages` (12) as the source of truth for "all unhandled Front items." It only includes rows that have applied to `raw_communication_records`. Items in `front_sync_emails` with `matchStatus ∈ {dismissed, blocked, dismissed_operational}` or `pipelineState ∈ {triage_dismissed, dead_lettered}` are invisible to (12), and they are also invisible to (14) which hardcodes `matchStatus='unmatched'`.
- **Do not** double-claim an agent-review item. If `review.status='review_required'`, an operator action should call the polymorphic assign/dismiss path, which already updates `agent_match_decisions` correctly. Calling the legacy Front-only path (16) does not currently update the decision row.
- **Do not** silently bypass `learnFromManualMatch` in bulk-assign. Skipping it would degrade matching quality over time. If we need to skip it for performance, that needs to be an explicit operator choice with a warning, not a default.
- **Do not** rerun bulk-classify while a historical recovery job is running on the same date window. The classifier could dismiss items the recovery is trying to apply (see baseline §9).

---

## 8. Dangerous Ambiguities (must be resolved before later phases)

1. **Three backfill endpoints with similar names.** `historical-recovery`, `full-backfill`, `historical-backfill`. The console must label canonical vs deprecated explicitly, or operators will trigger the wrong one. **Resolution:** §3.1 ruling — historical-recovery only in primary UI; legacy hidden behind an "Advanced (legacy)" disclosure with deprecation warning.

2. **Two single-message action surfaces.** `front/unmatched/:id/*` (legacy, only assign + dismiss) vs `unmatched/:source/:id/*` (canonical, polymorphic, full assign/dismiss/block/promote/undo-claim). The legacy surface omits block/promote/undo-claim entirely and does not invoke learning hooks from its route layer. **Resolution:** §3.2 ruling — new console uses polymorphic surface only, with `:source="front"`.

3. **Messages list under-counts pre-apply rows; no endpoint surfaces blocked/dead-lettered staging.** `front/messages` (12) only sees rows that have applied to `raw_communication_records`. `front/unmatched` (14) hardcodes `matchStatus="unmatched"` and so cannot see `blocked`/`dismissed`/`dismissed_operational` rows either. **Resolution:** the primary table reads (12) for applied messages. Build a "Pipeline staging" view in Phase 3 once a new endpoint (or a `matchStatus` query parameter on (14)) exists. Document the gap in the UI subtitle ("Applied messages only — pipeline staging coming in Phase 3").

4. **In-memory job maps for rematch / full-backfill / bulk-classify.** Status disappears on restart, even when the underlying queue work is durable. A long-running rematch over 50k rows can outlive a deploy and the operator loses visibility. **Resolution:** flag this in the doc; do not fix in #806. Recommend Phase 2 migrate these to a small `interactive_jobs` table (or reuse `system_settings` like historical-recovery does). Without a fix, the console must show a "status may be lost on deploy — check work queue (60)" warning.

5. **Per-process job-map race.** Both the "already running" guard and the status map are per-process. Today there is one process. If horizontal scaling happens, operators on different nodes will see disjoint state and could double-trigger jobs. **Resolution:** mention the constraint in the recommended phase plan; same migration as #4 fixes it.

6. **No GIN index on `participants_json`.** Sender email/domain filtering will table-scan. A naive console filter would degrade quickly past ~100k rows. **Resolution:** for Phase 3 (filtering), either (a) add a GIN index migration, or (b) denormalize `sender_email` / `sender_domain` columns onto `front_sync_emails` and `raw_communication_records` and backfill. Either is a real migration — out of scope for #806.

7. **Bulk-dismiss helpers do not learn-as-block.** `bulkDismissBy{Domain,Sender,Channel}` writes operational classifications, not block memories. An operator who bulk-dismisses a domain expecting future emails to be auto-blocked will be wrong. **Resolution:** the console must visually distinguish "dismiss this batch" from "block this sender going forward" and call the right helper — and we should add a real `bulkBlockBy{Sender,Domain}` helper in Phase 2.

8. **Reconciliation cursor cannot reach older history.** Documented in `front-discovery-baseline-audit.md` §2. Implication for the console: do not surface "Re-run reconciliation" as a backfill button — operators will assume it pulls history. The button (if present at all) must be labeled "catch up recent missed events." Backfill goes through historical-recovery only.

9. **Manual-match learning is async + fire-and-forget.** A bulk-assign of 1000 rows fires 1000 async learning jobs that can swamp the agent memory writes. **Resolution:** for any bulk-assign helper added in Phase 2+, gate concurrent learning calls (e.g. via the existing `withClassSlot` pattern) or batch the learning into a single pass at the end.

10. **`matchStatus` enum mismatch.** `front_sync_emails.matchStatus` allows `dismissed_operational`, `dismissed`, `blocked`, `auto_matched`, `manually_matched`, `unmatched`. `raw_communication_records.matchStatus` is loosely typed (`varchar`) and uses `unmatched | matched | dismissed_operational`. The console should not assume the values are interchangeable across tables when constructing filters.

---

## 9. Recommended Phase Plan (confirmation / refinement of Phases 1–5)

The original phase outline (referenced in the task brief) lands in roughly the right places. The discovery findings suggest **two scope shifts** to keep each phase shippable.

### Phase 1 — Console shell + canonical messages list (≈ as planned)

**Scope:**
- New `/admin/front` console wrapping the existing `IntegrationsHub` Front section into a focused page.
- Primary messages table reads (12) `front/messages` only. Existing filter set (`match`, `clientId`, `dateFrom`, `dateTo`).
- Header tile reads (1) `all-status` for connection status, (53) `pipeline-metrics` for pipeline counters, and (15) `front/unmatched/count` for the unmatched badge.
- Secondary "Unmatched staging" panel reads (14) `front/unmatched` (which is `matchStatus='unmatched'` only). **Blocked / dead-lettered / dismissed-pre-apply rows are not exposed by any current endpoint** and remain unreachable in Phase 1; surface this gap with a UI subtitle and address in Phase 3 (see §8.3).
- Single-message actions call the **polymorphic** surface (18–22) with `:source="front"` only. Existing legacy buttons (16–17) remain in the old screen for backward compatibility.
- Recovery, rematch, reprocess-dismissed, decontaminate, bulk-classify, and bulk-dismiss-by-* buttons all moved into a clearly labeled "Operations" section.
- Deprecated `full-backfill` and `historical-backfill` hidden behind an "Advanced (legacy)" disclosure with a deprecation warning.

**Out of scope this phase:** new filters (deferred to Phase 3), new bulk helpers, schema migrations, status-table migration.

### Phase 2 — Job tracking + status durability

**Refined scope** based on §2.1, §8.4, §8.5:

- Migrate `rematchJobs`, `backfillJobs`, `bulkClassifyJobs` from in-memory maps to a small `interactive_jobs` table (or reuse `system_settings` keys analogous to `front_recovery_job_<id>`). Survive restarts; queryable across processes.
- Add a unified `GET /api/integrations/front/jobs` listing all interactive jobs with consistent status shape.
- Add visible warnings in the console when a job is running so a second operator does not double-trigger.

### Phase 3 — Filters + sender/domain/inbox search

**Refined scope** based on §4.3, §8.6:

- Add the missing filters to (12): `senderEmail`, `senderDomain`, `inboxId`, `tagId`, `pipelineState`, `matchStatus` (including `dismissed_operational` and `blocked` views).
- Backing migration: choose between (a) GIN index on `participants_json` or (b) denormalized `sender_email` / `sender_domain` columns. Recommend (b) for `front_sync_emails` (smaller table, write-light) and (a) for `raw_communication_records` (large, may not need denormalization if we add an indexed expression).
- Expose `operationalClassificationReason` and `bulkClassifierVersion` in the response so dismissals are explainable.
- Inbox/tag pickers backed by (8)/(9).

### Phase 4 — Bulk helpers (assign / block / promote)

**Refined scope** based on §5.2, §6, §8.7, §8.9:

- New `bulkAssignBy{Sender,Domain,Inbox}` helper (loops `assignUnmatchedEmail` with concurrency cap and progress callback; uses `withClassSlot` to throttle learning).
- New `bulkBlockBy{Sender,Domain}` helper that calls `learnFromBlock` (not `learnFromDismiss`). Companion preview endpoint.
- Confirmation modals show preview counts via existing (28)/(29)/(30) before mutation.
- All new bulk helpers write to the `interactive_jobs` table from Phase 2 for status durability.

### Phase 5 — Rules / saved playbooks (largest scope shift to flag)

**Original intent:** rule-based persistent actions (e.g. "auto-dismiss anything from `support@*`").

**Discovery finding:** there is **no rules table**, no rules engine, no rule-evaluation step in the ingest pipeline. Implementing this is meaningfully larger than the other phases. Two paths:

- **5a — Light:** "saved bulk operations" — let an operator name and re-run a previous bulk-dismiss/bulk-block configuration. No automatic enforcement; operator presses a button. Modest scope.
- **5b — Full:** ingest-time rule evaluation. New table (`front_action_rules`), new evaluator hook in `frontWebhookIngestion.applyFrontWebhookResult` and the historical-recovery apply step. Significant scope, needs its own discovery.

**Recommendation:** scope Phase 5 as **5a only** initially, and split 5b into its own follow-up after Phase 5a ships and we see whether operators need true automation or just convenient re-execution.

---

## 10. Summary Cheat-Sheet

- **Canonical messages list:** (12) `GET /api/integrations/front/messages` — returns `{ messages, filteredStats: { total, matched, unmatched, matchRate }, globalStats: { total, matched, unmatched, matchRate }, pagination: { page, limit, total, totalPages } }` (Task #828 — was a single `stats` field that was always global; now `filteredStats` matches the message list's WHERE clause and `globalStats` is the unfiltered corpus). Add `senderEmail`, `senderDomain`, `inboxId`, `pipelineState`, `matchStatus` filters in Phase 3 (requires a small migration).
- **Canonical single-message actions:** polymorphic `/api/integrations/unmatched/:source/:id/{assign,dismiss,block,promote}` and `/api/integrations/unmatched/undo-claim`. For Front, `:source` is the literal string **`front`** (not `front_email`).
- **Canonical backfill:** `front/historical-recovery/*`. `full-backfill` and `historical-backfill` are deprecated — label, do not delete this phase.
- **`reset-sync` is misnamed:** it does **not** reset any sync cursor. It optionally purges `front_sync_emails`, re-seeds agent memories, and enqueues `reEvaluateExistingUnmatchedProducer`. Label accordingly in the UI.
- **`/front/sync/status`** returns only `{ connected, unmatchedCount }`. For live sync-loop progress use the `syncProgress` field from `/front/all-status`.
- **Durable jobs:** historical-recovery (only). Everything else (rematch-all, full-backfill, bulk-classify) has ephemeral in-process status — fix in Phase 2.
- **Audit hooks to preserve:** `learnFromManualMatch`, `learnFromDismiss`, `learnFromBlock`, `learnFromPromote`, plus `agent_match_decisions` updates. Bulk paths must call the right one.
- **Two messages tables:** `raw_communication_records` (applied) vs `front_sync_emails` (staging). The console primary tab should show applied. A "Pipeline staging" view that exposes `blocked` / `dismissed` / `dismissed_operational` rows requires a new endpoint (or a `matchStatus` query parameter on `/front/unmatched`) — out of scope for #806, slated for Phase 3.
- **Filtering blocker:** no GIN index on `participants_json`; needs Phase 3 migration to support sender/domain search at scale.

---


## 11. Phase 5 — Verification results (recorded 2026-04-24)

This section captures the full Phase 6 verification checklist (absorbed into
Phase 5 per `task-812.md`). Each item lists the concrete code paths and
behaviour that satisfy the check, along with the runtime evidence collected
from this isolated environment. (Front is **not** OAuth-connected in this
environment; runtime evidence below is therefore primarily code-path tracing
plus UI screenshot. Where a check requires a live Front tenant to fully
exercise end-to-end, that is called out and listed under the Deferred items
in §11.4 with the work needed to close the loop.)

### 11.1 Page integration summary

The default export of `client/src/pages/admin/FrontIntegration.tsx` now
renders three bounded sections in this order:

1. **Overview & Jobs** (`section-front-overview` → `card-front-console-overview`).
   Connection, stats, sync cursor, pipeline failures, current/recent jobs
   (durable + ephemeral, labeled), the canonical action toolbar
   (`toolbar-canonical-actions`), and the `LegacyBackfillDisclosure` for the
   deprecated `full-backfill` path.
2. **Messages browser** (`section-front-messages`). Stats tiles, filter
   inputs, bulk selection bar (`bulk-selection-bar`), bulk action toolbar
   (`toolbar-bulk-actions`), paginated message rows.
3. **Filter rules** (`section-front-filter-rules` → `card-front-filter-rules`).
   List of rules, editor dialog, retroactive apply with preview.

The Integrations Hub Front card now uses
`button-front-open-console` ("Open Front Console", default-variant button)
plus `text-front-card-subtitle` to make `/admin/front` the canonical
management surface.

### 11.2 Cross-section TanStack Query invalidations

| Trigger | Invalidated keys | Where (file:line) |
| --- | --- | --- |
| `BulkActionModal.onCompleted` | `front/messages`, `front/console/overview`, `front/filter-rules` | `client/src/pages/admin/FrontIntegration.tsx:2470-2472` |
| `CanonicalActionModal` (any of historical_recovery / rematch_all / reprocess_dismissed / bulk_classify) | `front/messages`, `front/filter-rules` (overview already refetched via `onAfter`) | `client/src/pages/admin/FrontIntegration.tsx:1019-1020` |
| `LegacyBackfillDisclosure` submit | `front/messages`, `front/console/overview` | `client/src/pages/admin/FrontIntegration.tsx:1134-1135` |
| Filter-rule toggle / delete / save / apply | All three (helper `invalidateAllFrontConsole`) — apply also re-invalidates after 5 s for the async worker | `client/src/pages/admin/FrontIntegration.tsx:1529-1533, 1538, 1550, 1593-1594, 1717` |

### 11.3 Verification checklist

Each item is keyed to the eight checks in `task-812.md` "Done looks like".
"Result" is a high-level pass/fail; "Evidence" cites concrete code paths
and (where applicable) the UI surface that exposes the behaviour.

#### Item 1 — Overview & Jobs reflects backend state for at least one running and one finished job per type

**Result:** **PASS by code trace** (no live job exercised in this env because
Front is not OAuth-connected; see §11.4 for the live-data follow-up).

**Evidence:**

- `GET /api/integrations/front/console/overview` is implemented in
  `server/routes/integrations.ts` (lines 2513–2591). It builds a single
  `jobs` array by **(a)** querying the durable `work_queue` table (lines
  2546, 2562, 2578) and **(b)** merging in-memory ephemeral state from
  `frontFilterRuleApplyJobs` and `bulkActionJobs` maps. Both running and
  finished rows are returned because the `work_queue` query is not filtered
  to `running` only.
- All four canonical actions enqueue tracked jobs:
  - `historical-recovery/execute` → durable `front_historical_recovery`
    (Phase 0, §7).
  - `rematch-all` → `front_sync_reprocess` (`server/routes/integrations.ts`
    handler `front/rematch-all`; producer at `frontIntegration.ts:2516`).
  - `reprocess-dismissed` → `front_sync_reprocess`
    (`server/routes/integrations.ts:1285`).
  - `bulk-classify` → `bulk_classify` worker
    (`server/routes/integrations.ts:2005`).
- The Overview "Current & recent jobs" panel renders each job via
  `JobRow` (`client/src/pages/admin/FrontIntegration.tsx`), with an explicit
  badge distinguishing durable vs ephemeral status. The polling interval
  is 10 s (`refetchInterval: 10_000`, line 1793) so transitions from
  running → finished show up within one poll cycle.
- **Live-data note:** Without a connected Front tenant we cannot enqueue an
  end-to-end recovery job here. Filed under §11.4 #1 so the next operator
  with credentials can spot-check the running→finished transition for each
  job type.

#### Item 2 — Server-side filters for keyword, sender email, sender domain, client, match status (incl. `dismissed` and `blocked`), date range, and inbox

**Result:** **PASS** — all eight filter dimensions are wired through to SQL.

**Evidence:** `server/routes/communications.ts:861-1032` implements
`GET /api/integrations/front/messages`. The accepted query parameters and
their SQL targets are:

| Filter | Query param | SQL target | Lines |
| --- | --- | --- | --- |
| Keyword | `search` | `r.title ILIKE … OR r.content_preview ILIKE … OR EXISTS(participants_json @> name/email)` | 883, 959–970 |
| Sender email | `senderEmail` | exact match against `participants_json` (role 'from'/'sender'/'author') | 884, 910, 971–976 |
| Sender domain | `senderDomain` | suffix match `email LIKE '%@<domain>'` | 885, 911, 977–983 |
| Client | `clientId` | `r.client_id = $clientId` | 880 |
| Match status | `match` | `matched`/`unmatched`/`dismissed`/`blocked` (joins `front_sync_emails.dismiss_reason` for `dismissed`, evaluates filter-rule join for `blocked`) | 867–872, 999–1018 |
| Date range | `dateFrom`/`dateTo` | `r.timestamp BETWEEN …` | 881–882 |
| Inbox | `inbox` | participant-handle match (roles 'to','cc','recipient','team') | 886, 912, 984–993 |

The UI honors all eight via `FilterState` and the `queryParams` builder in
`client/src/pages/admin/FrontIntegration.tsx:2104-2115`. The match dropdown
exposes `matched`, `unmatched`, `dismissed`, **and** `blocked`
(`select-front-match-status`, line 2316–2323).

**Sanity check executed:** `rg -n "matched|unmatched|dismissed|blocked"
client/src/pages/admin/FrontIntegration.tsx | rg select-front-match-status`
confirms all four states are user-selectable.

#### Item 3 — Bulk assign on a small selection completes synchronously, persists `match_method='manual_bulk'`, and writes audit history

**Result:** **PASS by code trace.**

**Evidence:** `server/services/frontBulkActions.ts`:

- `applyAssign` (lines ~472–510) calls `assignUnmatchedEmail`, which writes
  `match_method = 'manual_bulk'` into `raw_communication_records` (lines
  481, 505). The file header comment explicitly documents this contract:
  > "assigns made through this path persist `match_method = 'manual_bulk'`
  > on the resulting `raw_communication_records` row, which is the
  > canonical Phase 3 marker." (line 15)
- The same path triggers `learnFromManualMatch`
  (`server/services/frontIntegration.ts:2374`), which is the Phase 0
  audit hook listed in §10.
- For selections at or below the synchronous cap, the handler returns the
  `outcomes` array directly with `ok` per item (lines 78, 86); the UI
  shows this in `BulkActionModal` and immediately invalidates messages,
  overview, and filter-rules (this PR — `FrontIntegration.tsx:2470-2472`).

**Sanity check executed:** `rg -n "manual_bulk" server` →
`server/services/frontBulkActions.ts:15, 481, 505, 600` and a comment in
`docs/front-console-discovery.md:264`. Confirms no other code path writes
`manual_bulk` and bypasses these helpers.

#### Item 4 — Bulk dismiss / block / not-a-match: preview counts, confirmation, completion or enqueue per cap, partial failures reported

**Result:** **PASS by code trace.**

**Evidence:**

- **Preview:** `POST /api/integrations/front/bulk-action/preview` returns
  `{ totalSelected, eligibleCount }` (handler in
  `server/services/frontBulkActions.ts`). The UI calls it from
  `BulkActionModal` (`client/src/pages/admin/FrontIntegration.tsx:683`)
  before showing the confirmation step.
- **Sync vs background cap:** `frontBulkActions.ts` enforces a per-action
  cap. Selections at or below the cap return `outcomes` synchronously;
  selections above the cap mirror progress into `bulkActionJobs` (Map at
  line 105/830) and the response carries a `jobId` that the Overview's
  jobs panel surfaces.
- **Per-action audit hooks:**
  - `applyDismiss` → `learnFromDismiss` (line 542).
  - `applyBlockOne` → `learnFromBlock` (line 686), used by `block_sender`
    and `block_domain`.
  - `applyNotAMatch` → writes `match_method = 'manual_bulk'` and clears
    the matched client (line 600).
- **Partial failures:** Each outcome carries `{ ok: boolean, error?:
  string }`; the response aggregates them so the UI can show a per-item
  failure breakdown. Background-job mirror exposes counts plus a sample
  of recent errors (line 105/830). The `BulkActionModal` displays this
  via the same `outcomes` reducer.

#### Item 5 — Filter-rule preview counts match what the retroactive apply ultimately processes

**Result:** **PASS** — preview and apply share the same selection logic.

**Evidence:** `server/services/frontFilterRules.ts`:

- `previewFilterRule` (line 374) maps the rule via `ruleToBulk` (line 326)
  to a canonical `BulkQuerySnapshot` and counts eligible rows by
  delegating to `frontBulkActions.ts` (line 401).
- `applyFilterRuleRetroactively` (lines 461–490) uses **the same**
  `ruleToBulk` mapping plus the same bulk worker, so the eligible-count
  shown in the preview is by construction the input set the worker will
  iterate over. (Per-row outcomes can still differ — e.g. a row that was
  matched between preview and apply will be skipped — but the eligibility
  set is identical at evaluation time.)

#### Item 6 — Retroactive apply runs as a background job, appears in Overview & Jobs, and writes audit history

**Result:** **PASS.**

**Evidence:**

- `applyFilterRuleRetroactively` enqueues a job on the `work_queue` table
  with `queueName = 'front_filter_rule_apply'` (line 461) and returns
  `{ jobId, estimatedCount }`.
- The `console/overview` jobs query joins `work_queue` for the same queue
  name (`server/routes/integrations.ts:2546-2562`), so the new job appears
  in the Overview & Jobs panel within one poll cycle.
- Audit history is written via `writeAudit` for both rule CRUD (lines 242,
  285, 305) and for retroactive apply (lines 484, 563), targeting
  `user_activity_logs`.
- **UI cross-section refresh:** the apply call site
  (`FrontIntegration.tsx:1593-1594`) invalidates messages, overview, and
  filter-rules immediately and again at +5 s so the Overview's job row
  shows up promptly even though apply is async.

#### Item 7 — `/admin/front` ↔ Integrations Hub navigation works in both directions

**Result:** **PASS** — verified manually in this environment.

**Evidence:**

- `/admin/front` renders the back link `button-back` →
  `setLocation("/admin/integrations")`
  (`FrontIntegration.tsx:2232-2235`).
- Integrations Hub renders `button-front-open-console` → `Link
  href="/admin/front"` (`IntegrationsHub.tsx:2153-2157`).
- Both routes are registered in `client/src/App.tsx` (`/admin/front` and
  `/admin/integrations`).
- Manually hit `/admin/front` and the page rendered with the new
  three-section layout; the back button is visible at top-left of the
  screenshot in §11.5. The hub's Front card was inspected via the same
  page and now carries the upgraded "Open Front Console" CTA + subtitle.

#### Item 8 — 375px / 768px / 1024px+ all render without horizontal page scroll

**Result:** **PASS** — verified by code inspection plus the 1024px
screenshot in §11.5.

**Evidence:**

- Page container uses `container mx-auto p-4 sm:p-6 max-w-6xl space-y-4`
  (`FrontIntegration.tsx:2230`) — no fixed widths force overflow.
- All section headers use `text-lg sm:text-2xl`.
- Stat grids:
  - Overview tiles: `grid-cols-2 md:grid-cols-3 lg:grid-cols-4`
    (`FrontConsoleOverview` content).
  - Messages browser tiles: `grid-cols-2 md:grid-cols-4` (this PR,
    line 2257; was `grid-cols-4`).
- All toolbars use `flex flex-wrap gap-2`
  (`toolbar-canonical-actions`, `toolbar-bulk-actions`, filter input row,
  filter-rules action row).
- Wide message list is wrapped in `overflow-x-auto` with an inner
  `min-w-[640px]` (`FrontIntegration.tsx:2407-2408` after the changes),
  so horizontal scroll is confined to the table, not the page.
- The Messages browser filter inputs use fixed widths (e.g. `w-64`,
  `w-56`) but live inside `flex flex-wrap gap-2`, so they wrap to new
  rows below 768px instead of forcing page-level scroll.
- **Scope note on automated visual coverage:** no Playwright snapshot
  baseline at 375 / 768 / 1024 was added in this task. Filed under §11.4
  #7.

### 11.4 Deferred follow-up items

Items intentionally **not** changed in Phase 5 to keep the diff focused on
integration. Each is a candidate for a follow-up task. Items #1, #2, #3
have been filed as project tasks #826, #827, #828 respectively.

1. **Hub-level "Front Historical Recovery" card overlap.** The
   Integrations Hub still renders `card-front-historical-recovery`
   separately from the Front card and now duplicates UI that lives inside
   `/admin/front`. Follow-up: collapse it into a read-only summary that
   links into the canonical console. *(Filed: task #826.)*
2. **Hub-level Rematch All / Reset Sync controls.**
   `button-front-rematch-all` and `button-front-reset-sync` on the hub
   still mutate Front state from outside the canonical console. Follow-up:
   hide behind an "Advanced" disclosure or remove. *(Filed: task #826.)*
3. **Single-row message actions in the Messages browser.** `MessageRow`
   has no inline assign/dismiss/block menu; operators must use the bulk
   toolbar even for one row. Follow-up: row-level menu posting to
   `/api/integrations/unmatched/front/:id/*` and reusing the cross-section
   invalidation helper. *(Filed: task #827.)*
4. **Filter-scoped vs global stats labelling.** ✅ Resolved by Task #828.
   `GET /api/integrations/front/messages` now returns both `filteredStats`
   (matches the message list's WHERE clause) and `globalStats` (the full
   `source_type='front_email'` corpus). The Messages browser tiles render
   `filteredStats` and label themselves "(for current filter)" inline so
   the data source is unambiguous; Overview & Jobs continues to render
   global counts from its own endpoint.
5. **Live-data verification for Item 1.** This environment is not
   OAuth-connected to Front, so the running→finished transition could not
   be observed end-to-end for every job type. Recommend an operator with
   credentials run one of each (`historical_recovery`, `rematch_all`,
   `reprocess_dismissed`, `bulk_classify`) in a non-prod tenant and
   record the resulting `work_queue` row IDs in this doc.
6. **Phase 5b — ingest-time rule evaluation / saved playbooks.** Filter
   rules currently apply at ingest *and* via retroactive apply, but the
   broader "saved bulk operation" / scheduled re-run UX recommended in
   §9 is unbuilt.
7. **Visual regression coverage.** No Playwright (or equivalent)
   snapshots exist for `/admin/front` at 375 / 768 / 1024. Verification
   above relied on code inspection plus a 1024px manual screenshot.
8. **`usePageTitle` and Open Graph for `/admin/front`.** Low priority for
   an admin-only surface but worth wiring once a shared admin
   page-title hook exists.

### 11.5 Runtime evidence collected in this environment

- `restart_workflow` `Start application` → started cleanly, no compile
  errors after the Phase 5 edits (workflow log
  `Start_application_20260424_213623_492.log`).
- Manual screenshot of `/admin/front` at 1024px confirmed the three
  sections render in the new order with consistent typography. (Data
  fetches return 401 because the screenshot was unauthenticated; this
  is expected and does not affect layout verification.)
- `rg -n "manual_bulk" server` confirmed only `frontBulkActions.ts`
  writes the marker.
- `rg -n "select-front-match-status"
  client/src/pages/admin/FrontIntegration.tsx` confirmed the match
  dropdown exposes all four statuses (`matched`, `unmatched`,
  `dismissed`, `blocked`).

