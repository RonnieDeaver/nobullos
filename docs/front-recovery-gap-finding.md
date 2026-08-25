# Front Recovery Gap — Diagnostic Finding

**Status:** investigation aid. Companion to
[`scripts/diagnostic_front_recovery_gap.sql`](../scripts/diagnostic_front_recovery_gap.sql).
This document records the *shape* of the investigation and the
remediation decision tree. It is **not** a code change — fixing the
stall is an explicit follow-on.

## Observed symptom

The Front Historical Recovery panel reports the same gap months
indefinitely. The recovery backfill (`runHistoricalRecovery` in
`server/services/frontHistoricalRecovery.ts`) keeps scanning
pages and the per-page heartbeat (Task #1636) confirms forward
progress on the *scan* side, but the coverage report's gap
verdict for those months never flips to `ok`. Auto-continue
either keeps re-launching the same windows or skips them as
`no_progress_since_last_attempt`.

Leading suspect at the time of this finding: ~17,805 rows in
`front_sync_emails` stuck at `pipeline_state = 'discovered'` with
zero rows in `'applied'`. The coverage report sums
`front_sync_emails` + `raw_communication_records` per month, so
`frontSyncCount` does grow as the backfill discovers rows — but
`raw_communication_records` only grows after the apply stage runs,
and for high-volume historical months the `frontSyncCount` alone
is rarely enough to clear `GREATEST(5, median*0.2)`. The result:
"the gap never closes" even when the upstream Front fetch is
working perfectly.

## Why the gap metric can't improve when apply is stalled

The coverage report at
`server/services/frontHistoricalRecovery.ts:1485-1602` computes:

```
totalCoverage[month] = count(front_sync_emails WHERE last_message_at)
                     + count(raw_communication_records
                             WHERE source_type='front_email' AND timestamp)
gap_threshold        = GREATEST(5, median(totalCoverage) * 0.2)
isGap                = totalCoverage[month] < gap_threshold
```

Two consequences:

1. **`raw_communication_records` is the apply-stage output.** Rows
   only land there after the Front pipeline's apply step runs
   inside `applyFrontWebhookResult`
   (`server/services/frontWebhookIngestion.ts:347-353`).
   `PERF.FRONT_PIPELINE_APPLY_ENABLED` (env-only, default `true`,
   sourced at `server/perfConfig.ts:115`) gates the *execution* of
   that handler at line 351 — when `false`, the handler immediately
   returns `{applied: false, reason: "apply_stage_disabled"}` and
   writes nothing. The upstream enqueue at lines 329-339 (and
   :1012-1022) runs unconditionally, so jobs **do** queue and get
   "completed" by the worker; they just don't apply.
2. **`front_sync_emails.last_message_at`** *does* increment as the
   backfill scans pages, but the apply-disabled rows it inserts
   stay in `pipeline_state='discovered'` and their
   `last_message_at` is still counted. So `frontSyncCount` may
   grow modestly while `rawCommCount` stays flat — but the gap
   threshold (`median * 0.2`) for a month that should have
   hundreds of conversations is rarely met by `frontSyncCount`
   alone for the historical month, so the verdict stays `gap`.

## Confirmed root-cause query output

Run [`scripts/diagnostic_front_recovery_gap.sql`](../scripts/diagnostic_front_recovery_gap.sql)
against production and paste the results into the placeholders
below.

### Q1 — pipeline-state buckets (production, 2026-05-19 21:40 UTC)

```
pipeline_state | row_count | oldest_row              | newest_row
---------------+-----------+-------------------------+-------------------------
discovered     | 17,805    | 2026-03-31 16:24:27 UTC | 2026-04-14 12:11:21 UTC
failed         |     5     | 2026-03-31 16:33:14 UTC | 2026-03-31 16:33:27 UTC
applied        |     0     | —                       | —
```

### Q4 — work_queue front/apply activity (production, 2026-05-19)

```
queue_name              | status      | row_count | oldest_enqueued       | newest_enqueued
------------------------+-------------+-----------+-----------------------+-----------------------
front_webhook_normalize | pending     |    13,857 | 2026-05-11 21:42:33   | 2026-05-19 21:38:33
front_webhook_normalize | completed   |     3,174 | 2026-05-11 19:50:39   | 2026-05-11 21:42:32
front_webhook_normalize | dead_letter |         1 | 2026-05-17 06:58:14   | 2026-05-17 06:58:14
front_webhook_apply     | pending     |     1,834 | 2026-05-12 16:53:24   | 2026-05-19 21:38:14
front_webhook_apply     | completed   |     1,023 | 2026-05-11 19:57:36   | 2026-05-19 21:38:43
front_webhook_apply     | dead_letter |       301 | 2026-05-11 19:57:18   | 2026-05-19 21:38:45
front_webhook_apply     | failed      |         8 | 2026-05-12 03:44:58   | 2026-05-19 11:58:54
front_sync_reprocess    | pending     |        28 | 2026-05-19 18:36:25   | (rolling)
front_sync_reprocess    | completed   |     5,126 | 2026-04-14 14:10:47   | 2026-05-19 21:19:51
front_sync_reprocess    | failed      |        96 | 2026-04-14 14:22:51   | 2026-05-17 11:55:33
front_sync_reprocess    | dead_letter |         2 | 2026-04-14 14:22:57   | 2026-04-29 06:02:56
```

Throughput sample (completed in last 1h / 24h, pending now):

```
front_webhook_normalize:  64 / 472 / 13,857 pending
front_webhook_apply:      60 / 433 /  1,834 pending  (+ 301 dead_letter)
```

Apply dead-letter error breakdown:

```
count | error
------+----------------------------------------------------------------------------
  257 | e.toISOString is not a function     (Task #1045-era bug, code now fixed)
   36 | Connection terminated due to connection timeout
    4 | duplicate key value violates unique constraint "as_work_result_target_idx"
    1 | startup_stale_recovery
    3 | db_connection_timeout / Connection terminated due to connection timeout
```

### Q5 — system_settings kill switches (production)

No `queue_drain_state` row exists (no per-queue pause). No
`non_critical_sweeps` row exists. `front_sync_enabled = true`.
The only `kill_switch_*` entries are
`kill_switch_bulk_classify=false` and
`kill_switch_retroactive_reprocess=false` — both *off*, neither
related to the apply path.

### Q5b — env-var kill switch (cannot be queried from SQL)

`PERF.FRONT_PIPELINE_APPLY_ENABLED` is sourced from
`FRONT_PIPELINE_APPLY_ENABLED` in the deployed environment
(`server/perfConfig.ts:115`). Default is `true`. Operator must
verify the deployed value via Replit Secrets / Deployment env
inspector — the value is not visible from inside the DB.

Recorded value at investigation time: **unset (default true)** —
inferred from Q4: `front_webhook_apply` shows 1,023 `completed`
and 301 `dead_letter` rows with real Postgres errors (e.g.
`duplicate key value violates unique constraint`), which only
occur when apply actually executes. If the kill switch were
`false`, every job would short-circuit and `completed` rows
would carry no DB errors.

### Q6 — side-by-side monthly coverage (production, fs vs rc since 2025-08)

```
month   | front_sync_count | raw_comm_count
--------+------------------+----------------
2025-08 |                3 |              1
2025-09 |                1 |              0
2025-10 |                1 |              1
2025-11 |                0 |              0
2025-12 |                2 |              2
2026-01 |               12 |              9
2026-02 |              860 |            132
2026-03 |            4,179 |          1,267
2026-04 |            1,858 |            522
2026-05 |                0 |              0   ← current-month writes blocked behind backlog
```

The `fs >> rc` ratio for 2026-02 through 2026-04 confirms the
apply stage *is* writing to `raw_communication_records` but is
many thousands of rows behind. 2026-05 is empty because the
normalize → apply backlog never reached current-month events.

## Verdict

> **Confirmed cause (production, 2026-05-19):** *Not* the env
> kill switch (case A from the symptom matrix). Apply IS enabled,
> the worker IS running, and `raw_communication_records` IS
> growing — just far too slowly to clear the backlog. The real
> picture is a **compound case B + C**:
>
> 1. **Normalize stage is the upstream bottleneck.**
>    `front_webhook_normalize` has 13,857 pending jobs (oldest
>    enqueued 2026-05-11) and is draining at ~64 jobs/hour. At
>    that rate the existing backlog alone would take ~9 days,
>    and new rows arrive faster than they drain. Until those
>    rows leave `discovered`, the apply queue cannot grow them
>    into `applied`.
> 2. **Apply stage has a 301-row dead-letter backlog from the
>    Task #1045 timestamp bug.** That code bug was fixed (see
>    `applyFrontWebhookResult` lines 376–397 and
>    `shared/utils/safeDate.ts`) but the dead-lettered rows from
>    before the fix still need an explicit replay via
>    `scripts/replay-front-webhook-apply-dead-letter.ts --apply`.
> 3. **A small tail of DB-connection-timeout dead-letters (~39
>    rows)** indicates apply-pool saturation under burst load —
>    operationally benign once the upstream backlog is gone, but
>    worth watching after the replay.
> 4. **4 rows dead-lettered with a unique-constraint violation**
>    on `as_work_result_target_idx`. These are genuine
>    idempotency collisions where the row was already applied;
>    they are safe to leave dead-lettered or replay (replay will
>    short-circuit on `already_exists`).
>
> The original "17,805 rows stuck because apply is disabled"
> hypothesis from Task #1640 is **not** what's happening on
> production today. The 17,805 figure is real, but the cause is
> throughput, not a kill switch.

