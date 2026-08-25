# SEMrush Heatmap Pipeline

## Overview
This is the **heatmap + Local Dominance** side of the SEMrush integration: pulling Map Rank Tracker grid data per location, computing baselines (Avg Rank, Coverage, Share of Voice), and rendering GeoJSON for the dashboard. The narrow **mapping-write** side (linking SEMrush campaigns to OS locations and the one Import Write Policy exception) lives in [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md).

## Architecture

### Files
| File | Purpose |
| --- | --- |
| `server/services/semrushApi.ts` | OAuth (device-code flow), low-level Map Rank Tracker REST calls, 429 retry. |
| `server/services/semrushInventorySync.ts` | Reconciles SEMrush campaigns + keywords against the local DB. |
| `server/services/semrushCircuitBreaker.ts` | Trips to "open" on sustained failures so workers don't pin on a sick provider. |
| `server/services/semrushLocationAutoRetryWorker.ts` | Exponential-backoff retry for failed per-location syncs. |
| `server/services/semrushLocationSyncState.ts`, `semrushLocationSyncAttempts.ts` | Per-location state tracking. |
| `server/services/semrushStaleWarningClear.ts` | Clears stale "this location is overdue" warnings once a successful sync lands. |
| `server/services/semrushGhostCleanup.ts` | Removes mappings to campaigns SEMrush no longer returns. |
| `server/services/heatmapService.ts` | Imports raw grid data, computes baselines (Avg Rank, Coverage), generates GeoJSON. |
| `server/services/localDominanceService.ts` | Derived metrics (SoV, competitor ranks) from heatmap snapshots. |
| `server/services/localDominanceSyncWorker.ts` | Orchestrates the recurring Local Dominance sync across active clients. |
| `server/services/heatmapCoverage.ts`, `heatmapCoverageCheck.ts`, `heatmapCoverageCheckAdmin.ts` | Coverage-completeness checks. |

### Queues
- `semrush_inventory_sync` — campaign/keyword reconciliation.
- `semrush_background_refresh` — periodic per-location refresh.
- `local_dominance_sync` — Local Dominance per-client recurring sync.

### Circuit breaker
Open / half-open / closed state lives in `semrushCircuitBreaker`. On open, scheduled SEMrush jobs short-circuit immediately, freeing worker capacity for other queues.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `semrush_access_token` | `system_settings` (secret) | — | OAuth bearer. |
| `semrush_device_code` | `system_settings` | — | Device-flow code (transient during reconnect). |
| `semrush_token_expires_at` | `system_settings` | — | Expiry epoch. |
| `semrush_ghost_cleanup_enabled` | `system_settings` | true | Toggle ghost-mapping cleanup. |
| `semrush_ghost_cleanup_last_run` | `system_settings` | — | Last cleanup run timestamp. |

Circuit-breaker state and per-location retry state live in dedicated tables, not `system_settings`.

## Operational workflows

### Credential rotation / reconnect (device-code flow)
1. From admin Integrations → "Reconnect SEMrush". A device code is issued and stored in `semrush_device_code`.
2. Operator completes the device-code activation in the SEMrush UI.
3. On success, `semrush_access_token` + `semrush_token_expires_at` are written.

### Normal operation
- `semrush_inventory_sync` runs periodically; reconciles campaigns/keywords.
- `semrush_background_refresh` runs per-location grid refreshes on schedule.
- `local_dominance_sync` derives SoV + competitor metrics from the latest snapshots.

### Pause / disable
- Pause `semrush_*` queues via queue-drain control ([WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md)).
- Flip `semrush_ghost_cleanup_enabled` to false to suspend ghost-mapping cleanup during investigation.
- Clearing `semrush_access_token` forces every SEMrush API call to short-circuit.

### Auto-retry behavior
- A failed per-location sync is recorded in `semrushLocationSyncAttempts`.
- `semrushLocationAutoRetryWorker` re-enqueues with exponential backoff until success or terminal failure.
- `semrushStaleWarningClear` clears the "overdue" warning once a successful sync lands.

### Backfill
- For a single location, manually enqueue a `semrush_background_refresh` job for the location's campaign IDs.
- For all locations, the inventory sync run reconciles first, then background refresh sweeps.

### Recovery from common failures
- **401 on SEMrush calls** → token expired or revoked. Reconnect via device-code flow.
- **429 / 5xx spike** → circuit breaker should trip and isolate the failure. If it doesn't, check thresholds.
- **Ghost mapping** (campaign deleted in SEMrush, still mapped locally) → `semrushGhostCleanup` removes it on next run. See [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md) for the mapping-write side.
- **Coverage gaps** → run `heatmapCoverageCheckAdmin` to identify the missing grid cells.

## Alerts and observability
- Standard queue-backlog and pause-baseline alerts apply — see [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md).
- Circuit-breaker state changes are logged.
- Stale-warning UI surfaces per-location overdue conditions to operators.

## Verification
- `SELECT count(*) FROM heatmap_snapshots WHERE created_at > now() - interval '1 day';` — should be non-zero for an active install.
- Inspect `semrush_access_token`'s `semrush_token_expires_at`; should be in the future.
- Trigger one Local Dominance sync for a known client and confirm derived metrics update.

## Legacy keyword-spelling cleanup (Task #2476)

One-press idempotent worker-pool background-drain CEO prod-action
`cleanup_legacy_keyword_spellings` (shared core
`server/services/legacyKeywordSpellingCleanup.ts`, which also drives a CLI)
rewrites legacy non-canonical `heatmap_snapshots.keyword_name` to canonical form
(trim, collapse whitespace, lowercase — mirroring `normalizeKeyword` /
`0061_heatmap_keyword_canonical_check.sql`), then ensures that CHECK constraint
exists. Task #2451 fixed only display; this rewrites the stored data. Converges
to not-needed and self-heals.

## Related runbooks
- [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md) — canonical `applySemrushLocationMapping` helper and the Import Write Policy exception.
- [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) — pausing and rate-limiting SEMrush queues.
- [GEOSPATIAL_APIS.md](./GEOSPATIAL_APIS.md) — basemap (MapTiler) used to render the heatmap.
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- Task #920 family — SEMrush Mapping Policy correction (see SEMRUSH_MAPPING.md).
