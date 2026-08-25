# DB Health Operator Runbook (913F)

This runbook is the on-call reference for the DB-health observability stack
delivered by tasks 913A–E. It covers what each signal means, how to act on
it, and what to check first when DB health "looks wrong".

The full architectural background lives in:

- `.local/tasks/db-health-913a-discovery.md` — discovery & baseline
- `.local/tasks/db-health-913b-sampler-supervision.md` — supervised samplers
- `.local/tasks/db-health-913c-attribution.md` — pool-hold attribution
- `.local/tasks/db-health-913d-incident-lifecycle.md` — incident lifecycle
- `.local/tasks/db-health-913e-admin-ui.md` — admin UI

---

## 1. The moving parts

| Component | Source | What it does |
|-----------|--------|--------------|
| `health_samples` writer | `server/services/healthMetrics.ts` (run under `supervisedSampler`) | One row per probe tick: DB round-trip, API-pool wait, probe connect, status, alerts. |
| `pool_state_samples` writer | `server/services/poolStateSampler.ts` (supervised) | Per-pool snapshot: total/idle/waiting, utilization, slow-acquire/hold counters, top hold labels, `unknown_label_pct`. |
| Supervised-sampler watchdog | `server/services/supervisedSampler.ts` (`startSamplerWatchdog`) | Polls each sampler's `freshnessProbe` every 60s. Raises a `health_sampler_stalled` incident if the destination table hasn't progressed within `maxStalenessMs`. |
| Incident lifecycle engine | `server/services/healthIncidents.ts` | `firing → acknowledged → resolved` (terminal). Auto-resolver runs every 60s. |
| Daily rollups | `server/services/healthRollups.ts` → `health_daily_rollups` | One row per (metric, date). Source of truth for trend dashboards and the daily Slack digest. |
| Admin surface | `/api/health/*` (see §5) | All operator actions and queries. |

---

## 2. "Sampler stalled" — what it means and how to act

### What it means
The watchdog has detected that a supervised sampler hasn't produced a fresh
row in its destination table for longer than `maxStalenessMs` (default
`intervalMs * 4`). It raises an incident with:

- `metric = health_sampler_stalled`
- `severity = critical`
- `fingerprint = health_sampler_stalled:critical:<sampler-name>`

This was the original 913A symptom: `health_samples` stopped writing for ~17h
while `pool_state_samples` kept ticking. With supervision in place, a single
failed tick can no longer kill a loop — but the watchdog still fires when
the table itself stops progressing (DB outage, schema drift, persistent
exception inside the tick body).

### How to act
1. `GET /api/health/samplers` — find the unhealthy entry. Inspect
   `lastTickFailedAt`, `lastErrorSummary`, `consecutiveFailures`,
   `lastFreshnessAt`.
2. If `lastErrorSummary` shows a real exception → fix the underlying error.
   The supervised loop will recover on the next tick; no manual restart is
   needed.
3. If ticks are succeeding but `lastFreshnessAt` is still stale → the writer
   ran but produced no rows. Check the destination table's bootstrap (see
   `server/routes.ts` startup-bootstrap chain) and DB permissions.
4. The watchdog auto-clears the incident as soon as the freshness probe
   reports a fresh value. You should not need to manually resolve it.
5. If the incident lingers after sampling has resumed (>5 min — see
   `STALE_MAX_AGE_BY_METRIC[health_sampler_stalled]`), the auto-resolver
   will close it on its next sweep. Force a manual resolve via
   `POST /api/health/incidents/:id/resolve` only as a last resort.

---

## 3. Reading the `unknown`-hold ratio

The pool-hold attribution metric tells you what fraction of DB checkouts on
each pool resolved with the literal label `unknown` — i.e. the checkout
happened outside any `withDbAttribution(label, fn)` scope and we cannot
say which route/worker was holding the connection.

### Where to look
- `GET /api/health/db-attribution` — per-pool `totalHolds`, `attributedHolds`,
  `unknownHolds`, `unknownPct`, `uniqueLabels`.
- `GET /api/health/pool-state?since=<epochMs>` — per-sample `unknownLabelPct`
  and `topHoldLabels`.
- `pool_state_samples.unknown_label_pct` is also tracked in DB for trend
  analysis.

