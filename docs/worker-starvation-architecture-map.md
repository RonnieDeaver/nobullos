# Worker Starvation & Architecture Map

> Discovery report for Task 253A — read-only investigation of how DB-heavy slots,
> worker locks, timers, job state, and in-memory flags currently work.
>
> Historical note (2026-08-08): the `google_drive_sync` worker rows below are
> archival — the Google Drive integration was retired by Task #4084.

---

## 1. DB-Heavy Slot Lifecycle

### 1.1 Slot Mechanism

**File:** `server/services/workerConcurrency.ts`

Global concurrency is gated by `activeSlotCount` (in-memory integer) capped at
`WORKER_DB_HEAVY_MAX_CONCURRENCY = 3` (from `server/services/workerConfig.ts:4`).

Three APIs:
| API | Semantics |
|---|---|
| `acquireDbHeavySlot(worker)` | Increment counter, push to `activeSlotOwners[]`. Returns `false` if at max. |
| `releaseDbHeavySlot(worker)` | Decrement counter, remove first match from `activeSlotOwners[]`. |
| `withDbHeavySlot(worker, fn)` | RAII wrapper — acquire, run, release in `finally`. Uses `AsyncLocalStorage` to allow re-entrant calls within the same async context. |

**Reserved-slot override** (lines 32–39): Workers in `RESERVED_SLOT_WORKERS`
(`retroactiveReprocess`, `frontRematchAll`, `frontSyncReprocess`, `agentDecontamination`)
can claim a 4th slot if all 3 current slots are held by sync workers
(`front_sync`, `zoom_sync`) or `bulkClassify`.

### 1.2 Registered DB-Heavy Workers

From `server/services/workerConfig.ts:26–36`:

| Worker name | Kind |
|---|---|
| `front_sync` | Timer-driven sync |
| `zoom_sync` | Timer-driven sync |
| `local_dominance_sync` | Timer-driven sync |
| `bulkClassify` | Periodic + admin-triggered |
| `retroactiveReprocess` | Periodic + admin/contact-add triggered |
| `startupCleanup` | Startup-only |
| `frontSyncReprocess` | Admin-triggered |
| `frontRematchAll` | Admin-triggered |
| `agentDecontamination` | Admin-triggered |

### 1.3 Every Path That Acquires / Releases a Slot

| # | Worker | Acquire site | Release site | Style | Holds across network I/O? | Estimated hold time |
|---|---|---|---|---|---|---|
| 1 | `front_sync` | `frontIntegration.ts:907` | `frontIntegration.ts:946` | Manual acquire+release in try/finally | **Yes** — Front API calls, agent matching, DB writes per conversation | 30s–5 min |
| 2 | `zoom_sync` | `zoomIntegration.ts:1006` | `zoomIntegration.ts:1026` | Manual acquire+release in try/finally | **Yes** — Zoom API (recording list, transcript fetch), DB writes | 30s–3 min |
| 3 | `local_dominance_sync` | `localDominanceSyncWorker.ts:30` | `localDominanceSyncWorker.ts:107` (in finally) | Manual acquire+release | **Yes** — SEMrush API calls per campaign, DB writes | 1–10 min per batch |
| 4 | `startupCleanup` | `index.ts:126` via `withDbHeavySlot` | Auto-released by `withDbHeavySlot` | RAII | Minimal — DB-only (cleanup queries) | 2–10s |
| 5 | `bulkClassify` (periodic) | `frontIntegration.ts:2071` via `withDbHeavySlot` | Auto-released | RAII | **Yes** — OpenAI API calls for classification | 30s–5 min |
| 6 | `bulkClassify` (admin) | `integrations.ts:895` manual | `integrations.ts:914` in finally | Manual, fire-and-forget background | **Yes** — OpenAI + DB | 1–15 min |
| 7 | `retroactiveReprocess` (periodic client matching) | `frontIntegration.ts:2107` via `withDbHeavySlot` | Auto-released | RAII | **Yes** — DB reads/writes per client | 30s–5 min |
| 8 | `retroactiveReprocess` (contact add/update) | `agents.ts:38,74,381` via `withDbHeavySlot` in `setImmediate` | Auto-released | RAII, fire-and-forget | Yes — DB | 1–10s |
| 9 | `frontSyncReprocess` | `integrations.ts:762` via `withDbHeavySlot` | Auto-released | RAII (synchronous HTTP response) | **Yes** — DB scan + re-classify | 1–10 min |
| 10 | `frontRematchAll` (dry-run) | `integrations.ts:787` via `withDbHeavySlot` | Auto-released | RAII | Yes — DB | seconds |
| 11 | `frontRematchAll` (live) | `integrations.ts:802` manual acquire | `integrations.ts:825` in finally (background) | Manual, fire-and-forget | **Yes** — full re-match all conversations | 5–30 min |
| 12 | `agentDecontamination` | `integrations.ts:857` via `withDbHeavySlot` | Auto-released | RAII (synchronous HTTP response) | **Yes** — DB cleanup, re-seed | 1–5 min |

