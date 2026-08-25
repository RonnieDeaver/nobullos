import { registerHandler, isHandlerRegistered } from "./workScheduler";
import { handleUserSlackDmJob, USER_SLACK_DM_QUEUE } from "./notifications/userSlackSender";
import { registerGoogleAdsSyncHandler } from "./googleAdsSync";
import { registerRepairHandler, enqueueRepairJob } from "./repairDispatcher";
import type { WorkQueueJob } from "@shared/schema";
import {
  HEATMAP_COVERAGE_CHECK_QUEUE,
  handleHeatmapCoverageCheckJob,
} from "./heatmapCoverageCheck";
import {
  handleEventLogReplay,
  handleVendorReconciliation,
  handleRulesetBackfill,
} from "./replayFramework";
import { PERF } from "../perfConfig";
import { isKillSwitchEnabled } from "./killSwitches";
import { backoffForApiPoolPressure } from "./workloadManager";
import { workerLog } from "./workerLogger";
import {
  handleClickUpHierarchyBackfill,
  handleClickUpTaskApply,
  handleClickUpSubtreeRefresh,
  handleClickUpReconciliationSweep,
  handleClickUpWebhookHealthCheck,
  handleClickUpWebhookRepair,
  handleSdOverdueSweep,
  handleSdDeliveredAutoclose,
} from "./clickUpWorkerHandlers";
import { handleSheetsDataBlockRefresh } from "./sheetsDataRefresh";
import { handleOutboundEmailSend } from "./outboundEmail";
import {
  BOOK_PAID_DELIVERY_QUEUE,
  handleBookPaidDelivery,
  scheduleBookDeliveryBootCatchup,
} from "./bookDelivery";
import { EMAIL_SEQUENCE_QUEUE, handleEmailSequenceStepJob } from "./emailSequences";
import { registerZoomFaceSentimentHandlers } from "./zoomFaceSentiment";
import { registerZoomMatchAssistantHandlers } from "./zoomTranscriptMatchAssistant";
import { handleTagSegmentReconcile } from "./tagSegmentWorkerHandlers";
import {
  DEAL_STAGE_AUTOMATION_QUEUE,
  handleDealStageAutomation,
  scheduleDealAutomationBootCatchup,
} from "./dealAutomationQueue";
import {
  handleGhlOutboundSyncJob,
  scheduleGhlOutboundSyncBootCatchup,
} from "./ghlOutboundSync";
import { GHL_OUTBOUND_SYNC_QUEUE } from "./ghlOutboundKick";
import {
  handleClickUpRoleProjectionJob,
  scheduleClickUpRoleProjectionBootCatchup,
} from "./clickUpRoleProjection";
import { CLICKUP_ROLE_PROJECTION_QUEUE } from "./clickUpRoleProjectionKick";

const CHUNK_SIZE = 500;
const BACKFILL_BATCH_SIZE = 20;

// Task #836 Phase 2: helper to short-circuit a handler when the
// matching kill switch is set. The handler returns a `kill_switch`
// cursor so the operator can confirm in logs that the abort happened
// at a safe boundary (between batches / between jobs).
function killSwitchAbort(worker: string, switchName: string): { cursor: string } {
  workerLog({ worker, event: "kill_switch_abort", workloadClass: switchName, killSwitch: switchName });
  return { cursor: `kill_switch:${switchName}:aborted` };
}

interface JobPayload {
  maxItems?: number;
  clientId?: string;
  channelType?: string;
  cohort?: string;
  offset?: number;
  recordIds?: string[];
  [key: string]: unknown;
}

function parsePayload(job: WorkQueueJob): JobPayload {
  if (job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)) {
    return job.payload as JobPayload;
  }
  return {};
}

/**
 * Queue names whose handlers MUST be registered for the Front webhook
 * pipeline to drain. If any of these is missing after
 * `registerAllHandlers()` returns, work-queue rows for that queue land
 * in "No handler registered" and silently accumulate — exactly the
 * symptom we'd see in a Front intake stall caused by a code-side
 * regression. Asserted at startup so the regression is loud.
 */
const FRONT_WEBHOOK_REQUIRED_QUEUES = [
  "front_webhook_normalize",
  "front_webhook_apply",
] as const;

