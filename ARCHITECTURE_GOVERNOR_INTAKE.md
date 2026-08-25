# Architecture Governor Intake Report — NoBull OS

Point-in-time, read-only inspection of this repository, produced 2026-08-09 so an external architect can design a project-specific **Architecture Governor** skill (`.agents/skills/architecture-governor/`). The governor is NOT built here; this report is the discovery input.

> **Historical workflow note (superseded).** Workflow facts below describe the
> 2026-08-09 inspection. Current operation uses exactly three roles — Start
> application, Validate (`npm run gate`), and Long validation (the reviewed
> request runner). Every lint is registered in `scripts/gate.ts` `LINT_CHECKS`;
> individual lint workflows are forbidden.

**How to read this report.** Every material conclusion carries one of three labels:

- **FACT** — directly demonstrated by repository evidence; always cited as `path:lines` or `path — symbol`.
- **INFERENCE** — strongly suggested by evidence but not proven; the basis is stated.
- **UNKNOWN** — not determinable from the repository alone; where useful, a safe measurement prescription is given.

Recommendations are graded `ADOPT NOW`, `DEFER UNTIL [measurable trigger]`, or `NOT JUSTIFIED`. Line numbers reference Git HEAD `63e529e6a06fcfe8f43165885757f28fcfac6464`. The report is self-contained: someone without repository access should be able to design the governor from it.

---

## 1. Executive Intake Verdict

**What this system is.** **FACT:** A single-deployment TypeScript/Node Express monolith with a React SPA, an in-Postgres work queue, and a large integration surface, deployed to a Replit Reserved VM (`.replit:12-15` — `deploymentTarget = "vm"`, build `./scripts/predeploy.sh && npm run build`, run `node ./dist/index.cjs`). Prod DB is Neon Postgres via the plain `pg` driver; dev is a Replit Helium Postgres (`replit.md` § Runtime Truth Table; `server/db.ts:57-108`). Scale markers at HEAD: 1,361 registered HTTP routes (verified — §3, claim 14), 232 `pgTable` definitions across `shared/models/*` (§5), 190 SQL migrations, 894 registered test suites (§9), 52 queue-handler registrations (§7), ~35 scheduler kill switches (§7), 58 root runbook/docs files (§11).

**INFERENCE:** The product is an internal operations OS for a single marketing agency ("NoBull OS" — `TESTING.md:7`, `replit.md` § Overview): clients are data rows, not tenants; users are staff with role hierarchy (CEO / team lead / account manager / sales — `server/routes/middleware.ts:187-221`). There is no multi-tenant isolation model to govern; the governance problem is **operational blast radius** (pools, queues, vendors), not tenant separation.

**Verdict.** This codebase is a *governed monolith*: it has already built an unusually deep deterministic self-governance layer — a 37-check gate (`scripts/gate.ts`), a hermetic per-run test database (`tests/hermetic/provision.ts`), generated + freshness-linted route/contract inventories, DB pool tenancy rules with AST lints, a leased work queue with workload-class budgets, cross-instance advisory locks with watchdog ceilings, and ~35 kill switches. The Architecture Governor should be designed to **extend and orchestrate this existing machinery**, not to introduce a parallel system. Most candidate guards in §13 are marginal additions to `scripts/gate.ts`'s existing `LINT_CHECKS` pattern.

**Top structural strengths (preserve; do not rebuild):**

1. **Historical FACT (superseded):** the inspected gate used one canonical
   entrypoint and an enforced lint contract. **Current contract:** every lint
   exports side-effect-free `cliMain(): number`, is registered in `LINT_CHECKS`,
   and runs through the single Validate workflow; standalone lints are CLI
   tools, not workflows. The three-role topology is linted
   (`scripts/lint-gate-workflow-drift.ts`; contract enforced by
   `tests/gate-lint-phase.test.ts`).
2. **FACT:** Hermetic per-run test Postgres with template caching and an escape-hatch-free guard against the shared dev DB and prod Neon (`tests/hermetic/provision.ts:9-35,152-194`; `server/db.ts:62-108`; `TESTING.md:16-28`).
3. **FACT:** Deterministic DB pool tenancy: three pools (api 18 / worker 10 / probe 1) with an AsyncLocalStorage context switch (`getDb()`/`runWithWorkerDb`), hold-time attribution labels, and two enforcing lints (`server/db.ts:770-876,1058-1085`; `RUNBOOKS.md:206-232`; `scripts/lint-db-pool-tenancy.ts`, `scripts/lint-periodic-pool-ownership.ts`).
4. **FACT:** A single in-Postgres work queue with `FOR UPDATE SKIP LOCKED` claims, leases + heartbeats, exponential backoff, dead-letter terminal state, and a partial-unique dedupe index excluding terminal statuses (`server/services/workQueueLease.ts:139-169`; `shared/models/workQueue.ts:29-64`).
5. **FACT:** Generated architecture inventories kept fresh by gate lints and auto-refreshed post-merge: route inventory (1,361 routes), endpoint contract table, website bundle (`scripts/regen-route-inventory.mjs`; `scripts/lint-route-inventory-freshness.ts`; `scripts/lint-contract-table-freshness.ts`; commit `fcd348e2a` — post-merge auto-refresh hook `scripts/post-merge-generated-artifact-refresh.ts`).

**Top architectural risks (governor focus):**

1. **FACT:** Service-layer monoliths: `server/services/prodActionsRegistry.ts` 10,573 lines, `server/services/zoomIntegration.ts` 7,156, `server/routes/integrations.ts` 7,869, `server/routes/reports.ts` 4,468, `server/routes/twilio.ts` 4,462 (`wc -l` at HEAD). A size ratchet exists only for *aggregator* files (`scripts/lint-monolith-aggregator-size.ts`), not feature monoliths.
2. **FACT:** No blanket API auth guard — protection is per-route middleware; some endpoints are deliberately public (`/api/trends` GET at `server/routes/settings.ts:839`, `/api/phase-settings` GET at `:1531`, MCU endpoints at `server/routes/mcu.ts:10-18`), so a missing-middleware mistake ships silently. Mitigated by the generated contract table's auth column, but nothing *fails* on an unexpectedly-public new route (§8, §13-G7).
3. **FACT:** Inbound-payload validation is uneven: 22 of 94 route files import zod; 163 `parse/safeParse` call sites total; several high-traffic routes destructure raw bodies (`server/routes/communications.ts:662-697`; counts via `rg`, §8).
4. **FACT:** Pagination has no shared convention — sampled routes use ad-hoc `limit`/`offset` with divergent defaults (25/50/20, max 100) and no cursor helper (`server/routes/communications.ts:568-611,870-871,948-966`), so unbounded/expensive list endpoints are a recurring hazard class (§8, §13-G6).
5. **INFERENCE:** Test-portfolio cost is governed for *membership* (smoke/sweep reasons required per suite) but not for *runtime budget*: the smoke universe more than doubled in the two days before HEAD (336 → 704 suites, §3 claim 11), and no check bounds aggregate gate time. Basis: registry history + absence of any budget check in `scripts/gate.ts`.

**Governor scope in one sentence.** Trigger on schema/pool/queue/integration/API-contract/test-infrastructure changes (§12), run a short evidence-based design review with the invariants in §14, and enforce the deterministic subset via new `LINT_CHECKS` entries (§13) — everything else (copy, styling, isolated UI) proceeds ungoverned.

---

## 2. Evidence and Repository State

### 2.1 Repository state (recorded before investigation)

| Item | Value |
| --- | --- |
| HEAD (start) | **FACT:** `63e529e6a06fcfe8f43165885757f28fcfac6464` (`git rev-parse HEAD`, recorded 2026-08-09T18:51:34Z) |
| Branch | **FACT:** `main` |
| Last commit | **FACT:** 2026-08-09 "Published your App" |
| Worktree (start) | **FACT:** clean except two pre-existing untracked files under `attached_assets/` (`Pasted--MASTER-READ-ONLY-EPIC-...1786300634856.txt` — the uploaded spec — and one sibling paste), per `git status --porcelain` |
| Worktree (end) | Re-checked at completion: unchanged except the two deliverable files below (§2.3) — recorded in the completion summary |

### 2.2 Method

