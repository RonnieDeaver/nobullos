# Pool Epic — Verification Notes Index

This directory holds the per-phase verification notes required by the
[DB Pool Stability Epic](../../.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md).

- **Baseline:** [`../pool-epic-baseline.md`](../pool-epic-baseline.md) — 7-day prod
  snapshot every phase must compare against.
- **Template:** [`../pool-epic-verification-template.md`](../pool-epic-verification-template.md)
  — copy this when authoring a new phase note.

## How to add a phase note

1. Wait until at least **48 hours** of `pool_state_samples` have accumulated
   after the phase's prod deploy.
2. `cp ../pool-epic-verification-template.md ./phase-<N>.md` and fill in every
   field. Pull "before" numbers from the baseline (Phase 1) or the previous
   phase note (Phase 1.5+); pull "after" numbers by re-running
   [`scripts/baseline-pool-epic.sql`](../../scripts/baseline-pool-epic.sql)
   against the read-only prod SQL tool.
3. Commit the file in the PR that closes the phase task.
4. Add it to the index table below.

## Phase notes

| Phase | File | Deployed | Decision |
| --- | --- | --- | --- |
| 1 — High-ROI waste reduction | _not yet committed_ | — | — |
| 1.5 — Observability & audit surface | _not yet committed_ | — | — |
| 2 — Pool tenancy cleanup | _not yet committed_ | — | — |
| 3 — Front recovery throughput | _not yet committed_ | — | — |
| 4 — Automated regression guards | _not yet committed_ | — | — |
| Final — epic acceptance | [`final.md`](./final.md) — _not yet committed_ | — | — |

## Phase gate

Phase 3 may not start until the Phase 1 and Phase 2 notes are committed in
this directory and demonstrate the required improvements (API pool ≥80%
sample share materially down vs. baseline, peak waiter queue out of the 40
range, no DB hold label > 10 s under normal load). See the
[epic plan § Phase gate](../../.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md#phase-gate)
for the canonical statement.

---

## Final Epic Acceptance Checklist

The closing reviewer signs off the epic by working through this checklist
line by line and committing the result as `final.md` in this directory. The
list is taken verbatim from the epic plan's "Final Epic Acceptance Criteria"
section — keep it in sync with that file if either changes.

- [ ] API pool is no longer routinely saturated by background work.
- [ ] API pool utilization stays below 80% during normal business hours.
- [ ] Waiter queues are rarely above single digits.
- [ ] No known DB hold label exceeds 10 seconds under normal load.
- [ ] `notifyUser()` common path no longer performs 4 DB roundtrips.
- [ ] `notifyUser()` worker-context callers use `workerDb`.
- [ ] SEMrush enrichment uses persistent cache and avoids redundant
      cold-start fetches.
- [ ] SEMrush external calls do not happen inside DB holds.
- [ ] Heatmap apply no longer holds DB connection for extreme durations.
- [ ] Periodic timers / schedulers / maintenance sweeps use `workerDb`.
- [ ] Probe pool is reserved for probe work.
- [ ] Worker pool has safe concurrency caps (no boot warning about
      `<1 spare DB worker connection`).
- [ ] Front auto-heal recovery throughput improves, or the remaining
      bottleneck is clearly identified in the verification notes.
- [ ] Operators have audit panels for external calls and DB hold trends.
- [ ] CI / regression guards prevent future pool-tenancy violations
      (scheduler/timer API-pool import lint, `notifyUser()` query-count
      test, DB hold duration guard, external call audit guard).
- [ ] Documentation and runbooks reflect the new rules:
  - [ ] `replit.md` — DB Pool Tenancy Rules + DB Hold Rules.
  - [ ] `RUNBOOKS.md` — DB pool tenancy, DB hold rules, External-call
        audit surface entries in the Operational Runbook Coverage Matrix,
        plus the Audit Surface Runbook section.
  - [ ] `WORKERS_QUEUES_RUNBOOK.md` — tenancy rule + retuned worker
        concurrency caps from Phase 2.
  - [ ] `audits/C-db-performance-findings.md` — per-phase before/after
        metrics recorded.
  - [ ] `audits/G-docs-findings.md § 4` — every new env var /
        `system_settings` key / kill switch introduced by the epic has
        a row.
- [ ] All five phase verification notes (1, 1.5, 2, 3, 4) are committed in
      this directory and each carries a `continue` decision (or the
      `pause` / `rollback` outcome is resolved in a follow-up).
