# Durable Pipeline — Controlled Cutover by Source

## Overview

Each source (Front, Zoom, Semrush) is cut over independently from legacy direct-mutation
paths to the new durable compute/apply architecture. Feature flags control every step.
No source may run duplicate live apply paths without explicit shadow-mode enabled.

## Feature Flags

All flags live in `server/perfConfig.ts` and are set via environment variables.
Default: all `false` (legacy behavior unchanged).

| Flag | Env Var | Purpose |
|---|---|---|
| `FRONT_EVENT_INGEST_ENABLED` | `FRONT_EVENT_INGEST_ENABLED` | Enable durable event ingest for Front webhooks |
| `FRONT_RECONCILIATION_ENABLED` | `FRONT_RECONCILIATION_ENABLED` | Enable Front reconciliation via durable pipeline |
| `ZOOM_EVENT_INGEST_ENABLED` | `ZOOM_EVENT_INGEST_ENABLED` | Enable durable event ingest for Zoom webhooks |
| `ZOOM_RECONCILIATION_ENABLED` | `ZOOM_RECONCILIATION_ENABLED` | Enable Zoom reconciliation via durable pipeline |
| `SEMRUSH_INVENTORY_SYNC_ENABLED` | `SEMRUSH_INVENTORY_SYNC_ENABLED` | Enable durable path for Semrush inventory sync |
| `SEMRUSH_REPORT_REFRESH_ENABLED` | `SEMRUSH_REPORT_REFRESH_ENABLED` | Enable durable path for Semrush report refresh |
| `DURABLE_APPLY_ENABLED` | `DURABLE_APPLY_ENABLED` | Master switch for durable apply handlers |
| `LEGACY_DIRECT_MUTATION_FRONT_ENABLED` | `LEGACY_DIRECT_MUTATION_FRONT_ENABLED` | Keep Front legacy path running (for shadow comparison) |
| `LEGACY_DIRECT_MUTATION_ZOOM_ENABLED` | `LEGACY_DIRECT_MUTATION_ZOOM_ENABLED` | Keep Zoom legacy path running (for shadow comparison) |
| `LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED` | `LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED` | Keep Semrush legacy path running (for shadow comparison) |

## Cutover Decision Logic

The `cutoverGuard.ts` module computes a decision per source:

- **All flags false** → legacy behavior continues unchanged (default)
- **Source ingest + DURABLE_APPLY = true, legacy flag = false** → durable-only mode
- **Source ingest + DURABLE_APPLY = true, legacy flag = true** → shadow mode (both paths run, outcomes compared)

## Cutover Order

Execute in this order, one source at a time:

### Step 1: Durable Infrastructure Live
1. Confirm durable schema tables exist (`source_event_log`, `work_result_log`, `apply_state`)
2. Confirm apply handlers are registered and idle
3. Confirm pipeline observability endpoint responds: `GET /api/integrations/pipeline/health`

### Step 2: Front Cutover
1. Set `DURABLE_APPLY_ENABLED=true`
2. Set `FRONT_EVENT_INGEST_ENABLED=true`
3. Set `LEGACY_DIRECT_MUTATION_FRONT_ENABLED=true` (shadow mode)
4. Monitor `GET /api/integrations/pipeline/cutover-status` — verify shadow comparison shows MATCH
5. Confirm dedupe behavior: repeated events produce `deduplicated: true`
6. Confirm no-op apply: already-applied records return `skipped` outcome
7. After confidence period, set `LEGACY_DIRECT_MUTATION_FRONT_ENABLED=false`
8. Verify Front conversations still ingest correctly via durable-only path
9. Optionally enable `FRONT_RECONCILIATION_ENABLED=true` as backup

### Step 3: Zoom Cutover
1. Set `ZOOM_EVENT_INGEST_ENABLED=true`
2. Set `LEGACY_DIRECT_MUTATION_ZOOM_ENABLED=true` (shadow mode)
3. Monitor cutover-status endpoint for zoom shadow comparison MATCHes
4. Confirm dedupe and no-op apply
5. Set `LEGACY_DIRECT_MUTATION_ZOOM_ENABLED=false`
6. Verify Zoom meetings still ingest correctly
7. Optionally enable `ZOOM_RECONCILIATION_ENABLED=true`

### Step 4: Semrush Cutover
1. Set `SEMRUSH_INVENTORY_SYNC_ENABLED=true` and/or `SEMRUSH_REPORT_REFRESH_ENABLED=true`
2. Set `LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED=true` (shadow mode)
3. Monitor cutover-status for semrush shadow comparison
4. Set `LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED=false`
5. Verify heatmap data still syncs correctly

## Monitoring Endpoints

- `GET /api/integrations/pipeline/cutover-status` — shows all flag states, per-source decisions, shadow comparison summary and recent entries
- `GET /api/integrations/pipeline/health` — overall pipeline health metrics
- `GET /api/integrations/work-queue/status` — work queue depths, feature flags, slot budgets

## Rollback

To roll back any source to legacy:
1. Set the source's ingest flag to `false` (e.g., `FRONT_EVENT_INGEST_ENABLED=false`)
2. Legacy behavior resumes immediately (no restart needed since flags are read at runtime)

To disable the entire durable pipeline:
1. Set `DURABLE_APPLY_ENABLED=false`
2. All sources revert to legacy paths

## Shadow Mode Details

When shadow mode is active for a source:
- Both legacy direct-mutation and durable ingest paths execute
- Legacy runs first; durable runs second
- Outcomes are compared and logged to `[CutoverShadow:<source>]`
- Mismatches are logged at WARN level
- Comparison history is available via the cutover-status endpoint
- Shadow log retains the most recent 500 entries in-memory

## Files Modified

- `server/perfConfig.ts` — feature flag definitions
- `server/services/cutoverGuard.ts` — cutover decision logic and shadow comparison tracking
- `server/services/frontIntegration.ts` — dual-path guard on `ingestConversation`
- `server/services/zoomIntegration.ts` — dual-path guard on `ingestMeeting`
- `server/services/localDominanceSyncWorker.ts` — dual-path guard on `syncAllActiveClients`
- `server/routes/integrations.ts` — cutover-status endpoint and flag exposure in work-queue status
