# pg_stat_statements regression scan (Task #1724 Phase 4.4)

Nightly job that diffs the live `pg_stat_statements` view against a
checked-in baseline and posts the top 5 regressions to the queue-health
Slack channel. Companion to the Phase 4.1 lint guard
(`scripts/lint-getdb-attribution.ts`) and the Phase 4.3 query-count
budget harness (`tests/helpers/queryBudget.ts`).

## Files

| File | Purpose |
| --- | --- |
| `scripts/pg-stat-statements-regression.ts` | The scanner. |
| `scripts/baselines/pg-stat-statements-baseline.json` | Checked-in baseline. Empty on first commit because the extension is not yet created on prod. |

## When this fires

The scanner ranks regressions by `(new_mean_ms − baseline_mean_ms) × new_calls`
— the estimated extra latency the query is contributing — and reports
only entries that pass **all** of:

- new mean ≥ baseline mean × 1.5
- new mean − baseline mean ≥ 5 ms
- new calls ≥ baseline `minCalls` (default 50)

Tiny absolute regressions and rarely-called queries are filtered out so
the channel doesn't pick up noise.

## Operator runbook

### One-time prerequisites

1. On the deployed primary, create the extension (privileged role):
   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```
   `pg_stat_statements` is already in `shared_preload_libraries` per the
   Runtime Truth Table in `replit.md`. See `PROD_REMEDIATION.md` for the
   broader context.
2. Pick the Slack channel and export its id as
   `QUEUE_HEALTH_SLACK_CHANNEL` in the nightly job's env. If unset, the
   scanner still runs and prints to stdout — useful while wiring up.

### Seed the baseline

After the extension has been live long enough to collect a steady-state
snapshot (several days of normal traffic recommended):

```sh
DATABASE_URL=<prod-url> npx tsx scripts/pg-stat-statements-regression.ts --update-baseline
```

Commit `scripts/baselines/pg-stat-statements-baseline.json` in the same
PR. The file is sorted by `queryid` to keep diffs reviewable.

### Nightly invocation

```sh
DATABASE_URL=<prod-url> \
QUEUE_HEALTH_SLACK_CHANNEL=<channel-id> \
npx tsx scripts/pg-stat-statements-regression.ts
```

Exit code is always 0 unless `DATABASE_URL` is missing or the connection
fails — this is an informational alert channel, not a blocking gate.

### Updating the baseline after a deliberate change

When a planned index drop / schema migration / query rewrite makes the
old baseline genuinely stale, re-run with `--update-baseline` and commit
the diff. The diff itself is the audit trail for "we accepted this new
floor on purpose."

### Dry-run / local check

`--dry-run` runs the scan and prints to stdout but never posts to Slack
even when `QUEUE_HEALTH_SLACK_CHANNEL` is set. Useful for verifying the
job pre-deploy.

## When the extension is missing

If `pg_stat_statements` is not installed on the target, the scanner logs
one line and exits 0. This means it's safe to wire into the nightly job
**before** the prod extension is created — it will simply be a no-op
until the operator runs the `CREATE EXTENSION` step above.

## Companion guards (Task #1724 Phase 4)

Two sibling guards ship alongside this nightly scan:

- **`scripts/lint-getdb-attribution.ts`** (wired into the
  `lint-getdb-attribution` validation workflow) flags any new file
  calling `getDb()` without a `withDbAttribution()` wrap, baselined
  against `scripts/lint-getdb-attribution.baseline.txt`. Prevents the
  regression class that buried the `notifyUser` hot path as `unknown`
  in the slow-query dashboard.
- **`tests/helpers/queryBudget.ts`** monkey-patches `pg`'s
  `Pool`/`Client` `query` methods for any scope opened via
  `runWithQueryBudget()` / `assertQueryBudget()` so route handlers can
  pin per-call query budgets. Seeded with
  `tests/notify-user-query-budget.test.ts` (combined path ≤ 1 query,
  `notifyUser` wrapper ≤ 15).

The three guards together cover: (1) attribution at AST callsite
(lint), (2) per-call query budget (test), (3) production drift
(nightly scan).
