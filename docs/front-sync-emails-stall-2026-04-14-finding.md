# Front Sync Emails Writer Restoration — Task #1831

**Status:** implemented 2026-05-25.
Companion to diagnostic Task #1830 and
[`docs/front-recovery-gap-finding.md`](./front-recovery-gap-finding.md).

## Observed symptom

No new rows were written to `front_sync_emails` between **2026-04-14
12:11:21 UTC** (newest pre-cutover `discovered` row) and the deploy of
this fix. `front_sync_cursor` and `front_last_sync_success` settings
were frozen at the same date. Downstream readers
(`operationalClassifier`, `frontSyncEmailTriage`,
`agentMatchingEngine`, `frontPipelineMetrics`, `frontAutoClosure`,
`frontPipelineStuckAlerts`, `frontBulkActions`, `healthDegradedTracker`,
`frontAnalyticsCoverage`, the Communications routes, etc.) all saw a
stale-and-growing-staler picture.

## Root cause

The on-demand sync (`syncFrontEmails` in
`server/services/frontIntegration.ts`) that historically inserted rows
was decommissioned during the move to the durable webhook pipeline:

```
source_event_log
  → front_webhook_normalize  (server/services/frontWebhookIngestion.ts)
  → front_webhook_apply       (server/services/frontWebhookIngestion.ts)
  → raw_communication_records (server/services/pipelineProcessor.ts)
```

The two insert functions in
`server/storage/communicationStorage.ts` —
`createFrontSyncEmail` (line 178) and
`upsertFrontSyncEmailWithVersion` (line 351) — had **zero callers** in
the current codebase (confirmed by `rg "createFrontSyncEmail\|upsertFrontSyncEmailWithVersion"`).
Nothing in the webhook pipeline wrote to `front_sync_emails`, so the
17,805 pre-cutover `discovered` rows were the entire table.

## Remediation chosen — A (restore the writer)

Two alternatives were considered:

- **A. Restore the writer at the normalize stage.** Add a small
  `mirrorWebhookToFrontSyncEmail` helper that upserts the row in
  `discovered` state every time the normalize stage produces a
  result, and transition to `applied` from the apply stage on
  success. Minimal change, smallest blast radius, gated by a
  Phase 0 kill switch.
- **B. Deprecate the table and migrate every reader off it.** Would
  require touching ~10 downstream files (operationalClassifier,
  frontPipelineMetrics, frontAutoClosure, frontPipelineStuckAlerts,
  frontBulkActions, frontSyncEmailTriage, healthDegradedTracker,
  frontAnalyticsCoverage, routes/communications, routes/integrations)
  plus shipping a one-off backfill that retro-populates whatever
  replacement table they each switch to. Much larger scope; out of
  scope for this task.

**Chosen: A.** The Done criterion in the task plan reads:

> A new row appears in `front_sync_emails` from a real production
> webhook within 24h of deploy.

That is what Remediation A delivers; Remediation B is a future
project if the table is later judged not worth keeping.

## Implementation

New helper module:
[`server/services/frontSyncEmailMirror.ts`](../server/services/frontSyncEmailMirror.ts)

- `mirrorWebhookToFrontSyncEmail(input)` — upserts the row using
  `ON CONFLICT (conversation_id) DO UPDATE` with `COALESCE` on every
  optional field so a later payload with a null can't blank out a
  previously-set subject / snippet / participants, and `GREATEST` on
  `last_message_at` so a late-arriving older message can't regress
  the freshness column. Initial `pipeline_state = 'discovered'`.
  Hold label: `front_sync_email_mirror:upsert`.
- `markFrontSyncEmailMirrorApplied(conversationId)` — bare UPDATE
  sets `pipeline_state = 'applied'`, `state_changed_at = NOW()`,
  `processed_at = NOW()`, `pipeline_error = NULL`. A bare UPDATE
  (not `transitionFrontSyncPipelineState`) is correct because the
  webhook path legitimately bypasses the intermediate
  `triage_pending / hydrate_pending / apply_pending` states the
  legacy on-demand sync used. Hold label:
  `front_sync_email_mirror:apply`.

Wire-in sites in `server/services/frontWebhookIngestion.ts`:

1. `normalizeFrontWebhookEvent` (line ~313, after `markNormalized`) —
   live webhook path.