export function registerAllHandlers(): void {
  registerHandler("analyze_communication", handleAnalyzeCommunication);
  registerHandler("zoom_transcript_backfill", handleZoomTranscriptBackfill);
  registerHandler("zoom_revai_transcription", handleZoomRevAiTranscription);
  registerHandler("zoom_meeting_apply", handleZoomMeetingApplyJob);
  registerHandler("zoom_transcript_apply", handleZoomTranscriptApplyJob);
  // Task #3702 — opt-in client face-sentiment analysis of Zoom videos
  // (sweep producer + per-record analyzer, both on `maintenance`).
  registerZoomFaceSentimentHandlers();
  registerZoomMatchAssistantHandlers();
  registerHandler("front_rematch_all", handleFrontRematchAll);
  registerHandler("front_sync_reprocess", handleFrontSyncReprocess);
  registerHandler("front_webhook_normalize", handleFrontWebhookNormalize);
  registerHandler("front_webhook_apply", handleFrontWebhookApply);
  registerHandler("front_reconciliation", handleFrontReconciliation);
  registerHandler("front_full_backfill", handleFrontFullBackfill);
  registerHandler("front_historical_backfill", handleFrontHistoricalBackfill);
  registerHandler("front_bulk_action", handleFrontBulkActionJob);
  registerHandler("front_filter_rule_apply", handleFrontFilterRuleApplyJobWrapper);
  registerHandler("front_analytics_coverage_refresh", handleFrontAnalyticsCoverageRefresh);
  registerHandler("front_auto_closure_tick", handleFrontAutoClosureTick);
  registerHandler("front_outbound_gap_close", handleFrontOutboundGapClose);
  registerHandler("front_outbound_gap_backfill", handleFrontOutboundGapBackfill);
  registerHandler("front_message_grain_upgrade", handleFrontMessageGrainUpgrade);
  registerHandler("front_finish_message_grain", handleFrontFinishMessageGrain);
  // Task #2824 — restore the `retroactive_reprocess` handler. The original
  // handler delegated to the agent matching engine, which Task #2637 removed
  // (deterministic + manual matching only) without unregistering the queue's
  // producers (periodic per-client sweep, contact add/update, memory reset).
  // Every enqueued job then failed "No handler registered" and the startup
  // required-handlers assert fired on every boot. The deterministic
  // replacement re-evaluates ONLY the unmatched rows whose participants carry
  // one of the client's trusted identifiers (Task #2512 machinery).
  registerHandler("retroactive_reprocess", handleRetroactiveReprocess);
  registerHandler("restored_email_cleanup", handleRestoredEmailCleanup);
  registerHandler("feedback_slack_retry", handleFeedbackSlackRetry);
  registerHandler("feedback_video_resume", handleFeedbackVideoResume);
  registerHandler("prod_action_self_heal", handleProdActionSelfHeal);
  registerHandler("orphaned_user_heal", handleOrphanedUserHeal);

  // Task #2927 — ClickUp hierarchy backfill + per-task webhook apply.
  registerHandler("clickup_hierarchy_backfill", handleClickUpHierarchyBackfill);
  registerHandler("clickup_task_apply", handleClickUpTaskApply);
  // Task #2977 — targeted sub-tree refresh after create-from-template.
  registerHandler("clickup_subtree_refresh", handleClickUpSubtreeRefresh);
  // Task #4329 — tags & segments reconciliation sweep (rule tags +
  // segment membership converge to their criteria; orphan reap).
  registerHandler("tag_segment_reconcile", handleTagSegmentReconcile);
  // Task #4333 — deal & lead score recompute sweep (fit + engagement
  // convergence; orphan reap). Sole producer: scoringScheduler nightly
  // tick (manual recompute runs synchronously in the route instead).
  registerHandler("score_recompute", (job) =>
    import("./scoringWorkerHandlers").then(({ handleScoreRecompute }) =>
      handleScoreRecompute(job),
    ),
  );
  // Task #4331 — deal stage automation: consumes the deal_stage_events
  // rows emitted in-transaction by dealsStorage.createDeal/moveDealStage.
  // Boot catch-up re-enqueues pending events whose post-commit kick was
  // lost (deployment-gated one-shot, ~30s after boot).
  registerHandler(DEAL_STAGE_AUTOMATION_QUEUE, handleDealStageAutomation);
  scheduleDealAutomationBootCatchup();
  // Task #2984 — periodic reconciliation sweep + webhook health + repair.
  registerHandler("clickup_reconciliation_sweep", handleClickUpReconciliationSweep);
  registerHandler("clickup_webhook_health_check", handleClickUpWebhookHealthCheck);
  registerHandler("clickup_webhook_repair", handleClickUpWebhookRepair);

  // Task #3059 — Service Desk overdue sweep + delivered auto-close.
  registerHandler("sd_overdue_sweep", handleSdOverdueSweep);
  registerHandler("sd_delivered_autoclose", handleSdDeliveredAutoclose);

  // Task #4334 — outbound client-facing email: per-recipient send jobs
  // (mailbox-first routing via the sender's Front channel; SendGrid only
  // as the owner-gated overflow fallback). Producer lives in
  // services/outboundEmail.ts (composeOutboundEmails + self-reschedules).
  registerHandler("outbound_email_send", handleOutboundEmailSend);
  // Paid-book delivery is independently recoverable from Stripe/GHL and
  // composes through the outbound-email queue using deterministic batches.
  registerHandler(BOOK_PAID_DELIVERY_QUEUE, handleBookPaidDelivery);
  scheduleBookDeliveryBootCatchup();

  // Task #4335 — email sequence step advancement (delay-based, drafts by
  // default into the approval queue; auto-send only when the sequence
  // owner enabled it AND the merge is complete). Producers: enrollment +
  // approve/reject advancement + pause defers (services/emailSequences.ts).
  registerHandler(EMAIL_SEQUENCE_QUEUE, handleEmailSequenceStepJob);

  // Comms scheduled-message delivery — handler claims a single due
  // comms_scheduled_messages row, sends it as a real comms message, and
  // notifies the author on failure. Jobs are enqueued by the 60 s producer
  // tick (commsScheduledDelivery.ts / startCommsScheduledDeliveryScheduler).
  registerHandler("comms_scheduled_delivery", (job) =>
    import("./commsScheduledDelivery").then(({ handleCommsScheduledDelivery }) =>
      handleCommsScheduledDelivery(job),
    ),
  );

  // Comms message reminders — drain job claims due comms_message_reminders
  // rows and notifies each user via notifyUser (category `system`) with a
  // permalink. Jobs are enqueued by the 60 s producer tick
  // (commsReminderDeliver.ts / startCommsReminderScheduler).
  registerHandler("comms_reminder_deliver", (job) =>
    import("./commsReminderDeliver").then(({ handleCommsReminderDeliver }) =>
      handleCommsReminderDeliver(job),
    ),
  );

  // Task #2938 — Sheets Insert Data: refresh a live-data block region
  // within a workbook snapshot (report metrics / Google Ads / Front /
  // SEMrush). Enqueued manually on block creation and by the daily
  // auto-refresh producer (gated by `sheets_auto_refresh_enabled`).
  registerHandler("sheets_data_block_refresh", handleSheetsDataBlockRefresh);

  // Task #1759 — daily Google Ads sync. Scheduler in
  // `googleAdsSync.startGoogleAdsSyncScheduler()` enqueues a
  // dedupe-keyed `google_ads_sync` job on a 6h cadence; this handler
  // walks every enabled customer and pulls campaign + keyword stats.
  registerGoogleAdsSyncHandler();

  // Task #1687 — per-user Slack DM forwarding. The handler retries
  // transient Slack failures via the normal work-queue backoff and
  // dead-letters terminal codes (`user_not_found`, `channel_not_found`,
  // terminal-auth) without burning the retry budget.
  registerHandler(USER_SLACK_DM_QUEUE, handleUserSlackDmJob);

  registerHandler("communication_apply", handleApplyJob);
  registerHandler("meeting_apply", handleApplyJob);
  registerHandler("transcript_apply", handleApplyJob);
  registerHandler("local_report_apply", handleApplyJob);
  registerHandler("match_state_apply", handleApplyJob);
  registerHandler("inventory_sync_apply", handleApplyJob);
  registerHandler("semrush_heatmap_apply", handleApplyJob);

  // Task #1602 — verify the Front webhook pipeline handlers are
  // actually registered. If a future refactor accidentally removes one
  // of these `registerHandler(...)` lines, every Front webhook event
  // would be enqueued and then fail with "No handler registered" — the
  // exact silent-stall symptom we're trying to make impossible.
  const missingFrontHandlers = FRONT_WEBHOOK_REQUIRED_QUEUES.filter(
    (q) => !isHandlerRegistered(q),
  );
  if (missingFrontHandlers.length > 0) {
    throw new Error(
      `[workQueueHandlers] Front webhook pipeline missing handler(s): ${missingFrontHandlers.join(", ")}`,
    );
  }
  console.log(
    `[workQueueHandlers] Front webhook handlers registered: ${FRONT_WEBHOOK_REQUIRED_QUEUES.join(", ")}`,
  );

  // Task #978 Phase 1: register the SEMrush report-refresh handler
  // synchronously alongside every other queue. Previously this lived in
  // a deferred startup tick (semrush-inventory-sync-init) which fired
  // *after* the scheduler began polling, so any pending
  // `semrush_report_refresh` rows in the queue were claimed and failed
  // with "No handler registered". The feature-flag gate is preserved
  // inside the handler closure: when SEMRUSH_REPORT_REFRESH_ENABLED is
  // false we skip the work safely with an intentional message rather
  // than looking like a missing-handler bug.
  registerHandler("semrush_report_refresh", handleSemrushReportRefresh);
  registerRepairHandler("semrush_report_refresh", handleSemrushReportRefresh);

  // Task #978 Phase 2: SEMrush campaign-cache background refresh as a
  // proper work-queue job (was a setInterval that ran on the API pool
  // and dominated 24h pool hold time). Routing through the worker
  // scheduler gives it kill-switch support, dedupe, retry, pool-pressure
  // backoff, and fair scheduling alongside other workers.
  registerHandler("semrush_background_refresh", handleSemrushBackgroundRefresh);
  registerRepairHandler("semrush_background_refresh", handleSemrushBackgroundRefresh);

  registerRepairHandler("front_rematch_all", handleFrontRematchAll);
  registerRepairHandler("front_sync_reprocess", handleFrontSyncReprocess);
  registerRepairHandler("analyze_communication", handleAnalyzeCommunication);
  registerRepairHandler("zoom_transcript_backfill", handleZoomTranscriptBackfill);
  registerRepairHandler("zoom_revai_transcription", handleZoomRevAiTranscription);
  registerRepairHandler("zoom_meeting_apply", handleZoomMeetingApplyJob);
  registerRepairHandler("zoom_transcript_apply", handleZoomTranscriptApplyJob);
  registerRepairHandler("front_webhook_normalize", handleFrontWebhookNormalize);
  registerRepairHandler("front_webhook_apply", handleFrontWebhookApply);
  registerRepairHandler("front_reconciliation", handleFrontReconciliation);
  registerRepairHandler("front_full_backfill", handleFrontFullBackfill);
  registerRepairHandler("front_historical_backfill", handleFrontHistoricalBackfill);
  registerRepairHandler("front_bulk_action", handleFrontBulkActionJob);
  registerRepairHandler("front_filter_rule_apply", handleFrontFilterRuleApplyJobWrapper);
  // Task #2824 — `retroactive_reprocess` runs on the repair workload class
  // (see workloadManager.ts) and is drained by the repair dispatcher's
  // per-cycle drain-extra pass, so it needs the repair-side registration too.
  registerRepairHandler("retroactive_reprocess", handleRetroactiveReprocess);

  registerRepairHandler("communication_apply", handleApplyJob);
  registerRepairHandler("meeting_apply", handleApplyJob);
  registerRepairHandler("transcript_apply", handleApplyJob);
  registerRepairHandler("local_report_apply", handleApplyJob);
  registerRepairHandler("match_state_apply", handleApplyJob);
  registerRepairHandler("inventory_sync_apply", handleApplyJob);
  registerRepairHandler("semrush_heatmap_apply", handleApplyJob);

  // Task #651: post-backfill heatmap coverage check. Runs on the
  // maintenance class so it can wait for the SEMrush refresh queue to
  // drain without preempting interactive/ingestion work.
  registerHandler(HEATMAP_COVERAGE_CHECK_QUEUE, handleHeatmapCoverageCheckJob);
  registerRepairHandler(HEATMAP_COVERAGE_CHECK_QUEUE, handleHeatmapCoverageCheckJob);

  registerHandler("replay_event_log", handleEventLogReplay);
  registerHandler("replay_vendor_reconciliation", handleVendorReconciliation);
  registerHandler("replay_ruleset_backfill", handleRulesetBackfill);

  registerRepairHandler("replay_event_log", handleEventLogReplay);
  registerRepairHandler("replay_vendor_reconciliation", handleVendorReconciliation);
  registerRepairHandler("replay_ruleset_backfill", handleRulesetBackfill);

  // Task #5105 — GHL outbound buyer lifecycle sync.
  // Drains book_outbox entries for GHL-relevant event types. Disabled by
  // default via the kill_switch_ghl_outbound_sync + the ghlBuyerSyncConfig
  // enabled gate. Boot catch-up re-enqueues stuck pending entries (deployment
  // only; ~30 s delay, one-shot, bounded page).
  registerHandler(GHL_OUTBOUND_SYNC_QUEUE, handleGhlOutboundSyncJob);
  scheduleGhlOutboundSyncBootCatchup();

  // Post-registration assert: if the GHL outbound sync handler is missing after
  // this function returns, the outbox will silently accumulate un-drained rows.
  if (!isHandlerRegistered(GHL_OUTBOUND_SYNC_QUEUE)) {
    throw new Error(
      `[workQueueHandlers] GHL outbound sync handler not registered for queue: ${GHL_OUTBOUND_SYNC_QUEUE}`,
    );
  }

  // Task #5156 — ClickUp role projection lane.
  // Drains cu_role_projection_commands for configured roles. Disabled when
  // CLICKUP_ROLE_PROJECTION_ENVIRONMENT is unset or kill switch is on.
  // Boot catch-up re-enqueues stuck pending commands (deployment only; ~30s delay).
  registerHandler(CLICKUP_ROLE_PROJECTION_QUEUE, handleClickUpRoleProjectionJob);
  scheduleClickUpRoleProjectionBootCatchup();

  // Post-registration assert: missing handler = commands silently accumulate.
  if (!isHandlerRegistered(CLICKUP_ROLE_PROJECTION_QUEUE)) {
    throw new Error(
      `[workQueueHandlers] ClickUp role projection handler not registered for queue: ${CLICKUP_ROLE_PROJECTION_QUEUE}`,
    );
  }
}

