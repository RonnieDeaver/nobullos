-- =============================================================================
-- DB Pool Stability Epic — Phase 0 baseline query
-- (Task #1727 / epic .local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md)
--
-- Read-only. Pulls the 7-day production snapshot used to populate
-- docs/pool-epic-baseline.md. Run against the deployed prod target with
-- the read-only SQL tool (environment="production"); do NOT run against
-- dev because the metrics will be meaningless.
--
-- Each \echo'd section runs an independent SELECT — there are no shared
-- temp tables, so you can copy any individual block standalone.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Per-pool utilization distribution + waiter queue + slow-acquire/hold
--    counters + unknown-attribution percentage, last 7 days.
-- ---------------------------------------------------------------------------
SELECT pool_name,
  COUNT(*)                                                                       AS samples,
  ROUND(100.0 * SUM(CASE WHEN utilization_pct >= 80  THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS pct_ge_80,
  ROUND(100.0 * SUM(CASE WHEN utilization_pct >= 90  THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS pct_ge_90,
  ROUND(100.0 * SUM(CASE WHEN utilization_pct  = 100 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS pct_eq_100,
  MAX(utilization_pct)                                                           AS max_util,
  ROUND(AVG(utilization_pct)::numeric, 2)                                        AS avg_util,
  MAX(waiting_count)                                                             AS max_waiters,
  ROUND(AVG(waiting_count)::numeric, 2)                                          AS avg_waiters,
  MAX(slow_acquires_in_interval)                                                 AS max_slow_acquires,
  MAX(slow_holds_in_interval)                                                    AS max_slow_holds,
  ROUND(AVG(unknown_label_pct)::numeric, 2)                                      AS avg_unknown_pct
FROM pool_state_samples
WHERE sampled_at >= (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 7 * 24 * 3600 * 1000
GROUP BY pool_name
ORDER BY pool_name;

-- ---------------------------------------------------------------------------
-- 2) Business-hours slice (Mon–Fri, 13:00–23:59 UTC ≈ 09:00–19:59 ET).
--    Average waiter queue + average utilization during the business day.
-- ---------------------------------------------------------------------------
WITH bh AS (
  SELECT *
  FROM pool_state_samples
  WHERE sampled_at >= (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 7 * 24 * 3600 * 1000
    AND EXTRACT(DOW  FROM to_timestamp(sampled_at / 1000.0) AT TIME ZONE 'UTC') BETWEEN 1 AND 5
    AND EXTRACT(HOUR FROM to_timestamp(sampled_at / 1000.0) AT TIME ZONE 'UTC') BETWEEN 13 AND 23
)
SELECT pool_name,
  COUNT(*)                                AS bh_samples,
  ROUND(AVG(utilization_pct)::numeric, 2) AS avg_util_bh,
  ROUND(AVG(waiting_count)::numeric, 2)   AS avg_waiters_bh,
  MAX(waiting_count)                      AS max_waiters_bh
FROM bh
GROUP BY pool_name
ORDER BY pool_name;

-- ---------------------------------------------------------------------------
-- 3) Top hold labels, last 7 days. `top_hold_labels` is a JSON object
--    with three pre-sorted views (byCount / byMaxMs / byTotalMs); the
--    rollup below collapses the byCount lists across every sample so we
--    get one row per (pool, label) with total count, max single-hold
--    duration, and average per-hold duration.
-- ---------------------------------------------------------------------------
WITH labels AS (
  SELECT pool_name,
         jsonb_array_elements(top_hold_labels -> 'byCount') AS lbl
  FROM pool_state_samples
  WHERE sampled_at >= (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 7 * 24 * 3600 * 1000
    AND jsonb_typeof(top_hold_labels -> 'byCount') = 'array'
)
SELECT pool_name,
       lbl ->> 'label'                                                                                    AS label,
       SUM((lbl ->> 'count')::bigint)                                                                     AS total_count,
       MAX((lbl ->> 'maxMs')::int)                                                                        AS max_ms,
       ROUND((SUM((lbl ->> 'totalMs')::bigint)::numeric
              / NULLIF(SUM((lbl ->> 'count')::bigint), 0))::numeric, 1)                                   AS avg_ms
FROM labels
GROUP BY pool_name, lbl ->> 'label'
ORDER BY pool_name, total_count DESC
LIMIT 100;

-- ---------------------------------------------------------------------------
-- 4) work_queue throughput, last 7 days. Used as the Front-recovery
--    throughput proxy (front_webhook_normalize / front_webhook_apply /
--    front_sync_reprocess / front_analytics_coverage_refresh queues) and
--    as a wider view of what the worker scheduler has been chewing on.
-- ---------------------------------------------------------------------------
SELECT queue_name, status, COUNT(*) AS jobs
FROM work_queue
WHERE updated_at >= now() - interval '7 days'
GROUP BY queue_name, status
ORDER BY queue_name, status;

-- ---------------------------------------------------------------------------
-- 5) Per-user notification creation rate, last 7 days.
--    Proxy for `notifyUser()` call volume (the hot path Phase 1.1 targets).
-- ---------------------------------------------------------------------------
SELECT COUNT(*)                                  AS notifications_7d,
       COUNT(DISTINCT user_id)                   AS distinct_recipients,
       COUNT(*) FILTER (WHERE read_at IS NULL)   AS unread_now
FROM user_notifications
WHERE created_at >= now() - interval '7 days';

-- ---------------------------------------------------------------------------
-- Not in this script — see baseline doc § "Metrics not yet collected":
--   - SEMrush external-call count (no external_call_audit table yet —
--     ships in Phase 1.5.1)
--   - Per-route user-facing API latency (no api_latency rollup table yet
--     — ships in Phase 1.5)
--   - Probe pool utilization (pool_state_samples currently records only
--     api/worker; probe-pool sampling lands as part of Phase 1.5 work)
-- ---------------------------------------------------------------------------
