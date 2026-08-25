/**
 * Boot — staggered scheduler inits.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * every deferred scheduler/keep-alive/retention timer plus post-deploy verification.
 */

import { withDbAttribution as _withDbAttribution } from "../db";
import { shouldRunFrontBackgroundWorkers } from "../lib/deploymentEnv";
import { log } from "./httpApp";
import { isGracefulShutdown, trackTimer } from "./shutdown";

export function kickSchedulerInits(): void {
      (async () => {
        const { WORKER_SCHEDULE_JITTER_MS, WORKER_STAGGER_OFFSETS } = await import("../services/workerConfig");
        const jitter = () => Math.floor(Math.random() * WORKER_SCHEDULE_JITTER_MS);
        // Task #955: every deferred-scheduler bootstrap setTimeout is wrapped
        // in `_withDbAttribution("startup:<scheduler>")` so any DB checkout
        // performed by the start helper itself (or its inner module init)
        // is attributed instead of falling into the `unknown` bucket. The
        // schedulers themselves install their own `scheduler:` / `worker:`
        // attribution scope on each tick.
        const startupTick = (label: string, fn: () => Promise<unknown> | unknown) => () => {
          if (isGracefulShutdown) return;
          void _withDbAttribution(`startup:${label}`, async () => {
            await fn();
          });
        };
        // Task #2289 — gate the Front background workers (live sync,
        // coverage refresh, reconciliation, auto-closure, outbound-gap
        // drivers, recovery prune sweep) to the deployment only. The
        // always-on workspace process was a second concurrent OAuth
        // refresher racing the deployment; combined with the cross-process
        // refresh lease (one deployed instance refreshes at a time), this
        // removes the workspace from the refresher pool entirely. On-demand
        // Front API paths (admin actions, the `/me` probe) are NOT gated —
        // they run wherever a request originates.
        const runFrontWorkers = shouldRunFrontBackgroundWorkers();
        if (!runFrontWorkers) {
          log(
            "[Front] Background workers gated OFF (workspace) — deployment owns Front sync/coverage/reconciliation/auto-closure/outbound-gap workers (Task #2289). Set FRONT_WORKERS_FORCE_ENABLE=1 to run them locally.",
          );
        }
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-sync-init", () =>
          import("../services/frontIntegration").then(({ initAutoSync }) => initAutoSync()),
        ), WORKER_STAGGER_OFFSETS.front_sync + jitter()));
        trackTimer(setTimeout(startupTick("semrush-enrichment-init", () =>
          import("../services/semrushApi").then(({ startupEnrichment }) => startupEnrichment()),
        ), WORKER_STAGGER_OFFSETS.semrush_enrichment + jitter()));
        trackTimer(setTimeout(startupTick("slack-profile-sync-init", async () => {
          const { isConnected, syncSlackProfiles } = await import("../services/slackIntegration");
          const connected = await isConnected();
          if (connected) {
            await syncSlackProfiles().catch(err => console.warn("[Slack] Startup profile sync failed:", err?.message));
          }
        }), WORKER_STAGGER_OFFSETS.slack_profile_sync + jitter()));
        trackTimer(setTimeout(startupTick("zoom-sync-init", () =>
          import("../services/zoomIntegration").then(({ initZoomAutoSync }) => initZoomAutoSync()),
        ), WORKER_STAGGER_OFFSETS.zoom_sync + jitter()));
        trackTimer(setTimeout(startupTick("daily-judgment-init", () =>
          import("../services/dailyJudgmentScheduler").then(({ startDailyJudgmentScheduler }) => startDailyJudgmentScheduler()),
        ), WORKER_STAGGER_OFFSETS.daily_judgment + jitter()));
        // Task #1759 — daily Google Ads sync scheduler. Enqueues a
        // dedupe-keyed `google_ads_sync` job every 6h; the handler
        // short-circuits when the integration is not configured /
        // connected so we never burn API-pool capacity polling.
        trackTimer(setTimeout(startupTick("google-ads-sync-init", () =>
          import("../services/googleAdsSync").then(({ startGoogleAdsSyncScheduler }) => startGoogleAdsSyncScheduler()),
        ), WORKER_STAGGER_OFFSETS.google_ads_sync + jitter()));
        trackTimer(setTimeout(startupTick("call-analysis-init", () =>
          import("../services/callAnalysis").then(({ startWorker }) =>
            startWorker().catch(err => console.error("[CallAnalysis] Worker start failed:", err)),
          ),
        ), WORKER_STAGGER_OFFSETS.call_analysis + jitter()));
        // Task #1049: slow-lane worker for long-audio call analysis.
        // Runs as a separate poller with a 15-min per-job budget so
        // long calls cannot starve normal-call latency.
        trackTimer(setTimeout(startupTick("call-analysis-slow-init", () =>
          import("../services/callAnalysis").then(({ startSlowLaneWorker }) =>
            startSlowLaneWorker().catch(err => console.error("[CallAnalysis] Slow-lane worker start failed:", err)),
          ),
        ), WORKER_STAGGER_OFFSETS.call_analysis_slow + jitter()));
        trackTimer(setTimeout(startupTick("call-archive-init", () =>
          import("../services/callArchivePipeline").then(({ startCallArchiveScheduler }) => startCallArchiveScheduler())
            .catch(err => console.error("[CallArchive] Scheduler start failed:", err)),
        ), WORKER_STAGGER_OFFSETS.call_analysis + jitter() + 5000));
        // Task #978 Phase 1: handler registration moved to
        // `registerAllHandlers()` (see workQueueHandlers.ts) so it
        // happens synchronously before the scheduler begins polling.
        // This deferred tick now only starts the inventory-sync
        // scheduler (cron-style enqueue), not the handler.
        trackTimer(setTimeout(startupTick("semrush-inventory-sync-init", () =>
          import("../services/semrushInventorySync").then(({ startInventorySyncScheduler }) => {
            startInventorySyncScheduler();
          }),
        ), WORKER_STAGGER_OFFSETS.semrush_inventory_sync + jitter()));
        trackTimer(setTimeout(startupTick("zoom-review-alerts-init", () =>
          import("../services/zoomReviewQueueAlerts").then(({ startZoomReviewAlertScheduler }) => startZoomReviewAlertScheduler()),
        ), WORKER_STAGGER_OFFSETS.zoom_review_alerts + jitter()));
        // Task #3702 — Zoom client face-sentiment sweep. Default OFF via the
        // `zoom_face_sentiment_enabled` kill switch; the scheduler ticks but
        // each tick is a no-op while disabled.
        trackTimer(setTimeout(startupTick("zoom-face-sentiment-init", () =>
          import("../services/zoomFaceSentiment").then(({ startZoomFaceSentimentScheduler }) => startZoomFaceSentimentScheduler()),
        ), WORKER_STAGGER_OFFSETS.zoom_face_sentiment + jitter()));
        // Task #2368 — RIS BigQuery auto-pull. Default OFF via the
        // `enable_ris_bigquery_autopull` system setting; the scheduler ticks
        // but each tick is a no-op while disabled.
        trackTimer(setTimeout(startupTick("ris-bigquery-autopull-init", () =>
          import("../services/ris/risAutoPullScheduler").then(({ startRisAutoPullScheduler }) => startRisAutoPullScheduler()),
        ), WORKER_STAGGER_OFFSETS.ris_bigquery_autopull + jitter()));
        // Task #2686 — Live Data hourly BigQuery pull. Default OFF via
        // `enable_live_data_autopull` system setting.
        trackTimer(setTimeout(startupTick("live-data-autopull-init", () =>
          import("../services/liveData/liveDataScheduler").then(({ startLiveDataScheduler }) => startLiveDataScheduler()),
        ), WORKER_STAGGER_OFFSETS.live_data_autopull + jitter()));
        trackTimer(setTimeout(startupTick("app-backup-init", () =>
          import("../services/appBackupScheduler").then(({ startAppBackupScheduler }) => startAppBackupScheduler()),
        ), WORKER_STAGGER_OFFSETS.app_backup + jitter()));
        // Task #4645 — sustained Slack-outage daily escalation. The detector
        // is event-driven (dispatcher outcomes + console reads), but a quiet
        // or restarted deployment with zero delivery attempts would never
        // emit the next day-N re-alert; this 6h evaluator guarantees the
        // daily cadence from durable state alone. Cross-instance singleton
        // per tick; test-inert under the test runner.
        trackTimer(setTimeout(startupTick("slack-outage-evaluator-init", () =>
          import("../services/notifications/slackOutageDetector").then(({ startSlackOutageEvaluator }) => startSlackOutageEvaluator()),
        ), WORKER_STAGGER_OFFSETS.slack_outage_evaluator + jitter()));
        // Task #4888 — weekly win-cadence nudge. Shortly after a UTC week
        // closes, account managers who logged zero wins the prior week get a
        // bell nudge (team leads a summary). Lock-guarded periodic evaluator
        // over durable state (week-stamped ledger in notification_health_state);
        // cross-instance singleton per tick; test-inert under the test runner.
        trackTimer(setTimeout(startupTick("win-cadence-nudge-init", () =>
          import("../services/notifications/winCadenceNudge").then(({ startWinCadenceNudgeScheduler }) => startWinCadenceNudgeScheduler()),
        ), WORKER_STAGGER_OFFSETS.win_cadence_nudge + jitter()));
        // Task #2740 — proactive Zoom token keep-alive. Deployment-gated +
        // cross-instance singleton; rotates the Draft-app refresh token
        // before its ~1h cutoff so a quiet period can't let it expire.
        // Hot-toggle off via `zoom_token_keepalive_enabled`.
        trackTimer(setTimeout(startupTick("zoom-token-keepalive-init", () =>
          import("../services/zoomTokenKeepAliveScheduler").then(({ startZoomTokenKeepAliveScheduler }) =>
            startZoomTokenKeepAliveScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.zoom_token_keepalive + jitter()));
        // Proactive SEMrush token keep-alive. Deployment-gated +
        // cross-instance singleton; rotates the 7-day access token 48 h
        // before expiry so a quiet deployment can't silently let it
        // expire (root cause of the Jul 1–15 2026 fleet-wide paused_auth
        // outage). Hot-toggle off via `semrush_token_keepalive_enabled`.
        trackTimer(setTimeout(startupTick("semrush-token-keepalive-init", () =>
          import("../services/semrushTokenKeepAliveScheduler").then(({ startSemrushTokenKeepAliveScheduler }) =>
            startSemrushTokenKeepAliveScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.semrush_token_keepalive + jitter()));
        // Ads OS (Task #3598) — morning budget-pacing refresh for the
        // rebuilt /ads-os stores. Deployment-gated + cross-instance singleton;
        // default OFF — enable via the `ads_os_pacing_refresh_enabled` system
        // setting. Re-runs GAds + LSA budget pacing for every enrolled account
        // (incl. Off) once per morning after 6:00 ET — same code path as
        // POST /api/ads-os/cron/refresh-pacing.
        trackTimer(setTimeout(startupTick("ads-os-pacing-refresh-init", () =>
          import("../services/adsOs/morningPacingScheduler").then(({ startAdsOsPacingRefreshScheduler }) =>
            startAdsOsPacingRefreshScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.ads_os_pacing_refresh + jitter()));
        // Task #4964 — Ads OS monitor-label drift guard. Alerts the
        // responsible admins when any enrolled GAds account drifts to ZERO
        // monitor-labeled campaigns (its Ads OS metrics silently render
        // $0.00). Lock-guarded periodic evaluator over durable state
        // (day-stamped ledger in notification_health_state) — daily re-fire
        // while the condition persists, no intra-day spam. Deployment-gated,
        // cross-instance singleton, default ON with kill switch
        // `ads_os_label_drift_guard_enabled`; test-inert.
        trackTimer(setTimeout(startupTick("ads-os-label-drift-init", () =>
          import("../services/adsOs/labelDriftGuard").then(({ startLabelDriftGuardScheduler }) =>
            startLabelDriftGuardScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.ads_os_label_drift + jitter()));
        // Ads OS enrollment/MCC integrity guard. Once per ET day, compares
        // live ClickUp-enrolled CIDs (including Off) with the MCC's ENABLED
        // account list and alerts Slack + responsible-admin bells per missing
        // CID. Durable daily ledger, cross-instance singleton, default ON via
        // `ads_os_mcc_enrollment_guard_enabled`; test-inert.
        trackTimer(setTimeout(startupTick("ads-os-mcc-enrollment-guard-init", () =>
          import("../services/adsOs/enrollmentMissingGuard").then(({ startMccEnrollmentGuardScheduler }) =>
            startMccEnrollmentGuardScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.ads_os_mcc_enrollment_guard + jitter()));
        // Independent watchdog for the label-drift guard above. Reads the
        // guard's durable completed-pass heartbeat and alerts responsible
        // admins after 30 minutes of staleness. Its separate timer + lock let
        // it detect a stopped/disabled guard timer. Default ON; hot-toggle via
        // `ads_os_label_drift_guard_staleness_alert_enabled`; test-inert.
        trackTimer(setTimeout(startupTick("ads-os-label-drift-staleness-init", () =>
          import("../services/adsOs/labelDriftStalenessWatchdog").then(({ startLabelDriftStalenessWatchdogScheduler }) =>
            startLabelDriftStalenessWatchdogScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.ads_os_label_drift_staleness + jitter()));
        // Task #2984 — periodic ClickUp reconciliation sweep + webhook health.
        // Deployment-gated, cross-instance singleton. Default OFF via
        // `clickup_reconciliation_sweep_enabled` system setting.
        trackTimer(setTimeout(startupTick("clickup-reconciliation-init", () =>
          import("../services/clickUpReconciliationScheduler").then(({ startClickUpReconciliationScheduler }) =>
            startClickUpReconciliationScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.clickup_reconciliation + jitter()));
        // Task #4329 — periodic tags & segments reconciliation sweep
        // (rule tags + segment membership converge to their criteria).
        // Deployment-gated, cross-instance singleton. Default OFF via
        // `tags_segments_sweep_enabled` system setting.
        trackTimer(setTimeout(startupTick("tag-segment-reconcile-init", () =>
          import("../services/tagSegmentScheduler").then(({ startTagSegmentScheduler }) =>
            startTagSegmentScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.tag_segment_reconcile + jitter()));
        // Task #4333 — nightly deal/lead score recompute producer
        // (engagement windows decay with time, so scores rot without it).
        // Deployment-gated, cross-instance singleton. Default ON with kill
        // switch `scoring_sweep_enabled` — set "false" to pause.
        trackTimer(setTimeout(startupTick("score-recompute-init", () =>
          import("../services/scoringScheduler").then(({ startScoringScheduler }) =>
            startScoringScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.score_recompute + jitter()));
        // Task #4640 — dev/prod schema-drift catalog check. Deployment:
        // nightly comparator (cross-instance singleton, default ON, kill
        // switch `schema_drift_check_enabled`) that alerts when prod holds
        // catalog objects dev lacks. Main dev workspace (structurally not a
        // task sub-environment): periodic dev catalog snapshot publisher
        // (default ON, kill switch `schema_drift_snapshot_publish_enabled`).
        trackTimer(setTimeout(startupTick("schema-drift-check-init", () =>
          import("../services/schemaDriftCheck").then(({ startSchemaDriftScheduler }) =>
            startSchemaDriftScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.schema_drift_check + jitter()));
        // Task #3059 — Service Desk overdue sweep + delivered auto-close scheduler.
        // Deployment-gated, cross-instance singleton. Default OFF via
        // `sd_scheduler_enabled` system setting.
        trackTimer(setTimeout(startupTick("sd-scheduler-init", () =>
          import("../services/sdScheduler").then(({ startSdScheduler }) =>
            startSdScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.sd_scheduler + jitter()));
        // Task #3711 — daily client-offboarding sweep (06:30 America/New_York
        // + boot catch-up): auto-archives clients whose scheduled final day of
        // service has arrived, via the same shared helper as the manual
        // Archive action. Deployment-gated, cross-instance singleton. Default
        // ON with kill switch `client_offboarding_sweep_disabled`.
        trackTimer(setTimeout(startupTick("client-offboarding-sweep-init", () =>
          import("../services/clientOffboardingScheduler").then(({ startClientOffboardingScheduler }) =>
            startClientOffboardingScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.client_offboarding_sweep + jitter()));
        // Comms scheduled-message delivery producer tick — scans
        // comms_scheduled_messages for due rows every 60 s and enqueues
        // individual comms_scheduled_delivery jobs (deduped per message).
        trackTimer(setTimeout(startupTick("comms-scheduled-delivery-init", () =>
          import("../services/commsScheduledDelivery").then(({ startCommsScheduledDeliveryScheduler }) =>
            startCommsScheduledDeliveryScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.comms_scheduled_delivery + jitter()));
        // Task #3520 — daily sweep of orphaned comms draft attachments
        // (originals + thumbs left behind after promotion / abandoned
        // drafts). Deployment-gated, cross-instance singleton. Default OFF
        // via `comms_draft_attachment_cleanup_enabled` system setting.
        trackTimer(setTimeout(startupTick("comms-draft-cleanup-init", () =>
          import("../services/commsDraftAttachmentCleanup").then(({ startCommsDraftAttachmentCleanupScheduler }) =>
            startCommsDraftAttachmentCleanupScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.comms_draft_attachment_cleanup + jitter()));
        // Task #3983 — daily sweep of abandoned presigned uploads (unclaimed,
        // unreferenced objects under uploads/, feedback-uploads/ and ats-*
        // past the grace window). Deployment-gated, cross-instance singleton.
        // Default OFF via `abandoned_upload_cleanup_enabled` system setting.
        trackTimer(setTimeout(startupTick("abandoned-upload-cleanup-init", () =>
          import("../services/abandonedUploadCleanup").then(({ startAbandonedUploadCleanupScheduler }) =>
            startAbandonedUploadCleanupScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.abandoned_upload_cleanup + jitter()));
        // Task #4023 — daily retention purge of expired client-file Trash
        // (objects deleted first, then DB rows). Deployment-gated,
        // cross-instance singleton. Default OFF via
        // `client_file_trash_purge_enabled` system setting.
        trackTimer(setTimeout(startupTick("client-file-trash-purge-init", () =>
          import("../services/clientFileTrashPurge").then(({ startClientFileTrashPurgeScheduler }) =>
            startClientFileTrashPurgeScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.client_file_trash_purge + jitter()));
        // Comms message-reminder producer tick — checks comms_message_reminders
        // for due rows every 60 s and enqueues a deduped comms_reminder_deliver
        // drain job (Task #3254).
        trackTimer(setTimeout(startupTick("comms-reminder-init", () =>
          import("../services/commsReminderDeliver").then(({ startCommsReminderScheduler }) =>
            startCommsReminderScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.comms_reminder_deliver + jitter()));
        trackTimer(setTimeout(startupTick("rate-limit-auto-tune-init", () =>
          import("../services/rateLimitAutoTuner").then(({ startAutoTuneScheduler }) => startAutoTuneScheduler()),
        ), WORKER_STAGGER_OFFSETS.rate_limit_auto_tune + jitter()));
        // Task #2897 — hourly RSS/heap logging + Slack alert at ~75% of the
        // 4 GB Reserved VM tier. Default ON; kill switch
        // `memory_watchdog_enabled`, threshold `memory_watchdog_alert_rss_mb`.
        trackTimer(setTimeout(startupTick("memory-watchdog-init", () =>
          import("../services/memoryWatchdog").then(({ startMemoryWatchdog }) => startMemoryWatchdog()),
        ), WORKER_STAGGER_OFFSETS.memory_watchdog + jitter()));
        trackTimer(setTimeout(startupTick("audit-retention-init", () =>
          import("../services/auditRetention").then(({ startAuditRetentionScheduler }) => startAuditRetentionScheduler()),
        ), WORKER_STAGGER_OFFSETS.audit_retention + jitter()));
        trackTimer(setTimeout(startupTick("rate-limit-notification-retention-init", () =>
          import("../services/rateLimitNotificationRetention").then(({ startRateLimitNotificationRetentionScheduler }) =>
            startRateLimitNotificationRetentionScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.rate_limit_notification_retention + jitter()));
        trackTimer(setTimeout(startupTick("pending-digest-alerts-retention-init", () =>
          import("../services/pendingDigestAlertsRetention").then(({ startPendingDigestAlertsRetentionScheduler }) =>
            startPendingDigestAlertsRetentionScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.pending_digest_alerts_retention + jitter()));
        // Task #758 — daily auto-cleanup of stale SEMrush
        // location-campaign mappings whose locationId is no longer
        // configured. Disable via system setting
        // `semrush_ghost_cleanup_enabled`.
        trackTimer(setTimeout(startupTick("semrush-ghost-cleanup-init", () =>
          import("../services/semrushGhostCleanup").then(({ startSemrushGhostCleanupScheduler }) =>
            startSemrushGhostCleanupScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.semrush_ghost_cleanup + jitter()));
        // Task #1222 — daily snapshot of the *other* ghost surfaces
        // audited by `scripts/cleanup-import-ghosts.ts`
        // (auto-discovered client_contacts + import_entity_suggestions
        // queue counts). Disable via system setting
        // `import_ghosts_snapshot_enabled`.
        trackTimer(setTimeout(startupTick("import-ghosts-snapshot-init", () =>
          import("../services/importGhostsSnapshot").then(({ startImportGhostsSnapshotScheduler }) =>
            startImportGhostsSnapshotScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.import_ghosts_snapshot + jitter()));
        // Task #1724 Phase 4.4 — nightly pg_stat_statements regression
        // scan. Spawns scripts/pg-stat-statements-regression.ts once
        // every 24h. Default ON; set
        // PG_STAT_STATEMENTS_REGRESSION_SCHEDULER_ENABLED=false to opt
        // out (e.g. when running the scan via external cron). The
        // spawned script no-ops gracefully when the extension or
        // baseline aren't set up yet, so default-ON is safe.
        trackTimer(setTimeout(startupTick("pg-stat-statements-regression-init", () =>
          import("../services/pgStatStatementsRegressionScheduler").then(
            ({ startPgStatStatementsRegressionScheduler }) =>
              startPgStatStatementsRegressionScheduler(),
          ),
        ), 60_000 + jitter()));
        // Task #2611 — nightly regression sweep. Self-gates to the dev
        // workspace (never the deployment) since the test suite runs against
        // the dev DB; the cron only fires overnight, never on boot.
        trackTimer(setTimeout(startupTick("regression-sweep-init", () =>
          import("../services/regressionSweepScheduler").then(
            ({ startRegressionSweepScheduler }) =>
              startRegressionSweepScheduler(),
          ),
        ), 65_000 + jitter()));
        // Task #4729 — weekly non-Latin spreadsheet typing check (Saturday
        // 04:30 ET: build + scripts/verify-sheet-nonlatin-e2e.ts) plus its
        // 6h staleness watchdog. Self-gates to the main dev workspace
        // (refuses deployments AND task/sub-environments, fail closed).
        trackTimer(setTimeout(startupTick("sheet-nonlatin-check-init", () =>
          import("../services/sheetNonlatinCheckScheduler").then(
            ({ startSheetNonlatinCheckScheduler }) =>
              startSheetNonlatinCheckScheduler(),
          ),
        ), 70_000 + jitter()));
        trackTimer(setTimeout(startupTick("rate-limit-alert-auto-retry-init", () =>
          import("../services/rateLimitAlertAutoRetry").then(({ startRateLimitAlertAutoRetryScheduler }) =>
            startRateLimitAlertAutoRetryScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.rate_limit_alert_auto_retry + jitter()));
        // Task #672 — background auto-retry for failed threshold-alert
        // (agent_match_setting_history) Slack/email deliveries.
        trackTimer(setTimeout(startupTick("match-settings-alert-auto-retry-init", () =>
          import("../services/matchSettingsAlertAutoRetry").then(({ startMatchSettingsAlertAutoRetryScheduler }) =>
            startMatchSettingsAlertAutoRetryScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.match_settings_alert_auto_retry + jitter()));
        // Task #998 — alert when a queue paused via the Queue Drain Control
        // card has been paused for too long AND its pending count has grown
        // past the configured threshold.
        trackTimer(setTimeout(startupTick("queue-drain-backlog-alerts-init", () =>
          import("../services/queueDrainBacklogAlerts").then(({ startQueueDrainBacklogAlertsScheduler }) =>
            startQueueDrainBacklogAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.queue_drain_backlog_alerts + jitter()));
        // Task #1676 — cross-queue lease churn + production pipeline
        // backlog watcher (Front normalize/apply, raw_communication
        // ratio inversion, SEMrush dead-letter spike, stale-lease /
        // startup-stale-recovery rate).
        trackTimer(setTimeout(startupTick("lease-churn-alerts-init", () =>
          import("../services/leaseChurnAlerts").then(({ startLeaseChurnAlertsScheduler }) =>
            startLeaseChurnAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.lease_churn_alerts + jitter()));
        // Task #1284 — alert when Twilio inbound-webhook retries cause a
        // spike of 23505 unique-SID collisions on `twilio_messages`.
        trackTimer(setTimeout(startupTick("twilio-webhook-collision-alerts-init", () =>
          import("../services/twilioWebhookCollisionAlerts").then(({ startTwilioWebhookCollisionAlertsScheduler }) =>
            startTwilioWebhookCollisionAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.twilio_webhook_collision_alerts + jitter()));
        // Task #1009 — proactive alert when a queue has 0 dispatches
        // for N consecutive ~60-cycle scheduler windows while still
        // having pending depth (and not paused via Queue Drain Control).
        trackTimer(setTimeout(startupTick("queue-starvation-alerts-init", () =>
          import("../services/queueStarvationAlerts").then(({ startQueueStarvationAlertsScheduler }) =>
            startQueueStarvationAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.queue_starvation_alerts + jitter()));
        // Task #1073 — alert when a /api/health sub-check has been
        // degraded longer than its per-key threshold (default 10m for
        // critical `db`/`tables`, 30m for soft warnings).
        trackTimer(setTimeout(startupTick("health-degraded-alerts-init", () =>
          import("../services/healthDegradedAlerts").then(({ startHealthDegradedAlertsScheduler }) =>
            startHealthDegradedAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.health_degraded_alerts + jitter()));
        // Task #1103 — alert when the cached booking schema readiness
        // snapshot flips ready=true → false (e.g. a deploy where
        // migrations 0034-0036 didn't run, the booking tables were
        // dropped, or the no-overlap / one-page-per-AM constraints
        // disappeared). A recovery message posts on the reverse
        // transition. Gated by the
        // `booking_schema_readiness_alert_enabled` system_settings kill
        // switch.
        trackTimer(setTimeout(startupTick("booking-schema-readiness-alerts-init", () =>
          import("../services/bookingSchemaReadinessAlerts").then(({ startBookingSchemaReadinessAlertsScheduler }) =>
            startBookingSchemaReadinessAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.booking_schema_readiness_alerts + jitter()));
        // Task #1224 — backlog/digest alerts for pending
        // `import_entity_suggestions`. Fires a Slack alert when the
        // total pending count crosses the configured threshold (with
        // per-cooldown spam control), and emits an optional daily/weekly
        // digest summarizing pending counts by client + surface.
        trackTimer(setTimeout(startupTick("import-suggestions-backlog-alerts-init", () =>
          import("../services/importSuggestionsBacklogAlerts").then(({ startImportSuggestionsBacklogAlertsScheduler }) =>
            startImportSuggestionsBacklogAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.import_suggestions_backlog_alerts + jitter()));
        // Task #1231 — alert when the audit count of clients with
        // invalid stored product values grows since the last snapshot
        // (passive push counterpart to the pull-only
        // `/api/admin/clients/invalid-products` panel).
        trackTimer(setTimeout(startupTick("invalid-products-growth-alerts-init", () =>
          import("../services/invalidProductsGrowthAlerts").then(({ startInvalidProductsGrowthAlertsScheduler }) =>
            startInvalidProductsGrowthAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.invalid_products_growth_alerts + jitter()));
        // Task #3694 — weekly Monday-morning digest of aging open asks /
        // unkept internal promises across active clients (Churn Command
        // Center "Promises & Asks" tab). Cross-instance singleton lock,
        // kill switch `kill_switch_open_asks_digest`, at-most-once per
        // week via a persisted week key; init also runs a Monday
        // catch-up pass for instances that weren't alive at 08:00 NY.
        trackTimer(setTimeout(startupTick("open-asks-digest-init", () =>
          import("../services/openAsksDigest").then(({ startOpenAsksDigestScheduler }) =>
            startOpenAsksDigestScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.open_asks_digest + jitter()));
        // Task #1282 — alert when Front Historical Recovery jobs end
        // with `fatal_error:` reasons at a rate above the configured
        // threshold. Proactive notification so we don't only notice
        // recovery crashes when a customer asks why their backfill
        // stopped.
        trackTimer(setTimeout(startupTick("front-historical-recovery-fatal-alerts-init", () =>
          import("../services/frontHistoricalRecoveryFatalAlerts").then(({ startFrontHistoricalRecoveryFatalAlertsScheduler }) =>
            startFrontHistoricalRecoveryFatalAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_historical_recovery_fatal_alerts + jitter()));
        // Task #1575 (Track E, F-03) — per-location SEMrush auto-retry
        // worker. Moved out of the synchronous main bootstrap so its
        // first 30s-interval tick is staggered + jittered relative to
        // the rest of the deferred scheduler cohort.
        trackTimer(setTimeout(startupTick("semrush-location-auto-retry-init", () =>
          import("../services/semrushLocationAutoRetryWorker").then(({ startSemrushLocationAutoRetryWorker }) =>
            startSemrushLocationAutoRetryWorker(),
          ),
        ), WORKER_STAGGER_OFFSETS.semrush_location_auto_retry + jitter()));
        // Task #1053 — alert when the Twilio call-recording archive
        // pipeline stalls (rows stuck in `pending` past the threshold,
        // or rows landing in `failed` after exhausting MAX_ATTEMPTS).
        trackTimer(setTimeout(startupTick("call-archive-backlog-alerts-init", () =>
          import("../services/callArchiveBacklogAlerts").then(({ startCallArchiveBacklogAlertsScheduler }) =>
            startCallArchiveBacklogAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.call_archive_backlog_alerts + jitter()));
        // Task #1098 — alert when call recordings stay stuck in
        // `archive_status='processing'` with their lease released past
        // the call_archive ceiling.
        trackTimer(setTimeout(startupTick("call-archive-stuck-processing-alerts-init", () =>
          import("../services/callArchiveStuckProcessingAlerts").then(({ startCallArchiveStuckProcessingAlertsScheduler }) =>
            startCallArchiveStuckProcessingAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.call_archive_stuck_processing_alerts + jitter()));
        // Workers/queues parity (E-F12) — alert when call-analysis jobs
        // stay stuck in `status='processing'` with their lease expired
        // past the call_analysis ceiling.
        trackTimer(setTimeout(startupTick("call-analysis-stuck-processing-alerts-init", () =>
          import("../services/callAnalysisStuckProcessingAlerts").then(({ startCallAnalysisStuckProcessingAlertsScheduler }) =>
            startCallAnalysisStuckProcessingAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.call_analysis_stuck_processing_alerts + jitter()));
        // Workers/queues parity (E-F15) — alert when Local Dominance sync
        // rows stay stuck in `in_progress` past the lane ceiling.
        trackTimer(setTimeout(startupTick("local-dominance-stuck-sync-alerts-init", () =>
          import("../services/localDominanceStuckSyncAlerts").then(({ startLocalDominanceStuckSyncAlertsScheduler }) =>
            startLocalDominanceStuckSyncAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.local_dominance_stuck_sync_alerts + jitter()));
        // Workers/queues parity (E-F15) — alert when Semrush auto-retry
        // rows sit overdue without being picked up by the ticker.
        trackTimer(setTimeout(startupTick("semrush-auto-retry-overdue-alerts-init", () =>
          import("../services/semrushAutoRetryOverdueAlerts").then(({ startSemrushAutoRetryOverdueAlertsScheduler }) =>
            startSemrushAutoRetryOverdueAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.semrush_auto_retry_overdue_alerts + jitter()));
        // Task #1602 — alert when no Front webhook event has landed in
        // `source_event_log` for longer than the configured threshold.
        // Catches upstream Front delivery stalls (the May-15→May-18
        // outage was invisible until a manual SQL inspection).
        // Task #3993 — staleness now keys on webhook-origin rows only
        // (`dedupe_key LIKE 'front:webhook:%'`) so reconcile-sweep rows
        // can't mask a dead receiver; a never-validated receiver emits a
        // distinct "polling carrying sync" alert instead of silence.
        trackTimer(setTimeout(startupTick("front-webhook-receiver-staleness-alerts-init", () =>
          import("../services/frontWebhookReceiverStalenessAlerts").then(({ startFrontWebhookReceiverStalenessAlertsScheduler }) =>
            startFrontWebhookReceiverStalenessAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_webhook_receiver_staleness_alerts + jitter()));
        // Task #1642 — alert when rows in `front_sync_emails` sit in
        // a non-terminal `pipeline_state` longer than the configured
        // age threshold. Catches the next silent apply-stage stall
        // (e.g. the May-18 17,805-row backlog) before it shows up as
        // a lagging coverage gap.
        trackTimer(setTimeout(startupTick("front-pipeline-stuck-alerts-init", () =>
          import("../services/frontPipelineStuckAlerts").then(({ startFrontPipelineStuckAlertsScheduler }) =>
            startFrontPipelineStuckAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_pipeline_stuck_alerts + jitter()));
        // Task #2663 — alert when the Replit Auth session-refresh breaker is
        // persistently tripped (a sustained-failure streak past threshold with
        // no successful refresh in between), i.e. an issuer-wide auth outage
        // rather than one operator who just needs to re-login.
        trackTimer(setTimeout(startupTick("replit-auth-breaker-stuck-alerts-init", () =>
          import("../services/replitAuthBreakerStuckAlerts").then(({ startReplitAuthBreakerStuckAlertsScheduler }) =>
            startReplitAuthBreakerStuckAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_pipeline_stuck_alerts + jitter()));
        // Task #2146 — alert when the `front_sync_emails` mirror stops
        // getting new rows (`MAX(created_at)` falls behind live Front
        // webhook intake) while webhooks are still arriving — i.e. the
        // mirror writer is disabled (`front_sync_emails_mirror_enabled`)
        // or broken. Turns the next silent mirror freeze (like the
        // 2026-04-14 weeks-long stall) into an immediate alert.
        trackTimer(setTimeout(startupTick("front-mirror-freshness-alerts-init", () =>
          import("../services/frontMirrorFreshnessAlerts").then(({ startFrontMirrorFreshnessAlertsScheduler }) =>
            startFrontMirrorFreshnessAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_mirror_freshness_alerts + jitter()));
        // Task #1610 — alert when the Slack auth circuit breaker (added
        // by Task #1602) has been persistently tripping. Pairs with a
        // one-time recovery alert; reads `getSlackAuthState()` only and
        // never touches breaker control flow.
        trackTimer(setTimeout(startupTick("slack-auth-breaker-stuck-alerts-init", () =>
          import("../services/slackAuthBreakerStuckAlerts").then(({ startSlackAuthBreakerStuckAlertsScheduler }) =>
            startSlackAuthBreakerStuckAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.slack_auth_breaker_stuck_alerts + jitter()));
        // Task #1689 — alert when the Front self-healing coverage loop
        // (Task #1682) has itself stopped running or keeps re-tripping
        // on its own `lastSelfError`. Lightweight, narrow counterpart
        // to the broader Task #1684 regression alerter with an
        // explicit stuck → recovered pair.
        trackTimer(setTimeout(startupTick("front-auto-closure-stalled-loop-alerts-init", () =>
          import("../services/frontAutoClosureStalledLoopAlerts").then(({ startFrontAutoClosureStalledLoopAlertsScheduler }) =>
            startFrontAutoClosureStalledLoopAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_auto_closure_stalled_loop_alerts + jitter()));
        // Task #1643 — Front Analytics all-time coverage refresh
        // scheduler. Low-priority observability worker that pulls
        // Front's Analytics Reports API as the authoritative monthly
        // message denominator (the only source-of-truth answer to
        // "how many emails does Front say existed?"). Strictly
        // measurement-only: never writes to `front_sync_emails` or
        // `raw_communication_records`. Gated by
        // `front_analytics_refresh_enabled`, the
        // `front_analytics_coverage_refresh` queue-drain pause, and
        // `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-analytics-coverage-refresh-init", () =>
          import("../services/frontAnalyticsCoverage").then(({ startFrontAnalyticsCoverageScheduler }) =>
            startFrontAnalyticsCoverageScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_analytics_coverage_refresh + jitter()));
        // Task #1825 — periodically enqueue `front_reconciliation` jobs
        // so the auto-heal sweep (pulls missed Front conversations off
        // the REST API) actually runs on a cadence. Nothing else
        // enqueues this queue; without this scheduler, a silent live
        // webhook outage (like May 18 → May 21) keeps growing until
        // someone notices.
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-reconciliation-scheduler-init", () =>
          import("../services/frontReconciliationScheduler").then(({ startFrontReconciliationScheduler }) =>
            startFrontReconciliationScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_reconciliation_enqueue + jitter()));
        // Front auto-closure tick scheduler — enqueues
        // `front_auto_closure_tick` jobs every ~60s so the self-heal
        // loop (`runFrontAutoClosureTick`) drives the warp knobs
        // (recovery budget / cooldown / retry budget / concurrency
        // cap) on its own cadence. Prior to this scheduler the tick
        // was only invoked as a side-effect of the
        // `front_analytics_coverage_refresh` handler, which the
        // Task #1787 cadence rewrite de-cadenced — so in prod the
        // tick queue had zero rows ever and the warp settings had
        // nothing reading them. Honors a dedicated kill switch
        // (`front_auto_closure_scheduler_enabled`),
        // `KILL_SWITCH_NON_CRITICAL_SWEEPS`, the
        // `front_auto_closure_tick` queue-drain pause, and a
        // Front-not-connected guard.
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-auto-closure-scheduler-init", () =>
          import("../services/frontAutoClosureScheduler").then(({ startFrontAutoClosureScheduler }) =>
            startFrontAutoClosureScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_auto_closure_enqueue + jitter()));
        // Task #1984 — periodically enqueue `front_outbound_gap_close`
        // jobs so months with a positive `messages_outbound_gap` are
        // driven back through the historical-recovery ingestion pipeline
        // (per-message materialization dedupes on external_source_id) so
        // the next coverage refresh shrinks the gap. Default OFF via
        // `front_outbound_gap_close_enabled`; the scheduler skips enqueue
        // entirely while disabled. The tick also honors the queue-drain
        // pause, `KILL_SWITCH_NON_CRITICAL_SWEEPS`, and surfaces a
        // hard-gap reason when per-message materialization is disabled.
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-outbound-gap-close-scheduler-init", () =>
          import("../services/frontOutboundGapCloser").then(({ startFrontOutboundGapCloseScheduler }) =>
            startFrontOutboundGapCloseScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_outbound_gap_close + jitter()));
        // Task #2010 — periodically enqueue `front_outbound_gap_backfill`
        // jobs so months with a positive `messages_outbound_gap` are
        // repaired at message grain: ONE enumeration-walk per conversation
        // (vs recovery's re-list + re-hydrate) writes only the missing
        // outbound rows, deduped on external_source_id. Default OFF via
        // `front_outbound_gap_backfill_enabled`; the scheduler skips
        // enqueue entirely while disabled and the tick honors the
        // queue-drain pause + `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-outbound-gap-backfill-scheduler-init", () =>
          import("../services/frontOutboundGapBackfill").then(({ startFrontOutboundGapBackfillScheduler }) =>
            startFrontOutboundGapBackfillScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_outbound_gap_backfill + jitter()));
        // Task #2365 — periodically enqueue `front_message_grain_upgrade`
        // jobs so finalized coverage months still below `messages_all`
        // denominator grain are re-probed via the search fallback,
        // advancing the per-message enumeration walk until each row flips
        // to message grain — automating the manual
        // `reach_front_coverage_full_message_grain` prod-action. Default
        // OFF via `front_message_grain_upgrade_enabled`; the scheduler
        // skips enqueue entirely while disabled and the tick honors the
        // queue-drain pause + `KILL_SWITCH_NON_CRITICAL_SWEEPS` and the
        // per-message-enumeration hard gate.
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-message-grain-upgrade-scheduler-init", () =>
          import("../services/frontMessageGrainUpgrader").then(({ startFrontMessageGrainUpgradeScheduler }) =>
            startFrontMessageGrainUpgradeScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_message_grain_upgrade + jitter()));
        // Task #2529 — periodically enqueue `front_finish_message_grain`
        // jobs so every in-scope Front coverage month is driven to a real
        // `messages_all` denominator on a cadence (via the shared
        // `applyFinishFrontMessageGrainCoverage` apply path the operator
        // presses) WITHOUT requiring the global self-heal master switch.
        // Mirrors the Task #2365 upgrade driver. Default OFF via
        // `front_finish_message_grain_enabled`; the scheduler skips enqueue
        // entirely while disabled, and a tick honors the queue-drain pause,
        // `KILL_SWITCH_NON_CRITICAL_SWEEPS`, and the Front auth breaker
        // (reports `blocked`, never a failed run).
        if (runFrontWorkers) trackTimer(setTimeout(startupTick("front-finish-message-grain-scheduler-init", () =>
          import("../services/frontFinishMessageGrainDriver").then(({ startFrontFinishMessageGrainScheduler }) =>
            startFrontFinishMessageGrainScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.front_finish_message_grain + jitter()));
        // Task #2029 — periodically enqueue `restored_email_cleanup`
        // jobs so active users left on a `<original>.restored.<ts>`
        // fallback email (Task #1910 suffix-fallback restore) are
        // auto-repaired back to their original address once it is free,
        // writing a system-attributed `user_email_updated` audit entry.
        // Accounts whose original still collides are left for manual
        // cleanup. Default OFF via `restored_email_cleanup_enabled`; the
        // scheduler skips enqueue entirely while disabled. The tick also
        // honors the queue-drain pause and KILL_SWITCH_NON_CRITICAL_SWEEPS.
        trackTimer(setTimeout(startupTick("restored-email-cleanup-scheduler-init", () =>
          import("../services/restoredEmailCleanup").then(({ startRestoredEmailCleanupScheduler }) =>
            startRestoredEmailCleanupScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.restored_email_cleanup + jitter()));
        // Task #2066 — periodically enqueue `feedback_slack_retry` jobs
        // so feedback rows whose Slack relay failed (slack_status <>
        // 'delivered') are automatically re-sent once Slack reconnects,
        // updating each row's status + reason in place via the shared
        // relay. Default OFF via `feedback_slack_retry_enabled`; the
        // scheduler skips enqueue entirely while disabled. The tick also
        // honors the queue-drain pause, KILL_SWITCH_NON_CRITICAL_SWEEPS,
        // and a live Slack connectivity probe.
        trackTimer(setTimeout(startupTick("feedback-slack-retry-scheduler-init", () =>
          import("../services/feedbackSlackRetry").then(({ startFeedbackSlackRetryScheduler }) =>
            startFeedbackSlackRetryScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.feedback_slack_retry + jitter()));
        // Task #2086 — periodically enqueue `prod_action_self_heal` jobs
        // so the idempotent, recurring maintenance prod-actions that opt
        // in via `ProdAction.selfHeal` (cancel stale Front backlog, dedupe
        // unread notifications, mark legacy front_email pending terminal,
        // drain the 122k Front backlog, backfill competitor location
        // labels) are applied automatically on each action's own
        // cadence/backoff — so the CEO no longer re-applies them by hand.
        // Default OFF via `prod_action_self_heal_enabled`; the scheduler
        // skips enqueue entirely while disabled. The tick also honors the
        // queue-drain pause and KILL_SWITCH_NON_CRITICAL_SWEEPS.
        trackTimer(setTimeout(startupTick("prod-action-self-heal-scheduler-init", () =>
          import("../services/prodActionSelfHeal").then(({ startProdActionSelfHealScheduler }) =>
            startProdActionSelfHealScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.prod_action_self_heal + jitter()));
        // Task #2203 — periodically enqueue `orphaned_user_heal` jobs so
        // a logged-in user admitted with no `users` row (first-login
        // fail-open per Task #2078 that the Task #2129 request-time
        // reconcile never closed because the user made no further
        // request) is healed by a background sweep instead of depending
        // on user traffic. The tick scans live sessions for a `sub` with
        // no `users` row and re-upserts the profile from the session
        // claims. Default OFF via `orphaned_user_heal_enabled`; the
        // scheduler skips enqueue entirely while disabled. The tick also
        // honors the queue-drain pause and KILL_SWITCH_NON_CRITICAL_SWEEPS.
        trackTimer(setTimeout(startupTick("orphaned-user-heal-scheduler-init", () =>
          import("../services/orphanedUserHeal").then(({ startOrphanedUserHealScheduler }) =>
            startOrphanedUserHealScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.orphaned_user_heal + jitter()));
        // Task #2414 — periodically enqueue `feedback_video_resume` jobs so
        // a feedback video left `processing` by a server restart (its
        // in-memory TwelveLabs indexing job in videoAnalysis.ts orphaned)
        // is re-driven through the shared processor to completion, and a
        // permanently-stuck row is eventually marked terminal instead of
        // re-driving forever. Default OFF via `feedback_video_resume_enabled`;
        // the scheduler skips enqueue entirely while disabled. The tick also
        // honors the queue-drain pause and KILL_SWITCH_NON_CRITICAL_SWEEPS.
        trackTimer(setTimeout(startupTick("feedback-video-resume-scheduler-init", () =>
          import("../services/feedbackVideoResume").then(({ startFeedbackVideoResumeScheduler }) =>
            startFeedbackVideoResumeScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.feedback_video_resume + jitter()));
        // Task #2938 — periodically enqueue `sheets_data_block_refresh`
        // jobs so workbook data blocks with `autoRefresh=true` are
        // re-pulled from live NoBull connectors once per day. Default OFF
        // via `sheets_auto_refresh_enabled`; the producer skips enqueue
        // entirely while disabled. Each job uses a dedupe key so repeated
        // ticks within the same day collapse to a single job.
        trackTimer(setTimeout(startupTick("sheets-auto-refresh-producer-init", () =>
          import("../services/sheetsDataRefresh").then(({ startSheetsAutoRefreshProducer }) =>
            startSheetsAutoRefreshProducer(),
          ),
        ), WORKER_STAGGER_OFFSETS.sheets_auto_refresh + jitter()));
        // Task #1076 — alert when failed call_analysis_jobs spike for a
        // single failure_reason (absolute count or 3x baseline).
        trackTimer(setTimeout(startupTick("call-analysis-failure-spike-alerts-init", () =>
          import("../services/callAnalysisFailureSpikeAlerts").then(({ startCallAnalysisFailureSpikeAlertsScheduler }) =>
            startCallAnalysisFailureSpikeAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.call_analysis_failure_spike_alerts + jitter()));
        // Task #711 — daily/weekly Slack digest summarizing recent
        // reserve-pressure spikes (counts per metric × severity).
        trackTimer(setTimeout(startupTick("manual-reserve-digest-init", () =>
          import("../services/manualReserveDigest").then(({ startManualReserveDigestScheduler }) =>
            startManualReserveDigestScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.manual_reserve_digest + jitter()));
        // Task #3963 (audit B-012) — bounded fallback sweeper reconciling
        // ATS Rev.ai transcriptions whose completion callback never arrived
        // (deploy downtime, exhausted vendor retries, or no callback secret
        // configured). Singleton-locked, worker pool, gated on the
        // `ats_revai_transcription` kill switch inside the sweep.
        trackTimer(setTimeout(startupTick("ats-transcription-sweep-init", () =>
          import("../services/atsTranscriptionSweep").then(({ startAtsTranscriptionSweepScheduler }) =>
            startAtsTranscriptionSweepScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.ats_transcription_sweep + jitter()));

        // Task #4832 — alert the team when Ads OS criteria docs that were
        // seeded by the schedule-sync prod action (Task #4827) still have no
        // operator-authored content (business_name / service_area) after 7
        // days. Low-urgency hygiene alert; fires at most once per UTC
        // calendar day while overdue docs remain.
        trackTimer(setTimeout(startupTick("ads-os-seeded-criteria-incompleteness-alerts-init", () =>
          import("../services/adsOs/seededCriteriaIncompletenessAlerts").then(({ startAdsOsSeededCriteriaIncompletenessAlertsScheduler }) =>
            startAdsOsSeededCriteriaIncompletenessAlertsScheduler(),
          ),
        ), WORKER_STAGGER_OFFSETS.ads_os_seeded_criteria_incompleteness_alerts + jitter()));
        // Task #974 — after samplers and rollups have warmed up, attempt a
        // single auto-snapshot of the post-deploy verification baseline so
        // operators don't have to remember to click "Save as baseline" after
        // every clean deploy. Skipped when the admin toggle is off, and only
        // saves when overall status is "pass". Uses the service-owned
        // scheduler helper so the delay/shutdown wiring lives in one place.
        const { scheduleAutoBaselineSnapshot, AUTO_BASELINE_BOOT_DELAY_MS } =
          await import("../services/postDeployVerification");
        trackTimer(
          scheduleAutoBaselineSnapshot({
            delayMs: AUTO_BASELINE_BOOT_DELAY_MS + jitter(),
            isShutdown: () => isGracefulShutdown,
          }),
        );

        // Task #973 — fire the post-deploy verification report to Slack
        // shortly after the auto-baseline attempt so the team's normal
        // channels get a pass/warn/fail summary without anyone opening
        // /admin/health. Routed through the unified notifyByType
        // dispatcher; FAIL goes to a separate paging notification id.
        const {
          schedulePostDeployVerificationDigest,
          POST_DEPLOY_DIGEST_BOOT_DELAY_MS,
        } = await import("../services/postDeployVerificationDigest");
        trackTimer(
          schedulePostDeployVerificationDigest({
            delayMs: POST_DEPLOY_DIGEST_BOOT_DELAY_MS + jitter(),
            isShutdown: () => isGracefulShutdown,
          }),
        );
      })().catch((err) => console.error("[Bootstrap] Scheduler init failed:", err));
}
