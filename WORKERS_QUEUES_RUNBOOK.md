# Workers & Queues Runbook

Operator runbook for the work-queue scheduler, per-queue drain control, and backlog alerts.

## Overview

NoBull OS uses a fair multi-queue scheduler with in-memory locking and staggered worker startup. Jobs live in the `work_queue` table and are claimed via `FOR UPDATE SKIP LOCKED`.

## Deferred test-failure repair batches

The nightly regression sweep files canonical deferred-verification families into
the existing feedback queue, then selects a **maximum of 10** fresh,
non-ambiguous families for `deferred_failure_repair` handoffs. This is a
bounded daily repair lane, not a test rerun loop and not an automated source
editor.

- **Queued repair debt:** inspect `work_queue` rows whose
  `queue_name = 'deferred_failure_repair'` and status is `pending`. They use
  the normal `repair` workload class, so interactive work, leases, retries,
  fairness, pause controls, backoff, and dead-letter protections all apply.
- **Active repair work:** rows in `leased` or `processing` are being handed to
  the repair lane. Use the normal work-queue status endpoint and lease views;
  do not delete or re-enqueue a row to accelerate it.
- **Awaiting manual diagnosis:** feedback rows from **Deferred Verification**
  that remain pending but have no fresh repair handoff are deliberately
  ambiguous, incomplete, stale, or beyond the daily fan-out cap. They need
  operator diagnosis, not a new automatic queue cycle.

Each pending feedback owner id receives at most one queue handoff, including
after that handoff reaches a terminal queue status. Queue history also enforces
the ten-family limit across replayed or concurrent runs for the same nightly
report day. Later observations refresh the same owner's bounded evidence rather
than creating another repair job.
When the feedback owner resolves, a later failure creates a new owner episode
and can receive a new handoff.

Only a complete authoritative **nightly regression** report can auto-resolve a
deferred owner, and only after it observes that same family/file recovered.
Canary, post-merge, incomplete, malformed, stale, or partial observations
never close repair debt.

## Queue drain control (Task #987)

Per-queue **pause** / **rate-limit** knobs persisted in `system_settings.queue_drain_state`. When a queue is paused via `setQueuePause`, the helper captures pause-time baselines so backlog alerts can fire later:

- `pausedAt` — timestamp the pause was applied.
- `pausedAtBacklog` — `work_queue` pending count at pause time.

## Backlog alerts (Task #998)

`queueDrainBacklogAlerts` watcher fires:

- "paused for X hours" alerts.
- "grew by N since pause" alerts.

Queues paused **before** Task #998 deployed have no baselines, and the watcher logs `decision: "skipped_no_baseline"` for them.

## Pause-baseline backfill (Task #1014)

`scripts/backfill-queue-drain-pause-baselines.ts` fills missing baselines for queues paused before Task #998:

- Fills `pausedAt` with the current timestamp.
- Fills `pausedAtBacklog` with the current `work_queue` pending count.
- Default mode is **dry-run**; pass `--apply` to write.
- Idempotent — already-baselined queues are skipped on re-run.
- **After running with `--apply`, restart the server** so the in-memory queue-drain cache picks up the new values.

## Alerts and observability

