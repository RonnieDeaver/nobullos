# Task #222 — Perf Post-Merge Stabilization Patch: After-Action Report

**Date**: April 12, 2026
**Scope**: 8 production regressions from Tasks #212–#221
**Production domain**: `https://reports.nobullmarketing.com`

---

## Engineering Lesson (Headline Takeaway)

The hardest problems in this patch were not missing gating calls — they were **hidden assumptions in the concurrency system** that silently bypassed safety controls:

1. **Allowlist-based gating**: `acquireDbHeavySlot` skipped counting for any worker name not in `DB_HEAVY_WORKERS`, so newly added worker names passed through unchecked.
2. **Set semantics hiding same-name concurrency**: Using a `Set<string>` for tracking meant two concurrent `retroactiveReprocess` calls saw the same entry and both passed.
3. **Job-state creation before slot acquisition**: Creating a "running" job record before checking the concurrency limit produced orphaned entries on 429 rejection.
4. **Worker-context bypass through direct DB imports**: Seven functions in `operationalClassifier.ts` imported `db` directly instead of using `getDb()`, always hitting the API pool regardless of `runWithWorkerDb` context.

These were all latent design gaps exposed by Tasks #212–#221 adding new callers without the original system anticipating them.

---

## 1. Acceptance Criteria Scoreboard

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | TypeScript compiles clean | **Validated** | `npx tsc --noEmit` passes; build completes |
| 2 | Dead WorkerGate code removed from perfConfig | **Validated** | `perfConfig.ts` contains no `WorkerGate`, `workerGate`, `WORKER_MAX_CONCURRENT`, `WORKER_LOCK_TTL_MS`, or legacy `WORKER_*_DELAY_MS` / `WORKER_JITTER_MAX_MS` constants (all worker timing lives solely in `workerConfig.ts`) |
| 3 | Semrush 429 rate limit handled with backoff | **Implemented** | Code-verified: exponential backoff with Retry-After + jitter + bounded retries + deferred campaign tracking. **Not yet production-verified** — requires next 429 event to confirm |
| 4 | Zoom circuit breaker stops validation spam | **Implemented** | Code-verified: 3-failure limit, 30-min backoff, auth-only trigger, token-reset clears breaker. **Not yet production-verified** — requires Zoom auth failure to confirm |
| 5 | All DB-heavy paths use worker pool + concurrency gate | **Validated** | Full audit table below; grep confirms all paths wrapped |
| 6 | Pool monitor logs only meaningful output | **Validated** | Single initialization guard (`poolMonitorStarted`), idle suppression, slow-acquire warnings only above threshold |
| 7 | Front sync cycle explains skip reasons | **Implemented** | Code-verified: 4 true counters + sample IDs + diagnostic warning. **Not yet production-verified** — requires next Front sync cycle with traffic |
| 8 | No automated regression tests added | **Acknowledged risk** | No test files were created. See §13 below |

---

## 2. Scope of Guarantees: Process-Local vs Global

**All concurrency controls added in this patch are process-local (in-memory).** This includes:

- DB-heavy slot counter/array (`workerConcurrency.ts:activeSlotCount`, `activeSlotOwners`)
- Zoom circuit breaker state (`zoomIntegration.ts:zoomValidationFailures`, `zoomValidationBackoffUntil`)
- Semrush `backgroundRefreshRunning` flag and `enrichmentStartedAt`
- Front sync `clientMatchingRunning` flag
- Bulk classify `bulkClassifyJobs` Map

**Why this is acceptable today**: The application is deployed as a single-process Node.js server on Replit (no cluster module, no multi-instance scaling, `.replit` deployment config has no replica settings). There is no multi-instance runtime.

**Deploy overlap risk**: During a deploy, the old process receives SIGTERM and the new process starts. Since all state is in-memory, the new process starts with clean state (zero slots held, breakers reset, no running flags). This means:
- **Safe**: Old process's held slots die with it; new process starts with full capacity.
- **Risk window**: If the old process is mid-batch-operation when killed, the DB operation is interrupted (not completed or rolled back unless transactionally wrapped). The new process does not know about the interrupted operation.
- **Mitigation**: `dbRetry` (L160-189 in `db.ts`) handles "terminating connection" errors with 3-attempt retry + exponential backoff. Worker locks in `workerLock.ts` use TTL (15min) so stale locks from a killed process auto-expire.

