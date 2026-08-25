-- =============================================================================
-- Diagnostic: Front Historical Recovery — why the gap never closes
-- =============================================================================
--
-- Read-only diagnostic queries. Run against the production database (Neon
-- neondb / neondb_owner). Each section is a standalone SELECT and can be
-- executed independently. No DDL, no DML, no extensions required.
--
-- Companion finding: docs/front-recovery-gap-finding.md
--
-- Background
-- ----------
-- The Front Historical Recovery coverage report
-- (server/services/frontHistoricalRecovery.ts:1485-1602) computes a per-month
-- coverage signal as:
--
--     totalCoverage[month] = count(front_sync_emails WHERE last_message_at)
--                          + count(raw_communication_records
--                                  WHERE source_type='front_email' AND timestamp)
--     gap_threshold        = GREATEST(5, median(totalCoverage) * 0.2)
--     gap if totalCoverage[month] < gap_threshold
--
-- A row only lands in `raw_communication_records` after the Front pipeline's
-- *apply* stage runs. If apply is stalled (e.g. PERF.FRONT_PIPELINE_APPLY_ENABLED=false,
-- worker not scheduled, queue paused), `front_sync_emails` keeps growing in
-- `pipeline_state='discovered'` but `raw_communication_records` stays flat,
-- so totalCoverage never improves and the gap never closes — regardless of
-- how many pages the historical-recovery backfill scans.
--
-- These queries identify which of those conditions is true today.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Q1. Pipeline-state bucket counts (front_sync_emails)
-- -----------------------------------------------------------------------------
-- Goal: confirm the bulk of rows are stuck in a non-terminal state.
-- Expected healthy shape: most rows in 'applied'; small in-flight counts in
-- 'discovered' / 'hydrate_pending' / 'triage_pending' / 'apply_pending'.
-- Stall signature: large 'discovered' (or intermediate) count, zero 'applied'.
SELECT
  pipeline_state,
  COUNT(*)::int                       AS row_count,
  MIN(created_at)                     AS oldest_row,
  MAX(created_at)                     AS newest_row
FROM front_sync_emails
GROUP BY pipeline_state
ORDER BY row_count DESC;