2. `normalizeReconciliationEvent` (line ~1062, after
   `markNormalized`) — auto-heal scan path (Task #1825).
3. `applyFrontWebhookResult` success persist phase (after
   `recordApplyOutcome`) — transitions mirror row to `applied`.
4. `applyFrontWebhookResult` `already_exists` short-circuit —
   transitions mirror row to `applied` even when we didn't create a
   new `raw_communication_records` row.

Both calls are wrapped in try/catch inside the helper module:
mirror failures only warn, they never block the apply enqueue or the
apply persist itself.

## Pool tenancy

- Helper file is `@db-pool-intent: worker` — the only callers run in
  worker context (`workerDb`) and the helper imports `workerDb`
  directly, matching every other write in
  `frontWebhookIngestion.ts`.
- `lint-db-pool-tenancy` and `lint-getdb-attribution` both pass.

## Kill switch

`front_sync_emails_mirror_enabled` in
`server/services/poolEpicKillSwitches.ts` — **default ON**. Flip to
`false` via:

```sql
INSERT INTO system_settings (key, value, updated_by)
VALUES ('front_sync_emails_mirror_enabled', 'false', NULL)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();
```

Cache refreshes within 60 seconds; no redeploy required.

When OFF, both helpers immediately return without touching the DB.

## The 17,805 pre-cutover `discovered` rows

These remain untouched. They are addressed by the existing
recovery-gap apply work documented in
[`docs/front-recovery-gap-finding.md`](./front-recovery-gap-finding.md) —
out of scope for this task. They do not affect the writer-restoration
deliverable: new webhook traffic will produce new rows starting at
deploy.

## Verification queries

Run against production 24h after deploy:

```sql
-- (1) New rows since cutover (should be >0 within 24h of real Front activity):
SELECT COUNT(*)::int AS new_rows
FROM front_sync_emails
WHERE created_at >= '2026-04-14 12:52:58'::timestamp;

-- (2) Pipeline-state distribution (expect `discovered` AND `applied`
-- to both be growing now, not frozen):
SELECT pipeline_state, COUNT(*)::int
FROM front_sync_emails
GROUP BY 1
ORDER BY 1;

-- (3) Newest row timestamp (sanity — should advance):
SELECT MAX(created_at), MAX(last_message_at), MAX(state_changed_at)
FROM front_sync_emails;
```

## Test coverage

[`tests/front-sync-email-mirror.test.ts`](../tests/front-sync-email-mirror.test.ts)
covers four cases:

- (a) New conversation → row inserted in `discovered` state.
- (b) Re-upsert: no duplicate row, `lastMessageAt` advances on newer
      payload and does NOT regress on older payload, `COALESCE`
      keeps prior values when new payload fields are null.
- (c) `markFrontSyncEmailMirrorApplied` transitions to `applied`
      and stamps `processedAt`.
- (d) Kill switch OFF → both helpers are no-ops.

## Files touched

- `server/services/frontSyncEmailMirror.ts` (new)
- `server/services/frontWebhookIngestion.ts` (imports + 4 wire-in sites)
- `server/services/poolEpicKillSwitches.ts` (1 new switch, default ON)
- `tests/front-sync-email-mirror.test.ts` (new)
- `docs/front-sync-emails-stall-2026-04-14-finding.md` (this finding)

---

# Task #2092 — decision: keep the re-wire, do **not** retire the mirror

**Status:** decided 2026-06-02. Closes the "re-wire or retire" question the
mirror has carried since the 2026-04-14 freeze.

## Context

Task #2092 was opened on the premise that `front_sync_emails` was *still*
frozen ("zero new rows since 2026-04-14, the only two inserters
`createFrontSyncEmail` / `upsertFrontSyncEmailWithVersion` are
code-orphaned"). That premise predates this finding's Remediation A
(Task #1831), which restored the writer through a **new** code path —
`server/services/frontSyncEmailMirror.ts` — rather than by reconnecting
the two legacy `communicationStorage.ts` inserters. Those two legacy
inserters are therefore *still* orphaned in production, but they are a
**red herring**: they are no longer the table's writer and the table is
no longer frozen. (`createFrontSyncEmail` retains a single consumer —
`tests/operational-rules-reattribute-e2e.test.ts` uses it to seed a row;
`upsertFrontSyncEmailWithVersion` has no caller at all. Both are left in
place: deleting them is unrelated storage-layer churn with no functional
benefit now that the mirror helper is the sole production writer.)

## Production verification (read-only prod replica, 2026-06-02)

| Check | Result |
| --- | --- |
| `front_sync_emails` total rows | **90,176** (was 17,805 at the freeze) |
| Newest `created_at` | **2026-06-02** (same day) — table is live, not frozen |
| Pipeline-state split | `applied` 88,328 · `discovered` 379 · `failed` 1,478 |
| Mirror `fetched` by month (live `front_sync_emails`) | 2026-01 5,426 · 02 6,577 · 03 7,903 · 04 4,687 · 05 8,047 |

The mirror is being written every day, both by the live webhook normalize
path and by the reconciliation path draining the historical backlog (rows
created today still carry late-April `last_message_at` values because the
normalize/apply pipeline is replaying the backlog roughly chronologically).

## Decision

**Re-wire (Remediation A) is the permanent answer. The mirror is NOT
retired.** Rationale:

1. It is already implemented, shipped, and verifiably self-sustaining in
   production — the Done criterion ("a new row appears from a real webhook
   within 24h of deploy") is met many times over.
2. Retiring would require migrating ~10 downstream readers
   (`operationalClassifier`, `frontSyncEmailTriage`, `frontPipelineMetrics`,
   `frontAutoClosure`, `frontPipelineStuckAlerts`, `frontBulkActions`,
   `healthDegradedTracker`, `frontAnalyticsCoverage`, the Communications and
   Integrations routes) off the table **plus** a one-off backfill into
   whatever replacement each adopts — a much larger blast radius for no
   functional gain now that the mirror is live.
3. The coverage `fetched` denominator
   (`frontAnalyticsCoverage.ts` → `countFetchedForMonth`, keyed on
   `front_sync_emails.last_message_at`) again reads a live table, so the
   "coverage math is increasingly stale" concern that motivated the task is
   resolved for current months going forward.

## Out-of-scope observations (NOT fixed here)

These surfaced during verification, are unrelated to the mirror decision,
and are owned by existing mechanisms — recorded so a future reader does not
re-open this question on their account:

- **Historical coverage cache lag.** `front_analytics_monthly_coverage`
  rows for 2026-01..04 were last pulled 2026-05-20 (cached `fetched` 12 /
  860 / 4,179 / 1,858) — *before* the mirror finished backfilling those
  months, so they undercount the now-complete live mirror. This is the
  intentional finalized-month-skip cadence (de-cadenced under Task #1787),
  not a mirror defect; a one-time operator recompute would reconcile them.
- **Normalize/apply backlog.** Front webhooks are arriving in June
  (`source_event_log` shows 11k on 2026-06-01, 681 on 2026-06-02, a 53k
  recovery spike on 2026-05-29) but `raw_communication_records` /
  `front_sync_emails` top out at 2026-05-29 — the pipeline is still draining
  the backlog. This is a Front recovery-throughput concern (Tasks
  #1730 / #1963 / self-heal warp), not a mirror writer concern.

## Closing note — frozen "Last successful sync" dashboards retired (Task #2413)

The frozen `front_sync_cursor` / `front_last_sync_success` settings called out
in *Observed symptom* above had a second, cosmetic consequence even after the
mirror writer was restored: the Integrations-Hub Front card and the Pipeline
Health tab still sourced their "Last successful sync" / "cursor freshness"
displays from those dead settings, so a perfectly healthy webhook-driven Front
integration permanently *looked* stale-since-2026-04-14.

Task #2413 re-sources those dashboards to a **live heartbeat**: the most-recent
Front webhook landed in `source_event_log` (`source_system = 'front'`, indexed
by `sel_received_at_idx` / `sel_source_system_idx`).

- `getSyncMetadata().lastSuccess` (used by both Front status surfaces) now comes
  from `getLastFrontWebhookActivityAt()` — `MAX(received_at)` of the Front rows.
- `frontPipelineMetrics.getPipelineMetrics()` cursor-freshness fields derive
  from the same heartbeat; `pageTokenActive` is now permanently `false` (the
  page-token concept belonged to the retired pull loop).
- The dead settings (`front_sync_cursor`, `front_sync_page_token`,
  `front_last_sync_success`) are **no longer read** anywhere and are marked
  *retired* in the Env Var / System Setting index (`audits/G-docs-findings.md`
  § 4). Historical rows may linger; nothing reads or writes them.
- The orphaned `upsertFrontSyncEmailWithVersion` inserter (a remnant of the
  retired pull loop, with no callers) was removed from `IStorage` and
  `communicationStorage.ts`. The live mirror writer (`createFrontSyncEmail` /
  `frontSyncEmailMirror.ts`) is untouched.

The heartbeat can only ever advance with real Front activity and freezes at the
genuine last-activity time when Front goes quiet or auth dies — it can never be
a value that only ever goes stale. Covered by
`tests/front-sync-metadata-heartbeat.test.ts`.