**If multi-instance deployment is ever introduced**, the slot counter, Zoom breaker, and Semrush overlap guard would all need to move to shared state (Redis or database-backed). This is called out as an explicit non-goal of this patch.

---

## 3. Concurrency Model Remaining Footguns

### Allowlist bypass: Fail-closed

**Fixed.** `acquireDbHeavySlot` now **rejects** unknown worker names (returns `false`) and logs an error:

```
[WorkerConcurrency] ✖ acquireDbHeavySlot REJECTED unknown worker "someNewWorker" —
not in DB_HEAVY_WORKERS set. Add it to workerConfig.ts to allow this caller.
```

This eliminates the class of bug entirely. A new DB-heavy caller with an unregistered name will be blocked and logged, not silently passed through. The fix is to add the name to `DB_HEAVY_WORKERS` in `workerConfig.ts`.

### Slot ownership: Canonical `withDbHeavySlot` wrapper now exists

**Fixed.** A new `withDbHeavySlot(worker, fn)` wrapper in `workerConcurrency.ts` handles acquire + execute + release atomically:

```typescript
const outcome = await withDbHeavySlot("retroactiveReprocess", async () => {
  return runWithWorkerDb(() => doWork());
});
if (!outcome.acquired) { /* rejected — limit reached */ }
// slot is guaranteed released, even on exception
```

**Migrated callers** (now use `withDbHeavySlot`):
- `startPeriodicSpamCleanup` — periodic interval
- `startPeriodicClientMatching` — periodic interval
- `reprocess-dismissed` route — admin action
- `retroactive/:clientId` route — admin action
- Contact add/update `setImmediate` — fire-and-forget background work

**Callers still using manual acquire/release** (with `try/finally`):
- `bulk-classify` route — fire-and-forget pattern requiring synchronous 429 check before async IIFE. Uses `try/finally` in the IIFE.
- `front_sync`, `zoom_sync`, `local_dominance_sync` — interleave worker lock + slot + running-flag management. `try/finally` covers the slot release in each case.

**Result**: 5 of 8 non-worker-sync paths now use the leak-proof wrapper. The remaining 3 have structural reasons they can't use it cleanly but retain correct `try/finally` handling.

### Re-entrancy: AsyncLocalStorage-based context ownership

**Fixed.** `withDbHeavySlot` uses `AsyncLocalStorage<Set<string>>` to track which slots are owned by the **current async call chain**, not by global name lookup. This correctly distinguishes between:

- **True re-entrancy** (same call chain, same or different worker name): Detected via `slotContextStorage.getStore()` having any owned slots. The inner call skips acquisition and runs directly — no double-counting, no deadlock. This covers both same-name nesting and cross-name nesting (e.g., `front_sync` calling into `retroactiveReprocess`).
- **Independent concurrency** (different call chains): Each call independently attempts `acquireDbHeavySlot`. Two concurrent `retroactiveReprocess` calls from different requests will each consume a slot, correctly enforcing the global limit.

```typescript
const ctx = slotContextStorage.getStore();
if (ctx && ctx.size > 0) {
  const result = await fn();       // re-entrant: skip acquisition
  return { acquired: true, result };
}
if (!acquireDbHeavySlot(worker)) {
  return { acquired: false };      // independent: enforce limit
}
const ownedSlots = ctx ?? new Set<string>();
ownedSlots.add(worker);
try {
  const result = await slotContextStorage.run(ownedSlots, fn);
  return { acquired: true, result };
} finally {
  ownedSlots.delete(worker);
  releaseDbHeavySlot(worker);
}
```

Code search still confirms **no current call path actually nests** — all 11 gated paths are leaf-level. But if nesting is ever introduced, it will work correctly without consuming extra slots.

---

## 4. Backpressure Contract by Path

When the DB-heavy limit (2 concurrent) is reached, each path behaves differently:

| Path | Trigger | On rejection | User/operator impact |
|------|---------|--------------|---------------------|
| Bulk classify (admin route) | POST `/api/integrations/bulk-classify` | **Returns HTTP 429** with message "Too many DB-heavy operations running. Try again shortly." | Admin sees error toast; can retry manually |
| Reprocess dismissed (admin route) | POST `/api/integrations/front/reprocess-dismissed` | **Returns HTTP 429** with same message | Admin sees error toast; can retry manually |
| Retroactive reprocess (admin route) | POST `/api/clients/:id/agents/retroactive-reprocess` | **Returns HTTP 429** with same message | Admin sees error toast; can retry manually |
| Retroactive reprocess (contact add) | setImmediate after POST `/api/clients/:id/contacts` | **Silently skips** — `if (!acquireDbHeavySlot(slot)) return;` | Contact is saved (response already sent); background matching is deferred. No user-visible failure. Next periodic sweep will catch it. |
| Retroactive reprocess (contact update) | setImmediate after PUT `/api/clients/:id/contacts/:id` | **Silently skips** (same as above) | Same as above |
| Periodic spam cleanup | setInterval every 15 min | **Skips cycle** with log: `"Skipping periodic run — DB-heavy concurrency limit reached"` | Next cycle runs in 15 min. No user-visible impact. |
| Periodic client matching | setInterval every 10 min | **Skips cycle** with log: `"Skipping periodic sweep — DB-heavy concurrency limit reached"` | Next cycle runs in 10 min. No user-visible impact. |
| Front sync | Worker cycle | Gated at L732; skips with log | Next cycle runs normally |
| Zoom sync | Worker cycle | Gated at L985; skips with log | Next cycle runs normally |
| Local dominance sync | Worker cycle | Gated at L30; skips with log | Next cycle runs normally |

**Key behaviors**:
- Admin routes get explicit 429s (not silent failures).
- Background/periodic paths skip and retry next cycle.
- Contact-triggered reprocessing is fire-and-forget — the primary operation (save contact) always succeeds.

---

## 5. Semrush Lifecycle Guarantees

### Can enrichment cycles overlap?

**No.** The `backgroundRefreshRunning` boolean (L411, L672-673, L701) acts as an in-process mutex:

```
refreshCampaignCache():
  if (backgroundRefreshRunning) return;  // L672 — early exit if already running
  backgroundRefreshRunning = true;       // L673 — claim
  try { ... } finally {
    backgroundRefreshRunning = false;    // L701 — release
  }
```

The scheduled interval (`ensureBackgroundRefreshRunning`, L705-713) fires every 60 minutes. If the previous enrichment is still running when the next interval fires, it returns immediately at L672.

The startup enrichment (`startupEnrichment`, L532-551) also calls `refreshCampaignCache`, so it shares the same mutex. If the startup pass is still running when the first scheduled interval fires, the interval is a no-op.

### Does slower enrichment create partial-state risk?

**Partial enrichment is safe by design.** Each campaign is enriched independently. If a campaign is rate-limited (429), it gets a `SemrushRateLimitError`, is counted as `deferred_429`, and skipped — but all other campaigns proceed normally. The deferred campaign retains its previous cached data (if any) and will be retried on the next cycle.

The cache (`cachedCampaignList`) is updated atomically at L687 after enrichment completes. If enrichment fails entirely (catch at L698), the old cache remains valid.

### Semrush control-flow verification

| Concern | Status | Evidence |
|---------|--------|----------|
| Retry-After header honored? | **Yes** | `apiGet` L130–132: parses `retry-after`, uses `Math.max(retryAfterMs, expDelay)` so server-specified delay always wins if longer |
| Pagination serialized within a campaign? | **Yes** | `fetchAndMapCampaigns` uses sequential `while` loop with `nextPageToken`; no parallel page fetches |
| Max retries bounded? | **Yes** | `SEMRUSH_429_MAX_RETRIES_PER_REQUEST = 3`; loop runs `attempt < maxRetries` then throws `SemrushRateLimitError` |
| Campaigns deferred instead of poisoning cycle? | **Yes** | `SemrushRateLimitError` caught in enrichment loop (L744), increments `deferred429` counter; other campaigns continue |
| Log spam campaign-level not per-request? | **Yes** | 429 responses suppressed from `console.error` (L126–128: `if (res.status !== 429)`); summary logged once per enrichment cycle (L754) |
| Startup delay before first API calls? | **Yes** | `startupEnrichment()` L539–541: waits `SEMRUSH_STARTUP_INITIAL_DELAY_MS` (15s) before first pass |
| No overlapping enrichment passes? | **Yes** | `backgroundRefreshRunning` mutex at L672-673/L701 |

---

## 6. Zoom Circuit Breaker — Complete Behavior

### Control-flow verification