### 1.4 Starvation Risk Summary

With only 3 slots and `front_sync` running every 5 minutes, `zoom_sync` running daily,
and `local_dominance_sync` running every 6 hours, the system is frequently at capacity.
When an admin triggers `frontRematchAll` or `bulkClassify`, it can hold a slot for 15–30
minutes, effectively blocking all other DB-heavy work for that duration.

The reserved-slot mechanism (4th slot for repair workers) only activates when all 3 slots
are held by sync+bulkClassify — if any repair worker already holds a slot, the reserved
path doesn't help.

---

## 2. Worker Lock Lifecycle

### 2.1 Lock Mechanism

**File:** `server/services/workerLock.ts`

In-memory `Map<string, LockEntry>` with TTL-based expiration (default `WORKER_LOCK_TTL_MS = 900_000` / 15 min) and heartbeat (default `WORKER_LOCK_HEARTBEAT_MS = 30_000` / 30s).

| API | Semantics |
|---|---|
| `acquireLock(worker, ttl, heartbeat)` | Checks for existing unexpired lock; if none, inserts + starts heartbeat `setInterval`. Returns `false` if locked. |
| `releaseLock(worker)` | Clears heartbeat interval, deletes from map. |
| `withWorkerLock(worker, fn)` | RAII wrapper. |
| `recoverStaleLocks()` | Called at top of `acquireLock`; deletes all expired entries. |

### 2.2 Lock Call Sites

| Worker | Acquire | Release | Notes |
|---|---|---|---|
| `front_sync` | `frontIntegration.ts:903` | `frontIntegration.ts:947` | Also guarded by `frontSyncCycleRunning` flag |
| `zoom_sync` | `zoomIntegration.ts:1002` | `zoomIntegration.ts:1027` | Also guarded by `zoomSyncRunning` flag |
| `local_dominance_sync` | `localDominanceSyncWorker.ts:26` | `localDominanceSyncWorker.ts:108` | Also guarded by `isSyncing` flag |
| `google_drive_sync` | `googleDriveSyncWorker.ts:28` | `googleDriveSyncWorker.ts:92` | Also guarded by `isSyncing` flag |
| `call_analysis_poll` | `callAnalysis.ts:2292` | `callAnalysis.ts:2318` | Per-poll lock (not per-job) |

All sync workers use a **three-layer guard**: (1) in-memory boolean flag, (2) worker lock, (3) DB-heavy slot (except `google_drive_sync` and `call_analysis` which skip the DB-heavy slot).

---

## 3. Timers, Cron Loops, and Staggered Startup

### 3.1 Staggered Startup

**File:** `server/index.ts:395–442`

All background workers start via `setTimeout` from the `httpServer.listen` callback, using `WORKER_STAGGER_OFFSETS` + random jitter (0–30s):