## Recommended remediation

These are the candidate follow-on actions per identified cause.
Choose the one that matches the verdict above; do **not** combine
without operator approval.

### A. Env kill switch is off (`FRONT_PIPELINE_APPLY_ENABLED=false`)

Diagnostic signature: Q1 shows large `discovered` count and zero
`applied`. Q4 shows `front_webhook_apply` with a large `completed`
count (jobs ran but short-circuited) and `pending` close to zero.
Q5b confirms `FRONT_PIPELINE_APPLY_ENABLED=false` in the deployed
env.

1. Confirm via Replit Deployment env that
   `FRONT_PIPELINE_APPLY_ENABLED` is in fact set to `false` (the
   default is `true`, so the variable must have been explicitly
   set).
2. Decide whether the disable was intentional (incident response)
   or accidental. Check deploy history / chat for the change.
3. If safe to re-enable: set `FRONT_PIPELINE_APPLY_ENABLED=true`
   (or delete the env var to fall back to the default) and
   redeploy. The next time each backlog `discovered` row's
   webhook is re-applied (via filter-rule re-apply, manual replay,
   or normal incoming activity), apply will actually run. There
   is **no automatic backfill of the 17,805 rows** — operator
   must trigger a deliberate replay path (e.g.
   `front_filter_rule_apply` or a recovery window) to drain them.
