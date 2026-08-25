# Async Correctness Lint

The most expensive recurring bug class in this app's history is async misuse:
fire-and-forget promises that race tests and restarts, missing awaits, and
double-driven refreshes (the incidents behind the drain helpers, single-flight
wrappers, and audit-after-finished repairs). Task #3817 added the standard
typescript-eslint async-correctness rule set as a generic static-analysis
baseline underneath the bespoke invariant lints, gated on **new violations
only**.

## What runs, where

`scripts/lint-async-correctness.ts` runs four **type-aware** rules over
`server/`, `client/src/`, `shared/`, and `scripts/` (tests are excluded — they
have their own harness conventions, e.g. deliberately dropped promises in race
fixtures). The TS program comes from `tsconfig.eslint.json`.

| Rule | Catches |
| --- | --- |
| `no-floating-promises` | A Promise created and dropped — the fire-and-forget catcher. |
| `no-misused-promises` | A Promise used as a boolean/void value (`if (asyncFn())` is always truthy). |
| `await-thenable` | `await` on a non-promise (usually a forgotten `()` — dead await). |
| `require-await` | `async` function containing no `await` — the `async` is noise or an await was forgotten. |

Tuning (see the script header for full rationale): `no-misused-promises` runs
with `checksVoidReturn: { arguments: false, attributes: false }` (async
express handlers and JSX event props are idiomatic); `no-floating-promises`
runs with `ignoreVoid: true` and `ignoreIIFE: false`.

## The annotation convention: `void`

An **intentional** fire-and-forget call must be visibly annotated at the call
site with the `void` operator, plus a short reason comment:

```ts
void kickBackgroundRefresh(); // fire-and-forget: badge freshness only, errors logged inside
```

Rules of use:

- Only `void` a promise whose rejection is **handled** — either the callee
  catches internally, or you append `.catch`:
  `refreshCache().catch((err) => console.error("[X] refresh failed:", err));`
  (a `.catch` with a handler also satisfies the rule on its own).
- Never use `// eslint-disable` comments for these four rules — the lint hard-fails
  them. `void` is the single sanctioned annotation, so intent is greppable at
  every call site instead of hiding in directives.
- If a caller *should* wait for the result, **await it** — do not annotate a
  real bug into silence.

## New-hit gating + the count baseline

Pre-existing violations are frozen in
`scripts/lint-async-correctness.baseline.txt` as `<file> <rule> <count>` rows
(counts, not `file:line` — a ~170-row baseline keyed by line would spray false
"new" hits on every unrelated edit). The gate fails when:

- a (file, rule) count **exceeds** its allowance → new violation: fix it or
  `void`-annotate it;
- a count **drops below** its allowance → stale: run the ratchet so fixed debt
  cannot silently refill:

```bash
npx tsx scripts/lint-async-correctness.ts --update-baseline
```

Never hand-raise a count. Burning down the baseline in tranches is welcome —
regenerate after each tranche.

## Where it is enforced

- `npm run gate` — the `lint-async-correctness` entry in `scripts/gate.ts`
  (~2–2.5 min: type-aware linting builds a full TS program; this is the tuned
  fast configuration — the untuned rule set ran >5 min).
- Full-set test runs (the `Validate` workflow, predeploy `npm test`) — via
  `tests/async-correctness-lint.test.ts`, which asserts the real tree against
  the baseline and fixture-proves each rule. It is deliberately **not** named
  `tests/lint-*.test.ts`: the always-core naming would double-scan every
  related-smoke gate run on top of the LINT_CHECKS entry.
- The `.replit` `Validate` workflow runs `npm run gate`, where the check is
  registered in `scripts/gate.ts` `LINT_CHECKS`.

## Local usage

```bash
npx tsx scripts/lint-async-correctness.ts                  # full scan (~2-2.5 min)
npx tsx scripts/lint-async-correctness.ts --scope=server   # one scope (~60-80s)
npx tsx scripts/lint-async-correctness.ts --scope=server --update-baseline
```

Scopes: `server`, `client`, `shared`, `scripts`. A scoped `--update-baseline`
rewrites only that scope's rows and preserves the rest.
