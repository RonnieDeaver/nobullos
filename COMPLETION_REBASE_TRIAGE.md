# Main moved during completion validation — scripted conflict triage

Canonical protocol for the "main moved, new conflict round" loop during a
task's completion/validation window (Task #4553). Each round is minutes of
scripted work, not manual conflict archaeology: one command classifies every
conflicted path, auto-resolves the mechanical classes by **regenerating on
the rebased tree**, and prints only the real conflicts needing judgment.

Tooling: `scripts/rebase-conflict-triage.ts` (executor) +
`scripts/rebaseConflictTriageLib.ts` (pure classifier/planner).
Round reports: `.local/runs/rebase-triage/*.json` (audited, machine-readable —
cite them in completion rebuttals/drift_reason instead of re-litigating the
round).

## The protocol (per round)

### 1. Quiesce

Before touching the conflicted tree:

- Kill orphan suite runners from superseded validation attempts
  (`pkill -f "tsx tests/run-all.ts"`) and remove `.local/runs/test-run-active`
  if stale — concurrent suites can contend for shared runner resources and
  double DB contention. Inspect the invocation-specific evidence directory;
  no fixed shared log or done-file is an outcome contract.
- Do **not** edit `.agents/memory/*` files concurrently with a completion
  attempt — the memory-index union lands when the attempt starts.

### 2. Triage — one command

```
npx tsx scripts/rebase-conflict-triage.ts            # add --dry-run to preview
```

Classifies every unmerged path and auto-resolves the mechanical classes:

| Class | Paths | Mechanical resolution |
| --- | --- | --- |
| generated-artifact | route inventory (`tests/route-inventory.json` + report), endpoint contract table (`audits/D-endpoint-contract-table.*` — generated FROM the inventory, always regens after it), design-contract baseline (`scripts/design-contract-baseline.json`, sole-writer regen), governance inventories (`audits/governance/*.json`), website bundle (`website/public/**`) | Take a side, run the existing sanctioned generator on the rebased tree in dependency order, stage. Never hand-merge. |
| memory-index | `.agents/memory/MEMORY.md` | 3-stage `git merge-file --union` (mirrors the `.gitattributes` `merge=union` driver), stage. |
| lockfile | `package-lock.json` | Take a side, `npm install` (reinstall, never merge), stage. |
| source | everything else | **Never touched.** Falls open to manual handling, listed in the report. |

Rules the helper enforces:

- **Unknown conflicts are never silently auto-resolved** — anything outside
  the classes above (including one-side-deleted artifacts) is listed as a
  residual real conflict and left unmerged in the index.
- **Deferral:** while residual source conflicts remain, all take-side/regen/
  lockfile work is deferred (generators must not parse a marker-laden tree).
  Resolve the residual conflicts, then **re-run the same command** to execute
  the mechanical plan.
- L3 test-control-plane surfaces (gate/runner/selection/fingerprint/
  `tests/green-baseline.json`/`tests/red-manifest.json` — the #4530/#4531
  track) are deliberately NOT mechanical classes: they always land in the
  residual list.
- Side choice defaults to the upstream side (`--ours` mid-rebase, `--theirs`
  mid-merge; override with `--side`). For regenerated artifacts the choice is
  cosmetic — regen overwrites — but the design baseline's ratchet then
  compares against main's latest bar. A design-baseline regen **refusal**
  means the rebased tree has new violations: fix them with tokens, never
  widen the baseline by hand.

Exit codes: `0` everything auto-resolved · `2` residual manual conflicts
remain · `1` an action failed (see the round report).

### 3. Resolve the residual real conflicts

The short list the helper printed is the entire manual surface. Inspect those
all three ways (`git diff`, stages `:1:`/`:2:`/`:3:`), resolve, `git add`.
Then re-run the triage command if regens were deferred.

### 4. Continue, then integrity pass

After the rebase/merge continues and the round lands:

```
npx tsx scripts/rebase-conflict-triage.ts --verify
```

Runs the existing `scripts/verify-merge-integrity.ts` — which includes the
`npm run check` typecheck (no second typecheck; same rule as post-merge.sh) —
and folds smear/resurrected-ancestor/typecheck outcomes into the round
report. Silent clean-merge corruption is a known failure mode; never skip
this step. On smears: repair from the upstream tip (`git show <upstream>:<file>`)
per the merge-corruption playbook, then re-run `--verify`.

Rebase-shaped rounds (HEAD not a merge commit) get typecheck coverage only;
smear analysis is N/A — diff against the upstream tip if anything looks off.

Also check whether the rebase imported NEW upstream gates (new
`scripts/lint-*.ts`, new smoke registrations): your untouched code is now
judged by them — run new gates locally before revalidating.

### 5. Revalidate ONCE

Re-run validation a single time via the `Validate` workflow (`npm run gate`)
and judge its final verdict. Incremental green-skip stays **unchanged**:
unaffected suites skip on their fingerprints; never force a full manual
re-derivation per round, and never re-verify suites with bare `tsx` against
the dev DB.

## What this protocol never does

- Hand-merge any generated artifact (regen on the rebased tree is the only
  sanctioned resolution).
- Auto-resolve an unclassifiable conflict.
- Touch gate/runner/selection/fingerprint/green-baseline/red-manifest
  semantics (L3 — #4530/#4531).
- Run more than one revalidation per round.
