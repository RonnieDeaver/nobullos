# Worktree Hygiene & Scratch Policy

**Task #3794** (mechanism) — successor to Task #3790's one-time cleanup of ~66 tracked root junk files. Every task environment is provisioned from a full copy of the repo, and the publish image carries the workspace's on-disk files, so stray scratch anywhere in the worktree taxes every future task and every deploy. This runbook is the canonical policy: where transient files belong, what gets cleaned automatically, and what is enforced.

The design mirrors how Google (Bazel) and Meta (EdenFS/Buck) solved this at monorepo scale: **one out-of-tree scratch home**, a **deny-by-default presubmit gate** on stray files, and **TTL garbage collection of the scratch home itself** so the sanctioned dump never becomes the new problem.

## Zone map

| Path | Class | Auto-pruned? | Notes |
| --- | --- | --- | --- |
| `.local/scratch/` | **Scratch zone** | Yes — TTL + size cap | The default home for any transient file: repro scripts, probe output, one-off dumps. |
| `tmp/` | **Scratch zone** | Yes — TTL + size cap | Same policy; historical location, kept for convenience. |
| `/tmp` (OS mount) | **Ephemeral — never stage here** | Wiped on every environment restart | Outside the workspace. Turn errors, resume, and hibernation all wipe it; quota ~1.5 GB observed (regardless of what `df` reports). Within-turn disposable bytes only. |
| `.local/runs/` | Agent tooling | Never by generic scratch GC | Per-invocation gate/test reports and selection manifests. The isolated `long-validation/` child is managed only by its own 14-day / 20-run / 256-MB lifecycle; all sibling gate evidence remains untouched. No fixed shared log or done-file is an outcome contract. |
| `.local/tasks/` | Agent tooling | Never automatically | Task plan documents, written by the platform. |
| `.local/hermetic-pg/` | Agent tooling | Never automatically | Hermetic test-DB template cache (`tests/hermetic/provision.ts`). Safe to delete manually; rebuilt on the next test run. |
| `.local/exports/` | Agent tooling | Never automatically | Deliberately exported deliverables (audit reports, zips) presented to the user. |
| `.local/state/`, `.local/skills/`, `.local/secondary_skills/`, `.local/custom_skills/` | **Platform-managed** | **NEVER** | Off-limits. The GC never enters, never deletes, and reports them as untouched. |
| `.agents/` | **Agent memory** | **NEVER** | Off-limits (persistent memory + user skills). Not a scratch location. |
| Anything else under `.local/` | Unknown | **Never** | Reported by `clean:scratch` as unclassified, left intact. Classify it in `scripts/worktreePolicy.ts` if it should become scratch. |

Both scratch zones are git-ignored **by the repo's own `.gitignore`** (`.local/`, `tmp/`) — the hygiene lint fails if those lines go missing, so the policy does not depend on the environment-level `/etc/.gitignore` that never travels with the repo.

## Junk patterns (deny-by-default)

Defined once in `scripts/worktreePolicy.ts` (`JUNK_ANYWHERE` / `JUNK_ROOT_ONLY`):

- Anywhere in the tree: `*.bak`, `*.orig`, `*.rej`, `*~`, `nohup.out`, `tmp_*` / `tmp-*`, `*_block.txt`, `.DS_Store`.
- Repo root only: `*.log`, `*.html` (app HTML lives in `client/` / `website/`; 28 legitimate tracked `.html` files exist deeper in the tree).

The repo **root is allow-listed for both files and directories**: any new non-dot, non-`.md` root entry must be registered in `ROOT_ALLOWLIST_FILES` / `ROOT_ALLOWLIST_DIRS` in `scripts/worktreePolicy.ts` **in the same change** — a deliberate one-line registration, mirroring the RUNBOOKS-index obligation for new root `.md` files (which stay owned by `scripts/verify-runbook-coverage.ts`). Tracked junk that genuinely cannot move yet can be grandfathered in `scripts/lint-worktree-hygiene.baseline.txt` (currently empty — keep it that way).

## Enforcement (three layers)

1. **`npm run gate`** (every task's final validation, all modes) runs **`clean-scratch --stale-only` first** — deleting untracked junk-pattern files and TTL/size-pruning the scratch zones — then runs **`lint-worktree-hygiene`** against the cleaned tree. Every task therefore self-cleans at validation time.
2. **`scripts/predeploy.sh`** runs the same self-clean + lint before any deploy, so the publish image stops accumulating scratch weight. Same block-banner + emergency-override convention as the other predeploy gates.
3. **Smoke tests**: `tests/lint-worktree-hygiene.test.ts` (always-run core via the `tests/lint-*` naming rule) and `tests/clean-scratch.test.ts` guard the lint and the GC — including fixture proof that platform-managed directories survive every mode. The `.replit` `Validate` workflow runs `npm run gate`, including this lint through `scripts/gate.ts` `LINT_CHECKS`; these SMOKE_FILES entries are part of the enforcement.

## Manual cleanup

```bash
npm run clean:scratch              # full wipe of scratch-zone contents + untracked junk sweep
npm run clean:scratch --dry-run    # report what would be removed, delete nothing
npx tsx scripts/clean-scratch.ts --stale-only   # what the gate/predeploy run (TTL + size cap)
```

The GC's hard safety rules, in priority order:

- **Tracked files are never deleted** (the lint flags them for a deliberate `git rm`); if git is unavailable, the junk sweep is skipped entirely rather than guessing.
- Platform-managed `.local` directories and `.agents/` are never entered or deleted; unknown `.local` entries are **reported, never deleted**. The only non-scratch exception is the long-control owner's direct-child cleanup below `.local/runs/long-validation/`; it rejects locks, symlinks, malformed names, and anything outside that namespace.
- Symlinks are never followed; every deletion target must resolve inside the repo root (and, for zone pruning, inside a declared zone).
- Zone pruning applies only to the two declared scratch zones, at depth 1, by recursive newest-mtime.

## Knobs & overrides

| Name | Type | Default | Effect |
| --- | --- | --- | --- |
| `CLEAN_SCRATCH_TTL_HOURS` | int | `72` | Stale-only mode: zone entries whose newest recursive mtime is older are pruned. |
| `CLEAN_SCRATCH_MAX_MB` | int | `512` | Stale-only mode: per-zone size cap after the TTL pass, pruned oldest-first. |
| `CLEAN_SCRATCH_SKIP` | flag | unset | `1` = skip the self-clean entirely (emergency; CLI entry only). |
| `LINT_WORKTREE_HYGIENE_SKIP` | flag | unset | `1` = skip the hygiene lint (emergency, audited; the worktree is NOT validated). |

`PREDEPLOY_SKIP_TESTS=1` skips both blocks in the predeploy path, per the existing convention.

## For task agents: the three habits

1. **Write transient files to `.local/scratch/` (or `tmp/`) from the start** — never to the repo root or next to product code. TASK_PREFLIGHT.md § 11 says the same thing before you begin.
2. **Never stage multi-turn work in OS `/tmp`.** `/tmp` is an ephemeral mount: it does not survive an environment restart (turn error, resume, and hibernation all wipe it) and its quota is small (~1.5 GB observed, regardless of what `df` reports). Anything that must survive a turn boundary goes in `.local/scratch/` / repo `tmp/` — workspace paths that persist across restarts — or directly into repo files in small increments.
3. **A new root-level entry or a junk-pattern exception is a deliberate act**: register it (`worktreePolicy.ts`, baseline file) in the same change, with the reason in the diff — exactly like a RUNBOOKS index row.
