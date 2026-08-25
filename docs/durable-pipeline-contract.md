# Durable Pipeline — Event/Result Schema and Dedupe Contract

## Overview

The durable pipeline is the canonical layer between event ingestion (Front, Zoom, Semrush) and the apply layer. All source-specific tasks **must** write to these tables — no child task may invent an alternative schema. These three tables form the single source of truth for event ingestion, result tracking, and apply state.

### Table Relationships

```
source_event_log  ──1:N──►  work_result_log  ──1:N──►  apply_state
     (ingest)                  (compute)                 (apply)
```

---

## Tables

### `source_event_log`

Canonical intake for all external events. One row per deduplicated external event.

| Column | Type | Description |
|---|---|---|
| id | varchar (UUID) | Primary key, auto-generated |
| source_system | varchar | Origin system: `front`, `zoom`, `semrush` |
| source_event_type | varchar | Event kind within the source (e.g. `conversation.updated`, `recording.completed`, `position_report`) |
| source_object_id | varchar | External identifier of the object (e.g. Front conversation ID, Zoom meeting ID) |
| dedupe_key | varchar | **Unique.** Canonical deduplication key (see Per-Source Dedupe Contracts below) |
| payload_json | jsonb | Raw event payload as received from the source |
| normalized_identity_keys_json | jsonb | Extracted identity keys after normalization (e.g. `{ "clientId": "c1", "email": "..." }`) |
| ruleset_version | varchar | Version of the normalization/processing ruleset used |
| status | varchar | One of: `received`, `normalized`, `ready_to_apply`, `applied`, `failed`, `dead_lettered`, `ignored` |
| replayable | boolean | Whether this event can be safely replayed (default: true) |
| correlation_id | varchar | Trace ID linking related events across the pipeline |
| attempt_count | integer | Number of processing attempts so far |
| max_attempts | integer | Maximum processing attempts before dead-lettering (default: 5) |
| error_code | varchar | Machine-readable error code from last failure |
| error_message | text | Human-readable error detail |
| retry_at | timestamp | Earliest time for next processing attempt |
| received_at | timestamp | When the event was first received |
| normalized_at | timestamp | When normalization completed |
| applied_at | timestamp | When all downstream applies succeeded |
| created_at | timestamp | Row creation time |
| updated_at | timestamp | Last modification time |

### `work_result_log`

Durable compute/analysis results produced from source events. One source event may yield multiple results (e.g. a Zoom recording produces both a transcript result and a sentiment analysis result).

| Column | Type | Description |
|---|---|---|
| id | varchar (UUID) | Primary key, auto-generated |
| source_event_id | varchar (FK) | References `source_event_log.id` |
| source_system | varchar | Denormalized source system for efficient filtering |
| result_type | varchar | Kind of result (e.g. `transcript`, `sentiment`, `keyword_ranking`, `conversation_summary`) |
| result_json | jsonb | The computed result payload |
| status | varchar | One of: `pending`, `completed`, `failed`, `dead_lettered` |
| ruleset_version | varchar | Version of the compute ruleset that produced this result |
| correlation_id | varchar | Trace ID for pipeline observability |
| error_code | varchar | Machine-readable error code |
| error_message | text | Human-readable error detail |
| created_at | timestamp | Row creation time |
| updated_at | timestamp | Last modification time |

### `apply_state`

Tracks each attempt to apply a work result to a downstream target. Supports version-aware convergence — an apply is skipped if the target already has a newer version.

