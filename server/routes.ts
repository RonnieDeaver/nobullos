import type { Express } from "express";
import { toVoidRequestHandler } from "./lib/voidRequestHandler";
import { type Server } from "http";
import { db, withDbAttribution } from "./db";
import { sql } from "drizzle-orm";
import { requireTeamLead } from "./routes/middleware";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { registerFeedbackSlackRetryRoutes } from "./routes/feedbackSlackRetry";
import { registerOrphanedUserHealRoutes } from "./routes/orphanedUserHeal";
import { registerClientRoutes } from "./routes/clients";
import { registerChurnRoutes } from "./routes/churn";
import { registerSavePlayRoutes } from "./routes/savePlays";
import { registerClientFileRoutes } from "./routes/clientFiles";
import { registerReportRoutes } from "./routes/reports";
import { registerSettingsRoutes } from "./routes/settings";
import { registerMcuRoutes } from "./routes/mcu";
import { registerCeoToolsRoutes } from "./routes/ceoTools";
import { registerAtsRoutes } from "./routes/ats";
import { registerCommandCenterRoutes } from "./routes/commandCenter";
import { registerRisRoutes } from "./routes/ris";
import { registerLiveDataRoutes } from "./routes/liveData";
import { registerCommunicationRoutes } from "./routes/communications";
import { registerHeatmapRoutes } from "./routes/heatmap";
import { registerIntegrationRoutes } from "./routes/integrations";
import { registerGoogleAdsRoutes } from "./routes/googleAds";
import { registerGoogleAdsAuditRoutes } from "./routes/googleAdsAudit";
import { registerGoogleAdsHygieneRoutes } from "./routes/googleAdsHygiene";
import { registerAgentRoutes } from "./routes/agents";
import { registerMatchSettingsRoutes } from "./routes/matchSettings";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerUserNotificationRoutes } from "./routes/userNotifications";
import { registerUserSlackPreferenceRoutes } from "./routes/userSlackPreferences";
import { registerVideoAnalysisRoutes } from "./routes/videoAnalysis";
import { registerBillingRoutes } from "./routes/billing";
import { registerBookCheckoutRoutes } from "./routes/bookCheckout";
import { registerBookDeliveryRoutes } from "./routes/bookDelivery";
import { registerBookBuyerJourneyRoutes } from "./routes/bookBuyerJourney";
import { registerBookOperationsRoutes } from "./routes/bookOperations";
import { registerTwilioRoutes } from "./routes/twilio";
import { registerRevAiWebhookRoutes } from "./routes/revAiWebhook";
import { registerActivityRoutes } from "./routes/activity";
import { registerInternalUsageRoutes } from "./routes/internalUsage";
import { registerBookingRoutes } from "./routes/booking";
import { registerWebsiteRoutes } from "./routes/website";
import { registerOutboundEmailRoutes } from "./routes/outboundEmail";
import { registerEmailSequencesRoutes } from "./routes/emailSequences";
import { registerRoadmapRoutes } from "./routes/roadmap";
import { registerQueueControlRoutes } from "./routes/queueControl";
import { registerImportSuggestionRoutes } from "./routes/importSuggestions";
import { registerClickUpRoutes } from "./routes/clickup";
import { registerPoolAuditTrendRoutes } from "./routes/poolAuditTrends";
import { registerSemrushCadenceRoutes } from "./routes/semrushCadence";
import { startExternalCallAuditFlusher } from "./services/externalCallAudit";
import { startPoolAuditRollups } from "./services/poolAuditRollups";
import { startFrontHydrateSnapshotsPruner } from "./services/frontHydrateSnapshotsPruner";
import { startTableRetentionPruner } from "./services/tableRetentionPruner";
import { startTableSizeWatchdog } from "./services/tableSizeWatchdog";
import { startExternalCallAuditAlertsScheduler } from "./services/externalCallAuditAlerts";
import { startRequestMetricsFlusher } from "./services/requestMetrics";
import { startRequestMetricsAlertsScheduler } from "./services/requestMetricsAlerts";
import { registerConversationDedupeConflictRoutes } from "./routes/conversationDedupeConflicts";
import { registerProdActionsRoutes } from "./routes/prodActions";
import { registerBackupsRoutes } from "./routes/backups";
import { registerClerkAdminRoutes } from "./routes/clerkAdmin";
import { registerSheetsRoutes } from "./routes/sheets";
import { registerDocsRoutes } from "./routes/docs";
import { registerCommsRoutes } from "./routes/comms";
import { registerServiceDeskRoutes } from "./routes/serviceDesk";
import { registerAdsOsRoutes } from "./routes/adsOs";
import { initializeStripeSync } from "./stripeSync";
import { registerBlockedEventsRetentionAdminRoutes } from "./routes/blockedEventsRetentionAdmin";
// Task #5105 — GHL Marketplace inbound appointment/DND webhook (Ed25519-signed).
import { registerGhlMarketplaceWebhookRoutes } from "./routes/ghlMarketplaceWebhook";

