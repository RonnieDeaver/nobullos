/**
 * Integrations routes — self-healing auto-closure loop (status, unpark, rearm, overnight window, regression alerts).
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 4437–4772); sections: self-healing auto-closure loop (status, unpark, rearm, overnight window, regression alerts).
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import type { AuthenticatedRequest } from "../requestContext";

export function registerIntegrationsFrontAutoClosureRoutes(app: Express) {
  // Task #1682 — Front self-healing coverage loop status (read-only).
  app.get(
    "/api/admin/front/auto-closure/status",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const { getFrontAutoClosureStatus } = await import(
          "../../services/frontAutoClosure"
        );
        const status = await getFrontAutoClosureStatus();
        return res.json(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  // Task #1885 — operator un-park for a Front recovery window that the
  // auto-closure loop has parked after N consecutive dead runs.
  app.post(
    "/api/admin/front/auto-closure/unpark",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown }>, res) => {
      try {
        const month = String(req.body?.month ?? "").trim();
        if (!/^\d{4}-\d{2}$/.test(month)) {
          return res
            .status(400)
            .json({ error: "month is required (YYYY-MM)" });
        }
        const { unparkRecoveryWindow } = await import(
          "../../services/frontAutoClosure"
        );
        const result = await unparkRecoveryWindow(month);
        return res.json(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  // Task #2085 — operator one-press re-arm of every parked Front recovery
  // window under the search strategy. Starts the same background drain
  // the CEO `rearm_parked_front_recovery_windows` prod-action drives, so
  // both surfaces share one drain implementation. Returns immediately;
  // the worker-pool drain processes one window per chunk.
  app.post(
    "/api/admin/front/auto-closure/rearm",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res) => {
      try {
        const actorId = req.user?.claims?.sub ?? null;
        const { startParkedWindowReArmDrain } = await import(
          "../../services/frontAutoClosure"
        );
        const result = await startParkedWindowReArmDrain(actorId);
        return res.json(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  // Task #2098 — operator re-arm of a SINGLE parked Front recovery window
  // under the search strategy. Mirrors the all-windows rearm route but
  // accepts one `month` (YYYY-MM) and starts a per-month worker-pool
  // background drain via `startOneParkedWindowReArmDrain`. Returns
  // immediately; status flips back via the auto-closure status poll.
  app.post(
    "/api/admin/front/auto-closure/rearm-one",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { month?: unknown }>, res) => {
      try {
        const month = String(req.body?.month ?? "").trim();
        if (!/^\d{4}-\d{2}$/.test(month)) {
          return res
            .status(400)
            .json({ error: "month is required (YYYY-MM)" });
        }
        const actorId = req.user?.claims?.sub ?? null;
        const { startOneParkedWindowReArmDrain } = await import(
          "../../services/frontAutoClosure"
        );
        const result = await startOneParkedWindowReArmDrain(month, actorId);
        return res.json({ ...result, month });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  // Task #1695 — admin editor for Front auto-closure overnight aggressive mode.
  app.get(
    "/api/admin/front/auto-closure/overnight",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const {
          getFrontAutoClosureStatus,
          SETTING_OVERNIGHT_ENABLED,
          SETTING_OVERNIGHT_TIMEZONE,
          SETTING_OVERNIGHT_START_HOUR,
          SETTING_OVERNIGHT_END_HOUR,
          SETTING_OVERNIGHT_RETRY_BUDGET,
          SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET,
          SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET,
          OVERNIGHT_HOUR_MIN,
          OVERNIGHT_HOUR_MAX,
          OVERNIGHT_RETRY_BUDGET_MIN,
          OVERNIGHT_RETRY_BUDGET_MAX,
          OVERNIGHT_INGEST_RECOVERY_BUDGET_MIN,
          OVERNIGHT_INGEST_RECOVERY_BUDGET_MAX,
          OVERNIGHT_APPLY_NUDGE_BUDGET_MIN,
          OVERNIGHT_APPLY_NUDGE_BUDGET_MAX,
        } = await import("../../services/frontAutoClosure");
        const status = await getFrontAutoClosureStatus();
        const keys = [
          SETTING_OVERNIGHT_ENABLED,
          SETTING_OVERNIGHT_TIMEZONE,
          SETTING_OVERNIGHT_START_HOUR,
          SETTING_OVERNIGHT_END_HOUR,
          SETTING_OVERNIGHT_RETRY_BUDGET,
          SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET,
          SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET,
        ];
        const settings = await Promise.all(
          keys.map((k) => storage.getSystemSetting(k)),
        );
        const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
        const userMap = await resolveLastEditedUsers(
          settings.map((s) => s?.updatedBy),
        );
        const lastEditedFor = (idx: number) =>
          settings[idx]
            ? buildLastEdited(settings[idx]!.updatedAt, settings[idx]!.updatedBy, userMap)
            : null;
        return res.json({
          currentMode: status.currentMode,
          config: {
            enabled: status.config.overnightEnabled,
            timezone: status.config.overnightTimezone,
            startHour: status.config.overnightStartHour,
            endHour: status.config.overnightEndHour,
            retryBudget: status.config.overnightRetryBudget,
            ingestRecoveryBudget: status.config.overnightIngestRecoveryBudget,
            applyNudgeBudget: status.config.overnightApplyNudgeBudget,
          },
          defaults: {
            enabled: status.defaults.overnightEnabled,
            timezone: status.defaults.overnightTimezone,
            startHour: status.defaults.overnightStartHour,
            endHour: status.defaults.overnightEndHour,
            retryBudget: status.defaults.overnightRetryBudget,
            ingestRecoveryBudget: status.defaults.overnightIngestRecoveryBudget,
            applyNudgeBudget: status.defaults.overnightApplyNudgeBudget,
          },
          bounds: {
            hourMin: OVERNIGHT_HOUR_MIN,
            hourMax: OVERNIGHT_HOUR_MAX,
            retryBudgetMin: OVERNIGHT_RETRY_BUDGET_MIN,
            retryBudgetMax: OVERNIGHT_RETRY_BUDGET_MAX,
            ingestRecoveryBudgetMin: OVERNIGHT_INGEST_RECOVERY_BUDGET_MIN,
            ingestRecoveryBudgetMax: OVERNIGHT_INGEST_RECOVERY_BUDGET_MAX,
            applyNudgeBudgetMin: OVERNIGHT_APPLY_NUDGE_BUDGET_MIN,
            applyNudgeBudgetMax: OVERNIGHT_APPLY_NUDGE_BUDGET_MAX,
          },
          lastEdited: {
            enabled: lastEditedFor(0),
            timezone: lastEditedFor(1),
            startHour: lastEditedFor(2),
            endHour: lastEditedFor(3),
            retryBudget: lastEditedFor(4),
            ingestRecoveryBudget: lastEditedFor(5),
            applyNudgeBudget: lastEditedFor(6),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.put(
    "/api/admin/front/auto-closure/overnight",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { enabled?: boolean; timezone?: string; startHour?: number; endHour?: number; retryBudget?: number; ingestRecoveryBudget?: number; applyNudgeBudget?: number }>, res) => {
      try {
        const {
          updateOvernightConfig,
          getFrontAutoClosureStatus,
          SETTING_OVERNIGHT_ENABLED,
          SETTING_OVERNIGHT_TIMEZONE,
          SETTING_OVERNIGHT_START_HOUR,
          SETTING_OVERNIGHT_END_HOUR,
          SETTING_OVERNIGHT_RETRY_BUDGET,
          SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET,
          SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET,
        } = await import("../../services/frontAutoClosure");
        const updatedBy = req.user?.claims?.sub || req.user?.id || "system";
        const before = (await getFrontAutoClosureStatus()).config;

        const body = req.body ?? {};
        const update: import("../../services/frontAutoClosure").OvernightConfigUpdate = {};
        if (body.enabled !== undefined) update.enabled = body.enabled;
        if (body.timezone !== undefined) update.timezone = body.timezone;
        if (body.startHour !== undefined) update.startHour = body.startHour;
        if (body.endHour !== undefined) update.endHour = body.endHour;
        if (body.retryBudget !== undefined) update.retryBudget = body.retryBudget;
        if (body.ingestRecoveryBudget !== undefined)
          update.ingestRecoveryBudget = body.ingestRecoveryBudget;
        if (body.applyNudgeBudget !== undefined)
          update.applyNudgeBudget = body.applyNudgeBudget;

        if (Object.keys(update).length === 0) {
          return res.status(400).json({ error: "no fields provided" });
        }

        const after = await updateOvernightConfig(update, String(updatedBy));

        const audits: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
        const maybe = (
          field: keyof typeof update,
          key: string,
          oldVal: unknown,
          newVal: unknown,
        ) => {
          if (update[field] !== undefined && oldVal !== newVal) {
            audits.push({ key, oldValue: oldVal, newValue: newVal });
          }
        };
        maybe("enabled", SETTING_OVERNIGHT_ENABLED, before.overnightEnabled, after.overnightEnabled);
        maybe("timezone", SETTING_OVERNIGHT_TIMEZONE, before.overnightTimezone, after.overnightTimezone);
        maybe("startHour", SETTING_OVERNIGHT_START_HOUR, before.overnightStartHour, after.overnightStartHour);
        maybe("endHour", SETTING_OVERNIGHT_END_HOUR, before.overnightEndHour, after.overnightEndHour);
        maybe("retryBudget", SETTING_OVERNIGHT_RETRY_BUDGET, before.overnightRetryBudget, after.overnightRetryBudget);
        maybe(
          "ingestRecoveryBudget",
          SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET,
          before.overnightIngestRecoveryBudget,
          after.overnightIngestRecoveryBudget,
        );
        maybe(
          "applyNudgeBudget",
          SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET,
          before.overnightApplyNudgeBudget,
          after.overnightApplyNudgeBudget,
        );
        for (const a of audits) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: a.key,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { value: a.oldValue },
              newValues: { value: a.newValue },
            });
          } catch (auditErr: any) {
            console.error(
              `[Integrations] Front auto-closure overnight audit failed (${a.key}):`,
              auditErr?.message,
            );
          }
        }

        return res.json({
          config: {
            enabled: after.overnightEnabled,
            timezone: after.overnightTimezone,
            startHour: after.overnightStartHour,
            endHour: after.overnightEndHour,
            retryBudget: after.overnightRetryBudget,
            ingestRecoveryBudget: after.overnightIngestRecoveryBudget,
            applyNudgeBudget: after.overnightApplyNudgeBudget,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid value";
        return res.status(400).json({ error: message });
      }
    },
  );

  // Task #1693 — Front auto-closure regression alert status (read-only).
  app.get(
    "/api/admin/front/auto-closure/regression-alert-status",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const { getFrontAutoClosureRegressionAlertStatus } = await import(
          "../../services/frontAutoClosureRegressionAlerts"
        );
        const status = await getFrontAutoClosureRegressionAlertStatus();
        return res.json(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  // Task #1693 — operator-triggered manual re-evaluation.
  app.post(
    "/api/admin/front/auto-closure/regression-alert-status/re-evaluate",
    isAuthenticated,
    requireTeamLead,
    async (_req: AuthenticatedRequest, res) => {
      try {
        const {
          runFrontAutoClosureRegressionAlertCheck,
          getFrontAutoClosureRegressionAlertStatus,
        } = await import("../../services/frontAutoClosureRegressionAlerts");
        const result = await runFrontAutoClosureRegressionAlertCheck();
        const status = await getFrontAutoClosureRegressionAlertStatus();
        return res.json({ result, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

}
