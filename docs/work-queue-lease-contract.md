# Work Queue — Lease Contract & Row Lifecycle

## Overview

The `work_queue` table is the canonical source of truth for all queued repair/backfill work. No other table or abstraction should be used for queue semantics. All jobs flow through this table using the lease model described below.

## Table Schema

| Column | Type | Description |
|---|---|---|
| id | varchar (UUID) | Primary key, auto-generated |
| queue_name | varchar | Human-readable queue name (e.g. `"reindex_client"`) |
| job_type | varchar | Specific job kind (e.g. `"reindex_client"`, `"fix_orphan_comms"`) |
| priority | integer (0–9) | Lower number = higher priority. Default 5 |
| status | varchar | One of: `pending`, `leased`, `processing`, `completed`, `failed` (reserved), `dead_letter`, `cancelled` |
| payload_json | jsonb | Arbitrary job payload |
| dedupe_key | varchar | Optional unique key to prevent duplicate enqueues for active jobs |
| cursor_json | jsonb | Checkpoint data for resumable jobs |
| attempt_count | integer | Number of lease acquisitions so far |
| max_attempts | integer | Maximum attempts before dead-lettering. Default 3 |
| retry_at | timestamp | Earliest time this job can be re-leased after a failure |
| lease_owner | varchar | Identifier of the worker holding the lease |
| lease_expires_at | timestamp | When the lease expires (reclaimed if not heartbeated) |
| heartbeat_at | timestamp | Last heartbeat from the lease owner |
| error_code | varchar | Machine-readable error code from last failure |
| error_message | text | Human-readable error detail from last failure |
| created_at | timestamp | Job creation time |
| updated_at | timestamp | Last modification time |
| completed_at | timestamp | When the job completed successfully |

## Indexes

| Name | Columns | Purpose |
|---|---|---|
| `wq_status_retry_at_idx` | (status, retry_at) | Fast lookup of jobs eligible for retry |
| `wq_class_status_priority_created_idx` | (workload_class, status, priority, created_at) | Ordered fetch of pending jobs per class |
| `wq_lease_expires_at_idx` | (lease_expires_at) | Efficient expired-lease reclaim |
| `wq_dedupe_key_idx` | (dedupe_key) WHERE NOT NULL AND status active | Prevents duplicate active jobs with same dedupe_key |

## Status State Machine

```
                    ┌──────────────┐
         enqueue    │              │
      ──────────►   │   pending    │ ◄──── retry (with backoff)
                    │              │
                    └──────┬───────┘
                           │ acquireLease
                           ▼
                    ┌──────────────┐
                    │              │
                    │   leased     │ ◄──── expired lease reclaim (back to pending)
                    │              │
                    └──────┬───────┘
                           │ markProcessing
                           ▼
                    ┌──────────────┐
                    │              │
                    │  processing  │
                    │              │
                    └──┬───────┬───┘
             complete  │       │  failJob
                       ▼       ▼
               ┌───────────┐ ┌──────────────┐
               │ completed │ │ pending      │ (if attempts remain, with backoff)
               └───────────┘ └──────────────┘
                             ┌──────────────┐
                             │ dead_letter   │ (if max_attempts exhausted)
                             └──────────────┘

  Any active status ──► cancelled (via cancelJob)
```

**Note on `failed` status:** The `failed` value is defined in the schema enum and excluded from the dedupe index's active set, but the current lease helpers do not produce it. `failJob` transitions directly to `pending` (retry) or `dead_letter` (exhausted). The `failed` status is reserved for future use cases where a job should be marked as failed without automatic retry or dead-lettering (e.g., manual triage workflows).

## Lease Semantics

### 1. Atomic Acquisition
`acquireLease(workloadClass, leaseOwner, leaseDurationMs, limit)` uses `SELECT FOR UPDATE SKIP LOCKED` to atomically claim jobs without contention. Multiple workers can safely call this concurrently — each gets distinct jobs. Both expired `leased` and expired `processing` jobs are reclaimed.

