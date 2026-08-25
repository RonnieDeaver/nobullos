# Task #1768 — Operator Activation Runbook

This runbook is the **sequenced operator procedure** for activating
the six dormant DB Pool Stability Epic switches in production. It
must be executed by an operator with `system_settings` write access
(the task agent's read-only prod SQL tool cannot flip switches).

Companion files:

- `1768-baseline.md` — pre-flight snapshot (Stage 0 already captured).
- `1768-phase-1.md`, `1768-phase-1.5.md`, `1768-phase-2.md`,
  `1768-phase-3.md` — verification note skeletons. Fill in the
  "Post-flip" sections after each stage's observation window.

Rollback table is at the bottom of this file and mirrored into
`RUNBOOKS.md`.

---

## Order of operations (do not reorder)

| Stage | Switches | Wait | Verification note |
| --- | --- | --- | --- |
| 0 | (none — pre-flight) | n/a | `1768-baseline.md` |
| 1 | `db_hold_rollup_enabled`, `external_call_audit_enabled` | ~ 70 min (one rollup cycle) | `1768-phase-1.md` |
| 2 | (none — investigation) | n/a | `1768-phase-1.5.md` |
| 3 | `db_pool_tenancy_enforcement_enabled` | 60 min + 24 h | `1768-phase-2.md` |
| 4a | `semrush_persistent_enrichment_cache_enabled` | 60 min or one SEMrush refresh cycle | append to `1768-phase-2.md` |
| 4b | `semrush_no_external_calls_inside_db_hold_enabled` | 60 min or one SEMrush apply cycle | append to `1768-phase-2.md` |
| 5 | `front_recovery_pool_threshold_tuning_enabled` | 60 min + 24 h | `1768-phase-3.md` |

If any stage trips its rollback criteria, **stop**, flip that stage's
switch back to `false`, and file a follow-up task. Do not proceed.

---

## How to flip a switch

Two equivalent paths:

1. **Admin UI:** `/admin/system-settings` → find the switch by key →
   toggle → save. Confirm the `value` column updates in the
   `system_settings` table.
2. **Direct SQL** (only if the UI is unavailable; requires production
   write access — the task agent cannot do this):
   ```sql
   UPDATE system_settings
   SET value = 'true', updated_at = NOW()
   WHERE key = '<switch_key>';
   ```

After flipping, immediately re-read to confirm:

```sql
SELECT key, value, updated_at
FROM system_settings
WHERE key = '<switch_key>';
```

Record the `updated_at` timestamp in the corresponding verification
note's "Activation timestamp" field.

---

## Per-stage verification queries

All queries are read-only and safe to run repeatedly.

### Stage 1 — observability is producing data

```sql
-- Rows should appear within ~1 hour of flipping the audit switch.
SELECT COUNT(*) AS audits_last_hour
FROM external_call_audits
WHERE called_at > (EXTRACT(EPOCH FROM NOW()) - 3600) * 1000;

-- Rollup table populated by the hourly pool-audit-rollups worker.
SELECT date, COUNT(*) AS labels
FROM db_hold_label_rollups
GROUP BY date
ORDER BY date DESC
LIMIT 5;

-- Same for external-call rollups (writes daily).
SELECT date, integration, SUM(call_count) AS calls
FROM external_call_audit_daily_rollups
WHERE date >= TO_CHAR(NOW() - INTERVAL '3 days', 'YYYY-MM-DD')
GROUP BY date, integration
ORDER BY date DESC, calls DESC;
```

Pool sanity check (re-run for every stage):

```sql
SELECT pool_name,
       ROUND(AVG(utilization_pct)::numeric, 1) AS avg_util,
       MAX(utilization_pct)                     AS max_util,
       MAX(waiting_count)                       AS max_waiters,
       ROUND(100.0 * COUNT(*) FILTER (WHERE utilization_pct >= 80)
                  / NULLIF(COUNT(*),0), 1)      AS pct_ge_80,
       ROUND(100.0 * COUNT(*) FILTER (WHERE utilization_pct = 100)
                  / NULLIF(COUNT(*),0), 1)      AS pct_eq_100
FROM pool_state_samples
WHERE sampled_at > (EXTRACT(EPOCH FROM NOW()) - 3600) * 1000
GROUP BY pool_name
ORDER BY pool_name;
```

### Stage 2 — 210 s label investigation

After Stage 1 rollups have at least one hour of data:

```sql
-- The same labels that show >10 s in pool_state_samples.top_hold_labels:
SELECT pool, hold_label,
       MAX(max_duration_ms) AS rollup_max_ms,
       SUM(count)           AS rollup_count
FROM db_hold_label_rollups
WHERE date >= TO_CHAR(NOW() - INTERVAL '1 day', 'YYYY-MM-DD')
  AND hold_label IN (
    'userNotifications:userExists',
    'userNotifications:findDedupe',
    'userNotifications:notifyCombined',
    'semrush_heatmap_apply:apply',
    'worker:semrush_background_refresh:enrich_campaigns',
    'scheduler:health-degraded-alerts',
    'scheduler:work-scheduler',
    'maintenance:front-client-matching-sweep',
    'worker:retroactive_reprocess:run'
  )
GROUP BY pool, hold_label
ORDER BY rollup_max_ms DESC;
```

If `rollup_max_ms` for each label is ≤ 10 000 ms, the
`top_hold_labels.byMaxMs` 210 s / 101 s / 662 s entries are confirmed
as stale running-top-N carryovers (Outcome A — see
`1768-phase-1.5.md`).

### Stage 3 — tenancy enforcement effect

Re-read the most-recent `top_hold_labels` JSON for the **api** pool
and confirm none of the top-5 labels by `maxMs` begin with `worker:`:

```sql
SELECT to_timestamp(sampled_at/1000) AS sampled_at,
       jsonb_pretty(top_hold_labels->'byMaxMs') AS api_top_by_max_ms
FROM pool_state_samples
WHERE pool_name = 'api'
ORDER BY sampled_at DESC
LIMIT 3;
```

### Stage 4 — SEMrush effect

```sql
-- Switch 1 (cache) — call-count drop:
SELECT date, SUM(call_count) AS calls, SUM(cache_hit_count) AS hits,
       ROUND(100.0 * SUM(cache_hit_count) / NULLIF(SUM(call_count),0), 1) AS cache_hit_pct
FROM external_call_audit_daily_rollups
WHERE integration = 'semrush'
GROUP BY date ORDER BY date DESC LIMIT 7;

-- Switch 2 (no calls inside DB hold) — heatmap label max should drop ≤ 10 s:
SELECT date, hold_label, max_duration_ms, count
FROM db_hold_label_rollups
WHERE hold_label IN ('semrush_heatmap_apply:apply',
                     'worker:semrush_background_refresh:enrich_campaigns')
ORDER BY date DESC, max_duration_ms DESC
LIMIT 20;
```

### Stage 5 — Front recovery throughput

```sql
SELECT DATE_TRUNC('hour', completed_at) AS hr,
       COUNT(*) AS completed
FROM work_queue
WHERE queue_name LIKE 'front_%'
  AND completed_at >= NOW() - INTERVAL '24 hours'
GROUP BY hr ORDER BY hr DESC;

SELECT status, COUNT(*)
FROM work_queue
WHERE queue_name LIKE 'front_%'
  AND updated_at >= NOW() - INTERVAL '24 hours'
GROUP BY status ORDER BY status;
```

Compare the hourly throughput against §8 of `1768-baseline.md`
(baseline was ~66 jobs/h).

---

## Required manual QA after each stage

| Page | Confirm |
| --- | --- |
| `/admin/db-attribution/trends` | Renders without console errors; panels populated after Stage 1. |
| `/admin/system-settings` | The switch you just flipped persists; can be flipped back. |
| `/notifications` (any user) | Bell still updates; create a test notification and confirm unread count. |
| Any SEMrush dashboard | After Stage 4 — still loads with expected data; no obvious stale rows. |
| Front Historical Recovery admin page | After Stage 5 — coverage figures continue to update; backoff history visible. |

---

## Rollback table

| Switch | Intended state | What it enables | Symptom that triggers rollback | Where to flip | Follow-up |
| --- | --- | --- | --- | --- | --- |
| `db_hold_rollup_enabled` | `true` | Hourly aggregation into `db_hold_label_rollups` for trend dashboards. | Worker-pool write pressure traced to `maintenance:db-hold-label-rollup`; rollup table runaway growth; `/admin/db-attribution/trends` errors. | Admin → System Settings, or `UPDATE system_settings SET value='false' WHERE key='db_hold_rollup_enabled'`. | File "DB hold rollup writer bug" with sample rows and timing. |
| `external_call_audit_enabled` | `true` | Per-call audit rows in `external_call_audits` + daily rollups. | Sensitive payloads/PII detected in `external_call_audits`; flusher backlog growth; audit table grows >> projected (>~50 k rows/day per integration). | Admin → System Settings, or SQL UPDATE as above. | File "External call audit bug" with offending row IDs (NEVER copy the raw payload into the ticket). |
| `db_pool_tenancy_enforcement_enabled` | `true` | `notifyUser()` (and other tenancy-aware helpers) routes worker-context callers onto `workerDb` instead of `apiDb`. | Worker pool sustained >80 % util; worker waiter queue >10; spike in `stale_lease_exhaustion` across non-Front queues; Front recovery slows; user-facing latency rises. | Admin → System Settings, or SQL UPDATE. | File "Pool tenancy routing bug" + which call sites starved. |
| `semrush_persistent_enrichment_cache_enabled` | `true` | Persistent enrichment cache used by `semrush_background_refresh`. | Stale SEMrush enrichment visible in client dashboards; SEMrush error spike; external-call audit shows a *paradoxical* call-count *increase*. | Admin → System Settings, or SQL UPDATE. | File "SEMrush enrichment cache bug" with affected client ids + observed vs expected. |
| `semrush_no_external_calls_inside_db_hold_enabled` | `true` | SEMrush apply/refresh stages external calls outside the DB-hold window (per DB Hold Rules). | `semrush_heatmap_apply` job failures; heatmap loses data; new dead-letter spike on SEMrush queues; pool holds *increase* (shouldn't happen). | Admin → System Settings, or SQL UPDATE. | File "SEMrush staged-call regression" with failing job ids and last error. |
| `front_recovery_pool_threshold_tuning_enabled` | `true` | New hysteresis-aware API-pool-pressure check + tighter inter-page sleep defaults in Front Historical Recovery worker (#1730). | Front API 429 rate spike; Front API 5xx spike; API-pool waiters >15 attributable to recovery worker; recovery dead-letter spike. | Admin → System Settings, or SQL UPDATE. | File "Front recovery tuning regression" with the offending `system_settings.front_recovery_*` values and 429/5xx rates. |

> The same table is mirrored in `RUNBOOKS.md` (§ "Pool Epic — Switch
> Rollback Reference") so on-call operators don't need to dig through
> `docs/pool-epic-verifications/`.