async function handleAnalyzeCommunication(job: WorkQueueJob): Promise<void> {
  const payload = parsePayload(job);
  const recordId = payload.recordId as string;
  if (!recordId) {
    console.error("[AnalyzeCommunication] No recordId in job payload");
    return;
  }
  const { analyzeCommunication } = await import("./communicationAnalysis");
  // Task #818 Phase 0: tag every DB checkout under this handler with a
  // stable label so any "long client hold" warnings surfaced by the pool
  // wrapper are attributable to the originating ingestion path.
  const { withDbHoldLabel } = await import("../db");
  await withDbHoldLabel("analyze_communication", () => analyzeCommunication(recordId));
}

async function handleFrontRematchAll(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { enumerateSyncEmailIds } = await import("./frontIntegration");
  const { frontSyncMatchStatuses } = await import("@shared/models/communications");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  const payload = parsePayload(job);
  const requestedMax = payload.maxItems ?? 50000;
  const producerVersion = payload.producerVersion as number | undefined;
  const cumulativeOffset = (payload.cumulativeOffset as number) ?? 0;

  const syncEmailIds = payload.syncEmailIds as string[] | undefined;
  if (syncEmailIds && syncEmailIds.length > 0) {
    const { rematchSyncEmailBatch } = await import("./frontIntegration");
    // Task #818 Phase 0: tag the per-batch rematch path; the enumeration
    // tail below is tagged separately so we can tell scan from work.
    const result = await withDbHoldLabel("front_rematch_all:batch", () =>
      runWithWorkerDb(() => rematchSyncEmailBatch(syncEmailIds)),
    );
    return {
      cursor: `batch:${syncEmailIds.length},matched:${result.newlyMatched},reassigned:${result.reassigned},v:${producerVersion ?? "none"}`,
    };
  }

  let cursorState: { createdAt: Date; id: string } | undefined;
  const cursorJson = payload.cursorState as { createdAt: string; id: string } | undefined;
  if (cursorJson?.createdAt && cursorJson?.id) {
    cursorState = { createdAt: new Date(cursorJson.createdAt), id: cursorJson.id };
  }

  const enumLimit = Math.min(CHUNK_SIZE, requestedMax);
  const enumResult = await withDbHoldLabel("front_rematch_all:enumerate", () =>
    runWithWorkerDb(() =>
      enumerateSyncEmailIds({
        matchStatuses: [...frontSyncMatchStatuses],
        limit: enumLimit,
        afterCursor: cursorState,
      }),
    ),
  );

  if (enumResult.ids.length === 0) {
    return { cursor: `complete:cumulative:${cumulativeOffset},v:${producerVersion ?? "none"}` };
  }

  for (let i = 0; i < enumResult.ids.length; i += BACKFILL_BATCH_SIZE) {
    const batchIds = enumResult.ids.slice(i, i + BACKFILL_BATCH_SIZE);
    const batchIndex = Math.floor((cumulativeOffset + i) / BACKFILL_BATCH_SIZE);
    await enqueueRepairJob({
      queueName: "front_rematch_all",
      workloadClass: "repair",
      priority: (job.priority ?? 50) + 1,
      payload: {
        syncEmailIds: batchIds,
        producerVersion,
      },
      maxAttempts: job.maxAttempts ?? 2,
      dedupeKey: producerVersion
        ? `rematch_batch:v${producerVersion}:b${batchIndex}`
        : undefined,
    });
  }

  const nextOffset = cumulativeOffset + enumResult.ids.length;
  const remaining = requestedMax - enumResult.ids.length;

  if (enumResult.ids.length >= CHUNK_SIZE && remaining > 0 && enumResult.nextCursor) {
    await enqueueRepairJob({
      queueName: "front_rematch_all",
      workloadClass: "repair",
      priority: job.priority,
      payload: {
        ...payload,
        maxItems: remaining,
        cumulativeOffset: nextOffset,
        cursorState: {
          createdAt: enumResult.nextCursor.createdAt.toISOString(),
          id: enumResult.nextCursor.id,
        },
      },
      maxAttempts: job.maxAttempts,
      dedupeKey: producerVersion
        ? `continuation:front_rematch_all:v${producerVersion}:offset${nextOffset}`
        : undefined,
    });
  }

  return { cursor: `enumerated:${enumResult.ids.length},cumulative:${nextOffset},v:${producerVersion ?? "none"}` };
}

/**
 * Task #2824 — `retroactive_reprocess` handler for the deterministic-only
 * matching world.
 *
 * History: the pre-#2637 handler called the agent matching engine's
 * `retroactiveReprocess(clientId)`. Task #2637 deleted that engine but left
 * the queue's producers live (`enqueueRetroactiveReprocessSafe` callers:
 * the periodic per-client sweep in frontIntegration, contact add/update in
 * routes/agents, and the memory-reset workflow), so ~50k jobs/week failed
 * with "No handler registered" in production and the startup
 * required-handlers assert fired on every boot.
 *
 * The deterministic replacement: gather the client's trusted identifiers
 * (exact contact emails + trusted domains — the same rules
 * `buildHardMatchIndexes` uses, so we only scan for identifiers the hard
 * matcher could actually win on) and run the participant-scoped Task #2512
 * re-eval `reEvaluateUnmatchedForTargets`. That issues real
 * participant-scoped queries — NOT the test-only `restrictToIds` shortcut
 * on the whole-corpus sweeps, which `lint-front-rematch-restrict-to-ids`
 * forbids in production. Idempotent: rows that don't hard-match are left
 * untouched apart from a refreshed unmatched-reason, so periodic-sweep
 * re-runs for the same client are safe.
 */
async function handleRetroactiveReprocess(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  if (isKillSwitchEnabled("retroactive_reprocess")) {
    return killSwitchAbort("retroactive_reprocess", "retroactive_reprocess");
  }
  await backoffForApiPoolPressure("retroactive_reprocess");

  const payload = parsePayload(job);
  const clientId = payload.clientId;
  if (!clientId) {
    // Deliberate throw (not a silent return): the kill-switch regression
    // test (tests/work-queue-kill-switch-attribution.test.ts) relies on
    // this deterministic, side-effect-free error to prove the OFF path
    // executes past the guards, and a payload without clientId is a
    // producer bug that should surface as a failed job, not a silent skip.
    throw new Error("retroactive_reprocess job requires clientId in payload");
  }

  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  const { storage } = await import("../storage");
  const { isCompanyEmail, isPublicEmailDomain, isCompanyDomain } = await import("./companyIdentity");
  const { normalizeClientEmailDomains } = await import("@shared/models/clients");

  const { client, contacts } = await withDbHoldLabel("retroactive_reprocess:targets", () =>
    runWithWorkerDb(async () => {
      const c = await storage.getClient(clientId);
      const ct = c && !c.isArchived ? await storage.getClientContacts(clientId) : [];
      return { client: c, contacts: ct };
    }),
  );

  // A deleted/archived client is a normal outcome for a queued job (the
  // periodic sweep enumerated it before the change) — complete, don't retry.
  if (!client) {
    return { cursor: `skip:client_not_found:${clientId}` };
  }
  if (client.isArchived) {
    return { cursor: `skip:client_archived:${clientId}` };
  }

  // Same identifier filtering as buildHardMatchIndexes: company addresses
  // and public free-mail / company domains can never win a hard match, so
  // scanning for them would only waste scoped-query round trips.
  const emails = new Set<string>();
  const primary = (client.contactEmail || "").trim().toLowerCase();
  if (primary && primary.includes("@") && !isCompanyEmail(primary)) {
    emails.add(primary);
  }
  for (const contact of contacts) {
    for (const raw of contact.emails || []) {
      if (!raw) continue;
      const email = raw.trim().toLowerCase();
      if (!email.includes("@") || isCompanyEmail(email)) continue;
      emails.add(email);
    }
  }
  const domains = normalizeClientEmailDomains(client.emailDomains as unknown)
    .filter((d) => !isPublicEmailDomain(d) && !isCompanyDomain(d));

  const targets = [
    ...[...emails].map((email) => ({ email })),
    ...domains.map((domain) => ({ domain })),
  ];
  if (targets.length === 0) {
    return { cursor: `skip:no_identifiers:${clientId}` };
  }

  const { reEvaluateUnmatchedForTargets } = await import("./frontIntegration");
  const result = await withDbHoldLabel("retroactive_reprocess:re_eval", () =>
    runWithWorkerDb(() =>
      reEvaluateUnmatchedForTargets(targets, {
        // Workers/queues parity (E-F04): the entry-point check above only
        // guards BEFORE the batch starts; long re-eval loops must honor a
        // mid-run operator stop at the per-row boundary too. Queue-handler
        // path only — the interactive attach-domain caller passes no
        // shouldAbort and is unaffected.
        shouldAbort: () => isKillSwitchEnabled("retroactive_reprocess"),
      }),
    ),
  );
  if (result.aborted) {
    return killSwitchAbort("retroactive_reprocess", "retroactive_reprocess");
  }
  return {
    cursor: `targets:${targets.length},affected:${result.total},matched:${result.matched},filterRuleHandled:${result.filterRuleHandled}`,
  };
}