### 2. Ownership-Safe Transitions
All state transitions that mutate a leased job (`markProcessing`, `heartbeat`, `completeJob`, `failJob`, `saveCursor`) require the caller to pass their `leaseOwner` identity. The UPDATE will only succeed if:
- The job's `lease_owner` matches the caller
- The job's `lease_expires_at` has not passed (except `failJob`, which allows a worker to fail its own job even at expiry)

This prevents stale or different workers from mutating another worker's job.

### 3. Expired Lease Reclaim
If a worker crashes or fails to heartbeat, its lease expires. The next `acquireLease` call (or explicit `reclaimExpiredLeases`) picks up expired `leased` and `processing` jobs and returns them to `pending`.

### 4. Heartbeat Extension
`heartbeat(jobId, leaseOwner, extensionMs?, cursorJson?)` extends the lease expiry and optionally saves progress. Workers should heartbeat at intervals shorter than the lease duration.

### 5. Max Attempts → Dead Letter
When `failJob` is called and `attempt_count >= max_attempts`, the job transitions to `dead_letter` instead of retrying. Dead-lettered jobs are preserved for manual inspection and replay. The retry vs. dead-letter decision is computed atomically in a single UPDATE using a SQL CASE expression — no read-then-write race.

### 6. Retry with Exponential Backoff
Failed jobs that still have attempts remaining get `retry_at` set with exponential backoff (`base * 2^(attempt-1)`) plus jitter (30%), computed in SQL. This prevents thundering herd on transient failures.

### 7. Deduplication
The `dedupe_key` column has a partial unique index that is active only for non-terminal statuses. This means:
- Enqueuing a job with a `dedupe_key` that already exists in `pending/leased/processing` state will fail (unique constraint violation).
- Once a job completes, is dead-lettered, or is cancelled, the same `dedupe_key` can be reused.

### 8. Explicit Lease Release
`releaseLease(jobId, leaseOwner)` returns a leased/processing job back to `pending` without counting it as a failure. Use this when a worker decides it cannot handle a job but the job itself is not broken (e.g., resource contention, graceful shutdown). The `attempt_count` is not reset — it was incremented on acquire. Cursor data is preserved for the next worker.

### 9. Cancellation
`cancelJob(jobId)` moves any active job (`pending`, `leased`, `processing`) to `cancelled`. The lease is released. Does not require lease ownership — cancellation is an administrative action.

### 10. Cursor / Checkpoint Persistence
Long-running jobs can save progress via `saveCursor(jobId, leaseOwner, cursorJson)` or by passing `cursorJson` to `heartbeat`. If the job is retried, the cursor is available so it can resume from where it left off.

## Example Row Lifecycle

### Happy Path: Successful Job

```
1. enqueueJob({ workloadClass: "repair", jobType: "reindex_client", payloadJson: { clientId: "c1" } })
   → Row created: status=pending, attempt_count=0

2. acquireLease("repair", "worker-1", 120000)
   → status=leased, lease_owner="worker-1", lease_expires_at=now+2min, attempt_count=1

3. markProcessing("job-id", "worker-1")
   → status=processing

4. heartbeat("job-id", "worker-1", 120000, { progress: 50 })
   → lease_expires_at extended, cursor_json={ progress: 50 }

5. completeJob("job-id", "worker-1")
   → status=completed, completed_at=now, lease_owner=null
```

### Failure + Retry Path