| Column | Type | Description |
|---|---|---|
| id | varchar (UUID) | Primary key, auto-generated |
| work_result_id | varchar (FK) | References `work_result_log.id` |
| source_event_id | varchar (FK) | References `source_event_log.id` (denormalized for queries) |
| source_system | varchar | Denormalized source system |
| apply_target | varchar | Where the result is applied (e.g. `client_record`, `report_cache`, `crm_sync`) |
| outcome | varchar | One of: `pending`, `success`, `partial`, `conflict`, `failed`, `skipped` |
| attempt_count | integer | Number of apply attempts |
| max_attempts | integer | Maximum apply attempts (default: 3) |
| ruleset_version | varchar | Version of the apply ruleset |
| applied_version | varchar | Version actually written to the target (for convergence checks) |
| input_hash | varchar | SHA-256 of the input — used to skip re-applies when nothing changed |
| response_json | jsonb | Response from the target system |
| error_code | varchar | Machine-readable error code |
| error_message | text | Human-readable error detail |
| retry_at | timestamp | Earliest time for next apply attempt |
| attempted_at | timestamp | When the last attempt was made |
| completed_at | timestamp | When the apply succeeded |
| created_at | timestamp | Row creation time |
| updated_at | timestamp | Last modification time |

---

## Status State Machines

### Source Event Log

```
             ┌────────────┐
  webhook    │            │
  ────────►  │  received  │
             │            │
             └─────┬──────┘
                   │ normalize
                   ▼
             ┌────────────────┐
             │  normalized    │
             └─────┬──────────┘
                   │ enrich + validate
                   ▼
             ┌────────────────┐
             │ ready_to_apply │
             └─────┬──────────┘
                   │ all apply_state rows → success
                   ▼
             ┌────────────┐
             │  applied   │
             └────────────┘

  Any status ──► failed (retryable, attempt_count < max_attempts)
  Any status ──► dead_lettered (attempt_count >= max_attempts)
  received   ──► ignored (event filtered out by rules)
```

### Work Result Log

```
  pending ──► completed (compute succeeded)
  pending ──► failed (retryable)
  pending ──► dead_lettered (exhausted)
```

### Apply State

```
  pending ──► success (target updated)
  pending ──► partial (some targets updated, others pending)
  pending ──► conflict (target has newer version — resolved by skipping or merging)
  pending ──► failed (retryable)
  pending ──► skipped (input_hash unchanged or target already at this version)
```

---

## Indexes

### `source_event_log`

| Name | Columns | Purpose |
|---|---|---|
| `sel_dedupe_key_idx` | (dedupe_key) UNIQUE | Prevents duplicate event ingestion |
| `sel_status_idx` | (status) | Fast status polling |
| `sel_status_retry_at_idx` | (status, retry_at) | Retry scheduling queries |
| `sel_source_system_idx` | (source_system) | Per-source filtering |
| `sel_source_system_type_idx` | (source_system, source_event_type) | Source+type filtering |
| `sel_correlation_id_idx` | (correlation_id) | Trace correlation lookups |
| `sel_received_at_idx` | (received_at) | Time-range queries and retention |

### `work_result_log`

| Name | Columns | Purpose |
|---|---|---|
| `wrl_source_event_id_idx` | (source_event_id) | Join back to source event |
| `wrl_status_idx` | (status) | Status polling |
| `wrl_source_system_idx` | (source_system) | Per-source filtering |
| `wrl_correlation_id_idx` | (correlation_id) | Trace correlation |
| `wrl_result_type_idx` | (result_type) | Filter by result kind |

### `apply_state`

| Name | Columns | Purpose |
|---|---|---|
| `as_work_result_id_idx` | (work_result_id) | Join back to work result |
| `as_source_event_id_idx` | (source_event_id) | Join back to source event |
| `as_outcome_idx` | (outcome) | Outcome polling |
| `as_outcome_retry_at_idx` | (outcome, retry_at) | Retry scheduling |
| `as_source_system_idx` | (source_system) | Per-source filtering |
| `as_apply_target_idx` | (apply_target) | Target-specific queries |

---

## Per-Source Dedupe Contracts

Each source system constructs its `dedupe_key` using a deterministic, stable formula. The key **must** be globally unique across all sources — it is prefixed with the source system name.

### Front