| Concern | Status | Evidence |
|---------|--------|----------|
| All validation entry points share same breaker? | **Yes** | Module-level variables `zoomValidationFailures`, `zoomValidationBackoffUntil` — single `validateConnection()` is the only validation entry point |
| Breaker resets on token/config changes? | **Yes** | `storeTokens()` (L138) calls `clearZoomValidationBreaker()`. Both `exchangeCodeForToken` (OAuth callback, L130) and `refreshAccessToken` (L130) go through `storeTokens`. |
| Manual reconnect (OAuth) bypasses backoff? | **Yes** | OAuth callback → `exchangeCodeForToken` → `storeTokens` → `clearZoomValidationBreaker`. New tokens reset the breaker immediately. |
| Only persistent auth errors trigger breaker? | **Yes** | `isPersistentAuthError()` (L23–33) filters for 401/403/invalid/unauthorized/forbidden/token/expired/revoked; transient network errors return without incrementing (L36–38) |
| Duplicate logs suppressed during backoff? | **Yes** | `recordZoomValidationFailure()` (L43–46) only logs when `errorMsg !== zoomLastValidationError`; during backoff `isZoomValidationInBackoff()` returns early before any API call (L229–231) |
| Resume-from-backoff logged once? | **Yes** | `isZoomValidationInBackoff()` (L15) logs `"Validation backoff expired — resuming validation attempts"` exactly once when timer expires, then resets state |

### UI/status behavior during backoff

When the breaker is active, `validateConnection()` returns `{ valid: false, error: "Validation in backoff — too many consecutive failures" }` (L230). The `all-status` endpoint (L35-37) catches this and reports `zoomConnected: false`. The Integrations Hub UI shows Zoom as **disconnected** during backoff — there is no distinct "paused" or "cooldown" status exposed to the UI.

**Operator experience**: If Zoom credentials are bad and the breaker trips, the UI shows "disconnected" for up to 30 minutes. The admin can re-authenticate via OAuth at any time, which stores new tokens and immediately resets the breaker. There is no scenario where manual reconnect is blocked by the backoff.

---

## 7. TypeScript Build Fix — Exact Change

**Problem**: `InstrumentedPool.connect()` declared an override with callback parameter typed differently from the base `Pool.connect()` overloads. TypeScript rejected it because the callback's `done` parameter type didn't match the base class signature.

**Before** (did not compile):
```typescript
override connect(
  callback: (err: Error, client: PoolClient, done: (release?: any) => void) => void,
): void;
```

**After** (compiles):
```typescript
override connect(
  callback: (err: Error | undefined, client: PoolClient | undefined, done: (release?: Error) => void) => void,
): void;
```

The key changes:
1. `err` parameter: `Error` → `Error | undefined` (matches base class which passes `undefined` on success)
2. `client` parameter: `PoolClient` → `PoolClient | undefined` (matches base class which passes `undefined` on error)
3. `done/release` parameter: `any` → `Error` (the release function optionally accepts an `Error` to destroy the client)

The callback body (L31–36) correctly guards `if (!err && client)` before calling `logAcquireWait`, preventing undefined access.

---

## 8. Pool Monitor — Validation Detail

| Concern | Status | Evidence |
|---------|--------|----------|
| Interval initialized exactly once? | **Yes** | `poolMonitorStarted` guard (L107, L143–144): `if (!poolMonitorStarted) { poolMonitorStarted = true; setInterval(...) }` |
| Startup confirmation logged? | **Yes** | L146: see example below |
| Periodic summaries only when meaningful? | **Yes** | `logPoolStats()` L118–121: returns `false` (suppresses) when `active === 0 && waiting === 0` and `DB_POOL_STATS_LOG_ONLY_WHEN_ACTIVE` is true |
| High utilization flagged? | **Yes** | L126–128: warns when `utilization_pct > DB_POOL_UTIL_WARN_PCT` (80%) or `waiting >= DB_POOL_WAITING_WARN_COUNT` (1) |

### Example Pool Log Lines

**Startup**:
```
[DB Pool] Monitor started (interval=60000ms, pools=api,worker)
```

**Normal periodic summary** (only printed when pool has active connections):
```
[DB Pool] api: total=5 idle=3 waiting=0 max=18 utilization_pct=11 slow_acquires_in_interval=0
```