-- -----------------------------------------------------------------------------
-- Q2. Age distribution of `discovered` rows, bucketed by week
-- -----------------------------------------------------------------------------
-- Goal: tell whether the stall is recent (last week's rows piling up) or
-- old (multi-week build-up that confirms apply has been off for a long time).
SELECT
  date_trunc('week', created_at)::date AS week_bucket,
  COUNT(*)::int                        AS discovered_count,
  MIN(created_at)                      AS oldest_in_bucket,
  MAX(created_at)                      AS newest_in_bucket
FROM front_sync_emails
WHERE pipeline_state = 'discovered'
GROUP BY date_trunc('week', created_at)
ORDER BY week_bucket;


-- -----------------------------------------------------------------------------
-- Q3. Intermediate pipeline stalls
-- -----------------------------------------------------------------------------
-- Goal: identify rows stuck partway through the pipeline (between discover
-- and applied) so we know exactly which stage is the bottleneck.
SELECT
  pipeline_state,
  COUNT(*)::int                       AS row_count,
  AGE(NOW(), MIN(created_at))         AS oldest_age,
  AGE(NOW(), MAX(created_at))         AS newest_age
FROM front_sync_emails
WHERE pipeline_state NOT IN ('applied', 'discovered')
GROUP BY pipeline_state
ORDER BY row_count DESC;


-- -----------------------------------------------------------------------------
-- Q4. work_queue evidence — front / apply queue activity
-- -----------------------------------------------------------------------------
-- Goal: confirm whether the apply worker is enqueueing/claiming/failing jobs.
-- If `pending` for `front_webhook_apply` is high and `completed` is zero, the
-- worker is enqueueing but never processing. If everything is zero, the
-- enqueue path itself is gated (kill switch / disabled queue / missing
-- registration).
SELECT
  queue_name,
  status,
  COUNT(*)::int                       AS row_count,
  MIN(created_at)                     AS oldest_enqueued,
  MAX(created_at)                     AS newest_enqueued,
  MIN(retry_at) FILTER (WHERE status = 'pending')  AS next_pending_retry_at
FROM work_queue
WHERE queue_name ILIKE '%front%'
   OR queue_name ILIKE '%apply%'
GROUP BY queue_name, status
ORDER BY queue_name, status;


-- -----------------------------------------------------------------------------
-- Q5. system_settings — any front / pipeline / apply / perf kill switches
-- -----------------------------------------------------------------------------
-- Goal: spot an active kill switch without needing to know the exact key.
-- Notable keys to scan for:
--   * `queue_drain_state` — per-queue pause / rate-limit state
--   * any *_enabled or *_kill_switch row touching the apply path
--   * `non_critical_sweeps` (gates auto-continue ticks via isKillSwitchEnabled)
-- NB: PERF.FRONT_PIPELINE_APPLY_ENABLED is an ENV VAR, not a system_setting;
-- check it via Q5b below (deploy env / process.env).
SELECT
  key,
  -- truncate large value blobs so output stays readable
  CASE
    WHEN length(value::text) > 500 THEN left(value::text, 500) || '...'
    ELSE value::text
  END                                 AS value_preview,
  updated_at
FROM system_settings
WHERE key ILIKE '%front%'
   OR key ILIKE '%pipeline%'
   OR key ILIKE '%apply%'
   OR key ILIKE '%perf%'
   OR key ILIKE '%drain%'
   OR key ILIKE '%kill%'
   OR key ILIKE '%sweep%'
ORDER BY key;


-- Q5b. Env-var-driven kill switch reminder (cannot be queried from SQL)
-- ---------------------------------------------------------------------
-- The single biggest apply-stage kill switch is:
--   PERF.FRONT_PIPELINE_APPLY_ENABLED  (server/perfConfig.ts:115; default true)
--
-- IMPORTANT: this flag gates *apply execution* inside
-- `applyFrontWebhookResult` (server/services/frontWebhookIngestion.ts:351),
-- NOT the enqueue. The enqueue at frontWebhookIngestion.ts:329-339 (and
-- :1012-1022) runs unconditionally. When apply is disabled, the worker
-- still claims and "completes" jobs but each one short-circuits with
-- `{applied: false, reason: "apply_stage_disabled"}` and writes nothing
-- to raw_communication_records.
--
-- The diagnostic signature is therefore:
--   * Q1: large `discovered` bucket, zero `applied`
--   * Q4: front_webhook_apply has large `completed` (not `pending`) count
--   * Q5b: FRONT_PIPELINE_APPLY_ENABLED=false in deployed env
--
-- Verify the env value via Replit Secrets / Deployment env inspector —
-- it is not visible from inside the DB.


-- -----------------------------------------------------------------------------
-- Q6. Side-by-side monthly coverage (mirrors the in-app coverage report)
-- -----------------------------------------------------------------------------
-- Goal: see the same numbers the recovery code uses, so we can confirm whether
-- the gap-threshold computation matches expectations and which months trip it.
-- Reproduces the JS logic in generateCoverageReport()
-- (server/services/frontHistoricalRecovery.ts:1485-1602):
--
--     frontSyncCount = count(front_sync_emails) by to_char(last_message_at, 'YYYY-MM')
--     rawCommCount   = count(raw_communication_records WHERE source_type='front_email')
--                      by to_char(timestamp, 'YYYY-MM')
--     totalCoverage  = frontSyncCount + rawCommCount
--     median         = totalCoverage at floor(n/2) after ascending sort
--     gapThreshold   = GREATEST(5, median * 0.2)
--     isGap          = totalCoverage < gapThreshold
--
-- The in-app report adds zero-rows for every month from 2024-01 through
-- the current month via a synthetic month spine, AND unions in any
-- months that appear only in source_event_log (pipeline events) BEFORE
-- computing the median. Both materially affect the median value and
-- thus the gap_threshold. The CTE below reproduces that exactly.
WITH spine AS (
  SELECT to_char(d, 'YYYY-MM') AS month
  FROM generate_series(
    date_trunc('month', DATE '2024-01-01'),
    date_trunc('month', NOW()),
    INTERVAL '1 month'
  ) AS d
),
fs AS (
  SELECT to_char(last_message_at, 'YYYY-MM') AS month, COUNT(*)::int AS front_sync_count
  FROM front_sync_emails
  WHERE last_message_at IS NOT NULL
  GROUP BY 1
),
rc AS (
  SELECT to_char(timestamp, 'YYYY-MM') AS month, COUNT(*)::int AS raw_comm_count
  FROM raw_communication_records
  WHERE source_type = 'front_email' AND timestamp IS NOT NULL
  GROUP BY 1
),
pe AS (
  SELECT to_char(received_at, 'YYYY-MM') AS month
  FROM source_event_log
  WHERE source_system = 'front' AND received_at IS NOT NULL
  GROUP BY 1
),
all_months AS (
  SELECT month FROM spine
  UNION
  SELECT month FROM fs
  UNION
  SELECT month FROM rc
  UNION
  SELECT month FROM pe
),
fa AS (
  -- Task #1643 — Front Analytics authoritative monthly denominator.
  -- Pulled from `front_analytics_monthly_coverage` so the SQL view and
  -- the in-app coverage dashboard always agree on the same total.
  SELECT month,
         front_total_messages           AS front_analytics_total,
         pulled_at                      AS analytics_pulled_at,
         front_analytics_status         AS analytics_status,
         front_analytics_error          AS analytics_error,
         is_finalized_month
  FROM front_analytics_monthly_coverage
),
combined AS (
  SELECT
    am.month                              AS month,
    COALESCE(fa.front_analytics_total, 0) AS front_analytics_total,
    COALESCE(fs.front_sync_count, 0)      AS front_sync_count,
    COALESCE(rc.raw_comm_count, 0)        AS raw_comm_count,
    COALESCE(fs.front_sync_count, 0)
      + COALESCE(rc.raw_comm_count, 0)    AS total_coverage,
    -- Task #1643: ingest gap = Front had it, we never fetched.
    GREATEST(
      0,
      COALESCE(fa.front_analytics_total, 0) - COALESCE(fs.front_sync_count, 0)
    )                                     AS ingest_gap,
    -- Apply gap = we fetched, never applied (today's pain point).
    GREATEST(
      0,
      COALESCE(fs.front_sync_count, 0) - COALESCE(rc.raw_comm_count, 0)
    )                                     AS apply_gap,
    -- Convenience deltas used by the dashboard headline.
    COALESCE(fa.front_analytics_total, 0)
      - COALESCE(fs.front_sync_count, 0)  AS analytics_vs_sync_delta,
    COALESCE(fs.front_sync_count, 0)
      - COALESCE(rc.raw_comm_count, 0)    AS sync_vs_raw_delta,
    fa.analytics_pulled_at,
    fa.analytics_status,
    fa.analytics_error,
    fa.is_finalized_month
  FROM all_months am
  LEFT JOIN fa USING (month)
  LEFT JOIN fs USING (month)
  LEFT JOIN rc USING (month)
),
ranked AS (
  SELECT
    month,
    front_analytics_total,
    front_sync_count,
    raw_comm_count,
    total_coverage,
    ingest_gap,
    apply_gap,
    analytics_vs_sync_delta,
    sync_vs_raw_delta,
    analytics_pulled_at,
    analytics_status,
    analytics_error,
    is_finalized_month,
    PERCENTILE_CONT(0.5)
      WITHIN GROUP (ORDER BY total_coverage)
      OVER ()                            AS median_coverage_cont,
    -- match the JS implementation exactly: value at floor(n/2) after asc sort
    (
      SELECT total_coverage
      FROM combined c2
      ORDER BY c2.total_coverage
      OFFSET (SELECT FLOOR(COUNT(*)::numeric / 2)::int FROM combined)
      LIMIT 1
    )                                    AS median_coverage_js
  FROM combined
)
SELECT
  month,
  -- Task #1643 — Front Analytics authoritative denominator (0 means
  -- not yet cached; check `analytics_status` / `analytics_error`).
  front_analytics_total,
  front_sync_count,
  raw_comm_count,
  total_coverage,
  ingest_gap,
  apply_gap,
  analytics_vs_sync_delta,
  sync_vs_raw_delta,
  median_coverage_js                                                AS median_coverage,
  GREATEST(5, median_coverage_js * 0.2)                             AS gap_threshold,
  CASE
    WHEN total_coverage < GREATEST(5, median_coverage_js * 0.2)
    THEN 'gap'
    ELSE 'ok'
  END                                                                AS verdict,
  GREATEST(5, median_coverage_js * 0.2) - total_coverage             AS below_threshold_by,
  analytics_pulled_at,
  analytics_status,
  analytics_error,
  is_finalized_month
FROM ranked
ORDER BY month;


-- -----------------------------------------------------------------------------
-- Q7. Stale work_queue leases (apply worker may be alive but wedged)
-- -----------------------------------------------------------------------------
-- Goal: detect rows leased by a worker but never released. If rows in
-- 'leased' or 'processing' status exist with very old `leased_at` (and the
-- lease has expired per `lease_expires_at`), the worker is probably dead or
-- crashed mid-job and the lease is rotting.
-- Column names per shared/models/workQueue.ts:17-52. Status enum is
-- pending|leased|processing|completed|failed|dead_letter|cancelled.
SELECT
  queue_name,
  status,
  COUNT(*)::int                       AS leased_count,
  MIN(leased_at)                      AS oldest_leased_at,
  MAX(leased_at)                      AS newest_leased_at,
  MIN(lease_expires_at)               AS earliest_lease_expiry,
  AGE(NOW(), MIN(leased_at))          AS oldest_lease_age,
  COUNT(*) FILTER (WHERE lease_expires_at IS NOT NULL
                     AND lease_expires_at < NOW())::int
                                      AS expired_lease_count
FROM work_queue
WHERE status IN ('leased', 'processing')
  AND (queue_name ILIKE '%front%' OR queue_name ILIKE '%apply%')
GROUP BY queue_name, status
ORDER BY oldest_lease_age DESC NULLS LAST;


-- -----------------------------------------------------------------------------
-- Q8. source_event_log activity (does the upstream Front ingest still tick?)
-- -----------------------------------------------------------------------------
-- Goal: distinguish "Front ingest is dead" (no recent rows) from "Front
-- ingest is running but apply is stuck" (recent rows in source_event_log but
-- no movement out of front_sync_emails.discovered).
SELECT
  to_char(received_at, 'YYYY-MM-DD')  AS day,
  COUNT(*)::int                       AS event_count