// PR9 split (Task f1425127): the former ~6.1k lines of inline route
// registrations live in per-feature modules under ./routes/, invoked in the
// original inline order inside registerRoutes() below.
import { registerHealthRoutes } from "./routes/health";
import { registerRateLimitAdminRoutes } from "./routes/rateLimitAdmin";
import { registerAuditRetentionAdminRoutes } from "./routes/auditRetentionAdmin";
import { registerRateLimitNotificationRoutes } from "./routes/rateLimitNotifications";
import { registerRateLimitRetentionRoutes } from "./routes/rateLimitRetention";
import { registerAlertChannelSettingsRoutes } from "./routes/alertChannels";
import { registerRateLimitMultiplierRoutes } from "./routes/rateLimitMultipliers";
import { registerIpBlockingRoutes } from "./routes/ipBlocking";
import { registerFeedbackRoutes } from "./routes/feedback";
import { registerDealsRoutes } from "./routes/deals";
import { registerDealAutomationRoutes } from "./routes/dealAutomation";
import { registerTagsSegmentsRoutes } from "./routes/tagsSegments";
import { registerSmsConsentRoutes } from "./routes/smsConsent";
import { registerTimelineRoutes } from "./routes/timeline";
import { isAuthenticated } from "./middlewares/requireAuth";
import { registerLeadsRoutes } from "./routes/leads";
import { registerScoringRoutes } from "./routes/scoring";
import { registerCampaignRoutes } from "./routes/campaigns";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  registerObjectStorageRoutes(app);

  void withDbAttribution("startup:ats-backfill", () =>
    db.execute(sql`
      UPDATE ats_candidates
      SET assessment_base_score = total_score,
          final_display_score = COALESCE(calibrated_score, total_score)
      WHERE assessment_base_score IS NULL
        AND total_score IS NOT NULL
    `).then(() => {}).catch((e: any) => {
      console.error("[ATS Backfill] Error:", e.message);
    }),
  );

  // ─── PR9 split (Task f1425127) ─────────────────────────────────────────────
  // The calls below mount the former inline registrations (one module per
  // feature area, under ./routes/) in their exact original inline order.
  // Mount-order is a contract: later param routes must not swallow earlier
  // literal paths — do not reorder these calls.
  await registerHealthRoutes(app);
  registerRateLimitAdminRoutes(app);
  registerAuditRetentionAdminRoutes(app);
  registerRateLimitNotificationRoutes(app);
  registerRateLimitRetentionRoutes(app);
  registerAlertChannelSettingsRoutes(app);
  registerRateLimitMultiplierRoutes(app);
  registerBlockedEventsRetentionAdminRoutes(app);
  registerIpBlockingRoutes(app);
  registerFeedbackRoutes(app);

  // Task #2075 — operator surface for the feedback → Slack auto-resend
  // scheduler (status readout + on-demand run). Extracted to
  // `server/routes/feedbackSlackRetry.ts` so the two endpoints can be
  // covered by `tests/feedback-slack-retry-routes.test.ts`.
  registerFeedbackSlackRetryRoutes(app);
  // Task #2243 — operator status readout for the orphaned-user heal sweep
  // (Task #2203): GET /api/admin/orphaned-user-heal/status. Extracted to
  // `server/routes/orphanedUserHeal.ts` so it can be covered by
  // `tests/orphaned-user-heal-routes.test.ts`.
  registerOrphanedUserHealRoutes(app);

  registerClientRoutes(app);
  // Task #4327 — Deals pipeline (kanban CRM board + stage history).
  // Extracted to server/routes/deals.ts; covered by tests/deals-routes.test.ts.
  registerDealsRoutes(app);
  // Task #4329 — Tags & segments engine (definitions CRUD, manual
  // apply/remove, segment membership, sweep status/trigger). Extracted to
  // server/routes/tagsSegments.ts; covered by tests/tags-segments.test.ts.
  registerTagsSegmentsRoutes(app);
  // Task #4333 — deal & lead scoring (config/rule CRUD, recompute, preview):
  // server/routes/scoring.ts; covered by tests/deal-scoring.test.ts.
  registerScoringRoutes(app);
  // Task #4331 — Deal stage automation rules engine (rules CRUD, run
  // history, kill switch, pending-event requeue). Extracted to
  // server/routes/dealAutomation.ts; covered by tests/deal-automation.test.ts.
  registerDealAutomationRoutes(app);
  // Task #4328 — Unified client activity timeline: read-only merged feed
  // (emails/SMS/calls/meetings/tickets/notes) for client + deal detail.
  // Extracted to server/routes/timeline.ts; covered by
  // tests/client-timeline-route.test.ts.
  registerTimelineRoutes(app);
  // Task #4330 — Lead intake & lifecycle stages: Leads list/detail, manual
  // stage correction, promote-to-deal. Extracted to server/routes/leads.ts;
  // covered by tests/lead-lifecycle.test.ts.
  registerLeadsRoutes(app);
  // Task #4337 — Campaigns & first-touch attribution: campaign CRUD +
  // tracked UTM links + source/campaign attribution report. Extracted to
  // server/routes/campaigns.ts; covered by tests/campaign-attribution.test.ts.
  registerCampaignRoutes(app);
  // Task #3691 — Churn Command Center (director-gated churn leaderboard).
  // Extracted to server/routes/churn.ts; covered by tests/churn-leaderboard.test.ts.
  registerChurnRoutes(app);
  // Task #3696 — Save-play tracker: per-client CRUD + director-gated
  // /api/churn/save-plays rollup. Extracted to server/routes/savePlays.ts;
  // covered by tests/save-plays.test.ts.
  registerSavePlayRoutes(app);
  // Task #4023 — in-app client file storage: per-client folders/files on
  // private object storage (presigned upload + verified claim, versioning,
  // trash, activity) + global /api/files library. Extracted to
  // server/routes/clientFiles.ts; covered by tests/client-files-routes.test.ts.
  registerClientFileRoutes(app);
  registerReportRoutes(app);
  registerSettingsRoutes(app);
  registerMcuRoutes(app);
  registerCeoToolsRoutes(app);
  registerAtsRoutes(app);
  registerCommandCenterRoutes(app);
  registerRisRoutes(app);
  registerLiveDataRoutes(app);
  registerCommunicationRoutes(app);
  registerHeatmapRoutes(app);
  registerIntegrationRoutes(app);
  // Task #5105 — GHL Marketplace signed webhook receiver (appointment outcomes +
  // DND opt-out). Registered immediately after the GHL integration surface;
  // Ed25519 fail-closed, no session auth, governed by webhookLimiter.
  registerGhlMarketplaceWebhookRoutes(app);
  registerGoogleAdsRoutes(app);
  registerGoogleAdsAuditRoutes(app);
  registerGoogleAdsHygieneRoutes(app);
  registerAgentRoutes(app);
  registerMatchSettingsRoutes(app);
  registerNotificationRoutes(app, { isAuthenticated, requireTeamLead });
  // Wrap the Promise-returning role middleware in a void-returning RequestHandler
  // so no-misused-promises is satisfied where these Opts types declare
  // RequestHandler (void return); rejections route to Express error handling.
  const requireTeamLeadVoid = toVoidRequestHandler(requireTeamLead);
  registerUserNotificationRoutes(app, { isAuthenticated, requireTeamLead: requireTeamLeadVoid });
  registerUserSlackPreferenceRoutes(app, { isAuthenticated, requireTeamLead: requireTeamLeadVoid });
  registerVideoAnalysisRoutes(app);
  registerBillingRoutes(app);
  // Task #5097 — Book-commerce public checkout API (catalog + start +
  // capability-token-gated resume/contact/totals/payment-intent).
  // Registered adjacent to billing; dedicated IP-keyed bookCheckoutLimiter.
  registerBookCheckoutRoutes(app);
  registerBookDeliveryRoutes(app);
  registerBookBuyerJourneyRoutes(app);
  registerBookOperationsRoutes(app);
  registerTwilioRoutes(app);
  // Task #4336 — SMS consent ledger (comms status lookups + admin ledger/
  // events/gate-audit/settings). Registered right after the Twilio surface
  // it belongs to; all literal paths, no param-route interactions.
  registerSmsConsentRoutes(app);
  // Task #3963 (audit B-012) — Rev.ai transcription-completion webhook
  // (vendor-called: bearer-secret auth via notification_config, no session).
  registerRevAiWebhookRoutes(app);
  registerActivityRoutes(app);
  registerInternalUsageRoutes(app);
  registerBookingRoutes(app);
  registerWebsiteRoutes(app);
  // Task #4334 — outbound client-facing email: compose/log/suppressions
  // admin surface + public unsubscribe + SendGrid signed event webhook.
  registerOutboundEmailRoutes(app);
  // Task #4335 — email templates + approval-gated sequences: template
  // library, sequence definitions/enrollment, approval queue, kill switch.
  registerEmailSequencesRoutes(app);
  // Task #3728 — company roadmap: team_lead+ CRUD + the public/embed JSON.
  // Covered by tests/roadmap-public-routes.test.ts.
  registerRoadmapRoutes(app);
  registerQueueControlRoutes(app, requireTeamLead);
  registerImportSuggestionRoutes(app);
  registerClickUpRoutes(app);
  registerPoolAuditTrendRoutes(app);
  registerSemrushCadenceRoutes(app);
  registerConversationDedupeConflictRoutes(app);
  registerProdActionsRoutes(app);
  registerBackupsRoutes(app);
  registerClerkAdminRoutes(app);
  registerSheetsRoutes(app);
  registerDocsRoutes(app);
  registerCommsRoutes(app);
  registerServiceDeskRoutes(app);
  registerAdsOsRoutes(app);

  // Task #1728 (Pool epic Phase 1.5): start the audit flusher and the
  // hourly rollup tick. Both are no-ops until the corresponding Phase 0
  // kill switches (`external_call_audit_enabled`, `db_hold_rollup_enabled`)
  // are flipped, so it's safe to start them unconditionally at boot.
  startExternalCallAuditFlusher();
  startPoolAuditRollups();
  startFrontHydrateSnapshotsPruner();
  // Task #3814 — retention pruner + size watchdog for the high-churn
  // operational tables (work_queue, source_event_log, call_analysis_jobs,
  // mcu_cache, …). Both are no-ops until their gating system settings
  // (`table_retention_pruner_enabled`, `table_size_watchdog_enabled`)
  // are flipped via the registry actions, so safe to start at boot.
  startTableRetentionPruner();
  startTableSizeWatchdog();
  // Task #1731 (Pool epic Phase 4, spec 4.4) — external-call audit alert
  // evaluator. No-op until the Phase 0 `external_call_audit_enabled`
  // switch is flipped, so safe to start unconditionally at boot.
  startExternalCallAuditAlertsScheduler();
  // Task #3816 — app-wide request spine: persist the rolling per-route
  // latency/error windows every 5 min, and evaluate the sustained
  // p95/error-rate regression bands each minute (config via the
  // `request_metrics_alert_config` system setting; honors the
  // `non_critical_sweeps` kill switch). Skipped in test mode: suites that
  // boot registerRoutes would otherwise flush window rows and — when an
  // error-path suite drives ≥minCount 5xx on one route past the 90s first
  // eval — fire REAL regression alerts (admin inbox fan-out) into the
  // shared dev DB (semrushAuthMode test-gate convention).
  if (process.env.NODE_ENV !== "test" && !process.env.TEST_SMOKE) {
    startRequestMetricsFlusher();
    startRequestMetricsAlertsScheduler();
  }

  initializeStripeSync().catch((err) => {
    console.error("[StripeSync] Failed to initialize:", err.message);
  });

  return httpServer;
}