| Event Type | Dedupe Key Formula | Example |
|---|---|---|
| `conversation.created` | `front:conv:{conversation_id}` | `front:conv:cnv_abc123` |
| `message.received` | `front:msg:{conversation_id}:{message_id}` | `front:msg:cnv_abc123:msg_xyz789` |
| `conversation.updated` | `front:conv_upd:{conversation_id}:{updated_at_epoch}` | `front:conv_upd:cnv_abc123:1713024000` |
| `tag.applied` | `front:tag:{conversation_id}:{tag_id}:{applied_at_epoch}` | `front:tag:cnv_abc123:tag_1:1713024000` |

**source_object_id**: Always the `conversation_id` (primary object).

### Zoom

| Event Type | Dedupe Key Formula | Example |
|---|---|---|
| `meeting.ended` | `zoom:mtg:{meeting_id}` | `zoom:mtg:85746321` |
| `recording.completed` | `zoom:rec:{meeting_id}:{recording_id}` | `zoom:rec:85746321:rec_abc` |
| `transcript.completed` | `zoom:txn:{meeting_id}:{transcript_sha256_first16}` | `zoom:txn:85746321:a3f8b2c1d4e5f6a7` |
| `participant.joined` | `zoom:prt:{meeting_id}:{participant_id}:{join_epoch}` | `zoom:prt:85746321:usr_1:1713024000` |

**source_object_id**: Always the `meeting_id` (primary object).

**Transcript hash**: Use SHA-256 of the raw transcript content, truncated to 16 hex characters. This handles the case where Zoom may deliver the same transcript multiple times with different metadata.

### Semrush

| Event Type | Dedupe Key Formula | Example |
|---|---|---|
| `position_report` | `semrush:pos:{campaign_id}:{report_date}:{keyword_sha256_first16}` | `semrush:pos:camp_1:2025-04-13:b7d3e1f4a2c8d9e0` |
| `backlink_report` | `semrush:bkl:{campaign_id}:{report_date}` | `semrush:bkl:camp_1:2025-04-13` |
| `site_audit` | `semrush:aud:{campaign_id}:{audit_id}` | `semrush:aud:camp_1:aud_xyz` |
| `domain_overview` | `semrush:dom:{domain}:{report_date}` | `semrush:dom:example.com:2025-04-13` |

**source_object_id**: The `campaign_id` for campaign-scoped events, or `domain` for domain-scoped events.

**Keyword hash**: Use SHA-256 of the lowercase keyword, truncated to 16 hex characters. This keeps the key a fixed length regardless of keyword length.

---

## Safe Upsert Semantics

All event inserts use **INSERT ... ON CONFLICT (dedupe_key) DO UPDATE** with the following rules:

1. **Payload update**: The `payload_json` is updated to the latest version if the event is still in `received` status. Once normalized or beyond, the payload is frozen.
2. **Status guard**: The upsert only updates if the existing row is in an earlier status than the incoming event would set. This prevents regression (e.g. an `applied` row cannot be moved back to `received`).
3. **Timestamp preservation**: `received_at` is never overwritten — it always reflects the first receipt. `updated_at` is always refreshed.
4. **Attempt count**: Not incremented on upsert — only on actual processing attempts.

### SQL Pattern

```sql
INSERT INTO source_event_log (source_system, source_event_type, source_object_id, dedupe_key, payload_json, ...)
VALUES ($1, $2, $3, $4, $5, ...)
ON CONFLICT (dedupe_key) DO UPDATE SET
  payload_json = CASE
    WHEN source_event_log.status = 'received' THEN EXCLUDED.payload_json
    ELSE source_event_log.payload_json
  END,
  updated_at = NOW()
WHERE source_event_log.status IN ('received')
RETURNING *;
```

---

## Late, Duplicate, and Out-of-Order Event Handling

### Duplicates

Exact duplicates (same `dedupe_key`) are handled by the unique index and upsert semantics. The row is updated per the upsert rules above — no new row is created.

### Late Events

Events arriving after the pipeline has already processed the same `dedupe_key` to a terminal state (`applied`, `dead_lettered`, `ignored`) are handled as follows:

