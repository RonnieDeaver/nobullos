/**
 * Prod-actions composition root (F7, Task #4154).
 *
 * Statically composes the registry from explicit domain modules: no
 * filesystem discovery, no globs, no service locator. Adding an action means
 * defining it in its domain module, adding it to that module's Domain
 * collection, and inserting it at the right position in the PROD_ACTIONS
 * array below — the module-load guard fails the boot on any disagreement.
 *
 * ORDER IS CONTRACT: the literal array below is the operator-facing panel
 * order AND the apply-all execution order (uniform contract preserved from
 * the pre-split registry — see audits/program-baseline-2026-08).
 */

import { assertProdActionDomainComposition, type ProdAction, type ProdActionDomain } from "./kernel";
import {
  disableFrontRecoveryActiveInboxFilterAction,
  enableFrontGapDrainWarpAction,
  enableFrontRecoveryPoolTuningAction,
  enableFrontWarpSpeedAction,
  forceRampFrontDrainAction,
  frontWarpClassBackfillAction,
  loosenApiPoolPressureGateAction,
  ramp2to3Action,
  rampFrontRecoveryIngestConcurrencyAction,
  rampIngestionClassConcurrency5Action,
  rampIngestionClassConcurrencyAction,
  rewritePendingFrontBacklogToIngestionAction,
  frontThroughputDomain,
} from "./frontThroughputActions";
import {
  backfillFrontRecoveryDedupeKeysAction,
  cancelFront2999PoisonCheckpointsAction,
  cancelStaleFrontBacklogAction,
  markLegacyFrontEmailPendingTerminalAction,
  pruneFailedRetroactiveReprocessBacklogAction,
  rearmParkedFrontRecoveryWindowsAction,
  recoverFrozenFrontMirrorAction,
  rematchDismissedOperationalBacklogAction,
  rematchUnmatchedFrontBacklogAction,
  rerunFront202511RecoveryAction,
  resetStuckFrontRecoveryCheckpointsAction,
  seedClientTrustedEmailDomainsAction,
  unblockPoisonedFrontRecoveryCheckpointsAction,
  frontRecoveryDomain,
} from "./frontRecoveryActions";
import {
  cleanupVendorIdentifierPoisonAction,
  drainStuckFrontDiscoveredApplyTailAction,
  enableFrontHydrateSnapshotsPrunerAction,
  reconcileFrontEmailsMissingMirrorAction,
  replayFrontWebhookApplyDeadLetterAction,
  triggerFrontAutoClosureTickAction,
  triggerFrontReconciliationSweepAction,
  frontSyncDomain,
} from "./frontSyncActions";
import {
  backfillFrontMessageAttributionAction,
  drainFront122kBacklogAction,
  enableFrontRecoveryPerMessageMaterializationAction,
  finishFrontMessageGrainCoverageAction,
  frontRecentWindowMessageFreshnessAction,
  purgeDeadFrontAdoptionDateSettingAction,
  purgePreFloorFrontCoverageRowsAction,
  reachFrontCoverageFullAction,
  recoverFrontPlanLimitedMessagesAction,
  refreshFinalizedFrontCoverageLocalCountsAction,
  relabelFrontCoverageUnitsAction,
  repairFrontCoverageDenominatorFloorAction,
  studyMaterializedFrontMessagesAction,
  frontCoverageDomain,
} from "./frontCoverageActions";
import {
  backfillCompetitorLocalityRelabelAction,
  backfillCompetitorLocationLabelsAction,
  backfillCompetitorStructuredLocationAction,
  competitorGeoDomain,
} from "./competitorGeoActions";
import {
  enableSemrushPersistentEnrichmentCacheAction,
  rerunStaleSemrushPartialsAction,
  semrushCadenceCutoverAction,
  semrushKeepAliveTickAction,
  semrushDomain,
} from "./semrushActions";
import {
  backfillCommsAttachmentThumbnailsAction,
  backfillEmptyReportSectionsAction,
  backfillSeasonalTrendAiCommentaryAction,
  backfillHeatmapSnapshotClientLinksAction,
  backfillReportSectionHistoryAction,
  cleanupInactiveProductReportBlocksAction,
  cleanupLegacyKeywordSpellingsAction,
  clearPlaceholderCommonIssuesAction,
  curateDemoReportDatasetAction,
  deactivateFabricatedZeroMetricFactsAction,
  enableOpenAskDedupConstraintAction,
  groomOpenAskBacklogAction,
  healImportedFabricatedZeroMetricsAction,
  purgeAiSlideVerdictsAction,
  reformatCommonIssuesAllReportsAction,
  repairDegenerateCommonIssuesFinalReportsAction,
  rejudgeStaleClientJudgmentsAction,
  reparseJune2026ReportLeadsAction,
  reviewWebinarBreakdownMismatchesAction,
  sanitizeSavedLinkPreviewAssetsAction,
  seedLiveDataCompletedMonthsAction,
  reportContentDomain,
} from "./reportContentActions";
import {
  drainStaleZoomApplyEventsAction,
  retireLegacyZoomOauthTokensAction,
  zoomRematchUnmatchedBacklogAction,
  zoomS2sCutoverAction,
  zoomS2sRollbackToOauthAction,
  zoomDomain,
} from "./zoomActions";
import {
  backfillUserAuthorityFromLegacyRoleAction,
  createPgStatStatementsExtensionAction,
  dedupeUserNotificationsUnreadAction,
  deepPruneReclaimOversizedTablesAction,
  deleteGoogleDriveLegacyKeyAction,
  deleteSpeedwellDuplicateClientsAction,
  enableAdsOsPacingRefreshAction,
  enableDbHoldRollupAction,
  adsOsIncompleteCriteriaStatusAction,
  enableDbPoolTenancyEnforcementAction,
  enableExternalCallAuditAction,
  enableFeedbackSlackRetryAction,
  enableOrphanedUserHealAction,
  enableProdActionSelfHealAction,
  enableProdActionSelfHealFailureAlertAction,
  enableProdActionSelfHealReconnectAlertAction,
  enableRedisCacheGloballyAction,
  enableTableRetentionPrunerAction,
  enableTableSizeWatchdogAction,
  makeCompanyOpsDepartmentsCompanyWideAction,
  backfillAgentChatSendersFromActivityAction,
  purgeSweptPiiScreenshotsAction,
  repairFeedbackUnknownSubmitterNamesAction,
  reconcileAdsOsPracticeAreasAction,
  syncAdsOsClientSchedulesAction,
  platformOpsDomain,
} from "./platformOpsActions";
import { smsConsentBackfillAction, smsConsentDomain } from "./smsConsentActions";
import {
  applyAdsOsMonitorLabelsAction,
  adsOsLabelDomain,
} from "./adsOsLabelActions";
import {
  refreshKiTrafficQualitySnapshotsAction,
  adsOsKiRefreshDomain,
} from "./adsOsKiRefreshActions";
import {
  importPaidSearchRolesAction,
  paidSearchRoleImportDomain,
} from "./paidSearchRoleImportAction";