4. Monitor `front_sync_emails` `pipeline_state='applied'` count
   (rerun Q1) — it should begin rising.

### B. Worker is not consuming a populated queue

Diagnostic signature: Q4 shows `front_webhook_apply` with a large
`pending` count and `completed` near zero.

1. Check `system_settings.queue_drain_state` (Q5) for an entry
   pausing or rate-limiting `front_webhook_apply` —
   `WORKERS_QUEUES_RUNBOOK.md` documents how to flip it back.
2. Check the scheduler registration — confirm
   `front_webhook_apply` is in the active queue list and not
   silently removed. If missing, the registration is a code
   bug, not an ops fix.
3. Check Q7 for stale leases; rows stuck in `leased` or
   `processing` with very old `leased_at` (and an expired
   `lease_expires_at`) mean a dead worker is holding leases.
   Restart the deployment to clear them.

### C. Apply is running but behind

1. Q1 still shows a large `discovered` bucket and Q4 shows
   non-zero `completed` with `pending` slowly draining.
2. No remediation needed beyond patience, unless throughput is
   inadequate for the backlog. In that case, consider raising
   the `front_webhook_apply` concurrency in
   `server/services/queueMaxProcessing.ts` (currently 5) and
   redeploying.

### D. Upstream Front ingest is itself dead

1. Q8 shows zero `source_event_log` rows for `source_system='front'`
   in the last 14 days.
2. Open the existing Front observability runbook (`FRONT.md`)
   and follow the webhook-receiver / token-refresh playbook.
   This is a different failure mode from the apply-stage stall
   this finding documents.

## Out of scope for this finding

