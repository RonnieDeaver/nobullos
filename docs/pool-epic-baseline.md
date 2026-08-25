# DB Pool Stability Epic — Phase 0 Baseline

**Task:** #1727 — Pool epic Phase 0 — Baseline, owners, safety switches.
**Epic plan:** [`.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md`](../.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md)
**Source SQL:** [`scripts/baseline-pool-epic.sql`](../scripts/baseline-pool-epic.sql)
**Captured:** May 21 2026 (7-day window ending at capture time)
**Target:** read-only prod (`neondb` / `neondb_owner`) via the platform read-only SQL tool. Workspace dev `DATABASE_URL` would return meaningless numbers — re-run against prod when refreshing this doc.

> Every phase of the pool epic must compare *against this baseline*. Update this doc (and re-run the SQL) before opening a new phase, and again at the end of each phase to demonstrate movement.

---

## 1. Pool utilization distribution (7-day)

`pool_state_samples` rows in the window: 6,019 per pool (api + worker; probe is not currently sampled — see § 6).

| Pool | Samples | % ≥80% | % ≥90% | % =100% | Max util | Avg util | Max waiters | Avg waiters | Max slow-acquires / interval | Max slow-holds / interval | Avg unknown-attribution % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `api`    | 6,019 | **21.07%** | **16.85%** | **15.33%** | 100 | 41.79 | **40** | 1.11 | 0 | 1,796 | 2.44 |
| `worker` | 6,019 | 26.30% | 15.07% | 15.07% | 100 | 55.24 | 9 | 0.15 | 0 | 2,619 | 3.43 |

**Reading.** The API pool spends roughly **one in seven samples pinned at 100% utilization** and one in five samples at or above the 80% threshold that `backoffForApiPoolPressure` uses. Peak waiter queue of **40** on a max-18 pool means user requests are waiting behind background work — exactly the symptom the epic exists to fix. Worker-pool utilization is higher on average (55%) but waiter queues stay in single digits, consistent with the workload-managed scheduler doing its job.

## 2. Business-hours slice (Mon–Fri 13:00–23:59 UTC ≈ 09:00–19:59 ET)

| Pool | Samples | Avg util | Avg waiters | Max waiters |
| --- | ---: | ---: | ---: | ---: |
| `api`    | 2,727 | **51.94** | 1.64 | 40 |
| `worker` | 2,727 | 48.89 | 0.10 | 6 |

API-pool utilization during business hours **averages 52%**, with an average waiter queue >1 — i.e. at any given moment during the business day there is, on average, more than one request waiting for a connection.

## 3. Top hold labels — `api` pool (7-day)

Aggregated across the per-sample `top_hold_labels.byCount` lists. Showing the top 25 by total count plus every label whose `max_ms` exceeded 60s.