- **If replayable=true on the existing row**: The event is ignored (the upsert WHERE clause prevents regression). A log entry is emitted for observability.
- **If a new version of the same logical event arrives** (different payload but same dedupe_key structure): The ingestion layer should construct a new dedupe_key that includes a version or timestamp component to allow the new version through.

### Out-of-Order Events

Events from the same source may arrive out of order (e.g. `message.received` before `conversation.created`). The pipeline handles this by:

1. **Independent rows**: Each event type has its own dedupe_key, so out-of-order arrival does not cause conflicts.
2. **Normalization-time joins**: The normalization step resolves relationships between events (e.g. linking a message to its conversation) using `source_object_id`, not arrival order.
3. **Missing parent tolerance**: If a child event arrives before its parent, it is normalized with available data. When the parent arrives, a reconciliation pass updates the child's `normalized_identity_keys_json`.

---

## Replay and Reconciliation

### Replay Cursor Persistence

Replay cursors are stored in the `work_queue` table (existing infrastructure) using job type `pipeline_replay`. The `cursor_json` field contains:

```json
{
  "source_system": "front",
  "last_processed_id": "sel_abc123",
  "last_received_at": "2025-04-13T00:00:00Z",
  "batch_size": 100
}
```

### Replay Semantics

1. **Full replay**: Re-process all events for a source system from `received` status. Events already in terminal states are skipped (upsert WHERE clause).
2. **Partial replay**: Re-process events from a specific `received_at` timestamp forward.
3. **Idempotency**: Replay is safe because of dedupe_key uniqueness and status guard upserts. Re-processing an already-applied event is a no-op.

### Reconciliation

Periodic reconciliation jobs (via `work_queue`) scan for:
- Events stuck in `received` or `normalized` for longer than a threshold (default: 1 hour) → re-enqueue for processing.
- Events in `ready_to_apply` with no corresponding `apply_state` rows → create apply_state entries.
- `apply_state` rows in `failed` with `attempt_count < max_attempts` and `retry_at` in the past → re-attempt.

---

## Retention Policy

| Status | Retention | Action |
|---|---|---|
| `applied` | 90 days after `applied_at` | Soft-delete (move to archive table or mark for cleanup) |
| `ignored` | 30 days after `created_at` | Hard delete |
| `dead_lettered` | 180 days (kept for forensics) | Hard delete after review |
| `failed` (terminal) | 90 days after last `updated_at` | Hard delete |
| Active statuses | Indefinite | Retained until terminal |
| `work_result_log` | Follows parent `source_event_log` retention | FK ON DELETE CASCADE — automatic cleanup when parent is deleted |
| `apply_state` | Follows parent `work_result_log` / `source_event_log` retention | FK ON DELETE CASCADE — automatic cleanup when parent is deleted |

Retention is enforced by a scheduled maintenance job in the `work_queue` with job type `pipeline_retention_cleanup`.

---

## Replayability Rules

| Source System | Event Type | Replayable | Reason |
|---|---|---|---|
| Front | conversation.created | Yes | Idempotent upsert to client record |
| Front | message.received | Yes | Message content is immutable |
| Front | conversation.updated | Yes | Last-write-wins on conversation metadata |
| Zoom | meeting.ended | Yes | Meeting metadata is immutable post-end |
| Zoom | recording.completed | Yes | Recording URL is stable |
| Zoom | transcript.completed | Yes | Transcript content is immutable |
| Semrush | position_report | Yes | Point-in-time data, idempotent by date+keyword |
| Semrush | backlink_report | Yes | Point-in-time data, idempotent by date |
| Semrush | site_audit | Yes | Audit results are immutable once generated |

All events default to `replayable=true`. A source adapter may set `replayable=false` for events that trigger side effects (e.g. sending a notification) — in that case, replay will skip re-processing.

---

## Example Row Lifecycles

### Front: New Message Received