/**
 * Explicit domain registration list (F7). Deterministic order; the guard
 * below rejects a domain whose actions are missing from PROD_ACTIONS, so a
 * new domain module cannot be imported-but-forgotten, and an array entry
 * whose domain is not registered here fails loudly at module load.
 */
export const PROD_ACTION_DOMAINS: readonly ProdActionDomain[] = [
  frontThroughputDomain,
  frontRecoveryDomain,
  frontSyncDomain,
  frontCoverageDomain,
  competitorGeoDomain,
  semrushDomain,
  reportContentDomain,
  zoomDomain,
  platformOpsDomain,
  smsConsentDomain,
  adsOsLabelDomain,
  adsOsKiRefreshDomain,
  paidSearchRoleImportDomain,
];

export const PROD_ACTIONS: ProdAction[] = [
  enableDbHoldRollupAction,
  enableExternalCallAuditAction,
  enableFrontRecoveryPoolTuningAction,
  rampFrontRecoveryIngestConcurrencyAction,
  ramp2to3Action,
  rampIngestionClassConcurrencyAction,
  rampIngestionClassConcurrency5Action,
  forceRampFrontDrainAction,
  loosenApiPoolPressureGateAction,
  disableFrontRecoveryActiveInboxFilterAction,
  dedupeUserNotificationsUnreadAction,
  cancelStaleFrontBacklogAction,
  recoverFrozenFrontMirrorAction,
  unblockPoisonedFrontRecoveryCheckpointsAction,
  cancelFront2999PoisonCheckpointsAction,
  drainFront122kBacklogAction,
  resetStuckFrontRecoveryCheckpointsAction,
  markLegacyFrontEmailPendingTerminalAction,
  relabelFrontCoverageUnitsAction,
  purgePreFloorFrontCoverageRowsAction,
  repairFrontCoverageDenominatorFloorAction,
  refreshFinalizedFrontCoverageLocalCountsAction,
  enableFrontRecoveryPerMessageMaterializationAction,
  rewritePendingFrontBacklogToIngestionAction,
  rematchDismissedOperationalBacklogAction,
  seedClientTrustedEmailDomainsAction,
  rematchUnmatchedFrontBacklogAction,
  frontWarpClassBackfillAction,
  enableFrontGapDrainWarpAction,
  enableFrontWarpSpeedAction,
  triggerFrontReconciliationSweepAction,
  triggerFrontAutoClosureTickAction,
  replayFrontWebhookApplyDeadLetterAction,
  drainStuckFrontDiscoveredApplyTailAction,
  backfillFrontMessageAttributionAction,
  reconcileFrontEmailsMissingMirrorAction,
  backfillFrontRecoveryDedupeKeysAction,
  backfillCompetitorLocationLabelsAction,
  backfillCompetitorStructuredLocationAction,
  backfillCompetitorLocalityRelabelAction,
  cleanupLegacyKeywordSpellingsAction,
  backfillHeatmapSnapshotClientLinksAction,
  sanitizeSavedLinkPreviewAssetsAction,
  backfillCommsAttachmentThumbnailsAction,
  reformatCommonIssuesAllReportsAction,
  repairDegenerateCommonIssuesFinalReportsAction,
  clearPlaceholderCommonIssuesAction,
  reparseJune2026ReportLeadsAction,
  rerunFront202511RecoveryAction,
  pruneFailedRetroactiveReprocessBacklogAction,
  semrushKeepAliveTickAction,
  rerunStaleSemrushPartialsAction,
  rearmParkedFrontRecoveryWindowsAction,
  reachFrontCoverageFullAction,
  frontRecentWindowMessageFreshnessAction,
  recoverFrontPlanLimitedMessagesAction,
  finishFrontMessageGrainCoverageAction,
  studyMaterializedFrontMessagesAction,
  // Task #4846 — deactivate poisoned '0 intake / 0 sales' memory facts for
  // clients whose report history shows those metrics were never entered
  // (one-press converging drain). Ordered BEFORE the re-judge action so an
  // Apply-all pass — and the operator flow — cleans memory first, then
  // regenerates judgments from it.
  deactivateFabricatedZeroMetricFactsAction,
  rejudgeStaleClientJudgmentsAction,
  purgeDeadFrontAdoptionDateSettingAction,
  semrushCadenceCutoverAction,
  enableSemrushPersistentEnrichmentCacheAction,
  // Task #1810 — Phase 4 pool-tenancy enforcement guard. The switch is
  // already registered (default OFF) in poolEpicKillSwitches.ts; this
  // action is the operator surface to flip it ON post-deploy.
  enableDbPoolTenancyEnforcementAction,
  // Task #1810 — front_hydrate_snapshots retention pruner. The pruner
  // service is registered at boot in `server/routes.ts`; this action
  // flips the gating system_setting ON.
  enableFrontHydrateSnapshotsPrunerAction,
  // Task #1810 — pg_stat_statements bootstrap. Idempotent CREATE
  // EXTENSION; the per-query observability source the regression
  // scanner in scripts/pg-stat-statements-regression.ts already
  // expects. Graceful when the connecting role lacks CREATE
  // privileges (returns `error` with a clear detail instead of
  // throwing past the apply path).
  createPgStatStatementsExtensionAction,
  backfillUserAuthorityFromLegacyRoleAction,
  // Task #4777 — one-shot rename of the feedback rows the Clerk cutover
  // mis-filed as "Unknown" (write-path fix in server/routes/feedback.ts
  // closed the feeder in the same change).
  repairFeedbackUnknownSubmitterNamesAction,
  enableRedisCacheGloballyAction,
  // Task #2086 — master switch for the self-heal scheduler that
  // automatically applies the idempotent, recurring maintenance
  // prod-actions opted in via `ProdAction.selfHeal` (cancel stale Front
  // backlog, dedupe unread notifications, mark legacy front_email
  // pending terminal, drain the 122k Front backlog, backfill competitor
  // location labels and structured locality/street, refresh
  // finalized-month Front coverage local counts, recover a frozen Front
  // email mirror). Default OFF —
  // flipping ON lets the worker-pool
  // scheduler run those same idempotent actions on each action's own
  // cadence/backoff so the CEO no longer applies them by hand. The
  // scheduler still honors the `prod_action_self_heal` queue-drain pause
  // and KILL_SWITCH_NON_CRITICAL_SWEEPS.
  enableProdActionSelfHealAction,
  // Task #2154 — one-press CEO button for the persistent-failure alert
  // (Task #2096). Mirrors `enable_prod_action_self_heal` above: flips the
  // opt-in setting ON so the self-heal tick pages the responsible admins
  // when one action records N consecutive `error` outcomes. With it OFF
  // the consecutive-failure streak is still tracked but no notification is
  // sent. Idempotent, write-through, default OFF.
  enableProdActionSelfHealFailureAlertAction,
  // Task #2201 — one-press CEO button for the reconnect-required
  // (auth-dead) alert (Task #2124). Mirrors
  // `enable_prod_action_self_heal_failure_alert` above: flips the opt-in
  // setting ON so the self-heal tick pages the responsible admins the
  // first time a self-heal action records a `blocked` (reconnect-required)
  // outcome, naming which integration to re-link. With it OFF the
  // `reconnectAlertSent` de-dupe flag is still tracked but no notification
  // is sent. Idempotent, write-through, default OFF.
  enableProdActionSelfHealReconnectAlertAction,
  // Task #2207 — one-press CEO button for the feedback → Slack
  // auto-resend + give-up loop (Tasks #2066 / #2131). Mirrors
  // `enable_prod_action_self_heal` above: flips the master setting ON so
  // the worker-pool scheduler re-drives un-delivered feedback through
  // `feedbackSlackRelay.ts` once Slack reconnects, and (Task #2131) marks
  // a row terminally `undeliverable` + escalates once it passes the
  // attempt/age give-up thresholds. The give-up thresholds keep their sane
  // defaults (`feedback_slack_retry_max_attempts` = 10,
  // `feedback_slack_retry_max_stuck_hours` = 48) — this action only flips
  // the enable switch so an operator can turn the loop on without
  // hand-editing `system_settings`. Idempotent, write-through, default OFF
  // (behaviour-neutral until pressed). The scheduler still honors the
  // `feedback_slack_retry` queue-drain pause.
  enableFeedbackSlackRetryAction,
  // Task #2244 — one-press CEO button for the orphaned-user profile-row
  // auto-heal sweep (Task #2203). Mirrors `enable_prod_action_self_heal`
  // and `enable_feedback_slack_retry` above — RETIRED by Task #4554
  // (closed admission): the heal tick short-circuits unconditionally
  // (before this enable switch is consulted) and never scans sessions or
  // creates `users` rows; rows are created only via admin approval. The
  // action is kept, inert, so operators pressing it see the retirement
  // reason in the last-run readout instead of a vanished feature.
  enableOrphanedUserHealAction,
  reviewWebinarBreakdownMismatchesAction,
  // Task #3612 — one-press CEO button for the Ads OS (rebuild) morning
  // pacing refresh scheduler (`morningPacingScheduler.ts`, Phase 2).
  // Prod-side twin of the dev-only ADS_OS_PACING_REFRESH_FORCE_ENABLE
  // env override: the scheduler is deployment-gated + default OFF, so
  // until this switch is flipped in production the dashboard pace pills
  // only refresh when a tool page is opened or the cron endpoint is
  // called. The scheduler re-checks the setting live at every 15-min
  // tick, so the flip takes effect without a restart. Distinct from the
  // retired legacy morning-refresh switch (Task #2958, removed #3603) — the
  // two systems cut over independently. Idempotent, write-through,
  // default OFF (behaviour-neutral until pressed). Verify the first
  // morning run (after ~6am ET) via the
  // `ads_os_pacing_refresh_last_run_date` system setting and fresh
  // `updated_at` stamps in `ads_os_budget_pacing` /
  // `ads_os_lsa_budget_pacing`. See ADS_OS.md § Morning refresh
  // scheduler.
  enableAdsOsPacingRefreshAction,
  // ─── Task #4962 — force-refresh KI traffic-quality snapshots (MANUAL LEVER) ─
  // Snapshots persisted before the GAQL multi-segment aggregation fix may
  // carry under-counted clicks/cost. This lever force-re-runs the Search Term
  // Analyzer for every enrolled Google Ads account, replacing stale snapshots
  // immediately rather than waiting for the 30-day TTL or organic overwrites.
  // Manual lever: triggers real GAQL + OpenAI calls per account — Apply-all
  // skips it (audited synthetic not-needed); the press is deliberate.
  refreshKiTrafficQualitySnapshotsAction,
  // ─── Task #4964 — apply Ads OS monitor labels (MANUAL LEVER) ────────
  // Ten enrolled GAds accounts run active campaigns with ZERO
  // NBM_GADS_MONITOR_CAMPAIGN labels, so every label-scoped Ads OS surface
  // renders a misleading $0.00. This lever creates the label in each
  // zero-label account (if absent) and attaches it to all active non-LSA
  // campaigns there, then invalidates the combined-dashboard cache.
  // Manual lever: it WRITES to client Google Ads accounts — Apply-all
  // skips it (audited synthetic not-needed); the press is a deliberate
  // individual operator decision and is never scheduled. Partially-labeled
  // accounts (intentional scoping) are never modified; re-press after
  // success finds no zero-label accounts and reports not-needed.
  applyAdsOsMonitorLabelsAction,
  // ─── Task #3699 — drain stale Zoom apply events ────────────────────
  // Production had 35 transcript_completed + ~374 recording_completed
  // source_event_log rows wedged at ready_to_apply with attempt_count=0:
  // the apply handler marked the event ready_to_apply and crashed, the
  // work_queue job's own retries exhausted separately, and nothing ever
  // re-drove the event. This button runs the same bounded, idempotent
  // sweep pass the nightly Zoom reconciliation now runs: re-enqueue the
  // matching apply job for each stale event (attempt_count increments;
  // handlers are idempotent — already-applied work skips), and terminally
  // close events whose event-level retry budget is exhausted with a
  // stored reason. Converges: each press either moves events toward
  // applied/failed or closes them; nothing is ever left silently
  // ready_to_apply.
  drainStaleZoomApplyEventsAction,
  healImportedFabricatedZeroMetricsAction,
  // Task #3814 — table-retention pruner. The pruner service is started at
  // boot in `server/routes.ts`; this action flips the gating
  // system_setting ON (mirrors enable_front_hydrate_snapshots_pruner).
  enableTableRetentionPrunerAction,
  // Task #3814 — table-size watchdog. Samples per-table sizes into
  // table_size_samples every 6h and alerts (infra.database.table_growth)
  // when a covered table grows past its expected band.
  enableTableSizeWatchdogAction,
  deepPruneReclaimOversizedTablesAction,
  zoomS2sCutoverAction,
  retireLegacyZoomOauthTokensAction,
  zoomS2sRollbackToOauthAction,
  zoomRematchUnmatchedBacklogAction,
  // NOTE: the `enable_semrush_no_external_calls_inside_db_hold` action is
  // deliberately NOT registered yet. The kill switch exists in
  // `poolEpicKillSwitches.ts` (default OFF), but the runtime enforcement
  // wrapper that detects SEMrush HTTP calls inside an active
  // withDbHoldLabel scope is a separate Phase 1.2 follow-on and has not
  // shipped. Registering the action today would let an operator flip a
  // switch that does nothing — see code-review reject (May 2026).
  deleteSpeedwellDuplicateClientsAction,
  // Task #4107 — B-008 closure: delete the legacy Drive SA key in GCP and
  // clear the stale google_service_account_key DB setting.
  deleteGoogleDriveLegacyKeyAction,
  // Task #4776 — manual lever: purge the two platform-swept PII screenshots
  // from git history (dev-workspace only; blocked in the deployment).
  purgeSweptPiiScreenshotsAction,
  // Task #4818 — one-press sync of per-client Ads OS schedule_days /
  // lsa_schedule_days from the authoritative schedule list. Only touches
  // the schedule fields; all other criteria are preserved.
  syncAdsOsClientSchedulesAction,
  // One fresh ClickUp snapshot reconciles only the local Practice Area mirror.
  // Manual lever: Apply all and every scheduler skip it.
  reconcileAdsOsPracticeAreasAction,
  // Task #4839 — read-only scan of SCHEDULE_SYNC_TARGETS for clients whose
  // stored criteria doc is still seeded-minimal (no business_name /
  // service_area) and older than 7 days. Surfaces the count + client names
  // in the prod-actions admin panel so operators can self-serve without
  // waiting for the daily Slack alert (Task #4832). No data is written.
  adsOsIncompleteCriteriaStatusAction,
  // Task #4175 — F3 report-data historical-hygiene closure (empty-section
  // backfill before history seed: its inserts carry their own baseline
  // history rows, so ordering keeps the two counts independent).
  backfillEmptyReportSectionsAction,
  backfillReportSectionHistoryAction,
  cleanupInactiveProductReportBlocksAction,
  // Task #4289 — one-shot curation of the public demo report's stored
  // dataset (stamp-gated; later operator edits are never reverted).
  curateDemoReportDatasetAction,
  // Task #4252 — backfill the cached seasonalTrendsAi commentary onto
  // reports finalized (and shared) before Task #4240 started generating it
  // at finalize time, so old share links get the AI analysis too.
  backfillSeasonalTrendAiCommentaryAction,
  // Task #4902 — clear AI-authored slide-verdict copy from existing reports
  // (owner mandate); operator-written verdicts kept, clears journaled.
  purgeAiSlideVerdictsAction,
  // Task #4336 — seed the SMS consent ledger for every already-known phone
  // number and apply any historical STOP/START keywords (guarded backfill).
  smsConsentBackfillAction,
  // Task #4765 — one-press retro-groom of the open-ask backlog: hindsight
  // closure sweep with per-row dispositions (resolved-with-evidence /
  // merged-duplicate / archived-abandoned / still-live checkpoint).
  groomOpenAskBacklogAction,
  // Task #4803 follow-on — CEO-pressed enablement of the Task #4765
  // open-ask duplicate backstop: merge production's pre-existing duplicate
  // active asks (keep-oldest keepers, audited dismissals), then build the
  // partial unique index that Publish's schema-only validation could not
  // create against dirty data.
  enableOpenAskDedupConstraintAction,
  // Task #4766 — one-time seed of final (post-close) measured snapshots for
  // recent completed months, so the tier gate's measured-stability fallback
  // has real BigQuery history (bounded, resumable, explainable dispositions).
  seedLiveDataCompletedMonthsAction,
  // Task #4790 — strip vendor identifiers (Stripe/Replit/Tabs3 + legal-tech
  // vendor list) from client rows and return the vendor-cited auto-matches
  // to the unmatched pool (convergent one-press drain; report-only list of
  // remaining suspicious trusted domains).
  cleanupVendorIdentifierPoisonAction,
  // Task #4872 — evidence-based attribution of pre-launch (pre-2026-08-03)
  // user-role agent-chat rows: stamp created_by_user_id only when
  // user_activity_logs evidence (±60min straddle or page_view dwell
  // containment on that client's surface) identifies exactly one plausible
  // sender; ambiguous/no-evidence rows stay in the historical bucket.
  backfillAgentChatSendersFromActivityAction,
  // Task #4893 — flip the six pinned "Company Ops – …" departments (created
  // per_client by the 2026-07-24 taxonomy re-org) to company-wide scope so
  // they stop appearing as all-gap rows on every client's per-client
  // surfaces. Skips-and-reports pinned ids renamed away from "Company Ops";
  // reversible per department via the existing Scope toggle.
  makeCompanyOpsDepartmentsCompanyWideAction,
  // Task #5157 — CEO-pressed one-shot import of ClickUp Paid Search
  // Doer/Checker assignments into NoBull per-client dept assignments.
  // Manual lever: deliberate individual press after reviewing the preview.
  importPaidSearchRolesAction,
];

// Composition guard (F7): runs at module load — a duplicate id across
// domains, an array entry with no owning domain, or a domain action missing
// from the ordered array fails the boot of every process importing the
// registry (dev server, workers, and any prod-action test).
assertProdActionDomainComposition(PROD_ACTION_DOMAINS, PROD_ACTIONS);
