# Front

## Overview
Front is NoBull OS's primary email-conversation source. The integration ingests Front conversations via live webhooks and a historical-recovery backfill, normalizes them through a per-conversation pipeline state machine, hard-matches them to clients deterministically (no AI guessing), and applies the result to `raw_communication_records`. Filter rules suppress noise; bulk-action jobs apply rule changes retroactively.

This runbook is the book-of-record for Front. Historical-recovery details that operators need during a backfill incident live in the [Historical recovery](#historical-recovery) section below.

## Architecture

### Files
| File | Purpose |
| --- | --- |
| `server/services/frontIntegration.ts` | OAuth + REST client. Token refresh (5-min pre-expiry), 429 retry (max 5). |
| `server/services/frontWebhookIngestion.ts` | Verifies `X-Front-Signature`, maps events into the `source_event_log`. |
| `server/services/applyPipeline.ts`, `applyHandlers.ts` | Generic durable pipeline (state machine + idempotency via input hash). |
| `server/services/frontHardMatch.ts` | Deterministic matching: Exact Email **or** Trusted Domain. No AI/keyword guessing. |
| `server/services/frontFilterRules.ts` | `block` / `dismiss` / `never_match` rules. |
| `server/services/frontBulkActions.ts` | Retroactive application of rule changes via the `front_bulk_action` queue. |
| `server/services/frontSyncEmailTriage.ts` | Canonical helper so every ingestion path applies the same filter + classifier logic. |
| `server/services/frontHistoricalRecovery.ts` | Windowed backfill with per-window checkpoints. |
| `server/services/frontPipelineMetrics.ts` | Throughput, backlog, discovery-to-apply latency. |
| `server/services/frontRecoveryRetryAlerts.ts` | Recovery retry-alert notifier. |
| `server/services/frontHistoricalRecoveryFatalAlerts.ts` | Fatal-error alerts on recovery jobs. |
| `server/services/frontWebhookReceiverStalenessAlerts.ts` | Alerts when the receiver hasn't seen events recently. |

### State machine
Per-conversation: `received` → `normalized` → `ready_to_apply` → `applied`. Idempotency keyed on `apply_state.input_hash` so replays skip already-succeeded targets.

### Queues
- `front_webhook_normalize` — extracts participants/content; writes `work_result_log`; advances to `normalized`.
- `front_webhook_apply` — runs `frontHardMatch` + filter rules; writes `raw_communication_records`; advances to `applied`.
- `front_bulk_action` — large retroactive runs (filter rule changes, rematch-all, reprocess).

### Hydrate Snapshot Layer
`front_hydrate_snapshots` stores full conversation/message JSON at ingest time. When `FRONT_PIPELINE_HYDRATE_ENABLED` is on, the pipeline reads from the snapshot instead of re-fetching, guaranteeing consistent data across retries and immune to Front-side mid-processing edits.

## Console metric → source → definition matrix (Task #2502)

The Front Integration console (`/admin` → Front Integration) reads **three distinct
populations**. Each is correct on its own, but they were historically labelled with the
same generic words ("Messages", "Matched", "Backlog"), which made figures look like they
contradicted each other. The single source of truth for these definitions is
`shared/frontConsoleMetrics.ts` (imported by both the server overview endpoint and the
client UI, so the page and this doc can never drift). This is **presentation/correctness
only** — it changes nothing about ingestion, matching, or dismissal.

**Message-grain only (Task #2603).** The console renders these populations in
message-grain terms — the tiles read "tracked emails" / "matchable emails", and
there is no conversation count or conversation "match rate" shown to operators.
`front_sync_emails` still de-duplicates one row per Front thread internally
(Front's API is thread-based), but that grouping is an implementation detail, not
a user-facing grain.

**Populations**

1. **Raw imported** — `raw_communication_records WHERE source_type='front_email'`. Every
   Front record ever imported, *including per-version duplicates*. Largest count; NOT a
   count of distinct emails/threads.
2. **Tracked emails** — `front_sync_emails`. The de-duplicated operational rows
   (one per Front thread, an internal grouping detail), each carrying `match_status`.
3. **Pipeline state** — `front_sync_emails` grouped by `pipeline_state`. The processing
   lifecycle of those tracked rows.

**Matrix**

| Metric | Population / source | Definition |
| --- | --- | --- |
| Raw imported | `raw_communication_records` (`source_type='front_email'`) | All Front records ever imported, incl. per-version duplicates. Not distinct emails/threads. |
| Tracked emails | `front_sync_emails` (all rows) | De-duplicated operational rows, one per Front thread (internal grouping). |
| Matched | `front_sync_emails` `match_status ∈ {auto_matched, manually_matched}` | Tracked emails matched to a client. |
| Unmatched | `front_sync_emails` `match_status = unmatched` | Matchable emails awaiting a client match. |
| Matchable | `matched + unmatched` | Match-rate **denominator**. Excludes dismissed / blocked. |
| Match rate | `matched ÷ matchable` | Not diluted by operational dismissals (this is what fixed the misleading "~1%" headline). |
| Pipeline backlog | `front_sync_emails` grouped by `pipeline_state`, **excluding** `applied` + `triage_dismissed` | Rows still awaiting or failing processing. Includes `failed` + `dead_lettered`. |
| Applied / done | `pipeline_state ∈ {applied, triage_dismissed}` | Terminal rows — never counted as backlog. |

**Key invariants** (enforced by `shared/frontConsoleMetrics.ts`):

- Match rate is `matched / matchable`, **never** `matched / trackedTotal` and **never**
  `matched / rawImported`. Non-matchable statuses (`dismissed`, `blocked`) are excluded
  from the denominator. (The `dismissed_operational` status was removed in Task #2637; its
  rows are re-matched to `unmatched`/`auto_matched`/`dismissed`/`blocked` by the backlog
  re-match prod-action.)
- Backlog **excludes** terminal-done states (`applied`, `triage_dismissed`); folding those
  in is what made a healthy pipeline of ~137k applied rows look permanently "stuck".
- `rawImported ≥ trackedTotal` is expected (raw includes per-version dupes); they measure
  different populations and are not meant to be equal.

### Production sanity-audit note (Task #2502)

A read-only audit against the deployed Neon `neondb` confirmed the console populations
line up with the canonical model above:

- Raw imported (`raw_communication_records`, `source_type='front_email'`) is the largest
  count and exceeds the tracked-email count, as expected from per-version dupes.
- Tracked emails (`front_sync_emails`) reconcile: `matched + unmatched +
  dismissed_operational + dismissed + blocked = trackedTotal`.
- Pipeline `applied` + `triage_dismissed` (terminal-done) make up the bulk of rows; the
  computed backlog (everything else, incl. `failed` / `dead_lettered`) is the small
  remainder — confirming the prior "backlog ≈ total" reading was a labelling artifact,
  not a real stall.

No Front API calls and no coverage math were added or changed by this task; the dev
workspace DB is read-only to prod, so the audit was observational only.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `FRONT_CLIENT_ID` | env | — | OAuth client ID. |
| `FRONT_CLIENT_SECRET` | env (secret) | — | OAuth client secret. |
| `FRONT_REDIRECT_URI` | env | derived | OAuth callback. |
| `FRONT_WEBHOOK_SECRET` | env (secret) | — | HMAC verification on inbound webhooks. Audit A-003: fail-closed — in production a missing/blank value makes the webhook route return 503 before any ingestion (deployment prerequisite); non-production warns and allows for local testing. Presence-only readiness is surfaced as `webhookSecretConfigured` in the Front integration status. Front's rule-webhook scheme signs the raw body only (no timestamp header), so no replay window is cryptographically supportable — dedupe keys are the replay defense. |
| `front_access_token` | `system_settings` (secret) | — | OAuth bearer. |
| `front_refresh_token` | `system_settings` (secret) | — | Refresh token. |
| `front_token_expires_at` | `system_settings` | — | Token expiry epoch. |
| `front_oauth_state` | `system_settings` | — | OAuth CSRF state. |
| `oauth_refresh_lease:front` | `system_settings` | — | Task #2289 — cross-process OAuth refresh lease row (`{owner, acquiredAt, expiresAt}` JSON, TTL ~30s). CAS-acquired before the Front token POST so only one process (across all autoscale instances) refreshes at a time; deleted on release / reclaimed on TTL expiry. See [WORKERS_QUEUES_RUNBOOK.md § Cross-process lease](./WORKERS_QUEUES_RUNBOOK.md#cross-process-oauth-refresh-lease--deployment-gated-front-workers-task-2289). |
| `front_sync_cursor` / `front_sync_page_token` | `system_settings` | — | Legacy sync resume points. |
| `front_reconciliation_cursor` | `system_settings` | — | Periodic scan-based discovery cursor. |
| `front_producer_version` | `system_settings` | — | Producer-version stamp. |
| `front_rematch_all_cursor` | `system_settings` | — | Rematch-all cursor. |
| `front_reprocess_cursor` | `system_settings` | — | Reprocess cursor. |
| `front_recovery_jobs_index` | `system_settings` | — | Historical-recovery job index. |
| `front_recovery_max_age_days` | `system_settings` | — | Max age (days) for recovery candidates. |
| `front_recovery_prune_interval_minutes` | `system_settings` | — | Prune cadence. |
| `front_recovery_retry_alert_enabled` | `system_settings` | true | Toggle recovery retry alerts. |
| `front_recovery_checkpoint_reset_enabled` | kill switch | true | Task #1963 — guards `resetStuckRecoveryCheckpoints`. Flip OFF to hold the helper as a no-op without removing the prod-action; the `reset_stuck_front_recovery_checkpoints` action sets `force: true` so the operator surface is always functional. |
| `front_recovery_per_message_materialization_enabled` | kill switch | false | Task #1963 — when ON, `normalizeReconciliationEvent` hydrates the full message list for `historical_recovery` events and writes one `raw_communication_records` row per `msg_*` (idempotent on `external_source_id`, status `processed`). Default OFF so the deploy is behavior-neutral; flip via the `enable_front_recovery_per_message_materialization` prod-action. |

The full canonical index is in `audits/G-docs-findings.md` § 4.

## 122k-conversation backlog drain (Task #1963)

A multi-month gap in Front historical recovery (the dashboard showed 122k unfetched conversations) was traced to four compounding causes. The fix is a six-step operator runbook executed via prod-actions; each step is idempotent and individually reversible.

| Step | Cause | Operator action |
| --- | --- | --- |
| 1 | Recovery checkpoints stuck `status='partial'` with `statusReason~'safety_max_pages_reached*'` on the legacy `/conversations?` enumeration. | Apply **Reset stuck Front recovery checkpoints (Task #1963)** — clears `lastPageUrl/scanned/skipped/pages` so the next auto-closure tick rebuilds the path on the search endpoint. Window bounds and cumulative counters are preserved. |
| 2 | `isSparseSingleMonthWindow` blocked the search endpoint for any window > 32 days, forcing multi-month gaps onto the slower enumeration path. | Already shipped — the gate is removed; the helper is renamed `isSearchStrategyEligible` and now returns true for any bounded window. No operator action. |
| 3 | The apply path only wrote `last_message` per conversation, so even fully ingested historical envelopes left 5-30 messages per conversation absent from `raw_communication_records` (the 0-row pre-2025-07 months in the analytics coverage table). | Flip ON **Enable Front recovery per-message materialization (Task #1963)** *after* steps 1 + 4 + 5 have settled. The hydrated message rows are written at `processing_status='processed'` so they do not re-inflate the pending pool. |
| 4 | `raw_communication_records` had ~35k stale `pending` `front_email` rows from a decommissioned classifier path. No worker advances them; they inflated every pending-row dashboard. | Apply **Mark legacy front_email pending rows terminal (Task #1963)** — flips rows older than 30 days to `failed` with `operational_classification_reason` prefixed `[backlog-drain 2026-05] deprecated_path:`. Idempotent. |
| 5 | `front_analytics_monthly_coverage` rows pulled before Task #1837 carry `denominator_unit='inbound_conversations'` even though the values are equivalent to `conversations_all` (Task #1709 already established the Front search query was counting all directions). | Apply **Relabel Front coverage units → conversations_all (Task #1963)** — free relabel, no Front API call. Unblocks strict-equality `unitsMatch` callers. Idempotent. |
| 6 | Documentation drift. | This section + `FRONT_ANALYTICS_COVERAGE.md` § "Legacy `inbound_conversations` rows" + `replit.md` bullet. |

**Recommended apply order:** 1 → 4 → 5 → 3 (flip per-message materialization ON last, only after step 1 has refilled the queue from the search endpoint and a sample shows envelopes are landing). Steps 2 and 6 are code/doc only.

**One-button alternative:** the CEO prod-action **Drain Front 122k-conversation backlog — run all four steps (Task #1963)** (`drain_front_122k_backlog`) runs steps 1 → 4 → 5 → 3 sequentially in a single press, with a per-step breakdown in the audit detail. Each underlying step remains independently idempotent, so the combined action is also safe to re-press; the individual buttons remain available for fine-grained control or replay.

**Rollback:**
- Step 1 — flip `front_recovery_checkpoint_reset_enabled` OFF; the helper short-circuits. Already-reset checkpoints stay reset (they replay safely).
- Step 3 — flip `front_recovery_per_message_materialization_enabled` OFF; new events stop materializing. Existing rows are inert (status `processed`, no worker references them).
- Steps 4 and 5 — column updates only; no reverse action shipped. The prefixed `operational_classification_reason` (step 4) and the relabeled unit string (step 5) are the auditable markers if a future investigation needs to find them.

## 2025-11 historical-recovery re-run (Task #2717)

The `front_recovery_checkpoint_2025_11` checkpoint stuck `status='partial'` with `scanned=0/pages=0` because **page 1 hit a Front `401 "Invalid token"` immediately after a forced token refresh** — an OAuth refresh-token rotation race (see replit.md "OAuth refresh single-flight (Task #1975)"). The poison probe later auto-unblocked it (`blocked→partial`, `statusReason=auto_unblocked_after_probe_ok_was:front_auth_unauthorized_after_refresh`), but nothing re-scanned it, so 2025-11 coverage sat far below the ~9,711 conversations dev recovered for the same window.

Why the existing recovery actions don't reach it:

| Action | Match condition | Why 2025-11 is excluded |
| --- | --- | --- |
| `unblock_poisoned_front_recovery_checkpoints` (Task #1869) | `status='blocked'` + OAuth-race reason | This checkpoint is already `partial`, not `blocked`. |
| `reset_stuck_front_recovery_checkpoints` (Task #1963) | `status='partial'` + `statusReason~'safety_max_pages_reached'` + legacy `/conversations?` `lastPageUrl` | This checkpoint's reason is `auto_unblocked_*` and its `lastPageUrl` is already the `/conversations/search/<query>` endpoint. |

**Fix — CEO prod-action `rerun_front_recovery_2025_11`.** A single press re-drives JUST the 2025-11 window (`afterTimestamp=1761955200`, `beforeTimestamp=1764547200`) through the canonical engine: `runHistoricalRecovery({ customWindows:[2025-11], resumeMode:'clear_checkpoints' })`. That deletes the poisoned checkpoint, restarts from page 1 on the `/conversations/search` endpoint, and runs on the worker pool in the background (the press returns a recovery job id immediately). The per-message materializer (`front_recovery_per_message_materialization_enabled`) then fills `messages_all` rows as conversations land, raising 2025-11 coverage.

- **Idempotent:** reports `not-needed` once the checkpoint reaches `complete` with `scanned>0`; starts nothing while a run is in flight (checkpoint `running`); reports `blocked` (amber, names Front), never `error`, while Front auth is disconnected; reports `not-needed` if the recovery worker is at its concurrency cap (`front_recovery_max_concurrent_jobs`) so a re-press is safe.
- **Not self-heal-eligible:** it spawns a recovery job, so it stays a manual one-press action rather than running on the self-heal cadence.
- **Front API used (verified 2026-06-30):** `GET /conversations/search/{query}` (`after:`/`before:` unix operators, `limit` ≤ 100, `_pagination.next` cursor — https://dev.frontapp.com/reference/get_conversations-search) and `POST /oauth/token` `grant_type=refresh_token` (Basic auth, rotates `refresh_token` in the final 24h → stale token yields the original 401 — https://dev.frontapp.com/reference/post_oauth-token).
- **Rollback:** none needed — the action only re-scans an already-targeted window through the existing engine. If the re-run 401s again, the checkpoint returns to `partial`/`blocked` and the action simply reports `pending`/`blocked` again; reconnect Front and re-press.

## Message attribution backfill to 100% (Task #2662)

Coverage and attribution are separate: the message-grain coverage epic
(Task #2602) materializes per-message `raw_communication_records` rows
**without** a `client_id`, and the deterministic/manual matcher (Task #2637)
attributes whole conversations. Three residual gaps were left where a
message's attribution is already determined but had not been propagated. The
CEO prod-action **Backfill Front message attribution to 100% (Task #2662)**
(`backfill_front_message_attribution`, worker pool) closes all three in one
press via a `startBackgroundDrain` (cross-instance advisory lock,
single-flight, before/after `prod_action_runs` audit). It is **pure DB
convergence** — no Front API call, no re-matching, and it never moves the
coverage %.

| Phase | Cohort | What the drain does |
| --- | --- | --- |
| 1 | ~8,920 `front_email` messages whose conversation IS matched (`match_status` auto/manually_matched, `matched_client_id` set) but whose row `client_id` is NULL. | Stamps the conversation's matched client onto the message row, JOINing `clients` with `is_archived=false` so the orphaned-client guard is preserved. Idempotent via `client_id IS NULL`. 500-row chunks. |
| 2 | ~235 `failed` discovered-apply-tail rows (Task #2089 terminal-close). | Reconciles forward to `applied` (backfilling `ingested_record_id`) when a `raw_communication_record` now exists for the conversation. Rows with no record stay terminally `failed` and stop counting, so the phase converges. |
| 3 | 26 legacy `dismissed`/`blocked` conversations created 2026-04-01..14. | Resets to `unmatched` **only** when `evaluateFilterRules` finds no active manual filter rule still fires. Rule-protected rows are left as-is and stop counting, so a live operator block is never overridden. |

`runChunk` drives Phase 1 to exhaustion, then Phase 2, then Phase 3, so one
press converges everything and a second press is a `not-needed` no-op. When
the Front auth breaker is tripped (`frontAuthBreakerActive()`), both
`status()` and `apply()` return **`blocked`** (amber, integration `Front`) —
reconnect Front in the Integrations Hub, then apply the action.

**Rollback:** all three phases are forward state propagation with no reverse
action. The Phase 3 reset stamps `match_reason` with a `[task-2662]` marker;
Phase 1/2 are recoverable by the normal matching/apply paths if a row's
underlying conversation later changes.

## Reconcile front_email records missing a mirror (Task #2670)

The Front Console "Tracked > Matchable" gap can also be widened by a structural
hole: a `front_email` record exists in `raw_communication_records` (so it is
**tracked**) but its Front conversation id (`external_thread_id`) has **no**
`front_sync_emails` row. Because the matching surface only ever reads the mirror
table, such a conversation can never be matched, dismissed, or surfaced as
Unmatched — it just silently inflates the Tracked − Matchable delta.

The CEO prod-action **Reconcile front_email records missing a mirror (Task
#2670)** (`reconcile_front_emails_missing_mirror`, worker pool) closes this gap.
It is idempotent, breaker-aware, and runs as a `startBackgroundDrain`
(cross-instance advisory lock, in-process single-flight, before/after
`prod_action_runs` audit).

Per gap conversation the drain:
1. Creates the missing mirror via the canonical
   `mirrorWebhookToFrontSyncEmail` construction, then transitions it to
   `pipeline_state='applied'` + `match_status='unmatched'` (the column default
   — **never** `dismissed`/`blocked`).
2. Enqueues one deterministic `front_sync_reprocess` (cohort `unmatched`)
   matching pass per new mirror, dedupe-keyed so a re-press cannot double-enqueue.

The gap predicate keys on `front_sync_emails.id IS NULL` for `front_email`
records that are **not** orphaned and have a NULL `client_id`. Records that are
orphaned, already client-attributed, already mirrored, have a NULL
`external_thread_id`, or are non-`front_email` are left untouched. The batch
select is `DISTINCT ON (external_thread_id) ... ORDER BY external_thread_id,
timestamp DESC`, so multiple raw rows on one conversation produce exactly one
mirror carrying the newest record's subject. A chunk that selects rows but
creates zero mirrors returns `processed=0` to end the drain, so the action
converges to a clean `not-needed` no-op and a second press is a safe no-op.

When the Front auth breaker is tripped (`frontAuthBreakerActive()`), both
`status()` and `apply()` return **`blocked`** (amber, integration `Front`) —
reconnect Front in the Integrations Hub, then apply the action.

**Rollback:** the new mirror rows are forward-only state; they are recoverable
by the normal matching/apply paths if the underlying conversation later changes.
Verification test: `tests/prod-actions-front-emails-missing-mirror.test.ts`
(isolated-schema convergence + negative controls + idempotent second press).

## Operational workflows

### Credential rotation / reconnect
1. From the admin Integrations UI, click "Reconnect Front" — runs the OAuth flow and overwrites `front_access_token` / `front_refresh_token` / `front_token_expires_at`.
2. If the receiver was paused due to auth failure, it resumes automatically once a valid token is stored.

### Webhook secret rotation
1. Set the new secret in Front and `FRONT_WEBHOOK_SECRET` simultaneously (Front accepts both during overlap).
2. Verify a fresh webhook lands without signature errors, then remove the old secret in Front.

### Normal operation
- Live events arrive via webhook → `source_event_log` → `front_webhook_normalize` → `front_webhook_apply`.
- Periodic reconciliation also walks recent conversations to catch dropped webhook deliveries.

### Pause / disable
- Pause individual queues (`front_webhook_normalize`, `front_webhook_apply`) via the queue-drain control. See [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md).
- For a hard cutoff during an incident, remove `front_access_token` from `system_settings` — the apply queue will short-circuit cleanly.

### Historical recovery
- `frontHistoricalRecovery.ts` splits a time range into windows and persists a `WindowCheckpoint` (`lastPageUrl`) after each page.
- Restart-safe: on resume the engine restarts from the saved checkpoint.

**Per-page durability + heartbeat (Task #1636).** The checkpoint is persisted (`saveCheckpoint` + `options.onProgress`) after *every* completed page, after a page is aborted on `db_pool_saturated`, and inside the transient-error catch — not on a 5-page modulus. Each persistence point emits a `[FrontRecovery]` heartbeat with the same counters the persisted row holds, so the last persisted state and the last log line always agree. A SIGTERM/SIGINT/`beforeExit` handler does one best-effort flush of the active job and current window checkpoint, bounded by `FRONT_RECOVERY_SHUTDOWN_FLUSH_TIMEOUT_MS` (default `2000`). The auto-continue fingerprint (`buildProgressFingerprint`) now includes per-window `status`, `pages`, and `lastPageUrl` (literal `<none>` when null), so a recovery that advances even a single page is never misclassified as "no progress since last attempt" and quietly stalled.

Sample heartbeat:

```
[FrontRecovery] [job=front-recovery-2026-05-19T12-00-00-000Z-abc123] Window 2025-08: page 7 done — scanned=175 ingested=160 skipped=12 errors=0 nextPage=yes
[FrontRecovery] [job=front-recovery-2026-05-19T12-00-00-000Z-abc123] Window 2025-08: page 8 interrupted — scanned=180 ingested=164 skipped=14 errors=1 nextPage=preserved
```

- Errors are classified:
  - **Transient** (`5xx`, `429`, timeouts) → exponential backoff, auto-retry, "partial" jobs auto-continue.
  - **Non-transient** (`401`, `403`, "not connected") → job pauses and an admin alert fires; operator must reconnect Front before resuming.
- `front_recovery_max_age_days` bounds how far back a recovery can crawl.
- See `server/services/frontHistoricalRecovery.ts` for the engine and `frontHistoricalRecoveryFatalAlerts.ts` for fatal alerts.

### Bulk actions (filter-rule changes, rematch-all, reprocess)
- Enqueued on `front_bulk_action`. Cursored by `front_rematch_all_cursor` / `front_reprocess_cursor` so a job can resume after a restart.
- Bulk actions are observable via `frontPipelineMetrics`.

### Orphaned-communication audit trail (Tasks #897/#902/#966)
- Deleting a client preserves its `raw_communication_records` rows: `deleteClient` nulls `client_id`, stamps `match_status='orphaned'`, and writes a `communication_orphan_events` audit row — atomically.
- **Read surface**: `npx tsx scripts/listOrphanEvents.ts` (read-only; recent events, per-cause counts, per-source rollup). It is the only reader of `communication_orphan_events` — there is no route or UI. For production, mirror its queries through the read-only prod SQL tool.
- The table being empty is normal (no client deletion has orphaned records in prod as of 2026-08-09); see `audits/f3-operational-script-disposition-2026-08-09.md`.

### Recovery from common failures
- **Stale receiver** (`frontWebhookReceiverStalenessAlerts`) → check Front-side webhook status; resend a test event; confirm `source_event_log` row appears.
- **Apply crashes** → inspect `work_result_log` for the failing job; idempotent retry is safe.
- **Backlog growth** → use queue drain controls + backlog alerts; see workers/queues runbook.
- **Token refresh loop** → confirm `FRONT_CLIENT_SECRET` is current and re-trigger OAuth.

## Alerts and observability
- `frontPipelineMetrics.ts` — throughput, backlog, discovery-to-apply latency.
- `frontWebhookReceiverStalenessAlerts.ts` — fires when the receiver has gone quiet.
- `frontRecoveryRetryAlerts.ts` and `frontHistoricalRecoveryFatalAlerts.ts` — recovery-side alerts.
- See also [PROD_REMEDIATION.md](./PROD_REMEDIATION.md) for the documented stale-receiver remediation steps.

## Verification
- `SELECT count(*) FROM source_event_log WHERE source='front' AND created_at > now() - interval '15 min';` — should be non-zero in business hours.
- `SELECT count(*) FROM raw_communication_records WHERE source='front' AND created_at > now() - interval '15 min';` — should track ingestion.
- Trigger a test webhook from Front; confirm a fresh row appears in `source_event_log` within seconds.

### Self-healing coverage loop (Task #1682)
- The `front_analytics_coverage_refresh` worker invokes `runFrontAutoClosureTick` (see `server/services/frontAutoClosure.ts`) after each coverage snapshot. The loop auto-retries error rows via `refreshMonth`, auto-enqueues Front Historical Recovery for ingest gaps, and auto-nudges `front_webhook_apply` for apply gaps — all bounded by per-tick budgets, per-month cooldowns, kill switches (`KILL_SWITCH_NON_CRITICAL_SWEEPS`, `KILL_SWITCH_LARGE_BACKFILLS`, `KILL_SWITCH_AUTO_RETRY`), queue pause state, API pool pressure, worker-lease health, and a Front Analytics rate-limit deferral.
- Operator surface: compact status line on the Front Historical Recovery admin page and `GET /api/admin/front/auto-closure/status`. Full runbook: [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md#task-1682-front-self-healing-coverage-loop).

## Outbound email via user mailbox channels (Task #4334)

Client-facing outbound email sends **from the assigned user's own Front channel** (`POST /channels/{channel_id}/messages` via `sendFrontChannelMessage` in `frontIntegration.ts`), so sends ride each user's real mailbox reputation and both the sent message and any replies land in Front and are auto-captured by the existing sync.

- **User → channel mapping** lives in `user_email_identities` (admin UI: `/admin/outbound-email` → Mailboxes; channel picker fed by `listFrontChannels()`). A sender without an active mapping is **blocked with a clear error** (`blocked_no_mailbox`) — never silently re-routed.
- **Error taxonomy**: 5xx/timeout/mid-flight failures throw `FrontSendOutcomeUnknownError` — the send seam marks the row terminal `unknown` and alerts (a Front 500 can mean "sent but unconfirmed"; re-sending risks duplicates). Other 4xx throw `FrontSendRejectedError` (definitive, queue-retryable). 429 gets one bounded in-call retry; a single 401 triggers one forced token refresh.
- Per-user daily caps + the SendGrid overflow fallback are documented in [SENDGRID.md](./SENDGRID.md) § Client-facing outbound lane.

## Related runbooks
- [PROD_REMEDIATION.md](./PROD_REMEDIATION.md) — stale Front receiver remediation playbook.
- [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) — pausing/draining Front queues; the self-healing loop honors these pauses.
- [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md) — coverage table, refresh worker, and the Task #1682 auto-closure loop that drives it.
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## AI study backfill for materialized Front messages (Task #2963)

### What

`email_thread` rollup rows (~76% of `front_email` records) have empty `content_text`; the
`email_message` per-message rows that carry the actual bodies were never AI-studied
(the default-OFF `front_materialized_message_study_enabled` switch has never been flipped in
prod). Task #2963 closes both gaps:

- **Empty-rollup fallback**: `analyzeCommunication` now composes the thread body from sibling
  `email_message` rows (via the shared `composeEmailThreadTextFromSiblings` helper) before
  handing to the AI. The rollup row is never mutated — read-time composition only.
- **Backfill drive**: the existing `study_materialized_front_messages` prod-action (Task #2602)
  walks all `email_message` rows (`processing_status='processed'`, `ai_processed_at IS NULL`,
  `direction IN (inbound, outbound)`, `timestamp >= FRONT_ADOPTION_DATE`), matches each to a
  client via the deterministic hard-match index, and enqueues `analyze_communication` for
  matched rows only. Unmatched rows are stamped terminal with no OpenAI spend.

### Volume

~39k body-bearing `email_message` rows in the DB. Only the client-matched subset incurs AI
spend. The self-heal cadence (every 60 min) keeps draining automatically once the switch is
ON, so one press is enough to start — no re-pressing needed.

### Operator steps (prod)

1. **Enable the switch**: in the admin Settings panel (or via a direct `system_settings` write),
   set `front_materialized_message_study_enabled = true`.
2. **Press the action**: go to `/admin/prod-actions` → **"AI-study materialized Front messages"**
   and press apply. The action reports `not-needed` while the switch is OFF; after the flip it
   shows the pending count and starts the background drain.
3. **Monitor progress**: the prod-action `status()` shows the shrinking pending count. Each
   chunk claims 50 rows; the self-heal cadence runs every hour so no manual re-pressing is
   needed once started.
4. **Pause**: flip `front_materialized_message_study_enabled = false` to halt new chunks. The
   self-heal scheduler checks the switch on each tick and stops enqueuing immediately.

### Convergence guarantee

- Matched rows: `processing_status` flipped to `'pending'` → removed from `CANDIDATE_WHERE` →
  never double-enqueued (dedupeKey `analyze_<id>`).
- Unmatched rows: `ai_processed_at` stamped → removed from `CANDIDATE_WHERE` → no further spend.
- A re-press after convergence reports `not-needed` — safe no-op.

## "Bring it to 100%" simple console (Task #2691)
The CEO-facing default Front Console is a single card (`% of messages logged` + matched/unmatched/dismissed + ONE idempotent "Bring it to 100%" button + one rolled-up status); the operator tabs are demoted behind an "Advanced operator tools" disclosure. The button orchestrates the EXISTING drivers (historical recovery re-pull → finish message-grain → reach full coverage → attribution backfill) toward an honest **reachable** target that excludes plan-limited months (no infinite spinner). No new Front API call. Math: `computeFrontBringTo100Target` (`shared/frontConsoleMetrics.ts`); orchestration: `frontBringTo100.ts`. Full detail in [FRONT_ANALYTICS_COVERAGE.md § "Bring it to 100%"](./FRONT_ANALYTICS_COVERAGE.md#bring-it-to-100-simple-console-task-2691).

## Related Task # history
- Hard-match (Exact Email / Trusted Domain) policy and the durable apply pipeline evolved across the Front pipeline rebuild; see headers in `frontHardMatch.ts`, `applyPipeline.ts`, and `frontHistoricalRecovery.ts` for specific Task # citations.