- Actually flipping the kill switch, restarting the deployment,
  changing concurrency, or modifying scheduler registration. Each
  remediation above is a separate, operator-approved follow-on.
- Changes to the coverage report formula, the recovery panel UI,
  or the `BackfillJobsPanel`.
- Any schema migrations.

## How to refresh this finding

1. Re-run the SQL script against the current production database.
2. Replace the `<FILL>` placeholders with the latest output.
3. Update the **Verdict** section if the symptom matrix row has
   changed.
4. If a remediation has been applied since the last refresh,
   note it under a new `## History` section dated by the
   operator initials and date.

## History

### 2026-06-01 — Task #2089 — residual `discovered` apply-tail drain shipped

The large-scale apply gap this finding tracked has materially cleared
(see [`front-recovery-zero-ingest-2026-05-26.md`](./front-recovery-zero-ingest-2026-05-26.md)).
What remained was a ~6,914-row *inert* tail in
`pipeline_state='discovered'` (2026-03-31..2026-04-14) that the live
apply pipeline, the dead-letter replay, and the recovery auto-closure
ticks never re-touch — those paths only re-drive rows that still have a
pending / dead-letter apply job or a fresh normalize event, and these
rows have neither.

Remediation E's residual tail now has a deterministic resolver: the
`drain_stuck_front_discovered_apply_tail` CEO prod-action (worker-pool
background drain, 500-row chunks, idempotent). For each row stuck >24h it
reconciles forward to `applied` when a `raw_communication_records` row
already exists for the Front conversation id (apply DID happen; the
mirror just never recorded it, `ingested_record_id` backfilled),
otherwise it terminally closes the row to `failed` with a documented
`[task-2089]` reason. It writes only the `front_sync_emails` mirror,
never an authoritative entity. We deliberately do NOT re-enqueue onto
`front_sync_reprocess`: that worker updates the match/ingest layer but
never advances the mirror `pipeline_state` machine, so it could not
satisfy the "resolves to applied/failed" requirement on its own. Size
and verify with **Q11** in
[`scripts/diagnostic_front_sync_emails_stall.sql`](../scripts/diagnostic_front_sync_emails_stall.sql).

### 2026-05-23 — Task #1803 diagnostic refresh (still no production mutations)

