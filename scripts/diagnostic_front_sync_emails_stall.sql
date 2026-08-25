-- =============================================================================
-- Diagnostic: why has nothing been written to `front_sync_emails` since
-- 2026-04-14 12:11:21 UTC?
-- =============================================================================
--
-- Read-only diagnostic queries. Run against the production database
-- (Neon `neondb` / `neondb_owner`). Each section is a standalone SELECT
-- and can be executed independently. No DDL, no DML, no extensions
-- required.
--
-- Companion finding: docs/front-sync-emails-stall-2026-04-14-finding.md
--
-- Related finding (shares the apply-stage backlog picture; do not
-- duplicate that diagnostic here): docs/front-recovery-gap-finding.md.
-- This script focuses specifically on *what stopped writing to
-- `front_sync_emails`* on 2026-04-14 — the prior recovery-gap finding
-- explains why the rows that ARE in `front_sync_emails` aren't moving
-- to `applied`.
--
-- Background
-- ----------
-- Per the prior recovery-gap diagnostic, on 2026-05-19 production held
-- 17,805 rows in `front_sync_emails` with `pipeline_state='discovered'`
-- and a hard ceiling on `created_at` at 2026-04-14 12:11:21 UTC. The
-- gap finding analysed the apply-stage backlog (why rows don't leave
-- `discovered`); this script analyses the *insert* side — why no NEW
-- rows arrive at all.
--
-- Only two functions in the current codebase INSERT into
-- `front_sync_emails`:
--
--   * `createFrontSyncEmail`             — server/storage/communicationStorage.ts:178
--   * `upsertFrontSyncEmailWithVersion`  — server/storage/communicationStorage.ts:351
--
-- Both are declared on `IStorage`/`DatabaseStorage` but a repo-wide
-- ripgrep on 2026-05-25 found zero callers outside the storage layer
-- itself. The on-demand sync path (`syncFrontEmails` in
-- `frontIntegration.ts`) historically advanced the
-- `front_sync_cursor` / `front_last_sync_success` settings every time
-- it ran; both of those settings are frozen at 2026-04-14 12:52:58
-- UTC. The live webhook pipeline
-- (`source_event_log` → `front_webhook_normalize` → `front_webhook_apply`)
-- continued past that date, but that pipeline writes to
-- `raw_communication_records` — it does NOT touch `front_sync_emails`.
--
-- These queries verify the symptom and isolate it to the inserter
-- side.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Q1. Pipeline-state bucket counts + per-state extremes
-- -----------------------------------------------------------------------------
-- Goal: confirm there is no `applied` row, what the newest `created_at`
-- per state is, and that the cliff is at 2026-04-14.
SELECT
  pipeline_state,
  COUNT(*)::int                  AS row_count,
  MIN(created_at)                AS oldest_created,
  MAX(created_at)                AS newest_created
FROM front_sync_emails
GROUP BY pipeline_state
ORDER BY row_count DESC;
-- Shared with the recovery-gap diagnostic (Q1 there). Re-run here so
-- the reader does not have to bounce between files; the *interpretation*
-- in this finding is "what does the newest_created cliff tell us about
-- the writer?", not "what does the discovered backlog tell us about
-- apply".


-- -----------------------------------------------------------------------------
-- Q2. Per-month writer activity (insert-side cliff)
-- -----------------------------------------------------------------------------
-- Goal: see the exact month a row was last inserted. If the cliff is a
-- single date and not a long taper, the writer code path was removed /
-- disabled at that date — not "slowed down".
SELECT
  to_char(created_at, 'YYYY-MM') AS month,
  COUNT(*)::int                  AS rows_created,
  MIN(created_at)                AS first_insert,
  MAX(created_at)                AS last_insert
FROM front_sync_emails
WHERE created_at >= DATE '2025-01-01'
GROUP BY 1
ORDER BY 1;


-- -----------------------------------------------------------------------------
-- Q3. Frozen on-demand-sync cursors
-- -----------------------------------------------------------------------------
-- Goal: prove the on-demand sync (`syncFrontEmails` in
-- `server/services/frontIntegration.ts`) — historically the dominant
-- inserter into `front_sync_emails` — stopped advancing on 2026-04-14.
-- Both cursors are written by the sync loop on every successful run;
-- a frozen `updated_at` means the sync loop has not run.
SELECT key, value::text AS value, updated_at
FROM system_settings
WHERE key IN (
  'front_sync_cursor',
  'front_last_sync_success',
  'front_sync_enabled',
  'front_adoption_date',
  'front_reconciliation_cursor',
  'front_producer_version'
)
ORDER BY key;
-- Expected (observed 2026-05-25):
--   front_sync_cursor               last advanced 2026-04-14 12:52:57
--   front_last_sync_success         '2026-04-14T12:52:58.425Z'
--   front_sync_enabled              'true'    (NOT the cause)
--   front_reconciliation_cursor     advancing today (reconciliation
--                                   path is alive but does NOT write
--                                   to front_sync_emails — see Q8)


