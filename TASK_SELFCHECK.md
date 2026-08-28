# Task Self-Check Runbook

**Who runs this.** Every task agent before marking a task implemented — as
engineering diligence, independent of how completion gets validated. Complete
the inspection obligations below (Steps 2–6 are non-executing; Step 1 is an
operator-only troubleshooting reference). Tests and testing infrastructure are
read-only to task agents: inspect them for behavioral context, but do not
create, edit, execute, or otherwise maintain them. Cite this runbook in your
implementation notes.

**Completion validation (owner decision, 2026-08-26).** Routine task
completion is validated by Replit's own built-in completion review — a task
agent is not required to run, or wait on, `npm run gate` (or any lint/smoke
subset) before marking a task done. The canonical policy is
[TESTING.md § Bounded task-validation policy](./TESTING.md#bounded-task-validation-policy-owner-approved).
The gate remains a fully-functional, manual, operator-triggered audit tool —
Step 1 below documents how an operator runs it by hand. Steps 2–6 require
diff/source inspection and coverage/documentation review, not commands.
The default for a routine task agent is to run none of it — `npm run gate`,
any individual lint script, or any test file — including as a "just to be
safe" self-check on a small edit; a check's size does not change whether it
is opt-in. Validation is operator-owned or scheduled, never a task-agent
exception for its own work. See [TESTING.md § Task-agent read-only boundary
for tests](./TESTING.md#task-agent-read-only-boundary-for-tests-owner-approved)
for the complete protected-surface taxonomy.

**Completion-review rejection.** If the built-in review flags unrelated files,
inherited validation output, environment noise, or a platform inconsistency,
preserve the task diff, use provenance or attribution evidence when relevant,
and do not request a fresh review. Do not launch compensating tests, lints,
typechecks, focused checks, or unrelated repairs. A task-owned finding remains
blocking and must be fixed.

**Gate command (manual/operator-triggered troubleshooting reference).**
`npm run gate` runs typecheck, every lint registered in `scripts/gate.ts`
`LINT_CHECKS`, and the smoke gate in one invocation. The managed `.replit`
**Long validation** workflow is the default durable path for a requested
canonical gate, using the reviewed `routine-gate` profile; direct shell
execution is troubleshooting-only. Focused lint commands stay standalone and
never receive dedicated workflows.
The smoke gate defaults to **related-only selection** (Task #3755): it runs
only the smoke tests whose traced import closure reaches your changed files,
plus a small always-run core, printing `selected N of M` and a per-test
reason; the machine-readable manifest lands in
`.local/runs/smoke-related-selection.json`. Use `npm run gate --full-smoke`
for the complete set only when an operator requests central integrity; it is
never a task-branch requirement. Nobody should add `--full-smoke`,
`--force-all`, `TEST_FORCE_ALL=1`, or `PREDEPLOY_FULL_TESTS=1` on their own
judgment — not even because a change touches widely shared, high-fan-in
files; that decision is reserved for an operator. When operator-run evidence
is included in completion notes, report the actual disposition (`selected N
of M related suites`, `reused-accepted-green-evidence`,
`deferred-and-not-verified`, etc.) and never describe a bounded
related-selection run, however large, as "the full smoke suite" or "full
suite required before completing any task"; see
[TESTING.md](./TESTING.md#full-suite-execution-operator-only-on-demand-policy)
for the full rule and vocabulary.

**Incremental execution (Task #3791).** Selected suites additionally skip
when their input fingerprint matches their last green run in this
environment (store: `.local/state/test-green-store.json`, gitignored).
Re-runs are cheap by design — the runner prints `executed N, skipped M
(green on identical inputs)` and audits every decision in
`.local/runs/incremental-skip.json`. Failures never record green, the
always-run core never skips, and every store/trace error falls open to
executing. Whenever an operator runs the gate, test-control-plane maintenance
keeps its existing focused policy/runner coverage; broad central-integrity
work is handed to the post-merge/nightly/weekly lane, recorded as
**deferred-and-not-verified** debt. An operator alone may request
`--force-all` / `TEST_FORCE_ALL=1`
through the central lanes — never a task agent, and never because a change
touches widely shared or high-fan-in files. Full-suite execution is never a
task-completion requirement;
[TESTING.md](./TESTING.md#bounded-task-validation-policy-owner-approved) is
the canonical disposition policy, and
[TESTING.md](./TESTING.md#full-suite-execution-operator-only-on-demand-policy)
gives the exact operator-only rule and the vocabulary for narrating a bounded
run.

---

## Step 1 — Operator-only gate troubleshooting reference

```bash
npm run gate
```

This runs (in order):
1. Scratch self-clean (`scripts/clean-scratch.ts --stale-only`, Task #3794) — deletes untracked junk-pattern files and TTL-prunes the sanctioned scratch zones (`.local/scratch/`, `tmp/`) so every task self-cleans at validation time; policy in [WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md)
2. TypeScript typecheck (`tsc`)
3. Every lint script registered in `scripts/gate.ts` `LINT_CHECKS` (including `lint-worktree-hygiene`, which validates the just-cleaned tree)
4. The smoke gate (`TEST_SMOKE=1 TEST_SMOKE_RELATED=1 npm test`) — the **related subset** of the smoke universe (tests whose registration block declares `"smoke": true`; see `tests/relatedSmokeSelection.ts`)

**Related-smoke selection.** Selection is automatic — no manual tagging. Changes to global-trigger paths (`migrations/`, `shared/schema*`, `package.json`/lockfile, `tsconfig*`, `.replit`, harness scripts — `scripts/gate.ts`, `scripts/gate-lint-worker.mjs`, `scripts/lint-*`, `scripts/predeploy.sh`, `scripts/post-merge.sh`; other `scripts/` files flow through normal tracing) and any selection failure (git, trace, unparseable file) retain directly affected/core proof and record explicit **deferred-and-not-verified** central-integrity debt; they never launch the full set automatically or become green evidence. If you do run the gate, inspect `.local/runs/attribution-report.json` before any repair and do not rerun unchanged or inherited failures. Force the complete set only explicitly with `npm run gate --full-smoke` when an operator requests central integrity — a task agent never adds that flag itself, including for changes to widely shared or high-fan-in files. The `.replit` **Long validation** workflow runs the related-smoke gate through the reviewed `routine-gate` profile when an operator requests it. A smoke test that reads repo sources via `fs` instead of imports is invisible to tracing: name it `tests/lint-*.test.ts` or add it to `DEFAULT_CORE_RULES` in the selector so it stays always-on.

**Operator-run pass criteria.** Exit code 0. Every check listed shows `OK` or
`PASS`. No new TS errors. No new lint violations. These criteria apply only
when an operator runs the gate; they are not routine completion steps.

**If the gate fails.**
- **First: read `.local/runs/attribution-report.json`** (Task #3922 — the gate summary prints a pointer when it is fresh). Each failure carries a verdict: `inherited` (red at upstream main with matching signature AND your diff provably disjoint from the suite's input closure — fingerprint equality with the committed `tests/red-manifest.json`) or `yours` (everything else; attribution errors deliberately fall open to `yours`). Hand-diagnose only `yours` failures. Do NOT re-derive stash/worktree innocence proofs, and do NOT ship a local fix for an `inherited` red — it gets ONE fix on main, not N duplicate task-side fixes. Cite the report verbatim in drift/skip explanations and completion-review rebuttals. Full rules: [TASK_PREFLIGHT.md § 12](./TASK_PREFLIGHT.md#12-inherited-gate-failures--merge-integrity).
- The smoke runner itself applies the same evidence: fully-proven inherited failures are **excused** (listed with evidence, non-blocking), so the final verdict line may read `Test run verdict: PASS with N excused inherited failure(s)` — that IS a pass, including in the **Long validation** workflow output. Excused failures still record FAILED locally (they never turn green); kill switch `TEST_ATTRIBUTION_EXCUSE=0`.
- Typecheck red in files you never touched right after a system merge → check `.local/runs/merge-integrity.json` (written by post-merge; rerun via `npx tsx scripts/verify-merge-integrity.ts`) before hand-fixing — the errors may be merge-inherited.
- New TS errors in your own files → fix them. Do not baseline or suppress without a documented reason.
- New lint violation → fix the code pattern, or (if genuinely grandfatherable) add the SHA1 to the appropriate `*.baseline.txt` with a comment explaining why.
- Smoke gate failure attributed `yours` → investigate the failing test. Do not skip or quarantine without a documented reason.
- **Gate lint red → the same report covers lints (Task #4491).** `.local/runs/attribution-report.json` carries a `lints` section: each failing lint gets an `inherited`/`yours` verdict from a live base-tree A/B re-run (budget `GATE_LINT_AB_BUDGET_MS`), plus a remedy hint in the gate summary. Consult it BEFORE any manual worktree/git-log proof; hand-fix only verdict-`yours` lints; inherited lint reds get ONE fix on main. Freshness lints self-heal at gate time — a `gate: auto-regenerate …` commit (route inventory / contract table / website bundle) is expected after completion rebases: review its diff, don't revert it. Kill switches: `GATE_LINT_ATTRIBUTION_EXCUSE=0`, `GATE_LINT_SELFHEAL=0`.
- **Remaining failure is ambiguous or plausibly contended (Task #5307) → skip, don't retry or ask.** A fresh timeout, a resource/budget-ceiling miss under load, a recent unrelated merge touching the same failing suite/config, a merge-integrity warning naming overlapping files, or a failure in known shared/contended test infrastructure all mean: one bounded gate attempt is final — do not re-run the gate, do not ship a competing local fix, and do not pause to ask the operator. Complete instead with a fully evidenced `skip_validation_reason` naming the check, quoting the exact error/budget/line, and stating why it's unrelated to the diff. Never applies to a failure plausibly caused by your own changed files — that stays fully blocking. Full rule: [TESTING.md § Bounded task-validation policy](./TESTING.md#bounded-task-validation-policy-owner-approved) and [TASK_PREFLIGHT.md § 12](./TASK_PREFLIGHT.md#12-inherited-gate-failures--merge-integrity).

---

## Step 2 — Inspect for new TypeScript errors

Without running a command, inspect the diff and touched files:

- [ ] No apparent type errors were introduced in files you touched.
- [ ] No `@ts-ignore` or `@ts-expect-error` added without a comment explaining the suppression.

---

## Step 3 — Inspect coverage and report test needs

For every behavioral change you shipped, inspect existing tests and testing
infrastructure for behavioral context. Task agents do not add or modify
coverage as part of the implementation task:

- [ ] Existing coverage was inspected for the changed path and its result is
  recorded in the implementation notes.
- [ ] Any missing, stale, or broken test coverage is reported with the
  affected protected surface and the needed follow-up; it is not repaired in
  this task.
- [ ] No test, fixture, mock, setup file, test data, runner, configuration,
  dependency, snapshot, registration block, baseline, manifest, or scheduled
  validation workflow was changed or executed.

---

## Step 4 — Inspect doc and index obligations

Work through the applicable items:

- [ ] **New root-level `.md` file?** → Row added to the **Runbook Index** in [RUNBOOKS.md](./RUNBOOKS.md) in this same change.
- [ ] **New env var, `system_settings` key, or kill switch?** → Row added to `audits/G-docs-findings.md § 4` in this same change.
- [ ] **New integration token keys?** → Added to `SETTINGS_CACHE_DENYLIST` (or `_PREFIXES`) in `server/storage/settingsStorage.ts` in this same change.
- [ ] **New lint script?** → Task agents do not create or change test-related
  lint scripts, gate registrations, or validation workflows. Report the need
  for an operator-owned follow-up instead. The managed `.replit` **Long
  validation** role remains the existing path for an operator-requested
  `routine-gate` profile; do not add a per-lint workflow.
- [ ] **Workflow or long-control lifecycle change needed?** → Task agents do
  not modify scheduled validation workflows or their configuration. Report
  the need for operator-owned maintenance; the existing `.replit` roles,
  ports, commands, metadata, and long-control cleanup boundary remain intact.
- [ ] **New root-level file or directory?** → Registered in `ROOT_ALLOWLIST_FILES` / `ROOT_ALLOWLIST_DIRS` in `scripts/worktreePolicy.ts` in this same change (root `.md` files take a RUNBOOKS.md index row instead). Transient files never go at the root — use `.local/scratch/` or `tmp/` ([WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md)).
- [ ] **New integration added to the Runtime Truth Table?** → Owning runbook created or extended; rows added to both coverage matrices in RUNBOOKS.md in this same change.
- [ ] **New operational subsystem** (own queue / credential / kill switch / alert / admin console)? → Owning runbook created; row added to the Operational Runbook Coverage Matrix in RUNBOOKS.md.

---

## Step 5 — Inspect migration naming and safety

If you added or renamed a migration file:

- [ ] The filename uses the Task #3786 timestamp convention: `$(date -u +%Y%m%d%H%M%S)_short_description.sql` (e.g. `20260804153012_add_widget_flags.sql`). Never pick "the next number" — the `NNNN_*` namespace is frozen (snapshot in `scripts/lint-migration-prefixes.ts`).
- [ ] The migration prefix and idempotence rules are satisfied by inspection.
- [ ] New migration DDL is idempotent (`IF NOT EXISTS` / `IF EXISTS`).

---

## Step 6 — Inspect prior-fix regression obligations

For each subsystem your task touches, ask: "Did a previous task already fix a bug in this area? Is that fix's guard still intact?"

Check the [memory entries](.agents/memory/MEMORY.md) and the [failure class catalog](./audits/preflight-selfcheck-findings.md) for prior incidents in the same subsystem. Common regressions to check:

| Subsystem | Guard to verify |
| --- | --- |
| Queue handlers | Required-handlers smoke test still lists the handler |
| OAuth / single-flight | `lint-oauth-refresh-single-flight` passes; probe does not wipe tokens |
| Prod-actions | `lint-prod-actions-no-re-press` passes; ramp uses `>=` |
| Coverage grain | Shared predicate not forked in new write path |
| Migration prefixes | `lint-migration-prefixes` passes post-rebase |
| Runbook index | `verify-runbook-coverage` passes |
| DB pool tenancy | `lint-db-pool-tenancy` passes; no `db` import in a worker file |
| Test hermeticity | `lint-test-shared-setting-pinning` passes |
| Worktree hygiene | `lint-worktree-hygiene` passes; scratch went to `.local/scratch/` or `tmp/`, not the root |
| Gate lint attribution | Report `lints` section (`.local/runs/attribution-report.json`) consulted before any manual innocence proof; only verdict-`yours` lints hand-fixed |
| Gate self-heal commits | If a `gate: auto-regenerate …` commit landed during validation, its artifact-only diff was reviewed (not reverted) |

- [ ] All relevant guards in the table above are present and not obviously bypassed for the subsystems this task touches. Do not run them as a routine substitute for review-by-inspection.

---

## Step 7 — Cite both runbooks in your implementation notes

Before marking done, your implementation notes must include:

> **Preflight.** Consulted TASK_PREFLIGHT.md §§ [list the sections you read].
> **Self-check.** All applicable Step 2–6 inspection items completed. (If the gate was also run manually, note its disposition — see Step 1.)

If any step was skipped, document why (e.g. "Step 3: behavior change is cosmetic-only, covered by existing snapshot test").

---

## Quick-reference: operator-only gate command details

The managed `.replit` **Long validation** workflow runs the `routine-gate`
profile through `npm run gate`, which runs the following checks. Each
standalone command remains available for operator-requested troubleshooting
only; none is a routine task-completion step and none has a dedicated
workflow.

| Step | Standalone command | Gate check ID |
| --- | --- | --- |
| Scratch self-clean | `npx tsx scripts/clean-scratch.ts --stale-only` (manual full wipe: `npm run clean:scratch`) | `clean-scratch` |
| TypeScript typecheck | `npm run check` | `typecheck` |
| SQL array bindings | `npx tsx scripts/lint-sql-array-bindings.ts` | `lint-sql-array-bindings` |
| GetDb attribution | `npx tsx scripts/lint-getdb-attribution.ts` | `lint-getdb-attribution` |
| DB pool tenancy | `npx tsx scripts/lint-db-pool-tenancy.ts` | `lint-db-pool-tenancy` |
| Apply state writers | `npx tsx scripts/lint-apply-state-writers.ts` | `lint-apply-state-writers` |
| replit.md lint | `npx tsx scripts/lint-replit-md.ts` | `lint-replit-md` |
| Migration prefixes | `npx tsx scripts/lint-migration-prefixes.ts` | `lint-migration-prefixes` |
| Migration immutability | `npx tsx scripts/lint-migration-immutability.ts` | `lint-migration-immutability` |
| OAuth single-flight | `npx tsx scripts/lint-oauth-refresh-single-flight.ts` | `lint-oauth-refresh-single-flight` |
| Prod-actions no-re-press | `npx tsx scripts/lint-prod-actions-no-re-press.ts` | `lint-prod-actions-no-re-press` |
| Front sync email triage | `npx tsx scripts/lint-front-sync-email-triage.ts` | `lint-front-sync-email-triage` |
| Test hedge comments | `npx tsx scripts/lint-test-hedge-comments.ts` | `lint-test-hedge-comments` |
| Probe swallow check | `npx tsx scripts/lint-probe-swallow-into-unauthorized.ts` | `lint-probe-swallow-into-unauthorized` |
| Front rematch restrict | `npx tsx scripts/lint-front-rematch-restrict-to-ids.ts` | `lint-front-rematch-restrict-to-ids` |
| Probe refresh purpose | `npx tsx scripts/lint-probe-refresh-purpose.ts` | `lint-probe-refresh-purpose` |
| Test setting pinning | `npx tsx scripts/lint-test-shared-setting-pinning.ts` | `lint-test-shared-setting-pinning` |
| Cross-instance locks | `npx tsx scripts/lint-cross-instance-locks.ts` | `lint-cross-instance-locks` |
| Calendar probe purpose | `npx tsx scripts/lint-calendar-preview-probe-purpose.ts` | `lint-calendar-preview-probe-purpose` |
| Keyword canonical | `npx tsx scripts/lint-keyword-canonical-lockstep.ts` | `lint-keyword-canonical-lockstep` |
| Heatmap color | `npx tsx scripts/lint-heatmap-color-lockstep.ts` | `lint-heatmap-color-lockstep` |
| Smoke gate regression | `npx tsx scripts/lint-smoke-gate-regression.ts` | `lint-smoke-gate-regression` |
| Comms shared components | `npx tsx scripts/lint-comms-shared-message-components.ts` | `lint-comms-shared-message-components` |
| Notification shared row | `npx tsx scripts/lint-notification-shared-row.ts` | `lint-notification-shared-row` |
| Worktree hygiene | `npx tsx scripts/lint-worktree-hygiene.ts` | `lint-worktree-hygiene` |
| Monolith aggregator size | `npx tsx scripts/lint-monolith-aggregator-size.ts` | `lint-monolith-aggregator-size` |
| Route inventory freshness | `npx tsx scripts/lint-route-inventory-freshness.ts` | `lint-route-inventory-freshness` |
| Single-line bare-ref routes (Task #4995) | `npx tsx scripts/lint-single-line-bare-ref-routes.ts` | `lint-single-line-bare-ref-routes` |
| Contract table freshness | `npx tsx scripts/lint-contract-table-freshness.ts` | `lint-contract-table-freshness` |
| Website bundle freshness | `npx tsx scripts/lint-website-bundle-freshness.ts` | `lint-website-bundle-freshness` |
| Async correctness (typescript-eslint, ~2.5min) | `npx tsx scripts/lint-async-correctness.ts` | `lint-async-correctness` |
| Periodic pool ownership | `npx tsx scripts/lint-periodic-pool-ownership.ts` | `lint-periodic-pool-ownership` |
| Upload content verification | `npx tsx scripts/lint-upload-content-verification.ts` | `lint-upload-content-verification` |
| Test file parseability | `npx tsx scripts/lint-test-file-parseability.ts` | `lint-test-file-parseability` |
| Test fs-scan inputs declared | `npx tsx scripts/lint-test-fs-scan-inputs.ts` | `lint-test-fs-scan-inputs` |
| Server import cycles | `npx tsx scripts/lint-server-import-cycles.ts` | `lint-server-import-cycles` |
| Route classification (observed-public allow-list) | `npx tsx scripts/lint-route-classification.ts` | `lint-route-classification` |
| Vendor SDK confinement (importer baseline) | `npx tsx scripts/lint-vendor-confinement.ts` | `lint-vendor-confinement` |
| Persistence spread boundary (F8 ratchet) | `npx tsx scripts/lint-persistence-spread-boundary.ts` | `lint-persistence-spread-boundary` |
| Storage broad-update boundary (Task #4250 ratchet) | `npx tsx scripts/lint-storage-update-boundary.ts` | `lint-storage-update-boundary` |
| Gate/workflow drift | `npx tsx scripts/lint-gate-workflow-drift.ts` | `lint-gate-workflow-drift` |
| Calendar fixture bucket gap | `npx tsx scripts/lint-calendar-fixture-bucket-gap.ts` | `lint-calendar-fixture-bucket-gap` |
| Design hex-color ratchet (Task #4347) | `npx tsx scripts/lint-design-hex-colors.ts` | `lint-design-hex-colors` |
| Design text-[Npx] ratchet (Task #4347) | `npx tsx scripts/lint-design-text-px.ts` | `lint-design-text-px` |
| Design rounded-* ratchet (Task #4347) | `npx tsx scripts/lint-design-rounded.ts` | `lint-design-rounded` |
| Design z-index ratchet (Task #4347) | `npx tsx scripts/lint-design-z-index.ts` | `lint-design-z-index` |
| Design chart fontSize floor (Task #4500) | `npx tsx scripts/lint-design-chart-font-size.ts` | `lint-design-chart-font-size` |
| Design bg-primary+text-white pairing ratchet (Task #4726) | `npx tsx scripts/lint-design-primary-white.ts` | `lint-design-primary-white` |
| Brief-surface report-token guard (Task #4929) | `npx tsx scripts/lint-brief-surface-report-tokens.ts` | `lint-brief-surface-report-tokens` |
| Bundle budget (vite build, ~45s) | `npx tsx scripts/lint-bundle-budget.ts` | `lint-bundle-budget` |
| Smoke gate (tests) | `npm run gate` (routine related-only gate; a central operator may explicitly request full-smoke/force-all — never the task agent itself) | `smoke-gate` |

**Never narrate a bounded gate run as "the full smoke suite."** Report the actual disposition and counts (`selected N of M related suites`, `reused-accepted-green-evidence`, `deferred-and-not-verified`); see [TESTING.md](./TESTING.md#full-suite-execution-operator-only-on-demand-policy) for the operator-only rule and exact vocabulary.