| Rank | Label | Total count | Max hold (ms) | Avg hold (ms) | Notes |
| ---: | --- | ---: | ---: | ---: | --- |
| 1  | `worker:semrush_background_refresh:enrich_campaigns`        | 21,913,926 | 360,871 | 1,029 | Phase 1.2 / Phase 2 target — running on API pool. |
| 2  | `maintenance:health-metrics-sample`                         | 6,947,864  | 662,475 | 2,062 | Phase 1.3 target — non-SQL work inside DB-hold scope. |
| 3  | `worker:semrush_report_refresh`                             | 1,493,404  | 135,679 | 225   | Phase 2 target — worker, wrong pool. |
| 4  | `userNotifications:findDedupe`                              | 1,257,526  | 43,599  | 334   | Phase 1.1 target. |
| 5  | `userNotifications:userExists`                              | 1,254,435  | **94,155** | 341 | Phase 1.1 target — confirmed 94 s outlier. |
| 6  | `api:GET /api/admin/zoom/review-queue`                      | 1,072,957  | 28,799  | 58    | API route — legitimate api-pool tenant. |
| 7  | `scheduler:health-degraded-alerts`                          | 694,295    | 359,138 | 3,439 | Phase 2 target — scheduler on api pool. |
| 8  | `worker:google-drive-sync`                                  | 673,282    | 41,301  | 568   | Phase 2 target — worker on api pool. |
| 9  | `scheduler:twilio-webhook-collision-alerts`                 | 619,153    | 519,565 | 3,875 | Phase 2 target. |
| 10 | `scheduler:queue-starvation-alerts`                         | 479,634    | 519,554 | 3,450 | Phase 2 target. |
| 11 | `startup:google-drive-sync-init`                            | 459,554    | 331,222 | 664   | One-shot at boot; large hold count means re-running. |
| 12 | `startup:server-bootstrap`                                  | 339,362    | 79,193  | 323   | One-shot at boot. |
| 13 | `scheduler:rate-limit-alert-auto-retry`                     | 311,685    | 91,891  | 3,222 | Phase 2 target. |
| 14 | `maintenance:agent-matching-comparative-flush`              | 236,815    | 57,599  | 3,272 | Phase 2 target. |
| 15 | `api:GET /api/integrations/semrush/heatmap-coverage`        | 235,181    | 305     | 45    | Legitimate api-pool tenant. |
| 16 | `worker:retroactive_reprocess`                              | 231,332    | 402,100 | 3,232 | Phase 2 target. |
| 17 | `scheduler:work-scheduler`                                  | 210,016    | 72,400  | 3,044 | Phase 2 target — scheduler itself on api pool. |
| 18 | `api:GET /api/integrations/all-status`                      | 95,850     | 16,755  | 272   | Legitimate api-pool tenant. |
| 19 | `unattributed:api`                                          | 48,538     | 286,500 | 2,039 | Fallback bucket — Phase 1.5 should drive this down. |
| 20 | `api:GET /api/integrations/front/console/overview`          | 45,434     | 9,599   | 147   | Legitimate api-pool tenant. |
| 21 | `startup:bootstrap`                                         | 40,920     | 6,199   | 75    | Boot. |
| 22 | `startup:bootstrap-workers`                                 | 29,022     | 59,700  | 939   | Boot. |
| 23 | `api:PUT /api/reports/:id/sections/marketing`               | 21,510     | 9,178   | 209   | Legitimate api-pool tenant. |
| 24 | `scheduler:lease-churn-alerts`                              | 17,752     | 51,401  | 6,017 | Phase 2 target. |
| 25 | `scheduler:booking-schema-readiness-alerts`                 | 16,379     | 519,571 | 4,515 | Phase 2 target. |
| —  | `worker:semrush_heatmap_apply:apply`                        | 11,856     | **59,576** | 1,527 | Phase 1.4 target — observed 96 s outlier elsewhere. |
| —  | `scheduler:queue-drain-backlog-alerts`                      | 331        | 40,200  | 8,058 | Phase 2 target. |

**Reading.** Of the top 25 labels on the **api** pool, only six (`api:GET /api/admin/zoom/review-queue`, `api:GET /api/integrations/semrush/heatmap-coverage`, `api:GET /api/integrations/all-status`, `api:GET /api/integrations/front/console/overview`, `api:PUT /api/reports/:id/sections/marketing`, and a handful of smaller routes) are legitimate request-scoped tenants. Everything else is a worker, scheduler, maintenance sweep, boot-time job, or notification-hook DB call — i.e. the wrong pool. This is the **structural pool mis-tenancy** the epic is fixing.

## 4. Top hold labels — `worker` pool (7-day, top 15)

