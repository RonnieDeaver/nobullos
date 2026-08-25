# Front Analytics All-Time Coverage

Operator runbook for the Front Analytics coverage dashboard (Task #1643).

## Coverage grain: message-grain only

NoBull measures Front coverage in **individual messages, never
conversations**. Every coverage denominator, numerator, headline tile,
and per-month grain label that operators see is expressed in messages
(`messages_all`, inbound + outbound). Front's API is thread-based, so the
*fetch* still walks conversations under the hood, but that is an internal
implementation detail — conversations are not a NoBull metric or grain on
any user-facing surface (Task #2602 backend, Task #2603 console, Task
#2604 docs/verification).

One piece of conversation-grain logic remains **transitionally**: a
defensive guard in the all-time accumulator that prevents a historical
>100% overflow while any production month may still be stored at
conversation grain (see
[All-time totals: grain + floor scope](#all-time-totals-grain--floor-scope-task-2436)).
Retiring that guard needs production verification the read-only dev
workspace cannot do, so it is tracked separately by Task #2606. Until
then it is internal safety logic, not a conversation metric.

## Operational console grain (Task #2633)

The Front **operational console** (the admin Front tab — KPI strip,
Pipeline Health, Messages, Jobs & Bulk Actions) is a different surface
from the coverage dashboard above, and it had the same conversation-grain
problem the #2602 / #2603 / #2604 epic fixed for coverage: the tiles were
relabeled to "emails/messages" but still **counted conversations** from
`front_sync_emails`. That is why the KPI "Match rate" (matched
conversations ÷ matchable conversations ≈ 11%) contradicted the Messages
tab "Match rate" (matched messages ÷ all messages ≈ 1–2%).

Task #2633 makes every NoBull-facing console figure count individual
**messages** from `raw_communication_records` (`source_type='front_email'`,
excluding `orphaned`). One shared helper —
`server/services/frontMessageGrainStats.ts` (with the derivation in
`shared/frontConsoleMetrics.ts`) — performs the single
`raw_communication_records` → `front_sync_emails` join (a message inherits
its conversation's `match_status` / `pipeline_state`) so the KPI strip,
Pipeline Health (by-state, match-stats, diagnosis), the Messages tab, and
Jobs & Bulk Actions all read **one** canonical message-grain matched /
matchable / unmatched definition and can never drift. `front_sync_emails`
stays the internal matching/pipeline plumbing — it is just never the number
shown to operators.

**Conversation-grain telemetry that intentionally remains:** Filter-Rule
"Hits" and Historical Recovery fetch progress (`scanned` / `ingested` /
`skipped`) are accumulated pipeline-instrumentation counters recorded inline
where the unit of work is the conversation — filter-rule hits are tallied in
`frontSyncEmailTriage.ts` per `front_sync_emails` row, and recovery counts
the conversation pages it fetches. There is no stored rule→message or
per-fetch→message mapping to re-derive those historical totals from, and
re-instrumenting those hot paths to emit per-message counts would change how
Front email is ingested/triaged — explicitly out of scope for #2633. They
already carry email/message labels (no "conversation" vocabulary) from
#2603, and they describe Front's background fetch/triage unit, not a NoBull
headline metric.

## Legacy `inbound_conversations` rows (Task #1963)

Rows pulled before Task #1837 carry `denominator_unit='inbound_conversations'`. As the constants block in `server/services/frontAnalyticsCoverage.ts` documents, Task #1709 already proved that historical search query was counting *all* directions (Front search ignored the unsupported `is:inbound` modifier), so the stored values are equivalent to `conversations_all` — relabeling is free (no Front API call).

The prod-action **Relabel Front coverage units → conversations_all (Task #1963)** UPDATEs `denominator_unit` and (where it matches) `numerator_unit` from `inbound_conversations` to `conversations_all`. After running it, callers that require strict equality on `unitsMatch()` see consistent rows; the `isComparableUnit()` back-compat path remains a safety net for any rows missed by the relabel. Idempotent: a second press matches zero rows.

## What it measures

This subsystem answers a single question that the existing Front
Historical Recovery gap report cannot answer:

> *How many emails does Front say existed during a month, and how many
> of those made it all the way into NoBull OS?*

It pulls Front's Analytics Reports API as the **authoritative monthly
denominator** and compares it against two NoBull-local counts:

| Term | Source | Meaning |
| --- | --- | --- |
| **Front Total** | Front Analytics (`/analytics/reports`) | Authoritative count of messages Front recorded during the month. |
| **Fetched Into NoBull** | `front_sync_emails` rows whose `last_message_at` is in the month | Emails NoBull pulled from Front at least once. |
| **Applied Into NoBull** | `raw_communication_records` rows where `source_type='front_email'` and `timestamp` is in the month | Emails NoBull stored as canonical communication evidence. |

Derived numbers:

* **Ingest gap** = `front_total_messages − fetched_into_nobull`
  → Front has them, NoBull never fetched.
* **Apply gap** = `fetched_into_nobull − applied_into_nobull`
  → NoBull fetched them, never applied (the existing 17,805-row pain
  point, Task #1641).
* **Month coverage** = `applied_into_nobull / front_total_messages`
* **All-time coverage** = `Σ applied_into_nobull / Σ front_total_messages`
  (also exposed in the fetched form for the headline.)

The dashboard lives on the Front Historical Recovery admin page. The
SQL `Q6` in `scripts/diagnostic_front_recovery_gap.sql` joins
`front_analytics_monthly_coverage` so the SQL view and the dashboard
always agree on the same denominator.

### Reading the headline % (Task #2502)

The headline coverage percentages (e.g. an all-time figure near ~6.5%)
are measured against Front's **message-grain** total — every individual
message across all shared inboxes, including internal and automated
traffic — not against client-relevant conversations only. A low
percentage therefore reflects that broad denominator and the
measurement grain, **not lost client data**: most operational client
comms are captured, but the denominator is the full message firehose.
The admin coverage card carries a "How to read this" caption
(`data-testid="text-fa-coverage-caveat"`) stating exactly this. This is
**presentation only** — Task #2502 added no Front API calls and did not
change any coverage math; the percentages and underlying counts are
unchanged.

### One message-grain story (Task #2510 → Task #2603)

The Front console now tells a **single message-grain story** on every
screen. Both **Pipeline Health** and **Analytics Coverage** count and
label in individual emails/messages; there is no conversation count and
no conversation "match rate" shown to operators anymore.

- **Pipeline Health** speaks in **tracked emails** — its tiles and its
  "Match rate" caption read "of N matchable emails", not conversations.
- **Analytics Coverage** (this screen) counts individual **messages
  (inbound + outbound)**. The all-time applied/fetched headline tiles
  carry an explicit `messages (inbound + outbound)` grain label, and each
  monthly row shows a plain-English grain status — `message-grain` once a
  month is measured at `messages_all`, or `pending message-grain` while it
  is still being driven up to message grain.

History: Task #2510 originally added a shared "conversations-vs-messages"
caption to explain why the two screens disagreed (one counted
conversations, the other messages). Task #2603 removed that caption
entirely once both screens became message-grain only — there is no longer
a second grain to reconcile, so the caption and the per-month
`conversation-grain` label are gone from the UI. Front's API is
thread-based, so the underlying *fetch* still walks conversations under
the hood, but that is an internal implementation detail; nothing operators
see is expressed in conversations.

## Why Analytics is the denominator

Before this task every gap report compared NoBull-local tables against
other NoBull-local tables. There was no anchor against Front. With
the Analytics denominator the team has a single number — *all-time
applied coverage* — that they can always push toward 100%, and a
deterministic way to know whether the gap is in *fetch* or in *apply*.

## Adoption date (hard-coded constant — Task #2481)

The denominator floor is a **hard-coded constant**:
`FRONT_ADOPTION_DATE = "2025-07-01"` in
`server/services/frontAnalyticsCoverage.ts`. `ensureFrontAdoptionDate()`
and `getAdoptionFloorMonth()` simply return it (and its `YYYY-MM` slice,
`2025-07`). There is **no** API, UI, or worker path that can change it.

**Why it is a constant now (the regression it closes).** The floor used
to live in the mutable `system_settings.front_adoption_date` row, which
the refresh worker would *auto-derive* from the earliest
`source_event_log.received_at` where `source_system='front'` whenever the
row was missing. But Front events only began on **2026-04-16**, so a
missing row let the worker regress the floor from July 2025 down to April
2026 — silently dropping ~9 months (2025-07 → 2026-03) of Front history
from the all-time totals. Hard-coding the floor removes every mutable /
auto-derive path, so the floor can never regress.

**The `system_settings.front_adoption_date` row is dead.** A lingering
row may still exist in some environments; it is **ignored** — the readers
never consult it. The former operator override route
(`POST /api/admin/front/analytics-coverage/adoption-date`) and its admin
UI override row were **removed**; the route now 404s. The admin panel
surfaces the floor read-only as the "Adoption date (fixed)" headline card.

**Task #2483 — remove the dead plumbing.** With the floor a constant, the
`if (!adoption)` / `if (!floorMonth)` null-floor guards in
`runCoverageRefreshTick`, `getAdoptionFloorMonth`,
`countPreFloorCoverageRows`, `deletePreFloorCoverageRows`, and the
`purge_pre_floor_front_coverage_rows` prod-action are unreachable and were
deleted (`getAdoptionFloorMonth` now returns a plain `string`). The
`SETTING_ADOPTION_DATE` export is retained only to name the dead row in the
purge action + tests. The one-off `purge_dead_front_adoption_date_setting`
prod-action (idempotent, self-healing, ZERO external calls) deletes the
stale `system_settings.front_adoption_date` row from prod so the dead key
stops surfacing in settings dumps.

Months *before* the floor are excluded from the all-time totals at read
time, and the optional `purge_pre_floor_front_coverage_rows` prod-action
(Task #2436, below) can also physically delete them.

**Task #2369 — converge collection to 100% from July 2025.** The floor
of `2025-07-01` brings months 2025-07 → 2026-03 into scope while keeping
the legitimately-empty pre-July-2025 months excluded. Run the
`reach_front_coverage_full_message_grain` sweep (operator press or
self-heal) — its candidate set respects this floor and re-measures every
in-scope month to message grain. See
[Step 5 / candidate set](#step-5--reach-100-of-messages-prod-action).

## All-time totals: grain + floor scope (Task #2436)

The "All-time coverage" card could show a numerator larger than its
denominator (>100%) for two reasons, both fixed here:

1. **Grain mismatch.** A historical `front_analytics_monthly_coverage`
   row can be labeled `conversations_all` (the Task #1837 default for the
   search/enumeration fallback) while storing a *message-count* numerator.
   Summed against a *conversation-count* denominator the numerator can
   exceed it. `getFrontAnalyticsCoverageSummary` only adds a month to the
   all-time totals (`totalFront` / `totalFetched` / `totalApplied`) when its
   `denominator_unit` is genuinely message-grain (`isMessageGrainDenominator`
   → `messages_all`), so numerator and denominator always share a grain and
   the headline can never overflow.
2. **No floor scope.** Pre-`front_adoption_date` months (legacy recovery
   noise) used to pollute the totals. The accumulator now only counts months
   at or after the adoption floor.

> **Transitional note (message-grain epic — Task #2602 / #2603 / #2604).**
> Coverage is now a message-grain-only model: everything operators see and
> everything the headline sums is individual messages. The conversation-grain
> comparator/exclusion described in item 1 (`isComparableUnit` /
> `unitsMatch` / `isMessageGrainDenominator`) is kept **only** as a defensive
> guard against the historical >100% overflow while any production month may
> still be stored at conversation grain. Removing that guard requires
> confirming — against the production database, which the dev workspace
> cannot read — that every in-scope month has finished converting to
> `messages_all`; that cleanup is tracked separately by Task #2606. Until
> then the guard stays, but it is internal safety logic, not a conversation
> metric.

`byMonth` (a.k.a. `months`) still returns **every** cached row regardless of
grain or floor — the floor is a consumer-side concept, not a row filter, so
per-month inspection and re-measurement (e.g. the Task #2369 sweep) keep
seeing the out-of-scope months.

## Denominator floor invariant (Task #2795) + console surfacing (Task #2802)

For a message-grain month the stored denominator (`front_total_messages`)
is floored at the local message count: if NoBull's own tables hold more
in-window messages than Front's Analytics/search-sourced total reported,
the denominator is raised to the local count so the headline can never
exceed 100%. The raise is never silent:

* `denominatorFloorExcess` — how many messages the denominator was raised
  by (`local count − Front-reported total`); `0`/`null` when no raise.
* `denominatorFloorReconciliationNote` — an operator-facing sentence
  (built by `buildFloorReconciliationNote` in
  `server/services/frontAnalyticsCoverage.ts`) explaining which source
  reported the lower total and that the local count won.

Both fields ride on every `CoverageSummaryMonth`, are preserved across
recompute/failure branches, and apply to both the Analytics pull and the
search fallback write paths.

A raise also notifies operators: see [§ Denominator floor-raise alert
(Task #2819)](#denominator-floor-raise-alert-task-2819) — once per month
per raise (new excess or material regrowth), on
`integration.front.coverage_denominator_floor_raise`.

**Console surfacing (Task #2802).** The message-grain operational console
(`FrontHistoricalRecoveryPanel`) shows a disclosure banner
(`details-fa-floor-summary`) whenever at least one in-scope month has
`denominatorFloorExcess > 0`: the summary line counts the affected months
and sums the excess ("the local message count exceeded Front's reported
total, so the denominator was raised to keep the headline honest");
expanding it (a tap/click — works on touch devices, Task #2818) lists
each month with its excess and the full server reconciliation note as
visible text under the row (`text-fa-floor-month-note-<month>`). The
per-month Applied % cell keeps its inline `text-fa-floor-note-<month>`
marker; since Task #2826 that marker is the `<summary>` of a
tap-expandable `<details>` disclosure (`details-fa-floor-note-<month>`)
whose body shows the full reconciliation note as visible text
(`text-fa-floor-note-full-<month>`), so phone/tablet operators can read
the explanation in the table row without the hover tooltip or scrolling
up to the banner. Task #2818 reworded `buildFloorReconciliationNote`'s search
variant to say "threads" instead of "conversations", so the note is safe
to render as visible text under the Task #2603 no-conversation-vocabulary
render guard (`tests/client/front-coverage-floor-summary.test.tsx`,
smoke-gated).

## Denominator-floor DB repair (Task #2801)

The Task #2795 denominator floor (`front_total_messages` ≥ the local
unique-message count for every message-grain month, so the headline can never
exceed 100%) is enforced in two layers: every write path routes through
`applyMessageGrainDenominatorFloor`, and `getFrontAnalyticsCoverageSummary`
applies the same floor **in memory at read time** as a last-resort safety
net. But a row written *before* the floor shipped (or restored from a backup)
can still sit in the DB with `front_total_messages < applied_into_nobull`
until its next write — a latent violation that only the read-time net hides.

The prod-action **Repair stale Front coverage denominator-floor rows**
(`repair_front_coverage_denominator_floor`) permanently fixes those rows in
place. `repairMessageGrainFloorViolations()` selects every message-grain row
where `front_total_messages < applied_into_nobull`, floors the stored
denominator through `applyMessageGrainDenominatorFloor` (for message-grain
rows `applied_into_nobull` **is** the local unique-message total — fetched ==
applied == local, see `buildMessageGrainHeadline` — so no recount is needed),
recomputes the derived gap/% fields, and re-upserts via `upsertMonthRow`. All
other columns (per-direction Front/local counts, statuses, plan-limit memos)
are preserved, and `denominator_floor_excess` is stamped with
`max(stored, thisRepairDelta)` so a previously recorded reconciliation note
is never shrunk.

Properties: **idempotent and convergent** (repaired rows leave the WHERE
clause, so one apply reaches the zero-violation done-state), **ZERO Front API
calls** (pure cache-table repair), and **self-healing** (6 h cadence) so a
stale row surfacing later is repaired without a manual press. The read-time
in-memory safety net in `getFrontAnalyticsCoverageSummary` stays in place —
the repair removes the latent DB violation; the net remains the last-resort
guard for any window between a bad write and the next repair pass. The
`infra.front_coverage.denominator_floor_violated` drift alert (Task #2795)
keeps watching the table independently.

## Honest conversation-grain fallback for plan-limited months (Task #2669)

Front's analytics plan caps how far back per-message history is available.
For months older than that retention window the only thing Front will return
is conversation-grain data (the search/enumeration fallback stamps
`denominator_unit='conversations_all'` and sets the month's
`analytics_plan_limited_at` memo). Those months **cannot** ever reach a real
message-grain coverage %: the stored "applied %" divides a message count by a
conversation count, which is a meaningless grain mix that reads as a
misleadingly low number. No button or backfill fixes it — only a Front plan
upgrade would expose the per-message history.

So instead of pretending these months have a (bad) message-grain %, the
per-month panel renders an **explicitly-labeled conversation-grain fallback**.
The pure helper `frontPlanLimitedFallback()` in `shared/frontConsoleMetrics.ts`
returns a non-null result **only** when both conditions hold:

1. the month carries a plan-limit memo (`analyticsPlanLimitedAt != null`), and
2. its denominator is genuinely conversation grain
   (`frontCoverageGrain(denominatorUnit) === 'conversations'`).

When set, it builds the label from the **conversation pair only** — fetched
conversations of total conversations, at the conversation-grain
`fetchedCoveragePct` — e.g. *"4,960 of 5,000 conversations — Front plan blocks
per-message history."* `FrontHistoricalRecoveryPanel.tsx` shows that label in
the Applied % cell (testid `text-fa-plan-limited-<month>`) and suppresses the
message-grain floor highlight for that row, so the misleading red "below
floor" styling never fires on a grain it can't honestly measure.

This is a **labeled exception**, not a regression of the message-grain-only
model (Task #2602 / #2603 / #2604): non-plan-limited months stay strict
message-grain and never gain conversation vocabulary, and the grains are never
mixed inside a single numerator/denominator. A conversation-grain month with
**no** plan-limit memo also returns null — only the genuine plan-blocked case
is relabeled.

## Message attribution backfill to 100% (Task #2662)

Coverage (is a message in `messages_all`?) and **attribution** (which client
is a message stamped to, via `raw_communication_records.client_id`?) are two
different things — Task #2602 deliberately materializes per-message rows for
coverage **without** a `client_id`, leaving attribution to a separate opt-in
driver. Over time that left three residual gaps where a message's attribution
*could* be determined deterministically but had not been propagated:

1. **~8,920 unattributed matched messages.** `front_email` rows in
   `raw_communication_records` whose conversation IS matched
   (`front_sync_emails.match_status` ∈ {`auto_matched`,`manually_matched`},
   `matched_client_id` set) but whose own `client_id` is still NULL.
2. **~235 stuck `failed` discovered-apply-tail rows.** The Task #2089
   `drain_stuck_front_discovered_apply_tail` action closed these terminally to
   `failed`; some now have a real `raw_communication_record` (the apply did
   land) and should be reconciled forward.
3. **26 legacy `dismissed`/`blocked` conversations** created 2026-04-01..14,
   before the auto-filters were removed (Task #2637). Many no longer have any
   active manual filter rule and should return to `unmatched`.

The CEO prod-action **`backfill_front_message_attribution`** (worker pool,
breaker-aware, idempotent) closes all three in one press via a background
drain — see [FRONT.md § Message attribution backfill](./FRONT.md#message-attribution-backfill-to-100-task-2662)
for the operator runbook. It is pure DB convergence: no Front API call, no
re-matching, and it never raises the coverage % (that is the materialization
driver's job) — it only stamps attribution that is already determined.

### In-scope confirmation diagnostics (Task #2439)

Because the all-time accumulator silently skips any in-scope month that is
not yet message-grain, operators had no way to tell whether the headline
already counts *every* in-scope month or is quietly excluding some. The
`allTime` summary now carries an explicit split, computed from the same
floor + grain predicate the accumulator uses, so the two can never disagree:

* `inScopeMonths` — months at or after the adoption floor (the set the
  headline is responsible for).
* `inScopeCountedMonths` — of those, the ones actually summed into the
  headline (i.e. already message-grain).
* `inScopeExcludedMonths` — `inScopeMonths − inScopeCountedMonths`, the
  count of in-scope months omitted **purely** because they are not yet
  message-grain. `0` is the done-state: every in-scope month counts.

`listInScopeNonMessageGrainMonths()` (exported from
`server/services/frontAnalyticsCoverage.ts`) names the **convertible** subset of
those excluded months — the targets to drive to message grain. Task #2674 — it
omits terminally plan-limited months (returning them separately in
`terminalPlanLimitedMonths`), so it is a *subset* of `inScopeExcludedMonths`: a
plan-limited month is genuinely excluded from the message-grain headline yet can
never be converted, so it is not a finish-action target (see "One consolidated
control" below). The `FrontHistoricalRecoveryPanel` all-time card surfaces the
split as a green (all counted) / amber (some excluded) banner
(`text-fa-in-scope-confirmation`).

**Backfill execution.** `backfillInScopeMessageGrain()` drives those
in-scope months to a message-grain denominator so they re-enter the
all-time total. It does **not** duplicate any headline math — it reuses the
existing free conversion by calling `recomputeAllMonths({ frontPullsBudget:
0 })`, which performs Task #2290's per-direction → message-grain relabel in
place for every row that already carries both Front-side per-direction
message counts, with **zero** Front API calls. It is therefore idempotent
(a second run upgrades nothing further) and safe from a read-only-prod dev
workspace. Rows that lack per-direction counts cannot be converted for free;
they come back in `stillExcludedMonths` and still need the heavy Front-re-pull
driver (the default-OFF auto-upgrader of Task #2365 or the
`reach_front_coverage_full_message_grain` sweep). Operator entry points:

- **HTTP**: `POST /api/admin/front/analytics-coverage/backfill-message-grain`
  (Team-Lead, gated by the refresh-enabled setting, queue-drain pause, and
  `KILL_SWITCH_NON_CRITICAL_SWEEPS` like `/recompute`).
- **UI**: the **Backfill message grain** button on the amber confirmation
  banner (`button-fa-backfill-message-grain`).

**Optional physical purge.** The idempotent, self-healing CEO prod-action
`purge_pre_floor_front_coverage_rows` deletes rows strictly *before* the
adoption-floor month (the hard-coded `FRONT_ADOPTION_DATE` floor, Task
#2481). Read-time scoping already keeps those rows out of the totals, so this purge
is a tidy-up, not a correctness requirement. Backed by the exported helpers
`getAdoptionFloorMonth()` / `countPreFloorCoverageRows()` /
`deletePreFloorCoverageRows()` in `server/services/frontAnalyticsCoverage.ts`.

### One consolidated control — finish message-grain coverage (Task #2511)

The free relabel above only converts rows that *already* carry per-direction
counts; the rest still need a Front re-pull to re-measure the denominator. Before
#2511 an operator had to press the free **Backfill message grain** button and
then separately reach for a heavy driver, with no single place that says "drive
**every** in-scope month to message grain and tell me when it's done." Task #2511
folds those into **one** control (and supersedes the proposed #2467 — there is one
button, not two).

`finish_front_message_grain_coverage` (defined in
`server/services/prodActionsRegistry.ts`, exported as
`applyFinishFrontMessageGrainCoverage` / `getFinishFrontMessageGrainCoverageStatus`)
is a self-healing, worker-pool prod-action. One press does two things in order:

1. **Free relabel first** — runs `backfillInScopeMessageGrain()` synchronously
   (zero Front calls, idempotent, runs even when Front auth is down).
2. **Grain-only enumeration for the rest** — anything still excluded lacks
   per-direction counts, so a background drain processes the remaining months one
   per chunk, forcing the per-message enumeration walk
   (`refreshMonth({ forceSearchFallback, forceRerun, forcePerMessageEnum })`) to
   **re-measure** the denominator up to message grain and recomputing that
   month's local counts. Each month is processed at most once per run so the drain
   always terminates; the self-heal cadence finishes any month whose walk needs
   more passes.

**Grain-only — NOT numerator recovery.** This action only lifts the *grain* of
the denominator so the month re-enters the all-time total; it does **not** drive
the recovery *numerator* (the coverage value). Improving the value is the job of
`reach_front_coverage_full_message_grain` (Task #1920), which this complements,
and the scheduled, switch-gated message-grain upgrade driver (Task #2365,
`front_message_grain_upgrade_enabled`) does the same grain re-measure on a cadence.
This action is the operator's one-press "make the headline honest now" surface and
needs no global switch flipped (it forces the enumeration past
`front_analytics_per_message_enum_enabled`).

**Done-state.** `listInScopeNonMessageGrainMonths()` returning no *convertible*
months. **Terminally plan-limited months are excluded (Task #2674).** A month
whose `analytics_plan_limited_at` memo is set can never reach message grain —
Front's analytics plan does not expose its per-message history, so neither the
free relabel nor the forced per-message enumeration can ever lift it — so it is
**not** a candidate (`isTerminalPlanLimitedForMessageGrain`). Without this, the
adoption-floor month 2025-07 stayed a candidate every tick and the consolidated
button showed "1 pending" forever. The exclusion is a **terminal exemption with a
revival path**, never a silent drop of convertible work: the plan-limit memo is
cleared automatically by the next successful Analytics pull (re-probed weekly per
`front_analytics_plan_limited_reprobe_interval_days`, e.g. after a Front plan
upgrade), and the moment it clears the month gains per-message data and re-enters
the candidate set. `listInScopeNonMessageGrainMonths()` returns those excluded
months in `terminalPlanLimitedMonths` so the not-needed done-state names them
honestly instead of claiming every in-scope month is message-grain. This mirrors
the plan-limited retirement the sibling `reach_front_coverage_full_message_grain`
sweep applies via `shouldSweepFrontCoverageMonth` (Task #2499) — except this
grain-only action needs no convergence-budget guard, since plan-limited alone is
terminal for *grain* (the convergence budget is a numerator concern this action
never drives). Note these months are still counted in
`allTime.inScopeExcludedMonths` (they genuinely aren't in the message-grain
headline), so that diagnostic count can legitimately stay above zero while the
finish action reports done. **Breaker-aware**: while Front auth is dead the
free relabel still runs, but months still needing a Front re-pull report `blocked`
(reconnect Front) and converge automatically once auth heals — never a drain that
cannot succeed. Operator entry points:

- **HTTP**: `POST /api/admin/front/analytics-coverage/finish-message-grain` (apply,
  Team-Lead, same gating as `/backfill-message-grain`) and
  `GET /api/admin/front/analytics-coverage/finish-message-grain-status` (progress +
  explicit done-state with the exact `excludedMonths` count).
- **UI**: the **Finish message-grain coverage** button on the amber confirmation
  banner (`button-fa-finish-message-grain`), which replaces the earlier free-only
  backfill button and shows live drain progress plus a green done banner.

## Cache rules

Cache rows live in `front_analytics_monthly_coverage`, one row per
calendar month from the hard-coded `FRONT_ADOPTION_DATE` floor (Task
#2481) through the current month.

* Completed months are **immutable** after first successful pull
  (`is_finalized_month=true`, `pulled_at` non-null,
  `front_analytics_error` null). The worker skips them on every
  subsequent tick.
* Months with `front_analytics_error` set are retried on every tick
  until they succeed.
* The current month is **upserted** on every tick.
* Failed pulls persist the error (`front_analytics_status='error'`,
  `front_analytics_error='<typed_code>: <message>'`) so operators see
  *why* a month is stuck.

To force a full re-pull of a specific month, delete its cache row:

```sql
DELETE FROM front_analytics_monthly_coverage WHERE month = '2025-03';
```

The next tick will re-pull it as a missing-completed month.

## Worker / scheduler behavior

* **Queue name:** `front_analytics_coverage_refresh`
* **Workload class:** `maintenance` (Task #1643 spec calls this
  `ingestion_observability`; the runtime workload-class enum is
  `maintenance` and the registered queue runs alongside other
  low-priority observability sweeps).
* **Scheduler interval:** 30 minutes, started after the
  `WORKER_STAGGER_OFFSETS.front_analytics_coverage_refresh = 495_000`
  ms offset so it doesn't wake on the same JS tick as another
  scheduler.
* **Per-tick budget:**
  `frontAnalyticsCoverageMaxMonthsPerTick` (`server/perfConfig.ts`,
  default 3, bounded 1–24) controls how many missing completed months
  are back-filled per tick. The current month is *always* refreshed on
  top of that budget.
* **Gates respected, in order:** `front_analytics_refresh_enabled`
  system setting → queue-drain pause for
  `front_analytics_coverage_refresh` → `KILL_SWITCH_NON_CRITICAL_SWEEPS`
  perfConfig kill switch.

## System settings

| Key | Default | Purpose |
| --- | --- | --- |
| `front_adoption_date` | *(none)* | Fixed anchor month for coverage math. Set once. |
| `front_analytics_refresh_enabled` | `true` | Master kill switch for the refresh worker. |
| `front_analytics_refresh_lookback_current_month_only` | `true` | When `true`, missing-completed backfill still runs but the worker also re-pulls the current month every tick. |
| `front_analytics_measurement_refresh_enabled` | `true` | **Task #1787 — Stage 1.** Master switch for the finalized-aware cadence gating. When `false`, the worker falls back to the legacy 30-minute always-refresh-current-month behavior. Flip OFF to roll back the de-cadence without a redeploy. |
| `front_analytics_current_month_refresh_interval_hours` | `6` | **Task #1787.** Minimum hours between current-month refreshes. The scheduler still wakes every 30 minutes but skips the current-month pull until this interval elapses. |
| `front_analytics_incomplete_month_refresh_interval_hours` | `24` | **Task #1787.** Minimum hours between refreshes of a still-incomplete (non-finalized) past month. |
| `front_analytics_finalized_month_skip_enabled` | `true` | **Task #1787.** When `true`, months whose `is_finalized` flag is set are skipped entirely on subsequent ticks (they're already settled by Front and won't change). |
| `front_analytics_plan_limited_reprobe_interval_days` | `7` | **Task #1787.** How long a month flagged `plan_limited` stays memoized before the worker re-probes Front to see if the plan limit has been lifted. |
| `front_analytics_coverage_alerts_enabled` | `true` | Master kill switch for the coverage-drop / below-floor alerts. |
| `front_analytics_coverage_drop_delta_pct` | `2.0` | All-time applied coverage drop (in percentage points) that fires an alert. |
| `front_analytics_month_floor_pct` | `95.0` | Per-month applied coverage floor that fires a below-floor alert. |
| `front_analytics_coverage_alert_state` | *(internal)* | JSON snapshot of the previous tick's coverage + already-alerted months, used for delta computation and dedupe. |

### Task #1787 cadence gating (Stage 1)

Before Task #1787 the worker re-pulled the current month and every
non-current month on every 30-minute tick, which burned Front Analytics
budget and ran one `front_analytics_coverage_refresh` job even when no
month was actually due. The cadence gating turns the scheduler into a
*due-check* with three layers:

1. **Enqueue-time skip** (`anyMonthDueForRefresh`): the 30-minute
   `enqueueScheduledTick` consults `front_analytics_monthly_coverage`
   and only enqueues a job if at least one month is due under the
   cadence above. Skips also short-circuit when the
   `front_analytics_coverage_refresh` queue is paused (logs
   `front_analytics_refresh_enqueue_skipped_queue_paused`).
2. **Per-month skip inside the tick**: even if the job runs, each
   month's `fetched_at` is compared against the interval for its class
   (current / incomplete / finalized / plan-limited) and skipped if
   not yet stale.
3. **Finalized skip**: when
   `front_analytics_finalized_month_skip_enabled = true`, any month
   with `is_finalized = true` is dropped from the candidate set
   regardless of `fetched_at`.

**Rollback** is one setting flip: set
`front_analytics_measurement_refresh_enabled = false` to restore the
pre-Task-#1787 behavior. No code change or redeploy required.

## Alerts

Two conditions fire to the same notification id
`integration.front.analytics_coverage_drop`:

1. **Drop alert** — all-time applied coverage dropped by more than
   `front_analytics_coverage_drop_delta_pct` since the previous tick.
2. **Below-floor alert** — a finalized or current month is below
   `front_analytics_month_floor_pct`.

Payload includes the before/after percentages, ingest gap, apply gap,
worst month, and a recommended action:

> *If ingest gap dominates → investigate Front Historical Recovery
> (Front has emails we never fetched). If apply gap dominates →
> investigate apply backlog / Task #1641.*

Dedupe: months already alerted on are persisted in
`front_analytics_coverage_alert_state.alertedBelowFloorMonths`. New
below-floor months bypass the cooldown; previously-alerted months are
ignored.

### Denominator floor-raise alert (Task #2819)

A third operator alert fires on its **own** notification id
`integration.front.coverage_denominator_floor_raise` when a coverage
refresh corrects a month's message denominator **upward** (the Task
#2795 floor invariant: local message count exceeded Front's reported
total, surfaced as `denominatorFloorExcess` + a reconciliation note).

* **Trigger** — evaluated on the same
  `runFrontAnalyticsCoverageAlertCheck` tick as the other conditions;
  a month fires when it carries `denominatorFloorExcess > 0` and either
  (a) it has no last-alerted excess recorded (a NEW raise), or (b) its
  excess grew by at least `front_analytics_floor_raise_regrowth_pct`
  (default **25%**) past the last-**alerted** excess (material
  regrowth). A refresh tick that rewrites the same or slightly larger
  excess stays silent — dedupe is once per month per raise, never per
  tick.
* **Content** — names each month, the excess (messages the denominator
  was raised by), the previous alerted excess on regrowth, the row's
  `denominatorFloorReconciliationNote`, and the drift advice (recurring
  or growing excess suggests Front Analytics totals and local tables
  are drifting).
* **Gating** — master switch `front_analytics_coverage_alerts_enabled`
  plus its own sub-switch `front_analytics_floor_raise_alerts_enabled`
  (default **ON**). Both the sub-switch and the regrowth threshold are
  editable from the coverage-alert admin panel via the alerts GET/PUT
  routes (Task #2834) — no raw SQL needed.
* **Dedupe state** — `alertedFloorRaiseMonths` (month → last-alerted
  excess) inside the existing `front_analytics_coverage_alert_state`
  snapshot. Seeded on first run / while disabled (pre-existing raises
  never alert on enable); entries are pruned when a month's excess
  clears so a later fresh raise alerts again as new; sub-threshold
  growth accumulates against the last-alerted value.
* **Test** — `tests/front-analytics-floor-raise-alert.test.ts`.

## API

* `GET /api/admin/front/analytics-coverage` — cached summary. Admin
  (account manager) only. Does **not** call Front Analytics on the
  request path.
* `POST /api/admin/front/analytics-coverage/refresh` — enqueues a
  low-priority refresh job. Team lead only.
* `GET /api/admin/front/analytics-coverage/alerts` — current values,
  defaults, bounds, and last-edited attribution for the alert
  settings (`front_analytics_coverage_alerts_enabled`,
  `front_analytics_coverage_drop_delta_pct`,
  `front_analytics_month_floor_pct`,
  `front_analytics_completeness_alerts_enabled`, and — Task #2834 —
  the floor-raise pair `front_analytics_floor_raise_alerts_enabled` /
  `front_analytics_floor_raise_regrowth_pct`, the latter bounded
  0–1000%). Account manager only.
* `PUT /api/admin/front/analytics-coverage/alerts` — accepts any
  subset of `{ enabled, dropDeltaPct, monthFloorPct,
  completenessAlertsEnabled, floorRaiseAlertsEnabled,
  floorRaiseRegrowthPct }`, validates against the bounds, persists via
  `system_settings`, and writes an `admin_setting_audit` row per
  changed key (Task #1645; floor-raise keys Task #2834). Team lead
  only. Surfaced in the admin UI under the Front Analytics coverage
  section of the Front Historical Recovery panel — operators no
  longer need raw SQL to tune them.

## Counting alignment

| Side | Field used | Notes |
| --- | --- | --- |
| Front Analytics | metric `num_messages_received` (overridable via `FRONT_ANALYTICS_METRIC` env var) | Counts inbound messages Front recorded during the report window. |
| `front_sync_emails` | `last_message_at` within `[monthStart, monthEnd)` UTC | One row per conversation; matches the historical-recovery gap report. |
| `raw_communication_records` | `timestamp` within `[monthStart, monthEnd)` UTC where `source_type='front_email'` | Canonical communication evidence; same source filter used by Q6. |

Month boundaries are computed in UTC on both sides.

If you change the Front Analytics metric, also drop the affected
rows in `front_analytics_monthly_coverage` so the worker re-pulls
them with the new metric.

## Search-API fallback for plan-limited months (Task #1681)

Front's Analytics Reports API returns
`403 {"_error":{"message":"Your plan does not give you access to that time period"}}`
for months older than the workspace plan's analytics retention window
(observed for Jul–Oct 2025 on the current plan). Before Task #1681
these months were stuck at `front_total_messages=0` with a permanent
error, falsely inflating the apparent ingest gap.

The refresh worker now detects this exact 403 (phrase
`plan does not give you access`) and **falls back to the
`/conversations/search/:query` endpoint** with the query
`after:<unix-month-start> before:<unix-month-end>`,
paginating via `_pagination.next` until exhaustion or a 200-page /
20,000-conversation safety cap.

> **Message-grain note (Task #2602 / #2604).** This fallback walks Front's
> thread API only because that is the sole endpoint available for
> plan-limited months. Any `conversations_all` denominator it writes is a
> transitional *internal* measurement, not a metric operators see; the
> message-grain drive (`reach_front_coverage_full_message_grain` #1920,
> `finish_front_message_grain_coverage` #2511) re-measures these months to a
> per-message (`messages_all`) denominator, which is the coverage model of
> record.

> **Task #1709 — verified search-query syntax.** Front's
> `/conversations/search` endpoint does **not** accept `is:inbound`
> (or `is:outbound`); sending either returns
> `400 Unsupported search modifier provided` and the row keeps
> failing every Retry. Front's documented `is:` modifiers are
> status-only (`open`, `closed`, `unassigned`, `assigned`,
> `snoozed`, `unreplied`, `deleted`, `archived`). The fallback
> therefore relies only on the half-open `[after, before)` window in
> unix seconds. The denominator unit stays `inbound_conversations`
> for the dashboard pill, but is now an upper bound: a small number
> of outbound-only conversations may also be counted. The existing
> unit-caveat tooltip already warns operators not to compare
> search-sourced denominators to Analytics-sourced ones directly.

> **Task #1709 — broadened plan-limit detection.** Front sometimes
> returns the 403 body wrapped in an `{"_error":{...,"message":"…
> plan does not give you access to that time period."}}` envelope
> where the literal phrase sits past the previous 200-char body-
> snippet truncation. The truncation cap is now 1 KB so
> `isPlanLimitSnippet` keeps matching the phrase regardless of
> envelope padding. Rows previously stamped
> `front_analytics_auth_failed` + `unrecoverable=true` solely
> because of that truncation are re-armed automatically on the next
> worker tick (or on manual Retry) via
> `shouldReEvaluateMisclassifiedUnrecoverable` in
> `server/services/frontAnalyticsCoverage.ts`: any row whose
> persisted error starts with `front_analytics_auth_failed` AND
> whose stored error text contains the plan-history phrase is
> treated as recoverable. Legitimate auth failures (missing
> `analytics:read` scope, revoked token, etc.) do not contain the
> phrase and stay unrecoverable.

The fallback writes three new columns on the cache row:

| Column | Value when Analytics succeeded | Value when search fallback was used |
| --- | --- | --- |
| `denominator_source` | `analytics_reports` | `search_conversations` |
| `denominator_unit` | `inbound_messages` | `inbound_conversations` |
| `analytics_plan_limited_at` | `NULL` (cleared on every successful Analytics pull) | timestamp of the plan-limit observation; refreshed on every fallback attempt |

**Unit caveat.** `inbound_conversations` ≠ `inbound_messages`. A long
thread is one search result but many Analytics messages. The dashboard
percentages for search-sourced months are therefore approximations.
The UI surfaces a `search` (or `search (truncated)`) pill on each
affected row's status cell with a tooltip explaining the unit mismatch,
so operators don't silently compare the two denominators.

**Memoization + weekly re-probe.** `analytics_plan_limited_at` acts as
a TTL memo: within `FRONT_ANALYTICS_PLAN_LIMIT_REPROBE_TTL_MS`
(default 7 days) the worker skips the doomed Analytics submit
entirely and goes straight to the search fallback. Once the memo ages
past the TTL the worker re-probes Analytics first — so a plan upgrade
heals the denominator back to the authoritative `analytics_reports`
source automatically (no operator action required, no DB surgery).

**Status values added:**

| Status | Meaning |
| --- | --- |
| `search` | Row populated by the search fallback (count under cap). |
| `search_truncated` | Search fallback hit the 200-page cap before exhausting results; count is a lower bound. `front_analytics_error` carries a `search_truncated:` marker so the UI shows the pill but not a red error badge. |

**Failure mode added.**
* `front_analytics_search_failed` — both Analytics and the search
  fallback failed for this month. Row stays retriable
  (`unrecoverable=false`); next tick re-tries. Plan-limit memo is
  refreshed so the worker keeps going search-first instead of burning
  the Analytics submit slot.

### Front Search Fallback Semantics (Task #1767)

**Search denominator semantics.** The Search fallback counts
conversations matching the query. `after:` / `before:` apply to *any
message or comment* in the conversation that falls within the time
window — they are **not** scoped to "conversations created in the
month." This is a valid fallback denominator for plan-limited months
and the most accurate signal Front exposes for those windows, but
operators should **not** compare a search-sourced denominator 1:1
against an Analytics-sourced one: long-running threads that crossed
month boundaries will appear in multiple months, and a single thread
with N messages is one search result but N Analytics messages.
That's why the dashboard tags search-sourced rows with the `search`
pill and the unit pill (`inbound_conversations`) — the percentages
on those rows are approximations.

**Rate-limit semantics.** Front's Search API is subject to
**proportional rate limiting at 40% of the company's rate-limit
budget** (see https://dev.frontapp.com/docs/rate-limiting). Manual
"Retry (search)" bursts across several plan-limited months can hit
that cap or transient overload; Front sometimes surfaces overload as
**5xx** rather than a clean 429.

The search fallback handles those cases with two independent budgets:

| Response | Behavior |
| --- | --- |
| **200** | Parse page, continue pagination via `_pagination.next` until exhaustion or the 200-page safety cap. Resets both retry budgets. |
| **401 / 403** | Terminal. Auth/plan classification preserved — plan-limited 403 is detected by `isPlanLimitSnippet` *before* this path, on the Analytics submit. |
| **429** | Bounded retry budget of `SEARCH_FALLBACK_MAX_429_RETRIES = 5` consecutive 429s per page. Honors `Retry-After`. Exhaustion → `front_analytics_rate_limited` (still retriable on the next worker tick). |
| **5xx** | Bounded retry budget of `SEARCH_FALLBACK_MAX_5XX_RETRIES = 4` consecutive 5xx per page, with exponential backoff (500ms → 8s cap) + jitter. Honors `Retry-After` if Front provides it. Budget is *separate* from the 429 budget and resets on every successful page parse, so long paginations still complete after a transient blip. Exhaustion → `front_analytics_search_failed` with `status` + body snippet preserved on the row; still retriable (`unrecoverable=false`). |
| **4xx (not 401/403/429)** | Terminal. The query was rejected or the request shape is invalid; retrying won't heal it. Error includes status + body snippet. |

**Operational guidance — when to click Retry (search).**

* The button is auto-labelled `Retry (search)` when the row is
  already plan-limited (any of: `denominator_source =
  search_conversations`, `analytics_plan_limited_at` is set, or the
  persisted error contains the Front plan-history phrase). Clicking
  it sends `forceSearchFallback: true` and goes straight to the
  Search API.
* **Success** looks like: row status flips to `search` (or
  `search_truncated` if the 200-page cap was hit), `denominator_source
  = search_conversations`, Front denominator becomes non-zero, the
  error cell clears, and the All-time coverage headline updates to
  include the recovered denominator.
* **`search_truncated`** means the fallback hit the 200-page /
  ~20,000-conversation safety cap before exhausting pagination. The
  count is a *lower bound*; if you trust the cap-buster you can raise
  `SEARCH_FALLBACK_MAX_PAGES` and re-trigger.
* **If a row repeatedly fails:** open the Error cell, click **View**
  to expand the full text in place, and use **Copy** to grab the
  status + body snippet for a follow-up. A persistent 5xx after
  budget exhaustion almost always means Front-side overload — wait
  5–10 minutes (or pause the queue) and retry. A persistent terminal
  4xx (400 / 422) means the query was rejected by Front and Stage 1
  reproduction is needed before touching code.
* **Don't burst-click across all four plan-limited months at once.**
  The 40% proportional cap means parallel manual retries are exactly
  the workload most likely to trip rate limits. Click one month,
  wait for it to finalize, then click the next.

**Env var:**

| Name | Default | Purpose |
| --- | --- | --- |
| `FRONT_ANALYTICS_PLAN_LIMIT_REPROBE_TTL_MS` | `604800000` (7 days) | How long the plan-limit memo suppresses Analytics submits before the worker re-probes. Lower it temporarily to force an earlier re-probe after a plan upgrade. |

**One-shot backfill scripts:**
`scripts/backfill_front_search_fallback_2025.ts` (idempotent) replays
`refreshMonth` for the four known plan-limited months (Jul–Oct 2025)
so the dashboard catches up without waiting four worker ticks.

```bash
DRY_RUN=1 npx tsx scripts/backfill_front_search_fallback_2025.ts   # preview
npx tsx scripts/backfill_front_search_fallback_2025.ts             # execute
```

`scripts/backfill_front_search_fallback_2024_2025.ts` (Task #1892,
idempotent) does the same for the 14 months whose
`front_analytics_monthly_coverage` row was stuck at
`front_analytics_auth_failed (401)` (2024-04..07, 2024-10..2025-03)
or missing entirely (2025-04..06). It always passes
`forceSearchFallback: true`, so the Analytics submit is skipped (the
401 may be plan-history or a missing `analytics:read` scope — search
needs neither) and the existing `unrecoverable=true` rows are
re-armed on a successful pull.

```bash
DRY_RUN=1 npx tsx scripts/backfill_front_search_fallback_2024_2025.ts   # preview
npx tsx scripts/backfill_front_search_fallback_2024_2025.ts             # execute
```

**Task #1691 — Retry-button shortcut.** The per-row **Retry** action on
the Front Historical Recovery admin page now detects plan-limited
months (any of: `denominator_source = search_conversations`,
`analytics_plan_limited_at` is set, or the persisted error contains
the Front plan-history phrase) and sends `forceSearchFallback: true`
on `POST /api/admin/front/analytics-coverage/refresh-month`. The
endpoint passes the flag through to `refreshMonth(...)`, which skips
the guaranteed-403 Analytics submit and runs `runSearchFallback`
directly. The button is relabeled `Retry (search)` on those rows so
the operator can tell at a glance which path will execute. Result:
the dashboard heals on a single click for plan-limited months
(including misclassified `front_analytics_auth_failed +
unrecoverable=true` rows) without needing to run the one-shot
backfill script.

**Strictly measurement-only.** Like the rest of this subsystem, the
search fallback never writes to `front_sync_emails` or
`raw_communication_records`.

## Manual Retry semantics (Task #1780)

Operator-initiated calls to the manual endpoints must always force a
re-run, even on rows the worker would otherwise short-circuit as "clean
finalized":

- `POST /api/admin/front/analytics-coverage/refresh-month` (per-row
  **Retry** / **Retry (search)** button)
- `POST /api/admin/front/analytics-coverage/reprobe-month` (per-row
  **Re-probe Analytics** button after a plan upgrade)

Both endpoints invoke `refreshMonth({ ..., forceRerun: true })`. The
`forceRerun` flag is the **only** thing that bypasses the
`isExistingFinalizedClean(...)` short-circuit; every other safety gate
(perfConfig switches, rate limits, plan-limit memos) is still respected.

| Gate | Where it runs | Behavior |
| --- | --- | --- |
| `front_analytics_refresh_enabled=false` | route handler (returns 503) | blocks manual retry |
| `KILL_SWITCH_NON_CRITICAL_SWEEPS=true` | route handler (returns 503) | blocks manual retry |
| Queue-drain pause for `front_analytics_coverage_refresh` | route handler (returns 503) | blocks manual retry |
| `requireTeamLead` middleware | route handler (returns 401/403) | blocks unauthorized retry |
| `isExistingFinalizedClean(existing, isCurrentMonth, now)` | inside `refreshMonth` | **bypassed when `forceRerun: true`** |

The background worker tick (`runCoverageRefreshTick`) and the
auto-closure retry path (`frontAutoClosure.ts`) **do not** pass
`forceRerun`, so they continue to short-circuit clean finalized rows
(no wasted Analytics pulls during the periodic sweep).

The manual response payload is enriched so the toast can describe
what actually happened:

```ts
{
  month: "2025-09",
  outcome: "ok_search_fallback" | "ok" | "front_error" | ...,
  denominatorSource: "front_analytics_messages" | "search_conversations" | null,
  denominatorUnit:   "inbound_messages"   | "inbound_conversations"  | null,
  frontTotalMessages?: number,
  pulledAt: "2026-05-22T18:04:55.123Z" | null,
  frontAnalyticsStatus: "done" | "search" | "search_truncated" | "error" | null,
  frontAnalyticsError: string | null,
  // present on the front_error path:
  errorCode?: string,
  errorMessage?: string,
  unrecoverable?: boolean,
}
```

If the backend ever returns `skipped_existing_finalized` to a manual
endpoint (it shouldn't, given `forceRerun: true`), the panel renders a
**Retry blocked** toast instead of a misleading success.

## Failure modes

* `front_analytics_auth_failed` — Front OAuth refresh failed or report
  endpoint returned 401/403 for reasons **other than** the plan-limit
  phrase. Recover by reconnecting Front from Settings → Integrations.
* `front_analytics_plan_limited` — Analytics 403 with the plan-retention
  phrase. **Not** an operator failure: the search fallback is invoked
  automatically (see above). Row will show `denominator_source =
  search_conversations`.
* `front_analytics_search_failed` — search fallback transport failure
  (5xx, network, etc.). Retriable; next tick re-tries.
* `front_analytics_rate_limited` — repeated 429s from the submit step.
  Cache row is updated with the error code; the worker retries on the
  next tick. Manual fix: pause the queue, wait 5 min, resume.
* `front_analytics_report_timeout` — Front analytics report did not
  return `done` within the 5-minute poll window. Typically a transient
  Front-side issue; auto-retried.
* `front_analytics_report_failed` — explicit failure from Front. Check
  the cache row's `front_analytics_error` for context.
* `front_analytics_partial_result` — Front returned `status=partial`
  without a usable metric value. Re-runs next tick.
* `front_analytics_unexpected_shape` — response did not contain a
  numeric metric. Almost always means the metric name has changed on
  Front's side. Update `FRONT_ANALYTICS_METRIC` and re-pull.

## Interpreting ingest vs apply gap

* **Ingest gap dominates** → Front has emails we never even tried to
  fetch. Investigate Front Historical Recovery, look at the per-month
  recovery window UI, and consider a targeted recovery run.
* **Apply gap dominates** → We fetched but never applied. This is the
  Task #1641 apply-backlog territory. Check
  `scripts/diagnostic_front_recovery_gap.sql` Q4 for the
  `front_webhook_apply` queue depth.
* **Both gaps small but headline still <100%** → an unfinalized current
  month or a small per-month measurement variance — look at the
  monthly table and ignore the headline if every month is at 100%.

## One honest source of truth — three lenses + reconciliation (Task #2685)

The admin Front Console used to **contradict itself** because three
different screens answer three different "completeness" questions using
the *same words*. Reading any one in isolation is correct; side by side
they look wrong. Task #2685 is **presentation/reconciliation only** — it
adds no Front API call and changes no count, denominator, threshold, or
alert. It names each lens, registers every figure against its lens, and
reconciles the all-time numbers into one identity.

### The three lenses (`FRONT_CONSOLE_LENSES` in `shared/frontConsoleMetrics.ts`)

| Lens | Question it answers | "done" word |
| --- | --- | --- |
| **1 — Processing pipeline** (Pipeline Health KPI strip) | Of the messages we *already fetched*, how many are processed vs still queued/failing? | **drained** |
| **2 — Ingestion coverage vs Front** (this coverage dashboard) | Of *every* message Front recorded, how many did we fetch and apply into NoBull? | **covered** |
| **3 — Recovery run progress** (per recovery run) | For a *single* run, how much did that run scan and ingest? | **run-complete** |

Lens 1 ("no backlog") and Lens 2 ("25% covered") are **both true at
once**: a drained pipeline only proves everything *already fetched* is
processed; it says nothing about whether we fetched everything Front has.
The KPI strip now carries a `text-front-kpi-lens-label` caption naming
lens 1, and the coverage dashboard carries the lens-2 label plus the
`FRONT_PIPELINE_BRIDGE_NOTE` bridge text spelling this out.

### Metric registry (`FRONT_CONSOLE_METRIC_REGISTRY`)

Every console figure is registered with its `{id, question, lens, grain,
sourceTable, numerator, denominator, timeWindow}`. The id is namespaced
by lens (`front.pipeline.*`, `front.coverage.*`, `front.recovery.*`) so a
renamed or re-pointed figure can't silently drift into the wrong lens.
`tests/front-console-metrics.test.ts` enforces uniqueness, full
specification, lens-namespacing, and the no-cross-lens-vocabulary rule.

### The reconciliation identity (`computeFrontCoverageReconciliation`)

```
front total = applied + apply gap + ingest gap
  apply gap  = fetched − applied   (fetched but not yet processed)
  ingest gap = front total − fetched  (Front has it, we never fetched it)
```

The all-time banner (`banner-fa-reconciliation`) renders this identity
and a plain-English `frontReconciliationSentence(...)` so an operator can
see *why* "no backlog" and a low coverage % are both honest. The sentence,
identity, and bridge note are deliberately **message-grain wording only**
(no "conversation" vocabulary) so they render unconditionally on the
message-grain-only console (Task #2603).

### Plan-limited honesty (`frontPlanLimitState`)

A plan-limited month is in one of three honest states:

* `none` — not plan-limited; render the normal %.
* `conversation-fallback` — plan-limited AND its denominator is a
  conversation count; render the labeled conversation-grain fallback (see
  [Honest conversation-grain fallback for plan-limited months](#honest-conversation-grain-fallback-for-plan-limited-months-task-2669)).
* `message-grain-memoized` — plan-limited YET already at message grain.
  The % is a real message-grain figure but the row still carries a
  plan-limit memo (set when first probed, re-checked on a TTL). Without a
  label this reads as a contradiction, so the monthly table tags it with
  `text-fa-plan-memo-<month>` and the `FRONT_PLAN_LIMITED_MEMO_NOTE`.

## "Bring it to 100%" simple console (Task #2691)

The full Front Console is operator-grade (5 tabs + KPI strip + recovery
panels). For the CEO it answers only two questions, so the **default
view** is now a single card (`FrontBringTo100.tsx`) and every existing
tab is demoted behind an **"Advanced operator tools"** disclosure
(closed by default; auto-opened when the URL deep-links a non-default
`?tab=`, so existing operator links still work).

The card answers:

1. **"Are all our Front messages logged?"** → a `% of messages logged`
   headline (`applied / front_total`, all-time, message-grain) + raw
   counts + a progress bar marked with the **reachable target**.
2. **"How are they classified?"** → matched / unmatched / dismissed
   (sourced from `getFrontMessageGrainStats`, `dismissed = nonMatchable`).

Plus **ONE idempotent button — "Bring it to 100%"** — and one rolled-up
live status. **No new Front API call**: the summary is cache/DB-only and
the button only hands off to existing background drivers.

### Reachable (plan-limited-honest) target — `computeFrontBringTo100Target`

The pure target math lives in `shared/frontConsoleMetrics.ts` and is
unit-tested in `tests/front-console-metrics.test.ts` (gated in
`SMOKE_FILES`). It sums the **same in-scope, message-grain month set the
all-time totals use** (Task #2436: at/after the adoption floor AND a
message-grain denominator), then splits each month's ingest gap by
plan-limited (`analyticsPlanLimitedAt != null`):

```
reachableRemainingWork = applyGap(all) + ingestGap(non-plan-limited)
planLimitedRemainder   = ingestGap(plan-limited)
reachableTargetPct     = (applied + reachableRemainingWork) / frontTotal
atReachableTarget      = reachableRemainingWork === 0
```

The honesty rule has two tiers (Task #2705 split the plan-limited bucket):

- **`searchRecoverableRemainder`** — a plan-limited month whose ingest gap
  the Analytics endpoint won't return, but whose individual messages can
  still be enumerated through the **conversation-search + per-message
  workaround** (see [Search-API fallback for plan-limited months](#search-api-fallback-for-plan-limited-months-task-1681)).
  This is **reachable** work the button now chases, so it rolls into
  `reachableRemainingWork` and lifts `reachableTargetPct` toward 100%.
  Recoverability is decided by the pure helper
  `isFrontMonthSearchRecoverable({frontAnalyticsStatus, frontAnalyticsError})`:
  recoverable unless the month's analytics status is `error` / `auth_blocked`
  or its error already records a `front_analytics_search_failed` (search
  itself hard-failed — then the month is genuinely walled).
- **`planLimitedRemainder`** — the **truly** unreachable residue (search
  itself plan-limits, or auth is blocked). It can **never** be closed by this
  button, so it stays out of `reachableRemainingWork` and keeps the target a
  finite ceiling instead of an infinite spinner.
- **`searchExhaustedRemainder`** (Task #2745) — a **NON**-plan-limited month
  (`analytics_plan_limited_at IS NULL`, message-grain denominator) whose deep
  per-message search enumeration has been **proven exhausted**: reach ran the
  `/conversations/search` + per-message walk to exhaustion and Front no longer
  returns the residual messages. This gap is genuinely un-fetchable — no driver
  can close it (reach retired it, and the plan-limited driver skips non-plan-
  limited months) — so it is parked in its own bucket, **excluded** from
  `reachableRemainingWork` so the button converges instead of spinning forever.
  It is distinct from `planLimitedRemainder`, which is a *Front-plan-upgrade*
  concern, not an "already searched exhaustively" one. The marker is the
  `deep_search_exhausted_at` timestamp column, maintained by
  `reachFrontCoverageFullForMonth`: set on an `unreachable` convergence outcome
  with a residual ingest gap (materializer done), cleared on any `progress`.

```
searchRecoverableRemainder = ingestGap(plan-limited AND searchRecoverable)
planLimitedRemainder       = ingestGap(plan-limited AND NOT searchRecoverable)
searchExhaustedRemainder   = ingestGap(NOT plan-limited AND deepSearchExhausted)
reachableRemainingWork     = applyGap(all)
                             + ingestGap(non-plan-limited AND NOT deepSearchExhausted)
                             + searchRecoverableRemainder
```

A plan-limited month with the `searchRecoverable` flag omitted defaults to
**unreachable** (conservative), preserving the original Task #2691 behavior. A
non-plan-limited month with `deepSearchExhausted` omitted defaults to
**reachable** (the button keeps chasing it), preserving the pre-#2745 behavior;
plan-limited precedence is unchanged (a plan-limited month is classified by
`searchRecoverable`, never `deepSearchExhausted`).

### Orchestration — `frontBringTo100.ts`

`startFrontBringTo100(actorId)` kicks the existing, individually
idempotent + breaker-aware drivers in order, then returns immediately
(the drivers hand off to background drains/recovery jobs):

1. `runHistoricalRecovery({})` — re-pull the reachable **ingest gap**
   (skipped, not failed, when `front_historical_recovery` is paused in
   Queue Drain Control; `RecoveryConcurrencyCapError` → already-running).
2. `applyFinishFrontMessageGrainCoverage` — finish/raise every in-scope
   month to a message-grain denominator.
3. `applyReachFrontCoverageFull` — drive each sub-floor month's numerator
   toward 100% of messages. This step **retires** plan-limited months (they
   can't reach message grain via the Analytics endpoint).
4. `applyRecoverFrontPlanLimitedMessages` (Task #2705) — for the
   search-recoverable plan-limited months step 3 retires, run the
   conversation-search + per-message enumeration workaround (reusing
   `reachFrontCoverageFullForMonth`) as a resumable, breaker-aware,
   worker-pool background drain. Gated on
   `front_recovery_sparse_month_search_strategy_enabled`. The numerator it
   writes stays message-grain (no grain downgrade), so it lifts coverage
   honestly toward the search-reachable ceiling. The recovered counts are
   **approximate** (search enumeration can under/over-count vs the Analytics
   total — surfaced as a `searchNote` in the rolled-up status).
5. `applyBackfillFrontMessageAttribution` — close the **apply gap** +
   attribute matched-conversation messages.

`getFrontBringTo100Summary(db)` rolls all driver/recovery-job state into
**one** status — `working` / `blocked` / `up_to_date` / `work_remaining`
— honoring the Front auth breaker (`blocked`, button disabled) and the
plan-limited remainder (so `up_to_date` reads "everything Front lets us
log is logged"). Routes:
`GET|POST /api/integrations/front/console/bring-to-100` (+ `/status`);
GET is account-manager gated, POST is team-lead gated.

## Per-month completeness status (Task #2087)

Before this phase the coverage table only distinguished `final`
(`is_finalized_month = true`) from `current` / `error`. **"Final" read
as "done"** to operators even when a month had a huge ingest gap (the
2026-04 case: ~21,130 Front messages vs ~1,858 fetched ≈ 19k never
ingested). `is_finalized_month` only means *the denominator was
measured* — it says nothing about whether ingest/apply actually
completed — so a finalized-but-gappy month was being masked as done.

Phase 2 derives a separate **completeness status** that sits alongside
`is_finalized_month` (whose semantics are unchanged). It is computed
server-side in `deriveCoverageCompleteness()`
(`server/services/frontAnalyticsCoverage.ts`) from fields already on the
row — **no new Front call and no reintroduced mixed-direction
denominator** (the Task #1974 removal stands). The summary mapper
populates `completenessStatus` + `completenessReason` on every
`CoverageSummaryMonth`; the panel renders them as the primary Status
badge, demoting `denominator: finalized` / `denominator: current` to a
muted sub-label.

| Status | Meaning | Badge |
| --- | --- | --- |
| `covered` | Finalized + measured, no material gap on any axis (ingest, apply, or per-direction inbound/outbound). | green |
| `ingest-gap` | Finalized + measured, but Front has materially more messages than NoBull ever fetched (the masked case). A per-direction inbound/outbound shortfall folds in here — messages are still missing. | amber |
| `apply-gap` | Finalized + measured, ingest complete, but a material share of fetched messages were never applied. | rose |
| `in-progress` | Still settling: the current calendar month, a non-finalized denominator, or a `pending` pull. | sky |
| `not-measured` | Denominator can't be trusted — never pulled, units not comparable, or a terminal auth / unrecoverable failure. Surfaces "needs re-probe" instead of a false 0 % / 100 %. | slate (dashed) |

**Precedence** (first match wins): `not-measured` → `in-progress` →
`ingest-gap` → `apply-gap` → per-direction shortfall (→ `ingest-gap`) →
`covered`. Ingest gap outranks apply gap when both are material, matching
the recovery recommendation (you can't apply what you never fetched).

**Materiality threshold.** A gap counts as material when it is at least
`COVERAGE_MATERIAL_GAP_PCT` percentage points of the denominator
(default **5**, override via env
`FRONT_ANALYTICS_COVERAGE_MATERIAL_GAP_PCT`). Equivalently, a covered
month needs ≥ `100 − threshold` % coverage on every axis.

## Front self-healing coverage loop (Task #1682)

After every `front_analytics_coverage_refresh` tick, the orchestrator at
`server/services/frontAutoClosure.ts` (`runFrontAutoClosureTick`) runs
once. It is **measurement + orchestration only** — every action
delegates to an existing primitive (`refreshMonth`,
`runHistoricalRecovery`, `enqueueJob('front_webhook_apply', …)`) and
nothing in this file writes to `front_sync_emails` or
`raw_communication_records`.

What the auto-closer does, in this order, per tick:

1. **Retry recoverable error rows.** Any
   `front_analytics_monthly_coverage` row with
   `front_analytics_error IS NOT NULL`, `unrecoverable=false`, and an
   error code that is not `front_analytics_auth_failed` gets retried via
   the canonical `refreshMonth(...)` path, bounded by
   `front_auto_closure_retry_budget` (default 2 per tick).
2. **Auto-enqueue Front Historical Recovery for ingest gaps.** Months
   whose `ingest_gap` exceeds either
   `front_auto_closure_ingest_gap_threshold_count` (default 500) or
   `front_auto_closure_ingest_gap_threshold_percent` (default 5.0%) are
   sent to `runHistoricalRecovery({ customWindows: [{ label:
   "auto_closure:<month>", afterTimestamp, beforeTimestamp }] })`.
   Priority: current month → oldest month with a large gap → largest
   % gap. Bounded by `front_auto_closure_ingest_recovery_budget`
   (default 1 / tick) and `front_auto_closure_reenqueue_cooldown_minutes`
   per-month (default 360 min). Optional daily cap
   `front_auto_closure_max_recovery_runs_per_day`.
3. **Auto-nudge apply gaps.** Months whose `apply_gap` exceeds either
   `front_auto_closure_apply_gap_threshold_count` (default 500) or
   `front_auto_closure_apply_gap_threshold_percent` (default 5.0%)
   trigger a SQL join against `front_sync_emails` rows whose
   `pipeline_state != 'applied'`, finding their canonical
   `source_event_log` / `work_result_log` pair, and re-enqueuing
   `front_webhook_apply` with the canonical dedupeKey
   `apply:${sourceEventId}` so duplicates are dropped by the scheduler.
   Bounded by `front_auto_closure_apply_nudge_budget` (default 100).

**Gates honored every tick** (in evaluation order):

1. Master kill switch `front_auto_closure_enabled` (default `true`).
2. Global `KILL_SWITCH_NON_CRITICAL_SWEEPS` (env-driven).
3. Inherited from analytics: `front_analytics_refresh_enabled`.
4. `queue_drain_state.front_analytics_coverage_refresh.paused`.
5. `isApiPoolUnderPressure()` from `server/db.ts`.
6. Apply nudges separately respect
   `isQueuePaused('front_webhook_apply')`.
7. Permanent failures: rows with `unrecoverable=true` and
   `front_analytics_auth_failed` errors are never retried.
8. Per-month cooldown (after a recovery enqueue).
9. Per-tick budgets (retry / ingest-recovery / apply-nudge) — see the
   overnight-mode section below for the second budget tier.

**Persistence.** A single `system_settings.front_auto_closure_state`
JSON row holds the per-month cooldown table, the daily recovery-run
counter, and the last-run summary so the admin status line works
across restarts.

**Operator surfaces.**

* `GET /api/admin/front/auto-closure/status` returns config, defaults,
  last summary, cooldowns, daily counter, and the current mode
  (`daytime` / `overnight`) computed against the configured timezone at
  request time.
* The Front Historical Recovery admin page renders a compact one-liner
  with: enabled flag, current mode, last run time, last run mode, retry
  successes / attempts, ingest recoveries enqueued, apply nudges
  enqueued, skip reason (if any), and self-error (if any).
* Per-tick `workerLog` event `tick_complete` on worker
  `front_auto_closure` exposes counters, the months acted on, and the
  full skip-counter breakdown.

**Settings index.**

| Key | Default | Meaning |
| --- | --- | --- |
| `front_auto_closure_enabled` | `true` | Master kill switch. |
| `front_auto_closure_retry_budget` | `2` | Max recoverable error retries per tick. |
| `front_auto_closure_ingest_recovery_budget` | `1` | Max `runHistoricalRecovery` enqueues per tick. |
| `front_auto_closure_apply_nudge_budget` | `100` | Max `front_webhook_apply` enqueues per tick. |
| `front_auto_closure_ingest_gap_threshold_count` | `500` | Absolute ingest gap that triggers a recovery. |
| `front_auto_closure_ingest_gap_threshold_percent` | `5.0` | % ingest gap that triggers a recovery. |
| `front_auto_closure_apply_gap_threshold_count` | `500` | Absolute apply gap that triggers a nudge. |
| `front_auto_closure_apply_gap_threshold_percent` | `5.0` | % apply gap that triggers a nudge. |
| `front_auto_closure_reenqueue_cooldown_minutes` | `360` | Per-month cooldown after a recovery enqueue. |
| `front_auto_closure_max_recovery_runs_per_day` | unset | Optional daily cap across all months. |
| `front_auto_closure_overnight_enabled` | `true` | Master toggle for overnight aggressive mode (Task #1683). |
| `front_auto_closure_timezone` | `America/Chicago` | IANA timezone used to evaluate the overnight window. |
| `front_auto_closure_overnight_start_hour` | `0` | Inclusive start hour of the overnight window (local to the timezone above). |
| `front_auto_closure_overnight_end_hour` | `5` | Exclusive end hour of the overnight window. `start > end` wraps midnight. |
| `front_auto_closure_overnight_retry_budget` | `10` | Overnight override for `retry_budget`. |
| `front_auto_closure_overnight_ingest_recovery_budget` | `3` | Overnight override for `ingest_recovery_budget`. |
| `front_auto_closure_overnight_apply_nudge_budget` | `500` | Overnight override for `apply_nudge_budget`. |
| `front_auto_closure_dead_letter_growth_threshold` | `100` | Max allowed growth in the Front pipeline dead-letter count between two consecutive ticks (Task #1683). Exceeding it short-circuits the tick (`skippedReason=front_dead_letter_growth:<delta>>threshold`). Set `0` to disable the gate. Applies to BOTH daytime and overnight modes. |

The loop is **non-throwing by contract** — any orchestrator error is
captured in `lastSelfError` on the summary instead of bubbling, so a
bug here can never break the surrounding refresh tick.

### Auto-Closure Regression Alerts

Task #1684 adds a dedicated regression alerter that runs after every
auto-closure tick and fires when the self-healing loop is *running but
not making progress* or has gone silent. Implemented in
`server/services/frontAutoClosureRegressionAlerts.ts` and dispatched
through the existing notifications registry as
`integration.front.auto_closure_regression`.

**Independent kill switch.** This alerter is gated by
`front_auto_closure_alerts_enabled` — **not** by
`front_analytics_coverage_alerts_enabled`. Disabling the existing
coverage-drop alerter does not silence regression alerts, and vice
versa.

**Conditions evaluated.**

1. **Ingest gap growth** — a month's ingest gap grew monotonically
   across the last `front_auto_closure_alert_gap_growth_consecutive_ticks`
   ticks (default `3`).
2. **Apply gap growth** — same as above for apply gap.
3. **Silent loop** — the persisted auto-closure summary is older than
   `front_auto_closure_alert_silent_minutes` (default `60`, i.e. 2× the
   30-min coverage worker cadence).
4. **Repeated same-gate skips** — `front_auto_closure_state.lastSummary.skippedReason`
   is unchanged across `front_auto_closure_alert_same_gate_skip_ticks`
   consecutive ticks (default `5`).
5. **Recovery not converging** — ingest-recovery enqueues observed for
   the same month `front_auto_closure_alert_no_convergence_runs` times
   (default `3`) without the ingest gap shrinking. Enqueues are
   detected by transitions on the per-month cooldown timestamp in
   `front_auto_closure_state.cooldowns`.
6. **Unrecovered monthly errors** — a month carried a non-unrecoverable
   `frontAnalyticsError` for `front_auto_closure_alert_unrecovered_retry_attempts`
   consecutive ticks (default `5`).
7. **Overnight window missed** (Task #1694) — overnight aggressive
   mode is enabled but no overnight tick has been observed for longer
   than `front_auto_closure_alert_overnight_window_hours` (default
   `28`). The reference timestamp is
   `front_auto_closure_state.lastOvernightRanAt`, which the auto-closer
   stamps whenever a tick computes `mode === "overnight"` (even if the
   tick short-circuited on a gate — the signal is "the worker woke
   during overnight hours", not "the worker did work"). When
   `lastOvernightRanAt` is `null` (overnight just enabled, never run)
   the alerter falls back to its own first-observation timestamp so
   newly-enabled overnight mode gets one full window of grace before
   the condition can fire. Disabling
   `front_auto_closure_overnight_enabled` silences the condition and
   clears any active dedupe stamp.

**Dedupe.** Per-condition timestamps are stored in
`system_settings.front_auto_closure_alert_state` (`perMonth[month].alerted.<condition>`
for per-month conditions; `globalAlerted.<condition>` for silent /
same-gate-skip). The dedupe cooldown is 6 hours, mirroring
`front_analytics_coverage_alert_state`. Dedupe entries are cleared as
soon as the underlying condition resolves so the next regression fires
immediately.

**Baseline.** The very first observation seeds the rolling per-month
history without firing any alert. Subsequent ticks compare against it.

**Send failures don't arm dedupe.** If the Slack dispatcher returns
`delivered: false` for a fired alert, the dedupe stamp for that
condition is rolled back so the next tick retries.

**Admin surface (Task #1693).** The Front Historical Recovery admin
page renders a compact regression-alerts panel directly under the
auto-closure status line. It shows the kill switch state, last
evaluation timestamp, last observed auto-closure tick, currently-armed
per-condition dedupes (with their expiry), and the most recent fired
conditions (with month + Slack payload preview, deliverability badge,
and skip reason on failed sends). A "Re-evaluate now" button hits
`POST /api/admin/front/auto-closure/regression-alert-status/re-evaluate`
and refreshes the panel. The same data is exposed for tooling via
`GET /api/admin/front/auto-closure/regression-alert-status`.

**Settings index.**

| Key | Default | Meaning |
| --- | --- | --- |
| `front_auto_closure_alerts_enabled` | `true` | Master kill switch for the regression alerter. |
| `front_auto_closure_alert_gap_growth_consecutive_ticks` | `3` | Ticks of monotonic growth before firing ingest/apply gap-growth. |
| `front_auto_closure_alert_silent_minutes` | `60` | Max staleness of `lastSummary.ranAt` before firing silent. |
| `front_auto_closure_alert_same_gate_skip_ticks` | `5` | Same-`skippedReason` streak before firing same-gate-skip. |
| `front_auto_closure_alert_no_convergence_runs` | `3` | Recovery enqueues for the same month with no gap shrink before firing no-convergence. |
| `front_auto_closure_alert_unrecovered_retry_attempts` | `5` | Consecutive ticks a month carries an error before firing unrecovered-errors. |
| `front_auto_closure_alert_overnight_window_hours` | `28` | Max hours since the last overnight tick before firing `overnight_missed` (Task #1694). Gated by `front_auto_closure_overnight_enabled`. |
| `front_auto_closure_alert_state` (JSON) | (empty) | Per-condition dedupe + per-month rolling history + same-skip streak. |

### Auto-Closure Loop-Stalled Alerts

Task #1689 adds a dedicated, narrow watcher
(`server/services/frontAutoClosureStalledLoopAlerts.ts`) that pages an
operator when the self-healing loop itself stops making forward
progress — distinct from the broader Task #1684 regression alerter,
and modelled on the Slack auth circuit-breaker watcher (Task #1610) so
the stuck → recovered pair pattern matches what operators already
know.

**Why a second alerter?** Task #1684's `silent` condition shares state
and a single notification ID with five other regression conditions and
has no dedicated recovery alert. The loop-stalled watcher is
single-purpose, single-state, and emits an explicit recovery alert
exactly once.

**Conditions evaluated** (either trips the stuck alert):

1. **Stale summary** — `lastSummary.ranAt` is older than
   `front_auto_closure_stalled_loop_alert_threshold_minutes` (default
   `30` — roughly one coverage refresh interval).
2. **Self-error streak** — `lastSummary.lastSelfError` non-null on
   `front_auto_closure_stalled_loop_alert_self_error_streak` (default
   `3`) **consecutive ticks**. Streak is advanced only on a new
   `ranAt` so repeated watcher polls between two auto-closer runs
   don't inflate the count.

**Cooldown.** Once stuck, the watcher won't re-page for
`front_auto_closure_stalled_loop_alert_cooldown_minutes` minutes
(default `360`, matching the Slack auth breaker watcher).

**Recovery alert.** Fires
`pipeline.front_auto_closure.loop_recovered` exactly once after a
stuck alert when the latest summary is both fresh (within threshold)
AND has `lastSelfError == null`. Resets internal state so the next
stall starts a clean cycle.

**Send-failure safety.** A dispatcher skip (e.g. Slack down) does NOT
arm the cooldown — the next tick after the notification subsystem
recovers can deliver.

**Settings index.**

| Key | Default | Meaning |
| --- | --- | --- |
| `front_auto_closure_stalled_loop_alerts_enabled` | `true` | Master kill switch. |
| `front_auto_closure_stalled_loop_alert_threshold_minutes` | `30` | Max staleness of `lastSummary.ranAt` before firing the stuck alert. |
| `front_auto_closure_stalled_loop_alert_cooldown_minutes` | `360` | Cooldown between repeat stuck alerts while the loop remains stalled. |
| `front_auto_closure_stalled_loop_alert_self_error_streak` | `3` | Consecutive ticks of non-null `lastSelfError` before firing. |

### Overnight aggressive mode (Task #1683)

During the configured overnight window the same tick body runs with
larger per-tick budgets so the auto-closer can chew through deep
historical backlog while business hours are quiet.

* **Mode detection.** Each tick computes `daytime` vs `overnight` by
  reading the wall-clock hour in the configured timezone
  (`front_auto_closure_timezone`, default `America/Chicago`) and
  comparing it to `[start, end)`. `start > end` wraps midnight (e.g.
  `start=22, end=5` covers 22:00–04:59:59). `start == end` is treated
  as an empty window. Invalid timezones fall back to
  `America/Chicago` rather than throwing.
* **Budgets.** When `overnight`, the tick uses
  `front_auto_closure_overnight_retry_budget` (default 10),
  `front_auto_closure_overnight_ingest_recovery_budget` (default 3),
  and `front_auto_closure_overnight_apply_nudge_budget` (default 500)
  in place of their daytime counterparts. All other thresholds
  (gap floors, cooldown, daily cap) are unchanged.
* **Prioritization.** Overnight drops the current-month boost in both
  ingest-recovery and apply-nudge sorts, so the oldest historical gaps
  drain first; the current month is still covered by the normal
  coverage refresh tick.
* **Safety gates.** Overnight mode **inherits every daytime gate**
  unchanged — master kill switch, `KILL_SWITCH_NON_CRITICAL_SWEEPS`,
  `front_analytics_refresh_enabled`, coverage queue pause,
  `isApiPoolUnderPressure`, worker-lease health, Front rate-limit
  deferral, downstream `front_webhook_normalize` /
  `front_webhook_apply` pauses, `KILL_SWITCH_LARGE_BACKFILLS`,
  per-month cooldowns, the optional daily recovery cap, and the
  `unrecoverable` / `front_analytics_auth_failed` exclusions. Nothing
  in overnight mode bypasses a safety cutoff.
* **Disabling.** Setting `front_auto_closure_overnight_enabled=false`
  keeps the loop in daytime budgets 24/7 without otherwise changing
  behavior.
* **Dead-letter growth cutoff.** The tick samples the Front pipeline's
  dead-letter count (`work_result_log.status='dead_lettered'` rows where
  `source_system LIKE 'front%'`) on each run and compares against the
  previous tick's sample (persisted on the orchestrator state row). If
  the delta exceeds `front_auto_closure_dead_letter_growth_threshold`
  (default 100) the tick short-circuits with
  `skippedReason=front_dead_letter_growth:<delta>>threshold` and the
  baseline rolls forward so the gate clears as soon as the count
  stabilizes. The first sample after state reset is measure-only.
  Applies to BOTH daytime and overnight modes — overnight's larger
  budgets make the gate especially important.

The current mode is exposed by `GET /api/admin/front/auto-closure/status`
as `currentMode`, and the last-run mode is on
`lastSummary.mode` alongside `lastSummary.effectiveBudgets`.

**Editing the window and budgets (Task #1695).** The Front Historical
Recovery admin page renders an *Overnight aggressive mode* subsection
with the toggle, timezone, start/end hour, and the three overnight
budgets. Saves go through `PUT /api/admin/front/auto-closure/overnight`
(read sibling: `GET .../overnight`), which validates each field at the
API boundary — invalid IANA timezone strings, hours outside 0–23, or
budgets outside the conservative editor bounds (retry ≤ 200, ingest
recovery ≤ 50, apply nudge ≤ 5000) are rejected with `400`. Every
successful field change is recorded in `admin_setting_audit` against
the underlying `system_settings` key. Operators needing values above
the editor bounds can still edit the `system_settings` row directly;
the bounds only constrain the admin UI.

## Task #1837 — units unification (`conversations_all`)

Before Task #1837, the monthly coverage row mixed two incompatible
units: the numerator was "distinct conversations applied locally", but
the denominator from Front Analytics Reports was "inbound messages".
On Front, a single conversation can carry many messages — typical
mail threads run 3-10× — so the resulting coverage % under-reported by
the same multiplier and never reached 100% even when every Front
conversation was ingested.

The fix unifies both sides on **"conversations, all directions"**:

* **Numerator** — `countAppliedForMonth` now counts
  `COUNT(DISTINCT external_thread_id)` over `raw_communication_records`
  where `source_type = 'front_email'`. `external_thread_id` is the
  Front conversation ID (set by `frontWebhookIngestion.ts`). Stored
  unit string: `numerator_unit = 'conversations_all'`.
* **Denominator** — `pullMonthlyMessageCountViaSearchFallback` is the
  authoritative source. It queries Conversations Search without
  direction filters (`conversations_all`), so it counts every
  conversation Front saw in the month — inbound, outbound, or
  internal — matching the numerator's definition. Stored unit string:
  `denominator_unit = 'conversations_all'`.
* **Analytics Reports value preserved** — the Analytics Reports
  inbound-messages count is still pulled and stored, but as the
  diagnostic column `analytics_messages_inbound` rather than as the
  primary denominator. This keeps the historical "how many inbound
  messages did Front handle" number visible for cross-reference
  without polluting the coverage %.
* **Analytics-success path now ALSO calls Search** — on a successful
  Analytics submit, `refreshMonth` issues a companion
  Conversations-Search pull and uses *that* count as the primary
  denominator. The Analytics value is stored in
  `analytics_messages_inbound`. If the Search companion call fails,
  the Analytics value is used as a fallback denominator (in
  messages units) and the UI badges the row.

### Backfill — `recomputeAllMonths`

Existing rows are repaired via the operator-triggered endpoint
`POST /api/admin/front/analytics-coverage/recompute`, which calls
`recomputeAllMonths({ frontPullsBudget? })`. For each row, in order:

* **Already message-grain** (`denominator_unit = 'messages_all'`, from a
  completed per-message enumeration or an in-plan both-direction
  Analytics pull): the local **message** numerator is recomputed (free)
  and the message-grain denominator is **preserved**. Without this the
  row would fall through and get re-pulled back to conversations,
  silently undoing the message-grain headline on every pass.
* **Free message-grain conversion (Task #2290):** the row is still
  conversation/messages-units grain but already carries **both**
  Front-side per-direction message counts (`messages_inbound_front`
  AND `messages_outbound_front` — from an Analytics in-plan pull or a
  completed enumeration). It is upgraded to a **message-grain** headline
  IN PLACE for **free** (zero Front calls): denominator =
  inbound + outbound front messages, numerator = local inbound +
  outbound messages, both unit columns → `messages_all`,
  `denominator_source` restamped to `analytics_reports` when the
  direction data came from Analytics. This is the throttle-free backfill
  that corrects historical rows without waiting for the next scheduled
  refresh.
* If `denominator_unit` is already conversation-keyed (legacy
  `inbound_conversations` from a prior search-fallback pull or new
  `conversations_all`) **and** the row has no per-direction counts, it is
  **relabeled for free** — local numerator recomputed, both unit columns
  set to `conversations_all`, no Front call.
* Otherwise (denominator in `inbound_messages` units or unknown, no
  direction data) and budget remains, Conversations Search is called for
  a units-comparable denominator. The prior Analytics-messages value is
  moved into `analytics_messages_inbound`. Source switches to
  `search_conversations`.
* If the budget is exhausted, the numerator unit is still stamped so
  the UI badges the row as "units not comparable". Operators re-run
  to consume more budget. Default budget = 12 Front pulls per call.

CLI: `npx tsx scripts/recompute_front_analytics_units.ts --apply [--budget N]`
(dry-run by default).

### UI surface — mixed-unit Applied % suppression

`FrontHistoricalRecoveryPanel` exposes a server-derived field
`unitsComparable`. When false, the mixed-unit Applied % / Fetched %
cells render as `—` (instead of a meaningless mixed-units percentage)
so legacy pre-unification rows do not show a fake coverage number
until they are backfilled. The original yellow "units not comparable"
badge was removed in Task #1974 — the per-direction Inbound % /
Outbound % cells now carry the operator signal ("not yet measured"
when null).

### Kill switches

The recompute endpoint reuses the existing
`front_analytics_refresh_enabled` setting, the
`front_analytics_coverage_refresh` queue-drain pause, and
`KILL_SWITCH_NON_CRITICAL_SWEEPS`. No new switches added.

## Task #1974 — per-direction message coverage

Task #1837 unified the row on `conversations_all` to fix the
under-counting from mixing conversations against messages. Task #1974
re-introduces a **message-grain** view on top of that, split by
direction, so the panel answers two operational questions the unified
row alone cannot:

1. Are we ingesting every *inbound* message Front saw this month?
2. Are we ingesting every *outbound* message Front sent this month?

A single mixed denominator hid the asymmetry — a row could read 100%
while outbound was systematically under-pulled, or vice-versa.

### Data model

Nine new columns on `front_analytics_monthly_coverage` (migration
`0081_add_front_analytics_per_direction.sql`):

| Column | Source |
| --- | --- |
| `messages_inbound_front` | Front Analytics Reports, `inbound_messages` metric. Back-filled from `analytics_messages_inbound` for pre-#1974 rows. |
| `messages_outbound_front` | Front Analytics Reports, `outbound_messages` metric (new pull). |
| `messages_inbound_local` | `COUNT(*)` over `raw_communication_records` where `source_type='front_email'` AND `direction='inbound'` AND the month window. |
| `messages_outbound_local` | Same, `direction='outbound'`. |
| `messages_inbound_coverage_pct`, `messages_outbound_coverage_pct` | Derived: `min(local/front, 1.0) * 100`. NULL when Front-side count is NULL or 0. |
| `messages_inbound_gap`, `messages_outbound_gap` | Derived: `max(front - local, 0)`. |
| `direction_data_source` | `'analytics_reports'` when both directions came from a successful dual Analytics pull. NULL on plan-limited months and pre-#1974 rows. Reserved for future per-message enumeration sources. |

All nine columns are **nullable** by design. NULL means "not measured
yet" — distinct from `0` which means "measured and was empty".

### Front pull — dual metric submit

`pullMonthlyMessagesByDirectionResolved` in `frontAnalyticsClient.ts`
submits both `inbound_messages` and `outbound_messages` to Front
Analytics Reports. Either side may 403 independently with a plan-limit
shape; partial results are surfaced (`{ inbound: number | null,
outbound: number | null }`) and the corresponding per-direction
columns stay NULL rather than being stamped to `0`.

### In-plan headline at message grain (Task #2290)

When the in-plan Analytics path (`refreshMonth`) gets **both** direction
counts back, the month has a true message-grain denominator, so the
**headline** itself is published at message grain instead of the
conversation-grain Conversations Search number:

* `front_total_messages` = `messages_inbound_front + messages_outbound_front`.
* `fetched` = `applied` = local inbound + outbound message total (at
  message grain `raw_communication_records` IS the materialized message
  mirror, so the headline applyGap equals the true missing-message count).
* `denominator_unit` = `numerator_unit` = `messages_all`,
  `denominator_source` = `analytics_reports`.

Because the headline no longer needs the conversation-grain number, the
**Conversations Search companion pull is SKIPPED** whenever both
directions are known — saving a whole search pagination against Front's
tight proportional rate limit (Task #1767). The search denominator is
pulled only when the per-direction Analytics pull was unavailable (one or
both sides plan-limited / failed), in which case the row falls back to the
conversation-grain headline exactly as before — never a silent message
claim built from a single direction.

The single construction shared by the in-plan path, the search-fallback
path once per-message enumeration completes, and the free recompute
conversion is `buildMessageGrainHeadline(...)`, keeping the numerator grain
locked to the denominator grain so a month can never silently regress to a
conversation-count stand-in.

### Recompute

`recomputeAllMonths` (the operator-triggered backfill) re-runs
`countMessagesByDirectionForMonth` on every pass at zero Front-pull
cost, so the local per-direction numerators stay accurate as new
`raw_communication_records` rows land. Front-side per-direction
counts are preserved as-is — recompute does not re-pull Analytics; the
scheduled monthly refresh owns that.

### Plain-English errors + Reconnect Front button

`explainFrontAnalyticsError(rawError)` maps the persisted
`front_analytics_error` payload to:

| Field | Meaning |
| --- | --- |
| `message` | Operator-readable explanation (e.g. *"Front rejected the saved authorization. Click Reconnect Front to re-grant access."*). |
| `needsReconnect` | `true` when the fix is "re-grant OAuth". Drives the inline **Reconnect Front** button in the panel — same `/api/integrations/front/authorize` endpoint the Integrations Hub Reconnect uses. |
| `transient` | `true` when the error is retry-friendly (timeout, 5xx) and the next scheduler tick will likely succeed without operator action. |

The helper output is denormalised onto each `CoverageSummaryMonth`
(`reasonHuman`, `needsReconnect`) so the panel does not embed
error-code knowledge. `FrontAnalyticsErrorCell` shows `reasonHuman`
above the raw error; the raw payload remains accessible via the
existing Copy / View toggles.

The plan-limit detector (`isPlanLimitSnippet`) was broadened to parse
the structured `_error.title` / `_error.message` envelopes Front emits
on plan-history 403s (e.g. *"Your plan does not give you access to the
following endpoints …"* and *"Your plan doesn't include analytics"*).
This unsticks `front_analytics_auth_failed`-classified rows that
should have been recognised as plan-limited and routed to the search
fallback. `shouldReEvaluateMisclassifiedUnrecoverable` reuses the same
detector, so misclassified `unrecoverable=true` rows auto-heal on the
next refresh.

### UI surface

`FrontHistoricalRecoveryPanel` adds two sortable columns — **Inbound
%** and **Outbound %** — between the Applied % and Last pulled cells.
Each cell shows:

* `xx.xx%` plus `local / front · gap N` when both counts are present.
* *"not yet measured"* (italic grey) when the Front-side count is
  NULL — never a fake `0%`.

The legacy "units not comparable" badge was removed; the per-direction
cells now carry the operator signal. `unitsComparable` still controls
whether the mixed-unit Applied % cell prints numbers.

### Per-message enumeration fallback (Task #1983)

**Implemented (opt-in, MEASUREMENT-ONLY).** When Analytics is
plan-limited, the coverage worker can fill the per-direction
(inbound/outbound) denominators by walking Front **Conversations
Search → Messages** and counting messages at message grain
(by `is_inbound`, filtered to the month window via each message's
`created_at`). On completion the month's `messages_inbound_front` /
`messages_outbound_front` are set and
`direction_data_source = 'per_message_enumeration'`; until then the
per-direction columns stay NULL so the UI keeps showing *"not yet
measured"* rather than a partial number.

Operational shape:

* **Switch:** `system_settings.front_analytics_per_message_enum_enabled`
  (default **OFF**). When off, behavior is unchanged from the prior
  landing.
* **Resumable:** progress is checkpointed per month in
  `system_settings.front_analytics_enum_checkpoint:<YYYY-MM>` (search
  cursor + pending conversation IDs + running counts). The walk is
  conversation-atomic — a tick stops at a conversation boundary and the
  next tick resumes without double-counting. The checkpoint is deleted
  on completion.
* **Bounded:** per-tick budgets
  `FRONT_ANALYTICS_ENUM_CONVERSATIONS_PER_TICK` (default 150) and
  `FRONT_ANALYTICS_ENUM_MESSAGE_PAGES_PER_TICK` (default 600) cap the
  work per tick; in-process concurrency control prevents overlapping
  walks of the same month.
* **Respects Front limits:** the walk reuses the search fallback's
  bounded 429 / 5xx retry-with-backoff classification and honors the
  same kill switches that gate the search fallback path.
* Already-`per_message_enumeration` months are not re-walked.
* **Truncation safe (Task #1983 fix):** If a walk hits the total conversation cap (1,000) or a single conversation's message page cap (100 pages), it flags the checkpoint as `truncated`. Truncated months **never** publish their counts to the denominator columns (they remain null) and the checkpoint is cleared, preventing false 100% coverage reports from undercounts.

One piece of the original Task #1974 brief remains intentionally **not**
implemented in this landing:

1. **Close-gap retry** — when `messages_outbound_gap > 0`, enumerate
   the Front message IDs we are missing and route them through the
   existing ingestion pipeline. Requires API to list Front message IDs
   and dedupe against `raw_communication_records.external_message_id`.

It is scoped as a separate task so the original PR could ship the data
model + dual-Analytics pull + UI without an unbounded enumeration
surface.

## Automatic outbound gap close (Task #1984)

The originally-deferred **close-gap retry** now ships as a bounded,
default-OFF driver (`server/services/frontOutboundGapCloser.ts`) that
reads coverage rows with `messages_outbound_gap > 0` and routes the
still-real misses back through the existing historical-recovery
ingestion pipeline so the next coverage refresh shrinks the gap. No new
migration, table, or column is introduced — the driver reuses
`front_analytics_monthly_coverage`, `runHistoricalRecovery(...)`, and
the per-message dedupe on `raw_communication_records.external_source_id`.

**Trigger**
- **Scheduled tick** every 60 min (stagger offset `630_000` ms), enqueued
  on the work queue as `front_outbound_gap_close`.
- **Operator-triggered**: `POST /api/admin/front/analytics-coverage/close-outbound-gap`
  (requires Team Lead) enqueues a single tick on demand and writes an
  activity-log entry. An optional `{ month }` (YYYY-MM) scopes the run to
  one operator-chosen row in the gap-months table — the per-row **Run**
  action mirroring the analytics-coverage per-row Retry — instead of the
  worst-gap-first budgeted run; the dedupe key is scoped by month so a
  per-month press never collapses into a concurrent all-months run. Worker
  honors the month via the job payload.

**Gates (all must pass, evaluated in order — any failure is a logged
no-op, never a thrown error):**
1. `front_outbound_gap_close_enabled` (`system_settings`, default **OFF**)
   — master switch.
2. Queue `front_outbound_gap_close` must not be paused in
   `queue_drain_state`.
3. `KILL_SWITCH_NON_CRITICAL_SWEEPS` must not be engaged.
4. `front_recovery_per_message_materialization_enabled` (pool-epic
   switch, default **OFF**) must be **ON**. This is a *hard-gap reason*:
   recovery only writes per-message outbound rows and dedupes on
   `external_source_id` when this switch is on, so with it off the
   per-message outbound gap can never close and the tick no-ops with a
   reason rather than spawning recovery jobs that cannot help.

**Bounded work**
- `front_outbound_gap_close_max_months_per_tick` (`system_settings`,
  default **1**, hard cap **12**) caps how many worst-gap-first months a
  single tick will drive.
- Per selected month the tick **re-verifies** the gap against a fresh
  local outbound count (`countOutboundLocalForMonth`) before spending a
  recovery slot — a month whose gap has already closed since the last
  coverage refresh is skipped.
- Recovery is launched per-month via `runHistoricalRecovery({ customWindows,
  resumeMode: "clear_checkpoints" })`; `RECOVERY_CAP_REACHED`
  (`RecoveryConcurrencyCapError`) is caught and recorded as a deferred
  outcome so the next tick retries rather than crashing.

The next scheduled coverage refresh recomputes
`messages_outbound_gap = max(front - local, 0)`, so a successful drive
shrinks the gap without any direct mutation of authoritative client
entities.

## Message-grain outbound gap backfill (Task #2010)

Task #1984's close-gap retry (above) repairs the outbound gap by
re-driving the **whole month** back through Historical Recovery, which
re-lists *and* re-hydrates every conversation — roughly **2× the Front
budget** under Front's search-rate cap, and it depends on the
`front_recovery_per_message_materialization_enabled` switch being ON.

Task #2010 ships the **cheaper, message-grain repair** as a second
bounded, default-OFF driver
(`server/services/frontOutboundGapBackfill.ts`). Instead of re-driving
recovery, it runs the **same** measurement walk used by the per-message
enumeration fallback
(`enumerateMonthlyMessagesByDirectionTick`, Task #1983) with the opt-in
`collectOutboundMessages: true` flag, so each conversation's messages are
fetched **once**. It then dedupes the in-window outbound message ids
against `raw_communication_records.external_source_id` and writes only the
genuinely-missing rows through the shared
`materializeFrontMessageRecord(...)` ingestion helper (extracted from the
recovery per-message path in `frontWebhookIngestion.ts`). No new
migration, table, or column is introduced.

**Relationship to Task #1984** — both close the same `messages_outbound_gap`
and both dedupe-on-write, so they are safe to run together (or instead of
one another). Prefer **this** driver when Front budget is tight (single
fetch per conversation); prefer #1984's recovery when you also want the
conversation envelope re-applied through the apply pipeline. Unlike
#1984, this driver does **not** require
`front_recovery_per_message_materialization_enabled` — it writes
per-message rows directly.

**Trigger**
- **Scheduled tick** every 60 min (stagger offset `637_500` ms), enqueued
  on the work queue as `front_outbound_gap_backfill`.
- **Operator-triggered**: `POST /api/admin/front/analytics-coverage/backfill-outbound-gap`
  (requires Team Lead) enqueues a single tick on demand and writes an
  activity-log entry. An optional `{ month }` (YYYY-MM) scopes the run to
  one operator-chosen gap month; the dedupe key is scoped by month so a
  per-month press never collapses into a concurrent all-months run.
  `GET /api/admin/front/analytics-coverage/backfill-outbound-gap-status`
  returns the persisted last-run summary.

**Gates (all must pass, evaluated in order — any failure is a logged
no-op, never a thrown error):**
1. `front_outbound_gap_backfill_enabled` (`system_settings`, default
   **OFF**) — master switch.
2. Queue `front_outbound_gap_backfill` must not be paused in
   `queue_drain_state`.
3. `KILL_SWITCH_NON_CRITICAL_SWEEPS` must not be engaged.

**Bounded + resumable**
- `front_outbound_gap_backfill_max_months_per_tick` (`system_settings`,
  default **1**, hard cap **12**) caps how many worst-gap-first months a
  single tick will walk.
- Per selected month the tick **re-verifies** the gap against a fresh
  local outbound count (`countOutboundLocalForMonth`, reused from the
  #1984 closer) before walking — an already-closed month is skipped
  (`already_closed`).
- The walk is **resumable**: the bounded enumeration tick returns a
  checkpoint persisted under `front_outbound_gap_backfill_checkpoint:<month>`;
  rows are written **before** the advanced checkpoint is saved, so a crash
  between write and checkpoint-save only causes a harmless idempotent
  re-walk, never a lost row. The checkpoint is cleared when the month's
  walk is fully drained.
- Each written row stamps `rawPayloadJson.source = "outbound_gap_backfill"`
  so prod can tell this driver's rows apart from recovery's.

The next scheduled coverage refresh recomputes
`messages_outbound_gap = max(front - local, 0)`, so the written rows
shrink the gap without any direct mutation of authoritative client
entities.

## Automatic message-grain upgrade (Task #2365)

A finalized coverage row can publish its headline at a coarser denominator
grain than `messages_all` — `conversations_all` (the Task #1837
conversation-count search fallback for plan-limited months) or a
single-direction `inbound_conversations` / `inbound_messages` row. Only
`messages_all` answers "did we capture **100% of messages**". Until this
task a human had to press the `reach_front_coverage_full_message_grain`
prod-action to drive each lagging month to message grain.

Task #2365 ships that as a bounded, default-OFF **driver**
(`server/services/frontMessageGrainUpgrader.ts`) that converges the backlog
automatically on a cadence — the same shape as the Task #1984 close-gap and
Task #2010 backfill drivers.

**MEASUREMENT-ONLY.** The driver only re-probes the denominator and
recomputes the row; it does **not** ingest missing messages. The
numerator-repair drivers (#1984 / #2010) own that, so the three are
complementary and safe to run together.

**How a tick upgrades a month.** Each selected month is re-probed via the
**existing** `refreshMonth({ forceSearchFallback: true, forceRerun: true })`
path — the same one the prod-action uses. When the per-message enumeration
switch is ON that advances one bounded, resumable enumeration chunk
(`runSearchFallback` → `maybeRunPerMessageEnumeration`); once the walk
COMPLETES the row flips to `messages_all`. The driver then re-reads the row
and reports `upgraded` (reached message grain this tick), `advanced` (still
walking), `already_message_grain`, or `error`.

No new Front API endpoint is introduced. The enumeration walk reuses Front's
existing **Search Conversations** (`GET /conversations/search/{query}`) and
**List Conversation Messages** (`GET /conversations/{id}/messages`)
endpoints (scope `conversations:read`; standard `limit` / `page_token`
pagination), entirely outside any DB hold and rate-limited + auth-breaker-aware
via the shared Front client. (Front API docs reviewed
2026-06-08: dev.frontapp.com/reference/search-conversations,
dev.frontapp.com/reference/messages.)

**Selection (oldest first, pure read — no Front call):** finalized,
already-`pulled_at`, non-current coverage rows whose `denominator_unit`
`IS DISTINCT FROM 'messages_all'`. `pulled_at IS NOT NULL` deliberately
excludes never-measured months (the first-pull worker's job) — this driver
only **upgrades** the grain of an already-measured row.

**Trigger**
- **Scheduled tick** every 60 min (env
  `FRONT_MESSAGE_GRAIN_UPGRADE_INTERVAL_MS`, stagger offset `645_000` ms),
  enqueued on the work queue as `front_message_grain_upgrade`.
- **Operator-triggered**: `POST /api/admin/front/analytics-coverage/upgrade-message-grain`
  (requires Team Lead) enqueues a single tick on demand and writes an
  activity-log entry. An optional `{ month }` (YYYY-MM) scopes the run to one
  operator-chosen month; the dedupe key is scoped by month so a per-row press
  never collapses into a concurrent all-months run.
  `GET /api/admin/front/analytics-coverage/message-grain-upgrade-status`
  returns the gating config, the persisted last-run summary, and the
  finalized months still below message grain (oldest first).

**Gates (all must pass, evaluated in order — any failure is a logged no-op,
never a thrown error):**
1. `front_message_grain_upgrade_enabled` (`system_settings`, default
   **OFF**) — master switch.
2. Queue `front_message_grain_upgrade` must not be paused in
   `queue_drain_state`.
3. `KILL_SWITCH_NON_CRITICAL_SWEEPS` must not be engaged.
4. **Hard gate:** `front_analytics_per_message_enum_enabled` must be ON.
   Without it the search fallback can only ever produce a conversation-grain
   denominator, so a run cannot reach message grain — the driver no-ops with
   a hard-gap reason instead of burning Front budget that cannot help. The
   admin readout shows this as "enumeration OFF (hard gap)".
5. The Front auth breaker must not be open (no-op with a reconnect reason
   while Front auth is dead).

**Bounded + resumable**
- `front_message_grain_upgrade_max_months_per_tick` (`system_settings`,
  default **1**, hard cap **12**) caps how many oldest-first months a single
  tick re-probes.
- Resumability is free: the per-month enumeration checkpoint is owned by
  `frontAnalyticsCoverage.ts`, so a month that needs several chunks simply
  advances one chunk per tick until it flips.
- Idempotent: a month already at `messages_all` is excluded from selection
  (and reported `already_message_grain` if explicitly scoped), so "run all"
  converges and never re-burns budget on finished months.

## Automatic finish of message-grain coverage (Task #2529)

Task #2511's `finish_front_message_grain_coverage` is the operator's one-press
"drive **every** in-scope month to message grain" control (free relabel first,
then a forced per-message enumeration drain for the rest — see [One consolidated
control](#one-consolidated-control--finish-message-grain-coverage-task-2511)
above). It self-heals on its own cadence via the Task #2086 prod-action
self-heal scheduler — but ONLY when the global `enable_prod_action_self_heal`
master switch is ON, which enrolls **every** opted-in maintenance action at once.

Task #2529 ships the small, bounded, **default-OFF dedicated driver**
(`server/services/frontFinishMessageGrainDriver.ts`,
`front_finish_message_grain_enabled`) that keeps months at message grain on a
cadence WITHOUT the global self-heal master switch — the exact same shape as the
Task #2365 message-grain **upgrade** driver above.

**Same apply path as the button.** Each tick invokes the SAME shared apply path
the operator presses — `applyFinishFrontMessageGrainCoverage(null)` (exported
from `server/services/prodActionsRegistry.ts`). So a tick (1) runs the free
`backfillInScopeMessageGrain()` relabel synchronously (zero Front calls,
idempotent) and (2) hands anything still needing a Front re-pull to the shared
worker-pool background drain, which forces the per-message enumeration walk past
`front_analytics_per_message_enum_enabled` to re-measure the denominator up to
`messages_all`.

**Complementary to #2365, not a duplicate.** The #2365 upgrade driver is gated
behind `front_analytics_per_message_enum_enabled` (it never forces enumeration),
so it cannot finish months while that switch is OFF; this driver invokes the
finish apply path that DOES force enumeration. They are safe to run together —
the shared background drain takes its own cluster-wide advisory lock, so the same
month is never double-processed.

**GRAIN-ONLY (inherited from the shared apply path).** It re-measures the
denominator grain; it does **NOT** drive the recovery numerator (that is
`reach_front_coverage_full_message_grain`'s job, Task #1920).

No new Front API endpoint is introduced. All Front traffic flows through the
shared apply path's existing **Search Conversations**
(`GET /conversations/search/{query}`) and **List Conversation Messages**
(`GET /conversations/{id}/messages`) calls (scope `conversations:read`; standard
`limit` / `page_token` pagination), entirely outside any DB hold and
rate-limited + auth-breaker-aware via the shared Front client. (Front API docs
reviewed 2026-06-15: dev.frontapp.com/reference/search-conversations,
dev.frontapp.com/reference/messages.)

**Trigger**
- **Scheduled tick** every 60 min (env
  `FRONT_FINISH_MESSAGE_GRAIN_INTERVAL_MS`, stagger offset `650_000` ms),
  enqueued on the work queue as `front_finish_message_grain`. The enqueue is
  cross-instance-safe (dedupe-keyed per time bucket); the heavy work runs in the
  worker pool under the shared drain's advisory lock.

**Gates (all must pass, evaluated in order — any failure is a logged no-op,
never a thrown error):**
1. `front_finish_message_grain_enabled` (`system_settings`, default **OFF**) —
   master switch. The scheduler skips enqueue entirely while disabled, so a
   default-OFF deploy never piles up no-op jobs.
2. Queue `front_finish_message_grain` must not be paused in `queue_drain_state`.
3. `KILL_SWITCH_NON_CRITICAL_SWEEPS` must not be engaged.
4. The Front auth breaker must not be open — while Front auth is dead the tick
   reports `blocked` (reconnect Front first) and never fires a run that cannot
   succeed. It converges automatically once auth heals.

Each tick persists a plain-English JSON summary to
`front_finish_message_grain_last_run` for the operator readout.

### Operator status & on-demand trigger (Task #2558)

The scheduler runs on its own 60-min cadence, so flipping
`front_finish_message_grain_enabled` ON could leave an operator waiting up to an
hour for the next tick — and there was no way to read what the driver last did
without scraping worker logs. Task #2558 pairs the driver with two Team-Lead
routes (mirroring the Task #2365 message-grain UPGRADE driver's
`upgrade-message-grain` / `message-grain-upgrade-status` pair):

- **`GET /api/admin/front/analytics-coverage/finish-message-grain-driver-status`**
  — pure read. Returns the gating config (`enabled`, `paused`,
  `killSwitchNonCriticalSweeps`, `frontAuthBreakerOpen`) and the persisted
  last-tick summary via `readLastFinishMessageGrainRun()`
  (`lastRun` + `lastRunStatus` of `ok` / `never_run` / `unreadable`, plus
  `lastRunError` when the stored value is unreadable). Makes no Front API call —
  reads `system_settings` only. Companion to the manual Task #2511
  `finish-message-grain-status` consolidated-control readout.
- **`POST /api/admin/front/analytics-coverage/finish-message-grain-driver-run`**
  — enqueues a single `front_finish_message_grain` tick on demand (same
  worker path the scheduler uses, `trigger: "operator"`, dedupe-keyed per
  minute bucket) and writes a `front_finish_message_grain_triggered` activity
  log. It mirrors the tick's gates and 503s with a plain-English `reason` when
  the driver is disabled, the queue is paused, `KILL_SWITCH_NON_CRITICAL_SWEEPS`
  is engaged, or the Front auth breaker is open — instead of enqueueing a tick
  that could only report `blocked`.

A small **Finish-message-grain driver** surface on the Front analytics coverage
panel (`FrontHistoricalRecoveryPanel.tsx`) renders the enabled / queue-paused /
auth-down badges, a **Run now** button (disabled with the same calm reason the
route would 503 on), and the last-tick readout.

## Local-only count refresh for finalized months (Task #2145)

Older finalized months (e.g. 2026-01..04) can carry **stale cached
`fetched` / `applied` counts**: the cache row was written when the local
`front_sync_emails` mirror was still incomplete, and later backfills /
gap-drains filled the mirror without re-pulling Front for those closed
months (Task #1787 de-cadencing intentionally stops the Analytics API
firehose). The cached coverage row therefore under-reports adoption even
though the local data is now complete.

`recomputeLocalCountsAllMonths({ dryRun?, now?, onlyMonths? })` in
`server/services/frontAnalyticsCoverage.ts` repairs this **without any
Front API call**. For every coverage row that is `is_finalized_month =
true` and not the current month it:

* recomputes `fetched` (`countFetchedForMonth`), `applied`
  (`countAppliedForMonth`), and the per-direction local counts
  (`computeDirectionCoverage`) purely from the local mirror;
* **preserves** the existing Front-side denominator
  (`front_total_messages` / `analytics_*` / units), recomputing only the
  coverage percentages from that preserved denominator;
* upserts a row **only when** `fetched`, `applied`, or either
  per-direction local count actually changed (dry-run reports the diff
  without writing).

It returns `{ attempted, changed, results: [{ month, changed, before,
after }] }`. Because non-finalized and current months are excluded and a
no-op month is never re-written, the recompute **converges** — a second
run reports `changed = 0`. `onlyMonths` restricts the sweep to specific
month labels (used by hermetic tests and targeted operator recomputes);
omit it to refresh every finalized historical month.

**Operator trigger** — the idempotent prod-action
`refresh_finalized_front_coverage_local_counts`
(`server/services/prodActionsRegistry.ts`). `status()` runs the dry-run
and reports `pending` when any finalized month would change (else
`not-needed`); `apply()` performs the write. It makes **zero** Front API
calls and touches only the local coverage cache, so it never re-triggers
the Analytics firehose.

**Automatic refresh (Task #2175)** — the action also opts into the
maintenance prod-action self-heal scheduler (Task #2086) via
`ProdAction.selfHeal` (cadence 6 h after a run that changed rows, 24 h
backoff after a `not-needed`/error run), gated by the master switch
`enable_prod_action_self_heal`. With the master switch ON the self-heal
tick re-runs the idempotent recompute on that cadence so finalized-month
counts stay fresh as future backfills / gap-drains keep filling the local
mirror — no operator press required. Because the recompute converges
(`changed = 0` once everything matches) and makes zero Front API calls,
the automatic runs are safe and no-op when nothing drifted. See
[PROD_ACTION_SELF_HEAL.md](./PROD_ACTION_SELF_HEAL.md).

## Reaching 100% of messages, for good (Task #1920)

Three transient failure modes used to freeze a month short of 100% and
keep it there:

1. **A single transient `401` permanently froze the row.** Either probe
   (Analytics submit or the Conversations Search fallback) classified
   *any* `401` as the unrecoverable `auth_failed` state, so a momentary
   token blip during a refresh race poisoned a finalized row forever even
   after Front auth recovered on its own.
2. **The denominator was measured at conversation grain** for
   search-sourced months, so a month could read "100% of conversations"
   while still missing messages inside multi-message conversations.
3. **Nothing drove the recovery numerator back up** for a month once it
   had been parked or marked unrecoverable — the operator had to chase
   each month by hand.

### Step 1 — `auth_blocked` is recoverable, and un-sticks itself

`classifyProbeFailure(code, status)` in
`server/services/frontAnalyticsCoverage.ts` now treats a probe `401` as
the **recoverable** `auth_blocked` status (`unrecoverable = false`)
**unless the Front auth breaker is open** (`frontAuthBreakerActive` —
i.e. the token is genuinely revoked, not a transient blip). The probe
also force-refreshes and retries once inline before deciding, so a
refresh-race `401` is resolved in-band rather than persisted.

`shouldReEvaluateAuthBlocked(existing)` un-freezes rows that an *earlier*
build had stamped `unrecoverable = true` from a genuine-401 path: once
`isFrontAuthHealthy()` is true again it returns `true` so the worker
re-probes the row (plan-limit snippets are excluded — those are a
denominator-availability problem, not auth). It is wired into **both**
worker skip guards and complements the existing
`shouldReEvaluateMisclassifiedUnrecoverable`. In `deriveCoverageCompleteness`
an `auth_blocked` row resolves to **not-measured** (the denominator is
temporarily unknown), never to a false "covered".

### Step 2 — message-grain denominator for search-sourced months

When the per-message enumeration fallback (Task #1983) completes for a
month (`directionDataSource = per_message` with non-null inbound +
outbound), `runSearchFallback` now publishes a **message-grain primary
denominator**: `frontTotalMessages = inboundFront + outboundFront`,
`fetched = applied = local inbound + outbound`, and both
`denominatorUnit` and `numeratorUnit` set to `messages_all`. Coverage is
then a true messages-to-messages comparison. If enumeration did not
complete the row stays at conversation grain (unchanged behavior).
`recomputeAllMonths` preserves `messages_all` rows so a later recompute
never silently downgrades them back to the conversation denominator.

**In-window per-month grain (Task #2718).** A long-lived conversation is
returned by Front's `/conversations/search/after:X before:Y` for *every*
month window its activity touches, so the same conversation can appear in
two adjacent months' searches. The per-message enumeration walk counts a
message toward a month **only when that message's own `created_at` falls
inside the half-open `[monthStart, monthEnd)` window** (the message-fold
filter in `enumerateMonthlyMessagesByDirectionTick`). Each month's
message-grain denominator therefore contains only the messages that
actually occurred in that month — a cross-month conversation contributes
its earlier messages to the earlier month and its later messages to the
later month, never its full history to both. The simple-console
`reachable_ceiling` (`computeFrontBringTo100Target` in
`shared/frontConsoleMetrics.ts`) sums these per-month `frontTotalMessages`
denominators directly, so once a month is at message grain its
contribution to the ceiling is already cross-month-correct; the ceiling
math needs no separate de-duplication pass.

**Conversation-grain months are excluded from the ceiling (Task #2722).**
The in-window correctness above only holds *once a month has reached
message grain*. While a month is still measured at conversation grain
(`denominator_unit = conversations_all` / `inbound_conversations`,
i.e. per-message enumeration not yet finished), its denominator is a
`/conversations/search` *conversation* count, and a long conversation
active across several months is returned once by **each** of those
months' searches — so summing those conversation-grain months would count
that one conversation once per month and inflate the aggregate ceiling
with cross-month overlap. `computeFrontBringTo100Target` is therefore the
single grain authority: it **excludes** any conversation-grain month from
`frontTotal` / `applied` / the gaps and instead reports
`conversationGrainExcludedMonths` + `conversationGrainExcludedConversations`
for an honest "still counted by conversation" note. The
finish-message-grain / reach drivers (Step 3/4 below) converge those
months to message grain, at which point each in-window message counts
exactly once and the month re-enters the ceiling. The headline ceiling
numbers are unchanged by this — conversation-grain months were already
filtered out by the caller; the change moves the filter into the pure
function and surfaces the excluded count instead of silently dropping it.

### Step 3/4 — drive the numerator + one operator sweep

The idempotent worker-pool prod-action
`reach_front_coverage_full_message_grain`
(`server/services/prodActionsRegistry.ts`) converges every finalized
month still short of full coverage onto 100% of messages. A single press
starts a background drain (Task #1969 one-and-done policy) that processes
**one month per chunk** on the worker pool. Per month it:

1. **re-probes the denominator** via `refreshMonth({ forceSearchFallback:
   true, forceRerun: true, forcePerMessageEnum: true })` — which clears a
   stale `auth_blocked` flag (auth-healthy only, via the Step-1 classifier)
   and republishes the row at message grain (Step 2) when enumeration
   completes. **Task #2482 — `forcePerMessageEnum` forces the per-message
   enumeration walk even when the global
   `front_analytics_per_message_enum_enabled` switch is OFF.** This is what
   lifts the in-scope dropped-history months (2025-07 → 2026-03) from
   conversation grain up to `messages_all`, so the all-time #2436 headline
   (which sums only message-grain rows) stops reading ~0. A single operator
   press therefore restores the headline without also flipping the heavy
   global enumeration switch (the search-strategy switch remains the one
   documented prerequisite). The grain flip to `messages_all` counts as
   convergence `progress` even when the applied % drops (a message-grain
   denominator is larger than the old conversation-grain one), so a month
   is never prematurely retired the moment it finally reaches message grain;
2. **drives the recovery numerator** under the search strategy via
   `runTargetedWindowBackfill({ resume: false })` (idempotent on the
   per-conversation recovery dedupe keys) so missing
   conversations/messages are fetched + applied;
3. **recomputes that month's local counts** via
   `recomputeLocalCountsAllMonths({ onlyMonths: [month] })` (zero extra
   Front calls) so the recorded before→after delta is live.

**Following 301 merges (denominator honesty).** The per-message
enumeration walk (`enumerateMonthlyMessagesByDirectionTick`) requests
`GET /conversations/{id}/messages` for every conversation a month's search
returns. When a conversation was merged into another, Front answers that
request with a **301** to the canonical conversation; native `fetch`
follows it, so the response's final URL carries the canonical id. The walk
extracts that canonical id and dedups against the canonical merge targets it
has already counted (`mergedAwayCanonicalIds` on the enumeration checkpoint),
so a merged conversation's messages are counted **once** — never under both
the merged-away source and the canonical conversation. Without this, a merge
that surfaces both ids in search would double-count, inflating the
message-grain denominator and keeping the month perpetually short of 100%.
The dedup set is bounded by the number of merges (rare), not the
conversation count, so it does not bloat the persisted checkpoint.

The drain runs **continuously in rounds** (Task #2761): after all candidate
months in one round have been processed it immediately starts the next,
using Front's `x-ratelimit-*` headers (already read inside
`reachFrontCoverageFullForMonth`) as the natural throttle governor. Between
every chunk the Front auth breaker and the search-strategy switch are
re-checked, so a mid-drain disconnect or operator stop halts cleanly. Two
consecutive rounds that make zero combined progress (no messages ingested,
no coverage improvement) signal convergence and terminate the drain; the
60-minute self-heal cadence is a crash-recovery / resume mechanism, not the
primary pacing clock. The **budget knobs** (`front_reach_conversations_per_tick`
/ `front_reach_enum_messages_per_conversation`) now govern **chunk size**
(how much one month's chunk does before yielding for a breaker re-check),
not how many months are touched per scheduler hour. The action reports
`not-needed` when the search-strategy switch
(`front_recovery_sparse_month_search_strategy_enabled`) is OFF. The drain
tally records `months_processed`, `months_advanced`, and
`messages_ingested`; the final totals land in the prod-action History row.

**No duplicate re-walk of the same month (Task #2713).** The Step 2.5
materializer (`materializeAppliedConvMessagesForMonthTick`) expands a month's
already-`applied` conversations into per-message
`raw_communication_records` rows. Two failure modes wasted ~all the
worker/Front budget on duplicate work: (a) the per-message write was a
SELECT-then-INSERT, so two self-heal ticks / autoscale instances that both
passed the pre-check collided on the `raw_comm_external_source_id_unique_idx`
unique index — the loser threw a duplicate-key error (a continuous log storm)
yet the tick still advanced; and (b) nothing stopped two ticks/instances
walking the **same** month's conversations from the same checkpoint in
parallel. The fix removes both wastes without adding workers:
* The per-message insert is now idempotent at the DB level
  (`createRawCommunicationOnConflictSkip` → `ON CONFLICT (external_source_id)
  DO NOTHING`). A conflict resolves to a clean `"skipped"`, never a thrown
  error, so the inserted/skipped tally and the checkpoint "done" detection
  stay accurate and the log storm disappears. Non-duplicate write errors still
  surface.
* Step 2.5 runs under a **cluster-wide advisory lock** keyed by the month
  (`front_applied_conv_materializer:<month>`, via `withWorkerSingletonLock`,
  the same `crossInstanceLock` pattern as Task #2363). A tick that cannot
  acquire the lock (another tick/instance is already materializing that month)
  skips Step 2.5 and gates Step 3 (`materializeDone=false`) so it neither
  double-walks nor burns Front quota; the holder advances the resumable
  checkpoint and the next tick resumes from there. The lock self-heals on
  crash (Postgres drops the session) and a 15-minute watchdog force-releases a
  hung holder so a stalled Front page-walk cannot wedge the month forever.

Throughput is ultimately bounded by **Front API rate limits** (expanding
~138k messages means paging `GET /conversations/:id/messages` for ~140k
conversations), not the DB worker count. The documented next lever — if, after
the waste is removed, throughput is still too slow — is the per-tick Front API
call budget, **not** the worker pool (max 10) or the scheduler slot cap, both
already at their safe ceiling against Neon's connection limit.

**Operator throughput knob (Task #2714).** That per-tick Front call budget is
now operator-tunable from `system_settings` — no code change needed to speed
the backfill up or slow it down to be gentle on Front:

| Key | Default | Ceiling | Controls |
| --- | --- | --- | --- |
| `front_analytics_materializer_conversation_budget_per_tick` | `150` (`ENUM_CONVERSATIONS_PER_TICK_DEFAULT`) | `1000` | Conversations walked per materializer tick. |
| `front_analytics_materializer_message_page_budget_per_tick` | `600` (`ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT`) | `5000` | Total `GET /conversations/:id/messages` pages per tick. |

**Admin screen for the knob (Task #2720).** Operators no longer need to write
the raw `system_settings` rows. The Front Historical Recovery panel
(`client/src/components/admin/FrontHistoricalRecoveryPanel.tsx`,
`section-materializer-budget`) exposes both budgets as numeric inputs labelled
**"Bring it to 100%" backfill speed**, with the defaults (150 / 600) and
ceilings (1000 / 5000) shown inline plus a hint that it is a throughput dial
bounded by Front's API rate limit. Saving writes the same two keys via
`PUT /api/integrations/front/historical-recovery/materializer-budget`
(team-lead+; GET is account-manager+); a **blank** field deletes its row and
resets that budget to the in-code default, and a **Reset to defaults** button
clears both. Server-side validation rejects non-integer / out-of-`[1, ceiling]`
values; the resolver (`resolveMaterializerBudget`) is still the single source
of truth, so an over-ceiling value would clamp DOWN even if it slipped past the
UI.

Both are read by `loadMaterializerBudget()` in
`server/services/frontAppliedConvMaterializer.ts` and passed straight to the
enumeration tick (the leaf Front consumer). An unset / blank / non-positive /
non-numeric value falls back to the in-code default, so an empty row preserves
today's behavior exactly; an over-ceiling value clamps DOWN to the ceiling (a
fat-finger guard, still far above the defaults). The ceilings are deliberately
generous, not an exact rpm model: Front's published limits
(https://dev.frontapp.com/docs/rate-limiting, reviewed for Task #2714) are
**per-company** — 50 rpm Starter / 100 rpm Professional / 200 rpm Enterprise —
and requests from a **partner OAuth integration** (how this app connects) get a
separate per-company **120 rpm** budget that does not count against the
customer's own limit. The Search and `GET .../messages` routes are NOT on
Front's "additional rate-limiting" tiers (those cover POST/PATCH writes and
`POST /analytics/{reports,exports}`), so a tick is bounded only by that
per-minute budget, and the shared client already honors `429` / `Retry-After`
with a bounded retry budget. The knob is therefore a **throughput dial, not a
hard rate guarantee** — raising it lets ticks do more Front work before
yielding; the 429/backoff path remains the real safety net.

**Live rate-limit auto-pacing (Task #2721).** The Task #2714 knob is a *manual*
throughput dial; the 429 / `Retry-After` path is the *reactive* safety net. The
*proactive* one is `server/services/frontRateLimit.ts`. Front returns its
standard per-company budget on **every** response — `x-ratelimit-limit`,
`x-ratelimit-remaining`, and `x-ratelimit-reset` (the last as **epoch seconds**;
verified against https://dev.frontapp.com/docs/rate-limiting on 2026-06-30). The
backfill's enumeration/search paging reads those headers off each page and, once
`x-ratelimit-remaining` drops to/below **20% of the limit** (or an absolute floor
of **20** when no limit header is present), sleeps before the next page. The
delay is `time-until-reset / remaining` — so as the remaining budget shrinks the
per-page delay grows automatically — capped at **10s** (`POLL_MAX_DELAY_MS`); at
`remaining: 0` it waits out the window (same cap). A healthy budget or absent
headers → zero delay, so normal operation is unchanged. This is applied in
`pullMonthlyMessageCountViaSearchFallback` (inter-page) and inside
`frontGetJsonWithRetries` (every enumeration page), and the OAuth REST client
(`frontIntegration.ts` `frontApiRequest`) records the latest snapshot
(`getLastFrontRateLimitSnapshot()`) and self-paces on its success path too. The
effect: an operator who sets an aggressive per-tick budget cannot accidentally
starve other Front API consumers in the company — the backfill slows itself
*before* a 429, not after.

**Candidate set (Task #2369).** The pure helper
`shouldSweepFrontCoverageMonth` in `prodActionsRegistry.ts` decides, per
month, whether the drain processes it. It excludes the live current
month and any in-progress row, and adds two refinements:

* **Adoption floor.** Months before the hard-coded `FRONT_ADOPTION_DATE`
  floor (`2025-07-01`, compared as a `YYYY-MM` prefix) are excluded — they
  are legitimately pre-adoption / empty. `getFrontAnalyticsCoverageSummary()`
  returns every cached row regardless of the floor, so this filter lives in
  the sweep. The floor is fixed at `2025-07-01` (Task #2481 — see
  [Adoption date](#adoption-date-hard-coded-constant--task-2481)), bringing
  months 2025-07 → 2026-03 into scope; the sweep re-measures every in-scope
  month.
* **Covered-but-wrong-grain re-measure.** A month whose
  `denominator_unit` is **not** `messages_all` (e.g. `conversations_all`,
  `inbound_messages`, or NULL) is a candidate **even when it already reads
  ≥100% / `covered`**. Such a month reads ≥100% only because a small
  conversation-grain denominator divides an all-messages numerator;
  re-probing it converges the denominator to message grain
  (`messages_all`) and corrects the inflated reading. Once a month is on
  `messages_all` and ≥100% it drops out, so the action still converges to
  `not-needed`. This is measurement-only — message writes continue to flow
  through the recovery subsystem (Step 3 above), adding **no new Front API
  surface** (it reuses the existing `refreshMonth` / search-fallback /
  enumeration paths).
* **Convergence budget — terminally unreachable months (Task #2434).** A
  month that is genuinely unfillable was still re-counted on every self-heal
  tick before #2434 (it never reaches `messages_all` and never reaches 100%),
  so the action never settled. Each drive of `reachFrontCoverageFullForMonth`
  now records a `FrontCoverageConvergenceOutcome` that advances the month's
  `front_analytics_monthly_coverage.coverage_convergence_attempts` budget via
  the pure `nextCoverageConvergenceAttempts`:
  * `progress` (coverage advanced or rows ingested) → **reset to 0**;
  * `auth_blocked` (Front auth down) → **unchanged** — auth-down is
    recoverable, not "unreachable", so it never burns the budget;
  * `unreachable` (a clean, non-error drive that made no progress) → jump
    straight to `FRONT_COVERAGE_CONVERGENCE_CAP` (`3`, terminal);
  * `transient_error` (the recovery threw) → **+1**, bounded at the cap.

  Once `coverage_convergence_attempts >= FRONT_COVERAGE_CONVERGENCE_CAP` the
  month is `convergenceExhausted` and `shouldSweepFrontCoverageMonth` drops
  it from the candidate set, so the action converges to `not-needed` while
  any recoverable (or auth-blocked-then-healed) month still gets re-driven.

  **Task #2482 — convergence exhaustion is terminal only at message grain.**
  The convergence budget is a *numerator* concern (a month whose missing rows
  are proven unfillable); the denominator *grain* is a separate axis. So
  `shouldSweepFrontCoverageMonth` only honours `convergenceExhausted` once the
  month is **already at `messages_all`** — a still-wrong-grain month (covered
  or sub-floor) stays a candidate regardless of a spent budget, so the forced
  per-message enumeration can still lift it to message grain. This mirrors the
  #2365 message-grain upgrade driver, whose selector re-measures every
  sub-`messages_all` month regardless of the budget, and fixes the
  ~9-months-of-dropped-history regression where in-scope conversation-grain
  months sat at the convergence cap and could never re-measure.
  Regression coverage: `tests/front-adoption-floor-sweep.test.ts` and
  `tests/front-analytics-per-message-enumeration.test.ts` (forced-enum path).

  **Task #2745 — a spent budget alone is not proof the deep search walk ran.**
  #2482 retired a message-grain, non-plan-limited month as soon as its budget
  was spent ("budget spent ⇒ nothing left to fetch"). But the budget can be
  spent by grain-only re-measures or recovery passes that never actually ran the
  deep `/conversations/search` + per-message walk, leaving a **real ingest gap**
  that no driver drains (reach retired it; the plan-limited driver skips
  non-plan-limited months). This is exactly the ~81k-message / 5-in-plan-month
  stall that pinned the console headline at ~54.3%. `shouldSweepFrontCoverageMonth`
  now takes a `deepSearchExhausted` input (wired from the non-null
  `deep_search_exhausted_at` marker): a message-grain, non-plan-limited,
  budget-exhausted month is **kept a candidate** — so reach itself re-runs the
  deep walk — **until** that walk is proven exhausted, at which point it is
  retired so the action converges. `reachFrontCoverageFullForMonth` maintains
  the marker: it **sets** it on an `unreachable` outcome (clean drive,
  materializer done) that still leaves a residual ingest gap, and **clears** it
  on any `progress` outcome so a revived month re-opens. The residual gap is
  then reported in the console's `searchExhaustedRemainder` bucket (above),
  excluded from reachable work. Plan-limited months are unaffected (still
  retired by the #2499 rule below); wrong-grain months still fall through to the
  #2482 grain re-measure. Regression coverage:
  `tests/front-adoption-floor-sweep.test.ts` (marker-gated retire) and
  `tests/front-console-metrics.test.ts` (`searchExhaustedRemainder` math).

  **Task #2499 — plan-limited months retire even at conversation grain.** The
  #2482 rule above keeps a still-wrong-grain month a candidate so the forced
  per-message enumeration can lift it — but a month Front's analytics plan
  *terminally* caps at conversation grain (`analytics_plan_limited_at` set) can
  NEVER be lifted to `messages_all`, so it would be re-swept on every tick
  forever (`months_advanced:0, messages_ingested:0`) and the action would never
  settle. `shouldSweepFrontCoverageMonth` now takes a `planLimited` input
  (wired from `!!analyticsPlanLimitedAt`) and retires a month that is **both
  `convergenceExhausted` AND `planLimited`** in both the covered-but-wrong-grain
  and the sub-floor branch. Every *non*-plan-limited wrong-grain month is still
  kept (the #2482 behavior is preserved); only the terminally-capped subset is
  dropped, letting the action converge to `not-needed`. A genuinely-disconnected
  Front is still handled by the existing breaker-active `blocked` path (Task
  #2281), not perpetual pending.

### Step 6 — read-only prod before-snapshot (2026-06-02)

Captured via the read-only prod replica (`SELECT` only — no writes were
made to production; the live sweep runs only after the operator deploys
and presses the action). All 15 finalized months below 100% applied
coverage at snapshot time:

| month | front_total_messages | applied | applied % | denom_unit | num_unit | denom_source | unrecoverable | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-01 | 855 | 10 | 1.17 | conversations_all | conversations_all | search_conversations | **true** | error |
| 2024-02 | 838 | 7 | 0.84 | conversations_all | conversations_all | search_conversations | **true** | error |
| 2024-03 | 825 | 0 | 0.00 | conversations_all | conversations_all | search_conversations | **true** | error |
| 2024-08 | 2657 | 352 | 13.25 | conversations_all | — | search_conversations | false | search |
| 2024-09 | 2479 | 318 | 12.83 | conversations_all | — | search_conversations | false | search |
| 2025-01 | 2728 | 0 | 0.00 | conversations_all | conversations_all | search_conversations | false | search |
| 2025-04 | 3479 | 2293 | 65.91 | conversations_all | conversations_all | search_conversations | false | search |
| 2025-09 | 3801 | 3740 | 98.40 | conversations_all | conversations_all | search_conversations | false | search |
| 2025-10 | 4630 | 4569 | 98.68 | conversations_all | conversations_all | search_conversations | false | search |
| 2025-11 | 12943 | 9711 | 75.03 | inbound_messages | — | analytics_reports | false | done |
| 2025-12 | 13561 | 5793 | 42.72 | inbound_messages | — | analytics_reports | false | done |
| 2026-01 | 14102 | 5431 | 38.51 | — | — | — | false | done |
| 2026-02 | 16551 | 6559 | 39.63 | — | — | — | false | done |
| 2026-03 | 20825 | 7790 | 37.41 | — | — | — | false | done |
| 2026-04 | 21130 | 7958 | 37.66 | — | — | — | false | done |

Observations confirming the three failure modes this task fixes:

* **2024-01/02/03 are frozen `unrecoverable = true` with status `error`** —
  the genuine-401-path freeze Step 1's `shouldReEvaluateAuthBlocked`
  un-sticks once Front auth is healthy.
* Several months carry a `conversations_all` denominator (conversation
  grain) — Step 2 republishes these at `messages_all` once per-message
  enumeration completes under the search re-probe.
* Every row sits below 100% applied — Step 3/4's sweep drives the
  recovery numerator under the search strategy.

**After-snapshot** is captured by re-running the same `SELECT` against the
prod replica once the operator has deployed this change, turned the
search-strategy switch ON, and pressed `reach_front_coverage_full_message_grain`
to convergence. Because the sweep mutates production it cannot run from
this environment; the before-snapshot above is the baseline to diff
against.

### Task #2369 — read-only prod before-snapshot (2026-06-08)

Captured via the read-only prod replica (`SELECT` only). At the time, the
operator change was to set `system_settings.front_adoption_date` to
`2025-07-01`, then run the sweep. **Superseded by Task #2481:** the floor
is now the hard-coded `FRONT_ADOPTION_DATE = "2025-07-01"` constant — no
row to set — precisely because the mutable row regressed (see below). The
sweep still needs running to converge collection.

At snapshot time the prod floor was **`2026-04-16`** (set 2026-06-08,
empty `updated_by`) — i.e. only April 2026 onward was in scope, so the
July-2025 → March-2026 months were excluded from collection entirely.
After setting the floor to `2025-07-01`, the finalized in-scope months
were:

| month | front_total | applied | applied % | denom_unit | num_unit | sweep candidate? |
| --- | --- | --- | --- | --- | --- | --- |
| 2025-07 | 3449 | 33168 | 100 | conversations_all | conversations_all | **yes — wrong grain** |
| 2025-08 | 3222 | 11607 | 100 | conversations_all | conversations_all | **yes — wrong grain** |
| 2025-09 | 3801 | 3740 | 98.40 | conversations_all | conversations_all | yes — sub-floor |
| 2025-10 | 4630 | 4569 | 98.68 | conversations_all | conversations_all | yes — sub-floor |
| 2025-11 | 12943 | 9711 | 75.03 | inbound_messages | conversations_all | yes — sub-floor |
| 2025-12 | 4416 | 5793 | 100 | conversations_all | conversations_all | **yes — wrong grain** |
| 2026-01 | 5503 | 5431 | 98.69 | conversations_all | conversations_all | yes — sub-floor |
| 2026-02 | 16551 | 6559 | 39.63 | — | conversations_all | yes — sub-floor |
| 2026-03 | 20825 | 7790 | 37.41 | — | conversations_all | yes — sub-floor |
| 2026-04 | 8053 | 7959 | 98.83 | conversations_all | conversations_all | yes — sub-floor |
| 2026-05 | 22693 | 200 | 0.88 | messages_all | messages_all | yes — sub-floor |
| 2026-06 | 2202 | 2355 | 100 | conversations_all | conversations_all | no — current month |

Confirms the two behaviors this task ships: the **floor** brings 2025-07
→ 2026-03 back into scope, and the **covered-but-wrong-grain** rule
(2025-07 / 2025-08 / 2025-12, all reading ≥100% on `conversations_all`)
makes them candidates for a message-grain re-measure even though they
already classify as covered. 18 pre-2025-07 rows (2024-01 → 2025-06)
stay excluded by the floor.

**After-snapshot** is captured by re-running the same `SELECT` once the
operator has set the floor and pressed (or let self-heal apply) the
sweep. The sweep cannot run from this read-only environment; the table
above is the baseline to diff against.

## AI-study materialized Front messages (Task #2602)

Reaching message-grain coverage materializes one
`raw_communication_records` row per historical Front message (the
per-message enumeration path, `materializeFrontMessageRecord`). Those
rows are written `processing_status='processed'` with **no `clientId`** —
which is correct for the coverage *count*, but it means each row never
enters the classifier queue and is therefore **never studied** into the
unified `agent_knowledge_base` (`analyzeCommunication` only persists
client knowledge when a `clientId` is set, and only enqueued records run
through the analyze worker at all). So coverage could reach ~100% of
messages while the agent learned from none of the freshly-materialized
ones.

`server/services/frontMaterializedMessageStudy.ts` closes that gap. It
walks the materialized rows that have not yet been studied
(`source_type='front_email'`, `source_subtype='email_message'`,
`ai_processed_at IS NULL`, `processing_status='processed'`,
`direction IN ('inbound','outbound')`, `timestamp >= FRONT_ADOPTION_DATE`)
and, per row, resolves the participant set against the **same
deterministic hard-match index** Front uses elsewhere
(`resolveFrontHardMatch` / `getHardMatchIndexes`):

- **Confident client match** → persist the `clientId`, **claim** the row
  by flipping `processing_status` to `'pending'` (which removes it from
  the candidate predicate so a re-run can never double-process it), and
  enqueue the existing `analyze_communication` job (`dedupeKey
  analyze_<id>`). The message is then AI-studied exactly like any other
  communication, landing knowledge in `agent_knowledge_base`.
- **No confident client** (ambiguous / no match) → stamp
  `ai_processed_at` terminal. There is no client knowledge target, so
  studying it would be pure OpenAI spend; stamping it makes the queue
  converge.

### One control — `study_materialized_front_messages`

A single one-press, self-healing, worker-pool prod-action drives the
whole backlog: each chunk processes a bounded batch, and because every
row is claimed or stamped, `countPending` strictly decreases and the
action converges to `not-needed`.

It is gated behind the **default-OFF**
`front_materialized_message_study_enabled` switch — studying ~100% of
historical Front messages through GPT-4o is real, unbounded OpenAI spend,
so it is opt-in like every other heavy Front driver. While the switch is
OFF the action reports `not-needed` and does nothing. This is a
*study/attribution* driver only; it does **not** change any coverage
numerator or denominator (that is the job of
`reach_front_coverage_full_message_grain` and
`finish_front_message_grain_coverage`).
