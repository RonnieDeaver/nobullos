# SEMrush Cadence — Emergency Stabilization Runbook (Task #1784)

Operator runbook for the SEMrush refresh-firehose pause that landed under
Task #1784. The durable demand-driven cadence rewrite is a separate
follow-up task; this document covers what was paused, why, how to verify
it, and how to roll back.

## What was paused

- **`semrush_background_refresh`** — hourly `setInterval` enqueue in
  `server/services/semrushApi.ts` (`enqueueBackgroundRefresh`). Top API
  pool offender via `worker:semrush_background_refresh:enrich_campaigns`.
- **`semrush_report_refresh`** — 4h inventory-sync enqueue in
  `server/services/semrushInventorySync.ts` (`enqueueRefreshWork`,
  `triggerReportRefresh`, and the breaker-deferred re-enqueue inside
  `handleRefreshJob`). Large historical failed/dead-letter backlog.

`semrush_heatmap_apply` is **not** paused — it is the user-visible apply
queue that surfaces heatmap data, so it continues running normally.

## Why

SEMrush refresh was firing on a flat timer regardless of whether anyone
was looking at the data, with downstream apply work accumulating and
dead-letter/lease-churn noise dominating the queue health signals.
Pausing the refresh sources stops the firehose while the durable
cadence rewrite is in flight. Pause note recorded with the action:
`Pool epic — cadence rewrite pending`.

## How the pause works

