# Code Quality Non-Negotiables

Scope: code quality only — maintainability, simplicity, type safety, dependency discipline, module boundaries, duplication, dead/superseded code, testability, quality-check suppression, refactoring discipline, and required verification. Design, brand, website, and product governance live in their own canonical documents.
Hierarchy: this document supplements, and never overrides, `replit.md` (User Preferences + Doc Hygiene), `docs/DO_NOT_BREAK.md`, canonical runbooks, and subsystem contracts. On any conflict, those win.
Rules are repo-wide unless tagged **[OS]** (`client/`, `server/`), **[Web]** (`website/`), or **[RE]** (Revenue Engine cinematic section).

## Before changing code
- Inspect the existing framework, project structure, styling system, test setup, and build commands before changing code. npm is the canonical package manager and repository commands use `npm run …`; lockfile handling follows the repository's current package-manager policy.
- Search for an existing component, utility, hook, token, pattern, or dependency before creating another one. Extend existing implementations rather than creating competing production paths; sanctioned prototypes and explorations (`design-source/`, explicitly approved mockups) are not violations.
- For substantial changes, plan before editing: identify affected routes, integrations, tests, and docs, following the prior-task research rule and public-API documentation rule in `replit.md` § User Preferences.

## Stack boundaries (to prevent incorrect refactors)
- **[OS]** React 18 + TypeScript with its existing state, styling, and animation systems; Framer Motion is an intentional production dependency — do not remove or replace it without an explicitly approved migration.
- **[Web]** Generated static site; the homepage client is vanilla TypeScript + GSAP, not React. Do not introduce additional animation libraries into website bundles.
- **[RE]** Governed by `design-source/nobull-revenue-engine-cinematic-v1/IMPLEMENTATION_CONTRACT.md` and the `nobull-revenue-engine-cinematic` agent skill; keep its approved GSAP/ScrollTrigger architecture.
- Do not migrate frameworks, routers, styling/state/test systems, or animation stacks, and do not introduce parallel stacks, without an explicitly approved migration.

## Dependencies
- A new dependency is a last resort: state the problem it solves, why the existing stack is insufficient, its bundle impact, and its maintenance story. Do not add redundant libraries where the existing stack already solves the problem.

## Structure & abstractions
- Prefer focused modules with clear public interfaces. Keep business logic out of presentation code where the architecture supports that separation; avoid circular dependencies and inappropriate cross-feature coupling.
- Do not introduce speculative abstractions or pass-through layers. A first-use abstraction is acceptable when it creates a meaningful domain boundary, test seam, platform boundary, or isolation point for unavoidable complexity — the reason must be evident from the design or documented in the change.
- Consolidate components that share the same semantics and behavior. Keep separate components when domain meaning, accessibility behavior, lifecycle, or realistic change paths genuinely differ; never create a superficial duplicate to avoid understanding the existing component.
- Respect documented and mechanically enforced module boundaries; do not bypass known public interfaces through convenience imports. Enforced examples: DB pool tenancy, the OAuth refresh single-flight helper, comms shared message components (gate lints). Documented examples: non-comms surfaces use `useCommsSelector`, never `useCommsContext`; imports/syncs never directly mutate authoritative client entities (SEMrush mapping is the documented exception). When a boundary is unclear, flag the ambiguity — do not invent new architecture during an unrelated task.
- Keep feature work, behavioral refactors, and unrelated cleanup separately scoped.

## Dead & superseded code
- Cleanup within an approved change: when the implementation directly replaces an existing component, path, dependency, or code path, remove the superseded implementation in the same change — after completing the repository's required reference checks (corpus scan + dev/prod database-reference checks).
- Unrelated cleanup: identify and report suspected dead code, unused assets, abandoned experiments, and unnecessary dependencies; their removal is a separately scoped cleanup task under the deletion protocol, never an opportunistic side effect of a feature task.

## Quality-check suppression
- Prohibited (ad hoc): unexplained `@ts-ignore` or inline lint disables; weakening a check merely to pass; silently skipping or deleting tests; reclassifying a failure without evidence.
- Permitted only through operator-owned maintenance (documented mechanisms, with written justification): count-ratchet baselines (e.g. `scripts/lint-async-correctness.baseline.txt`); justified React-Hooks baseline entries (`scripts/lint-react-hooks.exhaustive-deps.baseline.txt`); the quarantine ledger for flaky suites; the established pre-existing-failure process (attribute against HEAD; minimal unblocking fix + drift note where policy requires it).

## Verification
- During implementation, perform review-by-inspection of the diff and touched files. Routine agents run no test, lint, typecheck, gate, or focused substitute. Tests and testing infrastructure are read-only to task agents: inspect existing coverage for context, but do not create, edit, execute, regenerate, skip, quarantine, or otherwise maintain test surfaces. Report any needed test maintenance for operator-owned work outside the task.
- Routine task completion is validated by Replit's own built-in completion review, not a required run of the custom gate (owner decision, 2026-08-26; see [TESTING.md § Bounded task-validation policy](./TESTING.md#bounded-task-validation-policy-owner-approved)). Explicitly requested gates use the managed `.replit` **Long validation** workflow's reviewed `routine-gate` profile; direct `npm run gate` and `npm run gate --full-smoke` remain troubleshooting-only operator tools. Complete the non-executing inspection obligations in `TASK_PREFLIGHT.md` and `TASK_SELFCHECK.md`.
- For an unrelated, inherited, environmental, or platform-owned completion-review rejection, preserve the task diff, use provenance/attribution evidence when relevant, do not request a fresh review, and do not launch compensating checks or unrelated repairs. A task-owned finding remains blocking and must be fixed.
- Do not create `quality:*` aliases or new scripts to satisfy this document's wording; any alias proposal is a separately approved task.
- When behavior intentionally changes, inspect existing tests for relevant coverage but leave test maintenance outside the task-agent change. Report any missing or stale coverage explicitly. Report every failed or skipped check accurately — never silently skip verification.
- Preserve mandatory same-PR Doc Hygiene updates (`replit.md` § Doc Hygiene). Keep transient artifacts only in `.local/scratch/` or `tmp/` (`WORKTREE_HYGIENE.md`). Follow the UTC-timestamp migration naming rule.
