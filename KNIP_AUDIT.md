# KNIP_AUDIT.md — Periodic Knip Audit (warning-only)

The repository's dead-code / dependency-hygiene audit. **Informational by
design: findings never block a merge, and this command is not — and must not
become — part of the merge gate** (`scripts/gate.ts`). Formalized by program
task F12 (Task #4162); validation evidence:
`audits/f12-knip-validation-2026-08-10.md`.

## How to run

```
npm run audit:knip
```

Two passes (`scripts/audit-knip.ts`, ~25 s total):

1. **Main report** — `npx --yes knip@6.32.0 --config knip.jsonc --no-exit-code`
   (files, dependencies, unlisted dependencies/binaries, unresolved imports,
   exports/types, duplicates).
2. **Cycles report** — same invocation plus `--include cycles`. knip 6.32.0
   has **no `--cycles` flag alias**; an output with no cycle section means
   0 cycles.

Exit-code policy: findings always exit 0; only an inability to execute knip
(spawn failure/crash) exits 1, loudly. Never run knip with `--fix` or
`--allow-remove-files`; nothing in this process writes, deletes, or rewrites
baselines.

**Version pin:** exactly `knip@6.32.0` via deterministic `npx` — deliberately
not a devDependency (accepted process #3894; zero lockfile footprint).
Changing the pin is a deliberate task that requires a fresh validation report
under `audits/`, never a routine edit.

## Cadence

Manual and periodic — run it:

- after a structural epic / refactor program settles (the 2026-08 program ran
  it at F0 baseline and F12 close),
- before major dependency work (upgrades, removals),
- on demand when investigating suspected dead code.

There is **no scheduled or validation run** for it: the two `.replit`
workflows are `Start application` and `Validate`, and gating/scheduling this
audit is explicitly out of policy.

## Expected steady state (validated 2026-08-10)

| Section | Expected | Meaning of drift |
| --- | --- | --- |
| Unused files | **0** | Any new entry is high-signal: trace before touching (see deletion protocol). |
| Unused dependencies | **0** | New entry = candidate phantom/orphaned dep — verify against hoisting first. |
| Unused devDependencies | **0** | Same as above. |
| Unlisted dependencies | **1** — `express-serve-static-core` | Documented classification (below). A *second* entry is high-signal. |
| Unlisted binaries | **6** — `ffmpeg`×4, `ffprobe`, `psql` | All environment-provided by `.replit` (`packages = ["ffmpeg", …]`, `postgresql-16` module), not npm. A *new* binary name is high-signal. |
| Unresolved imports | **0** | Any entry = broken specifier; fix immediately. |
| Unused exports / types | ~719 / ~405 | Informational only (below); track direction, not exact counts. |
| Duplicate exports | **7** | Benign patterns: component named+default pairs, `__test_` seams, shim re-export. |
| Configuration hints | **11** (main) / **6** (cycles) | Expected — see below. Do not "fix" hints by deleting explicit entries. |
| Cycles | **0** | Any cycle is high-signal; the server import-cycle gate enforces the server half continuously. |

### Configuration hints are expected

knip suggests removing entries its implicit defaults/plugins already detect
(`server/index.ts`, `client/src/main.tsx`, `tests/run-all.ts`,
`script/build.ts`, `drizzle.config.ts`, `vite.config.ts`) and ignores that
project globs already exclude (`artifacts/**`, `.agents/**`,
`design-source/**`, `attached_assets/**`, `.local/**`). Both stay: the F12
spec requires the config to *explicitly model* every application surface, and
the ignore list mirrors the sanctioned non-application classes verbatim.
Trading that self-documentation for implicit version-dependent defaults is
the wrong direction.

## Dynamic surfaces the config models

These load mechanisms are invisible to static import tracing; `knip.jsonc`
models each as an `entry` (never as an ignore):

| Surface | Load mechanism |
| --- | --- |
| `website/src/{home,site,calc}-client/main.ts` | esbuild `buildSync` with string-joined `entryPoints` in `website/generate.ts` |
| `scripts/**/*.mjs`, `scripts/**/*.js` | `Worker`-/spawn-loaded operational scripts (`gate-lint-worker.mjs`, `regen-route-inventory.mjs`, caseintake generators, verification smokes) |
| `scripts/**/*.d.mts` | tsc's automatic `.mjs`/`.d.mts` declaration pairing (typecheck-time, no import statement) |
| `tests/**/*.mjs` | node resolve-hook loaders/stubs and `--import` setup files |
| `tests/hermetic/bootstrap-db.ts` | `node --import` |
| `tests/_probe.ts`, `tests/self-test.ts` | spawned by the test runner |
| `tests/helpers/gate-lint-fixtures/**` | spawned as CLIs by lint self-tests |
| `tests/browser/**` | vite-served browser harnesses |
| `tests/**/*.test.ts(x)` | registration-block discovery by `tests/run-all.ts` (no central import list) |

One deliberate **ignore** exception: `tests/fixtures/import-cycles/**` is a
deliberately-cyclic fixture corpus for the cycle-tracer test — scanning it
would inject false positives into the cycles report.

## Documented classifications

### `gsap` (the historical example)

`gsap` is consumed **only** by the website client bundles, which are bundled
at generate time (see table above). Under a generator-only model it reports
as an unused dependency — audit §4 and the F0 baseline recorded exactly that.
The committed config resolves it by modeling the real bundle entries, **not**
via `ignoreDependencies`. If `gsap` ever reappears in the report, first check
that the `website/src/*-client/main.ts` entries still match the `BUNDLES`
list in `website/generate.ts`.

### `express-serve-static-core` (unlisted dependency, expected)

`server/routes/requestContext.ts` imports `ParamsDictionary` **type-only**
from `express-serve-static-core`. The types are satisfied transitively via
`@types/express` → `@types/express-serve-static-core`; there is no runtime
package and nothing to install. Adding `@types/express-serve-static-core` as
a direct devDependency would be a new dependency for zero runtime benefit
(out of F12 scope), and hiding it via `ignoreDependencies` would also hide a
future *real* unlisted dependency. It becomes actionable only if
`@types/express` is ever removed or replaced.

## Why unused exports stay informational

Accepted decision (process #3894, reaffirmed by the residual audit and F12):
the ~719 exports / ~405 types are dominated by deliberate seams —
`__test_*` injection seams, barrel re-exports, `shared/` contract types
consumed only in type position, component named+default pairs. Gating on
them would force churn with no behavior value. Validation reports record the
counts so *direction* is visible; the numbers are never enforced.

## Deletion protocol

Knip output alone **never** authorizes a deletion (accepted #3894). For any
candidate:

1. **Trace the load mechanism** — grep for string-joined paths, `Worker`/
   spawn sites, resolve hooks, `.replit` workflow commands, `package.json`
   scripts, and docs references before concluding "unused".
2. **Check prior dispositions** — the F3 operational-script disposition and
   related `audits/` reports may have already classified the file.
3. **For operational scripts, collect production evidence** — invocation
   stamps / data residue via the prod replica, per the established one-off
   script disposition practice.
4. **Delete in a dedicated, reviewed task** — with guard/baseline updates in
   the same change; never as a side effect of an audit run.
5. **Never `--fix` / `--allow-remove-files`.**

## Config maintenance

- New website bundle → add its `main.ts` under the website entries.
- New dynamically-loaded script class → add the *narrow* glob plus a comment
  naming the load mechanism.
- New non-application root surface → extend `ignore` **only** if it matches
  the sanctioned classes (sandbox projects, agent skills/memory, generated
  website output, design sources, attached assets, scratch). Broad ignores
  to reach zero findings are out of policy.
- `knip.jsonc` is a root file registered in `ROOT_ALLOWLIST_FILES`
  (`scripts/worktreePolicy.ts`); keep registration and file in lockstep.

## Provenance

- **#3894** — accepted scratch-config process; established warning-only +
  informational-exports policy and the deletion rule.
- **Audit §4** (`audits/code-quality-residual-audit-2026-08-09.md`) — curated
  post-validation results (0 unused files after manual classification).
- **F0 baseline** (`audits/program-baseline-2026-08/package-module-manifest.json`)
  — raw machine-comparable results (40 statically-invisible files, all
  classified; `gsap`; 0 unresolved; 0 cycles).
- **F12** (`audits/f12-knip-validation-2026-08-10.md`) — post-refactor
  validation, committed-config decision rationale, repeatability proof.