-- -----------------------------------------------------------------------------
-- Q4. Upstream live ingest is healthy
-- -----------------------------------------------------------------------------
-- Goal: distinguish "Front itself is dead" from "the writer to
-- front_sync_emails specifically is dead". `source_event_log` is the
-- canonical landing table for raw Front webhook events.
SELECT
  to_char(received_at, 'YYYY-MM-DD') AS day,
  COUNT(*)::int                      AS events
FROM source_event_log
WHERE source_system = 'front'
  AND received_at >= NOW() - INTERVAL '45 days'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 45;


-- -----------------------------------------------------------------------------
-- Q5. source_event_log absolute extremes for `source_system='front'`
-- -----------------------------------------------------------------------------
-- Goal: pin the first ever Front webhook event (the date the webhook
-- ingest was switched on) and the most recent (the heartbeat of the
-- live ingest). The first-ever date is informative because it is
-- *after* the front_sync_emails cliff — the two systems do not share
-- a writer.
SELECT
  MIN(received_at) AS oldest_event,
  MAX(received_at) AS newest_event,
  COUNT(*)::int    AS total
FROM source_event_log
WHERE source_system = 'front';


-- -----------------------------------------------------------------------------
-- Q6. raw_communication_records (front_email) — apply-side heartbeat
-- -----------------------------------------------------------------------------
-- Goal: the live webhook path (`front_webhook_apply`) writes here.
-- Use `created_at` (when the row was inserted) NOT `timestamp` (the
-- email's original send time) to confirm apply is still running.
SELECT
  to_char(created_at, 'YYYY-MM-DD') AS apply_day,
  COUNT(*)::int                     AS rows_applied,
  MIN(created_at)                   AS first_apply,
  MAX(created_at)                   AS last_apply
FROM raw_communication_records
WHERE source_type = 'front_email'
  AND created_at >= NOW() - INTERVAL '45 days'
GROUP BY 1
ORDER BY 1 DESC;
-- Healthy signature: rows_applied > 0 for most recent days. This is
-- what tells us "ingest is healthy, just not through front_sync_emails".


-- -----------------------------------------------------------------------------
-- Q7. work_queue current state for Front queues
-- -----------------------------------------------------------------------------
-- Goal: shape of every Front-related queue. The queues that DO move
-- the live path (normalize → apply) write to `raw_communication_records`
-- only — they never insert into `front_sync_emails`.
SELECT
  queue_name,
  status,
  COUNT(*)::int                       AS row_count,
  MIN(created_at)                     AS oldest_enqueued,
  MAX(created_at)                     AS newest_enqueued,
  MAX(completed_at)                   AS last_completed_at
FROM work_queue
WHERE queue_name ILIKE '%front%'
GROUP BY queue_name, status
ORDER BY queue_name, status;


-- -----------------------------------------------------------------------------
-- Q8. front_reconciliation activity vs. front_sync_emails growth
-- -----------------------------------------------------------------------------
-- Goal: confirm the Task #1825 reconciliation scheduler is enqueueing
-- jobs but that those jobs do NOT insert into `front_sync_emails`.
-- `runFrontReconciliation` (server/services/frontWebhookIngestion.ts:569)
-- pulls missed conversations from Front's REST API and enqueues
-- `front_webhook_normalize` jobs — which then flow to
-- `raw_communication_records`, bypassing `front_sync_emails`.
SELECT
  queue_name,
  status,
  COUNT(*)::int                       AS row_count,
  MIN(created_at)                     AS oldest,
  MAX(created_at)                     AS newest,
  MAX(completed_at)                   AS last_completed
FROM work_queue
WHERE queue_name = 'front_reconciliation'
GROUP BY queue_name, status
ORDER BY status;


-- -----------------------------------------------------------------------------
-- Q9. Historical-recovery job result trail (operator-triggered inserter)
-- -----------------------------------------------------------------------------
-- Goal: the only other path that can insert into `front_sync_emails`
-- in the current code is the historical-recovery runner (operator
-- "Backfill historical Front emails" admin action). Inspect a recent
-- result blob to see whether the runner is *trying* to insert and just
-- finding nothing new ("skipped: N, ingested: 0"), or whether it is
-- not running at all.
--
-- The full `front_recovery_result_*` key set is enumerated by the
-- second query; pick the most recent and read its `value::text` to
-- get the `{ scanned, ingested, skipped, errors }` totals.
SELECT key, updated_at
FROM system_settings
WHERE key LIKE 'front_recovery_result_%'
ORDER BY updated_at DESC
LIMIT 10;

-- Reading the most recent result (replace the suffix with the newest
-- key from the query above):
--   SELECT key, value::text
--   FROM system_settings
--   WHERE key = 'front_recovery_result_recovery-<id>';
--
-- Signature of "running but finds nothing": ingested=0 with a
-- non-trivial skipped count. Observed 2026-05-25 16:56:21 UTC for
-- recovery-1779727449464 — window `auto_closure:2025-10`,
-- scanned=152, ingested=0, skipped=149, errors=1.


-- -----------------------------------------------------------------------------
-- Q10. Configuration sweep — is anything explicitly gating the writer?
-- -----------------------------------------------------------------------------
-- Goal: rule out a kill switch or paused queue as the cause. The
-- conclusion of the finding is "the writer is orphaned in code, not
-- gated"; this query is the evidence for that.
SELECT
  key,
  CASE
    WHEN length(value::text) > 200 THEN left(value::text, 200) || '...'
    ELSE value::text
  END                                 AS value_preview,
  updated_at
FROM system_settings
WHERE key IN (
        'front_sync_enabled',
        'front_reconciliation_scheduler_enabled',
        'front_reconciliation_enabled',
        'front_event_ingest_enabled',
        'queue_drain_state',
        'kill_switch_non_critical_sweeps',
        'non_critical_sweeps',
        'front_recovery_pool_threshold_tuning_enabled',
        'front_recovery_ingest_concurrency',
        'front_recovery_same_response_suppression_enabled',
        'front_recovery_active_inbox_filter_enabled',
        'front_warp_speed_enabled'
      )
   OR key ILIKE 'kill_switch_%front%'
ORDER BY key;


-- -----------------------------------------------------------------------------
-- Q11. Stuck `discovered` apply-tail (Task #2089) — drain target + verify
-- -----------------------------------------------------------------------------
-- Goal: size the residual `discovered` apply tail the
-- `drain_stuck_front_discovered_apply_tail` CEO prod-action resolves, and
-- split it into the two outcomes the action produces:
--   * reconcilable → a raw_communication_records row already exists for the
--     Front conversation id (apply DID happen; the mirror just never
--     recorded it) → action moves the mirror FORWARD to 'applied'.
--   * orphan       → no raw_communication_records row → action terminally
--     closes the mirror to 'failed' with a documented [task-2089] reason.
-- Re-run AFTER the drain: stuck_discovered should be 0 (every row resolved).
SELECT
  COUNT(*)::int                                              AS stuck_discovered,
  COUNT(*) FILTER (WHERE r.external_source_id IS NOT NULL)::int AS reconcilable_to_applied,
  COUNT(*) FILTER (WHERE r.external_source_id IS NULL)::int     AS orphan_to_failed
FROM front_sync_emails f
LEFT JOIN raw_communication_records r
  ON r.source_type = 'front_email'
 AND r.external_source_id = f.conversation_id
WHERE f.pipeline_state = 'discovered'
  AND COALESCE(f.state_changed_at, f.created_at) < NOW() - INTERVAL '24 hours';
-- The action processes in 500-row chunks on the worker pool; it is
-- idempotent (the 24h-stale filter excludes any row it already resolved)
-- and the live in-flight `discovered` rows (<24h old) are never touched.


-- =============================================================================
-- Interpretation cheat sheet
-- =============================================================================
--
-- Given (Q1+Q2): max(created_at)=2026-04-14 12:11:21, zero rows since;
-- and (Q3): `front_sync_cursor` / `front_last_sync_success` both frozen
-- at 2026-04-14 12:52:58 — only ~41 min later.
--
-- | Q4/Q5 source_event_log | Q6 raw_comm applied | Q3 cursors      | Q10 kill switches | Likely cause                                                                                  |
-- |------------------------|---------------------|-----------------|-------------------|-----------------------------------------------------------------------------------------------|
-- | active (recent rows)   | active (recent)     | frozen 04-14    | none active       | **CONFIRMED.** Writer is code-orphaned: only `createFrontSyncEmail` and `upsertFrontSyncEmailWithVersion` insert into the table, and neither has any call site in the current codebase. Live ingest moved to the webhook pipeline (`source_event_log → front_webhook_normalize → front_webhook_apply → raw_communication_records`), which never touches `front_sync_emails`. |
-- | active                 | active              | frozen 04-14    | one is `false`    | A kill switch (likely `front_sync_enabled`) was flipped, suppressing the on-demand sync loop. Verify by re-running Q10 and inspecting the value; if `false`, that explains the cliff. |
-- | dead (no recent)       | dead                | frozen          | n/a               | Upstream Front ingest is itself dead — use `docs/front-recovery-gap-finding.md` Q8 / remediation D. Not this finding's scenario. |
--
-- Remediation per cause: see docs/front-sync-emails-stall-2026-04-14-finding.md.
