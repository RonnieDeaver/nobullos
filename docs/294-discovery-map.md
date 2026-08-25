# Task 294 — Production Recovery Discovery Map

## Date
April 16, 2026

## Context
Post-merge production issues from Tasks #282–#293. This map documents all identified failure modes,
root causes, fixes applied, and remaining items for child tasks.

---

## Issue 1: Durable Pipeline Bootstrap Silent Failures

**Owner:** Task 294A  
**Severity:** Critical  
**Status:** Blocking — must be fixed first

### Root Cause
Multiple `ensure*` bootstrap functions silently swallow errors, allowing the server to report
healthy startup even when critical database tables or columns are missing.

### Specific Failure Modes

1. **`ensureDurablePipelineColumns()` — Empty catch block (applyPipeline.ts:439-444)**
   - `source_event_log` column additions (`expected_result_count`, `results_finalized_at`) are
     wrapped in a completely empty `catch {}`. If the table doesn't exist or the ALTER fails,
     no log is emitted, no error is thrown, and bootstrap silently continues.

2. **`ensureDurablePipelineColumns()` — front_hydrate_snapshots (applyPipeline.ts:446-464)**
   - Table creation failure is caught and logged as `console.warn` but does not halt startup.
   - Downstream hydrate stage will crash at runtime when it tries to read/write this table.

3. **`ensureFrontSyncEmailsColumns()` (index.ts:65-96)**
   - Per-column errors are caught individually; only non-"already exists" errors are warned.
   - Outer catch logs a warning but does not halt.
   - Reports "columns ensured" even if some columns failed to add.

4. **`ensureTwilioColumns()` (index.ts:99-124)**
   - Same pattern as above. Silent continuation on failure.

5. **`ensureRawCommunicationColumns()` (index.ts:127-152)**
   - Same pattern as above. Silent continuation on failure.

6. **`ensureExternalSourceIdUnique()` (index.ts:155-206)**
   - Catches all errors and logs a warning but returns successfully.
   - Contains a destructive `DELETE` for deduplication that runs without dry-run on production.
   - Only runs in production (`NODE_ENV === "production"`), no dev verification path.

7. **Fire-and-forget bootstrap IIFE (index.ts:673-692)**
   - The entire durable pipeline bootstrap + scheduler start runs inside `(async () => { ... })()`.
   - If `ensureDurablePipelineColumns()` fails, the scheduler still starts.
   - If the scheduler fails, only a `console.warn` is logged — no process exit, no health flag.

### Fixes Applied (Task 294)
- Replaced empty `catch {}` in `ensureDurablePipelineColumns` with explicit error + throw.
- Added table existence checks (`SELECT 1 FROM ... LIMIT 0`) before column additions in all `ensure*` functions.
- All `ensure*` functions now throw on critical failure instead of logging warnings.
- Column failures are tracked and aggregated — if any column fails, the function throws.
- Fire-and-forget IIFE now catches bootstrap failures and halts scheduler startup.
- `ensureExternalSourceIdUnique` now throws instead of silently warning.

---

## Issue 2: Pipeline Event Gaps and Health Verification

**Owner:** Task 294B  
**Severity:** High  
**Status:** Unblocked after 294A

### Root Cause
No startup health check verifies that pipeline tables are populated and functional before
the scheduler starts processing work. Pipeline observability metrics exist
(`frontPipelineMetrics.ts`) but are passive — they report state, they don't enforce it.

### What 294B Must Fix
- Audit the source_event_log, apply_state, and work_result_log tables for gaps.
- Verify pipeline stage transitions are consistent (no orphaned events stuck in intermediate states).
- Confirm the Front pipeline cutover flags are in the expected final state.
- Produce a health verification report.

---

## Issue 3: CallAnalysis Transcription Timestamp Compatibility

**Owner:** Task 294C  
**Severity:** Medium  
**Status:** Unblocked after 294A

### Root Cause
The transcription system uses multiple models (`gpt-4o-mini-transcribe`, `whisper-1`) and external
sources (Rev.ai) with different timestamp formats and reliability characteristics. Timestamp
correction logic in `callAnalysis.ts` must handle:
- Synthetic (evenly-spaced) timestamps from some models
- Drifting timestamps from Rev-based transcripts
- Model fallback chains where timestamp format changes mid-pipeline

### Fixes Applied (Task 294)
- Added `hasSyntheticTimestamps` flag to `transcribeAudio` return type to explicitly mark
  synthetic timestamps so downstream code can trigger correction.
