# Front recovery zero-ingest diagnosis (2026-05-26)

Read-only diagnostic. Snapshot taken 2026-05-26 ~22:00 UTC against
production (`neondb`). Companion to
[`scripts/diagnostic_front_recovery_gap.sql`](../scripts/diagnostic_front_recovery_gap.sql)
and [`docs/front-recovery-gap-finding.md`](./front-recovery-gap-finding.md).
Task scope (Task #1880) is diagnosis only — no code or kill-switch changes.

## TL;DR

* The `safety_max_pages_reached_resume_available scanned=25000 ingested=0
  skipped=25000` pattern that fills the auto-closure log is **not** an
  apply-side miss or a malformed-key bug **for the rows that actually
  hit it**. The 25,000 convs that come back from Front for those
  windows are 100% already-present `source_event_log` rows from earlier
  recovery passes, and `source_event_log.dedupe_key` is the
  `UNIQUE` that drops them. That is the literal definition of
  `duplicate_ignored` and is working as designed.
* However, the **trailing empty suffix in the dedupe key (`front:recovery:cnv_<id>:`)
  is a real bug, not a log artifact**. 25,000 / 25,000 recent
  `historical_recovery` events have `payload_json->last_message`
  literally `null`, so the versioned-discovery branch
  (`PERF.FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED = true`) computes
  `lastMsgId = ""`. Every message on the same conv collapses to one
  dedupe entry. **Today this hurts us only on re-bumped threads** —
  Front's `sort_by=date` puts a thread back on page 1 whenever a new
  message lands, and we then drop the new message as a duplicate
  instead of fetching it. It is not what is producing the
  `ingested=0 skipped=25000` line you see, but it **is** masking
  legitimate new content on already-seen threads.
* The compound apply gap reported in
  [`front-recovery-gap-finding.md`](./front-recovery-gap-finding.md)
  has materially cleared since the 2026-05-23 entry. `front_sync_emails`
  is now **30,376 applied / 6,914 discovered / 0 failed** (was
  17,805 discovered / 0 applied on 2026-05-19). The remaining issue
  is **ingest coverage**, not apply throughput.

## Inputs

### Q1 — pipeline-state buckets (2026-05-26 22:00 UTC)

```
pipeline_state | row_count | oldest_row              | newest_row
---------------+-----------+-------------------------+-------------------------
applied        |    30,376 | 2026-03-31 16:24:27 UTC | 2026-05-26 21:59:20 UTC
discovered     |     6,914 | 2026-04-01 00:46:03 UTC | 2026-04-14 12:11:21 UTC
```

The `discovered` bucket is the residual from the apply-stall epic
(Task #1641 / Task #1803). None of those rows have moved since
2026-04-14 — apply is no longer touching them. (Out of scope here;
see "Recommended follow-up tasks" below.)

### Q4 — work_queue front/apply activity (current)

```
queue_name              | status     | row_count
------------------------+------------+----------
front_webhook_normalize | completed  | 30,388
front_webhook_normalize | cancelled  |      1
front_webhook_apply     | completed  | 34,092
front_webhook_apply     | cancelled  |  5,003
front_sync_reprocess    | completed  |  5,880
front_sync_reprocess    | pending    |    319
front_sync_reprocess    | processing |      1
front_reconciliation    | completed  |    112
front_reconciliation    | failed     |      1
```

Apply is draining, normalize is drained, only reprocess has a small
pending tail.

### Q6 — per-month coverage (2024-01 → 2026-05)

`Front Total` is whichever denominator the row holds —
`analytics_reports` (`inbound_messages`) when Analytics succeeded, or
`search_conversations` (`inbound_conversations`) when the search
fallback ran. The two are **not directly comparable**; see
[`FRONT_ANALYTICS_COVERAGE.md § Search Fallback Semantics`](../FRONT_ANALYTICS_COVERAGE.md#front-search-fallback-semantics-task-1767).

| Month | Front Total | Fetched (`front_sync_emails`) | Applied (`raw_communication_records`) | Ingest gap | Apply gap | Denom source | Verdict |
|---|---:|---:|---:|---:|---:|---|---|
| 2024-01 |    855 |     0 |     0 |    855 |   0 | search | **ingest-gap** |
| 2024-02 |    838 |     0 |     0 |    838 |   0 | search | **ingest-gap** |
| 2024-03 |    825 |     0 |     0 |    825 |   0 | search | **ingest-gap** |
| 2024-04 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2024-05 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2024-06 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2024-07 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2024-08 |  2,657 |     0 |     0 |  2,657 |   0 | search | **ingest-gap** |
| 2024-09 |  2,479 |     0 |     0 |  2,479 |   0 | search | **ingest-gap** |
| 2024-10 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2024-11 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2024-12 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2025-01 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2025-02 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2025-03 |      — |     0 |     0 |      — |   0 | (auth-failed) | **unknown — re-probe** |
| 2025-04 |      — |     0 |     0 |      — |   0 | (no row) | **unknown — measurement gap** |
| 2025-05 |      — |     0 |     0 |      — |   0 | (no row) | **unknown — measurement gap** |
| 2025-06 |      — |     0 |     0 |      — |   0 | (no row) | **unknown — measurement gap** |
| 2025-07 |  3,449 | 21,416 | 21,408 | (denom undercount) | 8 | search | **truly-covered** |
| 2025-08 |  3,222 |  3,584 |  3,582 | (denom undercount) | 2 | search | **truly-covered** |
| 2025-09 |  3,801 |      1 |      0 |  3,800 |   1 | search | **ingest-gap** |
| 2025-10 |  4,630 |      1 |      1 |  4,629 |   0 | search | **ingest-gap** |
| 2025-11 | 12,943 |      0 |      0 | 12,943 |   0 | analytics | **ingest-gap** |
| 2025-12 | 13,561 |      3 |      3 | 13,558 |   0 | analytics | **ingest-gap** |
| 2026-01 | 14,102 |     13 |     10 | 14,089 |   3 | analytics | **ingest-gap (+ tiny apply tail)** |
| 2026-02 | 16,551 |    862 |    134 | 15,689 | 728 | analytics | **ingest-gap (+ apply tail)** |
| 2026-03 | 20,825 |  4,183 |  1,275 | 16,642 | 2,908 | analytics | **ingest-gap + apply-gap** |
| 2026-04 | 21,130 |  1,897 |    562 | 19,233 | 1,335 | analytics | **ingest-gap + apply-gap** |
| 2026-05 | 16,819 |  5,330 |  5,336 | 11,489 | -6 | analytics (in flight) | **in progress** |

Notes:

* For 2025-07 / 2025-08 we have **more** fetched rows than the search
  denominator. That is expected — search counts inbound conversations
  while `front_sync_emails` is one row per conv but `last_message_at`
  can land *any* conv whose most-recent message fell in that month,
  including outbound-only threads. The 8 / 2 apply-tail is the only
  real gap for those months.
* The negative apply-gap for 2026-05 is the same denominator-unit
  artifact and reflects the active recovery + live webhook stream
  catching up faster than the analytics row is being re-pulled.

### Recovery checkpoints (`system_settings.front_recovery_checkpoint_*`)

Only the per-window picture relevant to the "25k/0 ingested" symptom:

```
window                             scanned ingested skipped status     statusReason
2024-01..2025-06 (mega-window)       8,801   3,701   5,092  partial    db_pool_saturated
2025-08..2026-01 (mega-window)      20,601  15,102   5,485  partial    db_pool_saturated
2026-05                              2,719     650   2,068  partial    db_pool_saturated
auto_closure 2024-01                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2024-02                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2024-03                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2024-09                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2025-08                24,963       0  24,961  partial    safety_max_pages_reached_resume_available
auto_closure 2025-09                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2025-10                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2025-11                25,000       0  25,000  partial    safety_max_pages_reached_resume_available
auto_closure 2026-02                 8,350       0   8,350  blocked    front_auth_unauthorized_after_refresh
auto_closure 2026-03                 1,250       0   1,250  partial    auto_unblocked_after_probe_ok_was:front_auth...
auto_closure 2026-04                 1,200       0   1,200  partial    auto_unblocked_after_probe_ok_was:front_auth...
auto_closure 2026-05                25,000   4,734  20,266  partial    safety_max_pages_reached_resume_available
auto_closure 2024-{07,08},2024-12..2026-01  0       0       0   partial  (auth/not-connected probe deferrals)
manual_2025-01-01..2026-04-28            0       0       0   failed     Expected sort_by to be one of: date
manual_2025-01-01..2026-05-07            0       0       0   failed     Expected sort_by to be one of: date
```

Critical pattern: the months that the in-app coverage report has
been flagging (`ingest-gap` table above) are the **same** months whose
auto-closure recovery window is reporting `25k/0`. Recovery is
behaving exactly as built, but it cannot make forward progress on
those windows because every page comes back already-deduplicated by
`source_event_log.dedupe_key`.

## Why `ingested=0 skipped=25000`

`runHistoricalRecovery` walks Front's
`/conversations?sort_by=date&sort_order=asc&q[after]=…&q[before]=…`
in pages of 50. Each conv is ingested via
`ingestEvent({ sourceSystem: 'front', sourceEventType: 'historical_recovery',
dedupeKey, … })`. `ingestEvent` does an
`INSERT … ON CONFLICT (dedupe_key) DO NOTHING` against
`source_event_log` and returns `{ deduplicated: true }` on hit. The
recovery loop counts that as `skipped++` (not `ingested++`).

Why nearly 100% of pages on these months are dupes:

1. **The mega-window did the unique work.** The
   `2024_01_2025_06` mega-window scanned 8,801 / ingested 3,701; the
   `2025_08_2026_01` mega-window scanned 20,601 / ingested 15,102.
   Those 3,701 + 15,102 + already-applied stragglers are the entire
   recoverable corpus for those date ranges as far as Front's
   `q[after]/q[before]+sort_by=date` enumeration can find it.
2. **`sort_by=date` is "most-recent-activity" ordering, not
   created-at.** Front's `date` field is "most recent message or
   comment in the conversation." A conv created in 2020 that had a
   new message in 2024-01 appears in the 2024-01 window's first page.
   The same conv will appear in every later month's window too,
   whenever it gets bumped. That is the reason narrow per-month
   windows keep seeing the same 25k convs first.
3. **The 500-page cap kicks in before pagination reaches the genuinely
   missing tail.** With 25,000 already-seen convs at the head of the
   asc-by-date enumeration, the cap fires before Front's cursor reaches
   any conv that *isn't* already in `source_event_log`. So the 855 or
   2,657 or 12,943 missing conversations for those months are real,
   but they sit behind the page cap and the recovery never sees them.

There is one exception worth noting: the prior 2024-05 auto_closure
run reported `ingested=6075 skipped=18925` (cited in the task brief).
That confirms recovery *can* make forward progress on a window when
the pagination order genuinely surfaces new convs — the issue is
specific to the windows where the head of the sort-by-date enumeration
is saturated with already-seen convs.

## The `front:recovery:cnv_<id>:` empty-suffix finding

```
empty_suffix  has_msg_suffix  no_colon_suffix  total
      25,000               0                0  25,000
```

```
SELECT … FROM source_event_log
WHERE source_system='front' AND source_event_type='historical_recovery'
```

Counts of the populated keys inside the most-recent 25k recovery rows:

| `payload_json ? 'last_message'` | `payload_json->'last_message' IS NOT NULL` | `payload_json->'last_message'->>'id' IS NOT NULL AND <>''` |
|---:|---:|---:|
| 0 | 0 | 0 |

Sample (5 rows):

```
dedupe_key                       payload.last_message  payload.id
front:recovery:cnv_1hs5qplq:     (null)                cnv_1hs5qplq
front:recovery:cnv_1hs548f2:     (null)                cnv_1hs548f2
front:recovery:cnv_1hs5qnoe:     (null)                cnv_1hs5qnoe
front:recovery:cnv_1ie06nha:     (null)                cnv_1ie06nha
front:recovery:cnv_1hs54uu6:     (null)                cnv_1hs54uu6
```

So:

* The **trailing empty colon is not a display artifact** of the
  pipeline log line — it is the literal `source_event_log.dedupe_key`
  value, written by
  `frontHistoricalRecovery.ts:2662-2665`:

  ```ts
  const lastMsgId = conv.last_message?.id || "";
  const dedupeKey = PERF.FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED
    ? `front:recovery:${convId}:${lastMsgId}`
    : `front:recovery:${convId}`;
  ```

  `FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED` defaults to `true`
  (`server/perfConfig.ts:158`), so the versioned branch executes —
  but `conv.last_message` is literally absent from the payload Front
  returned for every one of these 25,000 rows, so `lastMsgId = ""`
  and the version slot is empty.
* **Today's blast radius:** all current dedupe keys are unique by
  `conv_id` alone (each `dedupe_key` appears `n=1` in the 25k sample),
  so this empty suffix has not yet caused a *false-positive* dupe drop
  for the population we have on hand. The drops we observe are
  legitimate same-conv re-traversals from the page-ordering issue
  above.
* **Tomorrow's blast radius:** as soon as Front's listing returns a
  conv with `last_message.id` populated AND that conv is already in
  `source_event_log` with the empty-suffix key, the populated-suffix
  variant is a *different* key and will not dedupe — so the same
  conv will get re-ingested every recovery pass. Conversely, if both
  variants stay empty-suffix, any new message on a thread we have
  already seen will be silently dropped because the conv-level key
  collides. Either way the dedupe key is not doing the job versioned
  discovery was designed to do, and the in-app same-response
  suppression (Task #1789, Stage 5) is doing the de-bouncing work in
  its place.

The empty suffix is therefore **a real bug that needs a code-side
follow-up**, not just a logging cosmetic. It is *not* the cause of
the present "ingested=0 skipped=25000" symptom — that is the
page-ordering / page-cap issue above.

**Fix shipped (Task #1887).** `extractFrontConvMessageVersion(conv)` in
`server/services/frontHistoricalRecovery.ts` now resolves the version
slot in order: (1) embedded `last_message.id`, (2) `msg_xxx` parsed
from `_links.related.last_message`, (3) a timestamp that advances on
new activity (`last_message.created_at` → `waiting_since` →
`updated_at`, never `created_at`), (4) the literal `"noversion"`
sentinel. The helper is used by all three discovery sites
(`front:recovery:*`, `front:reconcile:*`, `front:backfill:*`), so the
trailing-empty-colon shape can never be produced again — even when
Front omits `last_message` from a list response. A diagnostic
re-run after the fix should show zero keys matching
`front:%recovery:%:` (or equivalents) with an empty suffix.

**Production backfill of legacy rows (Task #1911).** The Task #1887
helper fix only protects newly-written rows. The ~25,000+ pre-fix
rows in production still carry the trailing-empty-colon key, and
every new inbound message that lands on one of those already-seen
threads collides on the conv-level key and is silently dropped. To
remediate, the CEO prod-action
`backfill_front_recovery_dedupe_keys` (see
`server/services/prodActionsRegistry.ts`) owns this rewrite as a
single-press background drain on the worker pool. (The earlier
per-press CLI `scripts/backfill-front-recovery-dedupe-keys.ts` was
retired once the prod-action took over so there is one code path.)
The action:

* Reads each legacy row's stored `payload_json` and rewrites
  `dedupe_key` to the post-fix versioned shape via
  `extractFrontConvMessageVersion`.
* On unique-violation collision (recovery already re-traversed the
  same conv post-fix), DELETEs the legacy row instead so the UNIQUE
  index is freed for future version-bumped re-ingest.
* Caps at 2,000 rows per press to stay safely under the 10 s DB-hold
  cap; the operator re-presses until the status flips to
  `not-needed`. Idempotent.

Re-traversal of the affected windows is handled by the existing
auto-closure scheduler (which already re-runs every ~60 s and
re-traverses each `partial` window every cycle, per the
`auto_closure 2024-…` / `2025-…` rows in the recovery-checkpoints
table above). Once the legacy keys are rewritten, new inbound
messages on the affected threads land via the live webhook + apply
path; the historical `25k/0 ingested` symptom remains driven by the
page-cap / sort-by-date issue documented in
"Why `ingested=0 skipped=25000`" above and is independent of this
fix. An operator can press
`trigger_front_auto_closure_tick` immediately after the dedupe
backfill completes to force an out-of-cycle re-traversal pass
without waiting for the next scheduler tick.

### Production run record

Fill in once the CEO presses the action in production:

| Run | Date (UTC) | Pre-run legacy rows | Post-run legacy rows | Notes |
|---|---|---|---|---|
| _pending_ | _yyyy-mm-dd hh:mm_ | _e.g. 25,000_ | _e.g. 0_ | _e.g. N presses; rewritten=X, deletedConflict=Y_ |

Post-run diagnostic to confirm zero legacy rows (read-only):

```sql
SELECT COUNT(*)::int AS legacy_rows
FROM source_event_log
WHERE source_system = 'front'
  AND dedupe_key LIKE '%:'
  AND (
    dedupe_key LIKE 'front:recovery:%'
    OR dedupe_key LIKE 'front:reconcile:%'
    OR dedupe_key LIKE 'front:backfill:%'
  );
```

## Verdict per month

**Update 2026-05-26 (Task #1886):** Recovery now switches single-month
windows (≤ 32-day span) from `/conversations?sort_by=date` to
`/conversations/search/<after:UNIX before:UNIX>` when the
`front_recovery_sparse_month_search_strategy_enabled` kill switch is ON
(default). The search endpoint does not resurface bumped-from-outside
convs at the head of the page list, so the 500-page cap is no longer
exhausted on already-seen rows and the missing tail becomes reachable.
The verdicts below remain the *measurement-time* snapshot; the action
column documents the resolution path. **For windows that are currently
`partial` with a saved `lastPageUrl` cursor, the saved cursor still
points at the legacy `/conversations` endpoint — an operator must
clear the per-window checkpoint (`front_recovery_checkpoint_*`) to
force the strategy switch on the next run.**

| Month | Verdict | Action |
|---|---|---|
| 2024-01..03 | **ingest-gap** | Clear checkpoint and re-run; new search-strategy path (Task #1886) reaches the missing tail. |
| 2024-04..07, 2024-10..2025-03 | **unknown — measurement gap** | Front Analytics row stuck at `front_analytics_auth_failed (401)`. Re-probe needed before any verdict can be assigned. |
| 2024-08..09 | **ingest-gap** | Same as 2024-01..03. |
| 2025-04..06 | **unknown — measurement gap** | No `front_analytics_monthly_coverage` row at all. Force a refresh first. |
| 2025-07..08 | **truly-covered** | Recovery is done with these. Auto-closure should stop re-launching them. |
| 2025-09..2025-12 | **ingest-gap** | Pure ingest-side; apply tail is 0–1. |
| 2026-01..02 | **ingest-gap (+ tiny apply tail)** | Ingest dominates. |
| 2026-03..04 | **ingest-gap + apply-gap** | Both sides material. |
| 2026-05 | **in progress** | Live webhook + recovery still catching up. |

## `duplicate_ignored` flood — benign or bug?

**Benign for the populations we have on hand**: every one of the
25,000 dedupe entries we sampled corresponds to a real conv that is
already in `source_event_log` (and 24,400 of them are already
`applied`). The flood is the cost of the page-cap + sort-by-date
combination, not a key-collision drop of legitimate rows.

**Not benign as a design**: the empty `lastMsgId` suffix breaks the
contract that `FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED` is meant to
provide — namely, that "new message on already-seen thread" gets a
distinct dedupe key and re-enters the pipeline. With every key
collapsed to conv-level, the message-versioning protection only works
if and when Front starts returning `last_message` on its list response
*and* the prior row also had it populated. Today neither is true.

## Recommended follow-up tasks (no code change in this task)

A. **Stop auto-relaunching the "25k/0 ingested" windows.** The
   auto-closure loop (`frontAutoClosure.ts`) keeps re-enqueueing
   2024-01, 2024-02, 2024-03, 2024-09, 2025-08..11 every cycle even
   though every one of them has hit the page cap with zero forward
   progress for multiple consecutive runs. Add a "if last N runs of
   this window ingested 0 and hit the page cap, back off" guard.
   Today every cycle burns ~25k Front API requests against rate-limit
   budget for zero data.

B. **Either raise the per-run page cap OR change auto_closure window
   strategy for genuinely sparse months.** For months with only
   ~hundreds of expected convs (denominator < 5k), the missing tail
   sits behind the 500-page cap because the head is saturated with
   already-seen convs. Two viable options: (1) raise
   `FRONT_RECOVERY_SAFETY_MAX_PAGES` (currently 500) for sparse
   months, OR (2) switch sparse months to use the Search fallback
   API for ingest discovery (already wired for measurement), which
   does not have the "every bumped old conv comes back first" problem.

C. **Fix the dedupe-key composition.** Either:
   * Make the recovery payload always include `last_message` (likely
     a missed `?include=last_message` or `?expand=last_message` flag
     in the list call, or a switch from `/conversations` →
     `/conversations/:id` for the discovery row), OR
   * If Front genuinely cannot return `last_message` on the list
     endpoint, drop the version slot and stop pretending — set
     `FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED = false` and rely
     on the Stage 5 same-response suppression to handle versioning,
     OR
   * Composer the version slot from a stable conv field that Front
     *does* return on the list (e.g. `date` / `updated_at`).

D. **Re-establish Front Analytics measurement for 2024-04..2025-06.**
   Eleven months are stuck at `front_analytics_auth_failed (401)`
   for the Analytics submit, and three more (2025-04..06) have no
   cache row at all. Without a denominator we cannot classify those
   months as ingest-gap vs truly-covered. The 401 may be
   plan-history (try the Search fallback re-probe) or a token-scope
   issue (`analytics:read`). **Resolution path (Task #1892):** run
   `scripts/backfill_front_search_fallback_2024_2025.ts` — an
   idempotent one-shot that calls `refreshMonth` with
   `forceSearchFallback: true` for all 14 months, populating each
   row with a `denominator_source = search_conversations` value
   and clearing the `unrecoverable=true` flag on the auth-failed
   rows. See [FRONT_ANALYTICS_COVERAGE.md § One-shot backfill
   scripts](../FRONT_ANALYTICS_COVERAGE.md#search-api-fallback-for-plan-limited-months-task-1681).

E. **Address the 6,914 stuck `discovered` rows from
   2026-03-31..2026-04-14.** Out of scope for this finding (see
   [`front-recovery-gap-finding.md`](./front-recovery-gap-finding.md)
   Remediation E for the prior, larger-scale variant — most of it
   has already drained, this 6.9k tail is what's left).

   **Resolution path (Task #2089, absorbs #1921):** these rows are the
   *inert* tail — the live apply pipeline, the dead-letter replay
   (`replay_front_webhook_apply_dead_letter`), and the recovery
   auto-closure ticks only re-touch rows that still have a pending /
   dead-letter apply job or a fresh normalize event; these rows have
   neither, so nothing advances them. The
   `drain_stuck_front_discovered_apply_tail` CEO prod-action resolves
   them deterministically in 500-row worker-pool chunks: for each row
   stuck >24h it checks `raw_communication_records` by Front
   conversation id — if a record already exists the conversation WAS
   applied so the mirror is reconciled forward to `applied`
   (`ingested_record_id` backfilled); otherwise the row is terminally
   closed to `failed` with a documented `[task-2089]` reason. It writes
   only the `front_sync_emails` mirror, never an authoritative entity,
   and is idempotent (the 24h-stale filter excludes any row it already
   resolved). Size and verify with **Q11** in
   [`scripts/diagnostic_front_sync_emails_stall.sql`](../scripts/diagnostic_front_sync_emails_stall.sql)
   (re-run after the drain: `stuck_discovered` should be 0). The
   reconcile-applied branch does NOT change the coverage `fetched`
   count and was never inflating the apply gap; the orphan branch
   converts inert `discovered` backlog into a recognised terminal
   `failed`, so the coverage apply gap for the affected months then
   reflects only genuine failures.

## Out of scope

* Any code change. No tuning of recovery cadence, page caps,
  dedupe-key composition, or apply-side logic.
* Re-running CEO actions or kicking off recovery jobs beyond what is
  already running.
* Changes to the diagnostic SQL script.