async function handleFrontSyncReprocess(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  // Task #836 Phase 2: kill switch and pressure-aware backoff for the
  // Front sync reprocess flow. `front_sync_reprocess` shares the
  // `interactive_repair` budget; backing off prevents it from
  // displacing real interactive work during pressure spikes.
  if (isKillSwitchEnabled("front_sync_reprocess")) {
    return killSwitchAbort("front_sync_reprocess", "front_sync_reprocess");
  }
  await backoffForApiPoolPressure("front_sync_reprocess");

  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  const payload = parsePayload(job);
  const producerVersion = payload.producerVersion as number | undefined;
  const syncEmailIds = payload.syncEmailIds as string[] | undefined;

  const convergeDismissedOperational = payload.convergeDismissedOperational === true;
  const rematchUnmatchedBacklog = payload.rematchUnmatchedBacklog === true;

  if (syncEmailIds && syncEmailIds.length > 0) {
    // Task #4049 — the unmatched-backlog re-match runs deterministic-only
    // triage per row; rows legitimately stay unmatched (no cohort-exit
    // requirement), so it needs its own batch core rather than the
    // convergent dismissed_operational path below.
    if (rematchUnmatchedBacklog) {
      const { rematchUnmatchedBacklogByIds } = await import("./frontIntegration");
      const r = await withDbHoldLabel("front_sync_reprocess:unmatched_rematch:batch", () =>
        runWithWorkerDb(() => rematchUnmatchedBacklogByIds(syncEmailIds)),
      );
      return {
        cursor: `unmatched_rematch:batch:${syncEmailIds.length},matched:${r.matched},still:${r.stillUnmatched},rules:${r.dismissedByRule + r.neverMatch},errors:${r.errors},v:${producerVersion ?? "none"}`,
      };
    }
    // Task #2641 — the dismissed_operational drain needs the CONVERGENT per-row
    // path (every row leaves the cohort: match → auto_matched, no-match/error →
    // unmatched, operator rule → blocked/dismissed). `reprocessSyncEmailBatch`
    // only mutates rows that match and leaves the rest in place, so it can never
    // converge the cohort to 0. Route those batches to the convergent core.
    if (convergeDismissedOperational) {
      const { rematchDismissedOperationalByIds } = await import("./frontIntegration");
      const r = await withDbHoldLabel("front_sync_reprocess:dismissed_drain:batch", () =>
        runWithWorkerDb(() => rematchDismissedOperationalByIds(syncEmailIds)),
      );
      return {
        cursor: `dismissed_drain:batch:${syncEmailIds.length},matched:${r.matched},unmatched:${r.unmatched},dismissed:${r.dismissedByRule},errors:${r.errors},v:${producerVersion ?? "none"}`,
      };
    }

    const { reprocessSyncEmailBatch } = await import("./frontIntegration");
    // Task #818 Phase 0: tag the per-batch reprocess work; enumeration
    // is tagged separately to distinguish scan from work.
    const result = await withDbHoldLabel("front_sync_reprocess:batch", () =>
      runWithWorkerDb(() => reprocessSyncEmailBatch(syncEmailIds)),
    );
    return {
      cursor: `batch:${syncEmailIds.length},matched:${result.matched},errors:${result.errors},v:${producerVersion ?? "none"}`,
    };
  }

  const { enumerateReprocessEmailIds } = await import("./frontIntegration");
  const requestedMax = payload.maxItems ?? 50000;
  const cohort = (payload.cohort ?? "dismissed_operational") as "dismissed_operational" | "unmatched" | "all";
  const cumulativeOffset = (payload.cumulativeOffset as number) ?? 0;

  let cursorState: { createdAt: Date; id: string } | undefined;
  const cursorJson = payload.cursorState as { createdAt: string; id: string } | undefined;
  if (cursorJson?.createdAt && cursorJson?.id) {
    cursorState = { createdAt: new Date(cursorJson.createdAt), id: cursorJson.id };
  }

  // Task #4049 — finalize-only continuations (enqueued by the terminal
  // enumeration page, or re-enqueued by a deferred finalizer) never
  // enumerate again; they go straight to the settle-gate + lift report.
  if (rematchUnmatchedBacklog && payload.finalizeOnly === true) {
    return await finalizeUnmatchedBacklogRematchChain({
      job,
      payload,
      cumulativeOffset,
      producerVersion: producerVersion ?? null,
    });
  }

  const enumLimit = Math.min(CHUNK_SIZE, requestedMax);
  const enumResult = await withDbHoldLabel("front_sync_reprocess:enumerate", () =>
    runWithWorkerDb(() =>
      enumerateReprocessEmailIds({
        cohort,
        limit: enumLimit,
        afterCursor: cursorState,
      }),
    ),
  );

  if (enumResult.ids.length === 0) {
    // Task #4049 — enumeration exhausted with nothing left to fan out. For
    // the unmatched-backlog re-match chain this hands off to the finalizer,
    // which writes the before/after lift row ONLY once every fan-out batch
    // of the chain has settled (otherwise it defers itself durably).
    if (rematchUnmatchedBacklog) {
      return await finalizeUnmatchedBacklogRematchChain({
        job,
        payload,
        cumulativeOffset,
        producerVersion: producerVersion ?? null,
      });
    }
    return { cursor: `complete:cumulative:${cumulativeOffset},v:${producerVersion ?? "none"}` };
  }

  for (let i = 0; i < enumResult.ids.length; i += BACKFILL_BATCH_SIZE) {
    const batchIds = enumResult.ids.slice(i, i + BACKFILL_BATCH_SIZE);
    const batchIndex = Math.floor((cumulativeOffset + i) / BACKFILL_BATCH_SIZE);
    await enqueueRepairJob({
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: (job.priority ?? 50) + 1,
      payload: {
        syncEmailIds: batchIds,
        cohort,
        producerVersion,
        // Task #2641 — carry the convergent-drain flag onto each batch job so
        // the batch path routes to `rematchDismissedOperationalByIds`.
        ...(convergeDismissedOperational ? { convergeDismissedOperational: true } : {}),
        // Task #4049 — same for the unmatched-backlog re-match batches.
        ...(rematchUnmatchedBacklog ? { rematchUnmatchedBacklog: true } : {}),
      },
      maxAttempts: job.maxAttempts ?? 2,
      dedupeKey: producerVersion
        ? `reprocess_batch:v${producerVersion}:b${batchIndex}`
        : undefined,
    });
  }

  const nextOffset = cumulativeOffset + enumResult.ids.length;
  const remaining = requestedMax - enumResult.ids.length;

  if (enumResult.ids.length >= CHUNK_SIZE && remaining > 0 && enumResult.nextCursor) {
    await enqueueRepairJob({
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: job.priority,
      payload: {
        ...payload,
        maxItems: remaining,
        cumulativeOffset: nextOffset,
        cursorState: {
          createdAt: enumResult.nextCursor.createdAt.toISOString(),
          id: enumResult.nextCursor.id,
        },
      },
      maxAttempts: job.maxAttempts,
      dedupeKey: producerVersion
        ? `continuation:front_sync_reprocess:v${producerVersion}:offset${nextOffset}`
        : undefined,
    });
  } else if (rematchUnmatchedBacklog) {
    // Task #4049 — terminal enumeration page (partial page, exhausted
    // cursor, or budget consumed): this is the NORMAL end of the chain, so
    // the completion/lift row must be produced from here, not only from the
    // rare exact-multiple-of-CHUNK_SIZE case that reaches the empty
    // enumeration above. Enqueue a durable finalize-only continuation at
    // LOWER scheduling precedence than the fan-out batches (priority 51) so
    // batches tend to settle first; if it still runs early, its settle-gate
    // defers it. Never enumerates again — no more fan-out past this point.
    await enqueueRepairJob({
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: (job.priority ?? 50) + 2,
      payload: {
        ...payload,
        finalizeOnly: true,
        cumulativeOffset: nextOffset,
        ...(enumResult.nextCursor
          ? {
              cursorState: {
                createdAt: enumResult.nextCursor.createdAt.toISOString(),
                id: enumResult.nextCursor.id,
              },
            }
          : {}),
      },
      maxAttempts: job.maxAttempts,
      dedupeKey: producerVersion
        ? `finalize:front_sync_reprocess:v${producerVersion}:enqueue`
        : undefined,
    });
  }

  return { cursor: `enumerated:${enumResult.ids.length},cumulative:${nextOffset},v:${producerVersion ?? "none"}` };
}

// Task #4049 — how long a deferred finalizer waits before re-probing for
// still-running fan-out batches of the unmatched-backlog re-match chain.
const UNMATCHED_REMATCH_FINALIZE_RETRY_MS = 30_000;

/**
 * Task #4049 — durable finalizer for the unmatched-backlog re-match chain.
 * Invoked when enumeration is exhausted (empty page) or by the terminal
 * page's finalize-only continuation. Contract:
 *
 * 1. SETTLE GATE — if any fan-out batch job of this chain (same
 *    `producerVersion`, payload carries `syncEmailIds`) is still
 *    pending/leased/processing, the finalizer re-enqueues itself with a
 *    `retryAt` delay and defers. The completion row therefore always
 *    reports post-apply counts, never a mid-drain snapshot. Batches that
 *    end terminally (`completed`/`failed`) release the gate, so a poisoned
 *    batch cannot stall the finalizer forever.
 * 2. SINGLE WRITE — a version-marker probe over recent `prod_action_runs`
 *    rows makes the lift write idempotent across job retries and duplicate
 *    finalize attempts: exactly one completion row per chain version.
 * 3. Lift-report failures never fail the chain (non-fatal warn), but the
 *    settle-gate probe is allowed to throw — the queue's retry machinery
 *    re-runs the finalizer, which is safe by (2).
 */