**Slow acquire warning**:
```
[DB Pool] ⚠ Slow acquire on api: 245ms (threshold 100ms, active=16, waiting=3)
```

**High utilization warning**:
```
[DB Pool] api: total=18 idle=1 waiting=2 max=18 utilization_pct=94 slow_acquires_in_interval=4 ⚠ HIGH UTILIZATION (>80%)
```

---

## 9. DB-Heavy Gating Audit

### Search Strategy

The audit was produced by three complementary searches:

1. **`grep -rn 'acquireDbHeavySlot\|releaseDbHeavySlot' server/`** — finds all current call sites of the gating functions.
2. **`grep -rn 'runWithWorkerDb' server/`** — finds all worker-pool-context wrappers, cross-referenced against the gating calls to ensure every `runWithWorkerDb` path that does bulk DB work also has slot gating.
3. **`grep -rn 'import.*db\b' server/services/operationalClassifier.ts`** — specifically checked for direct `db` imports in the classifier, since that was the source of 7 bypasses found during review.

Additionally, all call sites of `bulkClassifyUnmatched`, `retroactiveReprocess`, and `reprocessDismissedNonSpam` were traced from route handlers through to their worker-pool context.

### Complete Inventory

| Path | File:Line | Previously API pool? | Previously gated? | Now `runWithWorkerDb`? | Now DB-heavy slot? | Re-entrant safe? |
|------|-----------|---------------------|--------------------|----------------------|--------------------|--------------------|
| `front_sync` main cycle | `frontIntegration.ts:743` | No (already worker) | Yes | Yes | Yes (L732) | N/A — no nesting |
| `startPeriodicSpamCleanup` | `frontIntegration.ts:1565` | **Yes** | **No** | Yes | Yes (L1560) | N/A |
| `startPeriodicClientMatching` | `frontIntegration.ts:1599` | **Yes** | **No** | Yes | Yes (L1591) | N/A |
| `bulkClassifyUnmatched` (route) | `integrations.ts:786` | **Yes** | **No** | Yes | Yes (L779) | N/A |
| `reprocessDismissedNonSpam` (route) | `integrations.ts:753` | **Yes** | **No** | Yes | Yes (L749) | N/A |
| `retroactiveReprocess` (route) | `agents.ts:376` | **Yes** | **No** | Yes | Yes (L372) | N/A |
| `retroactiveReprocess` (contact add) | `agents.ts:42` | **Yes** | **No** | Yes | Yes (L38) | N/A |
| `retroactiveReprocess` (contact update) | `agents.ts:79` | **Yes** | **No** | Yes | Yes (L75) | N/A |
| `zoom_sync` main cycle | `zoomIntegration.ts:997` | No (already worker) | Yes | Yes | Yes (L985) | N/A |
| `local_dominance_sync` | `localDominanceSyncWorker.ts:30` | No (already worker) | Yes | Yes | Yes (L30) | N/A |
| `startupCleanup` (poisoned memory + re-eval) | `index.ts:129` | **Yes** | **No** | Yes | Yes (L129, `withDbHeavySlot("startupCleanup", ...)`) | N/A |
| `operationalClassifier` (7 functions) | `operationalClassifier.ts:1079–1529` | **Yes** (direct `db` import) | **No** | Via `getDb()` context | Runs within caller's slot | N/A |

---

## 10. State Cleanup / Stale-State Migration

### In-memory state (all transient, reset on restart)

| State | Location | Persisted? | Behavior on restart |
|-------|----------|------------|-------------------|
| DB-heavy slot counter + array | `workerConcurrency.ts` | No | Starts at 0/empty — full capacity available |
| Zoom breaker (failure count, backoff timer) | `zoomIntegration.ts` | No | Resets — fresh validation attempt on first poll |
| Semrush `backgroundRefreshRunning` | `semrushApi.ts` | No | Starts `false` — next enrichment runs normally |
| Semrush enrichment cache | `semrushApi.ts` | No | Empty — rebuilt from API on first request |
| Front `clientMatchingRunning` flag | `frontIntegration.ts` | No | Starts `false` — next cycle runs normally |
| Bulk classify job map | `integrations.ts` | No | Empty — no stale "running" entries survive restart |

### Database-persisted state

