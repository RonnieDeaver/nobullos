# Maintenance Prod-Action Self-Heal (Task #2086)

A default-OFF, master-switch scheduler that automatically applies the
**idempotent, recurring maintenance prod-actions** on a cadence, so the
CEO no longer has to open the CEO Buttons panel and apply them by hand
whenever a backlog re-accumulates.

It is a thin orchestrator: every action it runs is the **same**
`action.apply()` the panel already calls. With the master switch OFF
(the default) it does nothing at all — behaviour-neutral.

- Service: `server/services/prodActionSelfHeal.ts`
- Queue / handler: `prod_action_self_heal` (`workQueueHandlers.ts`)
- Enqueue scheduler wired in `server/index.ts`; stagger offset
  `prod_action_self_heal` in `server/services/workerConfig.ts`.

## Eligibility — opt-in only

An action runs automatically **only** if it carries the
`selfHeal: { cadenceMs, backoffMs }` field on its `ProdAction`
definition (`server/services/prodActionsRegistry.ts`). `selfHeal ===
undefined` means manual-only. The 27 actions opted in today (Task #4762
enrolled the last five — safe converging one-offs now drain themselves
instead of waiting for a press):

| Action id | cadence (after a run that did work) | backoff (after no-op / error) |
| --- | --- | --- |
| `dedupe_user_notifications_unread` | 1 h | 6 h |
| `cancel_stale_front_backlog` | 30 min | 2 h |
| `recover_frozen_front_mirror` | 15 min | 1 h |
| `unblock_poisoned_front_recovery_checkpoints` (Task #2281) | 30 min | 2 h |
| `drain_front_122k_backlog` | 1 h | 4 h |
| `mark_legacy_front_email_pending_terminal` | 6 h | 24 h |
| `purge_pre_floor_front_coverage_rows` | 6 h | 24 h |
| `repair_front_coverage_denominator_floor` | 6 h | 24 h |
| `refresh_finalized_front_coverage_local_counts` | 6 h | 24 h |
| `rematch_dismissed_operational_front_backlog` | 10 min | 1 h |
| `rematch_unmatched_front_backlog` (Task #4762) | 6 h | 6 h |
| `backfill_front_message_attribution` | 1 h | 6 h |
| `backfill_competitor_location_labels` | 1 h | 6 h |
| `backfill_competitor_structured_location` | 1 h | 6 h |
| `backfill_competitor_locality_relabel` | 1 h | 6 h |
| `cleanup_legacy_keyword_spellings` | 6 h | 24 h |
| `rerun_stale_semrush_partials` | 1 h | 6 h |
| `reach_front_coverage_full_message_grain` (Task #2281) | 1 h | 6 h |
| `front_recent_window_message_freshness` | 1 h | 6 h |
| `recover_front_plan_limited_messages` | 1 h | 6 h |
| `finish_front_message_grain_coverage` | 1 h | 6 h |
| `study_materialized_front_messages` | 1 h | 6 h |
| `rejudge_stale_client_judgments` (Task #4762) | 6 h | 6 h |
| `purge_dead_front_adoption_date_setting` | 6 h | 24 h |
| `heal_imported_fabricated_zero_metrics` (Task #4762) | 6 h | 6 h |
| `retire_legacy_zoom_oauth_tokens` (Task #4762) | 6 h | 6 h |
| `backfill_seasonal_trend_ai_commentary` (Task #4762) | 6 h | 6 h |

Auth-`blocked` actions (Front / SEMrush / Zoom genuinely disconnected)
return a **`blocked`** outcome — not an endless manual "remaining" —
detected cheaply in `status()` via the in-memory auth breaker (no `/me`
probe on every panel poll). Task #4840 splits `blocked` into **two
flavors**, discriminated by whether the outcome **names an
`integration`**:

- **Auth reconnect** (`blocked` *with* `integration`): the login really
  is dead. The tick treats it as reconnect-required (Task #2124 alert;
  never inflates the failure streak) and converges the action
  automatically the moment auth heals. The panel shows the orange
  "Needs reconnect" badge + Integrations Hub link.
- **Precondition wait** (`blocked` *without* `integration`): the action
  is gated on something that is not an auth problem (e.g. the Zoom
  legacy-retirement soak waiting on live S2S webhook evidence). Same
  backoff/streak semantics, but it **never pages admins** and the panel
  renders it as a calm "Blocked — waiting" row whose status detail
  explains what it waits for — no reconnect link, no reconnect claim.

To add another action: confirm it is idempotent (a second apply with
nothing to do returns `not-needed` and writes zero rows) and
breaker/pause-aware, then add a `selfHeal` field with sensible
cadence/backoff. No scheduler change is required — the tick discovers
eligible actions from the registry at runtime.

Gate-guarded actions may enroll too: `retire_legacy_zoom_oauth_tokens`
self-gates on the full ZOOM.md § Retirement triple (mode `s2s`, ≥72h
soak since `zoom_s2s_cutover_at`, live S2S-webhook proof ≤7d) and
returns `blocked` while any gate is unmet — an early scheduled press
settles harmlessly, and the amber blocked row **during the soak is by
design** (the genuinely-human Zoom reconnect precedes it; once the gates
pass, the next pass presses it with no further operator involvement).
Because its gate outcomes name no integration, the soak renders as
"Blocked — waiting" (precondition-wait flavor), not "Needs reconnect".

## Drain declarations — zero by default (Task #4762)

Every registered action must now declare **how it reaches zero without a
human**. `assertProdActionConvergenceInvariants()` (module-load assertion
in the registry barrel + taxonomy guard suite) fails the boot and the
tests when a `converging` action has none of:

- `selfHeal: { cadenceMs, backoffMs }` — enrolled; the scheduler presses it.
- `manualLever: true` — availability, not work; status is synthetically
  `not-needed`, so it can never hold the badge.
- `humanGate: { reason }` — an explicit declaration that a human step is
  the drain (reconnect, external console op, operator-owned data edit).
  The reason renders on the amber row, so amber always explains itself.
  `humanGate` is converging-only and mutually exclusive with `selfHeal`
  and `manualLever` — it exists to make "a human is the drain path" a
  deliberate, visible choice rather than a silent default.

`continuous` actions already declare their drain (the named loop). The
result: a new action that would strand a pending row with no drain path
fails at boot and in tests — the class of "ships pending, waits for a
human forever" can't come back silently.

### Manual-lever exclusion: Paid Search role import

The Paid Search role-cutover **import** action (`import_paid_search_roles`)
imports the current **canonical production** Doer/Checker values **INTO
NoBull** — see `ADS_OS.md § Paid Search role cutover`. It is a **MANUAL
LEVER**, not a self-heal action, and it is **not** the projection/promotion
step (it writes **no ClickUp**):

- It carries **no** `selfHeal` field, so the scheduler never presses it — an
  operator presses it. Apply-all does not run it.
- Its drain path is `manualLever: true` (availability, not recurring work):
  its status is synthetically `not-needed`, so it can never hold the
  needs-attention badge or fall into the enrolled-converging auto bucket.
- It is **resumable**: a re-press retries only unresolved work (conflicts,
  newly matched parents), so an operator may safely press it again.
- Current/resume state is **per parent + role** in `ps_role_import_audit`;
  immutable per-press evidence is appended to `ps_role_import_attempts`
  (including retryable failures), so retries never erase earlier evidence.
  Successful assignments and their `imported` evidence commit atomically; an
  evidence-write failure rolls the assignment back and leaves the slot retryable.
- The separate **production projection** flow (staging generic
  `clickup_role_projection` commands to the canonical Doer/Checker People
  fields) is likewise **never** self-healed: it is gated by generic
  destination approvals, the `clickup_role_projection` kill switch, and the
  Paid Search read/projection approvals + write flag documented in
  `ADS_OS.md`, none of which is the self-heal scheduler. Do **not** enroll the
  import or any role read/projection in self-heal — these are deliberate,
  operator-owned steps, and Google Ads stays read-only throughout.

### Calm auto-managed bucket

`GET /api/admin/prod-actions` partitions rows that are draining without
an operator into `autoManaged` (never counted by the needs-attention
badge):

- **Working rows** — a `pending` status carrying `working: true` (the
  action's own background drain is observably progressing, e.g. the
  re-judge or seasonal-backfill fanned-out chains) renders as a calm
  "working" entry with the live N-of-M detail.
- **Enrolled converging rows** — `converging` + `selfHeal` + `pending`
  while the scheduler is healthy (master ON, no failure streak on that
  action) render as "auto-applies by ~next eligible pass".
- **Healthy continuous rows** — Task #4054 semantics, unchanged.

Errors, `blocked` states, failure streaks, and master-switch OFF all
fall through to the amber active list — the calm bucket fails toward
visibility.

### Lever retirement (served-purpose probes)

Levers whose purpose can be *verified complete* declare a
`servedPurpose()` probe; when it reports the target state reached, the
panel moves the lever to History with a completion note instead of
letting the lever list grow forever. Probes never retire on "unknown" —
a probe failure keeps the lever visible. Current probes: the Drive
legacy-key lever (B-008 closed: IAM-verified 404 + DB setting cleared +
env absent), the Zoom S2S rollback lever (mode `s2s` + all legacy token
rows retired — rollback is no longer meaningful), and the
inactive-product report-blocks lever (residue scan fully zero). The
retired action stays registered, so the Apply-all one-audit-row-per-action
contract is unchanged; removing the code is a later cleanup once
retirement is observed in prod.

### Mis-predicated statuses fixed by #4762

- `semrush_keepalive_rotate_now` used a fixed >4h staleness cut while
  the keep-alive loop ticks every 6h, so it perpetually re-armed. It now
  reads the loop's **own** interval (`getSemrushKeepAliveIntervalMs()`)
  and reports `not-needed` while the heartbeat is within 2× that
  interval (and outside deployments, where the loop is deliberately
  dormant); `pending` only when the loop is genuinely stale or failing.
- `delete_google_drive_legacy_key` is a manual lever and now honors the
  lever contract (never `pending`); the remaining-closure facts — DB
  setting / env var / GCP-side key state, including *why* the IAM probe
  fails (403 with the exact console path, dead clone credentials, etc.)
  — live in the lever detail via a classified probe.

### Idempotency requires terminal exclusion of unreachable work (Task #2434)

"Idempotent" here means more than "writes zero rows on a clean second
apply" — a self-heal action must also stop **counting** work it can never
finish, or it returns `applied`/non-empty-remaining forever and never
reaches `not-needed`. Three actions re-counted provably-unreachable
work-units on every tick before #2434:

- `backfill_competitor_location_labels` (#2017) and
  `backfill_competitor_structured_location` (#2052) — a snapshot whose
  SEMrush campaign keeps failing transiently. Fix: terminally stamp a row
  attempted once the campaign is **proven gone**
  (`isCampaignResolvable` → false) or its bounded
  `BACKFILL_TRANSIENT_RETRY_BUDGET` (3) is exhausted. Global outages
  (`circuit_open`/`rate_limited`) never burn the budget. See
  [SEMRUSH_MAPPING.md § Competitor backfill transient-failure convergence](./SEMRUSH_MAPPING.md#competitor-backfill-transient-failure-convergence-task-2434).
- `reach_front_coverage_full_message_grain` (#1920) — a coverage month
  that can never reach message grain / 100%. Fix: a per-month
  `coverage_convergence_attempts` budget (cap 3) that `unreachable` jumps
  to terminal, `transient_error` bumps, `progress` resets, and
  `auth_blocked` leaves untouched (recoverable, not unreachable). See
  [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md#reaching-100-of-messages-for-good-task-1920).

The distinction from a `blocked` outcome: `blocked` is a whole-action
auth wall that clears the instant auth heals; #2434 convergence is
**per-work-unit** terminal exclusion of items that will never complete
even with healthy auth. Auth-down work-units must use `blocked`/`auth_blocked`,
never the convergence budget, so they revive on reconnect.

### Relationship with the #2365 message-grain upgrade driver (Task #2387)

`reach_front_coverage_full_message_grain` does two distinct things per
candidate month: (1) re-probes the denominator via the Conversations
Search fallback so the row can reach **message grain** (`messages_all`),
and (2) drives the **recovery numerator** for genuinely sub-floor months
via `runTargetedWindowBackfill`. Task #2369 expanded its candidate set to
also include **covered-but-wrong-grain** months (already ≥100% but on a
conversation grain) purely so they get the (1) re-measure.

Task #2365 then shipped a dedicated, default-OFF **scheduled driver**
(`server/services/frontMessageGrainUpgrader.ts`, switch
`front_message_grain_upgrade_enabled`) that does exactly that
measurement-only grain upgrade on its own cadence — overlapping the (1)
half of this action for the covered-but-wrong-grain months.

To avoid the CEO panel offering work the driver now handles
automatically, `listFrontCoverageSubFloorMonths` /
`shouldSweepFrontCoverageMonth` **delegate** those covered-but-wrong-grain
months to the driver **when the driver switch is ON**: they stop being
candidates here, so once only grain re-measures remain the action
converges to `not-needed`. **Genuinely sub-floor months are never
delegated** — the #2365 driver is measurement-only and cannot fill the
recovery numerator, which stays this action's distinct job (and it keeps
self-healing on its own cadence for those). The panel detail names the
driver (`front_message_grain_upgrade_enabled`) whenever it is enabled so
the relationship is visible. When the driver switch is OFF, prior
behavior is preserved — this action re-measures the wrong-grain months
itself.

## How a tick works

1. The enqueue scheduler fires every `TICK_INTERVAL_MS` (default 15 min,
   overridable via `PROD_ACTION_SELF_HEAL_INTERVAL_MS`) and enqueues one
   dedupe-keyed `prod_action_self_heal` job (`workloadClass:
   "maintenance"`, `priority: 200`). It skips enqueue entirely while the
   master switch is OFF or the queue is paused, so a default-OFF deploy
   never piles up no-op jobs.
2. The handler runs `runProdActionSelfHealTick()` inside
   `runWithWorkerDb(...)` so every `getDb()` inside the applied actions
   resolves to the **worker** pool.
3. The tick gates in order: master switch → queue-drain pause →
   `KILL_SWITCH_NON_CRITICAL_SWEEPS`. Any gate short-circuits with a
   reason and zero side effects.
4. It selects the **due** eligible actions (never run, or `now >=
   nextEligibleAt`), oldest-due first, and applies at most
   `maxPerTick` of them (default 2, hard cap 10).
5. After each apply it advances that action's `nextEligibleAt` by
   `cadenceMs` (outcome `applied`) or `backoffMs` (outcome `not-needed`
   / `error`).

## Per-action scheduling state

The persisted `system_settings.prod_action_self_heal_last_run` JSON
carries both the readout (eligible/due ids, applied/not-needed/error
counts, reason) **and** a `schedule` map of `{ actionId: {
nextEligibleAt, lastOutcome, lastRunAt, lastRowsAffected } }`. The map is
the durable cadence/backoff state across ticks; stale keys (actions no
longer eligible) are pruned each tick.

## Persistent-failure alert (Task #2096)

Before this, a self-heal action that kept failing just backed off forever
— `recordProdActionRun` wrote an `error` audit row each backoff window,
but nobody was told the auto-fix was stuck. Task #2096 adds a bounded,
**default-OFF** alert that pages an admin when one action's failures
become *persistent* (not a single transient blip).

How it works:

- The per-action `schedule` entry (see above) also carries
  `consecutiveFailures` and a `failureAlertSent` flag.
- Every `error` outcome increments that action's streak. Any healthy
  outcome — `applied` or `not-needed` — resets the streak to 0 and clears
  the `failureAlertSent` flag (re-arming the alert). A `blocked` outcome
  (gate short-circuit, no apply attempt) leaves the streak unchanged.
- When the streak reaches the threshold (default **3**, min 1, cap 50)
  the tick fires **one** alert and sets `failureAlertSent` so it does
  **not** re-fire on every subsequent backoff tick. It stays suppressed
  until the action succeeds again, at which point the streak/flag reset
  and a fresh run of failures can page again.
- The alert reuses the per-user inbox + opt-in Slack DM mirror via
  `notifyUser()` (Tasks #1686 / #1687 / #1688), category `system`, deep
  link `/admin/integrations`, dedupe key `self-heal-failing:<actionId>`.
  Recipients are the responsible admins (`getResponsibleAdminsForAlert()`
  → CEO / team-lead). Delivery is best-effort: a notify failure never
  breaks the tick.
- Alerting is **opt-in**. With `prod_action_self_heal_failure_alert_enabled`
  OFF (the default) the streak is still tracked — so the alert works the
  moment it is turned on — but no notification is ever sent. Threshold ≥ 2
  by default means a lone one-off transient error never pages anyone.

Turn it on with `prod_action_self_heal_failure_alert_enabled = true`;
tune the trip point with `prod_action_self_heal_failure_alert_threshold`
(1..50).

## Reconnect-required alerting (Task #2124)

Separate from the persistent-failure alert above: when an integration
login expires the maintenance action it powers returns a **`blocked`**
(reconnect-required) outcome instead of an `error`. The tick watches for
that and pages the operator to go re-link the integration — so an
expired Front / SEMrush / Zoom / Google Ads login surfaces proactively
rather than silently stalling the auto-healer.

- **Task #4840 — only integration-named blocks page.** The alert fires
  only for `blocked` outcomes that carry an `integration` name (the
  auth-dead flavor: Front/SEMrush direct returns,
  `classifyIntegrationAuthBlocked` for SEMrush / Zoom / Google Ads). A
  `blocked` outcome **without** an integration is a precondition
  wait-state (e.g. the Zoom retirement soak) on a healthy integration —
  it keeps its backoff/streak bookkeeping but never pages, and its
  `reconnectAlertSent` flag simply stays false.
- An auth-dead `blocked` outcome is **deterministic** (the token really
  is dead), so there is **no** consecutive-count threshold like the
  failure alert. The tick fires **one** reconnect alert on the first
  blocked run and sets `reconnectAlertSent` so it does **not** re-fire
  on every subsequent backoff tick. It stays suppressed until a
  **healthy** run (`applied` / `not-needed`) re-arms the flag, after
  which a fresh blocked run can page again.
- `blocked` never inflates the failure-alert streak — it is tracked on
  its own flag, and the persistent-failure `consecutiveFailures` counter
  only advances on `error`.
- The alert reuses the per-user inbox + opt-in Slack DM mirror via
  `notifyUser()`, category `system`, deep link `/admin/integrations`,
  dedupe key `self-heal-reconnect:<integration>` (the action-id fallback
  is defensive only — since Task #4840 no alert fires without an
  integration name). Recipients are the responsible admins
  (`getResponsibleAdminsForAlert()` → CEO / team-lead). Delivery is
  best-effort: a notify failure never breaks the tick.
- Alerting is **opt-in**. With
  `prod_action_self_heal_reconnect_alert_enabled` OFF (the default) the
  blocked state is still tracked — so the alert works the moment it is
  turned on — but no notification is ever sent.

Turn it on with `prod_action_self_heal_reconnect_alert_enabled = true`.

## Admin readout

The CEO **Apply pending prod writes** panel surfaces what the auto-healer
did. `GET /api/admin/prod-actions` returns `selfHealEnabled` (master
switch), a `selfHealLastRun` tick summary, plus, on every action row,
`selfHealEligible` and a `selfHeal` object — the durable last-run trio
(`lastRunAt`, `lastOutcome`, `lastRowsAffected`), `nextEligibleAt`, and
(Task #2153) the persistent-failure state `consecutiveFailures` (current
error streak; 0 when healthy), `failureAlertSent` (whether the
streak's one-time admin alert has already fired), and (Task #2179)
`lastErrorDetail` (the message of the most recent `error` outcome, or
`null` when the last run was healthy) — all sourced from
`getProdActionSelfHealReadout()` over the persisted `last_run` schedule.
`lastErrorDetail` is set on every `error`, carried forward unchanged on a
`blocked` (reconnect-required) outcome, and cleared to `null` when the
action recovers (a healthy `applied` / `not-needed` outcome).

`selfHealLastRun` (Task #2095) is the tick-level readout: `ranAt` (when
the most recent pass ran), `eligibleCount`, `dueCount`, the aggregate
`applied` / `notNeeded` / `errors` counts, and an optional `reason` when
the pass short-circuited (disabled / paused / kill switch). It is `null`
until the auto-healer has run at least once.

The panel renders a master-switch banner that also shows the **last
pass** time and the applied / not-needed / error counts (or "No
automatic pass has run yet."), and a per-eligible-action "Auto-heal" line
(last run time / outcome / rows affected / next eligible) on both the
active and History rows, so the readout is visible whether self-heal is
ON or OFF and for `applied` / `not-needed` / `error` outcomes alike.

## Audit

Runs with a real effect (`applied`) or a failure (`error`) write a
`recordProdActionRun` audit row attributed to **system** (null actor) —
the same History surface manual applies use. `not-needed` runs are
intentionally **not** recorded so the History is not flooded with no-op
rows every backoff window; the `last_run` JSON still reflects the most
recent check of every eligible action.

## Operating it

- **Turn ON:** apply the `enable_prod_action_self_heal` CEO button (sets
  `prod_action_self_heal_enabled = true`).
- **Turn OFF:** set `prod_action_self_heal_enabled = false` (or trip
  `KILL_SWITCH_NON_CRITICAL_SWEEPS`, or pause the
  `prod_action_self_heal` queue via `queue_drain_state`).
- **Slow it down / speed it up:** `prod_action_self_heal_max_per_tick`
  (1..10) and the env override `PROD_ACTION_SELF_HEAL_INTERVAL_MS`.
- **Turn the persistent-failure alert ON:** apply the
  `enable_prod_action_self_heal_failure_alert` CEO button (Task #2154 —
  sets `prod_action_self_heal_failure_alert_enabled = true`). Once ON, the
  tick pages the responsible admins via `notifyUser()` when one action
  records `prod_action_self_heal_failure_alert_threshold` consecutive
  `error` outcomes (default 3). Turn OFF by setting
  `prod_action_self_heal_failure_alert_enabled = false`.
- **Tune the persistent-failure alert sensitivity (Task #2173):** the
  prod-actions / self-heal panel exposes an "Alert after N consecutive
  failure(s)" control (bounded **1..50**) that writes
  `prod_action_self_heal_failure_alert_threshold` directly — no need to
  edit the raw setting. The setter clamps/floors out-of-range input, and
  the value is re-read on every self-heal tick (the write busts the
  settings cache), so a change reflects on the **next tick** without a
  restart. Lower N = more sensitive (pages sooner). The control tunes the
  trip point even while the alert itself is OFF; the streak is tracked
  either way, so the new sensitivity applies the moment the alert is
  armed.
- **Turn the reconnect-required alert ON:** apply the
  `enable_prod_action_self_heal_reconnect_alert` CEO button (Task #2201 —
  sets `prod_action_self_heal_reconnect_alert_enabled = true`), or set the
  setting by hand. Once ON, the tick pages the responsible admins via
  `notifyUser()` the first time a self-heal action records a `blocked`
  outcome **that names an integration** (Task #4840 — auth-dead only;
  precondition wait-states never page), naming which integration to
  re-link; it re-arms after a healthy run. Turn OFF by setting
  `prod_action_self_heal_reconnect_alert_enabled = false`.

## Gating summary

| Gate | Setting / switch | Default |
| --- | --- | --- |
| Master switch | `prod_action_self_heal_enabled` | OFF |
| Queue pause | `queue_drain_state` → `prod_action_self_heal` | not paused |
| Global sweeps kill switch | `KILL_SWITCH_NON_CRITICAL_SWEEPS` | OFF |
| Persistent-failure alert | `prod_action_self_heal_failure_alert_enabled` | OFF |
| Reconnect-required alert | `prod_action_self_heal_reconnect_alert_enabled` | OFF |