```
1. Webhook arrives: POST /webhooks/front { type: "message.received", conversation_id: "cnv_1", message_id: "msg_1" }

2. INSERT source_event_log:
   source_system="front", source_event_type="message.received",
   source_object_id="cnv_1", dedupe_key="front:msg:cnv_1:msg_1",
   payload_json={...}, status="received", received_at=now

3. Normalization worker picks up the event:
   - Extracts identity keys: { clientId: "c1", email: "user@example.com" }
   - Updates: status="normalized", normalized_identity_keys_json={...}, normalized_at=now

4. Validation passes → status="ready_to_apply"

5. INSERT work_result_log:
   source_event_id="sel_1", source_system="front", result_type="conversation_summary",
   result_json={ summary: "Client asked about pricing..." }, status="completed"

6. INSERT apply_state:
   work_result_id="wrl_1", source_event_id="sel_1", source_system="front",
   apply_target="client_record", outcome="pending"

7. Apply worker updates client record → outcome="success", completed_at=now

8. All apply_state rows succeeded → source_event_log status="applied", applied_at=now
```

### Zoom: Recording Completed

```
1. Webhook arrives: POST /webhooks/zoom { event: "recording.completed", meeting_id: "85746321", recording_id: "rec_abc" }

2. INSERT source_event_log:
   source_system="zoom", source_event_type="recording.completed",
   source_object_id="85746321", dedupe_key="zoom:rec:85746321:rec_abc",
   payload_json={...}, status="received"

3. Normalization extracts: { clientId: "c2", meetingHost: "host@company.com" }
   → status="normalized"

4. → status="ready_to_apply"

5. Compute produces two results:
   a. work_result_log: result_type="transcript", result_json={ text: "..." }
   b. work_result_log: result_type="sentiment", result_json={ score: 0.85 }

6. Two apply_state rows created:
   a. apply_target="client_record" (attach transcript)
   b. apply_target="report_cache" (update sentiment dashboard)

7. Both succeed → source_event_log status="applied"
```

### Semrush: Position Report (with Retry)

```
1. Scheduled fetch: GET /api/semrush/positions { campaign_id: "camp_1" }

2. INSERT source_event_log:
   source_system="semrush", source_event_type="position_report",
   source_object_id="camp_1", dedupe_key="semrush:pos:camp_1:2025-04-13:b7d3e1f4a2c8d9e0",
   payload_json={ keyword: "legal services", position: 3, ... }, status="received"

3. Normalization → status="normalized" → status="ready_to_apply"

4. INSERT work_result_log:
   result_type="keyword_ranking", result_json={ keyword: "legal services", position: 3, delta: -1 }

5. INSERT apply_state:
   apply_target="report_cache", outcome="pending"

6. Apply fails (report service unavailable):
   outcome="failed", attempt_count=1, error_code="SERVICE_UNAVAILABLE",
   retry_at=now+backoff

7. Retry succeeds: outcome="success", completed_at=now

8. source_event_log → status="applied"
```

### Duplicate Event Handling

```
1. Front sends message.received webhook for msg_1 (first time)
   → INSERT succeeds, dedupe_key="front:msg:cnv_1:msg_1", status="received"

2. Front sends same webhook again (retry/duplicate)
   → ON CONFLICT (dedupe_key) DO UPDATE: payload_json updated (still in "received"), updated_at refreshed
   → No new row created

3. After normalization, Front sends same webhook a third time
   → ON CONFLICT: WHERE clause prevents update (status is "normalized", not "received")
   → Row unchanged, no-op
```

---

## Relationship to Work Queue

The durable pipeline tables (`source_event_log`, `work_result_log`, `apply_state`) are **data tables** — they store the state of events and results. The existing `work_queue` table is the **execution engine** — it manages the jobs that process these events.

Processing jobs reference pipeline rows via `payload_json`:

```json
{
  "jobType": "pipeline_normalize",
  "payloadJson": {
    "sourceEventId": "sel_abc123",
    "sourceSystem": "front"
  }
}
```

This separation means:
- Pipeline state survives job failures (data is never lost when a job dies)
- Multiple jobs can operate on the same pipeline row (e.g. normalize, then apply)
- The work queue handles scheduling, retries, and lease management — the pipeline tables handle data integrity