| Worker | Base offset | Effective delay |
|---|---|---|
| `front_sync` (→ `initAutoSync`) | 10s | 10–40s |
| `semrush_enrichment` (→ `startupEnrichment`) | 25s | 25–55s |
| `slack_profile_sync` (→ `syncSlackProfiles`) | 55s | 55–85s |
| `zoom_sync` (→ `initZoomAutoSync`) | 40s | 40–70s |
| `local_dominance_sync` (→ `startSyncScheduler`) | 100s | 100–130s |
| `daily_judgment` (→ `startDailyJudgmentScheduler`) | 110s | 110–140s |
| `google_drive_sync` (→ `startGoogleDriveSyncScheduler`) | 70s | 70–100s |
| `call_analysis` (→ `startWorker`) | 130s | 130–160s |

Additionally, these fire at startup without stagger offsets:
- `startMcuWorker()` — `index.ts:266–268`, immediate on listen
- `startupCleanup` — `index.ts:121–147`, fire-and-forget IIFE at route registration time
- Client code backfill — `index.ts:150–179`, fire-and-forget IIFE
- Location geocode backfill — `index.ts:181–235`, fire-and-forget IIFE
- Various DB migrations — `index.ts:269–393`, fire-and-forget in listen callback

**Note on sub-worker stagger offsets**: `WORKER_STAGGER_OFFSETS` in `workerConfig.ts`
includes entries for `front_health_check` (20s), `front_spam_cleanup` (50s), and
`front_client_matching` (80s). However, these offsets are **not used at startup**. The
front sub-workers (`startSyncHealthCheck`, `startPeriodicSpamCleanup`,
`startPeriodicClientMatching`) are started from within `initAutoSync()` at
`frontIntegration.ts`, not via separate `setTimeout` calls in `index.ts`. The offsets
exist in the config but are currently dead configuration. Only the top-level initializers
listed above are actually staggered.

### 3.2 Recurring Timers (`setInterval`)

| Timer | Interval | File:Line | DB-Heavy? | Lock? |
|---|---|---|---|---|
| Front sync cycle | 5 min (`SYNC_INTERVAL_MS`) | `frontIntegration.ts:1399` | ✅ | ✅ |
| Front health check | 1 min (`FRONT_HEALTH_CHECK_INTERVAL_MS`) | `frontIntegration.ts:2050` | ❌ | ❌ |
| Front spam cleanup (bulkClassify) | 15 min (`FRONT_SPAM_CLEANUP_INTERVAL_MS`) | `frontIntegration.ts:2068` | ✅ | ❌ |
| Front client matching (retroactiveReprocess) | 10 min (`FRONT_CLIENT_MATCHING_INTERVAL_MS`) | `frontIntegration.ts:2097` | ✅ | ❌ |
| Zoom daily sync | ~24h (via chained `setTimeout`) | `zoomIntegration.ts:1368` | ✅ | ✅ |
| Local dominance sync | 6h | `localDominanceSyncWorker.ts:462` | ✅ | ✅ |
| Google Drive sync | 1h | `googleDriveSyncWorker.ts:262` | ❌ | ✅ |
| Call analysis poll | 15s | `callAnalysis.ts:2289` | ❌ | ✅ (per-poll) |
| SEMrush background refresh | 1h | `semrushApi.ts:702` | ❌ | ❌ |
| DB pool stats | 1 min (`DB_POOL_STATS_INTERVAL_MS`) | `db.ts:145` | ❌ | ❌ |
| Video analysis temp cleanup | 30 min | `videoAnalysis.ts:396` | ❌ | ❌ |
| Worker lock heartbeats | 30s per lock | `workerLock.ts:33` | ❌ | N/A |
| MCU location-change recompute | Event-driven (30s debounce) | `mcu/worker.ts:77` | ❌ | ❌ |
| MCU initial computation | One-time (10s after startup) | `mcu/worker.ts:242` | ❌ | ❌ |
| MCU retry after failure | 5s after failed computation | `mcu/worker.ts:192` | ❌ | ❌ |