Diagnostic re-run against production `neondb` 2026-05-23 ~12:30 UTC. The
2026-05-19 verdict (compound throughput + Task #1045 DL pile) is unchanged
**but worse**:

- `front_sync_emails` `discovered` is unchanged at **17,805** (zero forward
  progress in 4 days; `applied` still 0).
- `front_webhook_normalize` pending **grew from 13,857 → 20,154 (+45 %)**.
  Zero new pending rows in the last 24h — every pending row is older than
  one day. Workers are alive (sample completed_at = 2026-05-23 12:23:26
  for normalize, 12:19:44 for apply) but moving ~2 jobs per 6h on
  observable samples, far below the ingest rate.
- `front_webhook_apply` dead_letter **grew from 301 → 676 (+125 %)**.
  Remediation E's Step 1 (`replay-front-webhook-apply-dead-letter.ts
  --apply`) was never executed — pre-Task-#1045-fix rows are still
  dead-lettered and new errors are layering on top.
- All Task #1803 observability + tuning kill switches are still at safe
  defaults (`external_call_audit_enabled=false`,
  `db_hold_rollup_enabled=false`,
  `front_recovery_pool_threshold_tuning_enabled=false`,
  `front_recovery_ingest_concurrency=1`). None of the planned flips have
  been applied to prod.
- Applied coverage = 4,412 / 130,054 = **3.4 %** (vs ~3.1 % on 2026-05-19).

**Why nothing has moved:** the workspace agent that picked up Task #1641
and now Task #1803 has read-only SQL access to prod and no write path —
`scripts/*.ts --apply` mutates the dev Helium DB, not Neon. Operator with
deploy-shell access is still the bottleneck.

**Path forward (agreed with operator 2026-05-23):** the Remediation E
script run, the three observability/tuning switch flips, the
`front_recovery_ingest_concurrency` ramp to 2, and the cancel-stale-rows
write are all being moved into a single CEO-only "Apply pending prod
writes" button shipped under **Task #1804** so the workspace agent can
land prod-side writes through a server-process button press instead of
waiting on a human shell session per task. Task #1803 Stages 1/2/3 and
Stage 4's remediation step transition there.

### 2026-05-19 — Task #1641 diagnostic refresh (no production mutations yet)

Diagnostic re-run against production `neondb`. All `<FILL>`
placeholders above were replaced with the actual values pulled
from production at 2026-05-19 21:40 UTC.

**Verdict changed.** Task #1640 hypothesized the apply stage was
gated by `FRONT_PIPELINE_APPLY_ENABLED=false`. That is not what
production shows. Apply is enabled, the worker is running, and
`raw_communication_records` *is* receiving rows — the system is
simply throughput-bottlenecked at the normalize stage and is
carrying a 301-row dead-letter pile from the Task #1045 era
timestamp bug that has since been fixed in code.

**Operator action required (cannot be done from the task-agent
isolated workspace).** The task-agent environment can read
production through the read-only SQL skill but cannot:

- mutate `work_queue` rows in production (no production write
  path is exposed to the agent), or
- run `scripts/replay-front-webhook-apply-dead-letter.ts --apply`
  against production (the script connects to whatever
  `DATABASE_URL` is set in the runtime, and the agent's
  workspace `DATABASE_URL` points at the Replit-managed dev
  Helium database, not Neon prod).

The deliberate replay path therefore has to be triggered by an
operator with deploy-shell access. The recommended sequence is
in the new **Remediation E** block below.

### Remediation E — Compound: drain normalize backlog + replay apply DL

Diagnostic signature: Q4 shows a large `front_webhook_normalize`
`pending` count *and* a non-trivial `front_webhook_apply`
`dead_letter` count, Q1 shows large `discovered` and zero
`applied`, Q5/Q5b confirm no kill switch is active.

1. **Replay the apply dead-letter backlog (safe; idempotent).**
   From the deployed environment (deploy shell or one-off task
   on the `autoscale` deployment), run:

   ```
   tsx scripts/replay-front-webhook-apply-dead-letter.ts            # dry run
   tsx scripts/replay-front-webhook-apply-dead-letter.ts --apply    # actually replay (cap 500/batch)
   ```

   The 257 `e.toISOString` rows will succeed once replayed
   because the Task #1045 timestamp fix is already deployed
   (`server/services/frontWebhookIngestion.ts:376-397`). The 4
   `as_work_result_target_idx` collisions will short-circuit on
   `already_exists` and remain harmless. The ~39 connection-
   timeout rows will mostly succeed after replay; a small tail
   may bounce back into the DL pile and can be replayed again.

2. **Let the normalize backlog drain.** No code change is
   required — `front_webhook_normalize` is currently moving
   ~64 jobs/hour against ~13.8k pending. There is no per-queue
   pause (`queue_drain_state` is empty) and no kill switch
   active. Throughput is bounded by `front_webhook_normalize`
   concurrency in `server/services/queueMaxProcessing.ts:54-55`
   (max processing window = 5 min/job slot). If the operator
   wants to drain faster, raise the per-queue concurrency in
   `server/services/workScheduler.ts` *or* shorten the slot in
   `queueMaxProcessing.ts`; either is a code change and should
   be its own follow-up.

3. **Verify drain is real**, not just churn. Re-run Q1 +
   throughput sample after 1 hour and after 24 hours:

   ```sql
   SELECT pipeline_state, COUNT(*)::int FROM front_sync_emails GROUP BY 1;
   SELECT
     COUNT(*) FILTER (WHERE status='completed'
                        AND completed_at >= NOW() - INTERVAL '1 hour')::int AS completed_last_hour,
     COUNT(*) FILTER (WHERE status='pending')::int AS pending_now
   FROM work_queue WHERE queue_name='front_webhook_apply';
   ```

   Success criteria: `front_sync_emails.pipeline_state='applied'`
   count becomes non-zero and grows monotonically; per-month
   coverage report verdict for 2026-02 through 2026-04 flips
   from `gap` to `ok` as `raw_communication_records` catches up.

4. **Do not** flip `FRONT_PIPELINE_APPLY_ENABLED` — it is
   already at its default (`true`). Setting it to anything
   would only make this worse.
