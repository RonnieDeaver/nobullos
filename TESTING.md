# Testing & Pre-Deploy Gate

Operator runbook for the test harness, the hermetic per-run test database (**Task #3797**), and the autoscale pre-deploy test gate (**Task #1006**; registration convention reworked by **Task #3786**).

## Test suite

NoBull OS includes a route inventory, API test harness, mismatch report, and deterministic test data seeder.

- **Full suite:** `npm test` — 1,000+ registered suites. The current smoke/regression membership is generated in `audits/governance/test-portfolio-baseline.json`; the count below is a historical measurement, not a live registry claim. Incremental by default (Task #3791, below): suites green on identical inputs skip.
- **Regression sweep:** `npm run test:regression` — the tests registered `"regression": true` (nightly sweep + on-demand). Also incremental; the nightly scheduler forces one full integrity run per week.
- **Smoke gate:** `TEST_SMOKE=1 npm test` — the tests registered `"smoke": true`; this is the existing manual/operator-triggered smoke audit with related-selection narrowing (Task #3755 — see `tests/relatedSmokeSelection.ts`), not routine task-completion validation.
- **Force full execution:** append `--force-all` (e.g. `npm test -- --force-all`) or set `TEST_FORCE_ALL=1` in any mode to bypass green-skipping entirely.
- **Single suite(s):** `npm test -- --file=tests/<name>.test.ts[,more]` — the sanctioned way to run one registered suite under the hermetic backend (a bare `NODE_ENV=test npx tsx tests/x.test.ts` is refused by the DB guard unless you provision env yourself).

### Generated artifact ownership in related selection

Related selection normally follows import closures and declared `scanPaths`. Two
committed generated artifact families have an additional, **closed** ownership
contract because their guard suites read inputs through the filesystem:

| Family | Outputs | Declared inputs | Owning smoke guard | Verification before narrowing |
| --- | --- | --- | --- | --- |
| Route inventory | `tests/route-inventory.json`, `tests/route-inventory-report.md` | live route tree, parser, generator, freshness lint | `tests/lint-route-inventory-freshness.test.ts` | `lint-route-inventory-freshness` re-scans the live route tree |
| Endpoint contract table | `audits/D-endpoint-contract-table.{json,md}` | route inventory; recursive caller scans in `client/src/` (`.ts/.tsx/.js`), `scripts/` (`.ts/.mjs/.sh`), `tests/` (`.ts/.tsx`), and `server/services/` (`.ts`); route handlers; generator/classifier/freshness lint | `tests/lint-contract-table-freshness.test.ts` | `lint-contract-table-freshness` checks the inventory and both outputs |
| Test portfolio baseline | `audits/governance/test-portfolio-baseline.json` | test registry; portfolio generator and shared governance-inventory helper | `tests/governance-test-portfolio-baseline.test.ts` | the portfolio generator's `--check` re-derives registry facts and verifies the committed hash |

When a declared input or output changes, the selector runs the named existing
freshness guard before narrowing and selects the owning guard plus all ordinary
import/`scanPaths` matches and the existing core. It prints the family and
verification evidence in the selection summary. Missing files, a malformed
ownership declaration, a stale/unverifiable output, or any unregistered test
infrastructure artifact **falls open to the full smoke universe**. Do not add a
generated artifact by filename convention; add an explicit ownership contract,
freshness guard, and focused regression proof first.

## Durable long-run validation

The repository uses exactly two Replit workflow roles: **Start application**
is the only Run-button/webview role on port 5000, and **Long validation** is
the sole portless console role for reviewed controls. The Mockup Sandbox is a
separate artifact preview on port 23636. Do not create a workflow for an
individual lint and never repurpose the application or artifact preview for a
control: run focused commands directly from the CLI instead.

Use the permanent **Long validation** console workflow for an explicitly
requested canonical gate, long control, or matched comparison. Its
`routine-gate` profile is the durable wrapper around the existing `npm run
gate` command; the other profiles wrap `npm test`. It does **not** change
selection, green-skips,
baselines, sharding policy, retries, test timeouts, or duration budgets.

`full-control` and `matched-comparison` are **main-workspace-only
central-integrity actions** — the reviewed operator path for an explicitly
requested central control, never a task-completion fallback. The runner
detects a task/sub-environment with the same structural classifier the
regression-sweep publisher uses (`server/lib/subEnvironment.ts`: REPL_ID
shape plus the `main-repl` git remote — never an inherited env var, since
Secrets and shared env vars both propagate into task-branch clones) and
refuses those two profiles before it captures source provenance, allocates a
run directory, acquires the lock, or spawns a child, even given an otherwise
valid request file. `focused-test` and `routine-gate` remain available,
unaffected, as the bounded path for an operator choosing to validate a diff
manually; neither is a required per-task step, and the default for a routine
task agent is to run neither — not even a single lint script or one test file
as a self-check substitute — and instead let Replit's own built-in completion
review validate the diff (owner decision, 2026-08-26; see
[§ Bounded task-validation policy](#bounded-task-validation-policy-owner-approved)).
Scale does not change that default: a "small" targeted check is still a gate
lane and still opt-in, not a lighter-weight required step. Validation is
operator-owned or scheduled; a task agent does not run an exception for its
own work.

1. Create `.local/runs/long-validation-request.json` with one reviewed profile:

   ```json
   { "schemaVersion": 1, "profile": "routine-gate" }
   ```

   ```json
   { "schemaVersion": 1, "profile": "focused-test", "files": ["tests/example.test.ts"] }
   ```

   ```json
   { "schemaVersion": 1, "profile": "full-control", "control": "static-4" }
   ```

   ```json
   { "schemaVersion": 1, "profile": "matched-comparison" }
   ```

2. Start **Long validation**. Its stable command is `npm run validate:long --
    --request .local/runs/long-validation-request.json`; do not edit workflow
    configuration to run a control. For focused lint debugging, run
    `npx tsx scripts/lint-<name>.ts` directly; it does not need or receive a
    separate workflow.

The runner permits no command text, shell arguments, arbitrary environment
values, or path traversal in the request. Full controls allow only `serial`,
`static-4`, or `dynamic-4`; a matched comparison runs the static and dynamic
four-lane controls sequentially under the same declared envelope. Controls
capture the current Git revision plus a working-tree content fingerprint and
fail if either changes mid-run. This lets operators validate the current diff
without letting the two controls observe different source. Only one job
can be active; an abandoned dead-owner lock is recovered
after six hours, never while its process is live.

Before a child starts, the runner creates a unique directory under
`.local/runs/long-validation/`. It retains the normalized immutable request,
source/provenance hashes, lifecycle manifest, per-stage redacted raw log, and
immediate report snapshots. A nonzero exit, timeout, cancellation, kill,
missing fresh report, or source change is recorded as failed and makes the
console workflow fail. Lifecycle metadata holds only status/timing/provenance
hashes and report digests—not test output, commands, environment values, or
secrets. A matched pair is point evidence only; it does not create
longitudinal performance evidence or authorize a policy change.

Each run also writes a redacted `events.jsonl` state trail
(`queued`, `running`, `succeeded`, `failed`, or `interrupted`) and the namespace
maintains a compact `index.json` with terminal status, elapsed time, per-stage
outcome, stale-lock recovery, and cleanup disposition. The index and events
never contain raw child output, command lines, environment values, secrets, or
focused test paths. Retention is intentionally isolated: only direct completed
run directories below `.local/runs/long-validation/` are eligible, with a
14-day evidence window, then a 20-completed-run / 256-MB cap. Current locks,
symlinks, malformed names, and evidence inside the window are retained or
reported—not deleted. Generic scratch cleanup never traverses this namespace,
and no other `.local/runs` evidence, platform state, Mockup Sandbox file, or
application log is eligible.

### Long-control troubleshooting and rollback

- A completed run exits 0 only when its declared stages succeeded. A failed,
  cancelled, timed-out, killed, source-changed, missing-report, or malformed
  run exits nonzero and retains its unique evidence directory. Do not infer an
  outcome from a shared `full.log`, `full.done`, pipe, or wrapper status.
- Inspect that run's `events.jsonl`, `index.json`, lifecycle manifest, and
  per-stage redacted raw log/report snapshot under
  `.local/runs/long-validation/<run-id>/`. The request, command-line, and
  event/index data are deliberately redacted; raw child output remains only in
  the run's stage directory.
- If a live owner died, the runner recovers only a stale six-hour lock. Do not
  delete an active lock or evidence directory to force another run.
- To roll back a workflow configuration change, restore the exact two-role
  topology and port ownership encoded by `scripts/lint-gate-workflow-drift.ts`,
  then inspect the guard against `.replit`; use **Long validation** if an
  operator separately requests the canonical gate. Rollback never means
  borrowing Start application or Mockup Sandbox capacity, changing their
  commands, or widening long-control cleanup.


## Hermetic per-run database (Task #3797)

Every test run provisions a **private, throwaway Postgres** — tests never touch the shared Helium dev DB, so they cannot fight the dev server or each other across runs.

- **Provisioner:** `tests/hermetic/provision.ts`. Local Postgres 16 cluster in `/tmp/nobull-hermetic/run-*/` (CI-tuned: fsync off, local socket, `pg_stat_statements` preloaded). Falls back to a uniquely named throwaway DB on the dev instance if local binaries are ever missing.
- **Schema:** built through the app's own path — `drizzle-kit push` → dev-migration ledger baseline (`server/devMigrations.ts`) → post-merge SAFE re-apply list (parsed from `scripts/post-merge.sh`, single source) → the server's boot ensures → baseline seed (synthetic `test` user, kill-switch seeds, `client_code_seq`).
- **Template cache:** the migrated DB is snapshotted under `.local/hermetic-pg/templates/<schema-hash>/` keyed on a schema-content hash; runs clone it in seconds. Templates rebuild automatically when migrations/schema/bootstrap inputs change.
- **Child env:** the runner injects every connection-string variant (`DATABASE_URL`, `DATABASE_URL_DIRECT`, `PGDATABASE_URL`, `PG*`) and **unsets** `DATABASE_URL_POOLED`/`DATABASE_URL_MIGRATIONS`; children also get a per-run Redis key namespace (`NOBULL_TEST_CACHE_NAMESPACE`) so live cache can't contradict hermetic DB state.
- **Guards:** in test mode `server/db.ts` refuses prod Neon **and** the shared dev DB (`heliumdb`) — unconditionally. There is no escape hatch: the per-suite `sharedDev` tag was retired (the registry rejects it), and the whole-run `TEST_SHARED_DEV_DB=1` legacy mode was retired in Aug 2026 once confirmed unused (nothing set it besides the guard test that proved it worked). Hermetic is the only mode; the flag is now inert and `tests/hermetic-db-guard.test.ts` proves setting it no longer admits the shared dev DB.
- **Doctor/CLI:** `npx tsx tests/hermetic/provision.ts --doctor | --build-template | --provision-smoke`.
- **Guard lint:** `scripts/lint-test-hermetic-db.ts` (in `npm run gate` + workflow) blocks raw `pg` pools, `heliumdb` literals, and self-granted `TEST_SHARED_DEV_DB` in `tests/**`. Deliberate exceptions carry a `// lint-hermetic-db-ok: <reason>` marker.
- **Flake history:** each run appends per-suite outcomes to `.local/runs/history/suite-history.json`; repeat offenders (≥2 fails in last 10) print at the end of every run. Gate retries stay at zero — flakes are loud, never silently retried.
- **Manual quarantine:** `QUARANTINE_LEDGER` in `server/services/regressionSweep.ts` — every entry needs a reason **and expiry**; quarantine skips apply to full/regression runs, never to the smoke gate.
- **Auto-quarantine (Task #5028):** suites that fail ≥2 of their last 10 recorded runs (flaky kind only) are automatically moved to a non-blocking lane. Evidence is persisted in `tests/flake-quarantine.json` (sha-256 sealed; committed; single writer: the nightly `TEST_GREEN_BASELINE_PUBLISH=1` run). Quarantined suites continue executing in nightly/regression lanes so reinstatement evidence accrues. A fix task is auto-filed per suite via the existing feedback system. Reinstatement: ≥10 consecutive trailing greens with ≥3 from sweep lanes. Safety valve: if a quarantined suite's import closure intersects the current diff it **always runs and blocks** that gate — quarantine can never hide a regression in code you actually changed. Kill switch: `FLAKE_QUARANTINE=0`. Cap: 10 concurrent quarantined suites; cap-exceeded candidates are denied (still block) and trigger a day-deduped alert. Guard test: `tests/flake-quarantine-state.test.ts`.
- **Inherited-red routing:** `tests/redManifest.ts` classifies every hard suite failure against the current manifest, normalized signature, and suite fingerprint. Only the non-publishing smoke gate can excuse an exact proof; full/regression/nightly and isolated evidence lanes stay blocking even if a caller mistakenly asks to arm excusal. Missing, stale, malformed, changed, or un-fingerprinted evidence blocks. The attribution report names the next action: repair through the canonical blocking workflow or leave proof-complete inherited debt alone. Recurring intermittent failures remain owned only by the sealed auto-quarantine and feedback path above; deterministic and diff-touching failures always block.
- **Live-tip fallback (Task #5318):** the manifest bar above is deliberately strict, so a stale/absent/mismatched manifest — or a fingerprint shift from an unrelated blast-radius touch — can leave a genuinely pre-existing failure stuck at "yours"/"unattributable" even though an agent could hand-prove it inherited with a git-stash/worktree-at-HEAD rerun. `tests/liveTipAttribution.ts` mechanizes exactly that manual ritual as a bounded, opt-in SECOND proof source, wired into `attributeRunFailures` in `tests/redManifest.ts`. It only ever considers failures whose static verdict is already "yours"/"unattributable" and not already excusable, and only in the same excusal-eligible smoke lane as the manifest rails (never nightly publish, full/regression sweeps, or isolated-evidence runs — `run-all.ts` computes `liveTipArmed` with the identical lane condition as `excusalArmed`, gated by its own `TEST_LIVE_TIP_ATTRIBUTION` kill switch, default on). For each such candidate it resolves the same trustworthy upstream base commit the gate-lint A/B rails use (`resolveBaseTree`), materializes it into a disposable per-invocation `git worktree` (torn down in a `finally`, never touching the task's own tree), and re-runs that one suite there via the same `npx tsx` invocation shape `runOne` uses. The whole pass is bounded by one wall-clock budget (`TEST_LIVE_TIP_BUDGET_MS`, default 240s) and a small per-run suite cap (`TEST_LIVE_TIP_MAX_SUITES`, default 3); once either is spent, remaining candidates fall back to their static verdict exactly as today. Only an identical failure signature reproducing at the base commit counts as proof — a clean base pass, a different signature, a thrown/spawn error, or a budget/cap miss all leave the failure blocking, untouched. A failure excused this way carries `proofStatus: "proven-inherited-live-tip"` and evidence prefixed `LIVE-TIP VERIFIED: …`, so reports and reviewers can tell it apart from manifest-based proof (`proofStatus: "inherited"`); the JSON report's additive `liveTip` object records whether the pass ran, how many candidates it attempted, and the proved/not-proved/inconclusive split. This fallback can only ADD excusals it can prove — it never weakens the manifest rails, never runs outside the eligible smoke lane, and never re-litigates a candidate the static classifier already excused.

## How to register a test (Task #3786)

There is no central registry to edit. The runner (`tests/run-all.ts`) **discovers** every `*.test.ts` / `*.test.tsx` file under `tests/` and `client/src/` and derives its registry from a registration block each file carries. Adding a test = adding one new file; concurrent tasks can no longer merge-conflict in a shared array.

Put this at the **very top** of the file (line 1):

```ts
/* test-registration
{
  "name": "What this suite proves (Task #NNNN)",
  "regression": true,
  "smoke": true,
  "tier": "small",
  "smokeReason": "Why this earns a routine-gate slot (fast, deterministic, guards a bug class)."
}
test-registration */
```

- `name` is required. Everything else is optional structurally: `regression`, `smoke` + `smokeReason`, `sweepOnlyReason`, `tier` + `tierReason`, `timeoutMs`, `extraNodeArgs`, `extraEnv`, `notes`. The registration lint requires every committed suite to carry a tier.
- A `"regression": true` test must record an explicit gate decision: either `"smoke": true` + `smokeReason`, or a `sweepOnlyReason` explaining why it stays out of the routine gate (slow / DB-heavy / contention-sensitive).
- Enforcement: `scripts/lint-test-registration.ts` (block present + structurally valid) and `scripts/lint-smoke-gate-regression.ts` (gate decision recorded). The runner refuses to start while any block is invalid, so a partial registry can never silently shrink the suite.
- Full field reference: the docblock in `tests/testRegistry.ts`.

## How to name a migration (Task #3786)

New files in `migrations/` use a UTC timestamp prefix, unique by construction — never "the next number":

```
$(date -u +%Y%m%d%H%M%S)_short_description.sql   →   20260804153012_add_widget_flags.sql
```

The pre-#3786 `NNNN_*` names are a frozen historical namespace (snapshot in `scripts/lint-migration-prefixes.ts`); timestamp names sort after them, so apply order is preserved. Keep DDL idempotent (`IF NOT EXISTS` / `IF EXISTS`).

## Shared vendor test stubs (Task #5313)

Building a working in-memory mock for an external vendor (ClickUp, Zoom,
Google Calendar, Front, OpenAI, ...) has a real, non-trivial cost: figuring
out which functions a code path actually calls, what shape a realistic
response needs, and how to redirect the import without hitting the network.
Before this convention, that cost was paid **once per suite** — four
different tasks each wrote their own bespoke ClickUp stub from scratch,
because whichever task happened to need ClickUp coverage first had no
working mock to reach for. **Check `tests/vendor-stubs/` for an existing
stub for your vendor before writing a new one.** If one exists, import it. If
none exists yet, write a one-off first (see below) and only promote it to
`tests/vendor-stubs/` once a second suite needs the same vendor — see
"Consolidating a one-off into a shared stub" below.

### Where shared stubs live

`tests/vendor-stubs/<vendor>-stub.mjs` — one file per vendor module, named
for the vendor, not for any one suite. Each file:

- Starts with `export * from "<relative path to the real module>";` so
  every function the real module exports keeps working for suites that
  don't need to override it.
- Overrides only the specific functions a consuming suite's code path
  actually calls, each documented with a comment naming which suite(s)
  configure it and through which `globalThis` key(s).
- Never fires real HTTP. Every override either returns an in-memory
  fixture or reads one from a `globalThis` key the test sets in `beforeEach`
  or at the top of a section.
- Carries a header comment listing every consuming suite (by file name and
  task), so the next reader can find every place a change to the stub needs
  re-verifying.

### How a suite opts in

A suite wires in a shared stub exactly the way it would wire in a one-off:
through the existing Node ESM resolve-hook loader mechanism (`--import` a
small `*-setup.mjs` that calls `register()` on a `*-loader.mjs`, which
redirects a real module specifier to a stub URL — see any `sd-*-loader.mjs`
or `onboarding-e2e-loader.mjs` for the pattern). The only change from a
one-off is what the loader's stub URL constant points at:

```js
// One-off:  const CU_STUB_URL = new URL("./my-suite-cu-stub.mjs", import.meta.url).href;
// Shared:   const CU_STUB_URL = new URL("./vendor-stubs/clickup-stub.mjs", import.meta.url).href;
```

If two suites' loaders redirect to the *same* shared stub but need
different behavior from an overridden function that both suites exercise
(for example, two suites both call `createChecklist` but expect different
return shapes), the shared stub can't tell them apart via `globalThis` —
`module.register()` customization hooks run in a separate Node hooks
thread with its own realm, so a `globalThis` write made at the top of a
`*-loader.mjs` file is invisible to the stub module's `globalThis` in the
main thread. Disambiguate by giving each loader's stub URL a distinct query
string instead (the query survives the thread boundary because it's part
of the resolved URL, and it doesn't affect the stub's own relative imports):

```js
// Loader A: const CU_STUB_URL = new URL("./vendor-stubs/clickup-stub.mjs?stubMode=suite-a", import.meta.url).href;
// Loader B: const CU_STUB_URL = new URL("./vendor-stubs/clickup-stub.mjs?stubMode=suite-b", import.meta.url).href;
```

and have the overridden function read its own mode with
`/[?&]stubMode=([^&]+)/.exec(import.meta.url)` — see
`tests/vendor-stubs/clickup-stub.mjs` for a working example (submit-status-
fallback vs. template-enforcement both override `createChecklist`,
`createChecklistItem`, and `updateTask`).

### Shared stub vs. genuinely one-off fixture

Not every stub belongs in `tests/vendor-stubs/`. Keep it suite-specific when:

- It stubs something that isn't an external vendor call at all (an internal
  service module, a notification sink, an auth-token lookup) — those are
  suite plumbing, not a vendor mock other suites would reach for.
- The override values are inherently specific to one suite's scenario in a
  way that can't be expressed as a `globalThis`-configurable default (rare
  in practice — most "suite-specific" values are just a `globalThis` key
  away from being reusable).
- Nothing else needs that vendor yet. Do not pre-emptively "share" a stub
  that has exactly one consumer; promote it the first time a second suite
  actually needs the same vendor (see below). A speculative shared stub
  with one real consumer just adds an extra layer of indirection for no
  reader benefit.

### Consolidating a one-off into a shared stub

When a second suite needs a vendor already stubbed one-off elsewhere:

1. Create `tests/vendor-stubs/<vendor>-stub.mjs`, folded from the existing
   one-off — a faithful superset that preserves every override the
   original suite relies on (same `globalThis` keys, same return shapes),
   plus whatever the new suite needs.
2. Repoint every consuming loader's stub URL constant at the shared file
   (add a `?stubMode=...` query per loader only if two suites' overrides of
   the *same* function genuinely diverge, per above).
3. Delete the old one-off stub file(s).
4. Run every affected suite before and after the change and confirm
   identical pass/fail behavior — the consolidation must not change what
   any suite covers or asserts.

`tests/vendor-stubs/clickup-stub.mjs` (four service-desk suites) and
`tests/vendor-stubs/zoom-stub.mjs` / `tests/vendor-stubs/calendar-stub.mjs`
(the onboarding end-to-end suite) are worked examples of this pattern.

## Gate cost & timings (Task #3789)

`npm run gate` is instrumented: the summary prints per-check wall times and persists them to `.local/runs/gate-timings.json`; every harness run (smoke or full) also writes a slowest-first per-suite report to `.local/runs/suite-durations.json`. When the gate gets slower, those two files attribute the regression to a specific check or suite — start there, not with guesses.

Expected costs on a warm workspace (8 vCPUs):

| Phase | Expected | Notes |
| --- | --- | --- |
| Typecheck (`npm run check`) | ~11s no-change, ~30s after a batch of edits, ~90s cold | The incremental cache lives at `.cache/typescript/tsbuildinfo` (gitignored) so it survives dependency installs; delete `.cache/` to force a cold check. Fresh task environments get pre-warmed by a best-effort `npm run check` at the end of `scripts/post-merge.sh` (Task #3808), so even the first gate run is warm. |
| Lint phase (all checks) | ~60s warm, ~200s cold | All lint checks run concurrently in ONE process via a worker-thread pool (`runLintPhase` in `scripts/gate.ts` + `scripts/gate-lint-worker.mjs`); bound with `GATE_LINT_CONCURRENCY`. The heavyweight deterministic scanners (async-correctness, React hooks, bundle budget, and vendor confinement) memoize **green-only** exact-input verdicts through `scripts/lintVerdictCache.ts`; every hit says it reused a cached green verdict, and every error falls open to a real scan. A wall past **240s** raises a non-blocking ALERT + breach-ledger event (Task #5030) — only a tampered/invalid budget artifact still hard-fails (`lint-phase-wall-budget`). |
| Smoke gate (related selection) | usually a few minutes | Only suites whose traced import closure reaches your diff, plus the always-run core. |
| Smoke gate (full set) | Last qualifying source: 6.9 min wall; budget 9.0 min | The 2026-08-19 all-green zero-skip measurement ran 900 selected suites in 6.9 min with 0 failed and 0 deferred; the 9.0 min wall budget is mechanically derived from it and the policy pins did not move. A fresh 2026-08-22 serial/four-shard attempt selected 917 suites in both modes, but both runs were red and one order-sensitive suite changed outcome, so it did **not** replace the qualifying source. Derive the live registry count from `audits/governance/test-portfolio-baseline.json`. |

Every lint check stays runnable standalone (`npx tsx scripts/lint-<name>.ts`) for
focused debugging. `scripts/gate.ts` `LINT_CHECKS` is the canonical registry,
and the managed `.replit` **Long validation** workflow runs the requested
`routine-gate` profile through `npm run gate`; individual lint workflows are
forbidden. `scripts/lint-gate-workflow-drift.ts` enforces the two-role
topology, protected ports, and canonical commands. Lint
scripts export a side-effect-free `cliMain(): number` and keep CLI behavior
behind an `isMain` guard — `tests/gate-lint-phase.test.ts` enforces that
contract for every `LINT_CHECKS` entry.

### Size tiers & smoke demotions (Task #5031)

Every registration declares a size tier, mechanically classified from the committed nightly `tests/green-baseline.json` duration and its harness:

| Tier | Measured duration | Resource rule | Gate membership |
| --- | --- | --- | --- |
| `small` | ≤30s | ordinary pure/jsdom/route suite | eligible for blocking smoke |
| `medium` | >30s and ≤90s | ordinary suite | eligible for blocking smoke |
| `large` | >90s | **always** large for Chromium/browser or self-booted dev-server harnesses, even if fast | regression/post-merge/nightly only, unless an owner-approved explicit exception exists |

The measurement lint allows 25% observation headroom (30s/90s/420s tier ceilings) and gives a clear remedy: optimize or split, or justify a tier bump; large requires a `tierReason`. Unmeasured suites start at `medium` — `small` is earned by a published green measurement. `timeoutMs` is intentionally separate: it is a process kill cap, not a tier signal.

A heavyweight demotion keeps `"regression": true`, removes `"smoke"`/`"smokeReason"`, and records a substantive `"sweepOnlyReason"` containing the measured cost and safety path. The nightly/post-merge lanes execute it, while related selection’s import-closure **and declared `scanPaths`** expansion re-add it as blocking when a touching diff changes its inputs. Expansion currently logs and caps at 15 additions; a tracer failure fails open to the existing nightly/full backstops, so this is intentionally not a replacement for core guards.

The initial owner-approved migration removed the 168s async-correctness self-test, eight Chromium website suites, and the 60.3s `prod-actions-routes` suite from unrelated blocking smoke selection (912 → 902 suites; about **285 seconds of serial measured work** moved to the honest post-merge/nightly lane). The async lint still runs in the gate lint phase; browser and route suites remain forced blockers when the diff touches their declared imports **or declared static/bundle inputs**. `tests/size-tier-policy.test.ts` pins the classifier, ceilings, membership rule, and initially-empty exception list.


### Duration budget (Task #4531; wall decoupled from verdicts by Task #5030)

The gate is bounded by a committed, self-hash-sealed ratchet —
`tests/gate-duration-budget.json` (sole writer:
`scripts/regen-gate-duration-budget.ts`; hand-edits fail the seal):

- **Per-suite ceiling (the ONLY duration hard-fail):** 90s per attempt for
  passing suites; a registered `timeoutMs` override IS that suite's ceiling
  (the registration text is the recorded slow-lane decision). Violations
  **FAIL full-smoke runs** and WARN on related/regression/all runs.
- **Full-smoke wall (alert-only):** ceil(1.30 × the measured zero-skip wall),
  hard-pinned at 40 min (regen clamps and records `clampedFromMs`). Currently
  9.0 min from the 2026-08-19 all-green zero-skip measurement (900 selected
  suites, 0 failed, 0 deferred; two non-diff-related auto-quarantined suites
  were excluded). A wall breach can NEVER fail a run — on 2026-08-18 a 765/765
  all-green run was verdicted FAIL against that stale budget (#5019); Task
  #5030 removed the coupling. A breach now prints a loud
  `ALERT (non-blocking)` line, appends an event to the breach ledger
  (`.local/runs/duration-budget-breach-events.jsonl`, helpers in
  `server/services/regressionSweep.ts`), and the sweep scheduler's 6h
  watchdog auto-files ONE `/admin/feedback` re-baseline/triage item per
  stale-budget episode (dedupe key `duration-budget:<budget generatedAt>`,
  submitter `system:duration-budget`; a failed filing retries next tick).
  The wall is judged only on full-smoke runs with zero deferrals — narrowed
  runs report `wall not judged` honestly.
- **Gate lint-phase wall:** 240s in `scripts/gate.ts` — same alert-only
  semantics, same ledger (`source: "gate-lint-wall"`).
- Missing artifact = warning (bootstrap); tampered/invalid artifact or a
  budget above the pinned maxima = hard fail. Guard suites:
  `tests/gate-duration-budget.test.ts`, `tests/full-lane-deferral.test.ts`.
- Kill switches: `TEST_DURATION_BUDGET=0` (budget evaluation — banned as a
  response to a wall ALERT, and it also disables the per-suite ceilings that
  DO block), `LINT_VERDICT_CACHE=0` (lint verdict caches — red verdicts are
  never cached; every cache error falls open to a full scan).
- Update path: fresh zero-skip full-smoke measurement → `npx tsx
  scripts/regen-gate-duration-budget.ts` → commit (regen REFUSES a run that
  deferred suites as a measurement source). Policy pins live in
  `tests/durationBudget.ts` (owner-approved changes only). Full evidence:
  `audits/gate-duration-budget-2026-08.md`.

### CI control-plane decisions (2026-08 audit)

The control plane is deliberately layered: blocking controls protect input and
artifact integrity; advisory evidence names likely breakage; warnings surface
operator action without manufacturing a red gate. The final CI-overhaul audit
is [`audits/ci-control-plane-simplification-audit-2026-08.md`](./audits/ci-control-plane-simplification-audit-2026-08.md).

- **Keep now:** the green store/baseline publisher, red manifest,
  post-merge canary, watchdog/dead-man alarms, scoped freshness lints, and
  regeneration-artifact discipline. The canary stays advisory; watchdogs stay
  warning-only; freshness/integrity checks remain blocking where wired into the
  gate.
- **Evidence-window update (2026-08-26, owner-approved):** cost/token
  pressure means the team cannot wait out a 42-calendar-day window before
  making control-plane cost-reduction decisions. The evidence-readiness bar
  is shortened to a **14-calendar-day** window — the shortest span that
  still spans at least two full weekly rotation/full-integrity-sweep cycles
  — **plus** a minimum of **20 completed-gate observations retained
  in-window**, so a quiet 14-day stretch cannot fake readiness on elapsed
  time alone. This reverses only the *how-soon* question; it does not retire,
  merge, disable, or promote/demote any control-plane mechanism, and it does
  not change what telemetry is collected or how gates are selected. See
  `audits/governance/decision-ledger.md` (2026-08-26 entry, superseding but
  not replacing the 2026-08-19 entry) for the full rationale. All numbers
  below reflect this shortened bar; dated checkpoint narrative further down
  reports what was actually observed under the 42-day bar that was in effect
  at each of those checkpoint dates and is left as a historical record.
- **Deferred, not removed:** the duration-budget artifact and green-only lint
  verdict cache remain unchanged until a retained **14-day** evidence window
  with at least **20** in-window completed-gate observations measures each
  completed task gate's wall time, attribution outcome, and relevant
  control-plane incident. The duration artifact's aggregate wall and
  lint-wall signals remain non-blocking alerts; per-suite ceilings and invalid
  artifacts remain hard failures.
- **14-day evidence report (minimum 20 observations for readiness):** every
  completed `npm run gate` invocation appends
  one aggregate-only record to
  `.local/runs/task-gate-evidence.jsonl`. The record contains wall time,
  resolved selection mode, executed/green-skipped/deferred counts, final
  verdict, attribution counts, lint-phase wall/concurrency and cache hit/miss
  totals, aggregate shard lane balance/estimate coverage, batch-worker reuse,
  and a numeric gate-orchestrator process resource envelope (not child-suite
  memory/CPU). When the task-completion boundary supplies
  `TASK_GATE_TASK_REF`, the record also retains only that numeric task
  reference, base Git revision, and exact Git tree assembled from all tracked
  and untracked source validated. The gate prints the retained observation ID
  for the completion boundary. The completion/merge
  boundary then invokes `scripts/link-task-gate-delivery.ts` with the
  observation ID, task ref, and validated commit/tree in the corresponding
  `TASK_GATE_*` environment fields; the boundary derives the final delivery
  commit from its captured merge SHA, and only an exact match updates that
  same record. Attachment verifies both commits exist, the validated base
  is an ancestor of delivery, and the delivery tree exactly equals the tree
  validated. A gate never self-asserts its delivered commit. Partial,
  malformed, missing, stale, or conflicting provenance
  remains unknown and is never reconstructed from task prose, timestamps, or
  commit-message similarity. It excludes test names/paths and output, errors,
  task titles/prompts, commit messages, users, environment values, secrets,
  and user data. The ledger atomically retains at most the newest **5,000** records no
  older than **14 days**; duplicate observation IDs collapse before storage
  and reporting. Run `npx tsx scripts/report-task-gate-evidence.ts` (or add
  `--json`) for de-duplicated median/p95 gate wall time, lane utilization and
  balance, cache effectiveness, batch efficiency, resource envelope, the
  unrelated-to-diff failure fraction, linked observed validator failures,
  unknown history, and the minimum-observation readiness floor (met/not met).
  Policy-required-but-unobserved checks and documentation-only mentions are
  reported separately and are never counted as observed executions. Evidence
  IO is report-only and can never
  alter a gate verdict, selection, cache behavior, timeout, shard count, or
  duration-budget policy.
- **No silent simplification:** no mechanism may be retired, merged, disabled,
  or made advisory without a new L3 owner decision. Missing telemetry is not
  evidence that a control is unneeded.

**Dated evidence-readiness checkpoint (2026-08-22):** the canonical command
returned a schema-valid trailing-window report but found no canonical ledger
and therefore 0 observations. Gate wall median/p95, shard utilization and
imbalance, lint-cache hit rate, batching efficiency, resource percentiles,
failure-attribution fraction, and executed/skipped/deferred coverage were all
**not computable**. Zero counters in that empty report mean “no observations,”
not “zero incidents.” The CI-efficiency program is therefore not closed, no
control or policy changed, and the valid 2026-08-19 zero-skip full-smoke run
(900 selected, 0 skipped/deferred/failed, 6.9m) remains a dated point baseline
rather than a median. The complete checkpoint, per-control
`ADOPT NOW`/`DEFER UNTIL`/`NOT JUSTIFIED` decisions, and re-review entry
criteria are in the audit linked above. Re-review requires a retained 14-day
observation span (shortened from 42 days by the 2026-08-26 decision-ledger
entry) with at least 20 in-window completed-gate observations and populated
wall, lint/cache, runner/batch, resource, coverage, verdict, and attribution
fields; one clean forced zero-skip, zero-deferral full-smoke sharded run is
also required as a like-for-like point measurement, not as a substitute for
the window or the observation-count floor.

**Rebuilt test-cost verification (2026-08-25):** The dedicated real-interface
guards passed: related selection (90 assertions), inherited-red attribution
(18), quarantine state, task-gate evidence/reporting (9), and full-lane
deferral/scheduled-lane safeguards (19). `npm run check` passed. No broad or
unrelated test run is part of this verification.

The live canonical report captured at the verification checkpoint contains
**1 unique in-window observation**: one failed `full-smoke-fallback`
observation (922 executed, 4 skipped, 0 deferred; one task-attributed
failure). It has **0 qualified full-smoke, zero-skip, zero-deferral comparison
observations**, so its medians and inherited fraction are point evidence only
and the 42-day re-review trigger remains **not met**. The observed repository
validation cost is resource telemetry (591,114ms wall and 131,514.729ms CPU),
not a currency amount. Replit/model/platform billing is **unavailable** to
repository telemetry, so attributable spend and monthly-normalized spend are
**unavailable**; the $5,000/month affordability outcome is **INCONCLUSIVE**,
not a savings claim. The report explicitly separates executed, green-skipped,
deferred-not-verified, quarantined, inherited, task-caused, unresolved, and
incomplete outcomes; zero means “not observed,” never “safe.”

This does not change selection, green-skip, baseline, retry, timeout, shard,
duration-budget, cache, or gate policy. Full/nightly lanes remain independent
sources of truth. Routine task completion is validated by Replit's own
built-in completion review, not by an automatic per-task run of this harness
(owner decision, 2026-08-26 — see "Bounded task-validation policy" below);
full-smoke/force-all remains exceptional and operator-only. If the evidence
contract is unavailable or incomplete, retain the current fail-closed controls
and classify the result as not verified; rollback of any future policy
adjustment is the prior owner-approved control-plane checkpoint, never a
routine kill switch or a weakened gate.

### Bounded task-validation policy (owner-approved)

**Owner decision (2026-08-26): for routine task completion, this repository
relies on Replit's own built-in completion review — not this custom test
harness.** `npm run gate` (typecheck + every registered lint + the
related-smoke test subset) is no longer a required per-task completion step;
this section takes precedence for task-validation instructions and states
that plainly. A routine task agent performs review-by-inspection, completes
the non-executing self-check, and is validated by Replit's built-in review —
it does not need to run or wait on the gate, a typecheck, lint, test, or
focused substitute.

### Task-agent read-only boundary for tests (owner-approved)

The no-self-testing rule above is also a permission boundary: task agents may
read tests and testing infrastructure for behavioral context, but they may not
change or execute them. This applies even when a task plan requests coverage,
asks for a targeted check, or describes a test change as a completion step.
Any needed test maintenance is reported in the task's completion notes and
left for operator-owned maintenance outside the task.

The protected surface is defined by purpose, not by a single directory:

- **Test content and data:** test/spec files and registration metadata;
  snapshots; fixtures; mocks, stubs, and vendor stubs; setup/bootstrap files;
  test helpers; and test-only seed or sample data, wherever they live.
- **Test execution and evidence:** runners; selectors; fingerprints;
  baselines and manifests; quarantine records; duration budgets; test-result
  and coverage-reporting code; test-specific lint scripts; and their
  configuration.
- **Test configuration and dependencies:** test-related sections of package
  scripts and dependency manifests/lockfiles, compiler or bundler test
  configuration, test-environment settings, and test loader configuration.
- **Scheduled validation:** nightly, weekly, post-merge, pre-deploy, and
  other scheduled test or gate workflows and the configuration that starts,
  selects, publishes, or retains their evidence.

The boundary follows content as well as paths: a mixed-purpose file is
protected for its test-related lines or entries even when it also contains
unrelated application configuration. A task agent must not create, edit,
delete, rename, regenerate, move, skip, quarantine, reclassify, or otherwise
work around any protected test surface, and must not run tests, lints,
typechecks, gates, browser checks, or focused substitutes. This policy changes
task-agent permissions only; it does not weaken, remove, or alter the
test harness, its evidence rules, or its scheduled and operator-run
validation lanes.

**Bounded response to a completion-review rejection.** If the built-in review
flags unrelated files, inherited validation output, environment noise, or a
platform-review inconsistency, preserve the task diff. Use the existing
diff-provenance or attribution evidence when relevant, include that evidence
in the completion explanation, do not request a fresh review, and do not
launch compensating tests, lints, typechecks, focused checks, or unrelated
repairs. A finding that the evidence shows is task-owned remains blocking:
fix it normally; this mitigation never turns an owned defect into a skip.

**This policy overrides conflicting task-plan text, regardless of when or by
whom that plan was written.** An individual task's own plan — its Steps,
Out-of-scope section, or any other plan text — sometimes carries wording like
"verify with a scoped/targeted test," "run tests that cover X," or "confirm
via a narrow check" left over from before the 2026-08-26 decision above, or
copied from an older task, or otherwise stale. That wording is never a
task-specific exception to this policy. A task agent that encounters it
treats it as void and falls back to this section's default (run nothing
yourself; the harness stays manual and operator-triggered) rather than
following it. When in doubt about which instruction governs, this canonical
policy wins over any task's plan text, every time.

That does not touch the harness. `npm run gate`, every lint script, the
full/regression/smoke test suites, the nightly sweep, the weekly
full-integrity sweep, and the post-merge canary all keep working exactly as
before, fully intact and independently runnable on their own existing
schedules. This section still **describes the existing gate**, selector,
evidence, quarantine, and integrity lanes for whenever any of them runs — an
operator's manual invocation, the nightly sweep, the weekly full-integrity
sweep, or the post-merge canary. It does not create a second gate or turn
deferred work into a pass. The structured `[task-gate] disposition=…;
observed=…` line and the aggregate evidence record use these exact labels
whenever the gate runs.

**Running the harness manually.** An operator (or a task agent explicitly
asked to audit the codebase) starts the managed **Long validation** console
workflow as the default durable path. Create the reviewed request file and
start the workflow with its stable command (`npm run validate:long -- --request
.local/runs/long-validation-request.json`, documented above under "Durable
long-run validation"); choose `routine-gate` for the canonical related-only
gate, or an explicitly requested control profile for central-integrity work.
The direct Shell commands — `npm run gate` for the bounded related-only gate,
`npm run gate -- --full-smoke` or `TEST_FORCE_ALL=1 npm run gate` for the
complete universe — remain troubleshooting-only operator tools. They are not a
routine task-completion path and must not be used to create a second
foreground/background validation runner.

| Disposition | Meaning | Gate effect and evidence |
| --- | --- | --- |
| `executed-and-passed` | The selected suite work executed in this gate and passed. | **Blocking proof.** A suite failure, incomplete result, per-suite ceiling breach, or invalid budget artifact prevents this disposition from passing. |
| `reused-accepted-green-evidence` | A selected suite was not re-executed because its fingerprint matched an accepted green record. | **Blocking proof only under the existing green-skip rails.** It is distinct from execution; missing, failed, unreadable, malformed, expired, or untraceable evidence executes instead. |
| `deferred-and-not-verified` | Rotation-day work was deferred to the downstream lane. | **Deferred, never passed/green.** Only rail-less `stale-rotation` or `stale-expired` accepted-green decisions qualify. The output must say **not verified**; deferred suites are excluded from the result count and never receive a green record. |
| `quarantined-non-blocking` | A sealed auto-quarantine record excluded a non-diff-related flaky suite from the task gate. | **Warning, narrowly non-blocking.** Nightly/regression execution continues for reinstatement evidence. A diff-touching suite, a tracer/diff failure, a malformed/seal-invalid ledger, a disabled quarantine switch, or a cap-denied candidate remains blocking. |
| `blocking-failure` | A required control did not prove safe completion. | **Blocking.** This includes failing or incomplete execution, bad evidence, invalid artifacts, and every fail-closed exception below. |

Mixed runs can truthfully report more than one observed disposition (for
example, executed-and-passed plus reused accepted green evidence plus deferred
and not verified); the primary label never converts the other facts into a
pass. The 14-day report aggregates these labels separately from the final
pass/fail verdict.

**Fail-closed matrix.** Directly affected suites, always-run core guards,
blast-radius additions, quarantine re-adds, smoke-only suites, and suites with
their own loader flags execute in the blocking gate, **or** satisfy it by
reusing accepted, fingerprint-matched green evidence — the identical-input
reuse an ordinary unchanged suite already relies on today (scoped,
owner-approved exception, 2026-08-26: `mandatoryRailWasExecuted` in
`scripts/taskGatePolicy.ts`; superseded the "no green-skip policy change"
restriction below for this one exception only). Any untrusted/ambiguous
related selection records deferred central-integrity debt rather than launching
the full smoke set automatically. Missing, malformed,
stale-by-anything-other-than-the-positive rotation/expiry classifications,
failed, poisoned, or unfingerprintable proof executes rather than reuses or
defers, and any suite left in `deferred`/not-verified status still cannot
satisfy a rail. Incomplete lane accounting blocks.

**Test-control-plane changes.** The runner, registry, selection/expansion,
fingerprint/green-baseline/deferral decisions, quarantine rails,
red-attribution evidence, gate/budget policy, and validation scheduler are
read-only to task agents. A task agent that discovers needed maintenance
reports it without changing or executing those surfaces. Operator-owned
changes continue to hand broad integrity to the shared
post-merge/nightly/weekly lanes and remain explicitly **not verified** until
one of those lanes (or an operator) runs them. An operator may still request
`TEST_FORCE_ALL=1 npm run gate -- --full-smoke` for an explicit
central-integrity check; that stays an operator-triggered path, never an
automatic task fallback. Touching widely shared, high-fan-in, or
broadly-imported files — even a shared model or hub component — never gives a
task agent grounds to run the gate or add that flag; see "Full-suite
execution: operator-only, on-demand policy" below
for the exact rule and the vocabulary for narrating a run when one does
happen.

**Handoff responsibilities.** Post-merge canary remains bounded,
report-only early detection and culprit stamping; it does not erase verification
debt. Main's nightly sweep executes deferred eligible work and publishes only
green evidence. The weekly forced full-integrity sweep executes every
regression suite regardless of fingerprints, catching environment and database
drift. Predeploy/full-integrity controls remain required on their existing
paths. Watchdog/baseline-staleness and aggregate wall alerts are **warnings**;
nightly lint results and task-gate evidence IO are **report-only**; a deferred
label is **not verified**; only the blocking controls determine a task-gate
pass/fail verdict.

No wider deferral, green-skip change, budget/cap change, or cost-saving claim
is authorized until the retained 14-day ledger, with at least 20 in-window
completed-gate observations, is populated and independently
compared against a clean zero-skip, zero-deferral full-integrity run — **except**
the one narrow, dated, owner-approved exception already shipped: a direct/core
rail suite may satisfy its rail with accepted, fingerprint-matched green
evidence instead of a fresh execution in that gate invocation (2026-08-26).
That exception does not touch suite selection, fingerprinting, or green-skip
eligibility; the `deferred-and-not-verified` disposition still cannot satisfy
a rail; and it leaves the duration-budget artifact and lint-verdict-cache
defaults untouched. The canonical read is
`npx tsx scripts/report-task-gate-evidence.ts`.

**Ambiguous or plausibly-contended failures default to skip, not retry or a
question (Task #5307).** This applies whenever an operator runs the gate. A
single bounded, already related-only gate run is final for a failure
that is ambiguous or plausibly unrelated to the task's own diff — a fresh
timeout, a resource/budget-ceiling miss under concurrent load,
or another transient infra error outside the task's traced input closure that
the attribution system above (red-manifest verdicts, gate-lint A/B) doesn't
already excuse. The agent does not re-run the gate a second time hoping for a
different result; the next action is completing with a fully evidenced
`skip_validation_reason` naming the failing check, quoting the exact
error/budget/line, and stating why it is judged unrelated to the diff. The
same default covers evidence, short of an exact red-manifest match, that
another concurrently-running task could plausibly be causing or independently
fixing the same failure — a recent unrelated merge touching the same failing
suite/config, a merge-integrity warning (`.local/runs/merge-integrity.json`)
naming overlapping files, or a failure sitting in test infrastructure known to
be shared/contended (a common DB-backed suite, a shared fixture, a shared
config file). This generalizes "Inherited reds get ONE fix, on main — never N
task-side fixes" ([TASK_PREFLIGHT.md § 12](./TASK_PREFLIGHT.md#12-inherited-gate-failures--merge-integrity))
to this reasonable-but-not-manifest-proven case: the agent ships no competing
local fix and instead skips and documents. (Distinct from Task #3933's
separate same-run resource-crash scope from concurrent lint processes inside
one gate invocation.) Neither trigger is ever escalated to the operator as a
question — retry avoidance, fix-war avoidance, and the no-ask default resolve
together as one decision. This default never covers a failure plausibly
caused by the task's own changed files (verdict `yours`, or a failing suite/
check tracing to touched files with no plausible concurrent-task explanation)
— that stays fully blocking, diagnosed and fixed before completion, with no
skip and no shortcut.

### Related-selection global triggers (narrowed by Task #3789)

Editing a one-off script under `scripts/` no longer forces the full smoke set. Only harness-relevant scripts remain global triggers: `scripts/gate.ts`, `scripts/gate-lint-worker.mjs`, `scripts/lint-*` (scripts and baselines), `scripts/predeploy.sh`, `scripts/post-merge.sh`. Everything else under `scripts/` flows through normal import tracing. Global triggers and selection failures retain direct/core rails, record deferred central-integrity debt, and never launch the full smoke set automatically.


### Verified generated-artifact ownership

Related selection has a deliberately closed ownership contract for the
committed route inventory (`tests/route-inventory.{json,report.md}`) and
endpoint contract table (`audits/D-endpoint-contract-table.{md,json}`). A
changed output or a verified generator input adds that family's named
freshness/refresh guard suites while preserving the normal import-closure and
declared-`scanPath` decisions. The selection manifest records
`VERIFIED artifact ownership` evidence so a narrowed gate explains why the
output was trusted.

The selector verifies the artifact files, primary generator, freshness lint,
generator-input rules, and registered guard suites before it narrows. A missing
or malformed artifact, stale/malformed ownership evidence, an output outside
the closed set, or any tracing/git ambiguity falls open to the complete smoke
universe. Filename patterns are detection only; they never grant a generated
file a precise-selection exception. Coverage lives in
`tests/smoke-related-selection.test.ts`.


## Incremental execution: skip suites green on identical inputs (Task #3791)

Selection (Task #3755) decides which suites are *relevant*; the incremental layer (`tests/suiteFingerprint.ts`) decides which of those actually need to *execute*. Before running a selected suite, the runner computes a content fingerprint over that suite's real inputs — the test file plus its traced import closure (same esbuild tracer as selection), its registered `extraNodeArgs`/`extraEnv`/`timeoutMs`, global inputs (`package.json`, lockfile, `tsconfig*.json`, the runner/selector/fingerprint modules, Node version), and, for suites with loader shims, every non-test file under `tests/` (stubs are registered by string path, invisible to tracing). The `migrations/` tree is a **per-suite** input (Task #4077): it folds into the fingerprint only for DB-backed suites — those whose closure reaches `server/db.ts`/`tests/hermetic/` by path, or whose closure files match a DB content marker (a `pg` driver import, `DATABASE_URL`, the drizzle node-postgres binding, or a `server/index.ts` boot reference — suites that spawn the full server apply migrations transitively). A routine migration merge therefore no longer re-runs pure lint/jsdom/source-scan suites; any classification error falls open to executing. If the fingerprint matches the suite's last **green** run in this environment, the suite is skipped. Every mode prints `executed N, skipped M (green on identical inputs)` plus the committed baseline's age, and writes a per-suite audit to `.local/runs/incremental-skip.json`.

The last-green store is `.local/state/test-green-store.json` — **gitignored and per-environment** and **schema-versioned** (a runner/fingerprint change discards it wholesale). One inheritance seam (Task #3872): an **absent/empty** local store seeds once from the committed `tests/green-baseline.json` — main's nightly publishes its green records there on **every** run, red or green (Task #4077; failures are filtered out and continue into `tests/red-manifest.json` instead), so a fresh task environment skips whatever main already proved on identical inputs. A non-empty local store always wins, and failures can never seed a skip.

Safety invariants (guarded by `tests/incremental-green-skip.test.ts`, itself in the always-run core):

- **Failures never record green** — and a failure overwrites any prior green, so the suite re-executes until it actually passes.
- **The always-run core never skips** — `DEFAULT_CORE_RULES` suites (`tests/lint-*.test.ts` etc.) scan the repo via `fs`, so their true inputs are invisible to tracing; they execute every run.
- **Every error falls open to executing** — store corrupt/missing, trace failure, unreadable file, unresolvable import in a closure: the affected suites (or the whole run) execute. No error path can cause a skip.
- **Greens expire** — after `TEST_GREEN_MAX_AGE_DAYS` (default 7), a suite re-executes even if inputs are byte-identical.
- **Full runs must be proven** — a mode-`all` run (`npm test`, what predeploy invokes) only skips when a genuine full-suite green (every suite executed, zero skips, zero failures) exists within `TEST_FULL_GREEN_WINDOW_DAYS` (default 7) in this environment. Missing store or stale full-green → the run executes everything. `PREDEPLOY_FULL_TESTS=1` on a deploy forces full execution regardless (it maps to `TEST_FORCE_ALL=1`).
- **Flake reporting is unchanged** — a suite that passes on retry records green with its flaky flag, so sweep/quarantine reporting sees the same signal.

**Deferred central integrity.** Rotation-day deferral remains reason-gated: directly affected, core, blast-radius, quarantine, smoke-only, and special-harness rails execute in the blocking gate; only positively stale green evidence can defer. Separately, global triggers and untrusted selector results preserve directly identifiable/core proof and record the omitted broad set in `.local/runs/full-lane-deferred.json` as **NOT verified**. Neither form of deferral records green evidence or expands a routine task gate to full smoke. The post-merge canary, nightly sweep, and weekly `--force-all` integrity sweep own this debt on main. Kill switch: `TEST_FULL_DEFERRAL=0`. Guard suite: `tests/full-lane-deferral.test.ts` (always-run core).

**Nightly culprit naming (Task #5030).** When the nightly publisher records a NEW red (absent from the previous manifest, or present with a different signature), it resolves the merge window `previous manifest commit → HEAD` (`resolveMergeWindow` in `tests/redManifest.ts`) and stamps `culprit` on the entry when the window contains exactly ONE commit — multi-commit or truncated windows never guess (the per-merge post-merge canary remains the precise stamper). The sweep notification appends a `🎯 … attributed to merge window` line, and each auto-filed feedback item names the sole culprit or lists the window, so breakage triage starts at the responsible merge window instead of falling on the next unlucky task.

**Nightly sweep cadence:** weeknight sweeps are incremental; the scheduler forces `--force-all` once a week (Sunday 03:30 America/New_York — `isFullIntegritySweepDate` in `server/services/regressionSweep.ts`), so environment/DB drift that fingerprints cannot see is caught within a week. The sweep report and alert distinguish executed vs skipped-green and carry the committed baseline's age; the nightly notification also fires whenever that baseline is older than `BASELINE_STALENESS_ALERT_DAYS` (2) — a frozen publish arm surfaces within a day instead of via mysteriously slow task validations (Task #4077).

**Baseline publisher alarm and catch-up arm (Task #4530):** A secondary watchdog fires at boot + every 6h, *independent of whether the nightly sweep ran*. If the committed `tests/green-baseline.json` is stale by more than `BASELINE_STALENESS_ALERT_DAYS` (2d) and the watchdog hasn't alerted today, it dispatches via the standard notification pipeline (`infra.regression_sweep.failed`, dedupe key `regression-sweep-staleness:<YYYY-MM-DD>`) — one alert per calendar day during a freeze, even if Slack is disconnected (in which case the alert lands in the in-app admin bell). **This fires even if the sweep itself is completely broken or the workspace was asleep when the 03:30 ET cron ticked.** When Slack IS working and healthy, green nights produce no watchdog noise (the watchdog sees a fresh baseline and clears its state).

The **catch-up arm** (also boot + 6h) kicks off a full sweep when the baseline is stale and no recent tick has completed. Publishing is gated by TWO conditions, both required: (1) `REGRESSION_SWEEP_PUBLISHER_ENABLED=1` — stored as a Replit Secret (never in the committed `.replit` `[userenv.shared]` section), and (2) a **structural main-workspace check** (`detectSubEnvironment` in `server/services/regressionSweepScheduler.ts`): task environments are detected by a sub-scoped `REPL_ID` (`<uuid>:<subid>` — main has a bare uuid) or the presence of the `main-repl` git remote (the completion-rebase target only task envs carry), failing closed (no publish) when signals are missing. The structural check exists because **Secrets and shared env vars both propagate into task-environment clones** — no env-var placement alone can be main-only. A task workspace therefore resolves publisher-disabled even when the flag is visible in its environment; the main workspace (bare `REPL_ID`, no `main-repl` remote) resolves enabled once the secret is set. To verify on main: `echo $REPL_ID` (no `:`), `git config --get remote.main-repl.url` (no output). **The same gate covers every trigger — cron, catch-up, and the manual/on-demand trigger (`runRegressionSweepNow("manual")`, the entrypoint reserved for the admin console button, Task #2625):** all three funnel into one spawn path whose env comes exclusively from `buildSweepSpawnEnv`, which injects `TEST_GREEN_BASELINE_PUBLISH=1` only when the publisher gate passes and otherwise strips it even if inherited. Before the child starts, that shared path also takes the existing process-plus-Postgres worker singleton lock, so concurrent workspace processes defer rather than overlap the costly full run; the lock releases in `finally` and on process crash. An admin pressing the on-demand button in a task-environment browser session therefore runs the sweep locally but can never publish baselines from that clone (Task #4541; structural guard in `tests/regression-sweep-catchup.test.ts`). The catch-up uses a 1-hour minimum gap between attempt starts (not just completions) so a killed sweep doesn't immediately retry under merge-storm load. Malformed or future baseline, manifest, attempt, or completion stamps are invalid evidence: they cannot make a lane fresh, bypass cadence, advance a baseline, or resolve repair debt; the watchdog emits the normal actionable alert for a future baseline/manifest stamp. Deferral reasons (load too high, recent tick, min-gap) are appended to `.local/runs/regression-sweep-catchup-deferrals.jsonl` for post-mortem diagnosis, distinguishing "workspace asleep" (no records) from "workspace awake but deferred" (records with reasons).

**What alerts when the sweep itself is down:**
- The watchdog alarm fires once per calendar day via `infra.regression_sweep.failed` for as long as the baseline stays stale — visible in the admin in-app bell even when Slack is disconnected. The alarm body names the age, the last-published timestamp, and (if detected) any orphaned sweep attempt that started more than `ATTEMPT_ORPHAN_THRESHOLD_HOURS` (1.5h) ago without a completion record.
- If the sweep is broken but the workspace is alive, the catch-up arm can still recover: it fires on the next 6-hour check as long as the publisher flag is set and the load/cooldown/min-gap gates allow it.
- If the workspace itself is asleep (cron never fires, catch-up never fires), the watchdog is also asleep — but the watchdog fires on the NEXT boot of the dev server, typically within a working day.

### Full-suite execution: operator-only, on-demand policy

When the harness runs — an operator's manual invocation or one of the
scheduled central lanes —
rely on skipping for repeats: a re-run right after a green gate re-executes
only the core and anything that changed. Forcing a genuine full run
(`--force-all` / `TEST_FORCE_ALL=1` / `PREDEPLOY_FULL_TESTS=1`) is
**exclusively an operator action**, taken
through the central lanes — an explicit on-demand request, predeploy, or the
nightly/weekly sweep — when *the operator* suspects inputs fingerprints
cannot see: shared dev-DB data shape, env-var semantics, wall-clock/timing
behavior, or external services.

**A task agent never makes this call itself, for any reason — including
because a change touches widely shared, high-fan-in, or broadly-imported
files.** The selector's import tracing and global-trigger rails (above)
already account for fan-in; any residual uncertainty they can't resolve is
recorded as **deferred-and-not-verified** central-integrity debt for the
operator/nightly/weekly lane to pick up, not a reason to add `--full-smoke`,
`--force-all`, `TEST_FORCE_ALL=1`, or `PREDEPLOY_FULL_TESTS=1` to your own
gate invocation. If you believe a change needs broader validation than the
selector gave it, say so plainly in your completion notes and let the
operator decide — never run or narrate a full/forced run yourself.

**Narrating gate results.** Report the gate's actual disposition and
selection counts in completion/PR notes using the exact labels from the
disposition table above — e.g. "selected 90 of 939 related suites,"
"reused-accepted-green-evidence," "deferred-and-not-verified." Never
paraphrase a bounded related-selection run, however large it looks, as "the
full smoke suite" or "full suite required before completing any task." Only
a run under the explicit operator `--full-smoke` / `TEST_FORCE_ALL=1` flag
is the full suite, and only an operator invokes it.

Measured effect (2026-08-05, this workspace): the full 262-suite smoke set executed in ~13–15 min wall; an immediate re-run executed **25 and skipped 237** (18 always-run core + 4 failing + 3 without a prior green) in **~3.5 min wall**, and a full `npm run gate` right after a green run finished in **~1.6 min** (typecheck 24s + lints 13s + smoke 60s, executed 22 / skipped 240) — with zero command changes. The managed `.replit` **Long validation** workflow runs `npm run gate` only through its requested `routine-gate` profile. Predeploy (mode `all`) keeps executing everything until a genuine zero-skip full green exists within the window, so quiet-period publish savings begin after the first fully-green full run in the environment.

## Pre-deploy test gate (Task #1006)

The autoscale deployment build is:

```
sh -c "./scripts/predeploy.sh && npm run build"
```

so `npm test` runs automatically before every deploy build. A failing test exits non-zero and blocks the build (and therefore the deploy) with a clearly delimited **"DEPLOY BLOCKED"** banner showing elapsed time and exit code.

The command is unchanged by Task #3791 but now runs incrementally: suites green on identical inputs skip, and the runner itself forces a genuine full execution when the green store is missing/invalid or no full-suite green exists within `TEST_FULL_GREEN_WINDOW_DAYS` (default 7). Set `PREDEPLOY_FULL_TESTS=1` on the deploy to force full execution explicitly.

### Emergency override

Set `PREDEPLOY_SKIP_TESTS=1` on the deploy to skip the suite. **Use sparingly.**

## Parallel sharded execution (Task #5029; timing-history correction)

The runner distributes suites across N concurrent shard lanes, each backed by its own private hermetic Postgres database cloned from the ensured `nobull_test` template. Wall time scales to ≈ slowest shard instead of the serial O(n) sum.

### Shard count

| Precedence | Setting | Example |
|---|---|---|
| 1 (highest) | `--serial` flag | `npm test -- --serial` → 1 shard (exact pre-5029 behavior) |
| 2 | `--shards=N` flag | `npm test -- --shards=2` |
| 3 | `TEST_SHARDS=N` env var | `TEST_SHARDS=8 npm test` |
| 4 (default) | `min(4, ceil(vCPUs / 2))` | 4 shards on an 8-vCPU box |

The four-lane value is an **upper default**, not a promise to use four lanes.
Before child processes start, the runner applies a lowering-only resource policy
to the requested count. It considers the measured CPU count, currently free
and total memory (2 GiB reserve plus 1 GiB per lane), the known local-hermetic
Postgres budget (100 connections, 20 reserved, five capped child-pool slots per
lane), one active suite child per lane, and the executable suite count. It never
raises the four-lane default, pool limits, timeouts, or duration budgets.

Every run prints a `[shards] policy` line with the requested source
(`serial`/flag/env/default), effective count, numeric caps, provisioned
shard-database count, and controlled reason labels. The completed gate keeps the requested count, source,
reason labels, and the hermetic **database capacity budget** as aggregate-only runner evidence; it does not retain command,
environment, suite, or output data. `--serial` remains exactly one lane.
`--shards=N` and `TEST_SHARDS=N` remain visible operator requests, but the
runner caps them only when a verified safety bound would otherwise be exceeded.
Recovery from memory pressure is automatic on the next invocation after memory
headroom returns; a run never grows past the shard databases provisioned before
its final plan. Use `--serial` for an immediate conservative operator choice.

Two situations force the effective count to 1 automatically:
- The hermetic provisioner is in `shared-instance-fallback` mode (no per-shard DB isolation).
- `toRun` has ≤ 1 suite (no benefit to shard infrastructure overhead).

### What sharding preserves

- **Batch-failure solo re-verify**: a batch-child failure is still re-verified in an isolated solo spawn before recording a failure — just within the same lane.
- **Worker recycling** (`BATCH_WORKER_MAX_SUITES = 30`): each lane recycles its own batch workers independently.
- **Straggler re-dispatch**: predecessor-straggler poison exits cause one re-dispatch within the same lane.
- **Per-suite timeout + SIGTERM→SIGKILL**: identical to the serial path, applied inside each lane.
- **Quarantine semantics**: smoke quarantine is applied per-result by the parent after `mergeLaneResults`.
- **Registration-order merge**: `mergeLaneResults` in `tests/shardScheduler.ts` reassembles shard results in the original `toRun` order — duration reports, attribution, and budget evaluation are byte-stable.
- **Fail-closed result accounting**: every selected suite must return exactly one recognized terminal lane result. A missing, duplicate, or foreign result (including a lane crash) is reported as **INCOMPLETE**, with the affected suite paths and crashed lane named. The runner exits non-zero, invalidates selected local green records so missing work cannot skip next time, and does **not** write duration evidence or publish green-baseline, red-manifest, or quarantine conclusions. Incomplete records are runner diagnostics, not quarantinable test-code failures.
- **Atomic output**: each suite's stdout/stderr is buffered within the lane (up to 8 MB) and printed atomically, tagged `[shard-N]`, preventing interleaved output.

### Lane scheduling

Static scheduling (the default) distributes suites via the LPT (Longest
Processing Time first) algorithm (`distributeSuites` in
`tests/shardScheduler.ts`): known suites sort by their last-recorded elapsed
time and assign greedily to the least-planned lane.
Timing estimates come from the durable per-suite history, with the newest
`.local/runs/suite-durations.json` entries overriding only suites that report
actually observed. A partial, deferred, or `--file` report therefore cannot
erase useful estimates for every other suite.

Unknown durations receive the median known estimate for **planning only** (or
1ms if there is no history) and deterministic rotating tie-breaking. When at
least one unknown suite is available per lane, coverage-first placement gives
every shard one before normal greedy balancing; smaller unknown sets go to
distinct lightest lanes. This spreads empty, stale, partial, and single-suite
histories instead of repeatedly assigning unknown work to lane zero. Startup reports
known/unknown estimate coverage plus aggregate planned lane counts/loads;
completion reports aggregate actual per-lane counts/work. These diagnostics
contain no test output aggregation.

**Measured check (2026-08-20):** after a partial timing report, a forced
11-suite representative registered subset ran with zero skips and zero deferrals: serial wall
**57.74s** vs four-shard wall **25.09s** (2.30× faster), all 11 passed.
Planned lanes were 3/2/3/3 suites with 13.14/13.33/12.87/12.86s planned work;
actual lanes were 3/2/3/3 with 15.04/11.87/13.31/17.75s work. The pre-fix
retained gate evidence was 294 suites distributed 1/258/18/17, which this
coverage and lane-balance output makes immediately visible.
Reproduce the comparison by appending either `--serial` or `--shards=4` to:
`TEST_FORCE_ALL=1 npm test -- --file=tests/batch-worker-realm-isolation.test.ts,tests/prod-action-feeder-convergence.test.ts,tests/dev-migrations-ledger-drift.test.ts,tests/lint-merge-conflict-markers.test.ts,tests/report-authz-remaining-gates.test.ts,tests/competitor-backfill-converge.test.ts,tests/front-recovery-incremental-progress.test.ts,tests/ads-os-criteria-cron-routes.test.ts,tests/google-ads-connection-retired-scan.test.ts,tests/sql-array-binding.test.ts,tests/smoke-related-selection.test.ts`.
The runner prints the aggregate coverage, planned lanes, actual lanes, final
verdict, skips, and deferrals.

**Bounded-policy recheck (2026-08-22):** the same forced, 11-suite comparison
completed with 0 skipped/0 deferred and all suites passing: **50.269s** serial
versus **21.183s** at the normal bounded default (**2.37× faster**). The
healthy 8-vCPU host selected four lanes (`cpu=4`, `memory=4`,
`database=16`, `workers=4`); its actual lane work was
13.98/14.49/12.19/14.40s. The sharded run reported no batch-worker
resource-pressure recycle or fallback. This protects the existing four-lane
ceiling rather than justifying a higher one. Re-run this forced comparison
before reconsidering the cap; do not regenerate the duration-budget artifact
from it.

**Full-population benchmark attempt (2026-08-22):** matched forced full-smoke
runs used the same source commit and selected the same 917 suites, with zero
green skips, zero deferrals, and one terminal result per selected suite:

| Quantity | Serial | Four static shards |
| --- | ---: | ---: |
| Runner suite wall | 1,364.399s (22.74 min) | 380.598s (6.34 min) |
| Start-to-duration-report | 1,406.224s | 415.527s |
| Non-suite harness overhead | 41.825s | 34.929s |
| Hermetic DB ready log | 13s | 3s, then four shard DB clones |
| Terminal suite outcomes | 911 passed / 6 failed | 912 passed / 5 failed |
| Duration-budget disposition | Hard per-suite violation at 199.368s; wall ALERT at 22.74 min | Within 90s suite ceilings and 9.0 min wall |

The raw observed wall ratio was **3.58×** (3.38× including harness overhead),
but this is **not a qualifying equivalence measurement**. Five failures were
identical in both modes; `tests/ghl-buyer-lifecycle-sync.test.ts` failed only
in the serial ordering on its two-row lease assertion and passed sharded. The
suite set was equal, but the terminal outcome maps were not. The serial run
also observed `tests/client/heatmap-style-not-ready.test.tsx` at 199.368s
versus 2.697s sharded, so the raw ratio is descriptive, not a scheduler-only
causal estimate. Because that suite has no registered `timeoutMs` override, the
serial attempt also breached the protected 90s per-attempt ceiling; this is a
hard full-smoke duration-budget violation separate from its six terminal suite
failures. Its 22.74-minute wall emitted the expected non-blocking 9.0-minute
wall ALERT. The sharded attempt was within both the per-suite ceilings and wall
budget.

The four-shard plan was 204/234/240/239 suites at
340.999/340.999/341.003/341.000s planned load. Actual work was
189.983/360.618/380.460/353.729s: **84.4% aggregate lane utilization** against
the slowest lane, **2.00× actual max/min skew**, and a **190.477s tail gap**
despite effectively perfect planned-load balance. The run had no shard-count
cap, lane crash, missing result, duplicate result, or foreign result. Reproduce
the protocol with:

```sh
TEST_SMOKE=1 TEST_FORCE_ALL=1 TEST_FULL_DEFERRAL=0 TEST_DYNAMIC_SHARDS=0 npm test -- --full-smoke --serial
TEST_SMOKE=1 TEST_FORCE_ALL=1 TEST_FULL_DEFERRAL=0 TEST_DYNAMIC_SHARDS=0 npm test -- --full-smoke --shards=4
```

Do not regenerate a budget or change scheduling policy unless a fresh pair is
complete, zero-skip, zero-deferral, all-green, has no hard duration-budget
violation, selects the same suites, and has an identical per-suite outcome map.
Full evidence and limitations are in
`audits/parallel-shard-equivalence-2026-08.md`.

**Current-main replacement attempt (2026-08-23):** the same protocol ran from
clean committed `main` at `0d28f68555b9b3115ad9a8cbfd900f150ff1340e`.
Both modes selected and executed the same 917 suites, skipped 0, deferred 0,
completed result accounting, and produced the same outcome map: 914 passed and
the same 3 failed.

Serial runner wall was **1,128.245s** versus **467.194s** for static four-shard
(an observed **2.41×** point ratio); start-to-duration-report was 1,162.389s
versus 501.659s (**2.32×**). The four lanes planned at
281.964/281.962/281.971/281.969s and ran at
278.638/291.489/273.375/467.048s: 70.2% aggregate utilization, 1.71× actual
max/min skew, and a 193.673s tail gap.

This pair is still **not qualifying**. Both controls were red, and the sharded
run recorded a hard duration-budget violation when
`tests/comms-bookmarks-sse-invalidation.test.tsx` took 181.9s/attempt against
the protected 90s default ceiling. The duration-budget artifact was deliberately
left unchanged and the sole writer was not run. The post-pair 42-day evidence
report initially parsed zero observations; after the final validation gate it
contained one failed related-smoke record, with 0 qualified shard-comparison
observations and 1 excluded. A one-point median/p95 is not a 42-day population,
so longitudinal median/p95, lint/cache, resource, and shard-efficiency
statistics remain not computable. See `audits/parallel-shard-equivalence-2026-08.md`
for complete metrics and limits.

**Post-repair clean rerun (2026-08-23):** the matched controls ran from clean
committed `main` at `cb214d8af05b76233f0af9df579a02e0b0e1a490`.
Both selected and executed the same 917 suites, skipped 0, deferred 0, returned
one recognized terminal result per selected suite, and produced the same
all-green outcome map (917 passed / 0 failed).

Serial runner wall was **1,078.458s** versus **433.833s** for static four-shard
(an observed **2.49×** point ratio); start-to-duration-report was 1,095.242s
versus 473.004s (**2.32×**), with 16.784s versus 39.171s outside-suite harness
overhead. The four lanes planned at
269.508/269.514/269.511/269.514s and ran at
284.436/281.301/433.440/253.827s: 72.3% aggregate utilization, 1.71× actual
max/min skew, and a 179.613s tail gap.

This pair is still **not qualifying**. The sharded run recorded a hard
duration-budget violation when
`tests/comms-bookmarks-sse-invalidation.test.tsx` took 180.580s/attempt against
the protected 90s default ceiling (the same suite took 0.107s serially).
Aggregate suite work was consequently 174.957s higher sharded, so neither the
raw ratio nor the outlier is attributed to scheduling causally. The duration
artifact, pins, runner, selector, fingerprints, baselines, retries, timeouts,
membership, and shard defaults remain unchanged; the sole budget writer was not
run. The post-pair 42-day report parsed 0 observations, so longitudinal
median/p95, lint/cache, resource, shard-efficiency, and failure-rate statistics
remain not computable. Full metrics and limits are in
`audits/parallel-shard-equivalence-2026-08.md`.


### Retained cap-reconsideration matrix

The task-gate evidence report retains a 14-day, aggregate-only comparison
(minimum 20 in-window observations for readiness) by
requested shard setting and decision source. Run `npx tsx
scripts/report-task-gate-evidence.ts` after each completed gate to inspect:

- gate wall median/p95, gate-process RSS median/p95, and batch-worker peak RSS;
- batch-worker recycle counts by hard cap, resource pressure, failure, and
  straggler causes;
- source and cap-reason totals, including `database-connections` and
  `shard-db-provisioning`;
- the hermetic database **capacity budget** (`max-reserved / connections per
  lane = safe lane cap`) that was used for each retained setting.

The database budget is capacity-policy evidence, **not** live PostgreSQL
utilization. `database-connections` means the verified policy cap limited a
run; it does not claim that the database was saturated. The runner currently
does not collect active connections, waits, or query latency, so no cap
decision may claim an unmeasured database-pressure improvement.

Use the same forced, zero-skip representative workload for every row and keep
the gate semantics unchanged:

| Comparison row | Request | Required retained evidence |
|---|---|---|
| Serial control | `TEST_FORCE_ALL=1 TEST_SHARDS=1 npm run gate --full-smoke` | Green verification; wall/RSS/recycles; source `env`, effective 1 |
| Bounded default | `TEST_FORCE_ALL=1 npm run gate --full-smoke` | Same workload and green verification; policy-selected effective count |
| Proposed higher cap | `TEST_FORCE_ALL=1 TEST_SHARDS=<candidate> npm run gate --full-smoke` | Same workload and green verification; requested/effective count, every cap reason, capacity budget, wall/RSS/recycles |

Run each row at least three times on comparable hardware with the same selected
universe, no skips or deferrals, and no incomplete lane result. The report
includes a setting row only for a passing full-smoke, zero-skip, zero-deferral
gate and splits rows by executed count; it reports excluded runner observations
separately. Do not compare a related gate, a changed test population, or a run
whose lint/cache state differs materially. The
four-lane ceiling can be reconsidered only after the retained 14-day evidence
(at least 20 in-window observations) shows a repeatable wall-time improvement
with no verification-semantic change,
no higher p95 RSS or resource-pressure recycle rate, and no new database-cap or
provisioning constraint. A candidate that is lowered to four lanes by the
existing policy is evidence to keep the ceiling, not evidence to raise it.
This matrix does not justify a duration-budget regeneration or a policy change.


#### Bounded pull dispatch (owner-approved, opt-in)

When estimates drift, an idle static lane can finish while another retains
unstarted work. Append `--dynamic-shards` (or set `TEST_DYNAMIC_SHARDS=1`) to
use the owner-approved bounded pull schedule. It is explicit: static LPT stays
the default and `--serial` always wins.

The pull queue is a finite, in-memory LPT-like order for the current `toRun`
population. A lane synchronously claims one suite immediately before starting
it; a claimed suite is never requeued or moved. Only the unstarted queue is
shared. Every lane continues to own its shard database, cache namespace,
retry/solo-recheck flow, timeout process groups, and atomic output buffer.
Because pull lanes have no fixed membership, their first attempts are
deliberately solo: this avoids inferring a batch worker from globally
compatible suites that may land in different lanes. Static LPT retains its
existing lane-local batch-worker recycling. A crash after claiming work
therefore remains an **INCOMPLETE** verification through the existing result
merge rather than causing a duplicate run.

For pull runs, the printed planned lane figures are clearly labeled as the
same-input static-LPT reference plan; actual lane figures describe the work
with terminal results returned by each lane. On a lane crash, claimed work
without a terminal result is intentionally absent from these partial
diagnostics and the run is marked incomplete. The resource envelope is
bounded: at most the
already-selected shard count runs concurrently, with the same one shard DB and
per-lane child/pool caps for each lane; pull mode adds no persistent batch
workers. No database, pool, timeout, or suite membership setting changes.

**Activation evidence (2026-08-21):** with the 11-suite forced zero-skip
subset above and the exact same saved duration estimates fed to both runs,
static LPT completed all 11 green in **13.84s** (slowest lane **13.79s**,
actual skew **1.27×**). Bounded pull completed the same 11 green in **12.04s**
(slowest lane **12.03s**, skew **1.03×**): a **13.0% wall** and **12.8% tail**
reduction. This is sufficient evidence for the opt-in path, not a reason to
change the default. Roll back immediately by omitting `--dynamic-shards` or
setting `TEST_DYNAMIC_SHARDS=0`; static LPT is then the only sharded path.

**Initial full-population bounded-pull attempt (2026-08-23):** after the bookmarks SSE
completion repair, clean committed `main`
`954adedd686d21b027ec1e420c1728bfb2fc2d6a` ran matched forced, zero-skip,
zero-deferral four-lane controls over the same 917 suites. Both returned one
terminal result per suite and had no duration-ceiling violation, cap reason,
lane crash, missing result, duplicate result, or foreign result.

Static LPT completed its suite loop in **306.480s** with actual lane work
305.373/306.264/294.019/274.338s (**96.32% utilization**, **1.116× skew**,
31.926s tail). Bounded pull completed in **534.590s** with
534.290/534.299/534.475/534.470s (**99.98% utilization**, **1.00035× skew**,
0.185s tail). The pull queue almost eliminated lane imbalance, but runner wall
was **74.4% slower** and aggregate suite work was **81.1% higher**.

Batching is the material measured tradeoff: static used 709 batched and 208
solo first attempts (39 worker starts, 670 reuses, 7 authoritative solo
rechecks); bounded pull deliberately used 917 solo attempts and no batch
workers. Static's peak batch-worker RSS was 690,544 KiB. Dynamic's 0 KiB means
no batch worker existed; it is not a whole-run memory measurement.

The outcome maps were not equivalent. Both controls failed
`tests/governance-test-portfolio-baseline.test.ts`; bounded pull additionally
failed `tests/lint-test-fs-scan-inputs.test.ts` and
`tests/report-metric-serif-guard.test.ts`, which passed static. This attempt
did not qualify. It identified two contained source/test defects; it did not
justify a scheduler-policy change. Full raw metrics and limitations are in
`audits/parallel-shard-equivalence-2026-08.md`.

**Qualifying full-population replacement pair (2026-08-23):** after those
blockers were repaired, clean committed `main`
`74831301475718faa48b4e0069d0ed31c9107116` ran the same forced controls again.
Before each control, the complete 917-suite duration-estimate report was
restored from the same frozen SHA-256 input
`80a482673580a63a0816e93c103ea56acbeb1954764ab046ccad8b7415dbce2b`.
The resulting static reference plans were identical, as were suite membership,
terminal outcome maps, attempts, and safety facts: **917 passed / 0 failed, 0
skipped, 0 deferred, one result and one attempt per suite, no incomplete lane
result, no cap reason, and no duration-ceiling violation**.

Static LPT completed its suite loop in **355.498s** with actual lane work
344.568/355.119/355.336/326.234s (**97.18% utilization**, **1.089× skew**,
29.102s tail). Bounded pull completed in **536.400s** with
535.869/535.687/536.303/536.211s (**99.95% utilization**, **1.00115× skew**,
0.616s tail). Pull nearly removed tail imbalance, but static was **180.902s /
50.9% faster** in runner wall and used **55.2% less aggregate suite work**.

The tradeoff is expected from the existing safety design: static ran 709
compatible first attempts batched and 208 solo (36 worker starts, 673 reuses,
6 authoritative solo rechecks); bounded pull ran 917 first attempts solo and
started no persistent batch workers. The 0 KiB dynamic batch-worker RSS is
therefore an absence-of-worker observation, not a whole-run memory result.

**Recommendation:** retain **static LPT as the default** and bounded pull as an
explicit opt-in. This one qualifying pair is sufficient to reject a
performance-based dynamic-default change today, but not to infer a 42-day
reliability/capacity result. The retained-evidence report still has 0
observations because benchmark controls are not gate records. Any future
default change or duration-budget action requires owner approval and a
documented multi-run/longitudinal evidence plan; do not alter shard counts,
timeouts, retries, suite membership, budgets, or resource caps from this pair.

### Duration budget + re-baseline

The committed `tests/gate-duration-budget.json` ratchet remains based on the
qualifying 2026-08-19 all-green four-shard run (413.485s; 900 selected; zero
skips and deferrals). The initial 2026-08-23 static/bounded-pull attempt did
not qualify; its replacement pair qualified for scheduler comparison but does
not itself authorize a budget change. The artifact was deliberately not
regenerated. Any future re-baseline needs owner approval and the sole writer,
`npx tsx scripts/regen-gate-duration-budget.ts`, after a fresh complete
sharded full-smoke run satisfies the separate budget eligibility protocol.

### Sharded DB provisioning

After the hermetic cluster is up and the ensures pass, `hermetic.createShardDbs(N)` creates `nobull_shard_0…nobull_shard_{N-1}` via `CREATE DATABASE … TEMPLATE nobull_test`. Each shard DB is a full copy of the ensured DB including boot DDL, kill-switch seeds, and the synthetic test user — tests within each shard get a clean, isolated, fully bootstrapped database. The shard DB names are per-run (each run provisions a fresh local Postgres cluster), so there is no cross-run contamination.

### Serial fallback

Pass `--serial` (or set `TEST_SHARDS=1`) to restore exact pre-5029 serial behavior: `stdio: "inherit"` (live streaming), the global `batchWorkers` map, and `killAllBatchWorkers()` after the loop. The sharded code paths are completely bypassed.

### Batch-worker efficiency telemetry and boundaries

The runner prints one aggregate `[batch]` line at completion and includes the
same counters in its duration/sweep report. It reports:

- suites compatible with the persistent worker versus suites kept solo for
  process-start arguments;
- actual batched and solo first attempts, plus the solo first-attempt
  end-to-end average (this includes suite work and is **not** presented as a
  pure process-start benchmark);
- worker starts, warm reuses, suites completed per worker, peak worker RSS,
  recycle causes, and batch-failure → solo re-verifications.

Only suites without `extraNodeArgs` are eligible. Loader and `--import` hooks
run at child-process startup, so they retain their exact solo `npx tsx` process
until the module-mocking owner explicitly proves a shared startup contract.
There is no alternate loader path in the batch worker.

Equivalent declarations of values the runner already injects may share the
existing worker: `NODE_ENV=test`, and the TSX test config for `.tsx` suites.
All other `extraEnv` values remain part of the compatibility key. This safely
joins redundant environment classes without allowing a behavior-changing
environment, DOM class, or loader hook to share state with another suite.

Every worker still recycles after `BATCH_WORKER_MAX_SUITES = 30`. In addition,
the child reports post-suite process RSS and the parent recycles it before the
next dispatch when it reaches the conservative 512 MiB limit (override
`RUN_ALL_BATCH_WORKER_MAX_RSS_BYTES` only in a focused harness test). Missing
or malformed health data simply preserves the hard-cap behavior. A failed,
timed-out, or predecessor-straggler child is also discarded, and every batch
failure still receives the authoritative solo re-verification.

`tests/batch-worker-policy.test.ts` guards the compatibility and recycle
policy. `tests/batch-worker-realm-isolation.test.ts` drives the real IPC worker
to prove JSDOM realm cleanup, canonical module-state resets between sibling
suites, health reporting, crash containment, and predecessor-straggler
re-dispatch semantics.

## Related

- `scripts/predeploy.sh` — gate implementation.
- `.replit` — deploy build command wiring.
- `tests/run-all.ts` — harness (bootstrap, spawn/retry, sweep report) + hermetic env injection + static/pull shard dispatch.
- `tests/shardScheduler.ts` — static LPT distributor, bounded pull dispatcher, env overlay builder, registration-order merger.
- `tests/parallel-shard-scheduler.test.ts` — smoke guard: exactly-once static/pull dispatch, drift balance, env overlay, merge order.
- `tests/testRegistry.ts` — registration-block format + registry derivation.
- `tests/durationBudget.ts`, `tests/gate-duration-budget.json` — duration-budget policy module + committed ratchet artifact (Task #4531).
- `tests/hermetic/provision.ts`, `tests/hermetic/bootstrap-db.ts` — hermetic provisioner + schema bootstrap.
- `tests/hermetic-db-guard.test.ts` — guard-chain regression suite (in the smoke gate).
