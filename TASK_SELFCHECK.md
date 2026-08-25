# Task Self-Check Runbook

**Who runs this.** Every task agent before marking a task implemented. Complete every item below. Cite this runbook in your implementation notes.

**Gate command.** `npm run gate` — runs typecheck, every lint registered in
`scripts/gate.ts` `LINT_CHECKS`, and the smoke gate in one invocation. The
single `.replit` **Validate** role runs this command; focused lint commands stay
standalone and never receive dedicated workflows. The command must pass before
marking done. The smoke gate defaults to **related-only selection** (Task
#3755): it runs only the smoke tests whose traced import closure reaches your
changed files, plus a small always-run core, printing `selected N of M` and a
per-test reason; the machine-readable manifest lands in
`.local/runs/smoke-related-selection.json`. Use `npm run gate --full-smoke` for
the complete set.

**Incremental execution (Task #3791).** Selected suites additionally skip when their input fingerprint matches their last green run in this environment (store: `.local/state/test-green-store.json`, gitignored). Run the gate ONCE at completion; re-runs are cheap by design — the runner prints `executed N, skipped M (green on identical inputs)` and audits every decision in `.local/runs/incremental-skip.json`. Failures never record green, the always-run core never skips, and every store/trace error falls open to executing. Force full execution with `--force-all` / `TEST_FORCE_ALL=1` when you suspect inputs fingerprints cannot see (shared dev-DB data shape, env semantics, timing). Full-suite execution is on-demand only — never the default cost of validating or publishing (see TESTING.md § Incremental execution).

---

## Step 1 — Run the consolidated gate

```bash
npm run gate
```

This runs (in order):
1. Scratch self-clean (`scripts/clean-scratch.ts --stale-only`, Task #3794) — deletes untracked junk-pattern files and TTL-prunes the sanctioned scratch zones (`.local/scratch/`, `tmp/`) so every task self-cleans at validation time; policy in [WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md)
2. TypeScript typecheck (`tsc`)
3. Every lint script registered in `scripts/gate.ts` `LINT_CHECKS` (including `lint-worktree-hygiene`, which validates the just-cleaned tree)
4. The smoke gate (`TEST_SMOKE=1 TEST_SMOKE_RELATED=1 npm test`) — the **related subset** of the smoke universe (tests whose registration block declares `"smoke": true`; see `tests/relatedSmokeSelection.ts`)

**Related-smoke selection (Task #3755).** Selection is automatic — no manual tagging. Changes to global-trigger paths (`migrations/`, `shared/schema*`, `package.json`/lockfile, `tsconfig*`, `.replit`, harness scripts — `scripts/gate.ts`, `scripts/gate-lint-worker.mjs`, `scripts/lint-*`, `scripts/predeploy.sh`, `scripts/post-merge.sh`; Task #3789: other `scripts/` files no longer widen — `tests/run-all.ts`, `tests/testRegistry.ts`, `tests/helpers/`, the selector, `server/db.ts`/`server/devMigrations.ts`) widen to the full set automatically, and ANY selection failure (git, trace, unparseable file) falls open to the full set — never to zero. Force the complete set explicitly with `npm run gate --full-smoke` (or plain `TEST_SMOKE=1 npm test`) when validating cross-cutting work whose blast radius you cannot trace to imports (e.g. env-var semantics, DB data shape, timing behavior). The `.replit` `Validate` workflow deliberately runs the routine related-smoke gate through `npm run gate`; it does not maintain a second full-smoke path. A smoke test that reads repo sources via `fs` instead of imports is invisible to tracing: name it `tests/lint-*.test.ts` or add it to `DEFAULT_CORE_RULES` in the selector so it stays always-on.

**Pass criteria.** Exit code 0. Every check listed shows `OK` or `PASS`. No new TS errors. No new lint violations.

**If the gate fails.**
- **First: read `.local/runs/attribution-report.json`** (Task #3922 — the gate summary prints a pointer when it is fresh). Each failure carries a verdict: `inherited` (red at upstream main with matching signature AND your diff provably disjoint from the suite's input closure — fingerprint equality with the committed `tests/red-manifest.json`) or `yours` (everything else; attribution errors deliberately fall open to `yours`). Hand-diagnose only `yours` failures. Do NOT re-derive stash/worktree innocence proofs, and do NOT ship a local fix for an `inherited` red — it gets ONE fix on main, not N duplicate task-side fixes. Cite the report verbatim in drift/skip explanations and completion-review rebuttals. Full rules: [TASK_PREFLIGHT.md § 12](./TASK_PREFLIGHT.md#12-inherited-gate-failures--merge-integrity).
- The smoke runner itself applies the same evidence: fully-proven inherited failures are **excused** (listed with evidence, non-blocking), so the final verdict line may read `Test run verdict: PASS with N excused inherited failure(s)` — that IS a pass, including in the `Validate` workflow output. Excused failures still record FAILED locally (they never turn green); kill switch `TEST_ATTRIBUTION_EXCUSE=0`.
- Typecheck red in files you never touched right after a system merge → check `.local/runs/merge-integrity.json` (written by post-merge; rerun via `npx tsx scripts/verify-merge-integrity.ts`) before hand-fixing — the errors may be merge-inherited.
- New TS errors in your own files → fix them. Do not baseline or suppress without a documented reason.
- New lint violation → fix the code pattern, or (if genuinely grandfatherable) add the SHA1 to the appropriate `*.baseline.txt` with a comment explaining why.
- Smoke gate failure attributed `yours` → investigate the failing test. Do not skip or quarantine without a documented reason.
- **Gate lint red → the same report covers lints (Task #4491).** `.local/runs/attribution-report.json` carries a `lints` section: each failing lint gets an `inherited`/`yours` verdict from a live base-tree A/B re-run (budget `GATE_LINT_AB_BUDGET_MS`), plus a remedy hint in the gate summary. Consult it BEFORE any manual worktree/git-log proof; hand-fix only verdict-`yours` lints; inherited lint reds get ONE fix on main. Freshness lints self-heal at gate time — a `gate: auto-regenerate …` commit (route inventory / contract table / website bundle) is expected after completion rebases: review its diff, don't revert it. Kill switches: `GATE_LINT_ATTRIBUTION_EXCUSE=0`, `GATE_LINT_SELFHEAL=0`.

---

## Step 2 — Verify no new TypeScript errors

Even if the gate passes, confirm:

- [ ] `npm run check` exits 0.
- [ ] No errors introduced in files you touched (check the tsc output for your changed files).
- [ ] No `@ts-ignore` or `@ts-expect-error` added without a comment explaining the suppression.

---

## Step 3 — Verify tests for changed behavior

For every behavioral change you shipped:

- [ ] A test covers the changed path (new test or meaningful strengthening of an existing test).
- [ ] The test is **hermetic**: it pins + restores any `system_settings` it reads; it uses isolated schema or unique per-run IDs for any DB rows; it cleans up in `finally`.
- [ ] The test is **registered** (Task #3786): a `/* test-registration` block at the very top of the file (line 1) with at least a `"name"`. There is no central array to edit — the runner discovers the file. Format reference: `tests/testRegistry.ts`; template: TESTING.md.
- [ ] The test is in the **right gate**, recorded in its own block:
  - Fast (< 30 s), DB-free or near-DB-free, and guarding a behavior that has regressed before → `"regression": true, "smoke": true` plus a `"smokeReason"`.
  - All other regression tests → `"regression": true` plus a `"sweepOnlyReason"` (slow / DB-heavy / contention-sensitive) — `lint-smoke-gate-regression` fails without one.
  - See the memory entry "[The gate is smoke membership, not the regression flag](./audits/preflight-selfcheck-findings.md)" for the distinction.
  - Note: `"smoke": true` makes a test *eligible* for the routine gate; the related-selection default (Task #3755) actually runs it when its import closure reaches the changed files. A smoke test whose subject is read via `fs` (not imported) must be named `tests/lint-*.test.ts` or listed in `DEFAULT_CORE_RULES` in `tests/relatedSmokeSelection.ts`, or it will only run in full-set runs.

---

## Step 4 — Check doc and index obligations

Work through the applicable items:

- [ ] **New root-level `.md` file?** → Row added to the **Runbook Index** in [RUNBOOKS.md](./RUNBOOKS.md) in this same change. Run `npx tsx scripts/verify-runbook-coverage.ts` to confirm.
- [ ] **New env var, `system_settings` key, or kill switch?** → Row added to `audits/G-docs-findings.md § 4` in this same change.
- [ ] **New integration token keys?** → Added to `SETTINGS_CACHE_DENYLIST` (or `_PREFIXES`) in `server/storage/settingsStorage.ts` in this same change.
- [ ] **New lint script?** → The script exports a side-effect-free `cliMain(): number` with a bottom `isMain` guard (Task #3789 — the gate imports it into a worker thread; `tests/gate-lint-phase.test.ts` enforces the contract), and an entry is added to `LINT_CHECKS` in `scripts/gate.ts` (shape `{ name, script }`). The single `.replit` `Validate` role runs the whole registry; do not add a per-lint workflow.
- [ ] **Workflow or long-control lifecycle change?** → `.replit` remains at the approved 3/3 role capacity with 0 spare slots; application port 5000 and Mockup Sandbox port 23636 retain their one owners; each role names owner/purpose/retirement/slot-budget metadata; long-control cleanup is confined to `.local/runs/long-validation/`.
- [ ] **New root-level file or directory?** → Registered in `ROOT_ALLOWLIST_FILES` / `ROOT_ALLOWLIST_DIRS` in `scripts/worktreePolicy.ts` in this same change (root `.md` files take a RUNBOOKS.md index row instead). Transient files never go at the root — use `.local/scratch/` or `tmp/` ([WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md)).
- [ ] **New integration added to the Runtime Truth Table?** → Owning runbook created or extended; rows added to both coverage matrices in RUNBOOKS.md in this same change.
- [ ] **New operational subsystem** (own queue / credential / kill switch / alert / admin console)? → Owning runbook created; row added to the Operational Runbook Coverage Matrix in RUNBOOKS.md.

---

## Step 5 — Migration prefix check

If you added or renamed a migration file:

- [ ] The filename uses the Task #3786 timestamp convention: `$(date -u +%Y%m%d%H%M%S)_short_description.sql` (e.g. `20260804153012_add_widget_flags.sql`). Never pick "the next number" — the `NNNN_*` namespace is frozen (snapshot in `scripts/lint-migration-prefixes.ts`).
- [ ] `npx tsx scripts/lint-migration-prefixes.ts` exits 0.
- [ ] New migration DDL is idempotent (`IF NOT EXISTS` / `IF EXISTS`).

---

## Step 6 — Prior-fix regression check

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

- [ ] All relevant guards in the table above are confirmed passing for the subsystems this task touches.

---

## Step 7 — Cite both runbooks in your implementation notes

Before marking done, your implementation notes must include:

> **Preflight.** Consulted TASK_PREFLIGHT.md §§ [list the sections you read].
> **Self-check.** `npm run gate` passed. All Step 2–6 items verified.

If any step was skipped, document why (e.g. "Step 3: behavior change is cosmetic-only, covered by existing snapshot test").

---

## Quick-reference: gate command details

The `.replit` `Validate` workflow runs `npm run gate`, which runs the following checks. Each remains available as a standalone command for targeted debugging; none has a dedicated workflow.

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
| Smoke gate (tests) | `TEST_SMOKE=1 TEST_FILE_TIMEOUT_MS=180000 npm test` (full set; the routine gate adds `TEST_SMOKE_RELATED=1`; both skip suites green on identical inputs — Task #3791 — so a re-run right after a green run only executes the always-run core; bypass with `TEST_FORCE_ALL=1`) | `smoke-gate` |