async function finalizeUnmatchedBacklogRematchChain(args: {
  job: WorkQueueJob;
  payload: Record<string, any>;
  cumulativeOffset: number;
  producerVersion: number | null;
}): Promise<{ cursor: string }> {
  const { job, payload, cumulativeOffset, producerVersion } = args;
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  const { hasInFlightUnmatchedRematchBatchJobs } = await import("./frontIntegration");

  const batchesStillRunning = await hasInFlightUnmatchedRematchBatchJobs({
    excludeJobId: job.id,
    producerVersion,
  });
  if (batchesStillRunning) {
    const waitCount =
      (typeof payload.finalizeWaitCount === "number" ? payload.finalizeWaitCount : 0) + 1;
    await enqueueRepairJob({
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: (job.priority ?? 50) + 2,
      payload: {
        ...payload,
        finalizeOnly: true,
        finalizeWaitCount: waitCount,
        cumulativeOffset,
      },
      maxAttempts: job.maxAttempts,
      retryAt: new Date(Date.now() + UNMATCHED_REMATCH_FINALIZE_RETRY_MS),
      dedupeKey:
        producerVersion != null
          ? `finalize:front_sync_reprocess:v${producerVersion}:wait${waitCount}`
          : undefined,
    });
    return {
      cursor: `finalize_deferred:wait${waitCount},cumulative:${cumulativeOffset},v:${producerVersion ?? "none"}`,
    };
  }

  try {
    const { storage } = await import("../storage");
    const { recordProdActionRun, listProdActionRuns } = await import("../storage/prodActionRuns");

    if (producerVersion != null) {
      const recentRuns = await withDbHoldLabel("front_sync_reprocess:unmatched_rematch:lift", () =>
        runWithWorkerDb(() =>
          listProdActionRuns(200, { actionId: "rematch_unmatched_front_backlog" }),
        ),
      );
      const versionMarker = `(v${producerVersion},`;
      if (recentRuns.some((r) => (r.detail ?? "").includes(versionMarker))) {
        return {
          cursor: `complete:duplicate_lift_suppressed,cumulative:${cumulativeOffset},v:${producerVersion}`,
        };
      }
    }

    const unmatchedAfter = await withDbHoldLabel("front_sync_reprocess:unmatched_rematch:lift", () =>
      runWithWorkerDb(() => storage.countFrontSyncEmailsByStatus("unmatched")),
    );
    const autoMatchedAfter = await withDbHoldLabel("front_sync_reprocess:unmatched_rematch:lift", () =>
      runWithWorkerDb(() => storage.countFrontSyncEmailsByStatus("auto_matched")),
    );
    const baselineUnmatched = typeof payload.baselineUnmatched === "number" ? payload.baselineUnmatched : null;
    const baselineAutoMatched = typeof payload.baselineAutoMatched === "number" ? payload.baselineAutoMatched : null;
    const matchedLift = baselineAutoMatched != null ? autoMatchedAfter - baselineAutoMatched : null;
    const detail =
      `Unmatched-backlog re-match chain complete (v${producerVersion ?? "?"}, ${cumulativeOffset} rows enumerated; all fan-out batches settled). ` +
      `auto_matched: ${baselineAutoMatched ?? "?"} → ${autoMatchedAfter}` +
      (matchedLift != null ? ` (${matchedLift >= 0 ? "+" : ""}${matchedLift})` : "") +
      `; unmatched: ${baselineUnmatched ?? "?"} → ${unmatchedAfter}.`;
    console.log(`[Unmatched-Backlog Rematch] ${detail}`);
    await withDbHoldLabel("front_sync_reprocess:unmatched_rematch:lift", () =>
      runWithWorkerDb(() =>
        recordProdActionRun({
          actionId: "rematch_unmatched_front_backlog",
          actionTitle: "Re-match unmatched Front backlog (deterministic)",
          actorUserId: null,
          outcomeState: "applied",
          detail,
          rowsAffected: matchedLift ?? undefined,
        }),
      ),
    );
  } catch (err: any) {
    console.warn(
      `[Unmatched-Backlog Rematch] Lift report failed (non-fatal): ${err?.message ?? err}`,
    );
  }
  return { cursor: `complete:cumulative:${cumulativeOffset},v:${producerVersion ?? "none"}` };
}

async function handleZoomTranscriptBackfill(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { enqueueTranscriptBackfillBatch, processTranscriptBackfillRecord } = await import("./zoomIntegration");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  const payload = parsePayload(job);

  if (payload.recordIds && payload.recordIds.length > 0) {
    let backfilled = 0;
    let failed = 0;
    let unavailable = 0;
    let revaiEnqueued = 0;

    // Task #818 Phase 0: tag the per-record backfill work; the
    // enumeration tail below is tagged separately.
    for (const recordId of payload.recordIds) {
      try {
        const result = await withDbHoldLabel("zoom_transcript_backfill:record", () =>
          processTranscriptBackfillRecord(recordId),
        );
        if (result === "backfilled") {
          backfilled++;
        } else if (result === "failed") {
          failed++;
        } else if (result === "unavailable") {
          // Task #3689: terminal no-transcript transitions, surfaced in the
          // cursor so operators can see convergence in the job history.
          unavailable++;
        } else if (result === "revai_enqueued") {
          // Task #3701: audio-but-no-transcript records routed to the Rev AI
          // generation pipeline instead of going terminal.
          revaiEnqueued++;
        }
      } catch (err: any) {
        console.error(`[ZoomBackfill] Error processing record ${recordId}:`, err.message);
        failed++;
      }
    }

    return { cursor: `batch:backfilled:${backfilled},failed:${failed},unavailable:${unavailable},revai_enqueued:${revaiEnqueued}` };
  }

  const pendingIds = await withDbHoldLabel("zoom_transcript_backfill:enumerate", () =>
    runWithWorkerDb(() => enqueueTranscriptBackfillBatch()),
  );

  // Task #3701: revival pass for rows the #3689 sweep parked as terminal
  // 'unavailable' with audio in their stored fileTypes. Runs on every sweep
  // (BEFORE the no-pending early return — terminal rows are by definition
  // not "pending") so production converges on its own.
  let revivalSummary = "";
  try {
    const { reviveUnavailableRecordsForRevAi } = await import("./zoomIntegration");
    const revival = await withDbHoldLabel("zoom_transcript_backfill:revai_revival", () =>
      runWithWorkerDb(() => reviveUnavailableRecordsForRevAi()),
    );
    revivalSummary = `,revai_revived:${revival.revived}${revival.capped ? ",revai_capped" : ""}`;
  } catch (err: any) {
    console.error("[ZoomBackfill] Rev AI revival pass failed:", err.message);
    revivalSummary = ",revai_revival_error";
  }

  if (pendingIds.length === 0) {
    return { cursor: `complete:no_pending_records${revivalSummary}` };
  }

  for (let i = 0; i < pendingIds.length; i += BACKFILL_BATCH_SIZE) {
    const batchIndex = Math.floor(i / BACKFILL_BATCH_SIZE);
    const batchIds = pendingIds.slice(i, i + BACKFILL_BATCH_SIZE);
    await enqueueRepairJob({
      queueName: "zoom_transcript_backfill",
      workloadClass: "repair",
      priority: job.priority ?? 100,
      payload: { recordIds: batchIds },
      maxAttempts: 2,
      dedupeKey: `zoom_backfill_batch:${job.id}:${batchIndex}`,
    });
  }

  return { cursor: `dispatched:${pendingIds.length}_records_in_${Math.ceil(pendingIds.length / BACKFILL_BATCH_SIZE)}_batches${revivalSummary}` };
}

async function handleZoomRevAiTranscription(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const payload = parsePayload(job);
  const recordId = payload.recordId as string | undefined;
  if (!recordId) {
    console.error("[ZoomRevAi] Missing recordId in job payload");
    return { cursor: "skipped:missing_record_id" };
  }

  const { processZoomRevAiTranscriptionJob } = await import("./zoomIntegration");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");

  const outcome = await withDbHoldLabel("zoom_revai_transcription", () =>
    runWithWorkerDb(() => processZoomRevAiTranscriptionJob(recordId)),
  );
  return { cursor: outcome };
}
async function handleZoomMeetingApplyJob(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const payload = parsePayload(job);
  const sourceEventId = payload.sourceEventId as string;
  const meetingUuid = payload.meetingUuid as string;

  if (!sourceEventId || !meetingUuid) {
    console.error("[ZoomMeetingApply] Missing sourceEventId or meetingUuid in job payload");
    return;
  }

  const { handleZoomMeetingApply } = await import("./zoomIntegration");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");

  // Task #818 Phase 0: stable label for the Zoom meeting-apply path so the
  // pool wrapper can attribute long client holds to this handler.
  await withDbHoldLabel("zoom_meeting_apply", () =>
    runWithWorkerDb(() => handleZoomMeetingApply(sourceEventId, meetingUuid)),
  );

  return { cursor: `meeting:${meetingUuid}:applied` };
}

async function handleZoomTranscriptApplyJob(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const payload = parsePayload(job);
  const sourceEventId = payload.sourceEventId as string;
  const meetingUuid = payload.meetingUuid as string;

  if (!sourceEventId || !meetingUuid) {
    console.error("[ZoomTranscriptApply] Missing sourceEventId or meetingUuid in job payload");
    return;
  }

  const { handleZoomTranscriptApply } = await import("./zoomIntegration");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");

  // Task #818 Phase 0: stable label for the Zoom transcript-apply path.
  await withDbHoldLabel("zoom_transcript_apply", () =>
    runWithWorkerDb(() => handleZoomTranscriptApply(sourceEventId, meetingUuid)),
  );

  return { cursor: `transcript:${meetingUuid}:applied` };
}

async function handleApplyJob(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { runApplyForWorkResult } = await import("./applyPipeline");
  const { getApplyHandler } = await import("./applyHandlers");
  const payload = parsePayload(job);
  const workResultId = payload.workResultId as string;

  if (!workResultId) {
    console.error(`[ApplyJob] No workResultId in payload for job ${job.id} (${job.queueName})`);
    return;
  }

  const handler = getApplyHandler(job.queueName);
  if (!handler) {
    console.error(`[ApplyJob] No apply handler found for queueName=${job.queueName}`);
    return;
  }

  // Task #818 Phase 0: tag this apply path with the queue name so the
  // pool wrapper can attribute long client holds to the right surface
  // (front_email_apply, semrush_*_apply, zoom_*_apply, etc.).
  // Task #976: use the canonical `worker:<queue>:apply` taxonomy so the
  // System Health top-labels list groups these holds under the worker
  // bucket instead of an outlier `apply:*` prefix.
  const { withDbHoldLabel } = await import("../db");
  const results = await withDbHoldLabel(`worker:${job.queueName}:apply`, () =>
    runApplyForWorkResult(workResultId, [handler]),
  );
  const outcome = results[0];

  return {
    cursor: `apply:${job.queueName}:outcome=${outcome?.outcome ?? "unknown"}`,
  };
}

