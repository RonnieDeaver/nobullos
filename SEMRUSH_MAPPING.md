# SEMrush Location Mapping

Operator runbook for the canonical `semrush_location_campaigns` mapping path. Shipped under **Task #920A–E**.

## Overview

Every `semrush_location_campaigns` row goes through one canonical helper — `applySemrushLocationMapping` — so the auto-match endpoint, inventory apply handler, and local-dominance sync share one code path.

## Why this is a deliberate exception to Task #755

The Import Write Policy (Task #755 — "imports never create authoritative entities") classifies these mapping rows as **links** between two already-authoritative entities (a configured `client_locations` row and a SEMrush campaign), not as new authoritative entities. So:

- When the parent `(clientId, locationId)` pair is **configured**, the helper writes the link directly (`allow_link_existing`).
- When the parent is **unconfigured**, the candidate is queued in `import_entity_suggestions` for operator review.

See `server/services/importWritePolicy.ts` for the full decision table.

## Guarantees

- Stale rows are never auto-revived.
- Concurrent writes are serialized by the `(clientId, locationId, semrushCampaignId)` unique index.

## Cleanup script

`scripts/promote-semrush-configured-mapping-suggestions.ts` — one-off cleanup that drained pre-#920A suggestions stuck in the queue.

## Verification

```sql
-- Mapping rows should always be written by the canonical helper (audited via source column).
SELECT source, count(*) FROM semrush_location_campaigns GROUP BY source;

-- Suggestions still queued for operator review:
SELECT count(*) FROM import_entity_suggestions
WHERE suggestion_type = 'semrush_location_campaign';
```

## Keywords / grep anchors

`applySemrushLocationMapping`, `semrush_location_campaigns`, `import_entity_suggestions`, `allow_link_existing`, `semrush_heatmap_apply`, `promote-semrush-configured-mapping-suggestions`, `server/services/importWritePolicy.ts`.

## Related Task # history

- **Task #755** — broader "imports never create authoritative entities" policy that this mapping path is a narrow exception to.
- **Task #920A–E** — canonical helper + decision table + cleanup script.

## Task #1785 cross-reference

Mapping-write paths are unchanged. The Task #1785 demand-driven cadence
adds a `semrush_heatmap_apply` suppression layer (identical-result
hashing) that runs **before** the apply enqueue; once the apply runs,
`applySemrushLocationMapping` behaviour is identical to before. See
`SEMRUSH_CADENCE.md` for the gate / hash / active-client model.

## Stale-partial re-run + false-failure fix (Task #2265)

This task stops SEMrush location sync from showing **false `failed` pills**
and adds an idempotent way to re-drive locations that are stuck stale.

### 1. Token wipes only on authoritative refresh failure

`semrushApi.ts` routes refresh through `withSingleFlightOAuthRefresh` (Task
#1975). The terminal token wipe now fires **only** when the refresh was
triggered by an authoritative caller (a real sync that needs the token). A
**probe** or **proactive** (pre-expiry) refresh that terminally fails returns
`unauthorized` to its caller **without clearing the stored SEMrush tokens**, so
a background health check or proactive top-up can no longer disconnect a
still-valid integration. The auth-dead breaker still trips on a genuinely
revoked token; the probe bypasses and resets it.

### 2. Mid-sweep auth gap → `paused_auth`, not `failed`

In `localDominanceSyncWorker.ts`, a per-location failure whose classified
cause is an **auth/config gap** (missing OAuth mid-sweep) now calls
`markPausedAuth({ resetAttempts: true })` and reports `terminalStatus:
"paused_auth"` instead of `failed`. Consequences:

- **No burned attempt** — `attemptCount` is reset, so a transient auth gap
  does not march a location toward a permanent failure.
- The consumer loop counts `pausedAuth` **separately** from `failed`, so the
  Integrations Hub surfaces a *paused* state, not a red failure pill.
- The pause **auto-clears on the next healthy sweep** (existing behaviour) once
  OAuth is restored — no operator action required.

`semrushLocationSyncState.ts` exposes `markPausedAuth({ resetAttempts? })` and
`listStalePartialAndPausedAuth(staleBeforeMs, now?)`.

### 3. One-press re-run prod-action `rerun_stale_semrush_partials`

A worker-pool, background-drain CEO prod-action (`prodActionsRegistry.ts`)
re-drives every location stuck in `partial` or `paused_auth` past the staleness
cutoff. It is:

- **Breaker-aware** — skips when `semrushAuthBreakerActive` (reports `blocked`),
  and honours `semrushCircuitBreaker.shouldAllowRequest({ isManual: true })`.
- **Idempotent** — `resetForManualRetry` then
  `syncSingleClient({ origin: "scheduled_background", restrictToLocationId })`;
  re-running re-counts only rows that are still stale.
- **Self-healing** — `selfHeal { cadenceMs: 60min, backoffMs: 6h }`, so the CEO
  no longer has to re-run it by hand.

### 4. Quiet top-competitors `reportDate` 400

`heatmapService.ts` / `competitorLocationBackfill.ts`: when the dateless
top-competitors retry **also** returns a 400, treat it as benign no-data
(`competitors = []`, converge via the normal `done`/attempted path) and log at
info level rather than `warn`. `isTerminalSemrushFetchError` still only treats a
400 as terminal when the message contains `invalid value for 'reportDate'`.

## Competitor backfill transient-failure convergence (Task #2434)

The two competitor backfill prod-actions —
`backfill_competitor_location_labels` (GBP URLs, #2017,
`competitorLocationBackfill.ts`) and `backfill_competitor_structured_location`
(locality/street, #2052, `competitorStructuredLocationBackfill.ts`) — are
idempotent and re-run on every self-heal tick. Before #2434 a snapshot whose
campaign kept failing **transiently** (campaign-specific `fetch_failed` /
`campaign_backoff`) was never stamped attempted, so it was re-counted as a
remaining candidate forever and the action never settled to "not needed".

Fix: a snapshot's still-NULL rows are now only stamped terminal once a
**transient failure is provably unrecoverable**, via two exits in
`convergeTransientFailure` (apply mode only):

1. **Proven gone** — `isCampaignResolvable(campaignId)` (built from the
   campaign metadata cache via `createCampaignResolvableResolver`) returns
   `false` ⇒ the campaign no longer exists, so stamp at once **without**
   spending the retry budget.
2. **Bounded retry budget** — otherwise increment the row's
   `gbp_url_backfill_retry_count` / `structured_location_backfill_retry_count`
   by one; once any candidate row reaches `BACKFILL_TRANSIENT_RETRY_BUDGET`
   (`3`, exported from `competitorLocationBackfill.ts` and reused by the
   structured sibling) the snapshot is stamped attempted (terminal).

Below the budget the row stays a candidate (still re-tried next tick).
**Global** outage outcomes (`circuit_open` / `rate_limited`) are NOT
campaign-specific, so they never stamp and never burn the budget — the drain
just stops and re-tries the whole batch later. A successful fetch with no
name-match still stamps immediately (unchanged), and any later real SEMrush
ingestion that learns the value writes it at write time, independent of this
path. Regression coverage:
`tests/competitor-backfill-converge.test.ts` and
`tests/competitor-structured-location-backfill-converge.test.ts`.

## Competitor location backfill family (Tasks #2017 / #2052 / #2357)

Three idempotent, breaker-aware backfills re-fetch SEMrush top-competitors and
fill/repair competitor location data on `heatmap_competitor_snapshots`. Each
ships as a CLI (dry-run by default) and a self-healing CEO prod-action:

- **GBP-URL location labels (Task #2017)** —
  `server/services/competitorLocationBackfill.ts`, prod-action
  `backfill_competitor_location_labels`. Leaderboard location labels derive at
  read-time from `competitor_gbp_url`; historical rows with NULL urls show no
  disambiguator. Fills NULLs by normalized-name match.
- **Structured locality/street (Task #2052)** —
  `competitorStructuredLocationBackfill.ts`, prod-action
  `backfill_competitor_structured_location`. Fills structured
  `competitor_locality` / `competitor_street` (columns added by #2020) for
  pre-#2020 BOTH-NULL rows, parsing `address` via `parseCompetitorAddress`,
  writing WHERE both NULL, stamping `structured_location_backfill_attempted_at`.
- **Locality RELABEL (Task #2357)** —
  `competitorLocalityRelabelBackfill.ts`, prod-action
  `backfill_competitor_locality_relabel`. Re-corrects an already-NON-NULL
  `competitor_locality` that an OLD parse stored as a region/postal token (e.g.
  "NSW 2000", an Eircode) before #2291's rules; #2052 only writes BOTH-NULL rows
  so never fixes these. Finds suspects via `isRegionOrZipToken`, re-parses
  `address`, overwrites the locality (usually to NULL) where it differs, stamping
  `competitor_locality_relabel_attempted_at`.

See the transient-failure convergence section above (Task #2434) for how these
stamp terminal on provably-unreachable work.

## June 2026 global-disconnect post-mortem and hardening (Task #2877)

### Timeline

| UTC | Event |
|-----|-------|
| 2026-06-26 ~22:25 | SEMrush stored tokens (`semrush_access_token`, `semrush_refresh_token`) wiped by an authoritative `onTerminalAfterRetry` call |
| 2026-06-26 ~22:25 | All `client_semrush_integrations` rows flipped to `paused_auth`; Local-Dominance sweep silently no-ops on every cycle |
| 2026-07-15 | Outage discovered manually — no alerting existed for a global SEMrush disconnect |

**Total silent outage: ~19 days.**

### Attribution

No operator disconnect action is recorded near 2026-06-26 22:25 UTC, ruling out an intentional manual revocation. The wipe was system-initiated.  Two plausible causes (indistinguishable post-hoc without cross-instance log correlation):

1. **Rotation-race loser** — two autoscale instances raced a token refresh simultaneously. The loser's `onTerminalAfterRetry` fired when the winner's freshly-rotated token was already in the store.  The prior `terminalRotationRecheck` (3×100ms = 300ms) may not have given enough time for the winner's `setSystemSetting` DB write to land.

2. **Genuine SEMrush revocation** — SEMrush revoked the refresh token (device-flow tokens can be revoked by the user or expire out-of-band). The authoritative refresh rightly wiped a dead credential; recovery required operator re-authorization.

Either way the outcome was identical: zero alerting, three weeks of no SEMrush data.

### Hardening delivered

| Hardening | File | Details |
|-----------|------|---------|
| Final wipe-confirmation re-read | `semrushApi.ts` `onTerminalAfterRetry` | Before wiping, capture a fingerprint of the refresh token that was last tried (`lastTriedRefreshFp`). In `onTerminalAfterRetry`, do ONE authoritative `getSystemSettingFresh` re-read and compare fingerprints. If the stored token fingerprint **changed**, a sibling just rotated it — abort the wipe (`outcome=wipe_aborted`). Only an **unchanged** (still-dead) token fingerprint triggers the wipe. |
| Once-per-streak global-disconnect alert | `semrushDisconnectAlert.ts` | Fires via `notifyByType("integration.semrush.auth_or_circuit_open")` whenever the sweep's auth gate short-circuits and the breaker/absence has persisted beyond a 30-minute grace window. Deduplication via the dispatcher health-state machine; re-arms via `onSemrushAuthRestored` on recovery. |
| Stuck `in_progress` row sweep | `semrushLocationSyncState.ts` `sweepStuckInProgress` | Promotes rows stuck in `in_progress` for >4h to `failed/timeout` so they re-enter the retry cycle after a crash/SIGKILL. Called at the top of every sweep. |
| Notification registry activated | `notifications/registry.ts` | `integration.semrush.auth_or_circuit_open` flipped `implemented: true`. |

### Recovery procedure

1. Re-authorize SEMrush in **Settings → Integrations Hub**.
2. The next sweep run automatically calls `recoverPausedAuthRows()`, which clears all `paused_auth` state rows and integration rows.
3. `onSemrushAuthRestored` re-arms the alert streak so the next disconnect re-alerts immediately.
4. No manual SQL required for standard auth recovery.

For a genuine credential revocation, the operator must complete step 1 first; recovery is not automatic.

## SEMrush partials & auth-pause (Task #1877)

Sweep-level `paused_auth` short-circuit when OAuth is missing (no per-client
failure inflation); keyword-level retry preserving the exact `reportDate`;
tunable `semrush_keyword_inventory_max_pages` caps the keyword-inventory page
walk. This complements the Task #2265 false-failure fix above.
