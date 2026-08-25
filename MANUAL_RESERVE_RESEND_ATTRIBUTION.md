# Manual-Reserve Resend Attribution Backfill

Operator runbook for the one-off backfill that attributes older manual-reserve alert resends. Shipped under **Task #1260**.

## Why this exists

`manual_reserve_alert_dispatches` rows written before **Task #798** (and any rows ingested from the in-memory buffer fallback) have NULL `triggered_by` / `trigger_source` and the column default `is_resend = false`. The Health dashboard's "Last resend by … (source)" badge therefore renders "unknown" for them.

## What the backfill does

`scripts/backfill-manual-reserve-resend-attribution.ts` infers attribution. For every dispatch row matching:

- `is_resend = false` **AND** `trigger_source IS NULL`
- status is `sent` / `failed` / `not_configured`

…if there exists a prior `failed` dispatch row with the same `(metric, severity)` inside a lookback window (default **60 min**; override via `--window-minutes=N`), the row is stamped:

- `is_resend = true`
- `trigger_source = 'admin_ui'`

`triggered_by` stays NULL — we have no record of who clicked Resend.

## Operational notes

- Default mode is **dry-run**; pass `--apply` to write.
- Idempotent — the WHERE clause filters `is_resend = false AND trigger_source IS NULL`, so re-runs only touch still-unattributed rows.

## Verification

```sql
-- How many dispatch rows are still unattributed?
SELECT count(*) FROM manual_reserve_alert_dispatches
WHERE is_resend = false AND trigger_source IS NULL
  AND status IN ('sent','failed','not_configured');
-- Re-running the backfill with --apply should only ever decrease this count.
```

## Keywords / grep anchors

`manual_reserve_alert_dispatches`, `is_resend`, `trigger_source`, `triggered_by`, `admin_ui`, `backfill-manual-reserve-resend-attribution`.

## Related Task # history

- **Task #798** — original "show admins who recently retried failed alerts" feature; introduced the attribution columns.
- **Task #1260** — this backfill.