- Static inspection only: file reads, `rg`/`grep`, `git log`/`git grep` history probes, and read-only bounded subagent scans per investigation lane, all synthesized here. No app code executed except: `npx tsx .local/scratch/agi/count-tests.ts` (a scratch script importing `tests/testRegistry.ts` to derive exact registry counts — read-only) and `npx tsx scripts/lint-route-inventory-freshness.ts` (the repo's own read-only freshness lint, run to verify the committed route count at HEAD).
- **FACT:** No migrations, workers, schedulers, builds, deployments, or the full test suite were run; no external service or production system was contacted. The dev database in this task environment was not used as evidence (task-environment clones are stale by design).
- Timing data comes only from committed artifacts (`tests/green-baseline.json`, `TESTING.md` measured tables); live run logs under `.local/runs/` are per-environment and not visible here — runtime baselines that depend on them are marked **UNKNOWN** with a measurement prescription (§9.6).
- No secrets, env-var values, credentials, or customer data appear in this report. Environment-variable *names* are listed where architecturally relevant (sanctioned by the spec).

### 2.3 Sanctioned deviations from the spec's operating rules

The spec was written for an in-place plan-mode session; this repository runs tasks in isolated environments whose uncommitted files are discarded at merge. Two deviations were pre-authorized by the task plan:

1. **The report itself is committed.** "Do not commit anything" would destroy the deliverable; the committed diff is exactly this file plus deviation 2.
2. **One index row added to `RUNBOOKS.md`.** **FACT:** `scripts/verify-runbook-coverage.ts` (wired into predeploy at `scripts/predeploy.sh:87-101`) fails Publish for any root `*.md` file absent from the RUNBOOKS.md Runbook Index unless its name ends in `-report.md`/`-results.md`. The spec mandates the exact name `ARCHITECTURE_GOVERNOR_INTAKE.md`, so a single index row is added to keep the repo publishable. No other file is touched.

### 2.4 Generated/committed artifacts excluded from architectural analysis

**FACT:** `artifacts/` (design mockup sandbox, ~27k files), `website/public/` (committed generated marketing bundle — `scripts/lint-website-bundle-freshness.ts:4-9`), `dist/` (build output), `tests/route-inventory.json` + `audits/D-endpoint-contract-table.{md,json}` (generated inventories — treated as *evidence outputs*, not source), `migrations/meta/` (drizzle journal), `attached_assets/` (uploads). These are excluded from module-structure conclusions but used as measurement artifacts where noted.

---

## 3. Verified Historical Claims

Each claim from the intake spec, checked at HEAD. Status ∈ {CONFIRMED, CORRECTED, OBSOLETE}.

| # | Historical claim | Status at HEAD | Current truth + evidence |
| --- | --- | --- | --- |
| 1 | TypeScript/Node app on Neon Postgres | **CONFIRMED** (nuance) | **FACT:** TS/Node/Express + React; *prod* is Neon PG 16.12 via plain `pg` driver, *dev* is Replit Helium PG 16.10 (`replit.md` § Runtime Truth Table; `package.json` deps; `server/db.ts:57-108` routes DIRECT/POOLED/MIGRATIONS URLs and refuses Neon+`heliumdb` in test mode) |
| 2 | Separate API and worker DB pools | **CONFIRMED** (+1) | **FACT:** Three pools, not two: `apiPool` (`server/db.ts:770-784`), `workerPool` (`:850-858`), and a max-1 `probePool` reserved for the health sampler (`:793-812`) |
| 3 | API pool ≈18, worker ≈7 | **CORRECTED** | **FACT:** API max 18 (`server/perfConfig.ts:24` via `PERF.DB_API_POOL_MAX`, used `server/db.ts:773`); worker max **10** — raised 7→8→10 per the history comments (`server/perfConfig.ts:26-36`); probe max 1. Mirrored in `replit.md` Runtime Truth Table and `RUNBOOKS.md:206-213` (Truth Table declared authoritative on conflict) |
| 4a | `runWithWorkerDb` exists | **CONFIRMED** | **FACT:** `server/db.ts:1083-1085` — AsyncLocalStorage context; `getDb()` resolves worker vs api (`:1074-1081`) |
| 4b | `acquireDbHeavySlot` / `releaseDbHeavySlot` | **OBSOLETE** | **FACT:** Symbols absent from the repo (exact-symbol search). The constant `WORKER_DB_HEAVY_MAX_CONCURRENCY = 3` still exists but has **zero consumers** (`server/services/workerConfig.ts:4`; repo-wide grep finds only the definition — dead config). The live mechanism is workload-class slots: `acquireClassSlot`/`releaseClassSlot` (`server/services/workScheduler.ts:20-21,90-96`) with per-class budgets in `server/services/workloadManager.ts` |
| 4c | `workerConfig.ts`, `workerLock.ts` | **CONFIRMED** | **FACT:** `server/services/workerConfig.ts` (stagger offsets, lock TTLs, cross-instance watchdog ceilings), `server/services/workerLock.ts` (in-process + layered advisory lock) |
| 4d | `workerConcurrency.ts` | **OBSOLETE** | **FACT:** No such file exists (directory listing); concurrency lives in `workloadManager.ts` + queue settings |
| 5 | `scripts/gate.ts` exists | **CONFIRMED** | **FACT:** Canonical gate — scratch-clean + typecheck + 34 lints + smoke = 37 checks, in-process lint worker pool (`scripts/gate.ts:109-175`; §10) |
| 6 | `tests/run-all.ts` exists | **CONFIRMED** | **FACT:** Discovery-based runner with hermetic DB, batching, retries, green-skip (`tests/run-all.ts`; §9) |
| 7 | DB testing via `runInTxSandbox` | **CONFIRMED** | **FACT:** `tests/db-sandbox.ts:141-170` — single rolled-back tx, `getDb()` redirect via test override resolver (`server/db.ts:1060-1072`); used by 49 suites (`rg -l` count) |
| 8 | HTTP testing via `TestHarness` | **CONFIRMED** (minor role) | **FACT:** `tests/test-harness.ts` exists but only 4 test files import it directly (`rg -l` count); most route suites spawn the server or stub fetch instead. Treat TestHarness as *a* pattern, not *the* pattern |
| 9 | Hand-rolled `assert()`/throw, no external framework | **CONFIRMED** | **FACT:** No jest/vitest/mocha/ava in `package.json` dependencies; suites are plain `tsx`-spawned scripts using `assert` + `process.exit` semantics, discovered via registration blocks (`tests/testRegistry.ts:121-171`) |
| 10 | Zero runtime dependency cycles after prior cleanup | **CONFIRMED** as gate invariant | **FACT:** `scripts/lint-server-import-cycles.ts` is in the gate (`scripts/gate.ts:162-166`); dynamic `import()` is the sanctioned cycle-break. The lint passing at HEAD is the enforcement; knip is referenced in docs only (pinned `knip@6.32.0 --cycles` documented in that lint's header, no knip dep/config — `package.json`, no knip entry) |
| 11 | ~290–294 tests vs ~317 smoke checks | **OBSOLETE** (explained below) | **FACT:** At HEAD the registry defines **894 suites**, **704 smoke**, **734 regression**, **662 both**, **118 neither** (derived by importing `tests/testRegistry.ts`; cross-check: 894 `*.test.ts(x)` files under `tests/` + `client/src/`) |
| 12 | Guards exist for pool ownership, SQL array bindings, migration prefixes, endpoint validation, idempotency | **CONFIRMED** (mapped) | **FACT:** `lint-db-pool-tenancy` + `lint-periodic-pool-ownership` (pools), `lint-sql-array-bindings` (SQL), `lint-migration-prefixes` (filename-only — content NOT checked, §10.4), `lint-contract-table-freshness` + `lint-route-inventory-freshness` (endpoint inventory), `lint-prod-actions-no-re-press` + work-queue dedupe index (idempotency) — all in `scripts/gate.ts:109-175` |
| 13 | Prior concerns: ATS pagination, webhook-vs-polling, worker contention, stuck rows, long transactions, N+1, unbounded reads | **PARTIALLY ADDRESSED** | **FACT:** Purpose-built mitigations exist for contention/stuck rows/long transactions: workload-class caps, lease watchdogs + `stale_lease_exhaustion`, stuck-processing alert watchers, DB-hold warn tiers at 1s/10s/30s (`server/db.ts:700-724`), `queueStarvationAlerts.ts`, `leaseChurnAlerts.ts`. **INFERENCE:** Unbounded reads and N+1 remain live hazards — no shared pagination/cursor helper exists (§8.5) and the DB performance audit is the stalest major audit (`audits/C-db-performance-findings.md`, last commit 2026-05-21) |
| 14 | ~1,348 routes | **CORRECTED** | **FACT:** **1,361** routes at HEAD — verified by running the repo's own freshness lint, which reported "OK (1361 routes; committed inventory matches a fresh parseRoutes() scan)". Counter: `tests/route-inventory.ts:199-270` parses every `app.METHOD(` registration (incl. multiline openers) across route files; committed artifact `tests/route-inventory.json` + report, regenerated by `scripts/regen-route-inventory.mjs`, freshness-gated by `scripts/lint-route-inventory-freshness.ts` and auto-refreshed post-merge (commit `c9f6f3603`) |

### 3.1 Why the historical test counts conflict

The historical "~290–294 tests" and "~317 smoke checks" match **no artifact at HEAD** (repo-wide grep for those figures finds only coincidental matches such as route-inventory rows). Three compounding reasons explain the drift — all **FACT** unless noted:

1. **Different denominators.** "Tests" has at least four current definitions: registered suites (894), smoke-tagged suites (704), regression-tagged suites (734), and gate *checks* (37 in `npm run gate`: scratch-clean + typecheck + 34 lints + smoke phase). A historical "317 smoke checks" most plausibly summed a smaller smoke set plus lint checks; nothing at HEAD reproduces it. **INFERENCE**, basis: current definitions + absence of any 317-producing formula.
2. **The corpus roughly tripled in eight weeks.** Test-file counts from git history: 576 (2026-07-15) → 737 (08-01) → 803 (08-05) → 876 (08-07) → 894 (HEAD 08-09) (`git ls-tree` at dated commits). A ~290-suite era predates this window.
3. **The smoke universe more than doubled two days before HEAD.** `"smoke": true` files: 0 before the registration-block rework (blocks introduced ~08-02 by Task #3786), 284 (08-05), 336 (08-07), ~704 (HEAD). The jump is one auditable commit: `a885b953e` "Triage all 361 no-reason nightly-only suites: promote 352 fast/deterministic ones to the smoke gate…". Consequence: **all pre-08-08 wall-time figures for the smoke gate (including TESTING.md's own "258 suites / 25–30 min") undercount the HEAD smoke universe** — see §9.6.

Even the current docs lag: `TESTING.md:9` says "770+ tests" against 894 at HEAD (file last committed 2026-08-08). The governor should treat **the registry derivation itself** (`tests/testRegistry.ts`) as the only authoritative count source, never prose.
---

## 4. System and Module Map

### 4.1 Stack and runtime

| Concern | Current choice | Evidence |
| --- | --- | --- |
| Language / runtime | TypeScript on Node, ESM (`"type": "module"`) | **FACT:** `package.json:4`; `tsconfig.json` |
| Package manager | npm (committed `package-lock.json`) | **FACT:** repo root |
| Server framework | Express 4 | **FACT:** `package.json` deps; `server/index.ts` |
| Frontend | React 18 SPA, Vite build, wouter routing, TanStack Query | **FACT:** `client/src/main.tsx:1-8`; `vite.config.ts` |
| ORM / query | drizzle-orm 0.45.2 + drizzle-kit; plain `pg` Pool underneath | **FACT:** `package.json`; `server/db.ts:848,876` (`drizzle(...)` over pools) |
| Database | Postgres — prod Neon 16.12 (DIRECT + optional POOLED/PgBouncer URLs), dev Replit Helium 16.10 | **FACT:** `server/db.ts:57-108`; `replit.md` § Runtime Truth Table |
| Queue | In-Postgres `work_queue` table (no external broker) | **FACT:** `shared/models/workQueue.ts:29-64`; `server/services/workQueueLease.ts` |
| Cache | Upstash Redis (settings cache, integration-status cache) + in-memory layers | **FACT:** `server/services/cache/redisCache.ts`; `INTEGRATION_STATUS_CACHE.md` |
| Sessions/auth | Replit OIDC via Passport; `express-session` + `connect-pg-simple` (sessions in PG) | **FACT:** `server/replit_integrations/auth/replitAuth.ts:584-625`; `package.json` |
| Scheduling | node-cron (10 scheduler files) + `setInterval` loops + boot-staggered inits | **FACT:** `rg -l "cron.schedule"` → 10 files (§7.3); `server/boot/schedulerInits.ts` |
| Docs/sheets engine | Univer (docs + sheets presets) with custom Vite transforms | **FACT:** `package.json:50-53`; `vite.config.ts:73-169` |
| Realtime | `ws` websockets; LiveKit for voice/video | **FACT:** `package.json`; `COMMS.md` (RUNBOOKS row) |
| Build | `tsx script/build.ts` → Vite client bundle + esbuild server → `dist/index.cjs` (CJS) | **FACT:** `package.json:9`; `.replit:14` runs `node ./dist/index.cjs` |
| Deployment | Replit **Reserved VM** (`deploymentTarget = "vm"`); predeploy gate before build | **FACT:** `.replit:12-15` |

### 4.2 Entry points and commands

**FACT:** `package.json:6-18` scripts: `dev` (`NODE_ENV=development tsx server/index.ts`), `dev:client`, `build`, `start` (`node dist/index.cjs`), `check` (`tsc`), `db:push` (`drizzle-kit push`), `test` (`tsx tests/run-all.ts`), `test:regression`, `test:regression:sweep`, `gate` (`npx tsx scripts/gate.ts`), `clean:scratch`, `generate:caseintake:pptx`.

| Entry point | Role | Evidence |
| --- | --- | --- |
| `server/index.ts` | Single app process: express setup → auth → limiters → `registerRoutes` → static/Vite → **deferred** worker/scheduler init | **FACT:** `server/index.ts:171-174,192-244,272-288` |
| `server/routes.ts` — `registerRoutes(app)` | Ordered aggregation of ~90 `registerXRoutes(app)` feature registrars | **FACT:** `server/routes.ts:99-180` |
| `server/boot/workersAndCleanup.ts`, `server/boot/schedulerInits.ts` | Queue handler registration + staggered scheduler boot | **FACT:** §7.1 |
| `client/src/main.tsx` | SPA root | **FACT:** `client/src/main.tsx:1-8` |
| `tests/run-all.ts` | Sole test runner (discovery + hermetic DB + batching) | **FACT:** §9 |
| `scripts/gate.ts` / `scripts/predeploy.sh` | Dev gate / publish gate | **FACT:** §10 |
| `migrations/*.sql` (190 files) + `migrations/meta/_journal.json` | Schema history (drizzle journal); dev ledger + `SAFE_MIGRATIONS` re-apply in post-merge | **FACT:** `ls migrations/*.sql | wc -l` = 190; `drizzle.config.ts` |

### 4.3 Top-level modules

| Module | Size at HEAD | Responsibility | Evidence |
| --- | --- | --- | --- |
| `server/` | 613 `.ts` files | API + workers + integrations (subdirs: `routes/` 94 files, `services/` 399, `boot/`, `observability/`, `replit_integrations/`) | **FACT:** file counts via `rg --files` |
| `client/src/` | 377 files | React SPA (pages, components, contexts, hooks) | **FACT:** file count |
| `shared/` | `schema.ts` barrel (53 lines) + `models/*` (~80 files, 232 `pgTable`) + shared types | **FACT:** §5.2 |
| `tests/` | 1,148 files (894 registered suites + helpers/hermetic/inventory tooling) | **FACT:** file count; §9 |
| `scripts/` | Gate lints (34), predeploy, regen/codemod/ops tooling | **FACT:** `scripts/gate.ts:109-175` |
| `migrations/`, `audits/`, `website/`, `artifacts/`, `attached_assets/` | Schema history; audit corpus (31 files); marketing-site generator + committed bundle; design sandbox; uploads | **FACT:** listings §2.4, §11 |

**Monolith hotspots.** **FACT** (`wc -l` at HEAD): `server/services/prodActionsRegistry.ts` 10,573; `server/routes/integrations.ts` 7,869; `server/services/zoomIntegration.ts` 7,156; `server/routes/reports.ts` 4,468; `server/routes/twilio.ts` 4,462. Only *aggregator* files have a size ratchet (`scripts/lint-monolith-aggregator-size.ts`); these feature files do not.

### 4.4 Dependency direction and boundaries

- **FACT:** Client cannot import server: Vite aliases expose only `client/` + `shared/` (`vite.config.ts:204-209`); no `server` alias; static search finds no `tests → server-runtime` leakage beyond intended imports.
- **FACT:** DB access is *broad*, not layered: 729 files match a (deliberately broad) db-import pattern — 47 in `server/routes/`, 175 in `server/services/` (`rg -l` counts; pattern includes relative-path false positives). Even `server/routes.ts` itself executes SQL inline (`server/routes.ts:85-97`). There is no repository/DAO layer; drizzle + `getDb()` *is* the data layer.
- **FACT:** Canonical cross-cutting abstractions that new code is expected to reuse: `getDb()`/`runWithWorkerDb` + `withDbAttribution` (pool context + hold labels, `server/db.ts:1058-1085`, `server/index.ts:40-41`); work-queue enqueue/lease helpers (`server/services/workQueueLease.ts`); `system_settings` accessors incl. kill switches (`server/boot/schedulerInits.ts:107-113`); cross-instance locks (`server/services/crossInstanceLock.ts`); limiter mount lists (`server/routes/limiterMounts.ts`); `asyncHandler` + `HttpError` + `globalApiErrorHandler` (`server/observability/httpErrors.ts:77,108,144`); integration-status cache loaders (`INTEGRATION_STATUS_CACHE.md`).
- **Competing patterns still coexisting** (governor should push toward one): **FACT:** client API calls via TanStack `apiRequest` wrapper *and* raw `fetch` (`client/src/pages/SheetsLibrary.tsx:23` vs `client/src/pages/ClientDetail.tsx:894-1036`); route registration via central registrars *and* direct `app.post` inside modules (`server/routes.ts:99-180` vs `server/routes/twilio.ts:692`); error handling via `asyncHandler`/`HttpError` *and* per-route try/catch returning ad-hoc `{error}` shapes (`server/observability/httpErrors.ts` vs e.g. `server/routes/conversationDedupeConflicts.ts:41-44`).
- **Vendor SDK import surface** (direct importers found): **FACT:** `openai` imported by 6+ files incl. `server/routes/middleware.ts` and service files (`rg -l`); `stripe` only in `server/stripeSync.ts`; `@google-cloud/storage` only in `server/replit_integrations/object_storage/*`; `@upstash/redis` only in `server/services/cache/redisCache.ts`; `twilio`/`livekit-server-sdk`/`@google-cloud/bigquery` are accessed via wrapper modules (no direct top-level import hits under the exact-package pattern). OpenAI is the least-contained SDK (§8.7).

### 4.5 Compact dependency map

```text
client/src (React SPA: wouter + TanStack Query)
    └── HTTP /api ──► server/index.ts (session auth, limiters, request tracker)
                          └── registerRoutes ──► server/routes/* (94 files)
                                                    ├──► server/services/* (399 files: domain + integrations)
                                                    │        ├──► shared/models/* (drizzle tables, 232)
                                                    │        ├──► server/db.ts (apiPool 18 / workerPool 10 / probePool 1)
                                                    │        └──► vendor SDKs / fetch (OpenAI, Twilio, Front, Zoom, …)
                                                    └──► server/db.ts (direct SQL in routes — sanctioned but broad)
server boot (deferred): workersAndCleanup ──► work_queue handlers (52) ──► runWithWorkerDb ──► workerPool
                        schedulerInits (stagger+jitter) ──► node-cron / setInterval loops ──► kill-switch gates
shared/: schema barrel + types (imported by server, client, tests)
tests/run-all.ts ──► hermetic PG (never dev/prod DB) ──► suites (894)
scripts/gate.ts ──► 34 lints + typecheck + smoke ──► .replit workflows (parity-linted)
```

**Expensive-to-reverse decisions** (all **FACT** by dependency + usage breadth): Express+SPA monolith on one Reserved VM; drizzle over plain `pg` with three-pool tenancy; in-Postgres work queue (no broker); Replit OIDC session auth (`connect-pg-simple`); Univer docs/sheets engine with bespoke Vite transforms; object-storage layout under `server/replit_integrations/object_storage/`; the hand-rolled test runner + registration-block contract (894 files carry it).

---

## 5. Database and Data Ownership

### 5.1 Pools — the core resource-governance model

**FACT** (all from `server/db.ts:770-876` and `server/perfConfig.ts:22-36`):

| Pool | URL | min/max | idle timeout | conn timeout | statement_timeout | Owner / intended tenant |
| --- | --- | --- | --- | --- | --- | --- |
| `apiPool` → `db` | POOLED (PgBouncer) when set, else DIRECT | 2 / **18** | 30s (0 in test) | 30s | 30s | HTTP requests + interactive work |
| `workerPool` → `workerDb` | DIRECT (session affinity for advisory locks) | 1 / **10** | 60s | 30s | 120s | Background workers/schedulers via `runWithWorkerDb` |
| `probePool` | DIRECT | 1 / 1 | 0 | 5s | 5s | Health sampler only — cannot starve even when both main pools are saturated (`server/db.ts:793-812`) |

- **FACT:** Worker max was deliberately raised 7→8→10 with dated history comments (`server/perfConfig.ts:26-36`). The historical "worker ≈ 7" is obsolete.
- **FACT:** Pools are wrapped in an `InstrumentedPool` with acquire/hold attribution and a 25-minute per-connection max lifetime sweep; hold-time warn tiers at 1s (warn) / 10s (record) / 30s (critical alert via lazy-imported `longDbHoldAlerts`) (`server/db.ts:~640-760`).
- **FACT:** Context switching is ambient: `getDb()` returns `workerDb` inside `runWithWorkerDb(...)` scopes (AsyncLocalStorage), else `db`; a test-only override resolver exists (`server/db.ts:1058-1085`). Two lints enforce tenancy: `lint-db-pool-tenancy` (workers must not use apiPool) and `lint-periodic-pool-ownership` (periodic jobs judged by imported symbol; `scripts/gate.ts:109-175`).
- **FACT:** Retry/pressure seams: `dbRetry` (3 attempts, 1s/2s/4s, transient-error classifier + recovery counter, `server/db.ts:1098-1142`); `isApiPoolUnderPressure()` with live-tunable thresholds for load-shedding call sites (`server/db.ts:974-1003`).
- **FACT:** `MIGRATION_CONNECTION_STRING` is exported separately for schema ops; test mode refuses Neon hosts and the shared `heliumdb` outright with no escape hatch (`server/db.ts:62-108`).

### 5.2 Schema shape and ownership

- **FACT:** 232 `pgTable` definitions live in `shared/models/*` (~80 domain files); `shared/schema.ts` is a 53-line re-export barrel (counted via `rg -c pgTable`). Drizzle config: schema `shared/schema.ts`, out `./migrations`, `tablesFilter` excludes `pg_stat_statements` views (`drizzle.config.ts`).
- **FACT:** Only **15** `db.transaction(` call sites exist in `server/` (`rg -c` sum) — transactions are the exception; most writes are single-statement + queue-mediated. Long transactions are policed by hold-tier alerts rather than forbidden.
- **INFERENCE:** System-of-record boundaries follow the `shared/models/*` file split (one domain per file: clients, bookings, communications, workQueue, notifications, clickupMirror, adsOs, sheets/docs, heatmap, ris, …). Basis: model-file naming + service imports; there is no formal ownership manifest — a governor gap (§13-G5).

| Entity cluster | System of record | External-ID modeling | Evidence |
| --- | --- | --- | --- |
| Clients, users, roles | `clients`, `users` tables; users upserted from Replit OIDC claims | — | **FACT:** `server/replit_integrations/auth/replitAuth.ts` (upsert on login); `shared/models/*` |
| Communications (email/SMS/calls/chat) | `front_sync_emails`, `raw_communication_records`, `twilio_*`, comms tables | Provider message/conversation IDs unique per raw row (e.g. `external_source_id` unique on Zoom raw records — one meeting = one row) | **FACT:** `shared/models/*`; `FRONT.md`, `ZOOM.md` runbooks |
| Background work | `work_queue` — statuses `pending/leased/processing/completed/failed/dead_letter/cancelled`; **partial unique dedupe index excluding terminal statuses** | `dedupe_key` per job | **FACT:** `shared/models/workQueue.ts:29-64` |
| Config & kill switches | `system_settings` (short-TTL Redis-cached accessors) | — | **FACT:** §7.5; `server/services/settingsCache*` |
| Observability | `external_call_audits`, `db_hold_label_rollups`, `pool_state_samples`, `api_route_stats_windows`, notification tables | — | **FACT:** `EXTERNAL_CALL_AUDIT.md`; `REQUEST_OBSERVABILITY.md` |
| Vendor mirrors | ClickUp mirror tables; Stripe mirror in a dedicated `stripe` schema via `stripe-replit-sync` | Vendor IDs as natural keys in mirror tables | **FACT:** `CLICKUP.md`; `server/stripeSync.ts`; `STRIPE.md` |

- **Tenancy:** **INFERENCE:** Single-organization; per-client scoping is by `client_id` FK columns + role middleware, not RLS or schema separation. Basis: role middleware (`server/routes/middleware.ts:187-330`), absence of RLS/policies in migrations (grep). The governor should treat "client data isolation" as an *authorization* concern (§8.2), not a database-tenancy concern.
- **High-volume / append-heavy tables:** **FACT:** audit/rollup tables have dedicated retention pruners and a table-size watchdog (`server/services/auditRetention.ts`, `rateLimitNotificationRetention.ts`, `pendingDigestAlertsRetention.ts`; `WORKERS_QUEUES_RUNBOOK.md`); `EXTERNAL_CALL_AUDIT.md` documents daily rollups + retention for call/hold audits. **INFERENCE:** the hottest write paths are `external_call_audits`, `front_sync_emails`/`raw_communication_records`, `work_queue`, and pool/route stats sampling — basis: retention machinery + integration cadences; no committed row-count evidence (§5.5).

### 5.3 Migrations

- **FACT:** 190 `.sql` files in `migrations/` with **mixed naming**: a frozen legacy `NNNN_*` block plus UTC-timestamp-prefixed names for everything new; `scripts/lint-migration-prefixes.ts` enforces the naming/ordering policy **by filename only** — it never reads SQL bodies (`:77-85,306-320`), and the frozen legacy snapshot is content-hash-pinned by its guard test (`tests/lint-migration-prefixes.test.ts`).
- **FACT:** Dev applies migrations via a ledger with `SAFE_MIGRATIONS` idempotent re-apply in `scripts/post-merge.sh`; hermetic test DBs are built schema-first (drizzle push semantics) and cached by schema hash, so migration files are exercised only for DB-sensitive suites' fingerprints, not replayed per run (`tests/hermetic/provision.ts:152-194`; `TESTING.md`).
- **FACT:** No down/rollback migrations exist (no `*down*.sql`; drizzle journal is forward-only). Rollback strategy is Replit checkpoints + forward fixes.
- **UNKNOWN:** Whether expand-contract (deploy-compatible) migration discipline is *followed* — nothing enforces it and no doc claims it. Prod schema drift is a known hazard class: the publish flow diffs dev-DB→prod and can propose dropping runtime tables that exist only in prod (`RUNBOOKS.md` / `replit.md` publish notes). Governor prompt material (§17-P8).

### 5.4 Access-pattern hygiene (demonstrated, not speculative)

- **FACT:** SQL array bindings have a dedicated lint (`scripts/lint-sql-array-bindings.ts`) — history of `= ANY($1)` binding bugs.
- **FACT:** Unbounded-read protection is *not* systematic: sampled list endpoints use ad-hoc `limit`/`offset` with divergent defaults and no shared helper (§8.5). `SELECT` sites without `LIMIT` are not linted.
- **FACT:** The nightly `pg_stat_statements` regression scan diffs prod query performance against a stored baseline and posts top-5 regressions (`PG_STAT_STATEMENTS_REGRESSION.md`) — this is the only continuous query-performance telemetry.
- **INFERENCE:** N+1 patterns exist in report/dashboard aggregation paths — basis: `audits/C-db-performance-findings.md` findings (last commit 2026-05-21, the stalest major audit) plus monolith route files issuing per-row queries; not re-proven at HEAD.

### 5.5 Missing information for a 10× forecast

**UNKNOWN** (not derivable from the repo; measurement prescriptions):

1. Current prod row counts / growth rates per table — replica stats are replica-local. *Prescribe:* a read-only prod query via the existing admin DB-attribution surface (`EXTERNAL_CALL_AUDIT.md`) capturing `pg_class.reltuples` + table sizes into a committed snapshot, refreshed monthly.
2. Queue throughput/backlog percentiles — *Prescribe:* export existing `work_queue` alert-watcher counters (§7.4) to a weekly snapshot.
3. Pool saturation headroom — *Prescribe:* the pool-epic baseline doc (`docs/pool-epic-baseline.md`) prescribes exactly this 7-day metric capture; refresh it before any pool-size decision.

---

## 6. Integration Registry

**FACT** (registry-level): `replit.md`'s Runtime Truth Table "Primary integrations" row + `RUNBOOKS.md` Integration Runbook Coverage Matrix (`RUNBOOKS.md:67-115`) enumerate the integration set; every integration must have an owning runbook row (predeploy-enforced, `scripts/verify-runbook-coverage.ts`). GHL appears only as prose in `SERVICE_DESK.md:187` — **no GHL integration exists** (no code hits).

### 6.1 Core registry

Direction: in = webhooks/inbound calls to us; out = we call vendor. All rows **FACT** at file/symbol level (entry-point files verified by import/search; per-cell line citations omitted for table economy — see owning runbook for each).

| Integration | Purpose | Dir | Entry points (representative) | Credentials (storage; env *names* only) | Sync model |
| --- | --- | --- | --- | --- | --- |
| Front | Shared email inbox → comms ingestion, analytics coverage | in+out | `server/services/frontSync*.ts`, `server/routes/front*.ts`, webhook receiver | OAuth token in `system_settings`; `FRONT_WEBHOOK_SECRET` | Webhooks + 3 queue-driven sweeps + historical recovery |
| Zoom | Meeting create, recordings, transcripts → client matching | in+out | `server/services/zoomIntegration.ts` (7,156 lines), webhook routes | OAuth (rotating refresh) + S2S app (`ZOOM_S2S_*`); dual webhook secrets | Signed webhooks (±5min) + polling backfills + queues |
| Twilio | Calls, SMS, voicemail, recordings | in+out | `server/routes/twilio.ts` (4,462), `server/services/twilio*` | Creds in `system_settings` | Signed webhooks + REST; recording archive worker |
| Google Calendar | Per-AM booking calendar, free/busy | out | `server/services/googleCalendar*` | Per-user OAuth tokens AES-encrypted with `TOKEN_ENCRYPTION_KEY`; `GOOGLE_CALENDAR_REDIRECT_URI` | On-demand + event lifecycle writes |
| Google Ads | Campaign/keyword sync, Ads OS console | out | `server/services/googleAds*`, `server/services/adsOs/*` | Env trio `GOOGLE_ADS_CLIENT_ID/SECRET/REFRESH_TOKEN` (+ developer token, login customer id) — single shared lane, no stored connection | Daily sync worker + on-demand reads |
| Google Sheets (SA) | Read-only sheet ingestion (Drive integration RETIRED 2026-08, Task #4084) | out | `server/services/sheets*` (service-account lane) | `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY` | Scheduled + manual pulls |
| SEMrush | SEO metrics, heatmap/Local Dominance pipeline | out | `server/services/semrush*` (+ 3 queues) | `SEMRUSH_V4_API_KEY` (Apikey header mode) | Queue-driven cadence + demand-driven refresh gate |
| ClickUp | Workspace mirror, Service Desk tickets, Client List | in+out | `server/services/clickup*`, per-user OAuth routes | Per-user OAuth in `clickup_user_tokens` (AES-GCM); admin app secrets | Mirror sync workers + on-demand; 100/min limiter |
| OpenAI | Transcript analysis, judgments, structured outputs | out | Distributed: 6+ direct SDK importers (`callAnalysis.ts`, `dailyJudgment.ts`, `server/routes/middleware.ts`, …) | `OPENAI_API_KEY` / `AI_INTEGRATIONS_OPENAI_*` | On-demand + queued jobs |
| Stripe | Billing mirror | in+out | `server/stripeSync.ts` (sole SDK importer) | Managed by `stripe-replit-sync`; signed webhooks | Webhook-driven mirror into `stripe` schema |
| Rev.ai | ATS video transcription | in+out | `server/services/revai*` | `REV_AI_API_TOKEN`; callback auth via `REV_AI_CALLBACK_SECRET` (Authorization header — no HMAC) | Submit + callback (+ redelivery ~30min/24h) |
| TwelveLabs | Video indexing/search (Marengo/Pegasus) | in+out | `server/services/twelvelabs*` | API key; `t+v1` signed webhooks (5-min window) | Async index + webhook completion |
| LiveKit | Comms voice/video rooms | in+out | Thin server SDK usage + room webhooks | `LIVEKIT_API_KEY/SECRET/SERVER_URL` | Webhook room lifecycle |
| Slack | Outbound ops alerts | out | `SLACK_WEBHOOK_URL` webhook sender + bot-token surfaces (no consolidated module) | `SLACK_WEBHOOK_URL` | Fire-and-forget sends |
| SendGrid | Single outbound email path for alerts/notifications | out | Per `SENDGRID.md` — one shared sender module | API key | On-demand |
| PandaDoc | Contract text sync | out | `server/services/pandadoc*` | Key in `system_settings` | Scheduled sync; 5×429 retries |
| Geospatial (Google Maps, MapTiler, FCC Census) | Geocoding, basemaps, census blocks | out | `GEOSPATIAL_APIS.md`-owned services; MapTiler key-serving route | `MAPTILER_API_KEY` etc. | On-demand |
| BigQuery | RIS auto-source metrics ingestion | out | `server/services/ris*` (mapping-owned schema) | Service-account (via env) | Scheduled pulls; unconfigured ⇒ `needs_review`, never silent pass |
| Upstash Redis | Settings + status caches | out | `server/services/cache/redisCache.ts` (sole importer) | Upstash REST creds | Continuous |
| Object Storage (GCS via Replit) | Client files, recordings, backups | out | `server/replit_integrations/object_storage/*` | Replit-managed; `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | On-demand + presigned-upload claim flow |
| Replit Auth (OIDC) | Staff login | in | `server/replit_integrations/auth/replitAuth.ts` | Platform-managed; `SESSION_SECRET` | Session refresh on expiry |
| Inbound token surfaces | CEO tools API (`CEO_TOOLS_API_TOKEN`, constant-time compare) and cron endpoints (`CRON_SECRET` via `X-Cron-Key`) | in | `server/routes/middleware.ts:225-254`; `server/routes/adsOs.ts:1212-1213` | env names as listed | External callers |

### 6.2 Reliability matrix and known weaknesses

Selected rows where the evidence is strongest; each weakness maps to a candidate governor invariant (§13).

| Integration | Idempotency | Retry/backoff | Breaker / kill switch | Weakness → governor invariant |
| --- | --- | --- | --- | --- |
| Front | Input-hash idempotency on ingest; thread-wide attribution via one shared helper | Queue backoff (10s→600s, 3 attempts → dead_letter) | Auth-dead breaker at accessor, persisted; OAuth single-flight refresh (lint-guarded) | **FACT:** webhook HMAC verifies **body only, no timestamp** (replay window) — invariant: signed webhooks must bind a timestamp |
| Zoom | `external_source_id` unique raw rows; transcript apply UPDATES | Reactive-401 + proactive-expiry dual refresh, single-flight | Per-integration disconnect gating (never on one 401); ~35 scheduler switches incl. Zoom lanes | Rotation races historically corrupted tokens — invariant: all OAuth refresh through the single-flight helper (`lint-oauth-refresh-single-flight` exists) |
| Twilio | Pre-insert + claim pattern | SDK retries **only on 429** | Kill switches per lane | **FACT** (runbook): non-429 timeout ⇒ duplicate-send risk — invariant: outbound sends must be idempotency-keyed |
| Google Calendar | Booking-row idempotency | — | Per-user token health | Dup-event risk on retry after timeout (same class as Twilio) |
| TwelveLabs | Webhook-driven completion | Vendor redelivery | — | **FACT** (runbook): in-memory correlation lost on restart; `ready` event lacks videoId → requires one retrieve — invariant: webhook correlation state must be durable |
| SEMrush | Hash suppression of unchanged results | Ladder 1m→24h → dead-letter | Circuit breaker + cadence pause switches | Firehose cost — cadence gate must stay demand-driven |
| Slack | none | none (fire-and-forget) | Self-alert on `channel_not_found` | **FACT:** no consolidated boundary module — invariant: vendor calls live behind one owning module |
| OpenAI | — | Per-service retry/fallback (`OPENAI.md`) | **No master kill switch** | Distributed SDK importers — invariant: SDK imports confined to an owning adapter (§13-G2) |
| Rev.ai | Callback treated as correlation-only; state re-fetched | Vendor redelivery | — | Callback auth is a static header token — acceptable, but must never gain state-mutating trust |

- **Inbound payload validation:** **FACT:** webhook receivers verify signatures (Front/Zoom/Twilio/TwelveLabs/Stripe) but body *schemas* are mostly hand-destructured, not zod-validated (§8.4 counts). **INFERENCE:** the riskiest gap is unvalidated vendor payload drift silently nulling fields — basis: hand-destructuring + prior incident classes in runbooks.
- **Status observability:** **FACT:** every integration surfaces into the Integrations Hub badge cache (Redis TTL 300s / fresh 60s; boot prewarm for 8 badge keys; `INTEGRATION_STATUS_CACHE.md`) and most write `external_call_audits` rows via the audited-call wrapper (`EXTERNAL_CALL_AUDIT.md`).
- **Tests:** **FACT:** integration logic is tested via stubs/fixtures (fetch-override seams, resolve-hook module stubs — §9.4); no test contacts a real vendor (network policy §9.4).

---

## 7. Workers, Schedulers, and Reliability

### 7.1 Topology and boot

- **FACT:** All background execution runs **in the same process** as the API (Reserved VM), deferred post-listen: `server/index.ts:272-288` kicks `workersAndCleanup` + `schedulerInits`. `server/boot/workersAndCleanup.ts` registers **52** queue handlers (`registerHandler` call count in `server/services/workQueueHandlers.ts`) and asserts at boot that **9 required queues** have handlers (`server/boot/workersAndCleanup.ts:171-184`) — backed by a required-handlers smoke test (producer-without-handler protection).
- **FACT:** `server/boot/schedulerInits.ts` (920 lines) starts every scheduler with per-worker stagger offsets (`WORKER_STAGGER_OFFSETS`, `server/services/workerConfig.ts`) plus up-to-30s random jitter, and gates each via `system_settings` kill switches (`server/boot/schedulerInits.ts:107-160`).

### 7.2 Queue mechanics (the canonical async substrate)

**FACT** (all from `server/services/workQueueLease.ts` + `shared/models/workQueue.ts` + `WORKERS_QUEUES_RUNBOOK.md`):

| Property | Value |
| --- | --- |
| Claim | `FOR UPDATE SKIP LOCKED` single-row claim (`workQueueLease.ts:139-169`) |
| Lease | Leased→processing with heartbeats; stale-lease reaper; `stale_lease_exhaustion` terminal path |
| Retry | Exponential backoff base 10s, cap 600s; `max_attempts` 3 → `dead_letter` |
| Dedupe | Partial unique index on dedupe key **excluding terminal statuses** (`workQueue.ts:29-64`) — replayed chains additionally payload-step-gated in step-chained jobs |
| Poll | 5s default; Front lanes warp to 500ms under load |
| Concurrency | Workload classes via `acquireClassSlot`/`releaseClassSlot` (`workScheduler.ts:20-21,90-96`): interactive cap 1, ingestion default 3 (live-tunable 1–10 via `workload_class_ingestion_max_concurrency`), repair/maintenance caps (`workloadManager.ts`) |
| Pause/drain | Queue pause + drain control routes (`server/routes/queueControl*`, `server/services/queueDrainControl.ts`), pause-baseline backfill |

### 7.3 Schedulers and locks

- **FACT:** 10 node-cron scheduler files: `regressionSweepScheduler`, `appBackupScheduler`, `semrushGhostCleanup`, `rateLimitNotificationRetention`, `pendingDigestAlertsRetention`, `openAsksDigest`, `importGhostsSnapshot`, `dailyJudgmentScheduler`, `clientOffboardingScheduler`, `auditRetention` (all `server/services/`, `rg -l "cron.schedule"`). Plus numerous `setInterval` watchers started from `schedulerInits`.
- **FACT:** Cross-instance safety: run-once jobs take PG advisory locks via `server/services/crossInstanceLock.ts` with **per-job watchdog hold ceilings** in `CROSS_INSTANCE_LOCK_MAX_HOLD_MS` (`server/services/workerConfig.ts:8-68`); in-process locks layer via `server/services/workerLock.ts`. Advisory locks are why `workerPool` must stay on the DIRECT (session-affine) URL (`server/db.ts:18-45` comments).
- **FACT:** ~35 scheduler kill-switch keys exist (enumerated in `schedulerInits.ts` gates + the RUNBOOKS kill-switch/rollback table, `RUNBOOKS.md:234-300` region). Kill-switch *skips* are non-observations for alert-streak logic (watcher convention).

### 7.4 Failure detection and shutdown

- **FACT:** Dedicated watchers: queue starvation (`queueStarvationAlerts.ts` — idle counters), lease churn (`leaseChurnAlerts.ts`), stuck-processing alerts, backlog alerts with pause-aware baselines (`WORKERS_QUEUES_RUNBOOK.md`), notification-cleanup failure alerts, force-stop audit for stuck jobs. Alert delivery evidence lands in `notification_deliveries` + `user_notifications` (+ Slack when configured).
- **FACT:** Graceful shutdown: SIGTERM handler releases active leases and exits within a 5s cap without ending pools (`server/boot/shutdown.ts:17-35,162-176`).
- **Blast-radius model:** **INFERENCE** (from the mechanics above): a slow vendor saturates only its workload-class slots (ingestion cap) and its queue lanes back off to 600s; a slow DB trips hold-tier alerts + api-pool pressure shedding; Redis loss degrades settings/status caches to DB reads. The weakest containment is OpenAI (no master switch) and any code that bypasses the queue entirely (§7.5).

### 7.5 Governance-bypass vectors (where new code can dodge the model)

1. **FACT:** Fire-and-forget `void someAsync()` is the sanctioned annotation that disables the async-correctness hard-fail (`ASYNC_CORRECTNESS.md`) — a new "background job" can legally run as an unmanaged floating promise with no lease/retry/kill switch. Governor trigger: any new `setInterval`/floating-loop outside `schedulerInits`.
2. **FACT:** The 9-queue required-handler assert covers only the required set (`workersAndCleanup.ts:171-184`); a brand-new queue name with a producer but no handler fails only via the smoke test that checks registered handlers — new lanes must be added there, nothing forces it at compile time.
3. **FACT:** `lint-periodic-pool-ownership` judges pool tenancy by *imported symbol name*; dynamic `const { db } = await import(...)` destructures are its documented blind spot (lint header notes) — a periodic job can silently run on the API pool.
---

## 8. API and Interface Contracts

### 8.1 Route registration and inventory

- **FACT:** `registerRoutes(app)` (`server/routes.ts:99-180`) calls ~90 feature registrars (`registerXRoutes(app)`); a minority of modules also register endpoints directly (e.g. `server/routes/twilio.ts:692`). Total surface: **1,361 routes** (§3 claim 14).
- **FACT:** The committed inventory (`tests/route-inventory.json` + `tests/route-inventory-report.md`) is produced by a static parser that stitches multiline `app.METHOD(` openers and classifies each route's auth middleware and limiter coverage (`tests/route-inventory.ts:199-270`); regenerated by `scripts/regen-route-inventory.mjs`, freshness-linted in the gate, and auto-refreshed post-merge. A generated **endpoint contract table** (`audits/D-endpoint-contract-table.md`, columns method/path/source/auth/input/output/client/owner) is likewise freshness-linted (`scripts/lint-contract-table-freshness.ts`).

### 8.2 Authentication and authorization

- **FACT:** Session auth is Replit OIDC via Passport: `isAuthenticated` checks session user, expiry, revocation, and refreshes expired tokens (`server/replit_integrations/auth/replitAuth.ts:584-625,649-665`). Role ladder `sales < account_manager < team_lead < ceo` via `hasRole` + `requireCeo`/`requireTeamLead`/`requireAccountManager` (`server/routes/middleware.ts:187-221`); surface-specific gates `requireTwilioAccess` (`:256-285`), `requireCommandCenterAccess` (`:295-330`).
- **FACT:** Machine surfaces: `requireCeoToolsAuth` — Bearer token, constant-time SHA-256 compare against `CEO_TOOLS_API_TOKEN` (`server/routes/middleware.ts:225-254`); cron endpoints check `X-Cron-Key` against `CRON_SECRET` (`server/routes/adsOs.ts:1212-1213`).
- **FACT:** **There is no blanket `/api` auth guard.** `server/index.ts:192-244` mounts only limiters/request trackers plus the terminal `globalApiErrorHandler` (`:244`) and an `/api` 404 catch-all (`:246`); protection is per-route middleware arrays. Deliberately public: `/api/trends` GET (`server/routes/settings.ts:839`), `/api/phase-settings` GET (`:1531`), MCU practice-areas GET + evaluate POST (`server/routes/mcu.ts:10-18`); their write siblings add auth (`settings.ts:952,1552`).
- **INFERENCE:** The dominant authz failure mode is therefore *omission* — a new route with an empty middleware array ships publicly and nothing fails closed. The route inventory records auth classification, but no check asserts "new routes must be classified protected or explicitly allow-listed public". Governor candidate §13-G7.

### 8.3 Error contract

- **FACT:** A central error spine exists: `HttpError` (`server/observability/httpErrors.ts:77`), `asyncHandler` wrapper (`:108`), status/code resolution (`:123-143`), and `globalApiErrorHandler` mounted app-wide (`:144`; mounted `server/index.ts:244`), documented in `REQUEST_OBSERVABILITY.md` alongside request-ID plumbing and per-route p50/p95 metrics.
- **FACT:** Adoption is mixed: many modules still catch locally and return ad-hoc `{ error: ... }` shapes (e.g. `server/routes/conversationDedupeConflicts.ts:41-44`). So the *contract* is uniform only for unhandled paths.

### 8.4 Request validation

- **FACT:** zod is imported by 22 of 94 route files; 163 `.parse(`/`.safeParse(` call sites across `server/routes/` (rg counts). Strong examples: `server/routes/conversationDedupeConflicts.ts:52-55`, `server/routes/docs.ts:165`, `server/routes/clientFiles.ts:402`. Counter-examples destructure raw bodies: `server/routes/mcu.ts:16-25`, `server/routes/communications.ts:662-697`.
- **FACT:** drizzle-zod schemas exist for models (used in insert validation in places), but there is no rule that mutating routes must validate. **INFERENCE:** validation density correlates with newer code; older monolith routes are the untyped mass. Basis: file dates + density distribution.

### 8.5 Pagination and list bounds

- **FACT:** No shared pagination helper or cursor convention exists. Sampled: `limit` used directly (`server/routes/communications.ts:568-611`), page/limit→offset with SQL LIMIT/OFFSET (`:870-871,948-966`), defaults varying 20/25/50 with max 100 in the cited lines; `cursor` absent from `server/routes/` search output.
- **INFERENCE:** Some list endpoints are unbounded (no LIMIT at all); not exhaustively enumerated here. A deterministic scan is the governor's job (§13-G6). Basis: sampling + absence of any bounding convention.

### 8.6 Versioning and compatibility

- **FACT:** No API versioning (`/v1`, version headers) exists outside vendor URLs (repo-wide search). Client and server share types via `shared/`; the SPA is deployed atomically with the server (single artifact), so breaking route changes are same-deploy events. Compatibility discipline = contract-table diffs in review, not runtime versioning. **NOT JUSTIFIED** to add versioning for an internal single-deploy tool; the governor should instead watch contract-table diffs for removed/renamed routes still referenced by `client` column consumers.

### 8.7 Vendor types in core logic

- **FACT:** Vendor-specific types leak into route/core code: `TwilioOutboundOperationError` referenced in `server/routes/twilio.ts:2655,2734`; Zoom-specific error classes throughout `server/services/zoomIntegration.ts:120,510-563`; the `openai` SDK is imported directly by `server/routes/middleware.ts` and 5+ service files. There is no adapter-boundary rule today (§13-G2).

### 8.8 Rate limiting

- **FACT:** Centralized limiter definitions (`server/routes/middleware.ts:335-429`: `aiLimiter`, `writeLimiter`, `uploadLimiter`, `adminLimiter`, `adminReadLimiter`) plus `sensitiveWriteLimiter`; mounted by path lists in `server/routes/limiterMounts.ts` (`ADMIN_READ_PATHS` at `:128-201`) from `server/index.ts:192-234`. Known sharp edge: `app.use` mounts have no method filter, and the path-list coverage parser breaks on apostrophes in comments (documented in the mount file).

### 8.9 Cross-module interface points where future integrations couple

**INFERENCE** (synthesis): new integrations today couple at five seams — (1) queue payloads (untyped JSON contracts per jobType), (2) `system_settings` keys (credentials + kill switches; free-form key namespace), (3) the integration-status cache loader contract, (4) `external_call_audits` labels, (5) RUNBOOKS Integration Coverage Matrix row (predeploy-enforced). Only (5) fails closed today. The governor should make (1)–(4) explicit checklist items per new integration (§14).

---

## 9. Test Architecture and Runtime Economics

### 9.1 Current count definitions (authoritative at HEAD)

**FACT** (derived by importing `tests/testRegistry.ts` in a scratch script; cross-checked against file listing):

| Definition | Count |
| --- | --- |
| Registered suites (= `*.test.ts(x)` files under `tests/` + `client/src/` — every one carries a registration block) | **894** |
| Smoke-tagged (`"smoke": true`) — the `TEST_SMOKE=1` universe | **704** |
| Regression-tagged (`--regression` nightly sweep universe) | **734** |
| Both smoke+regression | **662** |
| Neither tag (run only in full `npm test`) | **118** |
| `.tsx` (jsdom/component) suites | **159** |
| Suites with `extraNodeArgs` (resolve-hook stubs/loaders) | **142** |
| Suites with `extraEnv` | **187** |
| Suites with custom `timeoutMs` (default 180s) | **40** |
| Suites declaring `scanPaths` (fs-read inputs for selection/fingerprint) | **65** |
| Quarantined | **0** (`QUARANTINE_LEDGER` empty — `server/services/regressionSweep.ts:51-63`) |

Historical-count conflicts are explained in §3.1. Prose counts anywhere (incl. `TESTING.md:9`'s "770+") should be treated as stale; only the registry derivation is authoritative.

### 9.2 Registration and discovery

- **FACT:** Every suite self-registers via a line-1 `/* test-registration */` JSON block; `name` required; supported keys as listed above plus `smokeReason`/`sweepOnlyReason`/`notes`; unknown keys rejected; the legacy `sharedDev` tag is explicitly retired (`tests/testRegistry.ts:16-135,226-308`). Discovery walks `tests/` + `client/src/` recursively for `*.test.ts(x)` (`:121-171`) — there is no central suite array to forget.
- **FACT:** Gate-membership policy is *enforced*: a regression suite must be smoke with a non-empty `smokeReason`, or non-smoke with a non-empty `sweepOnlyReason` — mutually exclusive, validated by `validateGateDecision` (`tests/testRegistry.ts:311-342`) and linted (`lint-smoke-gate-regression`, in gate). Smoke criteria: fast (<30s), deterministic, DB-light (`tests/testRegistry.ts:32-77`).

### 9.3 Execution model

- **FACT:** `tests/run-all.ts` runs suites **strictly one at a time** (serial invariant), batching compatible no-flag suites into shared `tsx` children to amortize boot, with solo re-verification of any batched failure and `--retry-failed=N`/`--sweep` support (`tests/run-all.ts:289-308,522-581`). Module-global state between batched suites is reset via a registered reset registry.
- **FACT:** Hermetic DB: a private local Postgres per run — template clusters cached by schema-content hash under `.local/hermetic-pg/templates/<hash>/`, per-run copy, full env injection, pooled/migration URLs unset; fallback is a uniquely named throwaway DB, never the shared dev DB; `server/db.ts` refuses Neon and `heliumdb` under test with no escape hatch (`tests/hermetic/provision.ts:9-35,152-194,620-647`; `server/db.ts:62-108`).
- **FACT:** Selection layers: (a) `TEST_SMOKE=1` filters to the smoke universe; (b) **related-smoke** (gate default) traces one shared esbuild import-closure BFS from changed files, includes `extraNodeArgs` shim trees and `scanPaths`, and *falls open to full* on any git/trace/parse error (`tests/relatedSmokeSelection.ts:11-51,131-215,378-395,584-615`); (c) **incremental green-skip** fingerprints Node version, lockfiles, runner modules, import-closure content, registration metadata, shim trees, per-suite DB-migration tree, and scanPaths — core suites never skip, greens expire after 7 days, `--force-all` bypasses (`tests/suiteFingerprint.ts:13-55,437-585`).
- **FACT:** Committed run artifacts: `tests/green-baseline.json` (750 suite records with `durationMs`, publishedAt 2026-08-08 — published only from fully-green main nightlies) and `tests/red-manifest.json` (currently 0 entries — upstream-red excusal rail). Flake history (`.local/runs/history/suite-history.json`) and skip audits are local-only, not committed.

### 9.4 Categories, fixtures, and network policy

- **FACT:** Category mix (static heuristics): 49 tx-sandbox DB suites (`runInTxSandbox` — one rolled-back transaction, nested tx→SAVEPOINT, `tests/db-sandbox.ts:141-170`); isolated-schema DB suites (clone tables into a scratch schema); route/server suites (spawned server or fetch stubs; only 4 import `TestHarness` directly); 159 jsdom component suites; 35 lint guard tests (`tests/lint-*.test.ts`) + `tests/gate-lint-phase.test.ts` (enforces every gate lint's CLI contract); source-scan/structural suites; **no registered puppeteer suites** (browser checks live in `scripts/verification-*` outside the registry).
- **FACT:** Network mocking is **suite-local convention, not enforced policy**: fetch stubs (`tests/helpers/createFetchStub.mjs`, per-suite `globalThis.fetch` overrides) and resolve-hook module stubs via `extraNodeArgs`; the only *enforced* egress guard is the DB one. **INFERENCE:** a suite that forgets to stub could reach a real vendor in dev runs — dead task-env credentials mask this today. Governor candidate: an offline-enforcement wrapper (§13 note under G8).
- **FACT:** Flake policy: repeat-offender = ≥2 failures in last 10 runs (local history); retries default zero; quarantine requires reason+expiry, applies only to full/regression runs, never removes a suite from smoke (`TESTING.md:26-29`; `server/services/regressionSweep.ts:51-75`).

### 9.5 DB behavior during tests

- **FACT:** Migrations are not replayed per run: templates are built once per schema hash (push-first genesis), so suite cost excludes migration time; per-suite DB-scoped migration fingerprints re-trigger only DB-sensitive suites when `migrations/` changes (`tests/suiteFingerprint.ts` DB-tree scoping). Test-mode pools set `idleTimeoutMillis=0` to avoid exit hangs.

### 9.6 Timing data and runtime economics

- **FACT** (committed data only): summed `durationMs` across the 750 green-baseline records ≈ **18.1 minutes of child-process runtime** (not wall time; excludes tsx boot amortization and the 144 suites without baseline records). `TESTING.md` (last commit 2026-08-08) records: gate lint+typecheck ≈ 1.6 min; full-smoke wall ≈ 25–30 min *for the 258-suite era (2026-08-05)*; predeploy incremental re-run ≈ 3.5 min.
- **UNKNOWN:** Full-smoke wall time at HEAD (704 suites). Every committed wall figure predates the 08-08/09 promotion of 352 suites (§3.1). *Safe measurement:* run the `Validate` workflow (`npm run gate`) once off-hours and read its final validation verdict; do not time it from an interactive shell. Publish the result into `TESTING.md`'s timing table.
- **The unbounded-growth mechanism:** **FACT:** nothing bounds portfolio cost. Membership is governed (smoke/sweep reasons), but (a) `smokeReason` is free text with no uniqueness/overlap requirement, (b) no per-suite runtime budget exists, (c) no aggregate smoke wall budget exists, (d) green-skip hides cost from developers day-to-day (skipped suites feel free until a fingerprint bust re-runs everything). An agent can keep adding suites indefinitely with zero pushback — the exact failure mode the governor must own (§13-G8/G9).

### 9.7 Layer mapping (current reality)

| Layer | Mechanism today | Evidence |
| --- | --- | --- |
| Focused development | `npm test -- --file=<suite>` (comma-separated, rejects unregistered) | **FACT:** `tests/run-all.ts:173-196` |
| Pre-merge / task gate | `npm run gate` — related-smoke default + 34 lints + typecheck | **FACT:** `scripts/gate.ts:204-216` |
| Deployment | `scripts/predeploy.sh` — hygiene lints + **incremental full test run** (green-skip; `PREDEPLOY_FULL_TESTS=1` forces all) | **FACT:** `scripts/predeploy.sh:154-195` |
| Scheduled heavy | Nightly regression sweep (`test:regression`, publishes green baseline + red manifest from main) + weekly force-all | **FACT:** `server/services/regressionSweepScheduler.ts`; `TESTING.md` |

**Candidate new-test justification rule** (for §13-G8): every new suite must state in its registration block (1) the unique failure mode covered, (2) why its layer is the lowest sufficient one, (3) any suite it supersedes, (4) expected runtime class. Fields (1) and layer-rationale partially exist as `smokeReason`/`sweepOnlyReason`; (3) and (4) do not.

---

## 10. Existing Gates and Fitness Functions

### 10.1 The two gate chains

**FACT:** There is no external CI (`.github/` absent). Quality enforcement runs in two places:

1. **Dev/task gate — `npm run gate`** (`scripts/gate.ts`): clean-scratch → typecheck (`tsc`) → **34 lints** (in-process worker pool; every lint must export side-effect-free `cliMain(): number` with an `isMain` guard — contract enforced by `tests/gate-lint-phase.test.ts`) → smoke tests (related-selection default; `--full-smoke`, `--no-smoke`, `--lint-only` flags) (`scripts/gate.ts:10-20,97-175,204-216`).
2. **Publish gate — `scripts/predeploy.sh`** (wired as the deployment build prefix, `.replit:12-15`): clean-scratch → worktree hygiene → SQL-array lint → migration-prefix lint → **runbook coverage** (`verify-runbook-coverage.ts`) → gate/workflow drift → Front triage lint → **incremental `npm test`** (full suite with green-skip) → `npm run build` (`scripts/predeploy.sh:14-195`).

**Historical FACT (superseded):** this inspection found two workflow roles.
**Current contract:** `.replit` has exactly three workflow roles: `Start
application` for the Run button, `Validate` running `npm run gate`, and
portless `Long validation` running the reviewed request command. The canonical
lint registry is `scripts/gate.ts` `LINT_CHECKS`;
`scripts/lint-gate-workflow-drift.ts` guards all three roles, their commands,
and protected application/artifact ports.

### 10.2 Gate check inventory

All checks fail closed (non-zero exit blocks). "Self-test" = a dedicated `tests/lint-*.test.ts` guard proves the check fires (35 such guard tests exist — `find tests -name 'lint-*.test.ts' | wc -l` = 35 — plus the phase-contract test covering all entries).

| Check (all registered in `scripts/gate.ts` `LINT_CHECKS`) | Invariant protected |
| --- | --- |
| typecheck (`npm run check` = `tsc`) | Type soundness |
| clean-scratch / lint-worktree-hygiene | Scratch confined to `.local/scratch`/`tmp`; junk patterns + root allow-list |
| lint-sql-array-bindings | `= ANY($n)` array-binding correctness in raw SQL |
| lint-getdb-attribution | DB calls carry hold-attribution labels |
| lint-db-pool-tenancy | Workers never use the API pool |
| lint-periodic-pool-ownership | Periodic jobs (interval/cron/sampler/boot-seeded) use `workerDb` by imported symbol |
| lint-apply-state-writers | Apply-pipeline state writes confined to sanctioned writers |
| lint-replit-md | `replit.md` size/section budget (≤114 lines) |
| lint-migration-prefixes | Migration filename ordering/uniqueness; frozen legacy snapshot hash-pinned |
| lint-oauth-refresh-single-flight | OAuth refresh POSTs go through the single-flight helper |
| lint-prod-actions-no-re-press | Prod actions are idempotent / no double-fire semantics |
| lint-front-sync-email-triage, lint-front-rematch-restrict-to-ids | Front pipeline invariants (triage path, rematch scoping) |
| lint-probe-swallow-into-unauthorized, lint-probe-refresh-purpose, lint-calendar-preview-probe-purpose | Probe semantics: probes never wipe/trip auth state |
| lint-test-hedge-comments, lint-test-shared-setting-pinning, lint-test-hermetic-db | Test hygiene: no hedge comments; global settings pinned+restored; no bare-tsx DB runs |
| lint-cross-instance-locks | Run-once jobs hold advisory locks |
| lint-keyword-canonical-lockstep, lint-heatmap-color-lockstep, lint-comms-shared-message-components | Cross-file lockstep invariants (keyword canonicals, heatmap palette, comms components) |
| lint-smoke-gate-regression | Registry gate-membership policy (§9.2) |
| lint-monolith-aggregator-size | Aggregator files can only shrink (ratchet) |
| lint-route-inventory-freshness, lint-contract-table-freshness | Generated route/contract artifacts match a fresh scan |
| lint-async-correctness | typescript-eslint 4-rule pack; `void` = sanctioned fire-and-forget; two-sided count ratchet (`ASYNC_CORRECTNESS.md`) |
| lint-website-bundle-freshness, lint-bundle-budget | Marketing bundle regenerated; client bundle chunk budgets |
| lint-upload-content-verification | Uploads verified at claim (size/magic bytes) |
| lint-test-file-parseability, lint-test-fs-scan-inputs | Registration blocks parseable; fs-scan suites declare `scanPaths` |
| lint-server-import-cycles | Zero static import cycles in server graph (dynamic `import()` = sanctioned break) |
| smoke phase | Behavioral regression net (related or full smoke universe) |

Predeploy-only additions: `verify-runbook-coverage.ts` (every root `*.md` indexed in RUNBOOKS + every Truth-Table integration has a matrix row) and gate/workflow drift re-check.

### 10.3 Bypass levers and tamper exposure

- **FACT:** Documented bypasses: `PREDEPLOY_SKIP_TESTS=1` skips the entire predeploy (emergency lever, `scripts/predeploy.sh:5-12`); `PREDEPLOY_FULL_TESTS=1` forces all suites; per-lint env skips exist for a handful (`LINT_MIGRATION_PREFIXES_SKIP`, `CLEAN_SCRATCH_SKIP`, `LINT_WORKTREE_HYGIENE_SKIP`, 4 feature-lint skips); `--no-smoke`/`--lint-only` on the dev gate. All are explicit env/flag actions — visible in command history but **not audited or alerted anywhere**.
- **FACT:** Tamper protection is partial: workflow↔gate parity is two-way linted; the frozen migration snapshot is content-hash-pinned; but **`scripts/gate.ts`, lint implementations, `tests/testRegistry.ts`, and `.replit` have no hash pinning or required-review mechanism** — an agent can weaken a lint by editing it, subject only to the lint's own guard test (which the same edit could delete). Governor candidate §13-G10.
- **FACT:** Everything above must be **preserved, not rebuilt** — the governor's deterministic layer should be *new `LINT_CHECKS` entries* following the existing cliMain/workflow/guard-test contract (`TASK_SELFCHECK.md:62-72` documents the wiring checklist).

---

## 11. Durable Architecture Memory

### 11.1 Document inventory and authority

**FACT:** 58 tracked root `*.md` files; `RUNBOOKS.md` (339 lines) is the declared canonical index (`RUNBOOKS.md:1-7`) with three normative tables: Runbook Index, Integration Runbook Coverage Matrix (predeploy-enforced), and operational matrices incl. the DB pool-tenancy table and the kill-switch rollback table. `replit.md` (112 lines, lint-capped at 114) is the orientation layer; its Runtime Truth Table is declared authoritative on runtime facts. `audits/` holds 31 files (lettered domain audits A–H + dated snapshots + the generated contract table).

| Document | Authority | Staleness at HEAD |
| --- | --- | --- |
| `replit.md` | Authoritative Truth Table + architecture summary | **FACT:** last commit 2026-08-07; size-linted, low rot risk |
| `RUNBOOKS.md` | Canonical index + coverage matrices | **FACT:** 2026-08-08; rows enforced by predeploy |
| `TASK_SELFCHECK.md`, `TASK_PREFLIGHT.md`, `TESTING.md`, `CODE_QUALITY.md`, `WORKTREE_HYGIENE.md` | Process contracts | **FACT:** all 2026-08-08; but TESTING.md's counts/timings already lag HEAD (§3.1, §9.6) — prose numbers rot in days here |
| Integration runbooks (FRONT, ZOOM, TWILIO×3, CLICKUP, SEMRUSH×3, GOOGLE_*, OPENAI, STRIPE, …) | Canonical per-subsystem | **FACT:** dates range 2026-05-13 → 08-09; oldest cluster (May) covers the most stable subsystems |
| `audits/A–H` | Point-in-time findings | **FACT:** A/E/F/G 08-07, B/D 08-09, H/EXEC 08-05, **C-db-performance 2026-05-21 — the stalest major audit**; D's contract table is the only continuously-fresh audit artifact (gate-linted) |
| `loom/screenshare-analysis-report.md` | One-off analyses | **FACT:** 2026-04-02; historical only |

### 11.2 What lives only in code, and what evaporates

- **FACT:** Facts with no durable doc besides code: the exact 34-lint gate list (`scripts/gate.ts:109-175`); predeploy ordering (`scripts/predeploy.sh:14-136`); migration filename policy mechanics (`scripts/lint-migration-prefixes.ts`); runbook-coverage algorithm (`scripts/verify-runbook-coverage.ts`); smoke-selection/fingerprint internals (`tests/relatedSmokeSelection.ts`, `tests/suiteFingerprint.ts`); pool history rationale (dated comments in `server/perfConfig.ts:26-36`).
- **INFERENCE:** What disappears between agent conversations is *decision rationale* — why worker max is 10 not 7, why `WORKER_DB_HEAVY_MAX_CONCURRENCY` is dead, why TestHarness fell out of favor — currently preserved only in code comments, task references, and the agent-private memory directory. Basis: the dead-config finding (§3 claim 4b) went unnoticed by prior audits.
- **Duplication:** **FACT:** pool sizes appear in 3+ places (`perfConfig.ts`, `replit.md` Truth Table, `RUNBOOKS.md` tenancy table) with a declared precedence (Truth Table wins); test counts appear in TESTING.md prose and rot (§3.1). Rule of thumb the repo already follows: **counts and lists belong in generated/linted artifacts, never prose**.

### 11.3 Smallest durable reference set the governor needs

**ADOPT NOW** (no new documents — this is the read list): `package.json`, `.replit`, `scripts/predeploy.sh`, `scripts/gate.ts`, `scripts/lint-gate-workflow-drift.ts`, `scripts/verify-runbook-coverage.ts`, `scripts/lint-migration-prefixes.ts`, `tests/testRegistry.ts`, `tests/gate-lint-phase.test.ts`, `TASK_SELFCHECK.md`, `RUNBOOKS.md` (+ the owning runbook for whatever subsystem is touched), `replit.md`, `server/db.ts` + `server/perfConfig.ts` (pool truth), `shared/models/workQueue.ts` + `server/services/workQueueLease.ts` (queue truth). **NOT JUSTIFIED:** a new architecture-doc tree; the repo's doc discipline (size-linted orientation file + enforced index + generated inventories) already beats a document jungle — the governor should add at most one decision-log file if the owner wants ADRs (§16).
---

## 12. Architecture Governor Trigger Matrix

The governor should key on **files touched**, **symbols referenced**, and **task language**. Patterns below are exact to this repo.

| Domain | File patterns / symbols | Task-language cues | Governor must run? |
| --- | --- | --- | --- |
| Schema & migrations | `shared/models/**`, `shared/schema.ts`, `migrations/**`, `drizzle.config.ts`; symbols `pgTable`, `db:push` | "add table/column", "migrate", "backfill", "rename field", "index" | **Yes — full DB lane** (ownership, growth, compat, index evidence) |
| DB pools & transactions | `server/db.ts`, `server/perfConfig.ts`; symbols `runWithWorkerDb`, `getDb`, `withDbAttribution`, `dbRetry`, `db.transaction`, `statement_timeout`, pool min/max | "pool", "timeout", "connection", "slow query", "deadlock" | **Yes — pools are the #1 protected asset** |
| Integrations & vendor SDKs | `server/services/<vendor>*`, new dep in `package.json`, new `system_settings` credential keys, `server/services/externalCallAudit*`; any new `fetch` to an external host | "connect X", "API key", "sync from", "import from", "webhook from" | **Yes — full integration checklist (§14.3)** |
| Webhooks | routes verifying signatures; secrets `FRONT_WEBHOOK_SECRET`, `ZOOM_S2S_WEBHOOK_SECRET_TOKEN`, `REV_AI_CALLBACK_SECRET`; `express.raw` body usage | "webhook", "callback", "notify us" | **Yes** — signature+timestamp, idempotency, durable correlation |
| Workers/queues/schedulers | `server/services/workQueue*`, `server/boot/schedulerInits.ts`, `server/boot/workersAndCleanup.ts`, `server/services/crossInstanceLock.ts`, `workerConfig.ts`, `workloadManager.ts`; symbols `registerHandler`, `enqueue*`, `cron.schedule`, `setInterval` | "background", "nightly", "poll", "queue", "worker", "scheduled" | **Yes** — class budget, lock, kill switch, terminal state, alerting |
| API contracts | `server/routes/**`, `tests/route-inventory.*`, `audits/D-endpoint-contract-table.*`; symbols `registerXRoutes`, `app.get/post/…` | "endpoint", "API", "route", "expose" | **Yes when routes are added/changed** — auth classification, validation, bounds |
| Auth & role boundaries | `server/replit_integrations/auth/**`, `server/routes/middleware.ts`, `server/routes/limiterMounts.ts` | "role", "permission", "public", "login", "token" | **Yes — human approval required (§14.6)** |
| New infrastructure/deps | `package.json` deps, `.replit`, `script/build.ts`, `vite.config.ts`, Dockerless runtime assumptions | "install", "add library", "switch to" | **Yes** — §4.5 reversibility check + bundle budgets |
| Test infrastructure | `tests/run-all.ts`, `tests/testRegistry.ts`, `tests/hermetic/**`, `tests/relatedSmokeSelection.ts`, `tests/suiteFingerprint.ts`, `scripts/gate.ts`, new lint scripts | "test runner", "fixture", "flaky", "speed up tests", "new check" | **Yes — gate-policy integrity lane** |
| Cross-module refactors | moves touching >10 files, barrel splits, `server/routes.ts`/`server/index.ts` edits | "reorganize", "split", "extract", "rename module" | **Yes** — §4.4 boundary + cycle rules |
| Scale/retention changes | retention prunes, new append-heavy tables, `*Retention.ts`, object-storage prefixes | "keep forever", "history", "10×", "high volume", "archive" | **Yes** — growth forecast lane (§5.5) |

**Should NOT trigger** (explicit negative list): isolated client copy/styling/component changes under `client/src/` with no new query/route; content edits under `website/` (its own freshness lint governs); individual test *content* edits that don't touch the registry/runner/harness; doc edits; `attached_assets/`/`artifacts/` changes; single-suite additions that follow the registration contract (the registry lints govern those) — unless they add `extraNodeArgs` loaders or global fixtures.

---

## 13. Candidate Deterministic Guards

Recommended additions to `scripts/gate.ts`'s existing `LINT_CHECKS` pattern (cliMain contract + workflow mirror + guard test — `TASK_SELFCHECK.md:62-72`). None are built yet. "Baseline" = needs a frozen-snapshot ratchet because existing debt would fail day one (repo convention: derive allowances from one hash-pinned artifact, never hand-edited allow-lists).

| # | Guard | Invariant | Inspects | FP risk | Baseline? | Intentional-failure proof | Stage | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | Dependency cycles | Zero static server import cycles | *exists* — `lint-server-import-cycles` | — | — | guard test exists | gate | **ADOPT NOW = preserve as-is** |
| G2 | Vendor-SDK adapter confinement | SDK packages (`openai`, `twilio`, `stripe`, `@google-cloud/*`, `livekit-server-sdk`, `@upstash/redis`) importable only from their owning module dir | import graph (reuse the esbuild tracer from related-smoke) | Low — import edges are unambiguous | **Yes** — openai's 6+ importers (§4.4) | temp file importing `openai` outside allowlist must fail | gate | **ADOPT NOW** |
| G3 | Pool ownership | Workers never on apiPool; periodic jobs on workerDb | *exists* — `lint-db-pool-tenancy` + `lint-periodic-pool-ownership` | known blind spot: dynamic `{db}` destructures | has markers | guard tests exist | gate | **ADOPT NOW = extend to dynamic-import destructures (AST)** |
| G4 | Direct DB access outside approved owners | New `server/routes/*` files may not import `db` directly (services own queries) | per-file import scan, new-files-only ratchet | Medium — sanctioned inline SQL exists (`server/routes.ts:85-97`) | **Yes** — 47 route files already import db | new route file importing db must fail | gate | **DEFER UNTIL owner endorses the routes→services direction; enforcing a DAO layer repo-wide is NOT JUSTIFIED (729 files)** |
| G5 | Integration-registry completeness | Every outbound vendor (new fetch host / SDK / credential key) has: RUNBOOKS matrix row, status-cache loader, kill switch, `external_call_audits` label | cross-reference audit-wrapper labels + matrix rows + settings keys | Medium — host extraction from dynamic URLs | Small | delete a matrix row → must fail | predeploy (matrix half already there) + gate for labels | **ADOPT NOW (incremental)** |
| G6 | Unbounded-read protection | List routes must bound results (`.limit(`/`LIMIT`/pagination helper) | AST: drizzle `.select(` chains + raw `sql` SELECTs in `server/routes/**` without a bound | **High** — COUNT(*)/single-row/EXISTS shapes; needs shape whitelist | **Yes** — unknown existing count | strip `.limit()` from a known route → must fail | gate, warn-first for one week then fail | **ADOPT NOW (ratchet form)** |
| G7 | Route auth classification | New routes must be classified: protected middleware present, or path in an explicit `PUBLIC_ROUTES` allow-list | extend `tests/route-inventory.ts` parser output — diff new routes' auth column against allow-list | Low — parser already classifies | **Yes** — freeze current public set | add unauthenticated route → must fail | gate | **ADOPT NOW** |
| G8 | New-test justification | New suites declare failure-mode + layer rationale + supersedes + runtime class | registration-block keys (registry already rejects unknown keys — add optional keys first) | Low mechanical / high judgment (governor reviews text) | No | new suite missing keys → must fail | gate (mechanical part) | **DEFER UNTIL governor skill exists to consume the fields** |
| G9 | Test runtime budgets | Per-suite `durationMs` ≤ class budget vs green-baseline; aggregate smoke budget | `tests/green-baseline.json` diff | Medium — duration noise across machines | **Yes** — needs a trustworthy HEAD baseline first (§9.6 UNKNOWN) | inflate a duration → must fail | scheduled (nightly) first; gate later | **DEFER UNTIL the §9.6 wall-time measurement is captured** |
| G10 | Gate-policy integrity | `scripts/gate.ts`, `tests/testRegistry.ts`, lint list, `.replit` deploy block change only with an explicit ack token | hash manifest + `GATE_POLICY_ACK` file/commit-message token | Low | manifest = the baseline | edit gate.ts without ack → must fail | gate + predeploy | **ADOPT NOW** |
| G11 | Migration immutability & compat | Applied migrations never edited (content hash ledger); new migrations screened for `DROP`/`NOT NULL` w/o default | extend `lint-migration-prefixes` with a content-hash ledger + SQL keyword screen | Medium on compat heuristics (legit drops exist) | **Yes** — hash current 190 files | edit an old migration → must fail | gate | **ADOPT NOW (immutability); DEFER (compat heuristics) UNTIL owner defines expand-contract policy (§16)** |
| G12 | Queue governance completeness | Every `registerHandler` queue name has: producer, class assignment, kill switch, alert coverage | static scan of `workQueueHandlers.ts` + `schedulerInits` + settings keys | Medium — naming conventions vary | Small | register handler w/o kill switch → must fail | gate | **DEFER UNTIL [next new queue lane lands] — required-handlers assert covers today's 9 critical lanes** |

**NOT JUSTIFIED at this scale:** microservice/module federation boundaries; runtime API versioning (§8.6); replacing the hand-rolled runner with an external framework (894 suites depend on the registration contract); RLS/tenant isolation (single-org, §5.2); an external queue broker (in-PG queue is instrumented and load-appropriate).

---

## 14. Proposed Governor Package Inputs

For the future `.agents/skills/architecture-governor/` (not built here).

1. **Trigger description (exact):** run when the task or diff matches §12's positive matrix; skip on the negative list. Cheap classifier: `git diff --name-only` against the file patterns + task-text keyword scan.
2. **Workflow stages:** (a) classify domains touched → (b) pull evidence *only* from the §11.3 read list + owning runbook → (c) walk the domain checklist (below) → (d) write a short decision record into the task (not a new doc) → (e) emit deterministic-guard deltas (new lint entry or baseline update) when the change class recurs.
3. **Domain checklists (the heart of SKILL.md):** DB: owner module, pool tenancy, growth class, index evidence, migration compat. Integration: §8.9's five seams + §6.2 weakness patterns (timestamped signature, idempotency key, durable correlation, breaker, kill switch, dead-letter path, matrix row). Queue/worker: class slot, lock, terminal state, alert, drain. API: auth classification, zod on mutations, bounds, contract-table regen. Tests: layer, justification fields, runtime class.
4. **SKILL.md (short):** triggers + non-triggers, the five checklists in table form, the §11.3 read list, links to reference files. **Reference files (conditional):** one per domain lane with this report's relevant section distilled; a `historical-failures.md` from §17. **Scripts warranted:** G2, G5, G6, G7, G10, G11-immutability (§13) as `scripts/lint-*.ts` following the cliMain contract.
5. **Existing commands the skill must reuse (never reinvent):** `npm run gate` (+ `--lint-only`), `npm run check`, `npm test -- --file=…`, `npx tsx scripts/regen-route-inventory.mjs`, `node scripts/generate-endpoint-contract-table.mjs`, `npx tsx scripts/verify-runbook-coverage.ts`, `npm run db:push` (never raw DDL against dev), the registration-block contract for any new test.
6. **Non-negotiable invariants (from current code):** three-pool tenancy + `runWithWorkerDb` scoping; hermetic test DB (no dev/prod DB in tests, no escape hatch); queue jobs = leased + bounded retries + terminal state + dedupe key; every scheduler behind a kill switch + stagger; OAuth refresh single-flight; migration filenames append-only UTC-prefixed; every root doc indexed; every gate lint side-effect-free with guard test; smoke membership requires reasons.
7. **Human approval required before build:** schema drops/renames on populated tables; pool size/timeout changes; new vendor integration or new credential; auth/role boundary changes; anything touching `scripts/gate.ts`/`tests/run-all.ts`/`tests/testRegistry.ts`/`.replit` deploy block; retention/deletion policy changes; new always-on background load.
8. **Reversible without ADR/approval:** additive columns with defaults; new queue lanes following the full checklist; new routes matching auth+validation+bounds conventions; new tests following the registration contract; UI work; new lints (additive).
9. **Historical failure scenarios → forward prompts:** §17.

---

## 15. Current Risk Register

Ordered by (impact × likelihood), all tied to evidence above.

| # | Risk | Evidence | Existing mitigation | Governor action |
| --- | --- | --- | --- | --- |
| R1 | Unbounded/costly list queries degrade the 18-conn API pool under data growth | §8.5 no bounds convention; §5.4 stale DB audit | statement_timeout 30s; hold alerts; pressure shedding | G6 + refresh C-audit (§16) |
| R2 | New route ships unintentionally public | §8.2 no blanket guard; omission = public | inventory *records* auth; humans review | G7 allow-list check |
| R3 | Vendor SDK sprawl (OpenAI) defeats breaker/kill-switch containment | §4.4, §6.2 — 6+ direct importers, no master switch | per-service retry only | G2 + OpenAI kill switch as first governed refactor |
| R4 | Duplicate outbound side effects on vendor timeout (Twilio send, Calendar event) | §6.2 runbook-documented weaknesses | 429-only retries; booking-row idempotency | idempotency-key checklist item; targeted fix tasks |
| R5 | Webhook replay/forgery window (Front body-only HMAC, no timestamp) | §6.2 | secret required; receiver hardened per PROD_REMEDIATION.md | timestamped-signature invariant on any webhook change |
| R6 | Smoke wall time grows unbounded; devs route around the gate | §9.6 mechanism; 352-suite jump in one commit | green-skip; related-selection | measure (§9.6), then G9 budgets + G8 justification |
| R7 | Gate weakening by edit (no policy pinning) | §10.3 | guard tests; workflow parity lint | G10 ack-token manifest |
| R8 | Migration edited after apply → dev/prod schema drift | §10.4 filename-only lint | frozen legacy snapshot hash | G11 content-hash ledger |
| R9 | Monolith files (10k+ lines) grow until unmaintainable/merge-hazardous | §4.3 | aggregator-only ratchet | extend size ratchet to top-5 feature files (frozen baseline) — **DEFER UNTIL next major edit touches one** |
| R10 | Single-process blast radius: worker stampede or OOM takes the API down with it | §7.1 same-process; §7.4 5s shutdown | class slots; stagger+jitter; leases survive restart | keep; add "new always-on load needs approval" (§14.7) |
| R11 | Dead config misleads future work (`WORKER_DB_HEAVY_MAX_CONCURRENCY`) | §3 claim 4b | none | governor flags zero-consumer config on touch |
| R12 | Doc-prose counts rot within days (TESTING.md counts already stale) | §11.2 | generated artifacts for routes/contracts | rule: counts only in generated/linted artifacts |

---

## 16. Unknowns Requiring Owner Input

1. **UNKNOWN — growth horizon:** expected 12–24-month growth in clients, communications volume, and recordings; which tables are expected to 10×. Needed to size G6 budgets and index work. (§5.5 prescriptions.)
2. **UNKNOWN — smoke wall-time budget:** what gate latency is acceptable to developers (current HEAD wall time itself unmeasured — §9.6). Blocks G9.
3. **UNKNOWN — expand-contract policy:** is zero-downtime deploy required (Reserved VM restarts briefly on publish today)? Determines G11's compat strictness and whether destructive migrations need staging. (§5.3.)
4. **UNKNOWN — integration criticality tiers:** which vendors are business-critical (blast-radius priority for breakers/kill switches) vs best-effort. Shapes §6.2 invariant ordering.
5. **UNKNOWN — appetite for the OpenAI adapter refactor:** G2 confines future imports cheaply, but consolidating the existing 6+ importers is a real refactor needing sign-off. (R3.)
6. **UNKNOWN — ADR appetite:** does the owner want a lightweight decision log (one file), or should decision records stay in task history only? (§11.3 verdict pending this.)
7. **UNKNOWN — backup/restore objectives:** daily `pg_dump` exists (`BACKUPS.md`); acceptable RPO/RTO was never stated. Determines whether restore drills become a scheduled check.
8. **UNKNOWN — bypass-lever alerting:** should `PREDEPLOY_SKIP_TESTS=1` and lint-skip envs page/notify anyone? (§10.3 — currently silent.)

---

## 17. Historical Failure Prompts for Benchmarking

Documented incident classes from this repo's runbooks/remediation docs, phrased as forward-evaluation prompts the governor should ask on matching changes. Each is grounded: the failure happened here.

| # | Prompt (ask when…) | Grounding |
| --- | --- | --- |
| P1 | *Concurrent writes:* "Does this SELECT-then-INSERT path collide under concurrent execution? Where is the ON CONFLICT or advisory lock?" (any new upsert/dedupe write) | dup-key storms under autoscale led to the work-queue dedupe index + per-unit locks (`shared/models/workQueue.ts:29-64` design) |
| P2 | *OAuth rotation:* "Can two callers refresh this token simultaneously? Route it through the single-flight helper." | rotation races corrupted Front/Zoom tokens → `lint-oauth-refresh-single-flight` exists |
| P3 | *Webhook truth:* "Prove one real signed delivery end-to-end before trusting the receiver." | Front receiver ran with unset secret + body-only HMAC and had never seen a real delivery (`PROD_REMEDIATION.md`) |
| P4 | *Queue symmetry:* "New producer → where is the handler? New handler → does a producer exist?" | producer/handler mismatches caused silent dequeue failures → 9-queue boot assert + required-handlers smoke test |
| P5 | *Replay forks:* "If this queued chain is replayed after completion, does the payload step-gate no-op?" | replayed step-chained jobs forked live chains until payload-step authorization was added |
| P6 | *Hold time:* "What is this code path's worst-case DB hold? Which tier (1s/10s/30s) will it trip?" | long-held transactions starved the API pool → hold-attribution + tier alerts (`server/db.ts:700-760`) |
| P7 | *Cache pinning:* "After this settings write, which cached readers stay stale for ≤300s, and does anything latch that staleness?" | settings-cache miss-pinning made raw-SQL config edits invisible; hydration latches re-froze stale reads (`INTEGRATION_STATUS_CACHE.md` cold-read notes) |
| P8 | *Publish schema diff:* "Does prod contain runtime tables dev lacks? Will publish propose dropping them?" | publish diff nearly dropped prod-only runtime tables; dev DB is the schema source |
| P9 | *Probe semantics:* "Can this health probe wipe credentials or trip a global breaker on one failure?" | probes wiping tokens / single-401 disconnects → three probe-purpose lints in the gate |
| P10 | *Silent gate rot:* "Is this check actually in the gate, or merely tagged?" | regression-tagged-but-not-smoke suites rotted silently → `lint-smoke-gate-regression` + registry reasons |
| P11 | *Vendor timeout duplicates:* "If the vendor call times out after the side effect, what stops the retry from doubling it?" | Twilio duplicate-send risk on non-429 timeout (`TWILIO.md`) |
| P12 | *Restart-safe correlation:* "If the process restarts mid-flow, is the webhook/job correlation durable?" | TwelveLabs in-memory correlation lost on restart (`TWELVELABS.md`) |

---

## 18. Evidence Index

### 18.1 Repository state

- HEAD at start and end of investigation: `63e529e6a06fcfe8f43165885757f28fcfac6464` (branch `main`); worktree clean at start except two pre-existing untracked `attached_assets/Pasted-*.txt` uploads; at end, additionally only this report and the one `RUNBOOKS.md` index row (§2.3). No other file created or modified; no tests/migrations/workers/builds/external calls executed (§2.2).

### 18.2 Primary evidence files (by lane)

| Area | Files (all at HEAD) |
| --- | --- |
| Runtime/deploy | `package.json` (scripts:6-18), `.replit` (deploy:12-15; workflows), `script/build.ts`, `vite.config.ts:204-219` |
| DB/pools | `server/db.ts` (pools 770-876; guards 62-108; context 1058-1085; retry 1098-1142; pressure 974-1003), `server/perfConfig.ts:22-36`, `drizzle.config.ts`, `shared/schema.ts`, `shared/models/*` (232 pgTable), `migrations/` (190 .sql + meta journal), `docs/pool-epic-baseline.md` |
| Queue/workers | `shared/models/workQueue.ts:29-64`, `server/services/workQueueLease.ts:139-169`, `server/services/workQueueHandlers.ts` (52 registrations), `server/boot/workersAndCleanup.ts:171-184`, `server/boot/schedulerInits.ts` (920 lines), `server/services/{workerConfig,workerLock,crossInstanceLock,workScheduler,workloadManager}.ts`, `server/boot/shutdown.ts:17-35,162-176`, 10 cron files (§7.3), `WORKERS_QUEUES_RUNBOOK.md` |
| Routes/API | `server/routes.ts:85-180`, `server/routes/middleware.ts:187-429`, `server/routes/limiterMounts.ts:128-201`, `server/observability/httpErrors.ts:77-159`, `server/index.ts:192-246`, `server/replit_integrations/auth/replitAuth.ts:584-665`, `tests/route-inventory.ts:199-270`, `tests/route-inventory.json` (1,361 routes — freshness-verified at HEAD), `audits/D-endpoint-contract-table.md` |
| Integrations | `server/services/` vendor modules per §6.1; runbooks `FRONT.md`, `ZOOM.md`, `TWILIO*.md`, `GOOGLE_*.md`, `CLICKUP.md`, `SEMRUSH_*.md`, `OPENAI.md`, `STRIPE.md`, `PANDADOC.md`, `TWELVELABS.md`, `TRANSCRIPTION_PROVIDERS.md`, `SENDGRID.md`, `GEOSPATIAL_APIS.md`, `KEEP_ALIVE_RUNBOOK.md`, `INTEGRATION_STATUS_CACHE.md`, `EXTERNAL_CALL_AUDIT.md`; `RUNBOOKS.md:67-115` coverage matrix |
| Tests | `tests/run-all.ts:118-196,289-308,522-581`, `tests/testRegistry.ts:16-342`, `tests/hermetic/provision.ts:9-647`, `tests/relatedSmokeSelection.ts`, `tests/suiteFingerprint.ts`, `tests/db-sandbox.ts:141-170`, `tests/test-harness.ts`, `tests/green-baseline.json` (750 records), `tests/red-manifest.json` (0), `TESTING.md`, `server/services/regressionSweep.ts:51-75` |
| Gates/docs | `scripts/gate.ts:10-216`, `scripts/predeploy.sh:5-195`, `scripts/lint-gate-workflow-drift.ts:40-54`, `scripts/verify-runbook-coverage.ts`, `scripts/lint-migration-prefixes.ts:49-419`, `scripts/lint-replit-md.ts:54-79`, 35 `tests/lint-*.test.ts` + `tests/gate-lint-phase.test.ts`, `replit.md` (112 lines), `RUNBOOKS.md` (339), `TASK_SELFCHECK.md`, `audits/*` (31 files, dated §11.1) |

### 18.3 Derivation commands (reproducible)

Counts in this report reproduce with: registry derivation (`import { deriveRegistry } from "./tests/testRegistry"` in a scratch script); `rg --files tests client/src | rg '\.test\.tsx?$' | wc -l` (894); `rg -c pgTable shared/models/*` summed (232); `ls migrations/*.sql | wc -l` (190); `wc -l` on §4.3 files; `rg -l "cron.schedule" server --glob '*.ts'` (10); `npx tsx scripts/lint-route-inventory-freshness.ts` ("OK, 1361 routes"); `find tests -maxdepth 1 -name 'lint-*.test.ts' | wc -l` (35); `git log -1 --format=%cs -- <doc>` for §11.1 dates; `git ls-tree -r <dated-commit> --name-only | grep -c '\.test\.ts'` for §3.1 growth points.

### 18.4 Label totals

Exact totals for **FACT** / **INFERENCE** / **UNKNOWN** markers in this report are stated in the completion summary delivered with the report (counted by `grep -o` over the final file). Every FACT above carries a path plus line range or symbol; INFERENCE states its basis; UNKNOWN states a safe measurement path where one exists.
