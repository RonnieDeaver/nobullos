/**
 * Task #1804 — Universal "Apply pending prod writes" registry.
 *
 * A fixed, code-defined list of idempotent operator actions that the CEO
 * can apply from the Integrations Hub. Each entry exposes a `status()`
 * async check and an `apply()` async write. New writes get added here
 * whenever future tasks need them — one button, reusable forever.
 *
 * Pool tenancy: every action's `status()` and `apply()` runs as
 * background/maintenance work invoked from a route handler. We wrap the
 * full execution in `runWithWorkerDb` + `withDbAttribution` so the
 * underlying queries hit the `worker` pool (not `api`) and so the holds
 * land under a labelled bucket on the DB-attribution dashboard.
 */
/**
 * F7 (Task #4154): the 10.8k-line monolith was split into domain modules
 * under ./prodActions/ (kernel, helpers, nine action domains, composition,
 * engine). This file is now the COMPOSITION ROOT's public surface: it
 * re-exports every pre-split symbol under the same specifier, so routes,
 * services, and all existing tests keep importing from
 * `server/services/prodActionsRegistry` unchanged. Registration order and
 * the domain guard live in ./prodActions/composition.ts.
 */

export { PROD_ACTION_STATUS_STATES, PROD_ACTION_OUTCOME_STATES } from "./prodActions/kernel";
export type {
  ProdActionStatusState,
  ProdActionOutcomeState,
  ProdActionStatus,
  ProdActionOutcome,
  ProdActionSelfHeal,
  ProdActionConvergence,
  ProdAction,
} from "./prodActions/kernel";
export {
  __setFront202511RecoveryLauncherOverrideForTest,
  getRerunFront202511RecoveryStatus,
  applyRerunFront202511Recovery,
} from "./prodActions/frontRecoveryActions";
export { triggerFrontAutoClosureTickAction } from "./prodActions/frontSyncActions";
export {
  shouldSweepFrontCoverageMonth,
  listFrontPlanLimitedSearchRecoverableMonths,
  __setFrontRecentWindowFreshnessOverridesForTest,
  __setReachFrontCoverageFullForMonthOverrideForTest,
  getRecoverFrontPlanLimitedMessagesStatus,
  applyRecoverFrontPlanLimitedMessages,
  getFinishFrontMessageGrainCoverageStatus,
  applyFinishFrontMessageGrainCoverage,
  applyBackfillFrontMessageAttribution,
  getBackfillFrontMessageAttributionStatus,
  applyReachFrontCoverageFull,
  getReachFrontCoverageFullStatus,
  getFrontBringTo100DrainRunning,
} from "./prodActions/frontCoverageActions";
export { healImportedFabricatedZeroMetricsAction } from "./prodActions/reportContentActions";
export { PROD_ACTIONS } from "./prodActions/composition";
export {
  assertProdActionConvergenceInvariants,
  classifyIntegrationAuthBlocked,
  evaluateContinuousLoopHealth,
  getProdActionStatuses,
  applyAllProdActions,
  applyOneProdAction,
} from "./prodActions/engine";
export type {
  ProdActionStatusRow,
  ProdActionLastRunSummary,
  ProdActionCompletedRow,
  ProdActionStatusesResult,
  ProdActionApplyResult,
  ApplyOneProdActionResult,
} from "./prodActions/engine";

import { assertProdActionConvergenceInvariants } from "./prodActions/engine";

// Module-load enforcement (Task #4054): a violating action fails the boot
// of every process that imports the registry — dev server, workers, and
// any test touching prod actions — not just the dedicated guard suite.
// tests/prod-actions-convergence-taxonomy.test.ts asserts this exact
// top-level invocation line exists, so a merge can't silently drop it.
assertProdActionConvergenceInvariants();
