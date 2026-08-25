# Task Preflight Runbook

**Who reads this.** Every task agent (planning, main, task) before writing code. Consult the sections that match the subsystems your task touches. Each section takes under two minutes to read.

**Evidence base.** Failure classes and representative incident chains are in [`audits/preflight-selfcheck-findings.md`](./audits/preflight-selfcheck-findings.md).

---

## Which sections apply to my task?

Use this router before reading the full preflight. Read every section whose trigger matches your task's scope.

| If your task touches… | Read section(s) |
| --- | --- |
| A queue handler or producer (`work_queue`, `workScheduler`) | [§ 1 Queues](#1-queues--workers) |
| OAuth / token rotation (Front, Zoom, SEMrush, Google, Replit Auth) | [§ 2 OAuth & Tokens](#2-oauth--token-rotation) |
| A new return path that could silently return empty/zero/stale | [§ 3 Silent Failure](#3-silent-failuredegradation) |
| Tests (new or modified) | [§ 4 Test Hermeticity](#4-test-hermeticity) |
| A prod-action, admin drain, or convergence flow | [§ 5 Prod-Actions & Convergence](#5-prod-actions--convergence) |
| Front analytics coverage, grain, or accumulator | [§ 6 Coverage & Grain](#6-coverage--grain) |
| A caching layer or React Query invalidation | [§ 7 Caching & Version Markers](#7-caching--version-markers) |
| A DB migration or schema change | [§ 8 Schema & Migrations](#8-schema--migrations) |
| A new runbook, env var, system_settings key, or lint script | [§ 9 Docs & Gate Drift](#9-docs--gate-drift) |
| An alert, circuit breaker, or self-heal scheduler | [§ 10 Alerting & Self-Heal](#10-alerting--self-heal) |
| Transient/scratch files, a new root-level entry, or cleanup tooling | [§ 11 Scratch & Worktree Hygiene](#11-scratch--worktree-hygiene) |
| A red gate you suspect you didn't cause, or a mid-session system merge just landed | [§ 12 Inherited Gate Failures & Merge Integrity](#12-inherited-gate-failures--merge-integrity) |
| A task spanning multiple sections/modules/docs/test suites, or one that reads like a rebuild/restructure/overhaul | [§ 13 Epic Decomposition](#13-epic-decomposition) |

---

## 1. Queues & Workers

**Failure class FC-01** — Queue producer/consumer mismatch.

**Tell-tale symptom.** Queue table has rows but `MAX(created_at) IS NULL` on the handler side, or handler exists but nothing ever enqueues.

**Required design rules.**

1. Every queue handler must have a corresponding producer, and vice versa. If you add a handler, verify something enqueues to it. If you delete a handler, audit all producers and remove or reroute them.
2. The startup required-handlers assert is warn-only; the SMOKE_FILES smoke test is the enforcement gate. Do not rely on runtime startup warnings alone.
3. Worker-context code (schedulers, background jobs, maintenance sweeps) must use `workerDb` / `runWithWorkerDb`, never the `api` pool `db`. See [RUNBOOKS.md § Pool tenancy rules](./RUNBOOKS.md#pool-tenancy-rules-canonical-home).

**Pre-code checks.**
- [ ] `rg -n "enqueue\|workQueue" server/` — confirm both sides of any new queue exist.
- [ ] `rg "workerDb\|runWithWorkerDb" <your-file>` — confirm worker-pool import if scheduling work.
- [ ] If deleting a handler, grep for its queue type string and remove all producers.

---

## 2. OAuth & Token Rotation

**Failure class FC-02** — OAuth rotation race / false disconnect.

**Tell-tale symptom.** Integration shows "disconnected" immediately after a token refresh. Alert fires but integration never self-heals. 401 recurs on every request even though creds were supposedly rotated.

**Required design rules.**

1. Every rotating-refresh-token integration must route its refresh POST through `withSingleFlightOAuthRefresh` (per-process + cross-process Postgres lease). No bare `POST /oauth/token` calls outside this helper. Enforced by `lint-oauth-refresh-single-flight`.
2. **Proactive** keep-alive and **reactive** 401 paths must both be gated by the single-flight helper. Gating only the 401 path leaves the proactive flood gap open.
3. Probe/health-check refreshes must surface `Unauthorized` **without** wiping tokens. Only the authoritative on-demand path may wipe. `onTerminalAfterRetry` wipes go inside `withSingleFlightOAuthRefresh`, never in a probe.
4. Before wiping, confirm the token fingerprint changed (sibling rotated it) — same or empty fingerprint means the token is genuinely revoked, proceed; changed fingerprint means abort the wipe.
5. Replit Auth breaker keys by `sha256(sessionID)`, not user sub — sub-keying merges browser sessions.

**Pre-code checks.**
- [ ] `rg "withSingleFlightOAuthRefresh" server/services/<integration>.ts` — present for new integration?
- [ ] Proactive keep-alive scheduler also routed through the helper?
- [ ] Probe path returns 401-class error without wiping stored tokens?

---

## 3. Silent Failure / Degradation

**Failure class FC-03** — Silent failure or degradation path.

**Tell-tale symptom.** Endpoint returns 200 with an empty array or zero instead of an error. Cache serves stale data. Probe returns `connected: true` when the credential is missing.

**Required design rules.**

1. Probe accessors must **throw** (or re-throw as `Unauthorized`) on unknown/settings-read errors, not return `false-connected`. Enforced by `lint-probe-swallow-into-unauthorized`.
2. Probe path and refresh path must be separated in purpose. A probe must not rotate tokens; a refresh must not be gated as a health check. Enforced by `lint-probe-refresh-purpose`.
3. Missing/unconfigured state must degrade with a badge (Needs Review / gray / "Not configured"), never silently pass or return an empty success.
4. Cache misses for versioned payloads must emit a stale-marker or re-compute, not serve zero.

**Pre-code checks.**
- [ ] Does any new error handler use `|| []` / `?? 0` / swallowed catch? Replace with explicit error surface.
- [ ] Does any probe function catch and return `connected: false` instead of re-throwing? Fix it.
- [ ] Does the RIS / BigQuery path degrade to Needs Review on missing config, not silent Pass?

---

## 4. Test Hermeticity

**Failure class FC-04** — Non-hermetic tests / shared-state pollution.

**Tell-tale symptom.** Tests pass alone, fail when run together. A SIGKILL'd suite leaves leaked settings that poison siblings. A test that previously passed starts failing after an unrelated task.

**Required design rules.**

1. Every test that reads a `system_settings` key must pin + restore it in setup/teardown (`setSystemSetting` → restore original in `afterEach`). Enforced by `lint-test-shared-setting-pinning`.
2. `runInIsolatedSchema` clones only tables you explicitly pass; uncloned tables fall through to `public.*` and pollute or are polluted by the shared dev DB. Clone all tables your test touches.
3. `workerDb` calls bypass `runInTxSandbox`; seed those tables in `public.*` with unique per-run identifiers and clean up in `finally`.
4. Route tests that open a local Express server must close `getGlobalDispatcher()` at teardown (undici keep-alive drain hang).
5. Tests that `void` async side-effects must expose `__test_drainPending*()` and drain before assertions.
6. Never add a hedge comment (`// TODO fix`, `// known flaky`) without a concrete plan. Enforced by `lint-test-hedge-comments`.

**Pre-code checks.**
- [ ] Any `setSystemSetting` call → matching restore in `afterEach`?
- [ ] `runInIsolatedSchema` → tables list includes every table the test SELECTs or INSERTs?
- [ ] New route test → `getGlobalDispatcher().close()` in teardown?
- [ ] SMOKE_FILES: is this test fast (< 30 s, DB-free preferred) and guarding a behavior that's regressed before? If yes, add it. If no, add `regression: true` and do not add to SMOKE_FILES.

---

## 5. Prod-Actions & Convergence

**Failure class FC-05** — Non-convergent admin / prod-action.

**Tell-tale symptom.** CEO button stays Pending after apply. Running the action twice shows the same pending count. Different instances show different counts.

**Required design rules.**

1. Terminal items must stop being counted. Add a permanent exclusion predicate or a separate revival path. Running the action twice must yield 0 pending on the second run.
2. Cross-instance drains must hold a Postgres session advisory lock (`crossInstanceLock.ts`) — in-process single-flight Map is not enough on a Reserved VM / autoscale.
3. Ramp-ladder comparisons must use `>=` (floor), not `===`. Exact-match makes overshot rungs perpetually pending and causes downgrades. Enforced by the ramp-floor test.
4. Prod-action "flip a switch" actions must read via the **runtime consumer's accessor** (e.g. `killSwitch()`) and write unconditionally — `storage.getSystemSettings` caches diverge from `killSwitch` caches.
5. Press buttons must not be re-pressable while pending. Enforced by `lint-prod-actions-no-re-press`.

**Pre-code checks.**
- [ ] Pending count will reach zero after convergence? Test by running apply twice.
- [ ] Cross-instance advisory lock acquired before any stateful drain operation?
- [ ] Ramp comparisons use `>=`, not `===`?
- [ ] `storage.getSystemSettings` never used to read a kill-switch for a flip action?

---

## 6. Coverage & Grain

**Failure class FC-06** — Coverage / grain mismatch.

**Tell-tale symptom.** Coverage percentages are wrong. A month shows 100% but messages are missing. Recompute produces a different number than the initial write.

**Required design rules.**

1. All write paths to a coverage table must use **one shared predicate** for grain selection (e.g. `messages_all` row grain). A second write path that uses a different predicate will silently downgrade rows.
2. Recompute must keep the same grain as the initial write. Do not re-pull from conversations when the initial write was message-grain.
3. The adoption floor (`front_adoption_date`) must be applied at the **consumer**, not filtered at the source. `getFrontAnalyticsCoverageSummary` returns all cached months; sweep callers filter themselves.
4. Covered-but-wrong-grain months remain sweep candidates until they are upgraded to the correct grain.

**Pre-code checks.**
- [ ] New coverage write path uses the same grain predicate as the existing paths in `messages_all`?
- [ ] Recompute reads from the same grain source as the initial write?
- [ ] Adoption floor filtering done at the sweep/caller, not in the shared summary function?

---

## 7. Caching & Version Markers

**Failure class FC-08** — Caching / version marker drift.

**Tell-tale symptom.** A shape change deploys but stale cached entries serve the old shape. UI shows data that was computed before the change. React Query shows a saved mutation "reverting."

**Required design rules.**

1. Any change to a `compute*DriverTree` response shape must bump its cache key in lockstep. "We changed the shape" is not complete without "we bumped the key."
2. Heatmap geometry and color caches carry a version marker (set at write, checked at serve). Any geometry or color logic change must bump the version.
3. React Query mutations must call `queryClient.setQueryData(...)` authoritatively in `onSuccess` before `invalidateQueries`. Without `setQueryData`, the read view waits on a stale/deferred refetch and appears to "revert."
4. SWR-cached config-list GETs must use list-cache-sparing invalidation on writes (not full-cache flush) to avoid thundering-herd under pool contention.

**Pre-code checks.**
- [ ] Changing a cached payload shape → bump the cache key string.
- [ ] Heatmap geometry/color change → bump `GEOMETRY_CACHE_VERSION` or equivalent.
- [ ] New mutation → `setQueryData` in `onSuccess`, then `invalidateQueries`.

---

## 8. Schema & Migrations

**Failure class FC-09** — Schema / migration issues.

**Tell-tale symptom.** Dev server or run-all fails to start after a migration. Publish diff emits unexpected DROP. Two migrations share a numeric prefix.

**Required design rules.**

1. All migration DDL must be idempotent: use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP TABLE IF EXISTS`, etc.
2. After every rebase, re-check migration prefixes for collision: `npx tsx scripts/lint-migration-prefixes.ts`. Enforced by `lint-migration-prefixes` workflow and predeploy.
3. Never use `drizzle-kit push` in a non-interactive context (it prompts for TRUNCATE on constraint-name mismatch). Use idempotent SQL migrations.
4. Objects that must exist in prod must also exist in the dev DB before publish — Drizzle diffs dev vs prod and emits DROP for objects absent from dev. Raw-SQL / startup-created objects must be reflected in the dev schema.
5. Cite migrations by full filename (e.g. `0055_add_twilio_voicemail_fields.sql`), never by number alone. Numeric prefixes are not unique.

**Pre-code checks.**
- [ ] New migration DDL uses `IF NOT EXISTS` / `IF EXISTS` guards throughout?
- [ ] `npx tsx scripts/lint-migration-prefixes.ts` passes after adding the new file?
- [ ] New objects also created in dev DB if needed before publish?

---

## 9. Docs & Gate Drift

**Failure class FC-10** — Doc / gate drift.

**Tell-tale symptom.** Publish blocked because a new root-level `.md` file is missing from RUNBOOKS.md. New env var shows up in production but has no § 4 row. A new lint script exists in `scripts/` but is never run.

**Required design rules.**

1. **New root-level `.md` file** → add a row to the Runbook Index in [RUNBOOKS.md](./RUNBOOKS.md) **in the same change**. Enforced by `scripts/verify-runbook-coverage.ts` (predeploy gate).
2. **New env var or `system_settings` key or kill switch** → add a row to `audits/G-docs-findings.md § 4` in the same change. See [replit.md § Doc Hygiene](./replit.md#doc-hygiene).
3. **New integration token keys** → add to `SETTINGS_CACHE_DENYLIST` (or `_PREFIXES`) in `server/storage/settingsStorage.ts` in the same change.
4. **New lint script** → add it to the `LINT_CHECKS` array in `scripts/gate.ts`; the single `.replit` `Validate` role runs the entire registry via `npm run gate`. Do not add a per-lint workflow.
5. **Workflow or long-control lifecycle change** → preserve the three-role capacity budget (no spare repository slots), protected application/artifact ports, role metadata (owner, purpose, retirement trigger, slot budget), and namespace-only long-control cleanup. Do not borrow a runtime workflow for controls.
6. **New integration added to the Runtime Truth Table** → create or extend an owning runbook and add rows to both coverage matrices in RUNBOOKS.md in the same change.

**Pre-code checks.**
- [ ] Adding a root-level `.md`? → RUNBOOKS.md Runbook Index row in this same PR.
- [ ] Adding an env var / system_settings key / kill switch? → G-docs-findings.md § 4 row in this same PR.
- [ ] Adding a new lint script? → `scripts/gate.ts` LINT_CHECKS entry in this same PR; confirm the standalone CLI still works and do not add a per-lint workflow.
- [ ] Changing `.replit`, the workflow guard, or long-control evidence? → approved role metadata, protected port ownership, and `.local/runs/long-validation/`-only retention verified; no generic `.local` cleanup widened.
- [ ] `npx tsx scripts/verify-runbook-coverage.ts` passes?

---

## 10. Alerting & Self-Heal

**Failure class FC-11** — Alerting / self-heal gap.

**Tell-tale symptom.** An alert fires on every poll (spam) or never fires (silent). Self-heal reports "failing" but the alert is indistinguishable from a transient error. Slack channel_not_found silently swallows all subsequent notifications.

**Required design rules.**

1. **`blocked` state** (auth-dead, deterministic) must alert **once per streak** via `dedupeKey`, re-arm on a healthy run. No threshold needed — it is deterministic.
2. **`error` state** (transient failure) needs a **consecutive threshold** before alerting. Do not alert on the first transient error.
3. `blocked` and `error` flags must be **separate** — sharing the same flag makes the threshold wrong for both states.
4. Slack channel_not_found must fan an **in-app meta-alert** to admins (rate-limited per channelId, ≤ 1 per 6 hours). Never rely on Slack to deliver the alert about Slack being broken.
5. New integration probes must split **confirmed-empty** (no creds stored) from a **settings-read that threw** — a thrown read must return `probe_failed`/`last-good`, never "not connected."

**Pre-code checks.**
- [ ] New alert uses `dedupeKey` for once-per-streak delivery?
- [ ] `blocked` and `error` have separate state flags?
- [ ] Slack notification path handles `channel_not_found` with an in-app fallback?
- [ ] Probe distinguishes missing creds from a settings-read error?

---

## 11. Scratch & Worktree Hygiene

**Failure class** — worktree junk accumulation. Every task environment is provisioned from a full repo copy and the publish image carries the workspace's on-disk files, so stray scratch (merge `.bak` dumps, `nohup.out`, `tmp_*` scripts, `*_block.txt`, one-off HTML/log dumps) taxes every future task and every deploy. Task #3790 removed ~66 such tracked files once; Task #3794 added the ongoing mechanism: `npm run gate` self-cleans, then `lint-worktree-hygiene` denies by default. The companion failure class is **lost multi-turn staging**: OS `/tmp` is an ephemeral mount — wiped whenever the task environment restarts (turn error, resume, hibernation) and quota-capped small (~1.5 GB observed, regardless of what `df` reports) — so work products staged there vanish mid-task and the session must rebuild them from scratch. The scratch-zone rule is about durability as much as gate hygiene: the sanctioned zones live in the workspace and survive restarts; `/tmp` does not.

**Required design rules.**

1. Transient files go ONLY in `.local/scratch/` (or `tmp/`) — never the repo root, never next to product code. Both zones are git-ignored and TTL-pruned automatically (72 h / 512 MB per zone, `scripts/clean-scratch.ts`).
2. `/tmp` is within-turn disposable space only. It does NOT survive an environment restart — turn errors, resume, and hibernation all wipe the mount — and its quota is small (~1.5 GB observed, regardless of what `df` reports). Anything that must survive a turn boundary (staged frames, generated assets, chunked exports, long-running probe output) goes in `.local/scratch/` / `tmp/` — workspace paths that persist — or directly into repo files in small increments. Do not confuse the persistent repo `tmp/` zone with the ephemeral OS `/tmp`.
3. The repo root is deny-by-default for new files AND directories: a new root entry requires a same-change registration in `ROOT_ALLOWLIST_FILES` / `ROOT_ALLOWLIST_DIRS` (`scripts/worktreePolicy.ts`). Root `.md` files instead take a RUNBOOKS.md index row (`verify-runbook-coverage` owns those).
4. Junk name patterns (`*.bak`, `*.orig`, `*.rej`, `*~`, `nohup.out`, `tmp_*`, `*_block.txt`, `.DS_Store`; root-only `*.log`/`*.html`) are lint offenders anywhere in the git-visible tree — including git-ignored-but-on-disk copies, which still bloat every repo copy.
5. Cleanup tooling must never touch platform-managed directories (`.local/state`, `.local/skills`, `.local/secondary_skills`, `.local/custom_skills`) or agent memory (`.agents/`); unknown `.local` entries are reported, never deleted. `scripts/clean-scratch.ts` is the reference implementation (path-safety asserts, symlinks never followed, tracked files never deleted).
6. `npm run gate` runs the stale-only self-clean first in every mode; `npm run clean:scratch` is the manual full wipe (`--dry-run` to preview).

**Pre-code checks.**
- [ ] About to create a file outside the product directories → does it belong in `.local/scratch/`?
- [ ] Staging multi-turn work products (rendered frames, generated assets, long build/probe output) → `.local/scratch/` or incremental repo writes, never `/tmp` — it is wiped on any environment restart and quota-capped (~1.5 GB).
- [ ] Adding a root-level entry → allow-list registration (or RUNBOOKS index row for `.md`) in the same change?
- [ ] Writing cleanup/GC code → does it skip platform dirs and report unknowns instead of deleting?

Full policy: [WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md).

---

## 12. Inherited Gate Failures & Merge Integrity

**Failure class** — upstream-inherited breakage misattributed to the task. Parallel tasks inherit main's current reds through mid-session system merges; historically each agent independently re-proved innocence (git-stash runs, HEAD-worktree reruns, `git log -1` archaeology) and N siblings shipped N duplicate fixes for the same red. Task #3922 mechanized the ritual: attribution is automatic, evidence is machine-readable, and merge smears are flagged minutes after the merge instead of at completion review.

**Required design rules.**

1. **Read the reports before hand-diagnosing a red gate.** Every failing run writes `.local/runs/attribution-report.json`: per-failure verdict (`inherited` vs `yours`) with citable evidence lines. The runner prints the same evidence as `[attribution]` lines in the run summary, and `npm run gate` prints a pointer after the gate summary. Do NOT re-derive stash/worktree innocence proofs — cite the report verbatim in drift/skip explanations and completion-review rebuttals.
2. **The excusal bar is deliberately strict.** A failure is excused (verdict `inherited`, non-blocking) only when ALL hold: the suite is listed in the committed `tests/red-manifest.json` (published by main's nightly sweep — the same single writer as the green baseline), the failure signature matches (exit codes exactly; hangs as a class), AND the suite's current input fingerprint equals the fingerprint main recorded when it measured the red — proving your diff is disjoint from the suite's traced input closure. Anything weaker — absent manifest, signature drift, fingerprint mismatch or untraceable, any classification error — stays `yours` (conservative fall-open). Excusal applies only to the smoke gate; full/regression/`--file` runs report attribution but never excuse. Kill switch: `TEST_ATTRIBUTION_EXCUSE=0`.
3. **Inherited reds get ONE fix, on main — never N task-side fixes.** If the report says `inherited`, do not ship a local fix for that suite: your copy will be superseded (or conflict) when main's fix lands. Note the excusal in your implementation notes and move on. If the red blocks your actual deliverable, say so in `drift_reason` and cite the report.
4. **After every mid-session system merge, check the merge-integrity output.** `scripts/post-merge.sh` runs `scripts/verify-merge-integrity.ts` (budget: `MERGE_INTEGRITY_BUDGET_MS`, default 180 s), which writes `.local/runs/merge-integrity.json` and prints a loud `!!! MERGE INTEGRITY WARNING` banner when the merge changed files vs the upstream tip that no task commit or worktree edit touched (smears), resurrected merge-base content that upstream had since changed, or introduced typecheck errors in files the task never touched. Run it by hand (`npx tsx scripts/verify-merge-integrity.ts`) any time a merge lands outside the hook.
5. **Detection is automatic; repair stays agent-driven.** For smeared files, restore upstream's version (`git show <upstream>:<file>`) or re-merge, then re-verify with `git diff <upstream> HEAD` — the repair playbook is the existing merge-corruption memory/runbook chain. Never mark integrity warnings resolved without re-running the checker.
6. **The red manifest can never seed greens.** It is schema-disjoint from `tests/green-baseline.json` by design (entries carry no verdict/records); failures still record FAILED in the local green store and flake history even when excused. Do not "fix" that asymmetry.

7. **Gate lint reds have the same rails (Task #4491) — read the report's `lints` section first.** When gate lints fail, `scripts/gate.ts` runs `scripts/gateLintAttribution.ts`: it re-runs just the failing lints against your task's upstream base tree in a disposable worktree (live A/B, budget `GATE_LINT_AB_BUDGET_MS`, default 300 s) and writes per-lint `inherited` vs `yours` verdicts with evidence into `.local/runs/attribution-report.json` under `lints`, plus per-lint remedy hints in the gate summary. Do NOT hand-run worktree A/B or `git log` archaeology for a lint red — read the `lints` section, hand-fix only verdict-`yours` lints, and cite the report verbatim. A fully-inherited lint red (identical offense signature at base AND your diff touching neither the offending files nor the lint script/harness) is excused smoke-gate-only and needs ONE fix on main — never a task-side copy. Everything weaker (A/B error, budget overrun, base-green, signature drift, diff intersection) falls open to `yours`. Freshness lints on committed generated artifacts (route inventory, contract table, website bundle) additionally **self-heal**: the gate runs the registered generator, re-verifies, and commits the artifact-only diff when it turns green — a `gate: auto-regenerate …` commit in your history is expected after completion rebases, not an anomaly; review it, don't revert it. Kill switches: `GATE_LINT_ATTRIBUTION_EXCUSE=0` (disable excusal; verdicts still print), `GATE_LINT_SELFHEAL=0` (disable self-heal). Main-side visibility comes from the nightly report-only lint phase (`NIGHTLY_LINT_PHASE_BUDGET_MS`, default 900 s) feeding the red manifest's `lints` section.

8. **Post-merge canary culprit stamps (Task #4501).** After each task merge, `scripts/post-merge-canary.ts` re-runs the diff's related-smoke slice on main (4-min budget) and partial-publishes any new reds to `tests/red-manifest.json` with the culprit commit/task stamped. If a test you never touched is in the manifest **with a culprit stamp pointing to an earlier merge**, the attribution report will cite "broken by merge X (Task #N)" as additional evidence — quote that line verbatim in drift/skip explanations. The canary result is in `.local/runs/post-merge-canary.json`. The nightly publisher stamps culprits too (Task #5030): a NEW nightly red resolves the merge window since the previous manifest's commit and stamps the culprit when that window holds exactly one merge; the sweep notification and auto-filed feedback items name the window.

9. **Wall-time ALERTs and rotation-day deferrals are not your failure (Task #5030).** An all-green run can never be verdicted FAIL on aggregate wall time: a wall breach prints `ALERT (non-blocking)`, lands in the breach ledger, and auto-files a re-baseline/triage item. Never chase a wall ALERT as a gate red, and never set `TEST_DURATION_BUDGET=0` in response (banned; it also disables the per-suite ceilings, which DO block). Likewise a `deferred K (… NOT verified this run)` disposition in the summary is the rotation-day deferral: suites with no blocking rail whose green evidence positively rotated or expired were queued to the post-merge/nightly lane — everything your diff touches still ran and blocked, and new/unverified, last-failed, and uncomputable suites always execute. Only per-suite ceiling violations and genuine suite failures fail a run.

**Pre-code checks.**
- [ ] Gate red on suites you never touched → read `.local/runs/attribution-report.json` FIRST; only hand-diagnose verdict-`yours` failures.
- [ ] System merge landed mid-session → read the post-merge console block or `.local/runs/merge-integrity.json` before continuing work.
- [ ] Writing a drift/skip explanation about an inherited red → quote the report's evidence lines, don't paraphrase from memory.
- [ ] A manifest entry has a culprit stamp → check `.local/runs/post-merge-canary.json` for the last canary run that introduced it.
- [ ] Gate lint red → read the report's `lints` section FIRST; hand-fix only verdict-`yours` lints; a `gate: auto-regenerate …` self-heal commit is expected, review not revert.
- [ ] Summary shows a wall `ALERT (non-blocking)` or a `deferred K` disposition → informational (Task #5030): fix nothing, re-run nothing; per-suite ceilings and genuine reds are the only duration/verdict blockers.

---

## 13. Epic Decomposition

**Failure class** — context-exhausting mega-task. Task #4904 (homepage premium sales-page restructure) carried a 17-section rebuild in ONE task: a 1,740-line template, 1,169 lines of CSS, four interactive modules, four docs, five test suites, plus regen and screenshot passes. Every run exhausted agent context ("context was compacted"), and every Continue resumed the same overloaded session — a crash loop that ended only when the work was re-cut into staged tasks #4923–#4926 with dependencies. Oversized single tasks don't fail loudly; they silently burn sessions.

**Required design rules.**

1. **Default to epics.** Any request showing an oversize signal (rule 3) is planned as multiple project tasks chained with `dependsOn` so each stage finishes, validates, and merges before the next starts. There is NO cap on task count — use as many stages as the work needs.
2. **Full scope, never downsizing.** Decomposition preserves 100% of the requested scope: the epic (first-stage plan or umbrella description) enumerates the complete scope so nothing silently drops, and each stage plan names its exact slice (e.g. "brief §5–§6"). Splitting is the sanctioned answer to "too big"; trimming scope is not.
3. **Oversize signals — any ONE triggers decomposition:** ~3+ distinct deliverable clusters (page sections, modules, docs, test suites, regen/screenshot passes); expected diff beyond ~800 changed lines or ~10 files; authoring/rewriting any single file over ~1,000 lines; "rebuild / restructure / overhaul / all N sections" phrasing; verification needing multiple independent passes.
4. **Stage shape.** One deliverable cluster per stage — sized so an agent finishes it in a single session without context compaction; a final stage covers integration + full verification.
5. **Mid-flight bail-out.** An agent that discovers oversize after starting (context compaction, giant files, repeated Continue/retry) stops early, lands a clean partial slice if safe, and splits the remainder into dependency-ordered follow-up tasks via `proposeFollowUpTasks` (one-shot per assigned task) instead of grinding retries; a superseded mega-task follows the superseded-task close-out convention (no-op complete recommending archival).
6. **Worked example.** Task #4904's single-task rebuild → the #4923–#4926 staged chain: four dependency-ordered stages each owning a contiguous slice of the same brief (e.g. stage 3 = brief §7–§9, stage 4 = brief §10–§14), full brief enumerated up front so no section dropped.

Full playbook (stage-cutting guidance, bail-out procedure): `.agents/skills/epic-decomposition/SKILL.md`.

**Pre-code checks.**
- [ ] Count the deliverable clusters in your plan — 3 or more → cut dependency-ordered stages BEFORE writing code.
- [ ] Estimate the diff — beyond ~800 lines / ~10 files, or any single file over ~1,000 lines → epic.
- [ ] Already mid-task and seeing compaction/retry symptoms → stop, land the clean slice, split the remainder into follow-ups (§ 13 rule 5).