Two layers, both backed by the existing `system_settings.queue_drain_state`
control plane (Task #987):

1. **Claim-side** — `workScheduler.dequeueForClass` already calls
   `isQueuePaused(name)` and skips paused queues.
2. **Enqueue-side** (added by Task #1784) — every SEMrush refresh
   enqueue site short-circuits when the queue is paused, logging
   `semrush_refresh_enqueue_skipped_queue_paused` (worker logger). The
   hourly background-refresh `setInterval` and the 4h inventory-sync
   timer continue to fire; they just no-op until the queue is resumed.
   A defense-in-depth `handler_skipped_queue_paused` log fires from
   `workQueueHandlers.ts` if a row was claimed in the narrow window
   before the pause state hot-reloaded in that worker.

The `manual` trigger on `triggerReportRefresh` is the documented
escape hatch — it bypasses the pause guard so the Operations Console
"Refresh now" button still works for a one-off forced probe during the
pause window.

## How to run the stabilization plan

```bash
# Dry-run baseline snapshot only:
tsx scripts/semrush-emergency-stabilization.ts

# Dry-run the full plan (baseline → pause → archive → drain → baseline):
tsx scripts/semrush-emergency-stabilization.ts --stage=all

# Commit each stage individually (recommended for first prod run):
tsx scripts/semrush-emergency-stabilization.ts --stage=pause       --apply
tsx scripts/semrush-emergency-stabilization.ts --stage=archive     --apply
tsx scripts/semrush-emergency-stabilization.ts --stage=apply-drain --apply

# Or do the whole plan in one go:
tsx scripts/semrush-emergency-stabilization.ts --stage=all --apply
```

The script never deletes rows. Historical `failed` / `dead_letter` rows
in the two refresh queues are flipped to `status='cancelled'` with
`error_message` prefixed `[backlog-flush 2026-05] ` so they remain
queryable in the audit trail.

For `semrush_heatmap_apply`, the apply-drain stage is intentionally
**conservative** so it can never cancel the latest-valid pending apply
for a target. Only two buckets are cancelled:

1. `superseded` — a strictly newer pending/leased/processing apply
   row exists for the same `work_result_log.correlation_id`
   (canonical `${campaignId}:${locationId}:${keywordId}:${reportDate}`).
   The newer row already carries fresher data, so dropping the older
   sibling is safe even with refresh paused.
2. `orphan_over_24h` — `payload->>'workResultId'` does **not** resolve
   to a `work_result_log` row (deleted / never written) **and** the
   row was created more than 24h ago. There is literally nothing to
   apply.

A pending apply that is merely >24h old but still the latest for its
target is reported in the candidate breakdown as `keep_latest_old` and
left in place — the apply worker will process it once the backlog
drains. Rows that are currently leased/processing are never touched;
the UPDATE re-checks `status='pending' AND lease_owner IS NULL` at
write time so we cannot clobber a row that was claimed between the
candidate scan and the UPDATE.

## How to verify the pause is working

1. **Queue Drain UI / status dump** — `tsx scripts/queue-drain-status.ts`
   should show both refresh queues with `paused=true` and non-null
   `pausedAt` / `pausedAtBacklog`.
2. **No new pending rows** —
   `SELECT queue_name, COUNT(*) FROM work_queue WHERE queue_name IN ('semrush_background_refresh','semrush_report_refresh') AND status='pending' AND created_at > NOW() - INTERVAL '2 hours' GROUP BY queue_name;`
   should be 0 once the hourly/4h timer ticks under the pause.
3. **Skip logs** — `worker_logs` (or wherever `workerLog` is shipped)
   should contain `semrush_refresh_enqueue_skipped_queue_paused` events
   at the expected cadence (≥1 per hour for `semrush_background_refresh`,
   ≥1 per 4h for `semrush_report_refresh`).
4. **Pool attribution** —
   `worker:semrush_background_refresh:enrich_campaigns` should drop out
   of the top 5 API-pool hold labels on
   `/admin/db-attribution/trends` once the in-flight job finishes.
5. **Heatmap apply is alive** —
   `semrush_heatmap_apply` should continue processing rows; check the
   SEMrush Operations Console.
6. **Lease churn alerts** — the `queue.semrush_refresh.dead_letter_spike`
   alert in `leaseChurnAlerts.ts` only counts `status='dead_letter'`,
   so flipping rows to `cancelled` immediately removes them from the
   spike baseline.

## How to manually force a refresh during the pause

Use the existing Operations Console "Refresh now" button, or call
`triggerReportRefresh(campaignId, "manual")` directly. The `manual`
trigger is intentionally exempted from the enqueue pause guard so
operators can still force a one-off refresh without unpausing the
queue.

## Rollback / unpause

```sql
-- Check current state:
SELECT value FROM system_settings WHERE key = 'queue_drain_state';
```

```bash
# Via API (preferred) — actor is recorded in queue_drain_action audit:
curl -X POST $HOST/api/admin/queue-drain/semrush_background_refresh/resume
curl -X POST $HOST/api/admin/queue-drain/semrush_report_refresh/resume
```

Or call `setQueuePause(queueName, false, actor)` from a one-off script.

After resume, watch:

- API pool utilization (should NOT spike back to pre-pause levels —
  if it does, the cadence rewrite has not landed and you should
  re-pause).
- `work_queue` failed / dead-letter inflow for the two refresh queues.
- Heatmap freshness on the Operations Console.

Rollback should only be used if **refresh starvation creates a more
urgent production issue than the pool pressure that justified the
pause** — usually that means the cadence rewrite has shipped and we are
unpausing under the new system.

## Files changed

- `server/services/semrushApi.ts` — `enqueueBackgroundRefresh`
  pause guard.
- `server/services/semrushInventorySync.ts` — `enqueueRefreshWork`,
  `triggerReportRefresh`, and breaker-deferred re-enqueue pause
  guards.
- `server/services/workQueueHandlers.ts` — handler-side pause
  defense-in-depth for both refresh queues.
- `scripts/semrush-emergency-stabilization.ts` — baseline + pause +
  archive + apply-drain runner.

## Out of scope (handled by follow-up task)

- Demand-driven cadence rewrite.
- Active-client predicates.
- Same-response suppression.
- Changes to `semrushLocationAutoRetryWorker`.
- Mapping policy changes (see `SEMRUSH_MAPPING.md`).

---

# Task #1785 — Demand-Driven Cadence (durable rewrite)

Replaces the timer-driven SEMrush refresh firehose paused by Task #1784
with a two-gate enqueue model: a candidate is only refreshed when the
cached data is **stale** AND the owning client is **active**. Identical
refresh responses are dropped before the heatmap-apply enqueue.

## Two-gate enqueue model

1. **Stale gate** — `lastRefreshedAt` is older than
   `semrush_refresh_staleness_threshold_hours` (default 24 h).
2. **Active gate** — `clients.last_viewed_at` is within
   `semrush_active_client_window_days` (default 14 d). Skipped when the
   caller does not supply a `clientId` (tenant-wide caches).

The decision (and skip reason) is recorded as a daily rollup row in
`semrush_cadence_skip_log` — one row per `(date, queue_name, reason)`.

## Identical-result apply suppression

`semrushInventorySync.handleRefreshJob` hashes each refresh payload via
`hashSemrushResponse` (deterministic JSON sha256). When the hash
matches the row in `semrush_last_applied_hashes` for the same
`(campaign_id, location_id, snapshot_key)`, no `semrush_heatmap_apply`
job is enqueued — the work-result-log row is recorded with
`status='skipped'` and a `skipped_identical_result` skip-log entry. On
successful apply, `recordAppliedHash` writes the new hash.

## Permanent error short-circuit

`semrushLocationSyncState.classifyError` now recognises five new
permanent categories — `missing_place_id`, `mapping_disabled`,
`invalid_mapping`, `auth_config`, `malformed_payload` — alongside the
existing `not_found`. `PERMANENT_ERROR_CATEGORIES.has(...)` rows never
retry, never count toward the auto-retry budget, and dead-letter
immediately with a `terminal:` prefix on `lastError`.

## Long-form auto-retry backoff

When `semrush_auto_retry_backoff` is ON (default), retryable failures
walk the curve `1m → 5m → 30m → 2h → 24h → dead-letter` with ±10%
jitter (`computeLongFormBackoffMs`). When OFF, the legacy short-cycle
backoff (`computeBackoffMs`, 5s base) runs unchanged so rollback is a
single setting flip.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `semrush_background_refresh_interval_ms` | 43_200_000 (12 h) | `setInterval` tick for `semrush_background_refresh`. |
| `semrush_refresh_staleness_threshold_hours` | 24 | Stale-gate threshold. |
| `semrush_active_client_window_days` | 14 | Active-gate window. |
| `kill_switch_semrush_demand_driven_refresh` | true | Master switch. OFF = legacy "always enqueue" fallback. |
| `kill_switch_semrush_auto_retry_backoff` | true | Use long-form curve. OFF = legacy 5s base. |
| `kill_switch_semrush_identical_result_apply_suppression` | true | OFF = always enqueue apply. |

`PERF.SEMRUSH_LOCATION_AUTO_RETRY_TICK_MS` (30 s default) controls the
per-location auto-retry worker tick.

## Cutover

Two equivalent, idempotent paths — either is safe to re-run:

1. **CEO "Apply pending prod writes" panel** (preferred). The
   `cutover_semrush_demand_driven_cadence` action in
   `server/services/prodActionsRegistry.ts` mirrors the script's
   semantics and is wired into the universal one-click apply flow on
   the Integrations Hub. Sub-step failures (e.g. a queue-unpause that
   throws) are promoted to the `error` outcome rather than masked as
   `applied`, and every press lands in the `prod_action_runs` audit
   table.
2. **Operator script.** Run `npx tsx scripts/semrush-cadence-cutover.ts
   --apply` to do the same three steps from the shell: (a) flip the
   three kill switches ON, (b) seed any missing setting defaults
   without clobbering operator overrides, and (c) unpause
   `semrush_background_refresh` + `semrush_report_refresh` via
   `queueDrainControl.setQueuePause`. Defaults to dry-run.

## Admin surface

`/admin/semrush/cadence` (team-lead gated) shows live settings, the
skip-log rollup (today + last 7 d), active-client volume, identical-hash
coverage, and SEMrush queue failed / dead-letter counts.

## Manual override escape hatch

`triggerReportRefresh(campaignId, "manual", ...)` is the documented
exemption: it skips the demand gate and the queue-pause guard so
operators can still force a one-off refresh from the Operations Console
"Refresh now" button when the cadence is otherwise paused.

## Files

- `shared/models/semrushCadence.ts`, `shared/models/heatmap.ts` (permanent error categories).
- `server/services/semrushCadenceGate.ts` — gate, hash suppression, skip-log buffer, long-form backoff curve.
- `server/services/semrushApi.ts` — configurable BG interval + gate at enqueue.
- `server/services/semrushInventorySync.ts` — `triggerReportRefresh` gate + per-keyword hash suppression at apply enqueue.
- `server/services/semrushLocationSyncState.ts` — `classifyError`, `computeActiveBackoffMs`, `getEffectiveMaxAttempts`, `terminal:` prefix on permanent fail.
- `server/services/semrushLocationAutoRetryWorker.ts` — configurable tick.
- `server/services/applyHandlers.ts` — `recordAppliedHash` on success.
- `server/routes/heatmap.ts` — `markClientViewed` on `fetch-heatmap`.
- `server/routes/semrushCadence.ts` + `client/src/pages/admin/SemrushCadence.tsx`.
- `scripts/semrush-cadence-cutover.ts`.
- `server/services/prodActionsRegistry.ts` — `cutover_semrush_demand_driven_cadence` registry action.
- `tests/semrush-cadence-gate.test.ts`.
- `tests/prod-actions-semrush-cadence-cutover.test.ts`.
- `migrations/0073_semrush_demand_driven_cadence.sql`.