| Rank | Label | Total count | Max hold (ms) | Avg hold (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1  | `worker:retroactive_reprocess:run`                | 43,351,885 | 662,472 | 881 |
| 2  | `bulk_classify`                                   | 10,367,731 | 215,793 | 67 |
| 3  | `scheduler:work-scheduler`                        | 8,644,708  | 649,091 | 1,414 |
| 4  | `worker:front_analytics_coverage_refresh`         | 7,717,768  | 94,135  | 105 |
| 5  | `maintenance:front-client-matching-sweep`         | 4,719,964  | 578,928 | 1,812 |
| 6  | `worker:google-drive-sync`                        | 3,842,373  | 230,713 | 433 |
| 7  | `startup:google-drive-sync-init`                  | 2,661,874  | 330,592 | 670 |
| 8  | `worker:retroactive_reprocess:seed`               | 1,752,226  | 649,531 | 2,075 |
| 9  | `front_sync_reprocess:batch`                      | 696,622    | 662,472 | 1,914 |
| 10 | `api:POST .../historical-recovery/.../resume`     | 534,894    | 65,876  | 940 |
| 11 | `startup:server-bootstrap`                        | 327,796    | 61,700  | 781 |
| 12 | `worker:call-analysis-poll-normal`                | 186,675    | 63,600  | 2,059 |
| 13 | `front_normalize:reconciliation`                  | 183,353    | 245,605 | 1,099 |
| 14 | `worker:call-archive-process`                     | 155,947    | 64,098  | 3,672 |
| 15 | `api:POST .../historical-recovery/execute`        | 123,722    | 41,285  | 855 |

Worker pool is doing **expected** worker-pool work, but several p99 holds also exceed 60s — Phase 1.4 / Phase 2 will trim those once the api-pool fix-up makes the comparison meaningful.

## 5. work_queue throughput (7-day)

Used as the Front-recovery throughput proxy and a wider view of what the scheduler has been chewing on.

| Queue | completed | failed | dead_letter | pending | processing |
| --- | ---: | ---: | ---: | ---: | ---: |
| `front_webhook_normalize`         | 1,713 | — | 1   | **13,665** | — |
| `front_webhook_apply`             | 1,518 | 6 | 46  | **1,753**  | — |
| `front_sync_reprocess`            | 367   | 8 | —   | —          | — |
| `front_analytics_coverage_refresh`| 67    | — | —   | —          | — |
| `retroactive_reprocess`           | 1,301 | 244 | 190 | 50       | 4 |
| `bulk_classify`                   | 902   | 4 | 2   | 17         | — |
| `semrush_background_refresh`      | 512   | 30 | 30  | —          | — |
| `semrush_report_refresh`          | 794   | 17 | 13  | 125        | — |
| `semrush_heatmap_apply`           | 416   | 1 | —   | 226        | 1 |
| `zoom_transcript_backfill`        | 159   | 1 | —   | —          | — |
| (others <10 completed omitted)    |       |   |     |            | — |

**Reading.** `front_webhook_normalize` has **13,665 pending** rows against 1,713 completed in 7 days — i.e. the Front normalize lane is **not keeping up**. `front_webhook_apply` shows the same shape (1,753 pending vs 1,518 completed + 46 dead-letter). This is the throughput-starvation symptom the epic's success metrics will measure recovery from.

## 6. Notification creation rate (7-day)

| Metric | Value |
| --- | ---: |
| `user_notifications` rows inserted (7d) | **588** |
| Distinct recipients | 15 |
| Currently unread | 588 |

Low absolute volume — the `notifyUser()` problem from § 3 isn't the *count* of notifications, it's the **per-call cost** (4 roundtrips + a 90 s `userExists` hold) on the api pool.

## 7. Metrics not yet collected

These are required by the epic plan but **cannot be sampled today**; the missing surfaces are themselves Phase 1.5 deliverables. Their absence is recorded here so the baseline doc stays honest.

| Metric | Why missing | Phase that lands it |
| --- | --- | --- |
| Probe-pool utilization | `pool_state_samples` only records `api` and `worker` rows today (0 rows for `probe` in 7-day window). | Phase 1.5 (probe-pool sampling). |
| SEMrush external-call count + same-response rate | No `external_call_audit` table exists yet. | Phase 1.5.1. |
| Per-route user-facing API latency | No `api_latency_rollup` table exists yet; route latency is only observable through workflow logs. | Phase 1.5 (DB-hold rollups). |
| Front auto-heal throughput as a first-class metric | No standing rollup; today the only signal is the `work_queue` table above + `frontHistoricalRecovery.ts` logs. | Phase 1.5 / Phase 3. |
| Front recovery backoff frequency | `backoffForApiPoolPressure` does not emit a counter; backoffs are only visible in logs. | Phase 1.5 (DB-hold rollups). |

---

## 8. Owner roster

The epic requires a named owner per domain so a Phase-N change doesn't stall on "who decides?". Slots reflect today's responsibilities; rotate by editing this file (no separate registry).

| Domain | Owner (slot) | Phases they're on the hook for |
| --- | --- | --- |
| DB / pool architecture (`server/db.ts`, `server/perfConfig.ts`, `pool_state_samples`, attribution contract) | Platform on-call lead | All phases — owns the success metrics. |
| Notifications (`server/services/notifications/`, `user_notifications`) | Notifications maintainer | Phase 1.1 (`notifyUser()` rewrite), Phase 2 (worker-context tenancy). |
| SEMrush (`server/services/semrushApi.ts`, enrichment, heatmap apply) | Integrations on-call | Phase 1.2 (persistent cache), Phase 1.4 (heatmap apply long hold). |
| Front recovery (`server/services/frontHistoricalRecovery.ts`, `frontWebhookReceiverStalenessAlerts.ts`) | Front platform maintainer | Phase 3 (recovery throughput tuning). |
| Worker scheduler (`server/services/workScheduler.ts`, work-queue handlers, `workloadManager.ts`) | Worker platform maintainer | Phase 2 (tenancy migration), Phase 3. |
| Health metrics (`server/services/healthMetrics.ts`, `healthRollups.ts`, dashboard) | Platform on-call lead | Phase 1.3 (label narrowing), Phase 1.5 (rollups). |
| QA / verification (regression suite, predeploy gate) | QA owner | Per-phase verification notes (see downstream Phase epic doc task). |

If a slot is unowned at the start of a phase, do **not** start the phase — escalate.

---

## 9. Phase 0 safety switches (added by Task #1727)

Seven `system_settings` rows added with behavior-neutral defaults so any individual Phase 1+ change can be rolled back with a settings flip rather than a redeploy. See `server/services/poolEpicKillSwitches.ts` for the loader, and `audits/G-docs-findings.md § 4` for the canonical index row per switch.

**Operator surface.** The seven rows are seeded at startup by `ensurePoolEpicSwitchesSeeded()` (idempotent — never overwrites an existing row, so any prior operator flip survives). Read or flip at runtime via:

- `GET /api/health/pool-epic-switches` — returns the current snapshot (effective value, default, whether an override is in force, whether an env switch is forcing it).
- `POST /api/health/pool-epic-switches` `{ "name": "<switch>", "value": <boolean> }` — flips a single switch. Both endpoints require team-lead role and mirror the existing `/api/health/kill-switches` pattern. In-memory updates are immediate; the override cache refreshes from `system_settings` at most once every 60 s so out-of-process flips propagate without a restart.

| Setting key | Default | Phase that activates it |
| --- | --- | --- |
| `db_pool_tenancy_enforcement_enabled`                | `false` (off) | Phase 2 |
| `notify_user_optimized_path_enabled`                 | `true` (on; existing behaviour) | Phase 1.1 (mirrors existing `NOTIFY_USER_OPTIMIZED_PATH_DISABLED` env switch — both honoured during rollout) |
| `semrush_persistent_enrichment_cache_enabled`        | `false` (off) | Phase 1.2 |
| `semrush_no_external_calls_inside_db_hold_enabled`   | `false` (off) | Phase 1.2 / 1.4 |
| `front_recovery_pool_threshold_tuning_enabled`       | `false` (off) | Phase 3 |
| `external_call_audit_enabled`                        | `false` (off) | Phase 1.5.1 |
| `db_hold_rollup_enabled`                             | `false` (off) | Phase 1.5 |

---

## 10. Refresh procedure

1. Re-run `scripts/baseline-pool-epic.sql` against the read-only prod target (`environment: "production"`).
2. Replace the numeric tables in §§ 1–6 with the new output.
3. Update the "Captured" date at the top.
4. Commit in the same PR that opens the next phase — the diff is the phase's success-metric evidence.
