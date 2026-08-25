# Task #1768 — Pre-Flight Baseline Snapshot

**Captured:** 2026-05-22 ~16:00 UTC (via read-only prod SQL tool against `neondb`).
**Captured by:** task agent for #1768.

This is the canonical Stage-0 snapshot the per-phase verification notes
(`1768-phase-*.md`) compare against. All numbers below come from live prod
telemetry, not from #1768's prose claims.

> **Operator note.** The task agent does **not** have production write
> access, so the activation steps in `1768-operator-runbook.md` must be
> executed by an operator with `system_settings` write capability. This
> file only captures *before* numbers; the verification notes are
> filled in by the operator as each phase activates.

---

## 1. Pre-flight gate

| Check | Result | Source |
| --- | --- | --- |
| #1760 merged | **Assumed yes** — operator must confirm before flipping. | task spec, "Dependencies" |
| `lint-getdb-attribution` green | **Operator must confirm** in the workflow pane. | task spec |
| `lint-db-pool-tenancy` green | **Operator must confirm** in the workflow pane. | task spec |
| `Rate limit coverage` green | **Operator must confirm** in the workflow pane. | task spec |
| No active prod incident affecting pool telemetry | **Operator must confirm.** | task spec |
| `notify_user_optimized_path_enabled` = `true` | ✅ Confirmed (set 2026-05-22 14:09:09 UTC). | `system_settings` |

If any gate above is red, **stop**. Do not proceed to Stage 1.

---

## 2. Current Phase 0 switch state

| Switch | Current | Intended steady-state |
| --- | --- | --- |
| `notify_user_optimized_path_enabled` | `true` | `true` |
| `db_hold_rollup_enabled` | `false` | `true` |
| `external_call_audit_enabled` | `false` | `true` |
| `db_pool_tenancy_enforcement_enabled` | `false` | `true` |
| `semrush_persistent_enrichment_cache_enabled` | `false` | `true` |
| `semrush_no_external_calls_inside_db_hold_enabled` | `false` | `true` |
| `front_recovery_pool_threshold_tuning_enabled` | `false` | `true` |

Plus the live-tunable Front recovery knobs introduced by #1730: none are
present in `system_settings` yet (rows absent), so the recovery worker
will fall back to code defaults until Stage 5.

---

## 3. API pool baseline

| Window | Samples | Avg util % | Max util % | % ≥ 80 % | % = 100 % | Avg waiters | Max waiters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Last 24 h | 1330 | **54.2** | 100 | **40.5** | **32.2** | 2.32 | **64** |
| Last 1 h | 52 | **91.8** | 100 | — | — | — | **34** |

The 24 h average roughly matches the "before" number quoted in the task
spec (51 %). The 1 h figure shows the API pool is **currently hot**
(>90 % avg util, 34 waiters) — i.e. the "30-minute post-publish window"
improvement that #1768 cited has since regressed. This is consistent
with the worker-namespaced labels still occupying API-pool slots
(§ 5 below) and is the strongest argument for Stage 3 (tenancy
enforcement).

**Stage 0 acceptance gate consequence:** the task spec asks for "avg
utilization ideally ≤ 20 %" before proceeding. Current state is
materially worse than that. The operator should treat the 1 h hot
window as the reason **not** to delay Stage 3, but must still
sequence observability (Stage 1) and the 210 s investigation (Stage 2)
first so any Stage 3 effect is measurable.

---

## 4. Worker pool baseline

| Window | Samples | Avg util % | Max util % | % ≥ 80 % | Avg waiters | Max waiters |
| --- | --- | --- | --- | --- | --- | --- |
| Last 24 h | 1330 | 31.4 | 100 | 9.1 | 0.06 | **7** |
| Last 1 h | 52 | 65.4 | 100 | — | — | **2** |

Worker pool has headroom (24 h avg 31 %). Tenancy enforcement is
expected to raise this; Stage 3 rollback is required if it sustains
>80 %.

---

## 5. Top DB hold labels — most recent sample (16:00 UTC, last 1 h)

Read from `pool_state_samples.top_hold_labels` directly (it is a JSONB
**object** with `byCount` / `byMaxMs` / `byTotalMs` sub-arrays — old
queries that called `jsonb_array_elements(top_hold_labels)` silently
returned zero rows because the root is not an array).

**API pool — top 5 by `maxMs`:**

| Label | count | maxMs | totalMs |
| --- | --- | --- | --- |
| `scheduler:health-degraded-alerts` | 652 | **101 055** | 2 155 196 |
| `worker:semrush_background_refresh:enrich_campaigns` | 16 463 | **101 053** | 12 930 596 |
| `scheduler:work-scheduler` | 223 | **101 049** | 663 164 |
| `worker:google-drive-sync` | 103 | **84 229** | 262 822 |
| `userNotifications:notifyCombined` | 3 436 | **74 011** | 3 927 435 |

**Worker pool — top 5 by `maxMs`:**