**MCU Worker Runtime Model** (`server/mcu/worker.ts`): The MCU worker is **event-driven**,
not periodic. It seeds H3 population grids on first startup (lines 218–234), loads cached
results from DB (line 236), and recomputes only when `onLocationChanged()` is called
(debounced to 30s via `setTimeout` at line 77) or a manual refresh is triggered. It uses
an in-memory `computeStatus` flag (`'idle'` / `'computing'`) to prevent overlapping
computations, with a `pendingRefresh` flag for coalescing concurrent requests. On failure,
it retries after a 5s delay (line 192). No DB-heavy slot or worker lock is used.

### 3.3 Cron Schedules

| Schedule | Expression | File:Line |
|---|---|---|
| Daily judgment | `0 6 * * *` (6 AM ET) | `dailyJudgmentScheduler.ts:12` |

---

## 4. Existing Job / Queue-Like Tables

### 4.1 `call_analysis_jobs`

**File:** `shared/models/ceoTools.ts:12–26`

| Column | Purpose |
|---|---|
| `analysis_id` (PK) | UUID |
| `external_id` | Zoom/phone recording reference |
| `idempotency_key` (unique) | Dedup |
| `status` | `queued` → `processing` → `complete` / `failed` |
| `attempt_count` | Retry tracking |
| `started_at`, `completed_at` | Timing |
| `error_message` | Failure reason |

**This is the closest thing to a real job queue in the system.** The `call_analysis` worker polls every 15s for `status='queued'` rows, sets to `processing`, runs analysis, then marks `complete`/`failed`. Stale jobs (`processing` for >N minutes) are recovered back to `queued` (up to 2 retries).

### 4.2 `slack_sync_history`

**File:** `shared/models/communications.ts:193–212`

Tracks completed Slack sync runs: `status`, `channels_processed`, `messages_created`, `messages_skipped`, `errors`, `started_at`, `completed_at`. This is an **audit log**, not a queue.

### 4.3 `raw_communication_records.processing_status`

**File:** `shared/models/communications.ts:43`

Per-record status: `pending` → (classified/matched). Used by sync cycles and reprocess endpoints to identify work. Acts as a cursor of sorts — workers query for `pending` records. Not a queue, but a processing-state column.

### 4.4 `raw_communication_records.transcript_status`

**File:** `shared/models/communications.ts:55`

Tracks Zoom transcript backfill: `pending` / `failed` / (complete). The Zoom sync cycle queries for `pending` records to backfill.

### 4.5 `client_semrush_integrations.sync_status`

**File:** `shared/models/heatmap.ts:124`

Per-integration sync state: `idle` / `syncing` / `success` / `error`. Updated by `localDominanceSyncWorker` after each client sync.

### 4.6 In-Memory Job Maps (Ephemeral)

| Map | File:Line | Purpose |
|---|---|---|
| `rematchJobs` | `integrations.ts:775` | Tracks running `frontRematchAll` background jobs |
| `bulkClassifyJobs` | `integrations.ts:886` | Tracks running `bulkClassify` background jobs |

These are wiped on restart. Jobs have a 10-minute cleanup timeout after completion.

---

## 5. In-Memory Execution Flags

| Flag | File:Line | Purpose |
|---|---|---|
| `frontSyncCycleRunning` | `frontIntegration.ts:891` | Prevents overlapping front sync cycles |
| `zoomSyncRunning` | `zoomIntegration.ts:990` | Prevents overlapping zoom sync cycles |
| `isSyncing` (local dominance) | `localDominanceSyncWorker.ts:7` | Prevents overlapping local dominance syncs |
| `isSyncing` (google drive) | `googleDriveSyncWorker.ts:6` | Prevents overlapping drive syncs |
| `judgmentRunning` | `dailyJudgmentScheduler.ts:5` | Prevents overlapping daily judgment runs |
| `clientMatchingRunning` | `frontIntegration.ts:2089` | Prevents overlapping periodic client matching |
| `workerRunning` | `callAnalysis.ts:2203` | Prevents re-starting call analysis worker |
| `jobProcessing` | `callAnalysis.ts:2205` | Prevents concurrent job processing within poll |
| `backgroundRefreshRunning` | `semrushApi.ts:425` | Prevents overlapping SEMrush cache refresh |
| `activeReprocesses` (Set) | `agentMatchingEngine.ts:1119` | Per-client reprocess overlap guard |
| `reprocessCooldowns` (Map) | `agentMatchingEngine.ts:1117` | 30s cooldown per client for retroactive reprocess |
| `activeSlotCount` / `activeSlotOwners` | `workerConcurrency.ts:5–6` | Global DB-heavy slot tracking |
| `periodicSweepVersion` | `frontIntegration.ts:2091` | Sweep run counter for logging |
| `enrichedCacheReady` | `semrushApi.ts:426` | Gate for SEMrush data availability |
| `computeStatus` | `mcu/worker.ts` | MCU compute state: `idle` / `computing` / `ready` / `error` |
| `pendingRefresh` / `nextForceProbeSearch` | `mcu/worker.ts` | Coalesces concurrent MCU refresh requests |
| `locationChangeTimer` | `mcu/worker.ts:70` | Debounce timer for location-change recompute |