| State | Table/key | Cleanup needed? | Status |
|-------|-----------|----------------|--------|
| Worker locks | `system_settings` via `workerLock.ts` | Auto-expires via TTL (15 min) | **Self-healing** — stale locks from a killed process expire automatically |
| Front sync page token | `system_settings:front_sync_page_token` | No — valid across restarts | **Safe** |
| Zoom OAuth tokens | `system_settings:zoom_*` | No — persisted credentials | **Safe** |
| Semrush OAuth tokens | `system_settings:semrush_*` | No — persisted credentials | **Safe** |

### Orphaned bulk-classify jobs

**Before this patch**: If the bulk-classify route was called, a "running" job entry was created in the in-memory `bulkClassifyJobs` map *before* checking the DB-heavy slot. If the slot check returned 429, the job entry remained as "running" forever (until process restart).

**After this patch**: Slot acquisition happens at L779 *before* job creation at L784. If the slot is rejected, the route returns 429 immediately with no job entry created. Existing orphaned entries (if any) were cleared on the most recent restart since `bulkClassifyJobs` is in-memory.

---

## 11. Behavior Changes with Downstream Impact

These are intentional semantic changes introduced by this patch that affect operator experience or product behavior:

| Change | Old behavior | New behavior | Impact |
|--------|-------------|-------------|--------|
| Semrush enrichment is slower | 8 concurrent API calls, no startup delay | 2 concurrent, 15s startup delay, 500ms pacing between campaigns | Campaign data appears ~30s later on first load after restart. Reduces 429 risk significantly. |
| Heavy admin actions may be rejected under load | Bulk classify, reprocess-dismissed, retroactive reprocess ran without concurrency limits | Returns HTTP 429 if 2+ DB-heavy operations already running | Admin may need to wait and retry. Error message is explicit. |
| Contact-add/update background matching may be silently skipped | Always ran retroactive reprocess on contact save | Skips if DB-heavy limit reached; periodic sweep catches it within 10 min | Contact save always succeeds; matching is eventually consistent rather than immediate. |
| Zoom intentionally pauses validation for 30 min | Retried on every poll indefinitely | Stops after 3 consecutive auth failures, backs off 30 min | UI shows "disconnected" during backoff. Manual re-auth via OAuth resets immediately. |
| DB pool logs are quieter | Logged every connection acquire and periodic stats even when idle | Only logs slow acquires (>100ms threshold) and stats when pool is active | Fine-grained per-acquire visibility is intentionally gone. Slow-acquire warnings remain. |
| Front sync emits diagnostic summaries | Only logged total/matched/skipped counts | Adds per-reason counters + sample IDs + diagnostic warning | More log volume per cycle, but structured and actionable. |
| Periodic cleanup/matching may skip cycles | Always ran (possibly on API pool) | Skips if DB-heavy limit reached; logs skip reason | Self-heals on next interval (15 or 10 min). No user-visible impact. |

---

## 12. Files Changed

| File | What changed |
|------|-------------|
| `server/db.ts` | Fixed `InstrumentedPool.connect()` overload types; pool monitor single-init guard; idle-suppression for stats logging |
| `server/perfConfig.ts` | Removed `WorkerGate` class, `workerGate` singleton, `WORKER_MAX_CONCURRENT`, `WORKER_LOCK_TTL_MS` duplicates, and dead `WORKER_*_DELAY_MS` / `WORKER_JITTER_MAX_MS` constants (superseded by `workerConfig.ts` `WORKER_STAGGER_OFFSETS`); added Semrush 429, Zoom breaker, Front sample-limit constants |
| `server/services/workerConfig.ts` | Added `bulkClassify` and `retroactiveReprocess` to `DB_HEAVY_WORKERS` set |
| `server/services/workerConcurrency.ts` | Replaced `Set<string>` with counter + array; fail-closed for unknown workers; `withDbHeavySlot` wrapper with AsyncLocalStorage-based re-entrancy detection (cross-worker-name aware) |
| `server/services/semrushApi.ts` | Added `SemrushRateLimitError` class; 429 retry loop with backoff/jitter/Retry-After; startup delay; campaign pacing; enrichment summary with deferred count; overlap guard |
| `server/services/zoomIntegration.ts` | Added circuit breaker (failure counter, backoff timer, `isPersistentAuthError` filter, `clearZoomValidationBreaker` on token store) |
| `server/services/frontIntegration.ts` | Added `skipReasonCounters` + `skipReasonSamples` with bounded cap; diagnostic warning for 0-matched-but-eligible; DB-heavy gating on periodic spam cleanup and client matching |
| `server/services/operationalClassifier.ts` | Changed 7 functions from direct `db` import to dynamic `getDb()` import |
| `server/routes/integrations.ts` | Added `acquireDbHeavySlot`/`releaseDbHeavySlot` + `runWithWorkerDb` to bulk classify and reprocess-dismissed routes |
| `server/routes/agents.ts` | Added `acquireDbHeavySlot`/`releaseDbHeavySlot` + `runWithWorkerDb` to retroactive reprocess routes (3 call sites) |
| `server/index.ts` | Added `runWithWorkerDb` wrapper around startup worker calls |

