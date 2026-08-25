# Manual-vs-Background Origin Audit (Task #532)

This audit lists every user-triggered ingestion / repair / maintenance entry
point that acquires a workload class slot, and confirms each one annotates the
acquisition with `origin: "user_manual"` so the workload manager's manual
reserve (introduced in #528) protects it from background-backlog starvation.

The contract lives in `server/services/workloadManager.ts`:
- `acquireClassSlot(worker, { origin })`
- `awaitClassSlot(worker, { origin })`
- `withClassSlot(worker, fn, { origin })`

`origin` defaults to `"scheduled_background"` if omitted, so any new manual
entry point added in the future MUST opt in explicitly.

## Ingestion class — reserve actively applies

| Entry point (route / call site)                                      | Worker label              | Annotated? |
| -------------------------------------------------------------------- | ------------------------- | ---------- |
| `POST /api/integrations/local-dominance/sync` (existing #528)        | `local_dominance_sync`    | yes        |
| `POST /api/integrations/promote` (zoom branch)                       | `zoom_sync`               | yes (via `ingestMeeting({ origin })`) |
| `POST /api/clients/:id/communications/ingest-zoom` (single meeting)  | `zoom_sync`               | yes (via `ingestMeeting({ origin })`) |
| `POST /api/clients/:id/communications/ingest-zoom` (recent batch)    | `zoom_sync`               | yes (via `ingestRecentMeetings({ origin })`) |
| `GET  /api/integrations/zoom/discover`                               | `zoom_sync`               | yes (via `discoverUnmatchedRecordings({ origin })`) |
| `POST /api/semrush/inventory/sync`                                   | `semrush_inventory_sync`  | yes (newly registered as ingestion + wrapped in `withClassSlot`) |

Notes:
- `semrush_inventory_sync` was previously unregistered in `workerClassMap` and
  the manual route did not acquire any class slot at all, so background
  ingestion could effectively crowd out the resources it needed. It is now
  registered as `ingestion` and the manual route wraps `runInventorySync()` in
  `withClassSlot(..., { origin: "user_manual" })`.
- The Zoom service's three internal `awaitClassSlot("zoom_sync")` call sites
  inside `ingestMeeting` and the one inside `discoverUnmatchedRecordings` now
  thread the caller-supplied origin through.

## Interactive_repair / maintenance class — reserve does not currently apply

The manual reserve only protects the `ingestion` class today. The following
user-triggered routes still pass `origin: "user_manual"` through so that:
1. The contract is consistent across all manual entry points.
2. Future per-class reserves (e.g. an `interactive_repair` reserve) will pick
   them up automatically.
3. `getWorkloadOriginMetrics()` correctly attributes their wait times to
   manual work.

| Entry point (route)                                       | Worker label             | Class               | Annotated? |
| --------------------------------------------------------- | ------------------------ | ------------------- | ---------- |
| `POST /api/integrations/front/reprocess-dismissed` (dry)  | `frontSyncReprocess`     | interactive_repair  | yes        |
| `POST /api/integrations/front/rematch-all` (dry)          | `frontRematchAll`        | interactive_repair  | yes        |
| `POST /api/integrations/front/rematch-all` (legacy direct)| `frontRematchAll`        | interactive_repair  | yes        |
| `POST /api/integrations/front/decontaminate` (dry)        | `agentDecontamination`   | interactive_repair  | yes        |
| `POST /api/integrations/front/decontaminate` (legacy)     | `agentDecontamination`   | interactive_repair  | yes        |
| `POST /api/integrations/bulk-classify` (legacy direct)    | `bulkClassify`           | maintenance         | yes        |

## Out of scope — already routed through the work scheduler

These manual routes don't acquire class slots directly; they enqueue a job and
the scheduler/repair-dispatcher acquires the slot when it picks the job up.
Origin propagation through the queue is intentionally not part of this task.

- `POST /api/integrations/front/reprocess-dismissed` (non-dryRun) — enqueues
  via `reprocessDismissedNonSpamProducer`.
- `POST /api/integrations/front/rematch-all` (non-dryRun, queue path) —
  enqueues via `rematchAllProducer`.
- `POST /api/integrations/front/decontaminate` (non-dryRun, queue path) —
  enqueues via `submitRepairJob`.
- `POST /api/integrations/bulk-classify` (queue path) — enqueues via
  `submitRepairJob`.
- `POST /api/semrush/campaigns/:id/refresh` — enqueues a
  `semrush_report_refresh` job.

## Tests

- `tests/local-dominance-manual-reserve.test.ts` — original #528 coverage for
  `local_dominance_sync`.
- `tests/manual-origin-other-syncs.test.ts` — new: verifies `zoom_sync` and
  `semrush_inventory_sync` manual acquires cannot be starved by saturated
  background ingestion, and that `semrush_inventory_sync` stays registered as
  the `ingestion` class.