async function handleFrontWebhookNormalize(job: WorkQueueJob): Promise<void> {
  const payload = parsePayload(job);
  const sourceEventId = payload.sourceEventId as string;
  if (!sourceEventId) {
    console.error("[FrontWebhookNormalize] No sourceEventId in job payload");
    return;
  }
  const fromReconciliation = payload.fromReconciliation as boolean | undefined;
  // Task #818 Phase 0: tag normalize path. Reconciliation and live
  // webhooks share most code so we use sub-labels.
  const { withDbHoldLabel } = await import("../db");
  if (fromReconciliation) {
    const { normalizeReconciliationEvent } = await import("./frontWebhookIngestion");
    await withDbHoldLabel("front_normalize:reconciliation", () =>
      normalizeReconciliationEvent(sourceEventId),
    );
  } else {
    const { normalizeFrontWebhookEvent } = await import("./frontWebhookIngestion");
    await withDbHoldLabel("front_normalize:webhook", () =>
      normalizeFrontWebhookEvent(sourceEventId),
    );
  }
}

async function handleFrontWebhookApply(job: WorkQueueJob): Promise<void> {
  const payload = parsePayload(job);
  const sourceEventId = payload.sourceEventId as string;
  const workResultId = payload.workResultId as string;
  if (!sourceEventId || !workResultId) {
    console.error("[FrontWebhookApply] Missing sourceEventId or workResultId in payload");
    return;
  }
  const { applyFrontWebhookResult } = await import("./frontWebhookIngestion");
  // Task #818 Phase 0: stable label for the Front webhook apply path.
  const { withDbHoldLabel } = await import("../db");
  await withDbHoldLabel("front_webhook_apply", () =>
    applyFrontWebhookResult(sourceEventId, workResultId),
  );
}

async function handleFrontHistoricalBackfill(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { runFrontHistoricalBackfill } = await import("./frontWebhookIngestion");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  const payload = parsePayload(job);

  const startDate = payload.startDate as string;
  const endDate = payload.endDate as string;
  const runId = payload.runId as string | undefined;

  if (!startDate || !endDate) {
    console.error("[FrontHistoricalBackfill] Missing startDate or endDate in job payload");
    return;
  }

  // Task #818 Phase 0: tag the historical backfill maintenance path.
  const result = await withDbHoldLabel("front_historical_backfill", () =>
    runWithWorkerDb(() => runFrontHistoricalBackfill({ startDate, endDate, runId })),
  );

  if (!result.completed) {
    const { enqueueRepairJob } = await import("./repairDispatcher");
    await enqueueRepairJob({
      queueName: "front_historical_backfill",
      workloadClass: "maintenance",
      priority: job.priority ?? 300,
      payload: {
        startDate,
        endDate,
        runId: result.runId,
      },
      maxAttempts: job.maxAttempts ?? 5,
      dedupeKey: `front_backfill_continuation:${result.runId}:iter${Date.now()}`,
    });
  }

  return {
    cursor: `run:${result.runId},scanned:${result.scanned},ingested:${result.ingested},skipped:${result.skipped},completed:${result.completed}`,
  };
}

async function handleFrontReconciliation(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { runFrontReconciliation } = await import("./frontWebhookIngestion");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  // Task #818 Phase 0: tag the reconciliation entry point.
  const result = await withDbHoldLabel("front_reconciliation", () =>
    runWithWorkerDb(() => runFrontReconciliation()),
  );

  if (result.ingested > 0) {
    return { cursor: `scanned:${result.scanned},ingested:${result.ingested},skipped:${result.skipped}` };
  }
  return { cursor: `complete:scanned:${result.scanned}` };
}

async function handleFrontFullBackfill(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { runFrontFullBackfill } = await import("./frontWebhookIngestion");
  const { runWithWorkerDb, withDbHoldLabel } = await import("../db");
  // Task #818 Phase 0: tag the full backfill maintenance path.
  const result = await withDbHoldLabel("front_full_backfill", () =>
    runWithWorkerDb(() => runFrontFullBackfill()),
  );

  return {
    cursor: `pages:${result.pages},scanned:${result.scanned},ingested:${result.ingested},skipped:${result.skipped},errors:${result.errors.length}`,
  };
}

async function handleFrontBulkActionJob(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { handleFrontBulkAction } = await import("./frontBulkActions");
  const { runWithWorkerDb } = await import("../db");
  return runWithWorkerDb(() => handleFrontBulkAction(job));
}

async function handleFrontFilterRuleApplyJobWrapper(job: WorkQueueJob): Promise<{ cursor?: string } | void> {
  const { handleFrontFilterRuleApplyJob } = await import("./frontFilterRules");
  const { runWithWorkerDb } = await import("../db");
  return runWithWorkerDb(() => handleFrontFilterRuleApplyJob(job));
}

/**
 * Task #1643 — Front Analytics coverage refresh handler. Each enqueued
 * job runs one refresh tick: re-pulls the current month and back-fills
 * up to N missing completed months (capped by
 * `frontAnalyticsCoverageMaxMonthsPerTick`). Workload class is
 * `maintenance` so it competes with other low-priority observability
 * sweeps (Task #1643 spec calls this `ingestion_observability` —
 * preserved in comments; the runtime workload-class enum is
 * `maintenance`).
 *
 * Task #1644 — this handler is the only execution path for the
 * coverage refresh tick. The in-process interval started by
 * `startFrontAnalyticsCoverageScheduler` only enqueues a job each
 * interval (via the work queue), and the admin refresh endpoint
 * enqueues the same job on demand.
 */
async function handleFrontAnalyticsCoverageRefresh(job: WorkQueueJob): Promise<void> {
  const { runCoverageRefreshTick } = await import("./frontAnalyticsCoverage");
  const { runWithWorkerDb } = await import("../db");
  try {
    const r = await runWithWorkerDb(() => runCoverageRefreshTick());
    workerLog({
      worker: "front_analytics_coverage_refresh",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        adoption_date: r.adoptionDate,
        attempted: r.attempted.length,
        errors: r.attempted.filter((a) => a.outcome === "front_error").length,
        reason: r.reason ?? null,
      },
    });
    // Task #1644 — run the alert check after every successful tick so
    // dashboard drop/floor alerts continue to fire (previously called
    // from the in-process setInterval scheduler).
    try {
      const { runFrontAnalyticsCoverageAlertCheck } = await import(
        "./frontAnalyticsCoverageAlerts"
      );
      await runWithWorkerDb(() => runFrontAnalyticsCoverageAlertCheck());
    } catch (alertErr) {
      console.warn(
        `[FrontAnalyticsCoverage] alert check failed: ${
          alertErr instanceof Error ? alertErr.message : String(alertErr)
        }`,
      );
    }
    // Task #1682 — Front self-healing coverage loop. Runs after the
    // alert check so error rows seen by the alerter are also visible
    // to the auto-closer. Non-throwing by contract — never breaks the
    // surrounding refresh tick.
    try {
      const { runFrontAutoClosureTick } = await import("./frontAutoClosure");
      await runWithWorkerDb(() => runFrontAutoClosureTick());
    } catch (autoErr) {
      console.warn(
        `[FrontAutoClosure] tick failed: ${
          autoErr instanceof Error ? autoErr.message : String(autoErr)
        }`,
      );
    }
    // Task #1684 — Front auto-closure regression alerts. Runs after the
    // auto-closer tick so the alert evaluator reads the freshly
    // persisted summary. Independent from the coverage drop/floor
    // alerter — its own kill switch is
    // `front_auto_closure_alerts_enabled`. Non-throwing by contract.
    try {
      const { runFrontAutoClosureRegressionAlertCheck } = await import(
        "./frontAutoClosureRegressionAlerts"
      );
      await runWithWorkerDb(() => runFrontAutoClosureRegressionAlertCheck());
    } catch (regErr) {
      console.warn(
        `[FrontAutoClosureRegressionAlerts] check failed: ${
          regErr instanceof Error ? regErr.message : String(regErr)
        }`,
      );
    }
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "front_analytics_coverage_refresh")) {
      return;
    }
    throw err;
  }
}

/**
 * Front auto-closure tick handler. Drives the warp self-heal knobs
 * (recovery budget / cooldown / retry budget / concurrency cap) by
 * invoking `runFrontAutoClosureTick` directly on its own cadence.
 *
 * Enqueued by `frontAutoClosureScheduler.ts` on a ~60s timer. Idempotent
 * with the legacy invocation embedded in `handleFrontAnalyticsCoverageRefresh`
 * because `runFrontAutoClosureTick` carries its own `front_auto_closure_state`
 * lock (Task #1684). Non-throwing by contract — the catch below logs and
 * swallows so a transient tick failure cannot dead-letter the queue.
 */