| Label | count | maxMs | totalMs |
| --- | --- | --- | --- |
| `maintenance:front-client-matching-sweep` | 1 653 | **101 057** | 2 582 731 |
| `worker:retroactive_reprocess:run` | 17 585 | **101 051** | 9 186 125 |
| `bulk_classify` | 227 | 74 252 | 473 201 |
| `scheduler:work-scheduler` | 2 949 | 74 038 | 2 750 529 |
| `worker:call-analysis-poll-slow` | 262 | 74 009 | 1 137 635 |

**Key tenancy-violation finding (relevant to Stage 3):**

Three labels whose name explicitly starts with `worker:` are appearing
in the **API** pool's top-N list:

- `worker:semrush_background_refresh:enrich_campaigns` (16 463 holds)
- `worker:google-drive-sync` (103 holds)
- `worker:retroactive_reprocess` (302 holds in 7 d window)

This is exactly the API-pool tenancy violation that Stage 3
(`db_pool_tenancy_enforcement_enabled = true`) was designed to stop.

---

## 6. Stage-2 investigation seed — the "210 453 ms" labels

The task spec calls out 210 453 ms (~3.5 min) top-hold entries as
suspicious. The current most-recent sample no longer shows that exact
value, but it does show several labels at **~101 050 ms** and the
7-day rollup of `top_hold_labels.byMaxMs` shows entries up to
**662 482 ms (~11 min)**.

Critical observation: **Neon's statement timeout is 210 s** and the
project's documented DB-hold SLO is 10 s with a warning at 30 s. Any
sample reporting a `maxMs` above ~210 000 ms cannot be a real
single-statement hold — Postgres would have aborted it.

The `labelStats` map in `server/db.ts` (lines 78–114) tracks a
**running maximum per label since process start**, with no decay,
windowing, or reset on rollover. The `top_hold_labels` snapshot
emitted by the pool-state sampler is just the top-N of that running
map. So any value above the statement timeout is mechanically a
**stale running-top-N carryover** from an earlier process whose state
was not reset when the new process booted — or more likely, a
multi-statement hold (transaction batch) that the in-process counter
captured as a single label burst.

**Interim verdict — Outcome A (provisional).** The observability
rollups (`db_hold_label_rollups`, populated only after Stage 1) are
the source of truth. The recommended Stage 2 procedure is in
`1768-phase-1.5-investigation.md`: after Stage 1 has populated the
rollups for one hour, compare per-label `max_duration_ms` against the
`top_hold_labels.byMaxMs` values for the same labels. If the rollup
shows no holds > 10 s for those labels, Outcome A is confirmed and a
follow-up should be filed to either window or periodically reset the
running-top-N map.

---

## 7. External-call audit baseline

| Table | Row count |
| --- | --- |
| `external_call_audits` | **0** |
| `external_call_audit_daily_rollups` | **0** |
| `db_hold_label_rollups` | **0** |

All three are empty because their writers are gated by
`external_call_audit_enabled` and `db_hold_rollup_enabled` — both
currently `false`. Stage 1 will make these populate; there is no
"before" data to compare.

---

## 8. Front recovery baseline

| Status (last 24 h, `queue_name LIKE 'front_%'`) | Count |
| --- | --- |
| `completed` | 1 600 |
| `pending` | 5 656 |
| `dead_letter` | 79 |
| `failed` | 1 |

Pending backlog by queue (all-time):

| Queue | Pending | Oldest created |
| --- | --- | --- |
| `front_webhook_normalize` | 20 798 | 2026-05-12 14:18 |
| `front_webhook_apply` | 2 071 | 2026-05-14 08:46 |
| `front_analytics_coverage_refresh` | 16 | 2026-05-22 07:45 |

**Implied throughput baseline ≈ 1 600 / 24 h ≈ 66 jobs/h** across the
Front family. The Stage 5 verification note must re-measure this same
window after `front_recovery_pool_threshold_tuning_enabled = true`
and confirm a material increase.

---

## 9. SEMrush baseline

Last 24 h job status:

| Queue | Completed | Pending |
| --- | --- | --- |
| `semrush_background_refresh` | 105 | 1 |
| `semrush_heatmap_apply` | 514 | 244 |
| `semrush_report_refresh` | 439 | 0 |

`worker:semrush_background_refresh:enrich_campaigns` appears
**16 463 times in the API-pool top-N** with `maxMs` 101 053 — both a
tenancy violation (worker label on API pool) and a hold-window
violation (>> 10 s). Stage 4 switches target both.

---

## 10. Lease-churn baseline (7-day errors)

| Queue | Error code | Count |
| --- | --- | --- |
| `retroactive_reprocess` | `stale_lease_exhaustion` | 150 |
| `retroactive_reprocess` | `startup_stale_recovery` | 107 |
| `semrush_background_refresh` | `startup_stale_recovery` | 23 |
| `semrush_report_refresh` | `startup_stale_recovery` | 10 |
| `retroactive_reprocess` | `max_processing_exhaustion` | 4 |
| (others, single-digit) | — | — |

These are watchdog numbers, not pool-pressure numbers. Provided here
so each phase's verification note can spot regressions (a Stage 3
worker-pool starvation, for example, would show up as a spike in
`stale_lease_exhaustion` across multiple queues).
