# Architecture Boundaries — Post-Split Module Ownership & Dependency Direction

Locked in by the 2026-08 architecture program (Task #4161/F13; pre-registered
by the residual audit §12). Canonical map of the program's split surfaces:
each composition root, its domain modules, storage/data boundary, public
interface, guarding test suites, and the mechanical guard — plus the
dependency-direction rules that keep the splits from regressing into
monoliths. Supplements [CODE_QUALITY.md](./CODE_QUALITY.md) § Structure &
abstractions; never overrides `replit.md`, `docs/DO_NOT_BREAK.md`, or
subsystem runbooks.

**Enforcement.** `scripts/lint-monolith-aggregator-size.ts` (gate-registered,
gate lint) caps every composition root below with headroom above its
post-split size; `tests/lint-monolith-aggregator-size.test.ts` (smoke) proves
the lint fires and stays wired into the gate. `lint-server-import-cycles`
keeps the server import graph statically cycle-free (dynamic `import()` is
the sanctioned break). Raise a budget only when the root's own
composition/wiring legitimately grew (e.g. a new module's mount/re-export
lines) — never to make room for feature code; budget changes are
Architecture-Governor-reviewed (L3, owner-approved).

## Global rules (all split surfaces)

- Composition roots are wiring-only: imports, mount/re-export lines,
  root-owned gating/ordering. New feature code goes into a domain module (or
  a new module), registered in the root with one line.
- Dependency direction always points root → domain modules → shared leaves.
  Domain modules never import their composition root and never reach into a
  sibling's internals — cross-domain needs go through the shared helper leaf,
  a service, or an explicit public export.
- Public interfaces freeze at the root: consumers import the root specifier,
  not `<module-dir>/<file>` internals.

## Dependency direction per surface

### Integration routes (F6) — `server/routes/integrations.ts`

`server/routes.ts` → `registerIntegrationRoutes(app)` → domain modules under
`server/routes/integrations/` → `helpers.ts` (shared pure leaf) +
services/storage. Registration calls run in the order each domain first
appeared in the pre-split monolith; cross-module path families are disjoint
literal prefixes, so this order preserves Express matching — do not reorder
mounts, and do not register integration routes anywhere else. Route modules
own no tables; DB access goes through storage modules and services. Any
route add/move/removal regenerates the route inventory (freshness-linted).

### Production actions (F7) — `server/services/prodActionsRegistry.ts`

Consumers (routes, services, schedulers, tests) import ONLY the barrel
specifier `server/services/prodActionsRegistry`; it re-exports every
pre-split symbol. Inside `server/services/prodActions/`, direction is
`kernel.ts` (types/states leaf) ← `helpers.ts` ← action domain modules ←
`composition.ts` (ordered `PROD_ACTIONS` + duplicate/unowned-entry guard) ←
`engine.ts` (status/apply loops). Registration order = operator panel +
apply-all execution order: a new action lands in its domain module plus the
composition array — the module-load guard (`assertProdActionConvergenceInvariants()`,
invoked at the bottom of the barrel) fails every importing process at boot on
drift, and `tests/prod-actions-convergence-taxonomy.test.ts` asserts that
invocation line exists. Every action's `status()`/`apply()` runs on the
worker pool (`runWithWorkerDb` + `withDbAttribution`), never `api`.

### ATS JSONB boundary (F4) — `server/services/atsJsonb.ts`

Every read of an ATS jsonb column — ATS routes (`server/routes/ats.ts`),
unified scoring, cohort calibration, corruption alerts — goes through a named
decoder in `atsJsonb.ts`: reference-preserving container guards, explicit
null/missing semantics, logged malformed-row fallbacks. No bare `as`-casts of
jsonb values at these boundaries; a new jsonb read adds a named accessor plus
a row in the decoder-matrix suite.

### Reports JSONB boundary (F5) — `server/lib/reportJsonbAccessors.ts`

Reports routes, import warnings, and trend entries read report jsonb shapes
through `reportJsonbAccessors` (same-reference decoders, current + legacy
shapes, explicit malformed policy) — never ad-hoc casts. Trend-entry helpers
live beside it in `server/lib/reportTrendEntries.ts`. Write paths stay behind
focused zod parsing per the persistence-write boundary rule (inventory:
`audits/f8-spread-write-inventory-2026-08-09.md`).

### Frontend containers & sections (F11A–D)

Page/panel composition roots own: route/page identity + admin gating,
root-level queries and the hook mount order (a contract — domain hooks are
called unconditionally at the root in their original sequence), section
ordering, and top-level early returns. Domain modules own their section's JSX
plus a `use<X>Domain(...)` hook (`export type XDomain = ReturnType<typeof
useXDomain>`), and receive domain objects via props. Sections never import
their root; shared per-surface helpers/types live inside the module dir
(`shared.tsx` / `types.ts`). A new card or section = a new module + one mount
line in the root.

## Ownership map