- `queueDrainBacklogAlerts` watcher (Task #998).
- `queueStarvationAlerts` watcher.
- `leaseChurnAlerts` watcher (Task #1676 — see below).
- All are tuned via `system_settings` keys listed in `audits/G-docs-findings.md` § 4 (Queue / scheduler section).

## Lease churn root-cause investigation (Task #1676)

### Symptom

The May 20 production health check found growing backlogs across multiple, otherwise unrelated queues (Front webhook normalize/apply, raw_communication_records AI processing, SEMrush refresh) despite recent targeted fixes (#1602, #1050, #952, ...). The cross-queue signal was a spike in `work_queue.error_code` values:

- `stale_lease_exhaustion`
- `max_processing_exhaustion`
- `startup_stale_recovery`

`stale_lease_exhaustion` and `max_processing_exhaustion` are emitted by `recoverStaleLeases` in `server/services/workQueueLease.ts` when a row's `lease_expires_at < now` (or `leased_at + max_processing_ms < now`) and the next attempt would exceed `max_attempts`. `startup_stale_recovery` is emitted by `cleanupStaleJobsOnStartup` in `server/services/workScheduler.ts` for rows whose previous owner left them in `leased`/`processing` with no recent heartbeat.

### Root cause

Graceful shutdown (`server/index.ts` `gracefulShutdown`) stopped the scheduler timer but did NOT release the leases this process was holding for jobs still mid-execution when the SIGTERM arrived. The autoscale deployment target sends SIGTERM on every redeploy / scale-in event, so under normal production cadence:

1. Process gets SIGTERM. Scheduler timer stops. In-flight handlers may still be awaiting external APIs.
2. Grace timer expires after 5s and the process exits.
3. Heartbeats stop. The rows the dead process owned still show `status='leased' | 'processing'`, with `lease_owner = scheduler-<old pid>-<old boot id>`.
4. Next boot calls `cleanupStaleJobsOnStartup`. Within ~10 min the heartbeat threshold is hit and those rows are classified as `startup_stale_recovery` (failed, or `dead_letter` on max attempts) or reset to pending. Either path counts against the cross-queue lease churn metric.
5. Anything that wasn't picked up by that startup sweep falls through to the steady-state `recoverStaleLeases` sweeper after its lease window expires, where the same row can also trip `stale_lease_exhaustion`.

This was the dominant source of the cross-queue churn, not a per-queue handler bug.

### Fix

`workScheduler.releaseInFlightLeasesOnShutdown()` (new). Called from `gracefulShutdown` immediately after `stopScheduler()`, BEFORE the 5s grace period. It stops every active heartbeat timer, then `UPDATE work_queue SET status='pending', leased_at=NULL, lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL WHERE lease_owner = <this process's LEASE_OWNER> AND status IN ('leased','processing')`.

Safety: the terminal-write lease guard added in Task #1048 (`processJobInner`'s `leaseGuard` clause) prevents a still-running handler from clobbering the row after it's been requeued. The next boot's `cleanupStaleJobsOnStartup` becomes a no-op for rows this process owned, eliminating the `startup_stale_recovery` flood that followed every deploy.

### What the fix does NOT do

- It does not change worker concurrency, lease TTL, max_processing_ms, or heartbeat cadence.
- It does not extend the 5s grace timer — a job stuck in a long-running API call still misses the grace window and gets re-queued (correctly, as `pending`) for the next boot to retry. The difference is the row no longer takes the lossy zombie-classification path.
- It does not address legitimate `max_processing_exceeded` (a hung handler exceeding its per-queue ceiling). Those still get reclaimed by the existing `recoverStaleLeases` path and now stand out cleanly in the alert metrics instead of being buried in shutdown noise.

### New regression alerts

`server/services/leaseChurnAlerts.ts` — runs every 5 min, fires Slack alerts via the unified `notifyByType` dispatcher with these notification IDs:

- `queue.scheduler.lease_churn_spike` — cross-queue count of `error_code IN ('stale_lease_exhaustion','max_processing_exhaustion','startup_stale_recovery')` rows in the last 60 min exceeds `lease_churn_alert_per_hour_threshold` (default 25).
- `queue.front_webhook.backlog` — `front_webhook_normalize` or `front_webhook_apply` pending ≥ `lease_churn_backlog_threshold` (default 1,000) AND oldest pending older than `lease_churn_backlog_age_minutes` (default 60).
- `queue.raw_communications.processing_inverted` — `raw_communication_records` rows created in last 30d with `pending > processed` AND oldest pending older than the same age window.
- `queue.semrush_refresh.dead_letter_spike` — combined `semrush_report_refresh` + `semrush_background_refresh` `dead_letter` count grew by ≥ `lease_churn_semrush_dlq_growth_threshold` (default 25) within a rolling 60-min baseline window.

Each alert class has its own in-memory cooldown (default 60 min, tunable via `lease_churn_alert_cooldown_minutes`) so a sustained incident doesn't spam every check interval. The watcher itself is gated by `lease_churn_alerts_enabled` (default true).

### `raw_communication_records` status column (2026-05-26)

Any new probe over `raw_communication_records` must reference its
`processing_status` column (∈ pending/processing/processed/failed). There is
**no** `ai_processing_status` column — an early LeaseChurnAlerts probe used that
guessed name and read nothing.

### Diagnostic SQL

```sql
-- Cross-queue lease churn breakdown for the last 7 days.
SELECT queue_name, error_code, COUNT(*) AS cnt
FROM work_queue
WHERE completed_at >= NOW() - INTERVAL '7 days'
  AND error_code IN (
    'stale_lease_exhaustion',
    'max_processing_exhaustion',
    'startup_stale_recovery'
  )
GROUP BY queue_name, error_code
ORDER BY cnt DESC;

-- Front webhook pending depth and oldest pending age.
SELECT queue_name, COUNT(*) AS pending, MIN(created_at) AS oldest
FROM work_queue
WHERE status = 'pending'
  AND queue_name IN ('front_webhook_normalize', 'front_webhook_apply')
GROUP BY queue_name;

-- Raw communications ratio inversion check.
SELECT
  COUNT(*) FILTER (WHERE ai_processing_status = 'pending')   AS pending,
  COUNT(*) FILTER (WHERE ai_processing_status = 'processed') AS processed,
  COUNT(*) FILTER (WHERE ai_processing_status = 'processing') AS stuck
FROM raw_communication_records
WHERE created_at >= NOW() - INTERVAL '30 days';
```

### Verification window — operator responsibility

Task #1676's "Done looks like" requires a 7-day steady-state observation in production. This code change ships the fix and the alerts. The actual 7-day verification window (lease churn down 90% week-over-week, Front normalize/apply < 100 sustained, SEMrush DLQ growth flat, etc.), the May 19 spike root-cause attribution, the dead-letter row classification (requeue / cancel / keep), and the `front_sync_emails` live-or-retired decision all require production database access and elapsed wall-clock time — they cannot be completed inside the code-only scope of this change. Track those as follow-up operator work, not as part of this PR.

## Verification

- `scripts/queue-drain-status.ts` — read-only status dump for every queue with current pause state and baselines.
- After a baseline backfill `--apply` run, restart the server and confirm a paused queue's row in the queue-drain status output now has non-null `pausedAt` / `pausedAtBacklog`.

## Keywords / grep anchors

`queue_drain_state`, `queue_drain_action`, `queueDrainBacklogAlerts`, `queueStarvationAlerts`, `setQueuePause`, `pausedAtBacklog`, `skipped_no_baseline`, `work_queue`, `FOR UPDATE SKIP LOCKED`.

## Related Task # history

- **Task #987** — per-queue pause / rate-limit knobs.
- **Task #998** — backlog growth + paused-for-X-hours alerts.
- **Task #1014** — one-off backfill for missing pause baselines.
- **Task #1784** — SEMrush emergency stabilization: pauses
  `semrush_background_refresh` and `semrush_report_refresh` via this
  control plane, archives historical failed/dead-letter rows as
  `cancelled` with prefix `[backlog-flush 2026-05] `, and drains
  stale/superseded `semrush_heatmap_apply` pending rows. Operator
  runbook: [SEMRUSH_CADENCE.md](./SEMRUSH_CADENCE.md). The pause is
  enforced at both the scheduler claim site (existing
  `isQueuePaused` check) and at every SEMrush refresh enqueue site
  (so the hourly / 4h timers no-op instead of growing the pending
  pile). Manual `triggerReportRefresh(_, "manual")` is the documented
  exemption.

## Front self-healing coverage loop (Task #1682)

- `runFrontAutoClosureTick` (`server/services/frontAutoClosure.ts`) runs after every `front_analytics_coverage_refresh` tick. It is gated by the queue-drain state defined here: a pause on `front_analytics_coverage_refresh`, `front_webhook_apply`, or `front_webhook_normalize` short-circuits the corresponding auto-closure action.
- The loop also defers when worker leases are flapping on the coverage queue (recent `stale_lease_exhaustion` / `max_processing_exhaustion` / `startup_stale_recovery` terminations). Use the diagnostic queries below to triage lease churn before flipping `front_auto_closure_enabled=false`.
- Full operator runbook: [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md#task-1682-front-self-healing-coverage-loop). Pipeline context: [FRONT.md](./FRONT.md).

## Pool tenancy rule (DB Pool Stability Epic)

All work executed by the scheduler — every queue handler, every `setInterval`
periodic timer, every maintenance sweep, every auto-heal loop, every
SEMrush enrichment job, every rollup, and every `notifyUser()` invoked from
within a worker context — **must** use the `worker` pool, not the `api`
pool. Use `import { workerDb } from "server/db"` directly, or wrap the call
site in `runWithWorkerDb(...)` and let `getDb()` resolve to the worker pool
inside shared helpers via AsyncLocalStorage.

The `api` pool (max 18) is reserved for request-scoped handlers under
`server/routes/*`; the `probe` pool (max 1) is reserved for health-probe
work. Full rules (canonical home) + operator surface:
[RUNBOOKS.md § Audit Surface Runbook](./RUNBOOKS.md#audit-surface-runbook-db-pool-tenancy--external-call-audit)
(`replit.md` § "DB Pool Tenancy Rules" is a one-line pointer only).

### Worker pool concurrency caps

`server/perfConfig.ts` caps per-class concurrency so the worker pool (max
10; global slot cap 9) does not saturate when Phase 2 tenancy fixes move
periodic timers off the api pool. Any retune from the Phase 2 task is
reflected directly in `perfConfig.ts`; the boot warning `global slot cap
(9) leaves <1 spare DB worker connection` is the canary for "you
over-tuned" — if you see it,
either drop a class cap or document the exception in the file's header
comment. The Phase 2 verification note in `docs/pool-epic-verifications/`
records the before/after caps.

## Front Stabilization Epic (Task #1787)

Multi-stage epic to reduce Front-pipeline DB pool pressure and speed
recovery throughput. Stages landed are described here; deferred stages
remain tracked under the task.

### Stage 1 — Analytics coverage cadence (landed)

`front_analytics_coverage_refresh` no longer hard-enqueues every 30
minutes. The 30-minute tick now consults `front_analytics_monthly_coverage`
and short-circuits when nothing is due (`anyMonthDueForRefresh()`). Five
new settings drive per-month due-checks — `front_analytics_measurement_refresh_enabled`
(master, default ON), `_current_month_refresh_interval_hours=6`,
`_incomplete_month_refresh_interval_hours=24`,
`_finalized_month_skip_enabled=true`,
`_plan_limited_reprobe_interval_days=7`. The tick also short-circuits
when the queue is paused (`front_analytics_refresh_enqueue_skipped_queue_paused`
log).

### Stage 2 — Stale-backlog cancellation (operator-run)

`scripts/cancel-stale-front-backlog.ts` cancels `failed` + `dead_letter`
rows across the four Front queues. Pending and processing rows are
never touched. `--apply` flips the actual UPDATE inside a transaction;
default is dry-run. `error_message` gets prefix `[backlog-flush 2026-05] `
for auditability. Idempotent — re-running finds zero candidates.

```
# dry-run first
tsx scripts/cancel-stale-front-backlog.ts
# then apply
tsx scripts/cancel-stale-front-backlog.ts --apply
```

Re-baseline `work_queue` counts after applying.

### Stage 3 — DB-hold split (landed)

Two production hot paths split into shorter, labelled hold windows:

- **`reprocessSyncEmailBatch`** (`server/services/frontIntegration.ts`)
  — collapses the per-ID `storage.getFrontSyncEmail()` N+1 into a single
  bulk SELECT under label `front_sync_reprocess:batch:fetch`. The outer
  `front_sync_reprocess` handler label is kept for back-compat.

#### `front_sync_reprocess` convergent dismissed-operational drain (Task #2641)

The **Re-match dismissed-operational Front backlog** prod-action
(`rematch_dismissed_operational_front_backlog`) no longer runs a single serial
advisory-lock loop (which died on every autoscale recycle and only re-armed on a
6h cadence, leaving ~70k `match_status='dismissed_operational'` rows stuck).
Instead `apply` enqueues a durable, fanned-out `front_sync_reprocess` chain:

- The producer (`rematchDismissedOperationalDrainProducer`) enqueues ONE
  enumerate job with payload `{cohort:"dismissed_operational",
  convergeDismissedOperational:true, maxItems, producerVersion}`.
- `handleFrontSyncReprocess` pages the cohort (cursor-ordered by `(createdAt,
  id)`, so processed rows that leave the cohort never reappear — no overlap, no
  double-processing) into distinct id batches, each enqueued WITH
  `convergeDismissedOperational:true`, plus a self-continuation.
- Each batch routes to `rematchDismissedOperationalByIds` (the **convergent**
  per-row path: match → auto_matched + thread-wide attribution; no-match /
  never_match / error → unmatched; operator rule → blocked/dismissed). This is
  why batches use this path and NOT `reprocessSyncEmailBatch`, which only mutates
  matched rows and would never converge the cohort to 0.
- Batches and continuations run on the worker `repair` class, so the drain fans
  out across instances and survives recycles (any instance claims the next
  queued job). Rows stuck in `pipeline_state='failed'` drain naturally — they are
  still `match_status='dismissed_operational'`, so list/count include them and
  the convergent error branch moves them to `unmatched`; they were only "stuck"
  because the old serial loop died before reaching them.
- **Idempotency / watchdog:** `isDismissedOperationalDrainActive()` checks the
  queue for any in-flight (`pending`/`leased`/`processing`) job carrying
  `convergeDismissedOperational='true'`. `apply` is a no-op while a chain is in
  flight (no second overlapping chain); `status` reports `pending` with a "no
  drain chain currently in flight" signal when rows remain but nothing is
  running. The fast self-heal (`cadenceMs: 10m`, `backoffMs: 1h`) re-seeds a
  fully-dead chain quickly instead of waiting 6h.
- **`applyFrontWebhookResult`** (`server/services/frontWebhookIngestion.ts`)
  — three phases:
  - `front_webhook_apply:read` — workResultLog SELECT + dedupe probe.
  - (no hold) — timestamp coercion + filter-rule evaluation + decision.
  - `front_webhook_apply:persist` — createRawCommunication + recordApplyOutcome.

Verification: `/admin/db-attribution/trends` → **Front pipeline labels**
panel (Stage 7A). Healthy steady state shows no Front label in the
"≥ 10s" table.

#### `front_sync_reprocess` unmatched-backlog re-match drain (Task #4049)

The **Re-match unmatched Front backlog** prod-action
(`rematch_unmatched_front_backlog`) reuses the same fanned-out
`front_sync_reprocess` machinery over the `unmatched` cohort, re-running
deterministic-only matching (filter rules + exact-contact + trusted-domain
hard-match, no AI) after **Seed trusted email domains onto client records**
(`seed_client_trusted_email_domains`) populates `clients.email_domains`.
Differences from the dismissed-operational drain:

- Producer payload flag is `rematchUnmatchedBacklog:true` (dedupe
  `producer:unmatched_backlog_rematch:v{N}`); batches route to
  `rematchUnmatchedBacklogByIds` — the **non-convergent** per-row path. Rows
  legitimately REMAIN `unmatched` (automated-sender-only evidence, freemail,
  ambiguous domains), so termination is **cursor exhaustion**, never cohort
  emptiness; per-row errors leave the row untouched for the next press.
- No self-heal and no re-press loop: the intended flow is press after seeding
  or editing client domains. `isUnmatchedBacklogRematchActive()` makes a
  re-press while a chain is in flight a no-op.
- The producer captures baseline `unmatched`/`auto_matched` counts. The
  TERMINAL enumeration page (normal case: a partial page) enqueues a durable
  finalize-only continuation at lower scheduling precedence than the batches;
  its settle-gate re-enqueues itself (`retryAt`-delayed) while any fan-out
  batch of the chain is still pending/leased/processing, so the before/after
  lift written to `prod_action_runs` reports SETTLED post-apply counts —
  exactly once per chain version (marker-probe idempotence across queue
  retries). Terminally failed batches release the gate, so a poisoned batch
  cannot stall the finalizer.
- Guardrail: the trusted-domain tier only accepts HUMAN sender evidence —
  no-reply/notification/newsletter traffic riding a client's own domain gets
  `[automated_senders_only_no_autoclaim…]` and stays unmatched.

### Stage 4 — Tuning flip + concurrency ramp (UI or operator-run)

**Preferred path: UI.** The Front Historical Recovery admin panel
(`/admin/integrations/front` → "Recovery throughput" section) exposes
both knobs to Team-Lead+ via
`GET/PUT /api/integrations/front/historical-recovery/tuning`:
the ingest-concurrency input (1–5) and the Phase 3 tuning ON/OFF
toggle, with `LastEditedBadge` attribution and an activity-log entry
per change.

**Script path** (equivalent, still supported for headless ops):
`scripts/flip-front-recovery-tuning-on.ts` flips the same two settings:

- `front_recovery_pool_threshold_tuning_enabled = "true"` — hysteresis
  backoff (consecutive-samples trip / separate clear), per-page
  consecutive-saturation flag, 500ms→200ms inter-page sleep.
- `front_recovery_ingest_concurrency = "3"` — 1 → 3 ramp. Safe after the
  post-#1787 throughput bump: worker pool 8 → 10, global slot cap 7 → 9
  (`RETROACTIVE_REPROCESS_CONCURRENCY` default 4 → 6). Front per-token
  API rate limit is now the dominant ceiling, not our scheduler.

**Preconditions** (verify before `--apply`):
1. Stage 1 cadence stable (no 30-minute refresh storms).
2. Stage 2 backlog cancellation completed (alert noise quiet).
3. Stage 3 split deployed (`:read` / `:persist` labels appearing in trends).
4. API pool + worker pool headroom in last 24h.

**Watch window after applying:**
- First 30 minutes: API/worker pool utilization, Front recovery pages/min,
  Front 429s, lease-churn alerts.
- After 24h: same metrics + Conversation Hub freshness.

**Rollback** (single setting flip per knob):

```
tsx -e 'import("./server/storage").then(({ storage }) => Promise.all([
  storage.setSystemSetting("front_recovery_pool_threshold_tuning_enabled", "false"),
  storage.setSystemSetting("front_recovery_ingest_concurrency", "1"),
]))'
```

(Or just flip them back from the admin panel — toggle Phase 3 tuning
OFF and save `1` in the concurrency input.)

Concurrency ramps to 3 in Stage 4. The next ceiling is Front's
per-token API rate limit (~50 req/min on most plans → ~5–12k
messages/hour per token), not our scheduler. Further headroom requires
a second Front API token or a higher Front plan quota — not a code
change.

### Stage 5 / Stage 6 — Recovery same-response suppression + active-inbox filter

Wired in `frontHistoricalRecovery.ts` under Task #1789 (kill switches
`front_recovery_same_response_suppression_enabled` and
`front_recovery_active_inbox_filter_enabled`, both default ON, registered
in `poolEpicKillSwitches.ts`). Hot-flip to `"false"` to roll back.

### Stage 7 — Guardrails (landed)

- **7A** — admin trends panel: dedicated **Front pipeline labels** card
  on `/admin/db-attribution/trends` filtering top-holds-today,
  longest-max-holds (7d), and labels-over-10s (7d) to Front labels.
- **7B** — `tests/front-webhook-apply-query-budget.test.ts` pins
  proceed-path ≤ 8 queries and already-exists short-circuit ≤ 5 queries.
  A future N+1 regression in the apply path is a CI-visible failure.

### Stage 9 — Verification

After operator runs Stages 2 + 4, re-capture the Stage 0 baseline
(work_queue counts per Front queue × status; recent
`front_recovery_checkpoint_*` for `db_pool_saturated` occurrences;
trends panel) and confirm: zero failed/dead_letter Front rows;
no Front label in the trends ≥ 10s table; no `db_pool_saturated`
in the past hour's checkpoints.

### Deferred (not in this epic landing)

Stage 2.5 lease-release-on-shutdown is **already wired** at
`server/index.ts:65` via `releaseInFlightLeasesOnShutdown()`. Stage 8
end-to-end soak and Stage 9 prod re-baseline require operator action
after Stages 2 + 4 run in prod.

## Front reconciliation scheduler (Task #1825)

Until Task #1825, the `front_reconciliation` queue had a registered
handler (`runFrontReconciliation` → `handleFrontReconciliation`) but
nothing in the codebase enqueued it on a cadence — the only ways jobs
landed were one-off operator scripts or the manual full-backfill burst.
When the live Front webhook stream silently dropped events
(e.g. the May 18 → May 21 outage), the auto-heal path that pulls
missed conversations off Front's REST API never fired and the gap
kept growing until an operator noticed.

`server/services/frontReconciliationScheduler.ts` runs a `setInterval`
on the worker pool that enqueues a single `front_reconciliation` job
every `FRONT_RECONCILIATION_INTERVAL_MS` (default 15 min):

- **Queue**: `front_reconciliation` (same as before; only the producer
  is new).
- **Workload class**: `ingestion`. Matches the 2026-05-24 re-tag of
  the downstream `front_webhook_normalize` enqueue inside
  `runFrontReconciliation`.
- **Priority**: 250 — between live Front webhooks (50) and the bulk
  historical backfill (300). Reconciliation only runs when there's
  ingestion-class slack.
- **Dedupe**: scheduler ticks use
  `front_reconciliation:scheduled:<bucket>` with
  `bucket = floor(now / FRONT_RECONCILIATION_INTERVAL_MS)` so an
  already-pending or in-flight sweep is never duplicated within the
  same interval. The CEO action uses a separate per-minute manual
  bucket (`front_reconciliation:manual:<minute>`) so back-to-back
  presses coalesce but a real kick 60+ s later still goes through,
  independent of the longer scheduler cadence.
- **Safety gates** (any one no-ops the tick):
  - `PERF.FRONT_RECONCILIATION_ENABLED = false`.
  - `front_reconciliation` queue paused via `queue_drain_state`.
  - `KILL_SWITCH_NON_CRITICAL_SWEEPS = "true"`.
  - Front access token missing (`front_access_token` unset).
- **Boot wiring**: started from the staggered worker cohort in
  `server/index.ts` under offset `WORKER_STAGGER_OFFSETS.front_reconciliation_enqueue`
  (600 s post-boot).

### CEO action — trigger a one-shot sweep

`trigger_front_reconciliation_sweep` in the Integrations Hub →
"Apply pending prod writes" panel enqueues a single
`front_reconciliation` job immediately, independent of the 15-minute
scheduler. Use it when a live-webhook outage is suspected and you
don't want to wait for the next tick. Idempotent (per-minute dedupe
bucket); pre-flight checks skip the press when a sweep is already
pending or any safety gate is closed.

### Backlog drain knob

The 19k-pending `front_webhook_normalize` backlog observed 2026-05-25
drains through the `ingestion` class budget. Operators can raise the
class cap from 3 → 4 → 5 via the existing
`ramp_ingestion_class_concurrency_4` / `_5` CEO actions to accelerate
drain while reconciliation is feeding new work in.

## Front pipeline warp-speed throughput (Task #1829)

**Problem.** In prod the three Front pipeline queues
(`front_webhook_normalize`, `front_webhook_apply`,
`front_reconciliation`) all share the `ingestion` workload class
(class cap = 3–4) and the main scheduler loop dispatches **one job
per class per `pollIntervalMs` tick** (default 1000 ms). That caps
Front throughput at ~1 job/sec even when handlers complete in
<100 ms, which is why a 19,526-row `front_webhook_normalize` backlog
and a 2,573-row `front_webhook_apply` backlog accumulated on
2026-05-24.

**Fix.** A dedicated `front_ingestion` workload class plus a
SECOND scheduler timer (`frontWarpFastPollCycle` in
`server/services/workScheduler.ts`) that polls every 500 ms (default)
and dispatches up to `front_ingestion_per_cycle_dispatch_max` (default
8) Front-queue jobs per tick. The real cap on in-flight Front work
remains the class budget (`front_ingestion_class_concurrency`,
default 4). The fast-poll loop drains by `queue_name IN (…)` rather
than `workload_class = 'front_ingestion'` so the existing
`workload_class='ingestion'` backlog rows drain immediately after
flip — no row-rewrite required.

**Behavior-neutral deploy.** Master switch
`front_warp_speed_enabled` defaults OFF. While off:

  - The fast-poll timer ticks but no-ops (no slot acquired, no
    dequeue).
  - `enqueueJob` does NOT remap Front-queue enqueues, so new rows
    keep landing on `workload_class='ingestion'` exactly as before.

When the operator flips the switch ON:

  - The fast-poll loop starts multi-dispatching Front-queue rows.
  - New Front-queue enqueues are remapped to
    `workload_class='front_ingestion'` so they no longer compete with
    `semrush_background_refresh` etc. for the
    shared `ingestion` budget.

**Strict master-switch semantics (Phase 4).** Two changes make the
master switch a true kill switch (not a rollback mode):

  - The fast-poll loop starts multi-dispatching Front-queue rows.
  - New Front-queue enqueues are remapped to
    `workload_class='front_ingestion'` so they no longer compete with
    `semrush_background_refresh` etc. for the
    shared `ingestion` budget.

### Knobs

Boolean switches (`system_settings`, read via the
`poolEpicKillSwitches` hot-flip cache):

| Switch | Default | Purpose |
| --- | --- | --- |
| `front_warp_speed_enabled` | `true` (Task #1829 intent) or `false` (Behavior-neutral) | Master switch. Off = deploy is no-op. OFF stops the Front pipeline (Phase 4). |
| `front_ingestion_api_waiter_backoff_enabled` | `true` | Inner safety guard for API-pool pressure. Apply-queue back-off when API pool has waiters. |
| `front_ingestion_front_rate_limit_guard_enabled` | `true` | Inner safety guard for Front 429s. Skip cycle on Front 429 spike. |

Numeric settings (`system_settings`, read via
`frontWarpSettings.ts`, 30 s TTL cache):

| Key | Default | Bounds |
| --- | --- | --- |
| `front_ingestion_class_concurrency` | 4 | 1..8 |
| `front_ingestion_manual_reserve` | 1 | 0..4 |
| `front_ingestion_poll_interval_ms` | 500 | 100..10 000 |
| `front_ingestion_per_cycle_dispatch_max` | 8 | 1..32 |
| `front_ingestion_worker_idle_min` | 2 | 0..8 |

The class budget shares the worker-pool `TOTAL_BUDGET` (default 9)
with `ingestion` (3–5), `repair`, `interactive`, `maintenance`,
etc. — 4 + 5 + 1 reserve = 10 nominal demand vs 9 slots, so leave
the global cap or one of the contributing classes alone when
ramping. See the Runtime Truth Table in `replit.md`.

### Cutover

1. Confirm baseline:
   `npx tsx scripts/front-warp-validate.ts`
2. Flip master switch:
   `UPDATE system_settings SET value='true', updated_by=NULL WHERE key='front_warp_speed_enabled';`
   (Or use the CEO action surface — same effect, with audit row.)
3. Re-run the validator. `front_warp_speed_enabled = true` and
   pending counts should start dropping within seconds.

### Rollback

`UPDATE system_settings SET value='false' WHERE key='front_warp_speed_enabled';`

Effect: fast-poll loop becomes a strict no-op. **Front pipeline
stops** until the switch is flipped back on (Phase 4 semantics). In-flight
Front jobs finish normally. Backlog accumulates while OFF.
New enqueues revert to `workload_class='ingestion'` if
`front_warp_speed_enabled` is OFF and we are not in Phase 4.
There is no longer a legacy 1-per-tick fallback in Phase 4 — every
Front row sits on `workload_class='front_ingestion'` and only the
fast-poll loop drains that class. Use this only as an emergency stop.

### Manual reserve

`front_ingestion_manual_reserve` (default 1) keeps one slot
unavailable to `scheduled_background` callers so a reconciliation
sweep or operator-triggered job can always start. Mirrors the
existing `INGESTION_MANUAL_RESERVE` rule on the `ingestion` class.

### Test

`tests/front-warp-speed.test.ts` pins:

  - (a) master OFF = no dispatch
  - (b) master ON = drains both `ingestion`-class and
    `front_ingestion`-class rows in one tick
  - (c) manual reserve enforced (4 budget, 3 background, 1 manual)
  - (d) `TOTAL_BUDGET >= front_ingestion + ingestion` cap sum

## Related runtime facts

See the Runtime Truth Table in `replit.md` for the canonical worker-pool sizing and scheduler model.

## SEMrush demand-driven cadence (Task #1785)

`semrush_background_refresh` and `semrush_report_refresh` enqueue paths
now run through `evaluateRefreshGate()` (see
`server/services/semrushCadenceGate.ts`). The gate enforces a staleness
threshold and an active-client window before enqueueing. Identical
refresh payloads are suppressed at the `semrush_heatmap_apply` enqueue
site via `shouldSuppressApply`. Permanent error categories
(`missing_place_id`, `mapping_disabled`, `invalid_mapping`,
`auth_config`, `malformed_payload`, plus the existing `not_found`)
short-circuit the auto-retry budget and dead-letter immediately with a
`terminal:` prefix on `lastError`.

Cutover: `npx tsx scripts/semrush-cadence-cutover.ts --apply` flips the
three kill switches ON, seeds default settings, and unpauses both
SEMrush refresh queues. Admin surface: `/admin/semrush/cadence`. Full
runbook: `SEMRUSH_CADENCE.md`.

## Front reconciliation workload-class re-tag (2026-05-24)

The four reconciliation / full-backfill enqueue sites in
`server/services/frontWebhookIngestion.ts` (`front_webhook_normalize`
priority-200, priority-300, full-backfill priority-200;
`front_webhook_apply` priority-200) were re-tagged from
`workloadClass: "maintenance"` → `"ingestion"` so reconciliation rows
share the same class budget as live Front webhooks instead of competing
for the single `maintenance` slot (cap=1, shared with
`semrush_background_refresh`). Live webhooks still win because their
priority is 50 vs 200/300 for reconciliation; reconciliation only
consumes leftover ingestion slack. Fixes the 22k pending
`front_webhook_normalize` backlog observed 2026-05-24 where the entire
backlog was throttled to 1 slot.

`front_historical_backfill` continuation (`workQueueHandlers.ts` L780)
deliberately stays `maintenance` — it's a self-driven backfill loop
that should not compete with live or reconciliation.

## Front self-heal warp defaults (2026-05-26)

`runFrontAutoClosureTick` (queue: `front_auto_closure_tick`, ~17 s
cadence) inspects every month with a non-zero `ingest_gap` and enqueues
`front_historical_backfill` jobs for the historical recovery worker.

Previous defaults (`ingestRecoveryBudget=1`, `cooldownMinutes=360`,
`retryBudget=2` in `server/services/frontAutoClosure.ts`) meant **1
month per tick, locked for 6 hours**, so a 13-month / 123k-message
backlog would take weeks to drain even though the recovery worker is
already throttled by concurrency=2, Front rate-limit guard,
same-response suppression, active-inbox filter, and pool-pressure
backoff.

**New defaults**: `ingestRecoveryBudget=25`, `cooldownMinutes=20`,
`retryBudget=10` — every gap month gets a recovery enqueued each tick,
re-attempt every 20 min if still incomplete. Operators can still
throttle via the `front_auto_closure_*` `system_settings` keys.

**CEO button `enable_front_gap_drain_warp`** is the idempotent
multi-key flipper that forces the warp values even if someone manually
lowered a setting (status reports per-key diff; `not-needed` once all
three match).

## Cross-process OAuth refresh lease + deployment-gated Front workers (Task #2289)

**Symptom.** Front historical recovery in prod died with `invalid_grant`
even though Front was connected and healthy. The recovery worker treated
the terminal 400 as `blocked` / `front_not_connected`, so the backlog
stalled and operators saw a false "reconnect Front" alert.

**Root cause.** OAuth refresh was serialized only **in-process**
(`withSingleFlightOAuthRefresh`'s in-memory Map). Prod runs on `autoscale`
(N deployed instances) **plus** the always-on workspace process — each its
own process with its own single-flight Map. Two processes therefore
refreshed concurrently. Front returns the same refresh token during its
6-month validity but rotates a **new** one in the final 24h
(dev.frontapp.com/docs/oauth); inside that window the second (loser) POST
used a token the winner had just consumed → `invalid_grant` (HTTP 400,
terminal). The single-flight re-read-and-retry covered an *in-process*
race but not a *cross-process* one.

**Fix — two layers:**

1. **Cross-process refresh lease** (`server/services/oauthRefreshLease.ts`).
   A CAS on `system_settings` key `oauth_refresh_lease:front`
   (`{owner, acquiredAt, expiresAt}` JSON, TTL ~30s, bounded acquire ~25s
   with jittered polling) serializes every process to one refresher at a
   time. The Front refresh path reads the refresh token **after** the lease
   is held, so a loser picks up whatever token the winner just rotated, and
   an `onLeaseAcquiredRecheck` skips a wasteful second POST when a sibling
   already refreshed while we waited. The lease **degrades to in-process
   only** (acquire → null) on contention or any DB error — a refresh is
   never blocked by lease infrastructure. It uses `getDb()` so it honors the
   caller's api/worker pool context and never holds a connection across the
   token POST (a `pg_advisory_lock` was rejected for exactly that reason).
   Enforced by `lint-oauth-refresh-single-flight` (Rule 2): any caller of
   `withSingleFlightOAuthRefresh` must pass a `crossProcessLease` or sit on
   the `LEASE_PENDING_ALLOWLIST` (Zoom / Google Ads / SEMrush, pending
   migration).

2. **Deployment-gated Front background workers**
   (`server/lib/deploymentEnv.ts`). `shouldRunFrontBackgroundWorkers()`
   (true when `REPLIT_DEPLOYMENT === "1"`, or `FRONT_WORKERS_FORCE_ENABLE=1`
   for local testing) gates the Front background schedulers in
   `server/index.ts` — live sync init, analytics-coverage refresh,
   reconciliation, auto-closure, outbound-gap close/backfill, and the
   recovery prune sweep — to the **deployment only**. The workspace process
   was a second concurrent refresher with no operational need to run these;
   removing it from the pool eliminates the most common racer. On-demand
   Front API paths (admin actions, the `/me` probe) are **not** gated — they
   run wherever a request originates. The workspace logs a one-line
   "[Front] Background workers gated OFF (workspace)" on boot.

**Verification.** In the workspace, boot logs show the gate-off line and no
Front scheduler startup ticks fire; set `FRONT_WORKERS_FORCE_ENABLE=1` to
run them locally. In the deployment the schedulers run as before, and at
most one `oauth_refresh_lease:front` row exists at a time during a refresh.

## Cross-instance run-once worker locks (Task #2363)

**Problem.** Almost every scheduler/worker starts on **every** instance —
the workspace process *and* every `autoscale` instance (the only exception
is the deployment-gated Front workers, Task #2289 above). A "run-once"
background job guarded only by an **in-process** flag (a boolean, a `Set`,
or the in-memory `workerLock` Map) therefore still runs **once per
instance**: duplicate external-API calls (SEMrush/GBP
sync), duplicate rollup/snapshot writes, etc. In-process single-flight is
necessary but not sufficient on a multi-instance deploy.

**Fix — shared advisory-lock primitive** (`server/services/crossInstanceLock.ts`).
Generalizes the Task #2293 prod-action drain lock so any run-once job can
become a **cluster-wide singleton**: `pg_try_advisory_lock(namespace, key)`
on a pinned worker-pool connection held for the whole run. It self-heals —
if the winning instance crashes, Postgres drops the session and releases the
lock so a later run on any instance takes over. The lock is internal to our
own Postgres (no external API). Two namespaces partition the lock space by
purpose so unrelated jobs whose name strings hash equal can never collide:

- `PROD_ACTION_DRAIN` (`0x44524149` "DRAI"), keyed by `actionId` — the
  drain lock (`prodActionBackgroundDrain.ts`) delegates here; key is
  byte-for-byte identical to the original Task #2293 value.
- `WORKER_SINGLETON` (`0x57534E47` "WSNG"), keyed by a stable job name —
  run-once schedulers/workers.

**Consumers:**

- `workerLock.acquireDistributedLock(name)` = cheap in-memory `acquireLock`
  (same-process short-circuit) **then** the singleton advisory lock; its
  `release()` frees both. Used by `local_dominance_sync`
  and the `semrush_inventory_sync` sweep (its enqueued work is also dedupe-keyed
  in `work_queue` via `UNIQUE wq_dedupe_key_idx`, so the lock just avoids
  redundant paging/enrichment).
- `acquireWorkerSingletonLock(name)` / `withWorkerSingletonLock(name, fn)` —
  for crons that aren't `work_queue`-backed: the daily-judgment cron and the
  import-ghosts snapshot cron (covers both its cron tick and its 5s startup run).

**Deliberately NOT locked (already cross-instance-safe):** every `work_queue`
poller/handler — call-analysis worker + slow-lane, and all queue handlers —
claims rows with `FOR UPDATE SKIP LOCKED` and **wants** every instance polling
in parallel; a cluster-wide lock there would serialize the whole cluster and
regress throughput. Front workers are already gated to the deployment (Task
#2289). `alertResendGuard`'s in-memory cooldown is low-harm and restart-safe.

**Verification.** Acquire the same name twice in one process — separate
worker-pool sessions, so the second `pg_try_advisory_lock` returns false
exactly like a second instance would. Covered by
`tests/cross-instance-singleton-lock.test.ts`; the drain delegation is pinned
by the existing `tests/prod-actions-background-drain-consumers.test.ts`
cross-instance case.

**Regression guard — `lint-cross-instance-locks` (Task #2382).**
`scripts/lint-cross-instance-locks.ts` is registered in `scripts/gate.ts` and
runs with every other lint through the `.replit` **Validate** workflow. It
remains directly runnable only for focused debugging. It scans `server/` for
every `setInterval(...)` scheduler so a **new** run-once background job can't
ship without a deliberate cross-instance decision. A scheduler passes only if
it:

1. references a lock helper (`acquireWorkerSingletonLock` /
   `withWorkerSingletonLock` / `acquireDistributedLock` /
   `acquireCrossInstanceLock`), **or**
2. carries a `// @cross-instance-safe: <reason>` annotation in its first 80
   header lines (use this for the `work_queue` SKIP-LOCKED pollers, idempotent
   UPSERT rollups, and deployment-gated workers above that *want* to run on
   every instance), **or**
3. is listed in `scripts/lint-cross-instance-locks.baseline.txt` — the audited
   Task #2363 snapshot, each entry carrying its own rationale.

The lint also fails on **stale** baseline entries (a path that no longer calls
`setInterval`, or no longer exists) so the grandfather list can't rot. The lock
primitives (`workerLock.ts`, `crossInstanceLock.ts`) are excluded. To add a new
scheduler, pick option 1 or 2 — only grandfather (option 3) when neither fits
and you've recorded why. Covered by `tests/lint-cross-instance-locks.test.ts`.

**Baseline graduation (Task #2398).** The original Task #2363 snapshot
grandfathered 59 schedulers; a per-file re-audit graduated 38 of them out of
the baseline, leaving 21:

- **Annotated `// @cross-instance-safe` (option 2)** — the schedulers that are
  genuinely cluster-safe: `work_queue` SKIP-LOCKED claimers, dedupe-keyed
  enqueue producers (the handler runs once per claim; duplicate enqueues
  collapse via `wq_dedupe_key_idx`), idempotent UPSERT/DELETE maintenance,
  purely in-process loops (pool-idle sweep, SSE heartbeats, in-memory buffer
  flush), and DB-cooldown-guarded emits. **Classify at the `setInterval`
  level, not the handler body:** e.g. `feedbackSlackRetry.ts`'s tick only
  enqueues a dedupe-keyed `feedback_slack_retry` job — its
  `runFeedbackSlackRetryTick` is the singly-claimed handler, so the direct
  Slack relay inside it is safe even though it does an external write.
- **Wrapped in `withWorkerSingletonLock` (option 1)** —
  `semrushLocationAutoRetryWorker.ts` (calls the SEMrush API directly per tick,
  no `work_queue` dedupe) and `ris/risAutoPullScheduler.ts` (default-OFF
  BigQuery pull; duplicate remote pulls cost money and could race the
  suggested-status writes).
- **Still baselined (21)** — per-process in-memory alert/dedupe schedulers
  (cooldown lives in `alertResendGuard`/in-memory Sets, not the DB) plus
  `agentMatchingEngine.ts`. On autoscale each instance keeps its own cooldown
  so duplication is possible, but the blast radius is duplicate *alert noise*
  (or per-instance aggregation skew), not duplicate external writes — too
  low-harm to justify a Postgres advisory lock and the serialization it
  imposes. Revisit if alert-dedup is ever centralized in the DB.

## Front recovery throughput tuning (Task #1730)

Pool Epic Phase 3 makes the Front Historical Recovery worker's
pressure / saturation / page-delay / ingest-concurrency knobs
live-tunable via `system_settings`:

- `front_recovery_api_pool_backoff_threshold_percent`
- `front_recovery_api_pool_backoff_clear_percent`
- `front_recovery_api_pool_backoff_required_samples`
- `front_recovery_db_saturated_page_delay_ms`
- `front_recovery_db_saturated_required_signals`
- `front_recovery_page_delay_ms`
- `front_recovery_ingest_concurrency`

`server/services/frontRecoveryTuning.ts` adds a hysteresis-aware
API-pool-pressure check (consecutive-samples to trip, separate clear
threshold to release), replaces the sticky "saw saturation anywhere in
the window → 10× slower" flag with a per-page consecutive-saturation
counter that resets on clean pages, and drops the inter-page sleep
default from 500 ms → 200 ms when the Phase 0 kill switch
`front_recovery_pool_threshold_tuning_enabled` is on. Legacy defaults
are preserved when the switch is off so rollback is a single setting
flip.

Concurrency stays at 1 by default and is operator-ramped 1 → 2 → 3 via
`front_recovery_ingest_concurrency`. Full per-setting documentation:
`audits/G-docs-findings.md` § 4 (Env Var / System Setting / Kill Switch
Index).

### Apply-layer drop signal (Task #1872)

Task #1869 Step 6 added the per-page `front_recovery_dedupe_sample`
log with one of three verdicts:

- `apply_layer_dropping` — recovered conversations are being silently
  dropped at the apply layer (sampled dedupe-hit conv ids exist in
  `front_sync_emails` as `discovered`/missing instead of `applied`).
  Dedupe pct stays high but real ingest is stalled.
- `coverage_denominator_likely_wrong` — every sampled row is
  `applied`; recovery is healthy and the coverage denominator is off.
- `mixed` — neither pattern dominates.

`server/services/frontRecoveryDedupeDropAlerts.ts` records every
sample in-memory for the admin trends panel (apply-layer-drop rate
shown alongside dedupe rate), tracks per-(jobId, windowLabel)
consecutive `apply_layer_dropping` streaks, and fires a single Slack
alert via the unified `notifyByType` dispatcher
(`integration.front.recovery_apply_layer_drop`) when the streak
crosses `front_recovery_dedupe_drop_alert_consecutive_pages` (default
3). Any non-dropping verdict for the same window breaks the chain and
clears the "already alerted" flag.

The signal renders on **/admin/db-attribution/trends** as the **Front
recovery apply-layer drops** panel: apply-layer-drop rate, avg dedupe
pct over the in-memory sample buffer, lifetime verdict counters,
active drop chains, and the recent page-sample table (most recent
first, capped at 50). All counters reset on process restart.

Operator knobs (both live in `system_settings`):

- `front_recovery_dedupe_drop_alert_enabled` — default `true`; flip to
  `false` to mute the Slack alert without touching the panel.
- `front_recovery_dedupe_drop_alert_consecutive_pages` — default `3`;
  the streak length that crosses from "investigate" to "alert".

### Cumulative per-month telemetry + auto-unblock kill switch (Task #1869)

Per-window recovery checkpoints reset whenever auto-closure starts a
fresh window invocation, so the per-checkpoint counters can't tell
operators "is this month genuinely draining or are we re-walking the
same dedupe-hit conversations every tick?". The shared
`front_recovery_cumulative` JSON row in `system_settings` (written by
`server/services/frontHistoricalRecovery.ts`) captures per-YYYY-MM
totals — `scanned`, `ingested`, `dedupe_skipped`,
`same_response_skipped`, `inactive_inbox_skipped`, `pages_walked`,
`last_advanced_at`, `last_observed_dedupe_pct` — that survive every
window-checkpoint reset. Deltas are folded in after every successful
recovery run; the month bucket is derived from the window label
(`auto_closure:YYYY-MM` or plain `YYYY-MM`) and falls back to the
window's `afterTimestamp`.

The auto-unblock pass inside `runFrontAutoClosureTickInner`
(`server/services/frontAutoClosure.ts`) — which rewrites
`front_recovery_checkpoint_*` rows stuck `blocked` with an OAuth-race
reason (`front_auth_unauthorized_after_refresh`, `front_not_connected`,
`front_auth_refresh_failed`) back to `partial` after a single shared
`/me` probe confirms Front is healthy — is gated by the
`front_auto_unblock_enabled` kill switch (default ON). The
`force_front_auto_unblock` prod-action in
`server/services/prodActionsRegistry.ts` bypasses the gate when an
operator needs to drain blocked checkpoints regardless of the switch
state. Both rows are documented in `audits/G-docs-findings.md` § 4
(Front and § 4c).

## Parked-window search escalation + operator re-arm (Task #2085)

The auto-closure loop parks a recovery window after
`parkAfterDeadRuns` consecutive "dead runs" (scanned thousands,
ingested zero, checkpoint `partial` /
`safety_max_pages_reached_resume_available`). Historically a dead run
that was pinned to the **legacy** `/conversations?…` enumeration cursor
got parked even though migrating it to the **search** strategy
(`/conversations/search/…`) would have let it reach the missing tail.
Phase 1 closes that gap in two places, both gated on the existing
`front_recovery_sparse_month_search_strategy_enabled` switch (no new
switch was added):

**Automatic pre-park escalation.** The first time a window reaches the
park threshold, if its dead run is a legacy-strategy page-cap
saturation (`isLegacyStrategyDeadRun` — the checkpoint's `lastPageUrl`
is a `/conversations?…` cursor, not `/conversations/search/…`) and the
switch is on, the loop records an in-flight marker in
`state.searchEscalations[month]`, clears the checkpoint, and re-runs the
window once under the search strategy (`runHistoricalRecovery({
resumeMode: "clear_checkpoints" })`) **before** parking. The window is
only actually parked if that single escalated re-run *also* dead-runs
(its checkpoint `completedAt` advances past the one that triggered the
escalation). The marker makes the escalation fire **at most once** per
window; it is cleared on forward progress (streak resets to 0),
operator unpark, and auto-unpark.

**Operator one-press re-arm.** Windows already parked under the old
behavior never see the automatic escalation, so the CEO prod-action
`rearm_parked_front_recovery_windows` (and the Team-Lead
`POST /api/admin/front/auto-closure/rearm` route behind the
"Re-arm all (search strategy)" button on the Front Historical Recovery
panel) re-runs every parked window once under the search strategy via a
worker-pool background drain (`startBackgroundDrain`, one window per
chunk through `runTargetedWindowBackfill({ resume: false })`). Per-window
outcome (`reArmOneParkedWindow` → `classifyReArmCheckpoint`):

- `ingested` (new rows) / `resolved_covered` (walked clean) → the window
  is **unparked**.
- `still_empty` (search strategy also hit the page cap, 0 ingested) →
  the window **stays parked** and is **permanently** excluded from
  re-arm eligibility (`isReArmEligible` treats `still_empty` as
  terminal). It has been proven empty under the search strategy, so
  re-running would just dead-run again. This is what lets the
  `rearm_parked_front_recovery_windows` action **converge to "not
  needed"**: the status/countPending caller passes a *fresh* `sinceIso`
  every poll, so without the terminal exclusion such windows would be
  re-offered forever. If genuinely-new data later lands for the month,
  the auto-closure loop unparks it via its fresh-checkpoint trigger
  (`decideAutoUnpark`), independent of re-arm.
- `error` (blocked/failed) → the window **stays parked** and the outcome
  is stamped onto its `reArmOutcome` (with `source: "operator_rearm"`).
  This is treated as transient: the drain epoch (`sinceIso`) excludes
  already-stamped windows so a single press terminates after one pass,
  but a later press starts a fresh epoch and retries the still-parked
  `error` windows.

Both the automatic-escalation and re-arm outcomes are surfaced:
`searchEscalations` and each parked entry's `searchEscalated` /
`reArmOutcome` are exposed in `getFrontAutoClosureStatus()` and rendered
inline in the parked-windows list. The switch reuse means **no new
`system_settings` key** — nothing to add to `audits/G-docs-findings.md`
§ 4.

## Restored-fallback email auto-cleanup (Task #2029)

When a soft-deleted user is restored but their original email collides
with another active account, the suffix-fallback restore path
(Task #1910) restores the row on a synthetic `<original>.restored.<ts>`
address so it stays recoverable. Such an account fails its next login
until the original address is restored. Task #2012 added a one-click
"Restore original email" button in User Management; this scheduler
turns that click into unattended cleanup.

- **Service**: `server/services/restoredEmailCleanup.ts`.
- **Queue / handler**: `restored_email_cleanup` (workload class
  `maintenance`), registered in
  `server/services/workQueueHandlers.ts` → `handleRestoredEmailCleanup`,
  which wraps `runRestoredEmailCleanupTick()` in `runWithWorkerDb(...)`
  so all DB work lands on the worker pool.
- **Scheduler**: `startRestoredEmailCleanupScheduler()` started from
  `server/index.ts` with stagger offset `restored_email_cleanup`
  (`server/services/workerConfig.ts`). Enqueues a dedupe-keyed job every
  `TICK_INTERVAL_MS` (default 60 min; override via
  `RESTORED_EMAIL_CLEANUP_INTERVAL_MS`). Skips enqueue entirely while
  disabled so a default-OFF deploy never piles up no-op jobs.
- **What the tick does**: scans active users (`getAllUsers`) for the
  `.restored.<ts>` pattern (`isRestoredFallbackEmail`), and for each one
  calls `storage.updateUserEmail(id, stripRestoredFallbackSuffix(email))`
  — the same uniqueness check the manual button uses. On success it
  writes a system-attributed (null `userId`) `user_email_updated`
  activity-log row. Accounts whose original still collides
  (`RestoreEmailConflictError`) are left untouched for manual cleanup and
  remain surfaced by the existing User Management badge.
- **Gating** (all default to no-op): `restored_email_cleanup_enabled`
  system setting (default **OFF**), the `restored_email_cleanup`
  queue-drain pause, and `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
- **Tunables / readout**: `restored_email_cleanup_max_per_tick`
  (default 25, cap 500); `restored_email_cleanup_last_run` holds the
  JSON summary of the most recent tick. All keys are in
  `audits/G-docs-findings.md` § 4b.
- **Stuck-collision alert (Task #2044)**: every tick also takes a
  read-only census of *all* `.restored.<ts>` candidates (independent of
  the per-tick repair budget) and counts the ones the cleanup can never
  auto-fix — the original address is owned by another active user — that
  have been stuck longer than `restored_email_cleanup_collision_stuck_hours`
  (default 24h, cap 30d; age derived from the `.restored.<epoch-ms>`
  suffix). The count and a worst-first sample
  (`stuckCollisions` / `stuckCollisionSample` on the tick result, each
  sample row naming the affected user, their original address, the
  colliding owner, and how long it has been stuck) are exposed on every
  tick. When the count is at or above
  `restored_email_cleanup_collision_alert_threshold` (default 1, cap
  10000) the tick fires a single `notifyUser()` alert to the responsible
  admins (CEO / Team-Lead), categorised `system`, deep-linking
  `/admin/users`, deduped on `restored-email-collision-stuck`, and listing
  the affected users / original addresses. It is a streak alert: it fires
  **once** per streak (state persisted in
  `restored_email_cleanup_collision_alert_state`) and re-arms only after a
  later tick sees the count drop back below the threshold, so a standing
  backlog does not re-notify every hour. The census and alert are
  best-effort — a failure there never blocks the repair pass.

## Feedback → Slack auto-resend (Task #2066)

Task #2064 made feedback→Slack relay failures visible (per-row
`slack_status` / `slack_reason`) and added a manual "Retry Slack"
button, but a row left in `pending` / `failed` / `not_connected` still
needed a human to notice and press retry. This scheduler closes that
loop: it re-drives un-delivered feedback through the same relay once
Slack connectivity returns.

- **Service**: `server/services/feedbackSlackRetry.ts`. The relay itself
  lives in the shared `server/services/feedbackSlackRelay.ts`
  (`relayFeedbackToSlack` + `recordFeedbackSlackResult`), which Task #2066
  extracted out of `server/routes.ts` so the routes and this scheduler
  drive one copy of the channel-resolution / message-building /
  status-classification logic.
- **Queue / handler**: `feedback_slack_retry` (workload class
  `maintenance`), registered in
  `server/services/workQueueHandlers.ts` → `handleFeedbackSlackRetry`,
  which wraps `runFeedbackSlackRetryTick()` in `runWithWorkerDb(...)` so
  the candidate SELECT and the per-row status writes land on the worker
  pool.
- **Scheduler**: `startFeedbackSlackRetryScheduler()` started from
  `server/index.ts` with stagger offset `feedback_slack_retry`
  (`server/services/workerConfig.ts`). Enqueues a dedupe-keyed job every
  `TICK_INTERVAL_MS` (default 10 min; override via
  `FEEDBACK_SLACK_RETRY_INTERVAL_MS`). Skips enqueue entirely while
  disabled so a default-OFF deploy never piles up no-op jobs.
- **What the tick does**: runs a single `probeConnection()` first — if
  Slack is unauthorized/unreachable the whole pass no-ops with a reason
  so it never iterates the backlog (or hammers Slack) while down. Once
  connected it selects un-delivered rows (`slack_status <> 'delivered'`)
  whose last attempt (`slack_updated_at`) is older than the backoff
  window (oldest-first), bounded by the per-tick budget, and re-drives
  each through `relayFeedbackToSlack`, persisting the new status + reason
  in place via `recordFeedbackSlackResult`.
- **Give up + escalate (Task #2131)**: a row that can never reach Slack is
  no longer retried forever. `recordFeedbackSlackResult` increments a
  `slack_attempts` counter on every non-delivered attempt; once the attempt
  that just failed reaches `feedback_slack_retry_max_attempts` (default 10)
  **or** the row is older than `feedback_slack_retry_max_stuck_hours`
  (default 48) since `created_at`, the tick calls
  `markFeedbackSlackUndeliverable` to set the terminal
  `slack_status='undeliverable'` (with a plain-English give-up reason)
  instead of re-sending. Terminal rows are dropped from the candidate scan
  (`slack_status NOT IN ('delivered','undeliverable')`) so they stop
  counting toward the per-tick budget. When anything gives up in a tick the
  scheduler raises one deduped `notifyUser()` escalation (category
  `feedback`, deepLink `/admin/feedback`, dedupeKey
  `feedback-slack-undeliverable`) to the responsible admins so a human
  re-auths Slack / fixes the channel, then re-sends from the admin page.
- **Give up while Slack is down (Task #2131)**: the connectivity probe still
  short-circuits the *send* path when Slack is unauthorized/unreachable (no
  hammering a dead Slack), but it no longer just returns. The
  permanently-broken case — a revoked token that never re-auths — would
  otherwise strand rows in `failed`/`not_connected` forever, so the
  disconnected path runs `sweepStuckGiveUps`: it marks any non-terminal row
  older than `feedback_slack_retry_max_stuck_hours` as `undeliverable`
  (reason notes "Slack disconnected") and raises the same deduped escalation.
  Attempt-cap give-ups only happen on the connected path (they require a real
  send attempt); the age-based give-up holds in both states.
- **Gating** (all default to no-op): `feedback_slack_retry_enabled`
  system setting (default **OFF**), the `feedback_slack_retry`
  queue-drain pause, `KILL_SWITCH_NON_CRITICAL_SWEEPS`, and the live
  `probeConnection()` connectivity check.
- **Tunables / readout**: `feedback_slack_retry_max_per_tick`
  (default 25, cap 200); `feedback_slack_retry_backoff_minutes`
  (default 15, cap 1440); `feedback_slack_retry_last_run` holds the JSON
  summary of the most recent tick. All four keys are in
  `audits/G-docs-findings.md` § 4.

## Orphaned-user profile-row heal (Task #2203) — RETIRED (Task #4554)

**RETIRED by Task #4554 (closed admission).** The tick now
short-circuits unconditionally — before the enable switch is consulted —
and never scans sessions or creates `users` rows: the `users` table is
the sign-in allowlist, rows are created only via admin approval
(`POST /api/users`), and re-upserting a session-with-no-row from its
claims would resurrect exactly the auto-provisioned accounts closed
admission keeps out. The queue, handler, scheduler, prod action, and
budget/last-run settings are kept so status surfaces show the retirement
reason (`retired (Task #4554): …`) instead of a vanished feature. The
description below documents the historical Replit-Auth-era behaviour.

Task #2078 made `runOidcVerify` fail open when a first-login `upsertUser`
hits a transient DB blip: the session is admitted but, for a first-time
user, no `users` row is ever written. Task #2129 reconciles that missing
row best-effort on the user's *next* authenticated request. This
scheduler closes the residual gap — a user who is admitted but never
makes another request would otherwise stay orphaned forever — by
periodically scanning live sessions for a `sub` with no `users` row and
re-upserting the profile from the claims the session already carries.

- **Service**: `server/services/orphanedUserHeal.ts`.
- **Queue / handler**: `orphaned_user_heal` (workload class
  `maintenance`), registered in
  `server/services/workQueueHandlers.ts` → `handleOrphanedUserHeal`,
  which wraps `runOrphanedUserHealTick()` in `runWithWorkerDb(...)` so the
  candidate SELECT and the per-row upserts land on the worker pool.
- **Scheduler**: `startOrphanedUserHealScheduler()` started from
  `server/index.ts` with stagger offset `orphaned_user_heal`
  (`server/services/workerConfig.ts`). Enqueues a dedupe-keyed job every
  `TICK_INTERVAL_MS` (default 60 min; override via
  `ORPHANED_USER_HEAL_INTERVAL_MS`). Skips enqueue entirely while
  disabled so a default-OFF deploy never piles up no-op jobs.
- **What the tick does**: selects live (`expire > now()`) `sessions`
  whose passport claims (`sess->'passport'->'user'->'claims'`) carry a
  `sub` with no matching `users` row (`LEFT JOIN users … WHERE u.id IS
  NULL`), bounded by the per-tick budget, and for each re-upserts the
  profile (`id` / `email` / `first_name` / `last_name` /
  `profile_image_url`) from those claims via an
  `onConflictDoUpdate` so a row that appears between the scan and the
  write is harmlessly refreshed (idempotent). Soft-deleted / revoked
  users keep their `users` row (only `deletedAt` is set) and their
  sessions are purged, so the `u.id IS NULL` filter never re-creates a
  deleted account.
- **Pool note**: the handler calls `getDb()` directly (resolves to the
  worker pool under `runWithWorkerDb`) — **not** `authStorage.upsertUser`,
  which is bound to the static request-scoped `api` pool and must never be
  driven from a worker context.
- **Fail-open**: a per-row upsert error is caught and counted, never
  thrown — one bad session never aborts the tick or the surrounding
  worker slot.
- **Gating** (all default to no-op): `orphaned_user_heal_enabled`
  system setting (default **OFF**), the `orphaned_user_heal`
  queue-drain pause, and `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
- **Tunables / readout**: `orphaned_user_heal_max_per_tick`
  (default 25, cap 500); `orphaned_user_heal_last_run` holds the JSON
  summary of the most recent tick. All three keys are in
  `audits/G-docs-findings.md` § 4.

## Comms draft-attachment cleanup (Task #3520)

Draft pre-uploads land in object storage under `comms-draft-attachments/`
(originals) plus `comms-draft-attachments/thumb/` (Task #3438 thumbnails).
Promoting a draft into a real message COPIES the bytes to
`comms-attachments/`, so the draft original + its thumbnail become orphans;
abandoned drafts leave both behind too. Two cleanup layers:

- **Promotion-time delete** (`server/routes/comms.ts` upload route, draft
  branch): after the `comms_attachments` row is created, the draft original
  and its derived thumb key are deleted best-effort in a detached async
  block — a failure is only logged and never blocks or fails the send.
- **Retention sweep** (`server/services/commsDraftAttachmentCleanup.ts`,
  `startCommsDraftAttachmentCleanupScheduler()` from `server/index.ts`,
  stagger offset `comms_draft_attachment_cleanup`): daily tick (override
  via `COMMS_DRAFT_CLEANUP_INTERVAL_MS`) that lists everything under the
  draft prefix in one paged call, skips any key still referenced by a live
  `comms_drafts` row (`metadata.attachments[].objectKey` /
  `.thumbnailKey`) and anything younger than the retention window
  (default 30 days — also protects objects with no readable creation
  time), then deletes the rest bounded by the per-tick budget (default
  200). Per-object failures are counted and retried next tick.
- **Gating**: default OFF via `comms_draft_attachment_cleanup_enabled`;
  `KILL_SWITCH_NON_CRITICAL_SWEEPS` pauses it; deployment-gated because
  the workspace shares the object-storage bucket with prod but NOT the
  prod `comms_drafts` table (a workspace run could delete an object a
  live prod draft still references) — set
  `COMMS_DRAFT_CLEANUP_FORCE_ENABLE=1` to bypass locally.
- **Cross-instance safety**: each tick runs under
  `withWorkerSingletonLock("comms_draft_attachment_cleanup")` (max-hold
  ceiling in `CROSS_INSTANCE_LOCK_MAX_HOLD_MS`), so exactly one instance
  sweeps per tick; the advisory lock self-heals on crash.
- **Observability**: last-run JSON summary persisted at
  `comms_draft_attachment_cleanup_last_run` (listed / referenced /
  tooYoung / deleted / errors / budgetExhausted / reason). Knobs:
  `comms_draft_attachment_cleanup_retention_days`,
  `comms_draft_attachment_cleanup_max_deletes_per_tick` — see
  `audits/G-docs-findings.md` § 4.

## Abandoned presigned-upload cleanup (Task #3983)

Presigned upload URLs (feedback attachments, ATS interview videos,
heatmap/report screenshots) let the browser PUT an object into the private
bucket BEFORE the claim/submit step runs; an abandoned flow leaves the
object behind — unclaimed and unreferenced. Task #3964 deletes REJECTED
uploads at claim time; this sweep reaps the never-claimed ones.

- **Retention sweep** (`server/services/abandonedUploadCleanup.ts`,
  `startAbandonedUploadCleanupScheduler()` seeded from
  `server/boot/schedulerInits.ts`, stagger offset
  `abandoned_upload_cleanup`): daily tick (override via
  `ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS`) that lists everything under the
  presigned-upload namespaces (`uploads/`, `feedback-uploads/`, `ats-`,
  `client-files/` — Task #4023), skips any object with an ACL owner
  (claimed = completed flow, never touched), skips any key still
  referenced by a DB record (`user_feedback.screenshots`,
  `ats_submissions.video_url` / `video_object_key`, report-section
  `heatmapImageUrl`, client-file current + version storage keys), skips anything
  younger than the grace window (default 48h — also protects objects with
  no readable creation time), then deletes the rest bounded by the
  per-tick budget (default 200). Deletes go through the race-safe
  `deleteRejectedUploadObject` (`expectedOwner: null` + metageneration
  precondition), so a claim racing in mid-sweep aborts the delete.
  Per-object failures are counted and retried next tick.
- **Gating**: default OFF via `abandoned_upload_cleanup_enabled`;
  `KILL_SWITCH_NON_CRITICAL_SWEEPS` pauses it; deployment-gated because
  the workspace shares the object-storage bucket with prod but NOT the
  prod reference tables — set `ABANDONED_UPLOAD_CLEANUP_FORCE_ENABLE=1`
  to bypass locally.
- **Cross-instance safety**: each tick runs under
  `withWorkerSingletonLock("abandoned_upload_cleanup")` with the
  `CROSS_INSTANCE_LOCK_MAX_HOLD_MS` watchdog armed, so exactly one
  instance sweeps per tick; the advisory lock self-heals on crash.
- **Observability**: last-run JSON summary persisted at
  `abandoned_upload_cleanup_last_run` (listed / owned / referenced /
  tooYoung / deleted / errors / budgetExhausted / reason). Knobs:
  `abandoned_upload_cleanup_grace_hours`,
  `abandoned_upload_cleanup_max_deletes_per_tick`.

## Client-file trash retention purge (Task #4023)

Permanently deletes client files whose Trash retention has expired
(`server/services/clientFileTrashPurge.ts`,
`startClientFileTrashPurgeScheduler()` seeded from
`server/boot/schedulerInits.ts`, stagger offset `client_file_trash_purge`).
Daily tick (override `CLIENT_FILE_TRASH_PURGE_INTERVAL_MS`); each tick runs
under `withWorkerSingletonLock("client_file_trash_purge")`. **Objects first,
rows second**: the file's current object + every version object are deleted
before its DB rows, and a failed object delete retains the row so the next
tick retries (per-file failure isolation). Each purge writes a client-level
activity tombstone (`purged`, `file_id` NULL, actor "Retention sweep").

- **Gating**: default OFF via `client_file_trash_purge_enabled`;
  deployment-gated; `CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE=1` bypasses
  locally (tests).
- **Knobs**: `client_file_trash_purge_retention_days` (default 30, cap 365;
  cutoff on `trashed_at`), `client_file_trash_purge_max_files_per_tick`
  (default 200, cap 2000), last-run JSON at
  `client_file_trash_purge_last_run`.
- **Full subsystem runbook**: [CLIENT_FILES.md](./CLIENT_FILES.md).

## Feedback video restart-resume (Task #2414)

Uploaded feedback videos are auto-analyzed in the background through the
TwelveLabs tool (`feedbackVideoProcessing.processFeedbackVideos`, Task
#2409). That processor tracks the in-flight indexing job only in process
memory (`videoAnalysis.ts` jobStore), so if the server restarts while a
feedback video is still processing, the in-memory job is orphaned and the
`user_feedback` row is left at `video_analysis.status === "processing"`
forever — its transcript / key-moment frames never land. This scheduler
closes that gap by periodically re-driving stuck rows through the SAME
shared processor the submit path uses.

- **Service**: `server/services/feedbackVideoResume.ts`.
- **Queue / handler**: `feedback_video_resume` (workload class
  `maintenance`), registered in
  `server/services/workQueueHandlers.ts` → `handleFeedbackVideoResume`,
  which wraps `runFeedbackVideoResumeTick()` in `runWithWorkerDb(...)` so
  the candidate SELECT, the give-up / no-video terminal UPDATEs, and the
  status re-read all land on the worker pool. The actual re-drive delegates
  to `processFeedbackVideos`, which opens its own `runWithWorkerDb` context.
- **Scheduler**: `startFeedbackVideoResumeScheduler()` started from
  `server/index.ts` with stagger offset `feedback_video_resume`
  (`server/services/workerConfig.ts`). Enqueues a single dedupe-keyed job
  per tick bucket every `TICK_INTERVAL_MS` (default 15 min; override via
  `FEEDBACK_VIDEO_RESUME_INTERVAL_MS`). Skips enqueue entirely while
  disabled or paused so a default-OFF deploy never piles up no-op jobs.
- **What the tick does**: selects rows still `processing` whose
  `video_analysis.startedAt` is older than the stuck threshold (oldest
  first, bounded by the per-tick budget). A healthy in-flight job re-stamps
  `startedAt` to now() at the start of every run (including the re-drive),
  so anything older than the threshold cannot be an active job in a healthy
  process — it was orphaned by a restart. For each candidate: a row with no
  remaining video attachment is marked terminally `failed`; a row already
  re-driven `maxAttempts` times is marked terminally `failed` (give-up);
  otherwise the row is re-driven with the bumped `resumeAttempt` threaded
  in, and the resulting terminal status is recorded.
- **Resume-attempt counter**: each re-drive carries `resumeAttempt =
  prior + 1`, persisted on `video_analysis.resumeAttempts` (the processor
  stamps it into the analysis object so it survives the re-drive). A row
  that keeps coming back `processing` (e.g. the server keeps restarting
  mid-analysis, or the video is permanently un-indexable) is therefore
  eventually given up instead of re-driven forever.
- **Cross-instance safety**: the scheduler is enqueue-only — every
  autoscale instance may run it, but the dedupe key collapses each tick
  bucket to one `work_queue` job claimed `FOR UPDATE SKIP LOCKED` by a
  single instance, so the sweep itself runs once per bucket.
- **Fail-open**: a per-row re-drive that throws is caught and counted as an
  `error` outcome, never thrown — one bad row never aborts the tick or the
  surrounding worker slot. The next tick retries it.
- **Gating** (all default to no-op): `feedback_video_resume_enabled`
  system setting (default **OFF** — opt-in because the tick performs real
  TwelveLabs indexing submissions + ffmpeg work, not just measurement), the
  `feedback_video_resume` queue-drain pause, and
  `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
- **Tunables / readout**: `feedback_video_resume_max_per_tick`
  (default 5, cap 50); `feedback_video_resume_stuck_minutes` (default 120,
  cap 1440); `feedback_video_resume_max_attempts` (default 3, cap 20);
  `feedback_video_resume_last_run` holds the JSON summary of the most recent
  tick. All keys are in `audits/G-docs-findings.md` § 4.

## Reserved VM memory bounds & memory watchdog (Task #2897)

The deployment target moved from `autoscale` to a Reserved VM (4 GB tier).
Autoscale recycled instances often enough to mask slow in-memory growth; a
Reserved VM process can stay up for weeks, so every long-lived in-memory
structure was audited and either confirmed bounded or given an explicit
bound, and a memory watchdog now alerts before the process approaches the
tier limit.

### Memory watchdog

- **Service**: `server/services/memoryWatchdog.ts` (started via the
  `memory_watchdog` stagger offset in `server/index.ts`, stopped in
  graceful shutdown). Header carries `@cross-instance-safe` — it observes
  and alerts on its OWN process RSS, so a cluster-wide singleton would be
  wrong; the breach-streak latch bounds alert volume per instance.
- **Behavior**: logs RSS / heap used / heap total / external hourly. When
  RSS ≥ the threshold (default **3072 MB ≈ 75% of the 4 GB tier**) it fires
  the `infra.memory.high_rss` notification (Slack via `notifyByType`,
  admin in-app mirror) **once per breach streak**; a failed dispatch does
  NOT latch, so the next hourly tick retries. When RSS drops below the
  re-arm level (90% of the threshold — hysteresis so RSS oscillating at
  the threshold can't flap), a single "recovered" follow-up is sent and
  the alert re-arms.
- **Settings** (registered in `audits/G-docs-findings.md` § 4b/4c):
  - `memory_watchdog_enabled` — kill switch, default **ON**.
  - `memory_watchdog_alert_rss_mb` — threshold in MB, default `3072`.
- **Test**: `tests/memory-watchdog.test.ts` (routine `SMOKE_FILES` gate).

### In-memory cache & buffer bounds audit

Structures newly bounded by Task #2897 (all evictions are safe: worst case
is a re-fetch or a re-allowed resend for a long-dead alert):

| File | Structure | Bound added |
| --- | --- | --- |
| `alertResendGuard.ts` | `cooldowns`, `lastByAlert` | Cap 2000 each, oldest-insertion eviction |
| `slackIntegration.ts` | `userCache` | Cap 2000, oldest-insertion eviction |
| `semrushCircuitBreaker.ts` | `campaignBackoffUntil` | Expired entries pruned on every write |
| `zoomIntegration.ts` | `zoomUserCache` | Expired entries pruned on every write + cap 2000 |

Confirmed already bounded (no change): `rateLimitMonitor.ts` (per-category
caps + window pruning), `semrushApi.ts` (TTL caches + 1000-entry bailout
ring), `frontHistoricalRecovery.ts` (30-day prune sweep),
`replitAuthBreaker.ts` (5000-cap + TTL), `semrushCircuitBreaker.ts`
`samples` (sliding window), `alertResendGuard.ts` `history` (200-entry
ring), `leaseChurnAlerts.ts` (static queue-name keys),
`zoomIntegration.ts` `zoomScopeGates` (keyed by the small fixed set of
endpoint families; cleared on disconnect/reconnect),
`frontAnalyticsCoverage.ts` `enumerationInFlight` (YYYY-MM keys).

When adding a NEW long-lived Map/array under `server/`, give it an explicit
bound (cap, TTL sweep, or prune-on-write) in the same PR and add it to the
table above.

## Table retention, size watchdog & deep-prune reclaim (Task #3814)

Production high-churn operational tables grew unbounded (measured 2026-08-05: `work_queue` 809k rows / 693 MB, `front_hydrate_snapshots` 1,050 MB for 31 live rows, `source_event_log` 399 MB, `work_result_log` 294 MB, `call_analysis_jobs` 238 MB, `apply_state` 128 MB, `mcu_cache` 56 MB, `pool_state_samples` 47 MB). This section documents the retention layer that keeps them bounded.

**Policy module (single source of truth): `server/services/tableMaintenancePolicy.ts`**
- `PRUNE_UNITS` — eleven delete units, each with a fixed table/pk/predicate and a tunable retention window (`system_settings`, days):
  - `work_queue_terminal` — `completed`/`cancelled` rows by `updated_at`; `work_queue_retention_terminal_days` (default 7).
  - `work_queue_failed` — `failed`/`dead_letter` rows by `updated_at`; `work_queue_retention_failed_days` (default 30) — longer window so failures stay inspectable.
  - `source_event_log_terminal` — `applied`/`ignored`/`failed`/`dead_lettered` by `received_at`; `source_event_log_retention_days` (default 90). Deleting a parent CASCADEs to `work_result_log` + `apply_state` (their declared retention path — no separate pruner).
  - `call_analysis_jobs_terminal` — `complete`/`failed` by `created_at`; `call_analysis_jobs_retention_days` (default 90).
  - `mcu_cache_expired` — inherent TTL (`expires_at < NOW()`), no setting.
  - `table_size_samples_old` — watchdog's own trend samples; `table_size_samples_retention_days` (default 180).
  - `comms_link_previews_stale` (Task #4339) — unfurl-cache rows whose `cached_until` TTL lapsed before the cutoff; `comms_link_previews_retention_days` (default 30). The unfurl path refetches on demand.
  - `semrush_location_sync_attempts_old` (Task #4339) — insert-only attempt history by `created_at`; `semrush_location_sync_attempts_retention_days` (default 90). Latest state stays in `semrush_location_sync_state`.
  - `booking_client_tokens_expired` (Task #4339) — single-use tokens by `expires_at` (used or not — expired tokens can never be redeemed); `booking_client_tokens_retention_days` (default 30 past expiry).
  - `user_activity_logs_old` (Task #4392) — append-only activity log by `timestamp` (every row terminal at insert); `user_activity_logs_retention_days` (default 365).
  - `client_file_share_links_dead` (Task #4392) — share links dead at `LEAST(expires_at, COALESCE(revoked_at, expires_at))` (expression index-backed, migration `20260811161251`); `client_file_share_links_retention_days` (default 90 past death). Active links are never touched. `website_inquiries` was explicitly RETAINED (lead records with UTM attribution; decision recorded in `tableMaintenancePolicy.ts`).
- `COVERED_TABLES` — fifteen watched tables with default size bands (MB): work_queue 250, front_hydrate_snapshots 200, source_event_log 600, work_result_log 450, apply_state 250, call_analysis_jobs 350, mcu_cache 120, pool_state_samples 120, table_size_samples 50, comms_link_previews 100, manual_reserve_worker_samples 120, semrush_location_sync_attempts 150, booking_client_tokens 50, user_activity_logs 100, client_file_share_links 50. Bands are overridable via the `table_size_watchdog_bands_mb` JSON setting (`{"table": mb}`). `front_hydrate_snapshots` row-pruning stays with its existing dedicated pruner; `pool_state_samples` retention stays with the pool monitor; `manual_reserve_worker_samples` retention stays with the healthMetrics prune sampler (7d fixed) — the watchdog only *watches* those.

**Scheduled pruner: `server/services/tableRetentionPruner.ts`** — hourly, worker pool, cross-instance safe (idempotent cutoff deletes, no lock needed). Gated on `table_retention_pruner_enabled` = `true` (default OFF; enable via the `enable_table_retention_pruner` prod-action) and the `non_critical_sweeps` kill switch. Deletes in batches of 2,000 pk-selected rows, ≤ 25 batches per unit per tick, so a tick never monopolizes the pool; leftover backlog simply waits for the next tick. Eligibility counts and batch subselects are backed by partial indexes (migration `20260805025824_table_size_samples.sql`).

**Size watchdog: `server/services/tableSizeWatchdog.ts`** — every 6 h under advisory lock `scheduler:table-size-watchdog`; gated on `table_size_watchdog_enabled` (default OFF; `enable_table_size_watchdog` prod-action). Samples `pg_total_relation_size`/`pg_stat_user_tables` into `table_size_samples`, then alerts `infra.database.table_growth` (per-table dedupeKey `table_growth:<table>`) when a covered table exceeds its band; recovery is marked only after dropping under 90% of band (hysteresis prevents boundary flapping). Trend is visible in Admin → System Health → DB Server Metrics → **Size Trend** tab (`GET /api/health/db/table-size-trend?days=N`, team-lead+).

**One-press deep prune + reclaim: prod-action `deep_prune_reclaim_oversized_tables`** (`server/services/tableDeepPruneReclaim.ts`) — the initial-backlog/space-reclamation action. Phase 1 drains every prune unit (5,000-row batches through the shared drain framework, resumable, progress in the actions panel). Phase 2 runs `VACUUM (FULL, ANALYZE)` on covered tables that are over band, one table per chunk, with `lock_timeout='5s'` — a contended table is *skipped* (`lock_skipped`, retryable later) rather than blocking production. Success stamps `table_reclaim_state` (`{table: {at, bytesBefore, bytesAfter}}`); a stamp younger than 7 days makes status() report **not needed** for that table (convergence — re-press does not re-vacuum; a still-over-band table with a fresh stamp means the band needs retuning, which status() says explicitly). Manual-only: no self-heal opt-in, because VACUUM FULL takes exclusive locks and must be a deliberate CEO press. NOTE: VACUUM FULL rewrites the table and needs transient free disk ≈ the table's size; run it before disk is nearly full, not after.

**Rollout order (production):** press `enable_table_retention_pruner` + `enable_table_size_watchdog`, let the hourly pruner shave the backlog (or go straight to the deep prune), then press `deep_prune_reclaim_oversized_tables` once and verify sizes in the Size Trend tab; record before/after totals in the task notes. Expected effect: `work_queue` returns to near in-flight size, `front_hydrate_snapshots` drops from ~1 GB to MBs, total DB size and daily backup duration shrink materially.

## retroactive_reprocess backlog health CLI (Task #1047)

`npx tsx scripts/verify-retroactive-reprocess-health.ts` — read-only aggregate health
report for the `retroactive_reprocess` queue: status mix, failure-class breakdown,
oldest-pending age, kill-switch + concurrency-setting snapshot. No other single surface
reports these together (work-queue status API, stuck-processing inventory, the
queue-control pending-by-client endpoint, and starvation alerts each cover a slice).
Use it as the post-check whenever the boot-time backlog collapse
(`server/services/retroactiveReprocessBacklogCollapse.ts`, threshold-gated, paired with
`scripts/collapse-retroactive-reprocess-backlog.ts`) or the
`prune_failed_retroactive_reprocess_backlog` prod action fires. Runs against the dev
workspace DB; for production, mirror its queries through the read-only prod SQL tool.
Retained zero-reference diagnostic — see `audits/f3-operational-script-disposition-2026-08-09.md`.

## Custom-table worker reliability parity (workers/queues audit E-F01…E-F16 follow-through, 2026-08-06)

The five custom-table pipelines that bypass `work_queue` now carry the same operational controls as the established lanes. Business behavior (eligibility, ordering, schedules, vendor calls, outputs) is unchanged — these are safety/observability controls only.

| Worker (table) | Claim/lease | Processing cap (lane in `work_queue_max_processing_ms`) | Kill switch (`kill_switch_*`) | Stuck/stale watcher (notification id) |
| --- | --- | --- | --- | --- |
| callAnalysis (`call_analysis_jobs`) | atomic `FOR UPDATE SKIP LOCKED` claim; `locked_until`/`leased_at` + attempt-epoch guard; 60 s heartbeat capped at the lane ceiling | `call_analysis` 5 m / `call_analysis_slow` 16 m | `call_analysis` | `queue.call_analysis.stuck_processing` (`callAnalysisStuckProcessingAlerts.ts`) |
| callArchivePipeline (`twilio_calls`) | pre-existing (unchanged) | pre-existing `call_archive` 10 m | `call_archive` (new) | pre-existing `queue.call_archive.stuck_processing`; failures now also carry typed `archive_failure_reason` |
| localDominanceSyncWorker (`semrush_location_sync_state`) | existing sweep lock + per-run `runId`; finalization now guarded by `expectedRunId` (stale owner cannot clobber) | `local_dominance_sync` 240 m (also drives the stuck-`in_progress` sweep cutoff) | `local_dominance_sync` (claim + per-location boundary) | `queue.local_dominance_sync.stuck_rows` (`localDominanceStuckSyncAlerts.ts`) |
| semrushLocationAutoRetryWorker (same table, retry lane) | `claimDueAutoRetries` atomic claim; pushed `next_retry_at` acts as a self-expiring lease | `semrush_location_auto_retry` 15 m lease (per-location budget 6 m sits under it) | `auto_retry` (pre-existing, now also mid-batch) | `queue.semrush_auto_retry.overdue_rows` (`semrushAutoRetryOverdueAlerts.ts`) |

Also: the `retroactive_reprocess` queue handler now rechecks its kill switch at the per-row boundary inside `reEvaluateUnmatchedForTargets` (queue-handler path only — the interactive attach-domain caller is unchanged) and reports `killSwitchAbort` in its handler summary.

**Operator stop/start:** flip the switch in Admin → System Health → Kill Switches (or `POST /api/health/kill-switches`). ON = the worker stops CLAIMING new work at the next boundary; in-flight items finish and completed work is never rolled back or falsely failed. Stops are visible in logs as `kill_switch_abort` (structured `workerLog`, one line per transition or run). OFF = claiming resumes on the next tick; nothing needs re-queuing.

**Stuck-row recovery (no manual SQL in the normal path):**
- call analysis — expired-lease rows are requeued automatically (`recoverStaleJobs`, each poll tick); rows past 2 attempts go terminal `failed/cpu_starved`. Watcher pages when expired-lease rows sit past the alert age.
- call archive — unchanged: watchdog requeues expired `archive_locked_until` rows; `enqueueCallArchive` re-arms a terminal-failed row (clears typed reason + attempts).
- local dominance — the stuck-`in_progress` sweep (each worker run, cutoff = lane ceiling) promotes stuck rows to `failed/timeout`, which makes them auto-retry-eligible. The watcher deliberately KEEPS paging while the kill switch is on (the sweep is off too — stuck rows cannot self-heal during an operator stop).
- auto-retry lane — a claimed row's pushed `next_retry_at` simply comes due again if the claimer dies (self-expiring lease); the watcher pages when due retries sit unclaimed past the alert age. It goes quiet while `auto_retry` is intentionally off.
- drive sync — no row state to recover: a hung crawl dies at the folder-boundary deadline and the next hourly run overwrites staleness; the watcher pages when the whole cache stops refreshing (quiet while the switch is intentionally on).

**Watcher tuning:** every watcher has `*_enabled` / `*_age_minutes` / `*_cooldown_minutes` (+ `*_count_threshold` where row counts apply) system settings — see `audits/G-docs-findings.md` §4b. All route through `notifyByType` with watcher-owned dedupe (cooldown + growth re-fire), same pattern as `callArchiveStuckProcessingAlerts`.

**Rollback:** all switches default off (workers enabled) — flipping a switch off restores pre-parity claiming behavior at the next tick. The lease columns (`call_analysis_jobs.locked_until/leased_at`) are additive and nullable; old instances during a mixed-version deploy ignore them, and expired leases self-release (no row can stay permanently locked). Deleting the settings rows restores every default.


## ClickUp role projection queue (Task #5156)

Queue name: `clickup_role_projection`
Handler: `handleClickUpRoleProjectionJob` in `server/services/clickUpRoleProjectionWorker.ts`

### What it does

Drains durable `cu_role_projection_commands` rows, calling the ClickUp API to set People custom-field values on exact ClickUp tasks. A `direct_task` destination resolves the task from destination configuration; a `client_list_parent` destination resolves it from the stable per-client target mapping. NoBull assignment always succeeds first; the queue is the asynchronous projection lane.

### Lease and retry semantics

- **Lease**: FOR UPDATE SKIP LOCKED on `cu_role_projection_commands`, 5-minute lease TTL.
- **Attempts**: max 5, back-off schedule 30s → 2m → 10m → 30m → 60m.
- **Immediate attempt**: small writes make a bounded post-commit attempt. `kickClickUpRoleProjectionSafe` is a best-effort coalesced accelerator (never throws), not the durable delivery path.
- **Durable command wakes (the delivery driver)**: initial command staging and eligible failed/blocked operator Re-sync insert immediate `work_queue` wakes in the SAME command-state transaction. Retryable/ambiguous/drift finalization inserts a delayed wake in the SAME finalize transaction (one dedupe key per command revision/attempt, no vendor call in these transactions, enqueued only when command state changed). These wakes provide restart-safe first delivery, repair, and retries.
- **Continuation**: when a drain hits its 50-command cap the handler enqueues a durable immediate continuation (unique dedupe key derived from the current job id) so the remainder drains crash-safely.
- **Boot catch-up (defense in depth ONLY)**: `scheduleClickUpRoleProjectionBootCatchup` runs on server start and re-enqueues old, un-leased, due commands if queue state was administratively lost or damaged. It is a safety net, NOT the mechanism first delivery or ordinary retries rely on.

### Ambiguity path

When the ClickUp write call succeeds but the read-back cannot confirm (network error, rate-limit), the command transitions to `ambiguous`. On the next attempt the worker reads back first, then only writes if the desired value isn't already present. This prevents double-writes.

### Lost-kick / stuck command recovery

If `kickClickUpRoleProjectionSafe` fails (scheduler unavailable), no recovery
event is required: each new/superseded command already committed its own
immediate wake atomically with the assignment transaction. The scheduler leases
that wake normally. Boot catch-up remains defense in depth for administrative
queue loss, and manual Re-sync remains available only for terminal failed or
blocked commands after their dependency is repaired and no lease remains.

### Terminal / dead-letter alert

Commands reaching `failed` with `terminal_at IS NOT NULL` are dead-lettered (attempts exhausted or non-retryable). Diagnostic query:

```sql
SELECT client_id, destination_id, last_error, attempt_count, updated_at
FROM cu_role_projection_commands
WHERE terminal_at IS NOT NULL
ORDER BY updated_at DESC
LIMIT 50;
```

To retry a terminal command, use the operator `POST /api/service-desk/role-projections/resync` route. It resets only a terminal `failed` or `blocked` command with no lease before kicking the queue. The route returns `409` without changing status, counters, retry time, or lease for `pending`, `drift`, `ambiguous`, nonterminal failed, or leased commands. Direct SQL repair is reserved for cases where the route itself is unavailable.

### Manual resync

Team leads can trigger resync from the Role Assignments console (/admin/service-desk/role-assignments) → ClickUp Projection Issues panel → Re-sync button.
The button is available only when the safe status response marks a terminal
`failed` or `blocked` row as `resyncEligible`. The server repeats that
eligibility check and rejects any command with lease fields present.

Or via API:
```
POST /api/service-desk/role-projections/resync
{ "departmentId": "<uuid>", "responsibility": "doer"|"checker", "clientId": "<uuid>" }
```

Every department supports `doer`; `checker` is accepted only for stable
department UUIDs approved in `shared/departmentRoleCapabilities.ts`. Unsupported
or retired responsibilities are rejected and never stage or re-sync a command.

### Kill switch

```sql
UPDATE system_settings SET value = 'false' WHERE key = 'clickup_role_projection';
```

Pauses all projection draining. Commands remain in `pending` and drain when cleared.

### Projection-specific incident procedure

NoBull assignments are authoritative and must not be changed to clear a queue
alert. Use the Role Assignments console first; it shows the error code, desired
ClickUp person, attempt budget, next retry, and bounded Re-sync action.

1. **Classify:** `pending` is waiting, `ambiguous` means write outcome is unknown,
   `blocked` means identity/target/field configuration, `drift` means remote
   read-back differs, and terminal `failed` is dead-letter. A 429/5xx/timeout is
   retryable; 401/403 requires credential/scope repair.
2. **Pause safely when needed:** set the `clickup_role_projection` kill switch to
   false. Commands and durable wakes remain intact; no NoBull role, Service Desk
   behavior, or Ads OS state changes.
3. **Inspect before repair:** correlate command revision, destination, exact task
   and People field, desired/current People IDs, lease owner/expiry, attempts,
   `next_attempt_at`, and its `work_queue` wake. For `ambiguous`, do not issue a
   duplicate manual ClickUp write—the next attempt reads back first.
4. **Repair forward:** fix identity, target, field, list ownership, or company
   authorization; prove the dependency with read-only checks; clear the switch.
   Due durable wakes resume automatically.
5. **Re-sync selectively:** only reset terminal `failed` or `blocked` commands
    after confirming no lease remains. Never Re-sync `pending`, `drift`,
    `ambiguous`, or nonterminal failed rows; they retain counters/state and
    resume through their durable worker path. An accepted Re-sync proves
    enqueueing, not convergence; close only after status is `synced` with fresh
    remote read-back.

To verify a pause, watch that no new command leases are acquired and that pending
counts are stable after in-flight work settles. To disable one mapping rather
than the lane, set that destination `enabled=false`; its commands become
`disabled` and NoBull remains unchanged. Never delete command history as an
incident response.

Escalate repeated external drift or sustained manual repair volume with measured
counts. Webhook-driven or periodic full reconciliation remains deferred until
that evidence crosses an approved threshold.