All of these are **process-local** and reset on restart.

---

## 6. Deploy-Overlap Risk

### 6.1 Single-Instance Assumption

The entire concurrency system is **in-memory only** — there are no database-backed locks,
no leader election, no distributed coordination.

- `workerLock.ts` uses an in-memory `Map`
- `workerConcurrency.ts` uses in-memory counters
- All boolean flags are module-scoped variables

### 6.2 Two-Instance Overlap Scenario

During a deploy, if two instances run simultaneously:

1. **Both instances start all workers** via the staggered startup in `index.ts:395–442`.
2. **No lock contention** — each instance has its own lock map, so both will acquire
   "locks" independently and run sync cycles concurrently.
3. **DB-heavy slots** — each instance tracks 3 slots independently, meaning up to **6
   concurrent DB-heavy workers** could hit the database.
4. **Front sync**: Both instances call the Front API, potentially fetching the same
   conversations and creating duplicate `raw_communication_records` (mitigated only by
   `external_source_id` uniqueness constraints, if present).
5. **Zoom sync**: Both instances call Zoom API and could process the same recordings.
6. **Call analysis**: The `call_analysis_jobs` table uses a DB-level queue, so this
   worker is **relatively safer** than others. However, `processNextJob` updates
   `status` to `processing` by `analysisId` without an atomic `WHERE status='queued'`
   guard, meaning two instances could both read the same queued job and both begin
   processing it, leading to duplicate work or race conditions on completion.
7. **Admin operations**: The `rematchJobs` and `bulkClassifyJobs` maps are per-instance,
   so status polling from the frontend would break if requests hit different instances.

### 6.3 Risk Level: **HIGH**

The current architecture assumes exactly one running instance. Deploying a second
instance causes double-execution of all sync cycles, double-consumption of API rate
limits, and potential data integrity issues (duplicate records, overlapping classification).

---

## 7. Metrics / Logging Around Worker Duration and Slot Hold Time

### 7.1 Structured Worker Logging

**File:** `server/services/workerLogger.ts`

Every worker emits structured logs via `workerLog()`:
- `worker_started` — when work begins
- `worker_completed` — with `durationMs`
- `worker_failed` — with `durationMs` and `error`
- `worker_skipped_overlap` — lock contention
- `worker_skipped_global_limit` — DB-heavy slot unavailable
- `worker_batch_completed` — batch progress (used by `local_dominance_sync`)
- `worker_heartbeat` — periodic lock renewal
- `worker_lock_acquired` / `worker_lock_recovered` — lock lifecycle

### 7.2 DB Pool Monitoring

**File:** `server/db.ts:138–146`

`logPoolUtilization()` runs every 60s, logging pool size, active connections, idle
connections, waiting count, and utilization percentage. Warns when utilization exceeds 80%.

### 7.3 What's Missing

- **No slot hold-time tracking**: When a slot is acquired/released, no duration is logged
  at the slot level (only at the worker level via `workerLog`).
- **No histogram or time-series**: All metrics are console logs, not structured metrics.
- **No alerting**: No threshold-based alerts for long-running workers or slot starvation.
- **No queue depth tracking**: `call_analysis_jobs` queue depth is not monitored.