### Interpretation
- **< 5%** → healthy. The dominant `topHoldLabels` should be real
  `route:METHOD path` / `worker:<name>` / `scheduler:<name>` /
  `startup:<phase>` / `middleware:<name>` / `maintenance:<task>` strings
  (see the canonical contract in `server/db.ts` near `withDbAttribution`).
- **5–20%** → attribution drift. Some new code path is doing DB I/O
  outside any scope. Compare `topHoldLabels` against a known-good window
  to find what's new. Wrap the offending entrypoint in
  `withDbAttribution(...)` (or, for setInterval handlers, use
  `wrapTickWithAttribution`).
- **> 20%** → regression. Treat as a release blocker. The 913A baseline
  was ~99.99% unknown; we should never get back there.

### Why it matters
Without attribution, `pool_state_samples` becomes unactionable noise: you
see that the pool is busy but cannot tell which code path is responsible.
Every new DB-touching surface MUST have an attribution scope at its entry
point — Express routes get this from middleware automatically; workers,
schedulers, startup tasks, and maintenance sweeps must add it explicitly.

---

## 4. Incident lifecycle: when to acknowledge vs. resolve

Canonical statuses (913D):

```
firing  ──ack──▶ acknowledged ──resolve──▶ resolved (terminal)
   │                  │                       ▲
   └─── resolve ──────┴───────────────────────┘
```

`snoozed` is **not** a status — it is `acknowledged` with a `snoozedUntil`
timestamp. When the snooze window passes, the next matching firing alert
re-arms the incident back to `firing`.

### When to acknowledge
- You have seen the incident, you understand it, and you intend to fix
  the root cause but it does not need to wake anyone else.
- You're in the middle of mitigating and don't want the digest/UI to
  keep paging you.