| Surface | Composition root / boundary module | Domain modules | Storage/data boundary | Public interface | Test suites | Mechanical guard |
| --- | --- | --- | --- | --- | --- | --- |
| Integration routes (F6) | `server/routes/integrations.ts` | `server/routes/integrations/*` (one module per domain + `helpers.ts` leaf) | storage/services only — route modules own no SQL/tables | `registerIntegrationRoutes(app)` | per-domain families (`tests/front-*`, `tests/zoom-*`, `tests/semrush-*`, hub/status suites) + the source-scan suites pointing at the domain dir | budgets lint; `lint-route-inventory-freshness`; `lint-server-import-cycles` |
| Prod actions (F7) | `server/services/prodActionsRegistry.ts` | `server/services/prodActions/*` (kernel, helpers, action domains, composition, engine) | worker pool via `runWithWorkerDb` + `withDbAttribution` | the barrel's re-exports (`PROD_ACTIONS`, engine status/apply, action fns + types) | `tests/prod-actions-domain-composition.test.ts`, `tests/prod-actions-convergence-taxonomy.test.ts`, the `tests/prod-action*` + apply-all families | budgets lint; module-load composition guard; `lint-prod-actions-no-re-press` (scan set includes the domain dir) |
| Front historical recovery panel (F11A) | `client/src/components/admin/FrontHistoricalRecoveryPanel.tsx` | `client/src/components/admin/front/recovery/*` (section components, `useRecoveryJobs`, `shared.tsx`, `types.ts`) | React Query over Front recovery/coverage admin APIs | named export `FrontHistoricalRecoveryPanel` (consumer: `pages/admin/FrontIntegration.tsx`) | mount-kit families `tests/client/front-coverage-*`, `front-rearm-*`, `front-autoheal-banner`, `front-trigger-blocked-reasons-toast`, `outbound-gap-close-*`, `recovery-revert-buttons` | budgets lint |
| Match settings page (F11B) | `client/src/pages/admin/MatchSettings.tsx` | `client/src/pages/adminMatchSettings/*` | React Query over match-settings/guardrail admin APIs | default export (route `/admin/match-settings`) + 4 named re-exports (guardrail trend keys/set, `RoutedToReviewSparkline`, `DismissReasonDelta`) | `tests/client/match-settings-*`, `tests/client/comparative-trend-window-picker*`, `tests/zoom-guardrail-change-trends*`, `tests/match-settings-alert-giveup-notification*` | budgets lint |
| Rate-limit users page (F11C) | `client/src/pages/admin/RateLimitUsers.tsx` | `client/src/pages/adminRateLimit/*` | React Query over rate-limit admin + notification/retention APIs | default export + named re-export `BlockedEventHistory` | `tests/client/rate-limit-deeplink*`, `tests/pending-digest-retention-endpoints*`, `tests/os-mobile-layout-sweep*` | budgets lint |
| Health dashboard section (F11D) | `client/src/components/admin/health/HealthDashboardSection.tsx` | `client/src/components/admin/health/dashboard/*` | React Query over `/api/health*` (three root-owned queries) + per-card domain hooks | named export `HealthDashboardSection` (consumer: `pages/admin/SystemHealthConsole.tsx`) | `tests/client/integration-status-unknown-neutral*`, `tests/os-mobile-layout-sweep*`, hook-order gate in `tests/lint-react-hooks.test.ts` | budgets lint |
| ATS jsonb reads (F4) | `server/services/atsJsonb.ts` | consumers: `server/routes/ats.ts`, `atsUnifiedScoring.ts`, `atsCohortCalibration.ts`, `atsJsonbCorruptionAlerts.ts` | typed decoders over ATS jsonb columns | named accessors (no bare jsonb casts) | `tests/ats-jsonb-accessors*`, `tests/ats-jsonb-route-boundaries*`, `tests/ats-jsonb-corruption-alerts*` | decoder-matrix suites; typecheck |
| Reports jsonb reads (F5) | `server/lib/reportJsonbAccessors.ts` | consumers: reports routes, import warnings, `reportTrendEntries.ts` | typed decoders over report jsonb shapes (current + legacy) | named accessors (no bare jsonb casts) | `tests/report-jsonb-accessors*`, `tests/report-jsonb-corruption-alerts*`, `tests/report-jsonb-corruption-route-alert*` | decoder-matrix suites; typecheck |

## Changing a boundary

- **Budget raise**: only when the root's own wiring grew; cite the wiring
  diff in the change, keep the headroom convention, and treat it as
  Architecture Governor L3 (owner-approved).
- **New domain module**: create the module, add the single mount/re-export
  line in the root, keep the direction rules above; for route modules,
  regenerate the route inventory in the same change.
- **Moving/renaming a root**: update `BUDGETS` in
  `scripts/lint-monolith-aggregator-size.ts` in the same change — the lint
  reports a missing root as unreadable and fails.