---

## 13. Constants Changed (Old → New)

| Constant | Old Value | New Value | File |
|----------|-----------|-----------|------|
| `SEMRUSH_ENRICHMENT_CONCURRENCY` | 8 | **2** | `perfConfig.ts` |
| `SEMRUSH_STARTUP_INITIAL_DELAY_MS` | _(did not exist)_ | **15,000** | `perfConfig.ts` |
| `SEMRUSH_CAMPAIGN_START_DELAY_MS` | _(did not exist)_ | **500** | `perfConfig.ts` |
| `SEMRUSH_429_BASE_BACKOFF_MS` | _(did not exist)_ | **5,000** | `perfConfig.ts` |
| `SEMRUSH_429_MAX_BACKOFF_MS` | _(did not exist)_ | **60,000** | `perfConfig.ts` |
| `SEMRUSH_429_MAX_RETRIES_PER_REQUEST` | _(did not exist)_ | **3** | `perfConfig.ts` |
| `SEMRUSH_429_JITTER_MS` | _(did not exist)_ | **1,000** | `perfConfig.ts` |
| `ZOOM_VALIDATION_FAILURE_LIMIT` | _(did not exist)_ | **3** | `perfConfig.ts` |
| `ZOOM_VALIDATION_BACKOFF_MS` | _(did not exist)_ | **1,800,000** (30 min) | `perfConfig.ts` |
| `DB_ACQUIRE_WAIT_WARN_MS` | 100 | **100** (unchanged, now sole source of slow-acquire logging) | `perfConfig.ts` |
| `DB_POOL_STATS_LOG_ONLY_WHEN_ACTIVE` | _(did not exist)_ | **true** | `perfConfig.ts` |
| `DB_POOL_WAITING_WARN_COUNT` | _(did not exist)_ | **1** | `perfConfig.ts` |
| `LOG_SAMPLE_LIMIT` | _(did not exist)_ | **5** | `perfConfig.ts` |
| `FRONT_SKIP_REASON_SAMPLE_LIMIT` | _(did not exist)_ | **5** | `perfConfig.ts` |
| `WORKER_MAX_CONCURRENT` | 3 | **Removed** (was duplicate of `workerConfig.ts`) | `perfConfig.ts` |
| `WORKER_LOCK_TTL_MS` | 900,000 | **Removed** (canonical source: `workerConfig.ts`) | `perfConfig.ts` |
| `DB_HEAVY_WORKERS` | `{front_sync, zoom_sync, local_dominance_sync}` | **+ `bulkClassify`, `retroactiveReprocess`** | `workerConfig.ts` |

---

## 14. Example Log Lines

**Semrush deferred campaign (429)**:
```
[Semrush] Keyword enrichment: attempted=12, succeeded=10, failed=0, deferred_429=2 (rate-limited, will retry next cycle)
```

**Semrush startup pacing**:
```
[Semrush] Startup enrichment: waiting 15000ms before first pass...
[Semrush] Starting proactive campaign enrichment on startup...
[Semrush] Enriching 12 campaigns with keywords (concurrency=2, timeout=30000ms, delay=500ms)
```

**Zoom breaker entered backoff**:
```
[Zoom] Circuit breaker: 3 consecutive auth failures — backing off for 30min (error: Primary: 401 Unauthorized; Fallback: 401 Unauthorized)
```

**Zoom breaker resumed**:
```
[Zoom] Validation backoff expired — resuming validation attempts
```

**Zoom validation succeeded after prior failures**:
```
[Zoom] Validation succeeded — resetting circuit breaker (was at 2 failures)
```

**DB pool monitor started**:
```
[DB Pool] Monitor started (interval=60000ms, pools=api,worker)
```