FROM source_event_log
WHERE source_system = 'front'
  AND received_at >= NOW() - INTERVAL '14 days'
GROUP BY 1
ORDER BY 1 DESC;


-- =============================================================================
-- Interpretation cheat sheet
-- =============================================================================
--
-- Symptom matrix (read against Q1, Q4, Q5, Q5b):
--
-- | Q1 'discovered' | Q4 front_webhook_apply pending | Q4 completed | Q5b env       | Likely cause |
-- |-----------------|--------------------------------|--------------|----------------|--------------|
-- | LARGE           | low / near-0                   | LARGE        | =false        | Apply disabled by env kill switch (FRONT_PIPELINE_APPLY_ENABLED). Worker is claiming and "completing" jobs but each one short-circuits and writes nothing to raw_communication_records. |
-- | LARGE           | LARGE                          | 0            | =true         | Worker not consuming queue (scheduler missing, queue paused via Q5 queue_drain_state, or dispatch concurrency = 0) |
-- | LARGE           | LARGE                          | LARGE        | =true         | Apply working but slow / behind — check Q7 for stale leases and increase concurrency |
-- | SMALL           | 0                              | LARGE        | =true         | Apply healthy; gap may be a coverage-threshold artifact — re-check Q6 against in-app gap report |
-- | 0               | 0                              | 0            | n/a           | Upstream Front ingest itself is dead — check Q8 |
--
-- Remediation per cause: see docs/front-recovery-gap-finding.md.
