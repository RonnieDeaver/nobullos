# Performance Phase 0 — Discovery Map

Generated: 2026-04-11
(Historical note 2026-08-08: Google Drive sync sections below are archival — the Drive integration was retired by Task #4084.)

---

## 1. SEMrush Sync Polling

### Frontend Poll Loop
- **File:** `client/src/components/LocalDominanceDashboard.tsx:640-688`
- **Function:** `pollSyncStatus()` (useCallback)
- **Mechanism:** Manual `fetch()` loop — up to 120 polls at 3 000 ms interval (6 min max).
- **Endpoint polled:** `GET /api/clients/${clientId}/semrush-integration`
- **Trigger:** `useEffect` at line 684 fires when `integration?.syncStatus === "syncing"`.
- **Guard:** `pollingRef` (useRef boolean) prevents concurrent poll loops.
- **On completion:** Invalidates `["/api/clients", clientId, "semrush-integration"]` and `["/api/clients", clientId]`.

### Backend Sync Endpoint
- **File:** `server/routes/heatmap.ts:474-526`
- **Endpoint:** `POST /api/clients/:clientId/semrush-integration/sync`
- **Behavior:** Sets `syncStatus = "syncing"` in DB, then calls `syncSingleClient(clientId)` from `localDominanceSyncWorker` as a fire-and-forget promise. Returns 202 immediately.
- **Overlap prevention:** Uses optimistic-locking pattern — `ne(syncStatus, "syncing")` check returns 409 if already syncing.

### Backend Status Check
- **File:** `server/routes/heatmap.ts:418-430`
- **Endpoint:** `GET /api/clients/:clientId/semrush-integration`
- **Returns:** The integration row directly from `clientSemrushIntegrations` table.

---

## 2. Client Detail Page Queries

**File:** `client/src/pages/ClientDetail.tsx`

| # | Query Key | Lines | Classification | Notes |
|---|-----------|-------|----------------|-------|
| 1 | `["/api/clients", clientId, "summary"]` | 306-319 | **PRIMARY** | Fetches client + reports + dataAccess + contacts in one call. Gates page render (`clientLoading`). |
| 2 | `["/api/users"]` | 324-332 | **DEFERRED** | Only for role-gated dropdown (team_lead/ceo/AM). |
| 3 | `["/api/clients", clientId, "command-panel", "rer-recordings"]` | 334-342 | **DEFERRED** | RER recordings — only relevant in Command Panel tab. |
| 4 | `["/api/clients", clientId, "communications", "zoom"]` | 344-352 | **DEFERRED** | Zoom comms — only relevant in Communications tab. |

All queries use `enabled: !!user && !!clientId` (or role-gated). None set per-query `staleTime`, so they inherit the global 5 min default.

---

## 3. Worker Scheduling

### 3a. Front Sync
- **File:** `server/services/frontIntegration.ts`
- **Startup:** `initAutoSync()` called from `server/index.ts:346` via `setTimeout(10 000 + jitter)`.
- **Init logic (line 1401+):** Validates connection → calls `startAutoSync()` + `startSyncHealthCheck()` + `startPeriodicSpamCleanup()` + `startPeriodicClientMatching()`.
- **Cadence:**
  - **Main sync:** `setInterval` every **5 min** (`SYNC_INTERVAL_MS = 5 * 60 * 1000`). Function: `runSyncCycle()`.
  - **Health check:** `setInterval` every **1 min** — restarts sync if interval died.
  - **Spam cleanup:** `setInterval` every **15 min** — `bulkClassifyUnmatched()` via `operationalClassifier`.
  - **Client matching:** `setInterval` every **10 min** — `retroactiveReprocess()` for all clients.
- **Overlap prevention:** `syncIntervalId` null check prevents double-start. Sync cycle itself is guarded by a cycle-level timeout (`SYNC_CYCLE_TIMEOUT_MS = 10 min`). `clientMatchingRunning` boolean flag prevents concurrent matching sweeps.
- **DB context:** Uses `runWithWorkerDb()` for initial seed and sync cycles.
- **Batch pattern:** Main sync cycle processes conversations page-by-page. Client matching iterates all clients with `maxItems: 100`.

### 3b. Google Drive Sync
- **File:** `server/services/googleDriveSyncWorker.ts`
- **Startup:** `startGoogleDriveSyncScheduler()` called from `server/index.ts:380` via `setTimeout(30 000 + jitter)`.
- **Cadence:** `setInterval` every **1 hour** (`SYNC_INTERVAL_MS = 60 * 60 * 1000`).
- **Function:** `syncAllDriveFolders()` — BFS crawl of Google Drive folder tree.
- **Overlap prevention:** `isSyncing` boolean flag.
- **Batch pattern:** BFS with `MAX_CRAWL_DEPTH = 8`, `MAX_TOTAL_FOLDERS = 5000`.
- **DB usage:** Direct `workerDb` import (not via `getDb()`/`runWithWorkerDb()`).

### 3c. Zoom Auto Sync
- **File:** `server/services/zoomIntegration.ts`
- **Startup:** `initZoomAutoSync()` called from `server/index.ts:360` via `setTimeout(25 000 + jitter)`.
- **Cadence:** `setInterval` every **5 min** (`ZOOM_SYNC_INTERVAL_MS = 5 * 60 * 1000`).
- **Function:** `runZoomSyncCycle()` (line ~1120).
- **Overlap prevention:** `zoomSyncIntervalId` null check.
- **DB context:** Uses `runWithWorkerDb()` for worker context.

### 3d. LocalDominance Sync
- **File:** `server/services/localDominanceSyncWorker.ts`
- **Startup:** `startSyncScheduler()` called from `server/index.ts:370` via `setTimeout(40 000 + jitter)`.
- **Cadence:** `setInterval` every **6 hours** (`SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000`).
- **Function:** `syncAllActiveClients()` — iterates all active integrations sequentially.
- **Overlap prevention:** `isSyncing` boolean flag.
- **DB usage:** Direct `workerDb` import (not via `getDb()`/`runWithWorkerDb()`).
- **Batch pattern:** Sequential — one integration at a time, one keyword at a time.

### 3e. Call Analysis
- **File:** `server/services/callAnalysis.ts`
- **Startup:** **Boot-time** — `startWorker()` is called at `server/routes/ceoTools.ts:172` inside `registerCeoToolsRoutes()`, which is invoked at `server/routes.ts:57` during server route registration. The worker starts unconditionally at server boot and polls continuously.
- **Cadence:** `setInterval` every **15 sec** (default `intervalMs = 15000`). Polls `callAnalysisJobs` table for queued jobs.
- **Function:** `processNextJob()` — picks next queued job by creation order.
- **Overlap prevention:** `workerRunning` boolean prevents double-start. `jobProcessing` boolean prevents concurrent job processing.
- **Stale recovery:** Every 12 polls (~3 min), runs `recoverStaleJobs()` — resets jobs stuck in "processing" for >5 min.
- **Backoff:** Exponential backoff on consecutive errors (up to 30 poll skip).
- **No auto-stop:** Once started, polls indefinitely even when queue is empty.
- **DB usage:** Direct `workerDb` import via `db` alias + `dbRetry` wrapper.

---

## 4. Activity Tracking

### Client-Side Flush Logic
- **File:** `client/src/hooks/use-activity-tracker.ts`
- **Mechanism:** Module-level queue (`eventQueue`). Events are enqueued via `enqueue()`.
- **Flush triggers:**
  1. `setInterval` every **10 sec** (`FLUSH_INTERVAL = 10_000`) — started when user is authenticated.
  2. `eventQueue.length >= MAX_BATCH` (50) — immediate flush.
  3. `visibilitychange` → hidden — flushes dwell + queue.
  4. `beforeunload` — flushes dwell + queue.
- **Transport:** `navigator.sendBeacon()` preferred, falls back to `fetch()` with `keepalive: true`.
- **Endpoint:** `POST /api/activity` with `{ events: [...] }`.
- **Guard:** `isFlushing` boolean prevents concurrent flushes.

### Server-Side Insert Logic
- **File:** `server/routes/activity.ts:16-52`
- **Function:** `registerActivityRoutes()` → `POST /api/activity`
- **Behavior:** Validates auth, slices to 50 events max, sanitizes each event, then calls `insertActivityLogs()`.
- **Storage:** `server/storage/activityStorage.ts:8-11`
  - `insertActivityLogs()` — single `db.insert(userActivityLogs).values(events)` call via `getDb()`.
  - Uses `getDb()` which returns API pool or worker pool based on `AsyncLocalStorage` context. In the activity route context, this will always be the API pool.

---

## 5. DB Pool Configuration

**File:** `server/db.ts`

| Pool | Variable | min | max | idleTimeout | connectTimeout | statementTimeout |
|------|----------|-----|-----|-------------|----------------|------------------|
| API | `pool` / `db` | 2 | 15 | 30 s | 10 s | 30 s |
| Worker | `workerPool` / `workerDb` | 1 | 5 | 60 s | 30 s | 120 s |

- **Total max connections:** 20 (15 API + 5 Worker).
- **Error handler:** `pool.on("error", ...)` logs idle client errors on both pools.
- **Warmup:** Both pools call `.connect()` + `.release()` at startup to verify connectivity.
- **Context routing:** `AsyncLocalStorage<"worker" | "api">` with `getDb()` / `runWithWorkerDb()` helpers.
- **Retry utility:** `dbRetry()` — up to 3 attempts with 1s/2s/4s delays. Only retries transient errors (timeout, connection reset, etc.).
- **Existing logging:** Error-level only — `pool.on("error")` + `console.error` in warmup. No query-level logging, no pool utilization metrics, no slow-query logging.

---

## 6. Runtime Sharing — API + Workers Same Process

**Confirmed: YES — API server and all background workers share the same Node.js process.**

Evidence from `server/index.ts:340-387` and `server/routes.ts`:
- Most workers are started via `setTimeout(() => import("./services/...").then(...))` inside the same `app.listen()` callback: Front (10s), Slack (20s), Zoom (25s), Google Drive (30s), SEMrush enrichment (15s), LocalDominance (40s), DailyJudgment (50s).
- Call Analysis worker is started during route registration (`registerCeoToolsRoutes` → `server/routes.ts:57`), before the server begins listening — still the same process.
- The `jitter()` function adds 0-5000ms random delay to stagger the setTimeout-based workers.
- All workers use `setInterval` within the same event loop — no child processes, no separate worker threads, no cluster module.

**Implication:** All workers compete for the same event loop. CPU-heavy work (call analysis transcription) can block API responsiveness. DB connections are split (API pool max 15, Worker pool max 5) but share the same process memory.

---

## 7. Query Library Capabilities

**File:** `client/src/lib/queryClient.ts`
**Library:** `@tanstack/react-query`

### Global Defaults (lines 84-96)
```
queries: {
  queryFn: getQueryFn({ on401: "throw" }),
  refetchInterval: false,
  refetchOnWindowFocus: false,     ← Already disabled globally
  staleTime: 5 * 60 * 1000,       ← 5 minutes
  gcTime: 10 * 60 * 1000,         ← 10 minutes
  retry: false,                    ← No automatic retries
}
```

### Relevant Capabilities for Throttling

| Capability | Current State | Available? |
|------------|---------------|------------|
| **staleTime** | 5 min global default | Yes — can be overridden per-query |
| **refetchOnWindowFocus** | `false` globally | Already optimal — no tab-switch refetch storms |
| **refetchInterval** | `false` globally | Can be set per-query for polling (unused currently) |
| **enabled** | Used in ClientDetail queries (`!!user && !!clientId`) | Can add dependency conditions for deferred loading |
| **Query cancellation** | Not used anywhere | Available via `queryClient.cancelQueries()` and `signal` in queryFn |
| **gcTime** | 10 min global | Can tune per-query |
| **retry** | `false` globally | Already optimal — no retry storms |
| **placeholderData** | Not used | Available for optimistic deferred loading |
| **select** | Not used | Available to avoid re-renders on unchanged data |

### Query Error Handling
- Global `QueryCache.onError` shows toast for non-auth errors.
- Global `MutationCache.onError` shows toast (unless `meta.silent`).
- `formatQueryError()` provides user-friendly messages for 429/5xx/auth/network errors.

---

## 8. Ambiguities & Flags

1. **Front Sync uses `runWithWorkerDb()` correctly**, but Google Drive and LocalDominance workers import `workerDb` directly as `db`. This is functionally equivalent but inconsistent — `getDb()` calls within those workers would return the API pool, not the worker pool.

2. **Call Analysis worker starts at boot and never stops** — `startWorker()` is called during route registration (`server/routes/ceoTools.ts:172` → `server/routes.ts:57`). It polls every 15s indefinitely even when queue is empty. Consider adding idle detection to pause polling when no jobs are pending.

3. **SEMrush poll loop is a raw fetch loop**, not using react-query's `refetchInterval`. This means it bypasses staleTime, gcTime, and deduplication. Replacing with `refetchInterval` on the query would be cleaner.

4. **Activity tracking `getDb()`** — called from the POST route handler context (no `runWithWorkerDb` wrapper), so it correctly uses the API pool. However, if activity inserts ever move to a background task, the context would need updating.

5. **No pool utilization metrics** — neither pool has any instrumentation for active/idle/waiting connections. Adding `pool.totalCount`/`pool.idleCount`/`pool.waitingCount` logging would be the first observability step.

6. **Client detail deferred queries fire immediately** — all four queries in ClientDetail have `enabled: !!user && !!clientId`, meaning they all fire on mount regardless of which tab is active. Tab-gated `enabled` conditions would reduce unnecessary DB load.

7. **Worker staggering is randomized but not coordinated** — Front (10s), Zoom (25s), GDrive (30s), LocalDominance (40s) all start with jitter but their intervals (5m, 5m, 1h, 6h) can still overlap. No inter-worker coordination exists.