**DB slow acquire warning**:
```
[DB Pool] ⚠ Slow acquire on api: 245ms (threshold 100ms, active=16, waiting=3)
```

**Front cycle summary with counters**:
```
[Front Sync] Cycle summary: total=47, already_processed=31, matched=8, eligible_unmatched=3, no_client_email=2, classified_operational=3, warmup_spam=0, skipped_total=8, errors=0
[Front Sync]   eligible_unmatched sample IDs (of 3): cnv_abc123, cnv_def456, cnv_ghi789
[Front Sync]   classified_operational sample IDs (of 3): cnv_jkl012, cnv_mno345, cnv_pqr678
```

**Front diagnostic warning (suspicious)**:
```
[Front Sync] ⚠ 0 matched but 3 eligible_but_unmatched — check classifier/matching pipeline
```

**Front diagnostic (benign)**:
```
[Front Sync] 0 matched — all new conversations were operational (expected when most traffic is internal/automated)
```

**DB-heavy slot rejection (periodic)**:
```
[Spam Cleanup] Skipping periodic run — DB-heavy concurrency limit reached
[Client Matching] Skipping periodic sweep — DB-heavy concurrency limit reached
```

---

## 15. Front Sync Explainability — Business Assessment

### Current assessment of "0 matched"

**Not yet conclusively answered.** The instrumentation is now in place to distinguish between:
- **Expected**: all conversations are operational → logged as benign (L1083-1084)
- **Suspicious**: eligible unmatched conversations exist → warning emitted (L1081-1082)

The next production sync cycle with real traffic will produce the evidence needed to determine which pattern applies. The diagnostic warning makes it impossible to miss the suspicious case going forward. This is an instrumentation deliverable, not a root-cause analysis — the root-cause analysis happens when production data comes in.

---

## 16. Remaining Risks & Follow-ups

### ~~Follow-up 1: Allowlist/No-Op Gating~~ — CLOSED

**Resolved**: `acquireDbHeavySlot` now fail-closes on unknown worker names (returns `false` + logs error). See §3 for details.

### ~~Follow-up 2: Token-Based Slot Ownership~~ — CLOSED

**Resolved**: `withDbHeavySlot(worker, fn)` wrapper implemented and migrated to 5 of 8 non-worker-sync paths. See §3 for details. Remaining 3 paths use manual acquire/release with `try/finally` due to structural constraints (interleaved lock management).

### ~~Follow-up 2b: Re-entrancy Detection~~ — CLOSED

**Resolved**: `withDbHeavySlot` now auto-detects re-entrant calls via `isDbHeavySlotHeld(worker)` and skips re-acquisition. See §3 for details.

### Follow-up 3: Front "0 Matched" Root Cause

**Severity**: Low — instrumentation delivered, waiting for data.
**Issue**: Whether the observed "0 matched" pattern is expected (all operational) or suspicious (eligible but unmatched) is not yet determined.
**Action**: Monitor next production sync cycles; if warning fires, investigate matching pipeline.

### Follow-up 4: Automated Regression Tests

**Severity**: Medium — no tests cover the most fragile subsystems.
**Areas**: Same-name slot acquisition, slot release on failure, Zoom breaker auth-only filter, Semrush 429 defer, pool monitor init guard.
**Recommendation**: Create as a standalone task.

### Follow-up 5: Multi-Instance Readiness

**Severity**: Low (not currently multi-instance).
**Issue**: All concurrency controls are process-local. If Replit deployment ever scales to multiple instances, slot counter, Zoom breaker, and Semrush overlap guard would need shared-state backing.
**Action**: No action needed unless deployment model changes.

### Production Verification Gaps

These items are code-verified but **not yet observed in production**:

- Semrush 429 backoff (requires an actual rate-limit event)
- Zoom circuit breaker trip and resume (requires an auth failure sequence)
- Front sync diagnostic warning vs. benign message (requires next sync cycle with traffic)
- Pool monitor idle suppression (requires observation of quiet period)
- No "terminating connection" errors from worker pool (requires sustained operation under load)

### Explicit Non-Goals

- No infrastructure or resource scaling changes (pool sizes unchanged: API=18, Worker=7)
- No changes to scoring formulas, rubric weights, or AI-detection logic
- No schema migrations generated
- No multi-instance coordination (process-local by design for single-instance deployment)