- Added explicit logging when synthetic timestamps are detected during call analysis.
- Hardened `transcribeForTimestamps` whisper-1 fallback: wrapped in its own try/catch with
  explicit error logging instead of letting the outer catch silently return null.

---

## Issue 4: Zombie Job Cleanup and Startup Stale-State Recovery

**Owner:** Task 294D  
**Severity:** Medium  
**Status:** Unblocked after 294A

### Root Cause
The lease recovery system (`recoverStaleLeases()`) runs every 5s during normal operation and is
effective for runtime recovery. However, there is no explicit startup cleanup:
- On restart, the scheduler starts its polling loop, but the first `recoverStaleLeases()` call
  happens inside the normal cycle — there's no dedicated "clean up previous process" step.
- Jobs leased by a previous PID will have up to 5 minutes of stale lease time before recovery.
- No deterministic startup state: the work queue may contain jobs in `leased`/`processing` state
  from a crashed process that haven't expired yet.

### Fixes Applied (Task 294)
- Added `cleanupStaleJobsOnStartup()` to `workScheduler.ts` — resets all leased/processing jobs
  owned by non-current PIDs to pending status before scheduler starts.
- Cleanup is idempotent and safe to rerun.
- Each cleaned job is logged with id, queue, class, and previous owner.
- Called from `server/index.ts` bootstrap IIFE before `startScheduler()`.

---

## Issue 5: Product Canonicalization and Helper Cleanup

**Owner:** Task 294E  
**Severity:** Low  
**Status:** Unblocked after 294A

### Root Cause
Product canonicalization is mostly correct but has residual inconsistencies:

1. **"webinars" vs "webinar"** — `shared/models/commandCenter.ts` uses `"webinars"` (plural)
   in its local `commandPanelProductOptions`, while the canonical system uses `"webinar"`.
   The normalization layer handles this, but the source data is inconsistent.

2. **Client creation route** — `POST /api/clients` parses products via Zod but doesn't
   explicitly call `normalizeProductList()` before insertion. The Command Panel sync path
   does normalize — the creation path should match.

3. **Hardcoded product strings** — Several UI components (`ActionLog.tsx`, `CommandPanel.tsx`)
   reference product strings directly instead of using `PRODUCT_DISPLAY_NAMES` from the
   canonical system.

### Fixes Applied (Task 294)
- Changed `commandPanelProductOptions` from "webinars" → "webinar" in `shared/models/commandCenter.ts`.
- Changed `actionLogImpactedSystems` from "webinars" → "webinar" in `shared/models/commandCenter.ts`.
- Added `normalizeProductList()` call in `POST /api/clients` route (`server/routes/clients.ts`).
- Updated `CommandPanel.tsx` references: all `.includes("webinars")` → `.includes("webinar")`.
- Updated `ActionLog.tsx` impacted systems value from "webinars" → "webinar".

---

## Issue 6: Final Verification and Closure

**Owner:** Task 294F  
**Severity:** N/A (verification only)  
**Status:** Runs last after 294B-294E

### What 294F Must Do
- Verify all fixes from 294A-294E are applied and working.
- Run a production health check covering bootstrap, pipeline, work queue, and product resolution.
- Document what was fixed, what remains deferred, and any external issues.
- Produce the final verification report.

---

## Execution Dependencies

```
294A (bootstrap repair)
  ├── 294B (event gap audit)     ─┐
  ├── 294C (transcription fix)    │── all parallel
  ├── 294D (zombie job cleanup)   │
  └── 294E (product cleanup)     ─┘
                                  │
                                  v
                              294F (verification)
```

## Files of Interest

| Area | Key Files |
|------|-----------|
| Bootstrap | `server/index.ts` (lines 65-206, 670-692) |
| Durable Pipeline | `server/services/applyPipeline.ts` (lines 438-510) |
| Pipeline Metrics | `server/services/frontPipelineMetrics.ts` |
| Work Queue | `server/services/workScheduler.ts`, `server/services/workQueueLease.ts` |
| Repair Dispatcher | `server/services/repairDispatcher.ts` |
| CallAnalysis | `server/services/callAnalysis.ts` |
| Product Resolution | `shared/productResolution.ts`, `server/utils/productResolution.ts` |
| Command Center | `shared/models/commandCenter.ts`, `server/routes/commandCenter.ts` |
| Client Routes | `server/routes/clients.ts` |
