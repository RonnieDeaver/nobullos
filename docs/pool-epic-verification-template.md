# Pool Epic — Per-Phase Verification Note Template

Copy this file to `docs/pool-epic-verifications/phase-<N>.md` after the phase
deploys and at least **48 hours** of `pool_state_samples` have been collected.
Compare every metric against [`pool-epic-baseline.md`](./pool-epic-baseline.md)
and against the prior phase's verification note.

The note is required by the epic plan
([`.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md`](../.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md)
§ "Required Production Verification"). A phase is not considered shipped until
its note is committed.

---

```
Phase:
Deployment timestamp:
Telemetry window:

API pool utilization >=80% before:
API pool utilization >=80% after:

API pool 100% samples before:
API pool 100% samples after:

Peak waiter queue before:
Peak waiter queue after:

Top 10 hold labels before:
Top 10 hold labels after:

Max hold before:
Max hold after:

Worker pool utilization after:

Front recovery throughput before:
Front recovery throughput after:

Front API 429s:
Errors / dead letters:

Decision: continue / pause / rollback
```

---

## How to fill this in

- **Phase** — `1`, `1.5`, `2`, `3`, or `4` (matching the epic plan).
- **Deployment timestamp** — UTC timestamp of the production deploy that
  landed the phase's code.
- **Telemetry window** — 48 h minimum, starting after deploy. State the window
  explicitly (e.g. `2026-06-01 00:00 UTC → 2026-06-03 00:00 UTC`).
- **Before** numbers — pull from
  [`pool-epic-baseline.md`](./pool-epic-baseline.md) for Phase 1; pull from the
  previous phase's verification note for Phase 1.5+.
- **After** numbers — re-run
  [`scripts/baseline-pool-epic.sql`](../scripts/baseline-pool-epic.sql) against
  the read-only prod SQL tool (`neondb` / `neondb_owner`) over the telemetry
  window above.
- **Decision** — pick one. If `pause` or `rollback`, link the follow-up task or
  the deploy that reverted the change.

## Phase gate rule

Phase 3 may not start until both the Phase 1 and Phase 2 verification notes are
committed under `docs/pool-epic-verifications/` and show the required
improvements (API pool ≥80% sample share materially down, peak waiter queue out
of the 40 range, no DB hold label > 10 s under normal load). See
`.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md` § "Phase gate"
for the canonical statement of the gate.