- Use snooze when you want it suppressed for a known window (e.g. "this
  vendor outage will resolve in 30 min").

`POST /api/health/incidents/:id/ack` (no body)
`POST /api/health/incidents/:id/snooze` with body `{ "minutes": <5..1440> }`
(default 60). The server computes the absolute `snoozedUntil` from `minutes`
— callers do not pass an absolute timestamp.

Acknowledge is idempotent — repeated calls are safe.

### When to resolve
- The underlying condition is gone AND you want to immediately close the
  incident rather than wait for the auto-resolver.
- You're cleaning up a stuck legacy row.

`POST /api/health/incidents/:id/resolve`

Resolve is idempotent and terminal. **Do not** resolve an incident whose
condition is still active — a fresh sample will create a *new* incident
with a new `first_seen_at` (see the dedup rule below), losing continuity.

### Auto-resolver
Runs every 60s (`startIncidentAutoResolver`). An open incident is
auto-resolved when EITHER:
- `now - last_seen_at >= RESOLVE_AFTER_QUIET_MS` (10 min), OR
- `now - last_seen_at >= staleMaxAgeFor(metric)` (per-metric class; see
  `STALE_MAX_AGE_BY_METRIC` — `db_latency`/`consecutive_db_failures` =
  15 min, `health_sampler_stalled` = 5 min, default = 1 hour).

The on-boot sweep also normalizes any pre-913D `status='snoozed'` rows
to `acknowledged` (preserving `snoozed_until`) and immediately resolves
anything stale.

---

## 5. Dedup / reopen rule (from 913D — DO NOT change without an ADR)

> **Once an incident is `resolved`, it is terminal. A subsequent matching
> fingerprint always creates a NEW incident — never reopens the resolved
> one.**

Implementation: `findIncidentByFingerprint` in
`server/storage/healthMetricsStorage.ts` only matches `firing` or
`acknowledged` rows. `ingestAlert` therefore inserts a fresh row when
the only existing match is `resolved`.

Why: this keeps each incident's `first_seen_at` / `resolved_at` timeline
immutable, gives every new occurrence its own paging/digest scope, and
avoids the "incident has been firing for a week with 4 occurrences"
failure mode of the pre-913D model.

The reopen behavior that DOES exist is the **acknowledged + snooze
re-arm**: when an `acknowledged` incident's `snoozed_until` has passed
and a fresh sample matches the fingerprint, the row flips back to
`firing`. This is intentional and only applies *before* resolution.

---

## 6. Admin endpoints quick reference

All endpoints below require `isAuthenticated` + `requireTeamLead` unless
noted otherwise.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Public top-level liveness (DB / scheduler / workers / tables / rate limits). |
| `GET /api/health/history?since=<ms>` | Sample stream (persisted + in-memory unflushed). |
| `GET /api/health/overview` | Headline numbers for the admin dashboard. |
| `GET /api/health/freshness` | Latest write timestamp per signal. First thing to check if anything looks stale. |
| `GET /api/health/samplers` | Per-sampler runtime state from `getSupervisedSamplerStates()`. |
| `GET /api/health/pool-state?since=<ms>` | `pool_state_samples` slice incl. `topHoldLabels` and `unknownLabelPct`. |
| `GET /api/health/db-attribution` | Aggregate attribution quality (per-pool unknown%). |
| `GET /api/health/incidents?since=<ms>` | Returns `{ open, recent, since }`. `open` is `firing` + `acknowledged` (always returned in full); `recent` is everything with `last_seen_at >= since` (defaults to 7 days). There is no server-side `statuses` query — filter client-side from `open` if you need just `firing`. |
| `POST /api/health/incidents/:id/ack` | Acknowledge (idempotent). No body required. |
| `POST /api/health/incidents/:id/snooze` | Body: `{ "minutes": <5..1440> }` (default 60). Server computes `snoozedUntil = now + minutes*60_000` and sets `status=acknowledged` with `snoozedUntil`. Re-arms to `firing` on the next matching sample after the window passes. |
| `POST /api/health/incidents/:id/resolve` | Resolve (terminal, idempotent). No body required. |
| `GET /api/health/rollups?days=<1..90>` | Returns `{ days, series }` where `series` is the daily rollup rows for the last `days` days (default 30). No `since` query parameter. |
| `POST /api/health/flush` | Force-flush in-memory samples to DB. |
| `GET /api/health/flush-status` | Backlog and last flush timestamp. |

---

## 7. Triage checklist — "DB health looks wrong"

Run these in order. Stop as soon as one of them explains what you're seeing.

1. **Is the page itself stale?** `GET /api/health/freshness`.
   - `health_samples` last write > a few minutes old → go to step 2.
   - `pool_state_samples` last write > a few minutes old → same.
   - Both fresh → go to step 3.

2. **Is a sampler stalled?** `GET /api/health/samplers`.
   - Any `healthy: false` entry → that's your culprit. Read its
     `unhealthyReason` and `lastErrorSummary`. Fix the root cause; the
     supervised loop will recover on its own. The watchdog will
     auto-clear the `health_sampler_stalled` incident when freshness
     returns. (See §2.)
   - All healthy but freshness still stale → check the destination
     table's bootstrap (`server/routes.ts` startup chain) and DB
     permissions.

3. **Are pool samples telling a story you can read?**
   `GET /api/health/db-attribution` and the latest
   `GET /api/health/pool-state`.
   - `unknownPct > 20%` → attribution regression. New code path is
     doing DB I/O without `withDbAttribution(...)`. Fix it before
     spending more time on pool numbers — they're noise until labels
     come back. (See §3.)
   - Healthy attribution but high `utilizationPct` / `waitingCount` →
     `topHoldLabels` tells you who is holding connections. That's your
     real investigation target.

4. **Are there open incidents that should have auto-resolved?**
   `GET /api/health/incidents` (use the `open` array in the response — it
   already filters to `firing` + `acknowledged`).
   - Anything with `last_seen_at` older than its `staleMaxAgeFor`
     window AND still open → the auto-resolver isn't running. Check
     the `Start application` logs for
     `[HealthIncidents] auto-resolver tick failed` and
     `[HealthIncidents] startup sweep auto-resolved`. Restart the
     workflow if the loop is genuinely dead; otherwise wait one minute
     for the next sweep.
   - Incidents firing for the *current* condition → expected. Decide
     ack vs. resolve per §4.

5. **Did the daily rollup row land?** `GET /api/health/rollups?days=2`.
   - Missing today's row → `startHealthRollups` either didn't run or
     errored. Logs prefixed `[HealthRollups]` / `[HealthDigest]`.

---

## 8. Post-deploy verification checklist (913F Step 1–4)

Run these once after each rollout that touches DB-health code. Capture
the numbers in the deploy ticket so the next 913-class regression has
a clean baseline to compare against.

### Sampler verification (913F.1)
- [ ] `health_samples` MAX(timestamp) < 2× sample interval old.
- [ ] `pool_state_samples` MAX(sampled_at) < 2× sample interval old.
- [ ] `GET /api/health/samplers`: every entry `running: true`,
      `healthy: true`, `consecutiveFailures: 0`.
- [ ] No new `health_sampler_stalled` incidents created in the
      post-deploy window.

### Incident verification (913F.2)
- [ ] Look up the legacy `db_latency:warning:probe` incident **by
      fingerprint, never by hard-coded ID** — IDs change across
      environments and over time. Run:
      ```sql
      SELECT id, status, occurrence_count,
             EXTRACT(EPOCH FROM NOW())*1000 - last_seen_at AS age_ms,
             resolved_at
        FROM health_incidents
       WHERE fingerprint = 'db_latency:warning:probe';
      ```
      Then apply this rule:
      - If `status='resolved'` → criterion satisfied.
      - If `status IN ('firing','acknowledged')` AND
        `age_ms < 900000` (15 min) → **DO NOT manually resolve**.
        The 913D resolver is correctly holding the row open because
        the underlying `db_latency` condition is still firing.
        Treat as a performance/owner follow-up.
      - If `status IN ('firing','acknowledged')` AND
        `age_ms >= 900000` AND the auto-resolver has not closed it
        within one tick (60 s) → investigate the resolver loop
        (look for `[IncidentAutoResolver]` log lines); only then,
        and only after confirming the metric is genuinely quiet,
        force-close with
        `POST /api/health/incidents/<id-from-query-above>/resolve`.
- [ ] No legacy `status='snoozed'` rows remain (the boot normalizer
      converts them to `acknowledged`).
- [ ] If safe, simulate a benign condition (e.g. point a dev probe at
      a slow endpoint), confirm the incident fires, ack it via
      `POST .../ack`, clear the condition, and confirm the
      auto-resolver closes it within the metric's `staleMaxAgeFor`
      window.

### Attribution verification (913F.3)
- [ ] `GET /api/health/db-attribution`: per-pool `unknownPct` is
      meaningfully lower than the 913A baseline (~99.99%). Target
      < 5% on both pools.
- [ ] `GET /api/health/pool-state` over a 30-min window: top
      `topHoldLabels` are real `route:` / `worker:` / `scheduler:` /
      `startup:` / `middleware:` / `maintenance:` strings — not
      `unknown`.

### Health-metric correctness (913F.4)
- [ ] `GET /api/health/overview` returns sane numbers (no NaN, no
      missing fields, latency bands within historical range).
- [ ] `GET /api/health/history?since=<deploy-time>` is a continuous
      series with no gaps > 2× interval.
- [ ] `GET /api/health/rollups?days=2` shows yesterday's and (after
      midnight UTC) today's row with non-zero `sample_count`.

---

## 9. Glossary

- **Attribution scope** — an `AsyncLocalStorage` frame established by
  `withDbAttribution(label, fn)` (or `withDbHoldLabel`, an alias) that
  tags every DB checkout inside it with `label`. Express middleware
  installs one per request; workers/schedulers/startup tasks must add
  their own.
- **Fingerprint** — `${metric}:${severity}:${origin}` (256 char cap).
  Determines incident grouping. Two firings with the same fingerprint
  coalesce into one open incident; once resolved, the next firing
  creates a new incident.
- **Freshness probe** — function passed to `startSupervisedSampler`
  that returns the most-recent timestamp known-written by the loop.
  Drives the watchdog's stall detection.
- **Quiet window** — `RESOLVE_AFTER_QUIET_MS` (10 min). Time since
  `last_seen_at` after which the auto-resolver closes an incident
  even if no per-metric stale rule applies.
- **Stale max age** — per-metric class threshold from
  `STALE_MAX_AGE_BY_METRIC`. Force-closes an incident whose underlying
  signal has gone silent entirely (the original 913A failure mode).