async function handleFrontAutoClosureTick(job: WorkQueueJob): Promise<void> {
  const { runFrontAutoClosureTick } = await import("./frontAutoClosure");
  const { runWithWorkerDb } = await import("../db");
  try {
    await runWithWorkerDb(() => runFrontAutoClosureTick());
    workerLog({
      worker: "front_auto_closure_tick",
      event: "tick_complete",
      jobId: job.id,
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "front_auto_closure_tick")) {
      return;
    }
    console.warn(
      `[FrontAutoClosure] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry. Throwing here would
    // mark the job failed and burn a retry attempt for a transient
    // condition that will likely clear within ~60s.
  }
}

/**
 * Task #1984 — Front outbound gap-close tick handler. Reads
 * `front_analytics_monthly_coverage` rows with a positive
 * `messages_outbound_gap` and drives the still-real ones back through
 * the historical-recovery ingestion pipeline (which materializes one
 * `raw_communication_records` row per Front `msg_*` id, deduping on
 * `external_source_id`). Bounded per tick and gated by
 * `front_outbound_gap_close_enabled`. Non-throwing by contract — a
 * transient failure is retried on the next scheduler tick.
 */
async function handleFrontOutboundGapClose(job: WorkQueueJob): Promise<void> {
  const { runOutboundGapCloseTick, alertIfLastRunUnreadable } = await import(
    "./frontOutboundGapCloser"
  );
  const { runWithWorkerDb } = await import("../db");
  // Task #2057 — an operator can scope a run to a single month via the
  // per-row "Run" action. The payload carries `month` (YYYY-MM); the
  // scheduler path leaves it undefined for a worst-gap-first budgeted run.
  const payload = parsePayload(job);
  const month =
    typeof payload.month === "string" && payload.month.trim()
      ? payload.month.trim()
      : undefined;
  try {
    const r = await runWithWorkerDb(async () => {
      // Task #2197 — detect a corrupt persisted last-run summary BEFORE
      // this tick overwrites it, so a real persistence bug pages admins
      // (deduped) instead of being silently repaired. Best-effort: never
      // throws, never blocks the tick.
      await alertIfLastRunUnreadable();
      return runOutboundGapCloseTick(month ? { month } : undefined);
    });
    workerLog({
      worker: "front_outbound_gap_close",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        materialization_enabled: r.materializationEnabled,
        candidate_months: r.candidateMonths,
        attempted: r.attempted.length,
        triggered: r.attempted.filter((a) => a.outcome === "recovery_triggered")
          .length,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "front_outbound_gap_close")) {
      return;
    }
    console.warn(
      `[FrontOutboundGapClose] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2010 — Front outbound-gap backfill tick handler. Runs ONE
 * bounded, resumable enumeration-walk tick per gap month (collecting the
 * in-window outbound messages once) and writes the genuinely-missing
 * `raw_communication_records` rows through the shared ingestion helper —
 * the cheaper, message-grain counterpart to the close-gap recovery
 * driver. Gated by `front_outbound_gap_backfill_enabled` (default OFF);
 * also honors queue-pause + `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 * Non-throwing by contract — a transient failure is retried next tick.
 */
async function handleFrontOutboundGapBackfill(job: WorkQueueJob): Promise<void> {
  const { runOutboundGapBackfillTick } = await import(
    "./frontOutboundGapBackfill"
  );
  const { runWithWorkerDb } = await import("../db");
  // An operator can scope a run to a single month (YYYY-MM) via the
  // per-row "Backfill" action; the scheduler path leaves it undefined.
  const payload = parsePayload(job);
  const month =
    typeof payload.month === "string" && payload.month.trim()
      ? payload.month.trim()
      : undefined;
  try {
    const r = await runWithWorkerDb(() =>
      runOutboundGapBackfillTick(month ? { month } : undefined),
    );
    workerLog({
      worker: "front_outbound_gap_backfill",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        candidate_months: r.candidateMonths,
        attempted: r.attempted.length,
        inserted: r.attempted.reduce((s, a) => s + a.inserted, 0),
        skipped: r.attempted.reduce((s, a) => s + a.skipped, 0),
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "front_outbound_gap_backfill")) {
      return;
    }
    console.warn(
      `[FrontOutboundGapBackfill] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2365 — Front message-grain upgrade tick handler. Re-probes
 * finalized coverage months still below `messages_all` denominator grain
 * via the search fallback (advancing the per-message enumeration walk)
 * until each row flips to message grain — automating the manual
 * `reach_front_coverage_full_message_grain` prod-action. Gated by
 * `front_message_grain_upgrade_enabled` (default OFF); also honors
 * queue-pause, `KILL_SWITCH_NON_CRITICAL_SWEEPS`, the per-message
 * enumeration hard gate, and the Front auth breaker. MEASUREMENT-ONLY —
 * it re-probes the denominator, it does NOT ingest missing messages (the
 * #1984 / #2010 outbound-gap drivers own that). Non-throwing by contract.
 */
async function handleFrontMessageGrainUpgrade(job: WorkQueueJob): Promise<void> {
  const { runMessageGrainUpgradeTick } = await import(
    "./frontMessageGrainUpgrader"
  );
  const { runWithWorkerDb } = await import("../db");
  // An operator can scope a run to a single month (YYYY-MM) via the
  // per-row "Upgrade" action; the scheduler path leaves it undefined.
  const payload = parsePayload(job);
  const month =
    typeof payload.month === "string" && payload.month.trim()
      ? payload.month.trim()
      : undefined;
  try {
    const r = await runWithWorkerDb(() =>
      runMessageGrainUpgradeTick(month ? { month } : undefined),
    );
    workerLog({
      worker: "front_message_grain_upgrade",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        enum_enabled: r.enumEnabled,
        candidate_months: r.candidateMonths,
        attempted: r.attempted.length,
        upgraded: r.attempted.filter((a) => a.outcome === "upgraded").length,
        advanced: r.attempted.filter((a) => a.outcome === "advanced").length,
        errors: r.attempted.filter((a) => a.outcome === "error").length,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "front_message_grain_upgrade")) {
      return;
    }
    console.warn(
      `[FrontMessageGrainUpgrade] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2029 — Restored-fallback email cleanup tick handler. Scans
 * active users whose email matches the `.restored.<ts>` fallback
 * pattern and auto-restores the original address for any whose stripped
 * original is free (collisions are left for manual cleanup). Gated by
 * `restored_email_cleanup_enabled` (default OFF). Non-throwing by
 * contract — a transient failure is retried on the next scheduler tick.
 */
async function handleRestoredEmailCleanup(job: WorkQueueJob): Promise<void> {
  const { runRestoredEmailCleanupTick } = await import("./restoredEmailCleanup");
  const { runWithWorkerDb } = await import("../db");
  // Task #2043 — an operator on-demand trigger sets `force: true` so the
  // tick runs even when the `restored_email_cleanup_enabled` master
  // switch is off. Scheduled jobs omit it and stay gated as before.
  const force = (job.payload as { force?: boolean } | null)?.force === true;
  try {
    const r = await runWithWorkerDb(() => runRestoredEmailCleanupTick({ force }));
    workerLog({
      worker: "restored_email_cleanup",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        forced: r.forced ?? false,
        paused: r.paused,
        candidates: r.candidates,
        repaired: r.repaired,
        collisions: r.collisions,
        errors: r.errors,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "restored_email_cleanup")) {
      return;
    }
    console.warn(
      `[RestoredEmailCleanup] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2066 — Feedback → Slack retry tick handler. Re-drives feedback
 * rows whose `slack_status` is not `delivered` through the shared relay
 * once Slack connectivity returns, updating each row's status + reason
 * in place. Gated by `feedback_slack_retry_enabled` (default OFF) plus a
 * live connectivity probe. Non-throwing by contract — a transient
 * failure is retried on the next scheduler tick.
 */
async function handleFeedbackSlackRetry(job: WorkQueueJob): Promise<void> {
  const { runFeedbackSlackRetryTick } = await import("./feedbackSlackRetry");
  const { runWithWorkerDb } = await import("../db");
  try {
    const r = await runWithWorkerDb(() => runFeedbackSlackRetryTick());
    workerLog({
      worker: "feedback_slack_retry",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        connected: r.connected,
        candidates: r.candidates,
        delivered: r.delivered,
        stillFailed: r.stillFailed,
        errors: r.errors,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "feedback_slack_retry")) {
      return;
    }
    console.warn(
      `[FeedbackSlackRetry] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2414 — Feedback video resume tick handler. Scans `user_feedback`
 * rows whose `video_analysis.status` is stuck `processing` past a threshold
 * (orphaned when the server restarted mid-analysis) and re-drives them
 * through the shared processor, marking permanently-stuck rows terminal.
 * Gated by `feedback_video_resume_enabled` (default OFF). Non-throwing by
 * contract — a transient failure is retried on the next scheduler tick.
 */
async function handleFeedbackVideoResume(job: WorkQueueJob): Promise<void> {
  const { runFeedbackVideoResumeTick } = await import("./feedbackVideoResume");
  const { runWithWorkerDb } = await import("../db");
  try {
    const r = await runWithWorkerDb(() => runFeedbackVideoResumeTick());
    workerLog({
      worker: "feedback_video_resume",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        candidates: r.candidates,
        resumed: r.resumed,
        gaveUp: r.gaveUp,
        noVideos: r.noVideos,
        errors: r.errors,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "feedback_video_resume")) {
      return;
    }
    console.warn(
      `[FeedbackVideoResume] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2203 — Orphaned-user heal tick handler. Scans live sessions for
 * `sub`s with no `users` row (admitted by a first-login fail-open that
 * never reconciled because the user made no further request) and
 * re-upserts each profile from the session claims. Gated by
 * `orphaned_user_heal_enabled` (default OFF). Non-throwing by contract —
 * a transient failure is retried on the next scheduler tick.
 */
async function handleOrphanedUserHeal(job: WorkQueueJob): Promise<void> {
  const { runOrphanedUserHealTick } = await import("./orphanedUserHeal");
  const { runWithWorkerDb } = await import("../db");
  try {
    const r = await runWithWorkerDb(() => runOrphanedUserHealTick());
    workerLog({
      worker: "orphaned_user_heal",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        candidates: r.candidates,
        healed: r.healed,
        errors: r.errors,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "orphaned_user_heal")) {
      return;
    }
    console.warn(
      `[OrphanedUserHeal] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2529 — Front finish-message-grain tick handler. Invokes the SAME
 * shared apply path the operator presses
 * (`applyFinishFrontMessageGrainCoverage`) so every in-scope Front coverage
 * month is driven to a real `messages_all` denominator on a cadence WITHOUT
 * requiring the global self-heal master switch. Gated by
 * `front_finish_message_grain_enabled` (default OFF); also honors queue-pause,
 * `KILL_SWITCH_NON_CRITICAL_SWEEPS`, and the Front auth breaker (reports
 * `blocked`, never a failed run). GRAIN-ONLY — it re-measures the denominator
 * grain, it does NOT drive the recovery numerator (Task #1920). Non-throwing
 * by contract.
 */
async function handleFrontFinishMessageGrain(job: WorkQueueJob): Promise<void> {
  const { runFinishMessageGrainTick } = await import(
    "./frontFinishMessageGrainDriver"
  );
  const { runWithWorkerDb } = await import("../db");
  try {
    const r = await runWithWorkerDb(() => runFinishMessageGrainTick());
    workerLog({
      worker: "front_finish_message_grain",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        kill_switch: r.killSwitch,
        breaker_open: r.breakerOpen,
        applied: r.applied,
        outcome: r.outcomeState ?? null,
        rows_affected: r.rowsAffected ?? null,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "front_finish_message_grain")) {
      return;
    }
    console.warn(
      `[FrontFinishMessageGrain] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

/**
 * Task #2086 — Prod-action self-heal tick handler. Applies the due,
 * opted-in (`ProdAction.selfHeal`) idempotent maintenance actions so the
 * CEO no longer has to apply recurring drains by hand. Gated by
 * `prod_action_self_heal_enabled` (default OFF). Non-throwing by
 * contract — a transient failure is retried on the next scheduler tick.
 */
async function handleProdActionSelfHeal(job: WorkQueueJob): Promise<void> {
  const { runProdActionSelfHealTick } = await import("./prodActionSelfHeal");
  const { runWithWorkerDb } = await import("../db");
  try {
    const r = await runWithWorkerDb(() => runProdActionSelfHealTick());
    workerLog({
      worker: "prod_action_self_heal",
      event: "tick_complete",
      jobId: job.id,
      details: {
        enabled: r.enabled,
        paused: r.paused,
        eligible: r.eligibleActionIds.length,
        due: r.dueActionIds.length,
        applied: r.applied,
        notNeeded: r.notNeeded,
        errors: r.errors,
        blocked: r.blocked,
        reason: r.reason ?? null,
      },
    });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "prod_action_self_heal")) {
      return;
    }
    console.warn(
      `[ProdActionSelfHeal] scheduled tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Swallow — the next scheduler tick will retry.
  }
}

// Task #978 Phase 1: SEMrush report-refresh handler. Mirrors the body of
// the previous deferred-tick wrapper in semrushInventorySync.ts but is
// registered synchronously in `registerAllHandlers()` so the scheduler
// never claims a `semrush_report_refresh` job before the handler exists.
async function handleSemrushReportRefresh(job: WorkQueueJob): Promise<void> {
  if (!PERF.SEMRUSH_REPORT_REFRESH_ENABLED) {
    workerLog({
      worker: "semrush_report_refresh",
      event: "skipped_feature_disabled",
      jobId: job.id,
    });
    return;
  }
  // Task #1784: defense-in-depth pause check. The scheduler already
  // skips paused queues at dequeue time; this handler-side guard covers
  // the narrow window where a row was claimed just before the in-memory
  // pause state was hot-reloaded.
  {
    const { isQueuePaused } = await import("./queueDrainControl");
    if (isQueuePaused("semrush_report_refresh")) {
      workerLog({
        worker: "semrush_report_refresh",
        event: "handler_skipped_queue_paused",
        jobId: job.id,
      });
      return;
    }
  }
  try {
    const { handleRefreshJob } = await import("./semrushInventorySync");
    await handleRefreshJob(job as { payload: any });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "semrush_report_refresh")) {
      return;
    }
    throw err;
  }
}

// Task #978 Phase 2: SEMrush background campaign-cache refresh handler.
// Wraps the previously-inline refresh body in a controlled work-queue
// execution path with kill-switch + sub-attribution. The handler itself
// runs under `worker:semrush_background_refresh` (added by processJob);
// inner stages refine the label so DB hold time can be attributed to
// the actual offender (probe vs fetch vs enrich vs apply).
async function handleSemrushBackgroundRefresh(
  job: WorkQueueJob,
): Promise<{ cursor?: string } | void> {
  if (isKillSwitchEnabled("semrush_background_refresh")) {
    return killSwitchAbort(
      "semrush_background_refresh",
      "semrush_background_refresh",
    );
  }
  // Task #1784: defense-in-depth pause check (see handleSemrushReportRefresh).
  {
    const { isQueuePaused } = await import("./queueDrainControl");
    if (isQueuePaused("semrush_background_refresh")) {
      workerLog({
        worker: "semrush_background_refresh",
        event: "handler_skipped_queue_paused",
        jobId: job.id,
      });
      return;
    }
  }
  await backoffForApiPoolPressure("semrush_background_refresh");
  try {
    const { runBackgroundRefreshJob } = await import("./semrushApi");
    await runBackgroundRefreshJob({ jobId: job.id });
  } catch (err) {
    if (await deferIfDbPoolSaturated(job, err, "semrush_background_refresh")) {
      return;
    }
    throw err;
  }
}

// Task #1050: helper shared by the two SEMrush handlers. When a job
// fails because of pg-pool saturation (acquire timeout, connection
// terminated mid-statement, etc.) we treat the failure as a resumable
// partial — release the lease via normal completion, and re-enqueue a
// deferred copy with a short backoff. This avoids burning a maxAttempts
// slot on what is almost always a transient deploy-window blip and
// matches the existing breaker-deferred re-enqueue pattern in
// `semrushInventorySync.handleRefreshJob`.
//
// Returns true when the job was re-enqueued as a deferred partial (the
// caller should return successfully so the current job completes
// without consuming an attempt). Returns false otherwise (the caller
// should rethrow the original error so the scheduler counts the failure
// toward maxAttempts as before).
export async function deferIfDbPoolSaturated(
  job: WorkQueueJob,
  err: unknown,
  queueName:
    | "semrush_report_refresh"
    | "semrush_background_refresh"
    | "front_analytics_coverage_refresh"
    | "front_auto_closure_tick"
    | "front_outbound_gap_close"
    | "front_outbound_gap_backfill"
    | "front_message_grain_upgrade"
    | "front_finish_message_grain"
    | "restored_email_cleanup"
    | "feedback_slack_retry"
    | "feedback_video_resume"
    | "prod_action_self_heal"
    | "orphaned_user_heal",
): Promise<boolean> {
  const { isDbPoolSaturationError } = await import("./frontHistoricalRecovery");
  if (!isDbPoolSaturationError(err)) return false;

  const { workloadClasses } = await import("@shared/schema");
  type WorkloadClass = typeof workloadClasses[number];
  const rawClass = job.workloadClass;
  // SEMrush handlers run under `ingestion`; if a future caller wires
  // them into another class we still defer safely. Anything outside
  // the canonical set is rejected so we don't push a malformed job
  // into the queue.
  if (!(workloadClasses as readonly string[]).includes(rawClass)) {
    return false;
  }
  const workloadClass = rawClass as WorkloadClass;

  const errMsg = err instanceof Error ? err.message : String(err);
  // Bounded backoff: 60s + jitter, with a per-(job, minute) dedupe key
  // so concurrent saturation events on the same job don't fan out into
  // multiple deferred copies. We keep the original payload + workload
  // class so the deferred attempt is identical to the failing one.
  const baseDelayMs = 60_000;
  const jitterMs = Math.floor(Math.random() * 30_000);
  const retryAt = new Date(Date.now() + baseDelayMs + jitterMs);
  const minuteBucket = Math.floor(retryAt.getTime() / 60_000);
  const dedupeKey = `db_pool_partial:${queueName}:${job.id}:${minuteBucket}`;
  const payload = (job.payload as Record<string, unknown> | null) ?? undefined;

  const { enqueueJob } = await import("./workScheduler");
  try {
    await enqueueJob({
      queueName,
      workloadClass,
      priority: job.priority ?? 50,
      payload,
      retryAt,
      dedupeKey,
      maxAttempts: job.maxAttempts ?? 3,
    });
  } catch (reEnqErr: any) {
    // If we cannot re-enqueue, surface the original failure so the
    // scheduler still records the dead-letter / retry transition.
    workerLog({
      worker: queueName,
      event: "db_pool_partial_reenqueue_failed",
      jobId: job.id,
      error: reEnqErr?.message ?? String(reEnqErr),
    });
    return false;
  }
  workerLog({
    worker: queueName,
    event: "db_pool_partial_deferred",
    jobId: job.id,
    workloadClass: job.workloadClass,
    error: errMsg.slice(0, 200),
    retryAt: retryAt.toISOString(),
  });
  return true;
}

export async function submitRepairJob(opts: {
  queueName: string;
  workloadClass: "interactive_repair" | "repair" | "maintenance";
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
}): Promise<string> {
  return enqueueRepairJob({
    queueName: opts.queueName,
    workloadClass: opts.workloadClass,
    payload: opts.payload,
    priority: opts.priority ?? 200,
    maxAttempts: opts.maxAttempts ?? 3,
    dedupeKey: opts.dedupeKey,
  });
}