```
1. enqueueJob({ workloadClass: "backfill", jobType: "fix_orphans", maxAttempts: 3 })
   → status=pending, attempt_count=0

2. acquireLease("backfill", "worker-2")
   → status=leased, attempt_count=1

3. markProcessing("job-id")
   → status=processing

4. failJob("job-id", "worker-2", "TIMEOUT", "External API timed out")
   → status=pending, retry_at=now+~1s, attempt_count still 1 (incremented on next acquire)

5. (after retry_at passes) acquireLease("backfill", "worker-3")
   → status=leased, attempt_count=2

6. failJob("job-id", "worker-3", "TIMEOUT", "External API timed out again")
   → status=pending, retry_at=now+~2s

7. acquireLease("backfill", "worker-1")
   → status=leased, attempt_count=3

8. failJob("job-id", "worker-1", "TIMEOUT", "Still failing")
   → attempt_count(3) >= max_attempts(3) → status=dead_letter
```

### Expired Lease Recovery

```
1. acquireLease("repair", "worker-4")
   → status=leased, lease_expires_at=now+2min

2. Worker-4 crashes, no heartbeat sent

3. (2 minutes later) acquireLease("repair", "worker-5") or reclaimExpiredLeases()
   → Detects lease_expires_at < now, reclaims job
   → status=leased by worker-5 (or back to pending)
```

## Coexistence with Existing Job Tables

The following existing tables have job-like semantics but serve different purposes:

| Table | Purpose | Coexistence Strategy |
|---|---|---|
| `call_analysis_jobs` | Call analysis pipeline with domain-specific fields (audio_url, rev_transcript_json, result_json) | Remains as-is. Its `status` and `attemptCount` are specific to the call analysis workflow. If call analysis needs to be queued through the repair system, a `work_queue` job would reference the `call_analysis_jobs.analysis_id` in its `payload_json`. |
| `slack_sync_history` | Audit log for Slack sync runs | Remains as-is. This is a history/audit table, not a queue. |
| `webhook_import_logs` | Audit log for webhook imports | Remains as-is. This is a log table, not a queue. |
| `raw_communication_records.processing_status` | Per-record processing state | Remains as-is. This tracks individual record state. A `work_queue` job could batch-process multiple records, using `cursor_json` to track progress. |

The `work_queue` table does not replace these tables. Instead, it provides a unified queue for repair and backfill operations that may reference records in these tables via `payload_json`.

## Available Helper Functions

All functions are exported from `server/services/workQueueLease.ts`:

| Function | Signature | Description |
|---|---|---|
| `enqueueJob` | `(opts: EnqueueOptions) → Promise<WorkQueueJob>` | Create a new job |
| `acquireLease` | `(workloadClass, leaseOwner, leaseDurationMs?, limit?) → Promise<WorkQueueJob[]>` | Atomically claim pending/expired jobs |
| `markProcessing` | `(jobId, leaseOwner) → Promise<WorkQueueJob \| null>` | Transition leased → processing (ownership-checked) |
| `heartbeat` | `(jobId, leaseOwner, extensionMs?, cursorJson?) → Promise<WorkQueueJob \| null>` | Extend lease, save progress (ownership-checked) |
| `completeJob` | `(jobId, leaseOwner) → Promise<WorkQueueJob \| null>` | Mark job completed (ownership-checked) |
| `failJob` | `(jobId, leaseOwner, errorCode, errorMessage) → Promise<WorkQueueJob \| null>` | Fail with atomic retry or dead-letter (ownership-checked) |
| `releaseLease` | `(jobId, leaseOwner) → Promise<WorkQueueJob \| null>` | Release lease back to pending without failure (ownership-checked) |
| `cancelJob` | `(jobId) → Promise<WorkQueueJob \| null>` | Cancel an active job (admin action, no ownership check) |
| `reclaimExpiredLeases` | `(batchSize?) → Promise<number>` | Bulk reclaim expired leases |
| `saveCursor` | `(jobId, leaseOwner, cursorJson) → Promise<WorkQueueJob \| null>` | Save checkpoint data (ownership-checked) |
| `getJobsByStatus` | `(workloadClass, status, limit?) → Promise<WorkQueueJob[]>` | Query jobs by class and status |
| `getJob` | `(jobId) → Promise<WorkQueueJob \| null>` | Fetch a single job |