---

## 8. Recommendations

### 8.1 Initial Queue Candidates

These should be migrated to the proposed queue in 253B:

| Current worker | Why queue it |
|---|---|
| `frontRematchAll` | Long-running (5–30 min), admin-triggered, needs progress tracking. Already has ephemeral `rematchJobs` map that is lost on restart. |
| `bulkClassify` | Long-running (1–15 min), admin-triggered, needs progress tracking. Already has ephemeral `bulkClassifyJobs` map. |
| `frontSyncReprocess` | Long-running (1–10 min), admin-triggered, currently blocks HTTP response. |
| `agentDecontamination` | Admin-triggered, currently blocks HTTP response. |
| `retroactiveReprocess` (contact-add) | Fire-and-forget via `setImmediate`, lost on restart. |

### 8.2 What Should Stay Timer-Driven

| Worker | Why keep it |
|---|---|
| `front_sync` | Core sync loop, needs to run on a fixed cadence. Timer is appropriate; only the DB-heavy slot gate needs improvement. |
| `zoom_sync` | Daily cycle, inherently time-driven. |
| `local_dominance_sync` | 6h cycle with external API dependency. Timer is fine. |
| `google_drive_sync` | Lightweight cache refresh, no DB-heavy slot needed. |
| `call_analysis` | **Already has a DB-backed queue** (`call_analysis_jobs`). The polling worker should stay but could be enhanced. |
| `daily_judgment` | Daily cron, naturally time-driven. |
| `semrush_enrichment` | Cache refresh, lightweight. |
| `front_health_check` | Watchdog for sync interval, lightweight. |

### 8.3 Cut Line: Sync Orchestration vs. Repair Queue

**Sync orchestration** (stays timer-driven, no queue):
- `front_sync`, `zoom_sync`, `local_dominance_sync`, `google_drive_sync`
- `call_analysis` (already DB-queued)
- `daily_judgment`, `semrush_enrichment`, `front_health_check`

**Repair queue** (moves to queue infrastructure):
- `frontRematchAll`, `bulkClassify`, `frontSyncReprocess`, `agentDecontamination`
- `retroactiveReprocess` (contact-add triggers)
- Any future "reprocess N records" operations

The key distinction: **sync workers** discover new external data on a schedule;
**repair workers** reprocess existing internal data on demand.

### 8.4 Conflicts with Proposed Queue Schema (253B)

Potential issues to watch for:

1. **`call_analysis_jobs` coexistence**: This table already implements a queue pattern.
   The new queue schema should either (a) absorb it or (b) coexist without confusion.
   Recommend coexistence for now — call analysis has unique fields (`audio_url`,
   `rev_transcript_json`) that don't fit a generic queue.

2. **Slot reservation logic**: The `RESERVED_SLOT_WORKERS` mechanism in
   `workerConcurrency.ts:10–15` encodes priority rules that the queue scheduler must
   replicate if it manages slot allocation.

3. **Fire-and-forget patterns**: The `setImmediate` calls in `agents.ts:35,71` and the
   background `(async () => { ... })()` patterns in `integrations.ts:809,902` will need
   to be replaced with queue enqueue calls. These currently have no retry or persistence.

4. **In-memory job tracking**: The `rematchJobs` and `bulkClassifyJobs` maps
   (`integrations.ts:775,886`) must be replaced by queue status queries. Their current
   10-minute TTL cleanup should map to queue retention policy.

5. **Per-client cooldowns**: `reprocessCooldowns` in `agentMatchingEngine.ts:1117` is a
   debounce mechanism. The queue should implement equivalent dedup (e.g., upsert with
   "latest wins" semantics rather than enqueuing duplicates).

6. **Lock vs. queue**: Workers that currently use `withWorkerLock` for overlap prevention
   may need their lock usage reviewed — if the queue provides at-most-once delivery, the
   in-process lock becomes redundant. However, for timer-driven workers that stay
   timer-driven, the lock remains necessary.
