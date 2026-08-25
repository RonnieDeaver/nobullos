/**
 * Integrations routes — admin Front Analytics coverage (summary, months, refresh, message-grain upgrade, outbound gap close, adoption date).
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 1898–3205, 4773–5065); sections: admin Front Analytics coverage (summary, months, refresh, message-grain upgrade, outbound gap close, adoption date); coverage alert thresholds.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import { insertActivityLogs } from "../../storage/activityStorage";
import {
  refreshDisabledBlocked,
  queuePausedBlocked,
  killSwitchBlocked,
} from "../../services/frontTriggerBlockedReasons";
import type { AuthenticatedRequest } from "../requestContext";

export function registerIntegrationsFrontAnalyticsCoverageRoutes(app: Express) {
  // Task #1643 — Front Analytics all-time coverage summary. Cache-only
  // read from `front_analytics_monthly_coverage`. Does NOT call Front
  // Analytics on the request path; the refresh worker is responsible
  // for keeping the cache fresh. Admin-only.
  app.get(
    "/api/admin/front/analytics-coverage",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const { getFrontAnalyticsCoverageSummary } = await import(
          "../../services/frontAnalyticsCoverage"
        );
        const summary = await getFrontAnalyticsCoverageSummary();
        res.set("Cache-Control", "no-store");
        res.json(summary);
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics coverage summary failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to load coverage summary" });
      }
    },
  );

  // Task #2481 — the operator adoption-date override route (Task #1656) was
  // removed. The Front coverage floor is now a hard-coded constant
  // (`FRONT_ADOPTION_DATE` in services/frontAnalyticsCoverage.ts) with no API
  // or UI way to change it, so `POST /api/admin/front/analytics-coverage/
  // adoption-date` no longer exists (returns 404). This eliminates the
  // regression class where a missing `system_settings.front_adoption_date`
  // row let the worker silently re-derive the floor.

  // Task #1643 — operator-triggered refresh. Enqueues a low-priority
  // `front_analytics_coverage_refresh` work_queue job. Honors the
  // queue-drain pause and `front_analytics_refresh_enabled` kill
  // switch inside the handler.
  app.post(
    "/api/admin/front/analytics-coverage/refresh",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res) => {
      try {
        const { enqueueJob } = await import("../../services/workScheduler");
        const jobId = await enqueueJob({
          queueName: "front_analytics_coverage_refresh",
          workloadClass: "maintenance",
          priority: 200,
          payload: { triggeredBy: req.user?.claims?.sub ?? "unknown" },
          dedupeKey: "front_analytics_coverage_refresh:manual",
        });
        res.status(202).json({ enqueued: true, jobId });
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics coverage refresh enqueue failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to enqueue refresh" });
      }
    },
  );

  // Task #1675 — one-shot manual refresh for a single month. Runs
  // `refreshMonth` synchronously and returns the upserted row's
  // status/error so the operator sees the failure inline without
  // waiting for the 30-min worker tick. Still honors the same kill
  // switches: it returns 503 if the system setting is disabled or the
  // queue is paused so manual triggers can't bypass the gate.
  app.post(
    "/api/admin/front/analytics-coverage/refresh-month",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown; forceSearchFallback?: unknown }>, res) => {
      try {
        const raw = req.body?.month;
        if (typeof raw !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
          return res
            .status(400)
            .json({ error: "month must be a YYYY-MM string" });
        }
        // Task #1691 — operator-only flag for the Retry button on
        // plan-limited rows: skip the guaranteed-403 Analytics submit
        // and go straight to the search-API fallback.
        const forceSearchFallback = req.body?.forceSearchFallback === true;
        const [yy, mm] = raw.split("-").map(Number);
        const monthStart = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0, 0));
        const monthEnd = new Date(Date.UTC(yy, mm, 1, 0, 0, 0, 0));
        const now = new Date();
        const currentMonth = `${now.getUTCFullYear()}-${String(
          now.getUTCMonth() + 1,
        ).padStart(2, "0")}`;
        const isCurrentMonth = raw === currentMonth;

        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const { SETTING_REFRESH_ENABLED, refreshMonth, QUEUE_NAME } =
          await import("../../services/frontAnalyticsCoverage");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(
          SETTING_REFRESH_ENABLED,
        ).catch(() => null);
        const enabled =
          enabledSetting?.value == null
            ? true
            : enabledSetting.value === "true";
        if (!enabled) {
          return res
            .status(503)
            .json(refreshDisabledBlocked(SETTING_REFRESH_ENABLED));
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json(queuePausedBlocked(QUEUE_NAME));
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json(killSwitchBlocked());
        }

        const userId: string | undefined = req.user?.claims?.sub;
        // Task #1780 — operator clicks Retry / Retry (search) must
        // force a re-run even on rows the worker would otherwise
        // short-circuit as "clean finalized". `forceRerun: true` is
        // the only thing that bypasses `isExistingFinalizedClean`;
        // every other safety gate (kill switches above, queue pause,
        // requireTeamLead) is still honored.
        const result = await refreshMonth({
          month: raw,
          monthStart,
          monthEnd,
          isCurrentMonth,
          forceSearchFallback,
          forceRerun: true,
          runId: `manual${forceSearchFallback ? "-search" : ""}:${userId ?? "unknown"}:${now.toISOString()}`,
        });
        res.json(result);
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics manual refresh-month failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to refresh month" });
      }
    },
  );

  // Task #1692 — "Re-probe Analytics now". Forcibly clears
  // `analytics_plan_limited_at` for a single month and runs
  // `refreshMonth` synchronously so an operator who just upgraded
  // their Front plan doesn't have to wait out the ~7-day
  // PLAN_LIMIT_REPROBE_TTL_MS cooldown for the worker to retry
  // Analytics. Only meaningful for rows whose denominator currently
  // comes from the search fallback; behavior is harmless otherwise
  // (no-op for the column, then a normal refreshMonth).
  app.post(
    "/api/admin/front/analytics-coverage/reprobe-month",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown }>, res) => {
      try {
        const raw = req.body?.month;
        if (typeof raw !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
          return res
            .status(400)
            .json({ error: "month must be a YYYY-MM string" });
        }
        const [yy, mm] = raw.split("-").map(Number);
        const monthStart = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0, 0));
        const monthEnd = new Date(Date.UTC(yy, mm, 1, 0, 0, 0, 0));
        const now = new Date();
        const currentMonth = `${now.getUTCFullYear()}-${String(
          now.getUTCMonth() + 1,
        ).padStart(2, "0")}`;
        const isCurrentMonth = raw === currentMonth;

        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          SETTING_REFRESH_ENABLED,
          refreshMonth,
          clearPlanLimitMemo,
          getExistingMonth,
          QUEUE_NAME,
        } = await import("../../services/frontAnalyticsCoverage");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(
          SETTING_REFRESH_ENABLED,
        ).catch(() => null);
        const enabled =
          enabledSetting?.value == null
            ? true
            : enabledSetting.value === "true";
        if (!enabled) {
          return res
            .status(503)
            .json(refreshDisabledBlocked(SETTING_REFRESH_ENABLED));
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json(queuePausedBlocked(QUEUE_NAME));
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json(killSwitchBlocked());
        }

        const before = await getExistingMonth(raw);
        const hadMemo = !!before?.analyticsPlanLimitedAt;
        const previousSource = before?.denominatorSource ?? null;
        const previousMemoAt = before?.analyticsPlanLimitedAt
          ? before.analyticsPlanLimitedAt.toISOString()
          : null;

        const cleared = await clearPlanLimitMemo(raw);

        const userId: string | undefined = req.user?.claims?.sub;
        // Task #1780 — Re-probe Analytics is operator-initiated, so
        // force a re-run even on clean finalized rows. The
        // plan-limit memo has already been cleared above; the
        // remaining safety gates (kill switches, queue pause,
        // requireTeamLead) are still honored.
        const result = await refreshMonth({
          month: raw,
          monthStart,
          monthEnd,
          isCurrentMonth,
          forceRerun: true,
          runId: `reprobe:${userId ?? "unknown"}:${now.toISOString()}`,
        });

        try {
          await insertActivityLogs([
            {
              userId: userId ?? null,
              actionType: "front_analytics_reprobe_month",
              route: "/api/admin/front/analytics-coverage/reprobe-month",
              actionDetail: `Re-probed Front Analytics for ${raw} (previous source: ${previousSource ?? "unknown"}, plan-limit memo cleared: ${hadMemo}) → ${result.outcome}${result.denominatorSource ? ` (now ${result.denominatorSource})` : ""}`,
              metadata: {
                month: raw,
                previousDenominatorSource: previousSource,
                hadPlanLimitMemo: hadMemo,
                previousPlanLimitedAt: previousMemoAt,
                memoCleared: cleared,
                outcome: result.outcome,
                errorCode: (result as any).errorCode ?? null,
                denominatorSource: result.denominatorSource ?? null,
                denominatorUnit: result.denominatorUnit ?? null,
              },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            },
          ]);
        } catch (logErr: any) {
          console.error(
            "[Integrations] Front analytics reprobe-month audit log failed:",
            logErr?.message,
          );
        }

        res.json(result);
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics reprobe-month failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to re-probe month" });
      }
    },
  );

  // Task #1837 — operator-triggered backfill that re-labels every
  // `front_analytics_monthly_coverage` row's unit columns onto
  // `conversations_all` and re-pulls a units-comparable denominator
  // from Conversations Search where the row's prior denominator was
  // in Analytics-messages units. Bounded by `frontPullsBudget`
  // (default 12) so a single click can't fan out into an unbounded
  // firehose. Honors the same kill switches as `refresh-month`.
  app.post(
    "/api/admin/front/analytics-coverage/recompute",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { frontPullsBudget?: unknown }>, res) => {
      try {
        const rawBudget = req.body?.frontPullsBudget;
        const frontPullsBudget =
          typeof rawBudget === "number" && Number.isFinite(rawBudget)
            ? Math.max(0, Math.floor(rawBudget))
            : undefined;

        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          SETTING_REFRESH_ENABLED,
          recomputeAllMonths,
          QUEUE_NAME,
        } = await import("../../services/frontAnalyticsCoverage");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(
          SETTING_REFRESH_ENABLED,
        ).catch(() => null);
        const enabled =
          enabledSetting?.value == null
            ? true
            : enabledSetting.value === "true";
        if (!enabled) {
          return res
            .status(503)
            .json(refreshDisabledBlocked(SETTING_REFRESH_ENABLED));
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json(queuePausedBlocked(QUEUE_NAME));
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json(killSwitchBlocked());
        }

        const result = await recomputeAllMonths({ frontPullsBudget });
        res.json(result);
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics coverage recompute failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to recompute coverage units" });
      }
    },
  );

  // Task #2439 — operator-triggered backfill that drives in-scope
  // (at/after `front_adoption_date`) historical coverage rows to a
  // message-grain (`messages_all`) denominator so every in-scope month
  // re-enters the all-time total. Front-call-free and idempotent (reuses
  // the Task #2290 free conversion via `frontPullsBudget: 0`); months that
  // lack per-direction Front counts come back in `stillExcludedMonths` for
  // the heavy Front-re-pull driver. Same gating as `/recompute`.
  app.post(
    "/api/admin/front/analytics-coverage/backfill-message-grain",
    isAuthenticated,
    requireTeamLead,
    async (_req: AuthenticatedRequest, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          SETTING_REFRESH_ENABLED,
          backfillInScopeMessageGrain,
          QUEUE_NAME,
        } = await import("../../services/frontAnalyticsCoverage");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(
          SETTING_REFRESH_ENABLED,
        ).catch(() => null);
        const enabled =
          enabledSetting?.value == null
            ? true
            : enabledSetting.value === "true";
        if (!enabled) {
          return res
            .status(503)
            .json(refreshDisabledBlocked(SETTING_REFRESH_ENABLED));
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json(queuePausedBlocked(QUEUE_NAME));
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json(killSwitchBlocked());
        }

        const result = await backfillInScopeMessageGrain();
        res.json(result);
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics coverage message-grain backfill failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to backfill message-grain denominators" });
      }
    },
  );

  // Task #2511 — the SINGLE consolidated control. Runs the free relabel first
  // (zero Front calls) then drives the remaining in-scope months to message
  // grain via the worker-pool background drain shared with the
  // `finish_front_message_grain_coverage` prod-action (same drain id →
  // single-flight + cross-instance lock guarantee one drain). Mirrors the
  // backfill route's gating (refresh enabled, queue not paused, non-critical
  // sweeps kill switch off).
  app.post(
    "/api/admin/front/analytics-coverage/finish-message-grain",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const { SETTING_REFRESH_ENABLED, QUEUE_NAME } = await import(
          "../../services/frontAnalyticsCoverage"
        );
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(
          SETTING_REFRESH_ENABLED,
        ).catch(() => null);
        const enabled =
          enabledSetting?.value == null
            ? true
            : enabledSetting.value === "true";
        if (!enabled) {
          return res
            .status(503)
            .json(refreshDisabledBlocked(SETTING_REFRESH_ENABLED));
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json(queuePausedBlocked(QUEUE_NAME));
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json(killSwitchBlocked());
        }

        const { applyFinishFrontMessageGrainCoverage } = await import(
          "../../services/prodActionsRegistry"
        );
        const result = await applyFinishFrontMessageGrainCoverage(
          req.user?.claims?.sub ?? null,
        );
        res.json(result);
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics coverage finish-message-grain failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to finish message-grain coverage" });
      }
    },
  );

  // Task #2511 — progress + explicit done-state readout for the consolidated
  // control. Returns the prod-action status (pending / not-needed / blocked)
  // plus the exact count of in-scope months still short of message grain so the
  // panel can show progress and a green "done" state (excludedMonths === 0).
  app.get(
    "/api/admin/front/analytics-coverage/finish-message-grain-status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getFinishFrontMessageGrainCoverageStatus } = await import(
          "../../services/prodActionsRegistry"
        );
        const { listInScopeNonMessageGrainMonths } = await import(
          "../../services/frontAnalyticsCoverage"
        );
        const [status, scope] = await Promise.all([
          getFinishFrontMessageGrainCoverageStatus(),
          listInScopeNonMessageGrainMonths(),
        ]);
        res.json({
          state: status.state,
          detail: status.detail,
          integration: "integration" in status ? status.integration : undefined,
          floorMonth: scope.floorMonth,
          excludedMonths: scope.months.length,
          months: scope.months.map((m) => m.month),
        });
      } catch (err: any) {
        console.error(
          "[Integrations] Front analytics coverage finish-message-grain status failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to read message-grain coverage status" });
      }
    },
  );

  // Task #2558 — operator-triggered run for the Task #2529 scheduled
  // `front_finish_message_grain` driver. Enqueues a single tick (same worker
  // path the 60-min scheduler uses) so an operator no longer has to wait up to
  // an hour after flipping the switch. Mirrors the Task #2365 upgrade trigger's
  // gating (master enable setting, queue-drain pause,
  // KILL_SWITCH_NON_CRITICAL_SWEEPS) and surfaces the Front auth breaker as a
  // calm 503 hard-gap reason instead of enqueueing a tick that can only report
  // `blocked`. GRAIN-ONLY — the tick invokes the shared finish apply path
  // (relabel + per-message enumeration walk), it does not drive the recovery
  // numerator.
  app.post(
    "/api/admin/front/analytics-coverage/finish-message-grain-driver-run",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const { QUEUE_NAME, SETTING_ENABLED } = await import(
          "../../services/frontFinishMessageGrainDriver"
        );
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { frontAuthBreakerActive } = await import(
          "../../services/frontAuthBreaker"
        );
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(SETTING_ENABLED).catch(
          () => null,
        );
        if (enabledSetting?.value !== "true") {
          return res.status(503).json({
            error: `${SETTING_ENABLED}=false`,
            reason: `The finish-message-grain driver is turned off, so nothing was run. Turn on the "${SETTING_ENABLED}" setting to enable it.`,
          });
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json({
            error: "queue paused via queue_drain_state",
            reason: `The finish-message-grain queue is paused, so nothing was run. Resume the "${QUEUE_NAME}" queue in queue-drain controls to enable it.`,
          });
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json({
            error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
            reason:
              "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
          });
        }
        if (frontAuthBreakerActive()) {
          return res.status(503).json({
            error: "front auth breaker open",
            reason:
              "Front authentication is down, so nothing was run. Reconnect Front first, then try again.",
          });
        }

        const { enqueueJob } = await import("../../services/workScheduler");
        const bucket = Math.floor(Date.now() / 60_000);
        const jobId = await enqueueJob({
          queueName: QUEUE_NAME,
          workloadClass: "maintenance",
          priority: 150,
          payload: {
            trigger: "operator",
            userId: req.user?.claims?.sub ?? null,
          },
          dedupeKey: `${QUEUE_NAME}:operator:${bucket}`,
          maxAttempts: 2,
        });
        try {
          await insertActivityLogs([
            {
              userId: req.user?.claims?.sub ?? null,
              actionType: "front_finish_message_grain_triggered",
              route:
                "/api/admin/front/analytics-coverage/finish-message-grain-driver-run",
              actionDetail: `Enqueued Front finish-message-grain driver tick ${jobId}`,
              metadata: { jobId },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            },
          ]);
        } catch (logErr: any) {
          console.error(
            "[Integrations] Front finish-message-grain driver audit log failed:",
            logErr?.message,
          );
        }
        return res.status(202).json({ status: "enqueued", jobId });
      } catch (err: any) {
        console.error(
          "[Integrations] Front finish-message-grain driver trigger failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to enqueue finish-message-grain driver tick" });
      }
    },
  );

  // Task #2558 — operator readout for the Task #2529 scheduled
  // `front_finish_message_grain` driver. Pure read: surfaces the current gating
  // config (enabled / paused / kill switch / Front auth breaker) plus the
  // driver's persisted last-tick summary (via `readLastFinishMessageGrainRun`).
  // No Front API call — reads system_settings only. Companion to the manual
  // Task #2511 `finish-message-grain-status` consolidated-control readout.
  app.get(
    "/api/admin/front/analytics-coverage/finish-message-grain-driver-status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const { SETTING_ENABLED, QUEUE_NAME, readLastFinishMessageGrainRun } =
          await import("../../services/frontFinishMessageGrainDriver");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { frontAuthBreakerActive } = await import(
          "../../services/frontAuthBreaker"
        );
        const { PERF } = await import("../../perfConfig");

        const [enabledSetting, lastRunRead] = await Promise.all([
          getSystemSetting(SETTING_ENABLED).catch(() => null),
          readLastFinishMessageGrainRun(),
        ]);

        res.json({
          config: {
            enabled: enabledSetting?.value === "true",
            paused: isQueuePaused(QUEUE_NAME),
            killSwitchNonCriticalSweeps: PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS,
            frontAuthBreakerOpen: frontAuthBreakerActive(),
          },
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
        });
      } catch (err: any) {
        console.error(
          "[Integrations] Front finish-message-grain driver status failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load finish-message-grain driver status" });
      }
    },
  );

  // Task #1984 — operator-triggered close-outbound-gap run. Enqueues a
  // `front_outbound_gap_close` job (same worker path the scheduler uses)
  // so months with a positive `messages_outbound_gap` are driven back
  // through the historical-recovery ingestion pipeline. Mirrors the
  // gating of the close-gap tick (master enable setting, queue-drain
  // pause, KILL_SWITCH_NON_CRITICAL_SWEEPS) and surfaces the
  // per-message-materialization dependency as a calm 503 hard-gap reason
  // instead of silently enqueueing a job that cannot help.
  app.post(
    "/api/admin/front/analytics-coverage/close-outbound-gap",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown }>, res) => {
      try {
        // Task #2057 — an optional `{ month }` scopes the run to a single
        // month (the per-row "Run" action) instead of the worst-gap-first
        // budgeted run. Validate the YYYY-MM shape up front so a bad value
        // never reaches the worker.
        const rawMonth = req.body?.month;
        let month: string | undefined;
        if (rawMonth != null && rawMonth !== "") {
          if (
            typeof rawMonth !== "string" ||
            !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth)
          ) {
            return res
              .status(400)
              .json({ error: "month must be a YYYY-MM string" });
          }
          month = rawMonth;
        }

        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          QUEUE_NAME,
          SETTING_ENABLED,
          REQUIRED_MATERIALIZATION_SWITCH,
        } = await import("../../services/frontOutboundGapCloser");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { isPoolEpicSwitchEnabled } = await import(
          "../../services/poolEpicKillSwitches"
        );
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(SETTING_ENABLED).catch(
          () => null,
        );
        const enabled = enabledSetting?.value === "true";
        if (!enabled) {
          return res.status(503).json({
            error: `${SETTING_ENABLED}=false`,
            reason: `The outbound gap closer is turned off, so nothing was run. Turn on the "${SETTING_ENABLED}" setting to enable it.`,
          });
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json({
            error: "queue paused via queue_drain_state",
            reason: `The outbound gap-close queue is paused, so nothing was run. Resume the "${QUEUE_NAME}" queue in queue-drain controls to enable it.`,
          });
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json({
            error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
            reason: "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
          });
        }
        if (!isPoolEpicSwitchEnabled(REQUIRED_MATERIALIZATION_SWITCH)) {
          return res.status(503).json({
            error: `per-message materialization disabled — flip ${REQUIRED_MATERIALIZATION_SWITCH} ON first`,
            reason: `Per-message materialization is off, so a gap-close run can't help yet. Turn on the "${REQUIRED_MATERIALIZATION_SWITCH}" switch first.`,
          });
        }

        const { enqueueJob } = await import("../../services/workScheduler");
        const bucket = Math.floor(Date.now() / 60_000);
        // Scope the dedupe key by month so a per-month run never collapses
        // into a concurrent all-months run (and vice versa).
        const jobId = await enqueueJob({
          queueName: QUEUE_NAME,
          workloadClass: "maintenance",
          priority: 150,
          payload: {
            trigger: "operator",
            userId: req.user?.claims?.sub ?? null,
            ...(month ? { month } : {}),
          },
          dedupeKey: `${QUEUE_NAME}:operator:${month ?? "all"}:${bucket}`,
          maxAttempts: 2,
        });
        try {
          await insertActivityLogs([
            {
              userId: req.user?.claims?.sub ?? null,
              actionType: "front_outbound_gap_close_triggered",
              route: "/api/admin/front/analytics-coverage/close-outbound-gap",
              actionDetail: month
                ? `Enqueued Front outbound gap-close job ${jobId} scoped to ${month}`
                : `Enqueued Front outbound gap-close job ${jobId}`,
              metadata: { jobId, month: month ?? null },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            },
          ]);
        } catch (logErr: any) {
          console.error(
            "[Integrations] Front outbound gap-close audit log failed:",
            logErr?.message,
          );
        }
        return res.status(202).json({ status: "enqueued", jobId, month: month ?? null });
      } catch (err: any) {
        console.error(
          "[Integrations] Front outbound gap-close trigger failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to enqueue outbound gap-close" });
      }
    },
  );

  // Task #2021 — operator readout for the outbound gap-close driver.
  // Pure read: surfaces (1) per-month `messages_outbound_gap` worst-gap
  // first so operators can confirm the gap is shrinking, (2) the last
  // tick's persisted summary (attempted months, skipped + reason,
  // RECOVERY_CAP_REACHED deferrals), and (3) the current gating config
  // (enabled, per-message-materialization dependency, queue pause,
  // per-tick budget) so a month stuck on a hard-gap reason is obvious.
  // No Front API call — reads the cached coverage table + system_settings.
  app.get(
    "/api/admin/front/analytics-coverage/outbound-gap-status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          SETTING_ENABLED,
          SETTING_MAX_MONTHS_PER_TICK,
          REQUIRED_MATERIALIZATION_SWITCH,
          QUEUE_NAME,
          selectOutboundGapMonths,
          readLastOutboundGapCloseRun,
          readUnreadableAlertConfig,
        } = await import("../../services/frontOutboundGapCloser");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { isPoolEpicSwitchEnabled } = await import(
          "../../services/poolEpicKillSwitches"
        );
        const { PERF } = await import("../../perfConfig");

        const [
          enabledSetting,
          maxMonthsSetting,
          lastRunRead,
          gapMonths,
          unreadableAlert,
        ] = await Promise.all([
          getSystemSetting(SETTING_ENABLED).catch(() => null),
          getSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => null),
          readLastOutboundGapCloseRun(),
          // Cap the readout list; worst-gap-first ORDER BY already
          // surfaces the months that matter most.
          selectOutboundGapMonths(60),
          readUnreadableAlertConfig(),
        ]);

        const maxRaw = Number(maxMonthsSetting?.value);
        res.json({
          config: {
            enabled: enabledSetting?.value === "true",
            materializationEnabled: isPoolEpicSwitchEnabled(
              REQUIRED_MATERIALIZATION_SWITCH,
            ),
            materializationSwitch: REQUIRED_MATERIALIZATION_SWITCH,
            paused: isQueuePaused(QUEUE_NAME),
            // Task #2081 — mirror the route's KILL_SWITCH_NON_CRITICAL_SWEEPS
            // 503 gate so the panel can disable "Run now" proactively
            // instead of letting the admin POST a run that's blocked.
            killSwitchNonCriticalSweeps: PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS,
            maxMonthsPerTick:
              Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 1,
            // Task #2236 — corrupt-status alert tuning surfaced so the
            // panel can show + edit the cooldown / mute without raw
            // system-setting access.
            unreadableAlert,
          },
          // Existing contract preserved: `lastRun` is the parsed summary
          // or null. `lastRunStatus` distinguishes "never_run" (normal on
          // a fresh deploy) from "unreadable" (a persisted-value parse
          // failure → real persistence bug), with `lastRunError` carrying
          // the plain-English reason when unreadable.
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
          gapMonths: gapMonths.map((m) => ({
            month: m.month,
            messagesOutboundFront: m.messagesOutboundFront,
            messagesOutboundLocal: m.messagesOutboundLocal,
            messagesOutboundGap: m.messagesOutboundGap,
          })),
        });
      } catch (err: any) {
        console.error(
          "[Integrations] Front outbound gap-close status failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load outbound gap-close status" });
      }
    },
  );

  // Task #2365 — operator-triggered message-grain UPGRADE run. Enqueues a
  // `front_message_grain_upgrade` job (same worker path the scheduler
  // uses) so finalized coverage months still below `messages_all`
  // denominator grain are re-probed via the search fallback (advancing the
  // per-message enumeration walk) until they reach message grain —
  // automating the manual `reach_front_coverage_full_message_grain`
  // prod-action. Mirrors the upgrade tick gating (master enable setting,
  // queue-drain pause, KILL_SWITCH_NON_CRITICAL_SWEEPS) and surfaces the
  // per-message-enumeration dependency + Front auth breaker as calm 503
  // hard-gap reasons instead of enqueueing a job that cannot help.
  // MEASUREMENT-ONLY — re-probes the denominator, does not ingest messages.
  app.post(
    "/api/admin/front/analytics-coverage/upgrade-message-grain",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown }>, res) => {
      try {
        // An optional `{ month }` scopes the run to a single month (the
        // per-row "Upgrade" action). Validate the YYYY-MM shape up front so
        // a bad value never reaches the worker.
        const rawMonth = req.body?.month;
        let month: string | undefined;
        if (rawMonth != null && rawMonth !== "") {
          if (
            typeof rawMonth !== "string" ||
            !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth)
          ) {
            return res
              .status(400)
              .json({ error: "month must be a YYYY-MM string" });
          }
          month = rawMonth;
        }

        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          QUEUE_NAME,
          SETTING_ENABLED,
          REQUIRED_ENUM_SWITCH,
          classifyScopedMonthEligibility,
        } = await import("../../services/frontMessageGrainUpgrader");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { frontAuthBreakerActive } = await import(
          "../../services/frontAuthBreaker"
        );
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(SETTING_ENABLED).catch(
          () => null,
        );
        if (enabledSetting?.value !== "true") {
          return res.status(503).json({
            error: `${SETTING_ENABLED}=false`,
            reason: `The message-grain upgrader is turned off, so nothing was run. Turn on the "${SETTING_ENABLED}" setting to enable it.`,
          });
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json({
            error: "queue paused via queue_drain_state",
            reason: `The message-grain upgrade queue is paused, so nothing was run. Resume the "${QUEUE_NAME}" queue in queue-drain controls to enable it.`,
          });
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json({
            error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
            reason: "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
          });
        }
        const enumSetting = await getSystemSetting(REQUIRED_ENUM_SWITCH).catch(
          () => null,
        );
        if (enumSetting?.value !== "true") {
          return res.status(503).json({
            error: `per-message enumeration disabled — flip ${REQUIRED_ENUM_SWITCH} ON first`,
            reason: `Per-message enumeration is off, so an upgrade run can't reach message grain yet. Turn on the "${REQUIRED_ENUM_SWITCH}" setting first.`,
          });
        }
        if (frontAuthBreakerActive()) {
          return res.status(503).json({
            error: "front auth breaker open",
            reason: "Front authentication is down, so nothing was run. Reconnect Front first, then try again.",
          });
        }

        // For a scoped (per-row) run, reject a target that the scheduled
        // selector would never pick (not found / current / not finalized /
        // never measured / already at message grain) so a direct API caller
        // can't enqueue a guaranteed no-op job. The all-months run skips this
        // — the selector itself only returns eligible months.
        if (month) {
          const eligibility = await classifyScopedMonthEligibility(month);
          if (!eligibility.eligible) {
            const status =
              eligibility.code === "not_found"
                ? 404
                : eligibility.code === "already_message_grain"
                  ? 409
                  : 422;
            return res.status(status).json({
              error: `month ${month} ineligible: ${eligibility.code}`,
              reason: eligibility.reason,
            });
          }
        }

        const { enqueueJob } = await import("../../services/workScheduler");
        const bucket = Math.floor(Date.now() / 60_000);
        const jobId = await enqueueJob({
          queueName: QUEUE_NAME,
          workloadClass: "maintenance",
          priority: 150,
          payload: {
            trigger: "operator",
            userId: req.user?.claims?.sub ?? null,
            ...(month ? { month } : {}),
          },
          dedupeKey: `${QUEUE_NAME}:operator:${month ?? "all"}:${bucket}`,
          maxAttempts: 2,
        });
        try {
          await insertActivityLogs([
            {
              userId: req.user?.claims?.sub ?? null,
              actionType: "front_message_grain_upgrade_triggered",
              route:
                "/api/admin/front/analytics-coverage/upgrade-message-grain",
              actionDetail: month
                ? `Enqueued Front message-grain upgrade job ${jobId} scoped to ${month}`
                : `Enqueued Front message-grain upgrade job ${jobId}`,
              metadata: { jobId, month: month ?? null },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            },
          ]);
        } catch (logErr: any) {
          console.error(
            "[Integrations] Front message-grain upgrade audit log failed:",
            logErr?.message,
          );
        }
        return res
          .status(202)
          .json({ status: "enqueued", jobId, month: month ?? null });
      } catch (err: any) {
        console.error(
          "[Integrations] Front message-grain upgrade trigger failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to enqueue message-grain upgrade" });
      }
    },
  );

  // Task #2365 — operator readout for the message-grain upgrade driver.
  // Pure read: surfaces (1) the finalized months still below `messages_all`
  // grain (oldest first, the order the driver converges them in), (2) the
  // last tick's persisted summary, and (3) the current gating config
  // (enabled, per-message-enumeration dependency, queue pause, kill switch,
  // per-tick budget) so a month stuck on a hard-gap reason is obvious. No
  // Front API call — reads the cached coverage table + system_settings.
  app.get(
    "/api/admin/front/analytics-coverage/message-grain-upgrade-status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          SETTING_ENABLED,
          SETTING_MAX_MONTHS_PER_TICK,
          REQUIRED_ENUM_SWITCH,
          QUEUE_NAME,
          selectMessageGrainUpgradeMonths,
          readLastMessageGrainUpgradeRun,
        } = await import("../../services/frontMessageGrainUpgrader");
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { frontAuthBreakerActive } = await import(
          "../../services/frontAuthBreaker"
        );
        const { PERF } = await import("../../perfConfig");

        const [
          enabledSetting,
          maxMonthsSetting,
          enumSetting,
          lastRunRead,
          pendingMonths,
        ] = await Promise.all([
          getSystemSetting(SETTING_ENABLED).catch(() => null),
          getSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => null),
          getSystemSetting(REQUIRED_ENUM_SWITCH).catch(() => null),
          readLastMessageGrainUpgradeRun(),
          // Cap the readout list; oldest-first ORDER BY already surfaces
          // the months the driver will convert next.
          selectMessageGrainUpgradeMonths(60),
        ]);

        const maxRaw = Number(maxMonthsSetting?.value);
        res.json({
          config: {
            enabled: enabledSetting?.value === "true",
            enumEnabled: enumSetting?.value === "true",
            enumSwitch: REQUIRED_ENUM_SWITCH,
            paused: isQueuePaused(QUEUE_NAME),
            killSwitchNonCriticalSweeps: PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS,
            frontAuthBreakerOpen: frontAuthBreakerActive(),
            maxMonthsPerTick:
              Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 1,
          },
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
          pendingMonths: pendingMonths.map((m) => ({
            month: m.month,
            denominatorUnit: m.denominatorUnit,
            appliedCoveragePct: m.appliedCoveragePct,
          })),
        });
      } catch (err: any) {
        console.error(
          "[Integrations] Front message-grain upgrade status failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load message-grain upgrade status" });
      }
    },
  );

  // Task #2010 — operator-triggered outbound-gap BACKFILL run. Enqueues a
  // `front_outbound_gap_backfill` job (same worker path the scheduler
  // uses) so months with a positive `messages_outbound_gap` are repaired
  // at message grain (single enumeration-walk per conversation, writing
  // only the missing outbound rows). Mirrors the backfill tick gating
  // (master enable setting, queue-drain pause, KILL_SWITCH_NON_CRITICAL_
  // SWEEPS). Unlike the close-gap recovery driver it does NOT depend on
  // the per-message-materialization switch (it writes per-message rows
  // directly).
  app.post(
    "/api/admin/front/analytics-coverage/backfill-outbound-gap",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown }>, res) => {
      try {
        // Optional `{ month }` scopes the run to a single month (the
        // per-row "Backfill" action). Validate the YYYY-MM shape up front.
        const rawMonth = req.body?.month;
        let month: string | undefined;
        if (rawMonth != null && rawMonth !== "") {
          if (
            typeof rawMonth !== "string" ||
            !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth)
          ) {
            return res
              .status(400)
              .json({ error: "month must be a YYYY-MM string" });
          }
          month = rawMonth;
        }

        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const { QUEUE_NAME, SETTING_ENABLED } = await import(
          "../../services/frontOutboundGapBackfill"
        );
        const { isQueuePaused } = await import("../../services/queueDrainControl");
        const { PERF } = await import("../../perfConfig");

        const enabledSetting = await getSystemSetting(SETTING_ENABLED).catch(
          () => null,
        );
        if (enabledSetting?.value !== "true") {
          return res.status(503).json({
            error: `${SETTING_ENABLED}=false`,
            reason: `The outbound gap backfill is turned off, so nothing was run. Turn on the "${SETTING_ENABLED}" setting to enable it.`,
          });
        }
        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json({
            error: "queue paused via queue_drain_state",
            reason: `The outbound gap-backfill queue is paused, so nothing was run. Resume the "${QUEUE_NAME}" queue in queue-drain controls to enable it.`,
          });
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json({
            error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
            reason: "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
          });
        }

        const { enqueueJob } = await import("../../services/workScheduler");
        const bucket = Math.floor(Date.now() / 60_000);
        const jobId = await enqueueJob({
          queueName: QUEUE_NAME,
          workloadClass: "maintenance",
          priority: 150,
          payload: {
            trigger: "operator",
            userId: req.user?.claims?.sub ?? null,
            ...(month ? { month } : {}),
          },
          dedupeKey: `${QUEUE_NAME}:operator:${month ?? "all"}:${bucket}`,
          maxAttempts: 2,
        });
        try {
          await insertActivityLogs([
            {
              userId: req.user?.claims?.sub ?? null,
              actionType: "front_outbound_gap_backfill_triggered",
              route: "/api/admin/front/analytics-coverage/backfill-outbound-gap",
              actionDetail: month
                ? `Enqueued Front outbound gap-backfill job ${jobId} scoped to ${month}`
                : `Enqueued Front outbound gap-backfill job ${jobId}`,
              metadata: { jobId, month: month ?? null },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            },
          ]);
        } catch (logErr: any) {
          console.error(
            "[Integrations] Front outbound gap-backfill audit log failed:",
            logErr?.message,
          );
        }
        return res
          .status(202)
          .json({ status: "enqueued", jobId, month: month ?? null });
      } catch (err: any) {
        console.error(
          "[Integrations] Front outbound gap-backfill trigger failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to enqueue outbound gap-backfill" });
      }
    },
  );

  // Task #2010 — operator readout for the outbound gap-backfill driver.
  // Pure read: surfaces the gating config, the last tick's persisted
  // summary (months attempted, rows inserted/skipped, reason), and the
  // worst-gap-first month list. No Front API call.
  app.get(
    "/api/admin/front/analytics-coverage/backfill-outbound-gap-status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getSystemSetting } = await import("../../storage/settingsStorage");
        const {
          SETTING_ENABLED,
          SETTING_MAX_MONTHS_PER_TICK,
          QUEUE_NAME,
          getLastOutboundGapBackfillRun,
        } = await import("../../services/frontOutboundGapBackfill");
        const { selectOutboundGapMonths } = await import(
          "../../services/frontOutboundGapCloser"
        );
        const { isQueuePaused } = await import("../../services/queueDrainControl");

        const [enabledSetting, maxMonthsSetting, lastRun, gapMonths] =
          await Promise.all([
            getSystemSetting(SETTING_ENABLED).catch(() => null),
            getSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => null),
            getLastOutboundGapBackfillRun(),
            selectOutboundGapMonths(60),
          ]);

        const maxRaw = Number(maxMonthsSetting?.value);
        res.json({
          config: {
            enabled: enabledSetting?.value === "true",
            paused: isQueuePaused(QUEUE_NAME),
            maxMonthsPerTick:
              Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 1,
          },
          lastRun,
          gapMonths: gapMonths.map((m) => ({
            month: m.month,
            messagesOutboundFront: m.messagesOutboundFront,
            messagesOutboundLocal: m.messagesOutboundLocal,
            messagesOutboundGap: m.messagesOutboundGap,
          })),
        });
      } catch (err: any) {
        console.error(
          "[Integrations] Front outbound gap-backfill status failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load outbound gap-backfill status" });
      }
    },
  );

  // Task #2236 — operator override for the corrupt-status admin alert
  // (Task #2197). Lets a team_lead / CEO tune the cooldown between
  // repeat alerts or mute the alert entirely from the Front integration
  // panel instead of editing raw system settings. Validation lives in
  // the service (`setUnreadableAlertConfig`); a bad cooldown throws a
  // RangeError that maps to 400. Either field is optional, but the body
  // must change at least one.
  app.post(
    "/api/admin/front/analytics-coverage/unreadable-alert-config",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { cooldownMinutes?: unknown; muted?: unknown }>, res) => {
      try {
        const body = req.body ?? {};
        const patch: { cooldownMinutes?: number; muted?: boolean } = {};

        if (body.cooldownMinutes !== undefined) {
          if (typeof body.cooldownMinutes !== "number") {
            return res
              .status(400)
              .json({ error: "cooldownMinutes must be a number" });
          }
          patch.cooldownMinutes = body.cooldownMinutes;
        }
        if (body.muted !== undefined) {
          if (typeof body.muted !== "boolean") {
            return res
              .status(400)
              .json({ error: "muted must be a boolean" });
          }
          patch.muted = body.muted;
        }
        if (patch.cooldownMinutes === undefined && patch.muted === undefined) {
          return res.status(400).json({
            error: "Provide cooldownMinutes and/or muted to update",
          });
        }

        const { setUnreadableAlertConfig } = await import(
          "../../services/frontOutboundGapCloser"
        );
        // system_settings.updated_by is a bare FK to users.id.
        const userId: string | undefined = req.user?.claims?.sub;
        const updated = await setUnreadableAlertConfig(patch, userId);
        res.json(updated);
      } catch (err: any) {
        if (err instanceof RangeError) {
          return res.status(400).json({ error: err.message });
        }
        console.error(
          "[Integrations] Front unreadable-alert config update failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to update corrupt-status alert config" });
      }
    },
  );

  // Task #1645 — admin editor for Front Analytics coverage alert thresholds.
  app.get(
    "/api/admin/front/analytics-coverage/alerts",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const {
          getFrontAnalyticsCoverageAlertConfig,
          DEFAULTS,
          MIN_DROP_DELTA_PCT,
          MAX_DROP_DELTA_PCT,
          MIN_MONTH_FLOOR_PCT,
          MAX_MONTH_FLOOR_PCT,
          MIN_FLOOR_RAISE_REGROWTH_PCT,
          MAX_FLOOR_RAISE_REGROWTH_PCT,
          SETTING_ENABLED,
          SETTING_DROP_DELTA_PCT,
          SETTING_MONTH_FLOOR_PCT,
          SETTING_COMPLETENESS_ALERTS_ENABLED,
          SETTING_FLOOR_RAISE_ALERTS_ENABLED,
          SETTING_FLOOR_RAISE_REGROWTH_PCT,
        } = await import("../../services/frontAnalyticsCoverageAlerts");
        const cfg = await getFrontAnalyticsCoverageAlertConfig();
        const [
          enabledSetting,
          dropSetting,
          floorSetting,
          completenessSetting,
          floorRaiseEnabledSetting,
          floorRaiseRegrowthSetting,
        ] = await Promise.all([
          storage.getSystemSetting(SETTING_ENABLED),
          storage.getSystemSetting(SETTING_DROP_DELTA_PCT),
          storage.getSystemSetting(SETTING_MONTH_FLOOR_PCT),
          storage.getSystemSetting(SETTING_COMPLETENESS_ALERTS_ENABLED),
          storage.getSystemSetting(SETTING_FLOOR_RAISE_ALERTS_ENABLED),
          storage.getSystemSetting(SETTING_FLOOR_RAISE_REGROWTH_PCT),
        ]);
        const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
        const userMap = await resolveLastEditedUsers([
          enabledSetting?.updatedBy,
          dropSetting?.updatedBy,
          floorSetting?.updatedBy,
          completenessSetting?.updatedBy,
          floorRaiseEnabledSetting?.updatedBy,
          floorRaiseRegrowthSetting?.updatedBy,
        ]);
        return res.json({
          enabled: cfg.enabled,
          dropDeltaPct: cfg.dropDeltaPct,
          monthFloorPct: cfg.monthFloorPct,
          completenessAlertsEnabled: cfg.completenessAlertsEnabled,
          floorRaiseAlertsEnabled: cfg.floorRaiseAlertsEnabled,
          floorRaiseRegrowthPct: cfg.floorRaiseRegrowthPct,
          defaultEnabled: DEFAULTS.enabled,
          defaultDropDeltaPct: DEFAULTS.dropDeltaPct,
          defaultMonthFloorPct: DEFAULTS.monthFloorPct,
          defaultCompletenessAlertsEnabled: DEFAULTS.completenessAlertsEnabled,
          defaultFloorRaiseAlertsEnabled: DEFAULTS.floorRaiseAlertsEnabled,
          defaultFloorRaiseRegrowthPct: DEFAULTS.floorRaiseRegrowthPct,
          minDropDeltaPct: MIN_DROP_DELTA_PCT,
          maxDropDeltaPct: MAX_DROP_DELTA_PCT,
          minMonthFloorPct: MIN_MONTH_FLOOR_PCT,
          maxMonthFloorPct: MAX_MONTH_FLOOR_PCT,
          minFloorRaiseRegrowthPct: MIN_FLOOR_RAISE_REGROWTH_PCT,
          maxFloorRaiseRegrowthPct: MAX_FLOOR_RAISE_REGROWTH_PCT,
          enabledLastEdited: enabledSetting
            ? buildLastEdited(enabledSetting.updatedAt, enabledSetting.updatedBy, userMap)
            : null,
          dropDeltaPctLastEdited: dropSetting
            ? buildLastEdited(dropSetting.updatedAt, dropSetting.updatedBy, userMap)
            : null,
          monthFloorPctLastEdited: floorSetting
            ? buildLastEdited(floorSetting.updatedAt, floorSetting.updatedBy, userMap)
            : null,
          completenessAlertsEnabledLastEdited: completenessSetting
            ? buildLastEdited(
                completenessSetting.updatedAt,
                completenessSetting.updatedBy,
                userMap,
              )
            : null,
          floorRaiseAlertsEnabledLastEdited: floorRaiseEnabledSetting
            ? buildLastEdited(
                floorRaiseEnabledSetting.updatedAt,
                floorRaiseEnabledSetting.updatedBy,
                userMap,
              )
            : null,
          floorRaiseRegrowthPctLastEdited: floorRaiseRegrowthSetting
            ? buildLastEdited(
                floorRaiseRegrowthSetting.updatedAt,
                floorRaiseRegrowthSetting.updatedBy,
                userMap,
              )
            : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.put(
    "/api/admin/front/analytics-coverage/alerts",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { enabled?: unknown; dropDeltaPct?: unknown; monthFloorPct?: unknown; completenessAlertsEnabled?: unknown; floorRaiseAlertsEnabled?: unknown; floorRaiseRegrowthPct?: unknown }>, res) => {
      try {
        const {
          getFrontAnalyticsCoverageAlertConfig,
          setFrontAnalyticsCoverageAlertEnabled,
          setFrontAnalyticsCoverageDropDeltaPct,
          setFrontAnalyticsCoverageMonthFloorPct,
          setFrontAnalyticsCompletenessAlertsEnabled,
          setFrontAnalyticsFloorRaiseAlertsEnabled,
          setFrontAnalyticsFloorRaiseRegrowthPct,
          SETTING_ENABLED,
          SETTING_DROP_DELTA_PCT,
          SETTING_MONTH_FLOOR_PCT,
          SETTING_COMPLETENESS_ALERTS_ENABLED,
          SETTING_FLOOR_RAISE_ALERTS_ENABLED,
          SETTING_FLOOR_RAISE_REGROWTH_PCT,
        } = await import("../../services/frontAnalyticsCoverageAlerts");
        const updatedBy = req.user?.claims?.sub || req.user?.id || "system";
        const before = await getFrontAnalyticsCoverageAlertConfig();

        let savedEnabled = before.enabled;
        let savedDrop = before.dropDeltaPct;
        let savedFloor = before.monthFloorPct;
        let savedCompleteness = before.completenessAlertsEnabled;
        let savedFloorRaiseEnabled = before.floorRaiseAlertsEnabled;
        let savedFloorRaiseRegrowth = before.floorRaiseRegrowthPct;

        if (typeof req.body?.enabled === "boolean") {
          savedEnabled = await setFrontAnalyticsCoverageAlertEnabled(
            req.body.enabled,
            String(updatedBy),
          );
        }
        if (req.body?.dropDeltaPct != null) {
          savedDrop = await setFrontAnalyticsCoverageDropDeltaPct(
            Number(req.body.dropDeltaPct),
            String(updatedBy),
          );
        }
        if (req.body?.monthFloorPct != null) {
          savedFloor = await setFrontAnalyticsCoverageMonthFloorPct(
            Number(req.body.monthFloorPct),
            String(updatedBy),
          );
        }
        if (typeof req.body?.completenessAlertsEnabled === "boolean") {
          savedCompleteness = await setFrontAnalyticsCompletenessAlertsEnabled(
            req.body.completenessAlertsEnabled,
            String(updatedBy),
          );
        }
        if (typeof req.body?.floorRaiseAlertsEnabled === "boolean") {
          savedFloorRaiseEnabled = await setFrontAnalyticsFloorRaiseAlertsEnabled(
            req.body.floorRaiseAlertsEnabled,
            String(updatedBy),
          );
        }
        if (req.body?.floorRaiseRegrowthPct != null) {
          savedFloorRaiseRegrowth = await setFrontAnalyticsFloorRaiseRegrowthPct(
            Number(req.body.floorRaiseRegrowthPct),
            String(updatedBy),
          );
        }

        if (before.enabled !== savedEnabled) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_ENABLED,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { enabled: before.enabled },
              newValues: { enabled: savedEnabled },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front analytics coverage-alert enabled audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.dropDeltaPct !== savedDrop) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_DROP_DELTA_PCT,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { dropDeltaPct: before.dropDeltaPct },
              newValues: { dropDeltaPct: savedDrop },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front analytics coverage-alert drop audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.monthFloorPct !== savedFloor) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_MONTH_FLOOR_PCT,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { monthFloorPct: before.monthFloorPct },
              newValues: { monthFloorPct: savedFloor },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front analytics coverage-alert floor audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.completenessAlertsEnabled !== savedCompleteness) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_COMPLETENESS_ALERTS_ENABLED,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: {
                completenessAlertsEnabled: before.completenessAlertsEnabled,
              },
              newValues: { completenessAlertsEnabled: savedCompleteness },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front analytics coverage-alert completeness audit failed:",
              auditErr?.message,
            );
          }
        }

        if (before.floorRaiseAlertsEnabled !== savedFloorRaiseEnabled) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_FLOOR_RAISE_ALERTS_ENABLED,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: {
                floorRaiseAlertsEnabled: before.floorRaiseAlertsEnabled,
              },
              newValues: { floorRaiseAlertsEnabled: savedFloorRaiseEnabled },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front analytics coverage-alert floor-raise-enabled audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.floorRaiseRegrowthPct !== savedFloorRaiseRegrowth) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_FLOOR_RAISE_REGROWTH_PCT,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: {
                floorRaiseRegrowthPct: before.floorRaiseRegrowthPct,
              },
              newValues: { floorRaiseRegrowthPct: savedFloorRaiseRegrowth },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front analytics coverage-alert floor-raise-regrowth audit failed:",
              auditErr?.message,
            );
          }
        }

        return res.json({
          enabled: savedEnabled,
          dropDeltaPct: savedDrop,
          monthFloorPct: savedFloor,
          completenessAlertsEnabled: savedCompleteness,
          floorRaiseAlertsEnabled: savedFloorRaiseEnabled,
          floorRaiseRegrowthPct: savedFloorRaiseRegrowth,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid value";
        return res.status(400).json({ error: message });
      }
    },
  );


}
