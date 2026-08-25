# Database Optimization Playbook

A replication playbook distilled from the database-performance work in **NoBull OS** (a Node.js + Express + TypeScript + Drizzle + PostgreSQL app deployed on Replit `autoscale`). It is written so you can hand it to a *different* Replit project and re-apply the patterns without re-deriving them.

Every section follows the same shape:

- **Problem** — the failure mode that motivated the work.
- **Mechanism** — what was actually built.
- **Enforcement / guard** — the lint, test, alert, or runbook that keeps it from regressing.
- **Generic replication** — how to apply it in another project, with **portable** vs **NoBull-specific** called out explicitly.

Everything here is synthesized from shipped code, runbooks (`replit.md`, `RUNBOOKS.md`, `WORKERS_QUEUES_RUNBOOK.md`, `EXTERNAL_CALL_AUDIT.md`, `PG_STAT_STATEMENTS_REGRESSION.md`), and the source files cited inline. Task numbers (e.g. *Task #818*) are references to NoBull's internal task tracker and describe the behavior that shipped — they are pointers for *our* history, not something a different project needs to reproduce.

> **Runtime baseline (NoBull-specific, for grounding the numbers below):** dev workspace runs on Replit-managed Helium Postgres; deployed production runs on Neon Postgres. Driver is `pg` (node-postgres) in both. Deploy target is `autoscale` (multiple instances). Pool sizes: `api` max 18, `worker` max 10, `probe` max 1. When you replicate this, your absolute numbers will differ — what ports is the *structure and the ratios*, not the literal caps.

---

## Table of contents

1. [Three-pool architecture (api / worker / probe) + sizing](#1-three-pool-architecture-api--worker--probe--sizing)
2. [Connection attribution (who is holding a connection?)](#2-connection-attribution-who-is-holding-a-connection)
3. [DB hold-window rules (10s / 30s) + batch-vs-per-row](#3-db-hold-window-rules-10s--30s--batch-vs-per-row)
4. [Work queue: FOR UPDATE SKIP LOCKED + lease heartbeats + graceful shutdown](#4-work-queue-for-update-skip-locked--lease-heartbeats--graceful-shutdown)
5. [Cross-instance advisory-lock singletons](#5-cross-instance-advisory-lock-singletons)
6. [Safe array bindings helper](#6-safe-array-bindings-helper)
7. [pg_stat_statements nightly regression scan](#7-pg_stat_statements-nightly-regression-scan)
8. [External-call audit (no network I/O inside a DB hold)](#8-external-call-audit-no-network-io-inside-a-db-hold)
9. [Query-budget harness](#9-query-budget-harness)
10. [Staggered worker startup](#10-staggered-worker-startup)
11. [Backoff, kill switches, and workload control](#11-backoff-kill-switches-and-workload-control)
12. [Connection max-lifetime recycling](#12-connection-max-lifetime-recycling)
13. [Scale layer: Redis cache + PgBouncer pooled connections](#13-scale-layer-redis-cache--pgbouncer-pooled-connections)
14. [Replication checklist (do this in order)](#14-replication-checklist-do-this-in-order)

---

## 1. Three-pool architecture (api / worker / probe) + sizing

### Problem
A single shared connection pool means background work and user requests compete for the same connections. When a backfill, a reprocess sweep, or an ingestion burst grabs connections, user-facing API requests queue behind them — latency spikes and, in the worst case, the health probe itself can't get a connection to report that anything is wrong. A single number (`pool.max`) cannot express "users always come first."

### Mechanism
Split one logical database into **three pools with non-overlapping tenants**, each sized for its job (NoBull values in `server/perfConfig.ts` and `server/db.ts`):

| Pool | Max conns | Tenant (who may use it) | Lifetime |
| --- | --- | --- | --- |
| `api` | 18 | **only** request handlers (`server/routes/*`). Import the request-scoped `db`. | request-scoped (acquire, query, release fast) |
| `worker` | 10 | background work: workers, schedulers, `setInterval` timers, maintenance sweeps, auto-heal, enrichment, rollups, and any worker-context notification. Import `workerDb` or wrap in `runWithWorkerDb(...)`. | job-scoped, may be longer |
| `probe` | 1 | **only** the periodic health probe and code that intentionally measures pool-acquire latency. Nothing else. | one warm connection |

The point is **isolation**: a saturated `worker` pool cannot starve the `api` pool, and the `probe` pool's single connection always answers "how long does it take to get a connection right now?" because nothing else competes for it.

NoBull additionally caps total *background concurrency* below the `worker` pool size: the global scheduler slot cap is 9 (`RETROACTIVE_REPROCESS_CONCURRENCY` 6 + 3 reserve), leaving ≥1 worker connection spare for non-slot operations. That gap matters — **never let your concurrency budget equal your pool size**, or a single extra query (a heartbeat, a metrics flush) has nowhere to run.

### Enforcement / guard
- **Documented tenancy contract** in the *Audit Surface Runbook* in `RUNBOOKS.md` (canonical home; `replit.md` § "DB Pool Tenancy Rules" is a one-line pointer). Shared helpers must accept an explicit DB handle/context; the default must be documented; exceptions must record *why, hold duration, owner, monitoring label, review date*.
- A planned `lint-db-pool-tenancy` guard (Phase 4 of the pool epic) trips on undocumented cross-tenant usage. Source files carry `// @db-pool-intent: worker` markers so a scanner can verify intent.
- **Source-of-truth rule:** the Runtime Truth Table in `replit.md` wins over prose if a pool size is quoted in two places. Pick one canonical location for the numbers.

### Generic replication
- **Portable:** the three-role split (request / background / probe) and the rule "background can never starve user-facing." This is the single highest-leverage change. Even two pools (api + worker) captures most of the benefit; the probe pool is what makes saturation *observable*.
- **Portable:** size pools by role, and keep background concurrency strictly below the background pool size.
- **NoBull-specific:** the exact caps (18 / 10 / 1), the workload-class sub-budgets, and the `@db-pool-intent` markers. Start with caps that sum well under your provider's connection limit (Neon/Helium/managed PG all cap total connections), then tune from telemetry.
- **Watch-out:** if you later route a pool through a transaction-mode pooler (PgBouncer — see §13), pools that hold session state (advisory locks, `LISTEN/NOTIFY`, long transactions) **must** stay on a direct connection. The three-pool split makes this clean: only the stateless `api` pool is a candidate for pooling.

---

## 2. Connection attribution (who is holding a connection?)

### Problem
"The pool is saturated" is useless on its own. You need "the pool is saturated *because* `GET /api/clients/:id` is holding 12 connections" or "because the Front ingestion worker is holding them." Without attribution, pool incidents are unactionable — you see the symptom (waiters) but not the cause.

### Mechanism (NoBull: `server/db.ts`, Tasks #818 / #836 / #913C)
Wrap every DB checkout in an **attribution scope** carried through Node's `AsyncLocalStorage`, then record per-label hold statistics:

1. `withDbAttribution(label, fn)` (alias `withDbHoldLabel`) runs `fn` inside an async-local label ref. A pool wrapper reads the *current* label when a client is checked out and attributes the hold duration to it.
2. Labels use **structured namespaces** so they aggregate cleanly:
   - `route:<METHOD path>` — e.g. `route:GET /api/clients/:id`
   - `worker:<queue|name>` — background queue work
   - `scheduler:<name>` — scheduler-loop ticks
   - `startup:<phase>` — one-shot boot work
   - `middleware:<name>` — middleware that does DB I/O before route matching
   - `maintenance:<task>` — periodic sweeps
   - `unknown` / `unattributed:<pool>` — reserved fallback for "no scope at all."
3. A two-stage refinement (Task #836): an outer middleware installs a coarse fallback label at request entry (the normalized URL); an inner step refines it to the matched route pattern once routing resolves. Because the label is a **mutable ref** in the async context (not a copied string), the checkout always reads the most recent label.
4. Per-label rolling stats (count, total/avg/max ms, and a p95 from a bounded ring buffer) feed health endpoints. An **attribution-quality metric** reports the `unknown`-percentage per pool, so *missing attribution is itself a tracked regression* — you find out when you've stopped being able to see who's holding connections, before an incident.

### Enforcement / guard
- `lint-getdb-attribution` (Task #1724) catches DB access that bypasses an attribution scope.
- The `unknown_label_pct` metric is surfaced on the admin Health surface; a rising number means new code is checking out connections without a scope.

### Generic replication
- **Portable:** the `AsyncLocalStorage` label + structured namespaces + per-label hold stats. This is framework-agnostic — any Node app on `pg` can wrap `pool.connect`/`query`.
- **Portable:** the mutable-ref refinement trick (coarse-then-precise label) for web frameworks where the route pattern isn't known until after middleware runs.
- **Portable:** track `unknown%` as a first-class metric so attribution gaps are visible.
- **NoBull-specific:** the exact namespace taxonomy and the health-dashboard wiring. Adopt the namespaces you actually have (you may not have "scheduler" vs "maintenance" as distinct concepts).

---

## 3. DB hold-window rules (10s / 30s) + batch-vs-per-row

### Problem
A connection held open for a long time is a connection no one else can use. Two anti-patterns dominate: (a) doing slow non-DB work (an HTTP call, an AI request, geocoding) *while* holding a DB client, and (b) per-row loops that issue N round trips inside one logical operation. Both convert a fast pool into a saturated one.

### Mechanism (NoBull: `replit.md` "DB Hold Rules")
Two rules, enforced as norms:

1. **A hold window contains only DB work.** Never hold a DB client across an external HTTP call, an AI call, a reverse-geocode, an SSE broadcast, or a Slack enqueue. The pattern is **stage outside, re-enter for persistence**: do the slow/remote work *before* acquiring the client, then open a short hold purely to write the result.
2. **Keep holds short.** `>10s` warns; `>30s` raises a high-severity signal. Prefer **batch transactions over per-row loops** (one `INSERT ... VALUES (...), (...), ...` or one `UPDATE ... WHERE id = ANY(...)` instead of a loop of single-row writes).

These thresholds are observable because of the attribution layer (§2): a hold over the warn threshold is logged with its label, so you know *which* route or worker violated the rule.

### Enforcement / guard
- Per-label max-hold tracking (§2) surfaces the offending label automatically when a hold crosses 10s/30s.
- The external-call audit (§8) is the structural guard against "network I/O inside a hold."
- Code review + the runbook norm; batch helpers (§6) make the right thing easy.

### Generic replication
- **Portable:** both rules verbatim. "No remote I/O inside a DB hold" and "batch, don't loop" are universal. The 10s/30s thresholds are reasonable defaults for an interactive web app — tighten for low-latency APIs.
- **Portable:** the "stage outside, re-enter to persist" structure.
- **NoBull-specific:** the specific external systems enumerated (Front, Slack, Zoom, reverse-geocode). Substitute your own slow dependencies.

---

## 4. Work queue: FOR UPDATE SKIP LOCKED + lease heartbeats + graceful shutdown

### Problem
Background jobs need to run exactly once across multiple competing workers (and, on autoscale, multiple instances), survive crashes, retry on failure, and not be lost on deploy. A naive "SELECT a pending row, mark it running" race-conditions two workers onto the same row.

### Mechanism (NoBull: `work_queue` table; `server/services/workScheduler.ts`, `workQueueLease.ts`)
A Postgres-backed durable queue with three layers:

1. **Atomic claim with `FOR UPDATE SKIP LOCKED`.** A worker claims the next eligible row with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` inside a transaction, then stamps `status='leased'`, `lease_owner`, `leased_at`, `lease_expires_at`. `SKIP LOCKED` means concurrent workers each grab *different* rows without blocking — the database arbitrates, not application locks. This is the single most important primitive: it gives you a correct multi-consumer queue with no extra infrastructure.
2. **Lease + heartbeat.** A claimed row carries a lease that the handler **extends every heartbeat tick (~60s)**. Two independent reclaim conditions protect against stuck work:
   - the heartbeat **stops** extending the lease (the process died) → `lease_expires_at` passes → another worker reclaims it;
   - the heartbeat **keeps firing but the job is wedged** → a max-processing ceiling (`leased_at + maxProcessingMs < now()`, configurable per queue, default in `queueMaxProcessing.ts`, floor 30s) reclaims it anyway. A hung-but-heartbeating handler can't hold a row forever.
   Retries use `attempt_count` / `max_attempts` with a `retry_at` backoff; exhausted attempts go to a dead-letter terminal state.
3. **Graceful shutdown lease release (Task #1676; `server/index.ts` `gracefulShutdown` + `workScheduler.releaseInFlightLeasesOnShutdown`).** On `SIGTERM`/`SIGINT`, before exit: stop the scheduler, **stop all heartbeat timers** (so no late tick re-extends a lease you're about to drop), then `UPDATE work_queue SET status='pending', lease_owner=NULL, ... WHERE lease_owner = <this process> AND status IN ('leased','processing')`. The reset is **narrow** — only *this* process's rows, only still-leased ones — so a handler mid-await can't be clobbered (a terminal-write lease guard in the processor prevents that too).
   - **Why this matters on autoscale:** without it, every deploy/restart leaves in-flight rows owned by a now-dead process. On next boot they trip the stale-recovery path (~10 min later they're force-failed or reset), which on a frequently-redeploying autoscale fleet becomes the dominant source of queue "churn" noise. Releasing leases on the way out turns a deploy from a disruption into a no-op for the queue.

### Enforcement / guard
- A lease-churn alerts scheduler (`leaseChurnAlerts.ts`) watches for abnormal `startup_stale_recovery` / `stale_lease_exhaustion` rates — the metric that revealed the missing graceful-shutdown release in the first place.
- A reconciliation scheduler re-checks the queue against source-of-truth so a dropped event is eventually re-driven (webhook-first, reconcile-as-safety-net).
- See `WORKERS_QUEUES_RUNBOOK.md` for queue topology, drain controls, and the lease lifecycle.

### Generic replication
- **Portable (highest value):** `FOR UPDATE SKIP LOCKED` as your multi-consumer claim. If you have Postgres, you have a correct work queue — you usually do **not** need Redis/SQS/RabbitMQ for this. Lease + heartbeat + max-processing ceiling + retry/dead-letter are all portable.
- **Portable:** **release in-flight leases on SIGTERM.** Any containerized/autoscaled deploy benefits enormously; it's a small handler with a large payoff. Make sure your platform actually sends `SIGTERM` and gives you a grace period (Replit deployments do).
- **Portable:** the "two reclaim conditions" design — dead process (heartbeat stops) *and* wedged process (max-processing ceiling) are different failures and both need handling.
- **NoBull-specific:** the exact queue names, workload-class tagging, Front-pipeline reconciliation, and warp-speed fast-poll. Your queues and their SLAs will differ.

---

## 5. Cross-instance advisory-lock singletons

### Problem
On `autoscale`, almost every scheduler/worker boots on **every instance**. An in-process guard (a boolean, a `Set`, an in-memory lock map) only collapses concurrent runs *within one process*, so a "run-once" job guarded that way still runs **once per instance** — double-crawling external APIs, double-writing rollups, sending duplicate alerts.

### Mechanism (NoBull: `server/services/crossInstanceLock.ts`, Tasks #2363 / #2293 / #2383)
A Postgres **session-level advisory lock** as a cluster-wide singleton:

1. `pg_try_advisory_lock(namespace, key)` on a **dedicated pinned worker-pool connection**. Exactly one instance wins; others get `null` and skip. The lock is held for the whole critical section on that one pinned connection.
2. **Self-healing:** advisory locks are session-scoped, so if the winning instance crashes mid-run, Postgres drops the session and auto-releases the lock — a later run on any instance takes over. No external system, no stale-lock cleanup job.
3. **Namespacing:** the lock space is partitioned by *purpose* via an int4 namespace (e.g. one namespace for prod-action drains, another for run-once workers), so two unrelated subsystems that happen to hash the same name string can't collide. The key is a deterministic 32-bit hash of a stable job name.
4. **Hung-holder watchdog (Task #2383):** crash self-heals, but a job that merely *hangs* (an external call with no timeout) keeps its session — and its lock — alive forever. An optional `maxHoldMs` arms a watchdog timer that force-releases the lock after the ceiling so another instance can take over. Because the lock lives on a *dedicated* connection used only for lock/unlock (the job does its real DB work on separate connections), the watchdog's unlock query runs even while the job itself is wedged.
5. Ergonomic wrappers: `withWorkerSingletonLock(name, fn)` returns `{ ran: true, result }` or `{ ran: false }`.

> **Pinned-connection subtlety (portable):** the lock must be acquired and released on the **same** Postgres session, so you pin one `PoolClient` for the lock's whole life and never return it to the idle list mid-run. In NoBull this also dodges the connection max-lifetime sweep (§12) recycling the lock connection out from under the job.

### Enforcement / guard
- Watchdog fires a structured/observable alert (or `console.error` if no callback is wired) so a force-release is never silent.
- For **large** convergent cohorts, prefer a durable `work_queue` fan-out (§4) over a single serial advisory-lock drain — it parallelizes, survives recycling, and uses the queue scan for idempotency. The advisory lock is for *run-once*, not *do-a-lot-of-work-once*.

### Generic replication
- **Portable:** `pg_try_advisory_lock` for cluster-wide run-once. Any multi-instance deploy on Postgres should use this instead of in-process flags for crons/singletons. Namespacing + deterministic name hash + the crash self-heal are all portable.
- **Portable:** the hung-holder watchdog and the "lock on a dedicated connection" rule — without the dedicated connection, a wedged job blocks its own watchdog.
- **NoBull-specific:** the specific namespaces and the set of jobs that use it. Decide per-job whether run-once matters (most external-API crawls and rollups: yes).
- **Watch-out:** advisory locks require a **session** (direct connection), so a lock connection must never go through PgBouncer transaction mode (§13).

---

## 6. Safe array bindings helper

### Problem
The natural-looking pattern for "WHERE id in this JS array" with Drizzle's `sql` tag is a **trap**:

```ts
sql`... WHERE id = ANY(${jsArray}::text[])`   // ❌ broken
```

Drizzle binds a JS array as a single parameter that expands into a Postgres `record`, and `record::text[]` is illegal — Postgres rejects it with `cannot cast type record to text[]`. Historically this error got swallowed by callers' try/catch and **silently returned empty results** — the worst kind of bug, because the query "succeeds" with wrong data.

### Mechanism (NoBull: `server/utils/sqlArray.ts`, Task #733)
One canonical helper, `bindArrayParam(values, castType)`, that emits a literal array constructor with each element as its own bound parameter:

```ts
ANY(${bindArrayParam(values)})            // → ANY(ARRAY[$1, $2, $3]::text[])
ANY(${bindArrayParam(ids, "uuid")})       // typed
```

Pinned behaviors: empty array → `ARRAY[]::<type>[]` (Postgres needs the cast to know the element type on an empty array); `null` elements bind as SQL `NULL`, not the string `"null"`; the cast type is restricted to a small **allow-list** (`text | varchar | uuid | int | bigint | date`) so the cast slot can't be an injection vector.

### Enforcement / guard
- A dedicated test (`tests/sql-array-binding.test.ts`) pins every behavior above.
- The helper is documented as the *single* canonical way to bind an array, so the broken `ANY(${arr}::type[])` pattern has a clear replacement.

### Generic replication
- **Portable:** if you use Drizzle's `sql` tag (or any builder that flattens JS arrays into a record), build this helper on day one and forbid the raw pattern. The empty-array cast and null-handling are the two things people get wrong.
- **Portable:** the cast allow-list — never interpolate a caller-supplied type string into SQL.
- **NoBull-specific:** the exact set of allowed cast types. Add the ones your schema actually uses.

---

## 7. pg_stat_statements nightly regression scan

### Problem
Query performance degrades slowly and invisibly: an index gets dropped, a join changes shape, a hot query starts doing a seq scan. You don't notice until latency is already bad. You want an automated "did any query get meaningfully slower?" check.

### Mechanism (NoBull: `PG_STAT_STATEMENTS_REGRESSION.md`, Task #1814 / #1728)
Use Postgres's `pg_stat_statements` extension (per-query aggregate timing) and a **nightly scan** that compares current top queries against a baseline, flagging regressions (mean-time or call-count blowups).

Critical operational nuance NoBull learned the hard way (the **Replit Publish schema-diff direction**): Replit's deploy-time schema differ compares the *dev* database against the *prod* database. `pg_stat_statements` is a real extension (its catalog row + two extension-owned views) on prod, but the extension is non-functional on the Helium dev workspace. To stop the differ from "fixing" the mismatch by **dropping** the views from prod, NoBull deliberately **mirrors the catalog row and the two views on dev** so both sides match. Nothing on dev queries them; they exist purely to satisfy the differ.

### Enforcement / guard
- The nightly scan itself is the guard; a regression fires an alert.
- The Runtime Truth Table documents that the extension is in `shared_preload_libraries` on prod and mirrored (non-functional) on dev — so a future engineer doesn't "clean up" the dev views and silently break prod on the next publish.

### Generic replication
- **Portable:** enable `pg_stat_statements` and run a scheduled regression scan. This is standard Postgres practice and works on any host that allows the extension (most managed hosts do; it needs `shared_preload_libraries`, i.e. a config flag + restart).
- **Portable (Replit-specific but reusable):** the **publish-diff-direction lesson** — on Replit, any object created by raw SQL / startup code / an extension must exist in **dev** too, or the deploy differ drops it from prod. Mirror such objects on dev even if they're inert there.
- **NoBull-specific:** the Helium-dev / Neon-prod split that *causes* the mirror requirement. A project with the same DB engine in both environments may not need the mirror — but the diff-direction rule still applies to anything not in your migration files.

---

## 8. External-call audit (no network I/O inside a DB hold)

### Problem
The §3 rule "never hold a DB client across an external call" needs a *structural* guard, not just code review. You want to detect (and prove the absence of) network I/O happening while a DB connection is checked out — across the whole codebase, continuously.

### Mechanism (NoBull: `EXTERNAL_CALL_AUDIT.md`, Tasks #1724 / #1728)
A **hashes-only external-call audit**: instrument outbound calls and DB holds so the system can detect overlap (an external call beginning while a hold is open) and attribute it to a label (§2). "Hashes-only" means it records *fingerprints* of calls, not request bodies/URLs with secrets — the audit is safe to keep on in production.

Paired observability: hourly DB-hold rollups and an admin trends surface (default OFF) so the data is there when you need it without always-on overhead.

### Enforcement / guard
- The audit surface is the guard for the §3 "no remote I/O inside a hold" rule.
- See the *Audit Surface Runbook* in `RUNBOOKS.md` for what's audited and how the pool-tenancy + external-call checks fit together.

### Generic replication
- **Portable:** the *principle* — instrument both ends (DB checkout span + outbound-call span) and alert on overlap. The simplest version is a dev-mode assertion: if `fetch`/HTTP is called while an attribution scope holds a DB client, throw. That alone catches the regression class early.
- **Portable:** hashes-only / no-secrets logging so the audit can run in prod.
- **NoBull-specific:** the full rollup + admin-trends UI and the specific external systems. Start with the assertion; build the dashboard only if you have the volume to justify it.

---

## 9. Query-budget harness

### Problem
A handler that did 2 queries silently grows to 5 as features get added (an N+1 creeps in, a helper quietly adds round trips). Nothing fails — it just gets slower. You want a *test* that says "this endpoint may issue at most N queries" and trips on the regression instead of a production pager.

### Mechanism (NoBull: `tests/helpers/queryBudget.ts`, Task #1724 Phase 4.3)
A test helper that monkey-patches `pg`'s `Pool.prototype.query` / `Client.prototype.query` **exactly once** (idempotent via a symbol flag) and, while a `runWithQueryBudget` scope is active in the calling async context (tracked with `AsyncLocalStorage`), counts every query. Outside a scope the patch is a no-op, so it's safe to leave installed.

```ts
const { result, count, queries } = await runWithQueryBudget(() => handler(req, res));
expect(count).toBeLessThanOrEqual(3);

// or assert directly (throws with the captured query list on overrun):
await assertQueryBudget(3, "POST /api/notifications", () => handler(req, res));
```

It captures the actual SQL strings too, so an overrun message tells you *which* queries blew the budget. This was built after a notification helper quietly grew to four round trips.

### Enforcement / guard
- Pin budgets on hot routes and storage helpers in the test suite; an overrun fails CI.
- Capturing the query text makes the failure self-diagnosing.

### Generic replication
- **Portable:** the whole pattern. Any Node + `pg` project can monkey-patch `query` and count per async scope. Pin budgets on your highest-traffic endpoints first.
- **Portable:** idempotent patch (symbol flag) + `AsyncLocalStorage` scoping + capture-the-SQL-on-overrun.
- **NoBull-specific:** which routes have budgets and what the numbers are. Set them at "current count" and ratchet down.

---

## 10. Staggered worker startup

### Problem
If every scheduler/worker starts on the same tick at boot, they all hit the database (and external APIs) simultaneously — a thundering herd at the exact moment the process is least warmed up. On autoscale, every instance does this on every deploy.

### Mechanism (NoBull: `server/services/workerConfig.ts` `WORKER_STAGGER_OFFSETS`)
A per-worker **startup offset map**: each scheduler's first run is delayed by a distinct offset so no two wake on the same JS tick. Offsets are spread across minutes (e.g. front_sync +10s, front_health_check +20s, semrush_enrichment +25s, zoom_sync +40s, … health watchers at +195s/+210s/+225s, daily-ish jobs at +255s/+270s). The comments deliberately note "stagger after X so the two don't wake on the same tick" — the offsets are chosen to *interleave related jobs*, not just to spread load uniformly.

### Enforcement / guard
- The offset map is the single place startup timing lives; new workers add an entry with a distinct value and a comment explaining what they're staggered after.

### Generic replication
- **Portable:** stagger first-run timing for any set of periodic jobs that boot together. Trivial to implement (a `setTimeout(offset)` before the first run), large benefit on cold start and on every redeploy.
- **Portable:** the discipline of choosing offsets so *related* jobs interleave (two health watchers shouldn't fire together).
- **NoBull-specific:** the exact worker names and offsets. Yours will differ; the rule "no two on the same tick" ports directly.

---

## 11. Backoff, kill switches, and workload control

### Problem
Background work must yield to user-facing work under pressure, must be capped so no single class of job monopolizes the worker pool, and must be **stoppable in production without a redeploy** when something goes wrong.

### Mechanism (NoBull: `server/services/workloadManager.ts`, `server/perfConfig.ts`)
Three cooperating controls:

1. **Per-class concurrency budgets.** Background jobs are tagged with a *workload class* (`interactive`, `ingestion`, `front_ingestion`, `repair`, `maintenance`, …). Each class has its own `maxConcurrency`, and there's a **global** `TOTAL_BUDGET` (`max(4, RETROACTIVE_REPROCESS_CONCURRENCY + 3)`) so a fully-saturated repair class can't starve interactive/ingestion/maintenance work. `acquireClassSlot` / `awaitClassSlot` / `withClassSlot` gate every job; `awaitClassSlot` polls (50ms) up to a 30s ceiling then throws. Several caps are **live-tunable** from `system_settings` via operator actions, so concurrency can change without a redeploy.
2. **Manual-reserve carve-outs.** For `ingestion` (and `front_ingestion`), one slot is **reserved for user-manual work** so a background backlog can never fully saturate the class against an interactive, user-triggered sync. Background work computes its effective cap as `maxConcurrency - reserve`; manual work can use the full cap.
3. **API-pool-pressure backoff.** Long background loops call `backoffForApiPoolPressure(worker)` between batches / per record. When the `api` pool is under pressure (high utilization, queued waiters, recent slow acquires), the worker sleeps (`WORKLOAD_BACKOFF_SLEEP_MS`, bounded by `WORKLOAD_BACKOFF_MAX_SLEEP_MS`) and emits one sampled log line (60s cooldown so a tight loop can't flood logs). This makes background work *actively yield* the moment users start competing for connections.
4. **Kill switches.** `server/perfConfig.ts` centralizes feature/kill switches; `system_settings.queue_drain_state` gives per-queue pause / rate-limit knobs with backlog alerts. An operator can pause a misbehaving queue or disable a subsystem from settings, instantly, no deploy.

### Enforcement / guard
- Slot acquisition/denial and backoff events are logged through the worker logger; saturation counters surface on dashboards.
- Backlog/starvation alerts watch for a queue that's paused-and-piling-up or starved.

### Generic replication
- **Portable:** the three primitives — (a) class concurrency budgets with a global cap below pool size, (b) a reserved slot for user-facing work, (c) pressure-aware backoff that makes background loops yield to the `api` pool. These together are what "background never hurts users" looks like in practice (the §1 split is necessary but not sufficient without them).
- **Portable:** kill switches / pause knobs in a settings table so production is controllable without a redeploy — invaluable during an incident.
- **NoBull-specific:** the exact class taxonomy, the specific tunable settings keys, and `RETROACTIVE_REPROCESS_CONCURRENCY`. Define classes that match *your* workloads.

---

## 12. Connection max-lifetime recycling

### Problem
Managed Postgres hosts (Neon and most others) periodically recycle idle server-side connections. When that happens, the next query through that pooled client raises a transient error. You can absorb it with retry, but the underlying churn is noise — better to retire connections **on your own schedule, before the host does**.

### Mechanism (NoBull: `server/db.ts`, Task #815)
Cap how long any pooled client may live (`DB_CONN_MAX_LIFETIME_MS`), with two enforcement points and jitter:

1. **On release:** if a client has lived past its effective lifetime, forward `release(err)` so pg-pool destroys it instead of returning it to the idle list.
2. **Periodic sweep:** idle clients that never get checked out again still need retiring — every `DB_CONN_LIFETIME_SWEEP_MS`, walk the pool's idle list and remove over-aged entries.
3. **Per-client jitter** at connect time so the whole pool doesn't get evicted at the same instant (a self-inflicted thundering herd).

### Enforcement / guard
- A `connectionRecycleCount` counter and log lines make recycling observable; pairs with the retry layer (`dbRetry`) that previously absorbed the host-initiated errors.
- A test seam installs the same policy on a throwaway pool with a tiny lifetime so the recycle-on-release and sweep-idle behaviors are tested without waiting minutes.

### Generic replication
- **Portable:** proactively cap connection lifetime + sweep idle + jitter. Standard hygiene on any managed Postgres that recycles idle connections (Neon, RDS Proxy, etc.). Many drivers/pools have a built-in `maxLifetime`/`idleTimeout` — use it before hand-rolling.
- **NoBull-specific:** the manual idle-list sweep via pg-pool internals (needed because node-postgres lacks a native max-lifetime). If your pooler has the feature natively, prefer that.
- **Watch-out (ties to §5):** a connection pinned for an advisory lock must be **exempt** from the lifetime sweep, or the lock gets recycled out from under a running job. NoBull's advisory-lock connection is never returned to the idle list, so the sweep never sees it.

---

## 13. Scale layer: Redis cache + PgBouncer pooled connections

> This is the *next* capacity multiplier **after** the pool work above is done and verified. The spec (`.local/tasks/db-scale-layer-redis-pgbouncer.md`) is explicit: it must **not** be used to mask unresolved pool misuse from background workers. Fix the leaks first; cache second.

### Problem
Once background work no longer steals user capacity, the remaining ceiling is raw read volume and connection count. You want more effective throughput **without** sharding, read replicas, or raising the API pool max.

### Mechanism (two independent levers)

**A. Thin Redis cache for safe hot reads.**
- A typed cache service (`get` / `set` / `getOrSet` / `del` / `delByPrefix` / `remember`) with namespaced keys, centralized JSON, **required TTLs**, and `hit / miss / set / del / error / bypassed` metrics.
- **Fail-open is mandatory:** if Redis is down, every read falls through to the database. A cache outage must never break a core flow.
- **Only safe reads are cached** — system settings, user permission/profile, client-list summary, integration status, queue/health rollups. **Explicitly never cached:** report final numbers, revenue/billing truth, CRM pipeline state, raw message bodies, OAuth tokens, work-queue rows — anything used for an irreversible decision. *No truth lives in Redis.*
- **Single-layer rule:** an existing in-memory cache (e.g. `getSystemSettings`) must become a **read-through over Redis**, not a second parallel layer, so the two can't drift.
- **One global kill switch** disables all Redis caching from settings.

**B. PgBouncer (Neon pooled connection string) for stateless API traffic.**
- Connection-string routing with three roles (`server/db.ts`): **DIRECT** (default; session-state-safe — advisory locks, long transactions, named prepared statements, `LISTEN/NOTIFY`, migrations all work), **POOLED** (Neon's `-pooler` host = PgBouncer transaction mode; stateless request/response only), **MIGRATIONS** (always direct). Env precedence: `DATABASE_URL_DIRECT` → `DATABASE_URL_POOLED` → `DATABASE_URL_MIGRATIONS`, each falling back to `DATABASE_URL`.
- **Only the `api` pool routes to POOLED.** Worker and probe stay DIRECT because they hold session-affine state (advisory locks per §5, long transactions, the warm probe loop). This is exactly why the §1 three-pool split was worth it: only the stateless pool is eligible for transaction-mode pooling.
- **Transaction-mode compatibility is a hard prerequisite** (proven before cutover): no explicit named prepared statements on the hot path (Drizzle issues empty-named/anonymous statements, which PgBouncer doesn't pin), no `LISTEN/NOTIFY`/`SET LOCAL`/session GUCs/advisory locks/temp tables in request handlers, and short transactions that don't span network boundaries. The failure signature to watch on first deploy is `prepared statement "S_N" does not exist`.
- **Rollback is a single env-var flip:** unset `DATABASE_URL_POOLED` and restart — the `api` pool returns to direct.

### Enforcement / guard
- Cache: hit/miss/error metrics on the admin health dashboard; the global kill switch; the no-truth-in-Redis exclusion list; the single-layer read-through rule.
- PgBouncer: dashboards distinguish pooled vs direct usage; the first pooled deploy is watched for prepared-statement errors; migrations are structurally forced onto the direct URL.
- Gradual cutover: one pool at a time with a 24h soak between flips; a 48h pre/post comparison validates reduced DB query count and lower API-pool waiters before the change is considered done.

### Generic replication
- **Portable:** the cache **discipline** — fail-open, required TTLs, an explicit allow-list of *safe* reads and a hard exclusion list of *truth*, single-layer (no parallel caches), one kill switch, hit/miss metrics. This discipline is what separates a safe cache from a correctness incident; it ports to any cache backend.
- **Portable:** the **three-role connection-string routing** (direct / pooled / migrations) and the rule that **only stateless pools may use a transaction-mode pooler**, with a single-flip rollback. Applies to PgBouncer, RDS Proxy, Supabase pooler, etc.
- **Portable:** "**prove driver compatibility before cutover**" and "**migrations never go through transaction-mode pooling**" — these are universal PgBouncer truths, not Neon-specific.
- **NoBull-specific:** Neon's `-pooler` host, the specific cached endpoints and their TTL targets, and the exact env-var names. Your cache candidates come from *your* telemetry (cache the reads that are hot and safe in your app).
- **Sequencing rule (portable and important):** do this **last**. Pools, attribution, hold rules, and workload control come first — caching a system that's still leaking connections just hides the leak.

---

## 14. Replication checklist (do this in order)

The ordering matters: each layer assumes the one before it. Don't cache (13) before you've stopped background work from starving users (1, 11).

1. **Split pools by role** (§1): at minimum `api` (requests) + `worker` (background); add a 1-connection `probe` so saturation is observable. Keep background concurrency below the worker pool size.
2. **Add connection attribution** (§2): wrap every checkout in an `AsyncLocalStorage` label with structured namespaces; track `unknown%`. Without this, the rest is hard to debug.
3. **Adopt the hold rules** (§3): no remote I/O inside a hold; batch don't loop; 10s warn / 30s high-severity. Stage-outside-then-persist.
4. **Build a Postgres work queue** (§4): `FOR UPDATE SKIP LOCKED` claim + lease/heartbeat + max-processing ceiling + retry/dead-letter + **release leases on SIGTERM**.
5. **Cross-instance singletons** (§5): replace in-process run-once flags with `pg_try_advisory_lock` on a pinned connection; add a hung-holder watchdog.
6. **Safe array bindings** (§6): one `bindArrayParam`-style helper; ban the `ANY(${arr}::type[])` trap.
7. **Workload control** (§11): per-class budgets + a global cap + a reserved slot for user-facing work + pressure-aware backoff + kill switches/pause knobs in a settings table.
8. **Connection max-lifetime** (§12): recycle pooled clients before the host does (jittered), exempting pinned lock connections.
9. **Staggered startup** (§10): offset each periodic job's first run so nothing thunders on boot/redeploy.
10. **Regression guards** (§7, §8, §9): `pg_stat_statements` nightly scan; external-call audit (start with a dev-mode "no HTTP inside a hold" assertion); query-budget tests on hot routes.
11. **Only then, the scale layer** (§13): fail-open Redis cache for safe reads (no truth, required TTLs, one kill switch) and PgBouncer for the stateless `api` pool (direct for everything session-affine; migrations always direct; prove driver compat; single-flip rollback).

### What's universally portable vs what's NoBull-specific

| Portable to any Node + Postgres project | NoBull-specific (re-derive for your app) |
| --- | --- |
| Three-role pool split; background < pool size | Exact caps (18/10/1), workload-class taxonomy |
| `AsyncLocalStorage` attribution + `unknown%` metric | Namespace names, dashboard wiring |
| Hold rules (no remote I/O in hold; batch; 10s/30s) | The specific external systems enumerated |
| `FOR UPDATE SKIP LOCKED` queue + lease/heartbeat + SIGTERM release | Queue names, reconciliation specifics |
| `pg_try_advisory_lock` singletons + watchdog | The set of run-once jobs, namespace ints |
| `bindArrayParam` array helper + cast allow-list | Allowed cast types |
| `pg_stat_statements` nightly scan | Helium/Neon mirror; Replit publish-diff direction¹ |
| External-call audit (overlap detection, hashes-only) | Full rollup/admin UI |
| Query-budget harness (`pg` query monkey-patch) | Which routes have budgets, the numbers |
| Staggered first-run offsets | The worker names/offsets |
| Class budgets + manual reserve + backoff + kill switches | Class names, tunable settings keys |
| Connection max-lifetime + jitter | Manual idle-sweep (use native if available) |
| Cache discipline; 3-role conn routing; "stateless pools only" pooling | Neon `-pooler`, cached endpoints/TTLs, env names |

¹ Replit-specific but reusable on any Replit project: any DB object not in your migration files (created by raw SQL, startup code, or an extension) must exist in **dev** too, or the deploy schema-differ drops it from prod.
