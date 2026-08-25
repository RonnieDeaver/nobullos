/**
 * Task #987: admin endpoints for the per-queue drain control system.
 * All endpoints are gated behind `requireTeamLead` like the rest of
 * the operator surface (audit retention, kill switches, rate-limit
 * multipliers). Mutations are persisted to `system_settings` by the
 * `queueDrainControl` service so they survive restarts and show up in
 * the standard system_settings audit history.
 */
import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import {
  getQueueDrainBacklogAlertConfig,
  SETTING_ENABLED,
  SETTING_HOURS,
  SETTING_GROWTH,
  SETTING_COOLDOWN,
} from "../services/queueDrainBacklogAlerts";
import {
  getQueueStarvationAlertConfig,
  SETTING_ENABLED as STARVATION_SETTING_ENABLED,
  SETTING_WINDOWS as STARVATION_SETTING_WINDOWS,
  SETTING_MIN_PENDING as STARVATION_SETTING_MIN_PENDING,
  SETTING_COOLDOWN as STARVATION_SETTING_COOLDOWN,
} from "../services/queueStarvationAlerts";
import { setSystemSetting } from "../storage/settingsStorage";
import { listNotificationDeliveries } from "../storage/notificationsStorage";

export function registerQueueControlRoutes(
  app: Express,
  requireTeamLead: any,
): void {
  app.get(
    "/api/admin/queue-control",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getDrainStateSnapshot } = await import("../services/queueDrainControl");
        const snapshot = await getDrainStateSnapshot();
        res.json({ queues: snapshot });
      } catch (err: any) {
        console.error("[QueueControl] GET failed:", err?.message);
        res.status(500).json({ error: "Failed to load queue drain state" });
      }
    },
  );

  app.post(
    "/api/admin/queue-control/:queueName/pause",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { queueName } = req.params as { queueName: string };
        const { setQueuePause } = await import("../services/queueDrainControl");
        const actor = req.user?.claims?.sub ?? null;
        // Task #1784: optional free-form note explaining *why* the
        // queue is being paused. Surfaced in the Queue Drain admin
        // card + persisted in `admin_setting_audit`.
        const rawNote = req.body?.note;
        const note =
          typeof rawNote === "string" && rawNote.trim().length > 0
            ? rawNote
            : null;
        const state = await setQueuePause(queueName, true, actor, { note });
        res.json({ queueName, ...state });
      } catch (err: any) {
        console.error("[QueueControl] pause failed:", err?.message);
        res.status(500).json({ error: err?.message ?? "Failed to pause queue" });
      }
    },
  );

  app.post(
    "/api/admin/queue-control/:queueName/resume",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { queueName } = req.params as { queueName: string };
        const { setQueuePause } = await import("../services/queueDrainControl");
        const actor = req.user?.claims?.sub ?? null;
        const state = await setQueuePause(queueName, false, actor);
        res.json({ queueName, ...state });
      } catch (err: any) {
        console.error("[QueueControl] resume failed:", err?.message);
        res.status(500).json({ error: err?.message ?? "Failed to resume queue" });
      }
    },
  );

  app.post(
    "/api/admin/queue-control/:queueName/rate-limit",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { queueName } = req.params as { queueName: string };
        const raw = req.body?.jobsPerMinute;
        let value: number | null = null;
        if (raw !== null && raw !== undefined && raw !== "") {
          const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
          if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: "jobsPerMinute must be a positive integer or null" });
          }
          value = n;
        }
        const { setQueueRateLimit } = await import("../services/queueDrainControl");
        const actor = req.user?.claims?.sub ?? null;
        const state = await setQueueRateLimit(queueName, value, actor);
        res.json({ queueName, ...state });
      } catch (err: any) {
        console.error("[QueueControl] rate-limit failed:", err?.message);
        res.status(500).json({ error: err?.message ?? "Failed to set rate limit" });
      }
    },
  );

  // ── Task #1012: paused-queue backlog alert configuration & history. ──
  // Surfaces the watcher's thresholds + recent Slack alert events next to
  // the Queue Drain Control card so operators can tune the policy without
  // editing `system_settings` directly. The per-paused-queue diagnostics
  // (paused-since, baseline, current, growth) are already returned by
  // GET /api/admin/queue-control via `getDrainStateSnapshot`, so they
  // don't need a second endpoint.
  const NOTIFICATION_ID = "queue.drain_control.paused_backlog_growing";

  app.get(
    "/api/admin/queue-control/backlog-alerts",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const [config, deliveries] = await Promise.all([
          getQueueDrainBacklogAlertConfig(),
          listNotificationDeliveries(NOTIFICATION_ID, 25).catch(() => []),
        ]);
        const recent = deliveries.map((d) => {
          const meta = (d.metadataJson ?? null) as
            | Record<string, unknown>
            | null;
          return {
            id: d.id,
            createdAt:
              d.createdAt instanceof Date
                ? d.createdAt.toISOString()
                : (d.createdAt as unknown as string),
            status: d.status,
            channelName: d.channelName,
            errorMessage: d.errorMessage,
            queueName:
              typeof meta?.queueName === "string"
                ? (meta.queueName as string)
                : null,
            pausedAt:
              typeof meta?.pausedAt === "string"
                ? (meta.pausedAt as string)
                : null,
            pausedAtBacklog:
              typeof meta?.pausedAtBacklog === "number"
                ? (meta.pausedAtBacklog as number)
                : null,
            currentPending:
              typeof meta?.currentPending === "number"
                ? (meta.currentPending as number)
                : null,
            growth:
              typeof meta?.growth === "number"
                ? (meta.growth as number)
                : null,
            hoursPaused:
              typeof meta?.hoursPaused === "number"
                ? (meta.hoursPaused as number)
                : null,
          };
        });
        res.json({ config, recent });
      } catch (err: any) {
        console.error("[QueueControl] backlog-alerts GET failed:", err?.message);
        res
          .status(500)
          .json({ error: "Failed to load backlog-alert config" });
      }
    },
  );

  app.post(
    "/api/admin/queue-control/backlog-alerts/config",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const body = req.body ?? {};
        const errors: string[] = [];

        let enabled: boolean | undefined;
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") {
            errors.push("enabled must be a boolean");
          } else {
            enabled = body.enabled;
          }
        }

        function parsePosInt(field: string, max: number): number | undefined {
          const raw = body[field];
          if (raw === undefined) return undefined;
          const n =
            typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
          if (!Number.isInteger(n) || n <= 0 || n > max) {
            errors.push(
              `${field} must be a positive integer ≤ ${max}`,
            );
            return undefined;
          }
          return n;
        }

        const hoursThreshold = parsePosInt("hoursThreshold", 24 * 30);
        const growthThreshold = parsePosInt("growthThreshold", 1_000_000);
        const cooldownMinutes = parsePosInt("cooldownMinutes", 60 * 24 * 7);

        if (errors.length > 0) {
          return res.status(400).json({ error: errors.join("; ") });
        }

        const actor = req.user?.claims?.sub ?? null;
        const writes: Array<Promise<unknown>> = [];
        if (enabled !== undefined) {
          writes.push(
            setSystemSetting(SETTING_ENABLED, enabled ? "true" : "false", actor),
          );
        }
        if (hoursThreshold !== undefined) {
          writes.push(
            setSystemSetting(SETTING_HOURS, String(hoursThreshold), actor),
          );
        }
        if (growthThreshold !== undefined) {
          writes.push(
            setSystemSetting(SETTING_GROWTH, String(growthThreshold), actor),
          );
        }
        if (cooldownMinutes !== undefined) {
          writes.push(
            setSystemSetting(SETTING_COOLDOWN, String(cooldownMinutes), actor),
          );
        }
        await Promise.all(writes);

        const config = await getQueueDrainBacklogAlertConfig();
        res.json({ config });
      } catch (err: any) {
        console.error(
          "[QueueControl] backlog-alerts config POST failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: err?.message ?? "Failed to update config" });
      }
    },
  );

  // Task #1013: send a sample paused-queue backlog alert through the
    // unified dispatcher so admins can verify the Slack channel + format
    // before an incident. Mirrors the affordance the registry already
    // declares via `supportsTest: true` and matches the per-service test
    // buttons offered by Zoom review queue, manual reserve, etc. The
    // payload uses obviously-fake numbers and is prefixed with a TEST
    // banner so on-call doesn't react.
    app.post(
      "/api/admin/queue-control/backlog-alerts/test",
      isAuthenticated,
      requireTeamLead,
      async (req: any, res) => {
        try {
          const config = await getQueueDrainBacklogAlertConfig();
          const userId = req.user?.claims?.sub ?? null;
          const { storage } = await import("../storage");
          const user = userId
            ? await storage.getUser(userId).catch(() => null)
            : null;
          const actor =
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
            user?.email ||
            "An admin";

          const samplePausedAt = new Date(
            Date.now() - (config.hoursThreshold + 1) * 3_600_000,
          ).toISOString();
          const samplePausedAtBacklog = 1_000;
          const sampleCurrentPending =
            samplePausedAtBacklog + config.growthThreshold + 50;
          const sampleGrowth = sampleCurrentPending - samplePausedAtBacklog;
          const sampleHoursPaused = config.hoursThreshold + 1;

          const text =
            `:test_tube: *TEST — Paused queue backlog alert (no action needed)*\n` +
            `${actor} sent a sample of \`queue.drain_control.paused_backlog_growing\` from the Queue Drain Control card. ` +
            `If you can read this, real backlog alerts will be delivered to this channel.\n` +
            `\n` +
            `_Sample payload (not a real incident):_\n` +
            `:warning: *Paused queue backlog is growing* — \`example_queue\`\n` +
            `• Paused for *${sampleHoursPaused}h* (since ${samplePausedAt})\n` +
            `• Pending now: *${sampleCurrentPending}* jobs (was *${samplePausedAtBacklog}* at pause — grew by *+${sampleGrowth}*)\n` +
            `• Thresholds: paused ≥ ${config.hoursThreshold}h AND grew ≥ ${config.growthThreshold} jobs`;

          const { notifyByType } = await import(
            "../services/notifications/dispatcher"
          );
          const result = await notifyByType(
            "queue.drain_control.paused_backlog_growing",
            { text, preview: text.slice(0, 300) },
            {
              triggerSource: "test",
              triggerActorId: userId,
              bypassKillSwitch: true,
              bypassDedupe: true,
              metadata: {
                test: true,
                queueName: "example_queue",
                pausedAt: samplePausedAt,
                pausedAtBacklog: samplePausedAtBacklog,
                currentPending: sampleCurrentPending,
                growth: sampleGrowth,
                hoursPaused: sampleHoursPaused,
                hoursThreshold: config.hoursThreshold,
                growthThreshold: config.growthThreshold,
              },
            },
          );

          // Always return 200 with a structured `ok` flag so the client can
          // surface skip/failure reasons in a toast — `apiRequest` throws on
          // non-2xx, which would route dispatcher skips through the generic
          // onError path and lose the `skipReason`.
          return res.json({
            ok: result.delivered,
            status: result.status,
            channelId: result.channelId ?? null,
            deliveryId: result.deliveryId ?? null,
            error: result.delivered
              ? undefined
              : result.error ?? result.skipReason ?? "Test send failed",
          });
        } catch (err: any) {
          console.error(
            "[QueueControl] backlog-alerts test POST failed:",
            err?.message,
          );
          res
            .status(500)
            .json({ ok: false, error: err?.message ?? "Failed to send test alert" });
        }
      },
    );

    // ── Task #1009: queue starvation alert configuration & history. ──
    // Companion to the backlog-alerts endpoints above. The threshold
    // (consecutive idle windows + min-pending) lives in `system_settings`
    // and the most-recent Slack alert events come from
    // `notification_deliveries` so operators can confirm both that the
    // policy is what they want AND that a recent alert actually fired.
    const STARVATION_NOTIFICATION_ID = "queue.scheduler.starved";

    app.get(
      "/api/admin/queue-control/starvation-alerts",
      isAuthenticated,
      requireTeamLead,
      async (_req: any, res) => {
        try {
          const [config, deliveries] = await Promise.all([
            getQueueStarvationAlertConfig(),
            listNotificationDeliveries(STARVATION_NOTIFICATION_ID, 25).catch(() => []),
          ]);
          const recent = deliveries.map((d) => {
            const meta = (d.metadataJson ?? null) as
              | Record<string, unknown>
              | null;
            return {
              id: d.id,
              createdAt:
                d.createdAt instanceof Date
                  ? d.createdAt.toISOString()
                  : (d.createdAt as unknown as string),
              status: d.status,
              channelName: d.channelName,
              errorMessage: d.errorMessage,
              queueName:
                typeof meta?.queueName === "string"
                  ? (meta.queueName as string)
                  : null,
              event:
                typeof meta?.event === "string"
                  ? (meta.event as string)
                  : null,
              consecutiveIdleWindows:
                typeof meta?.consecutiveIdleWindows === "number"
                  ? (meta.consecutiveIdleWindows as number)
                  : null,
              threshold:
                typeof meta?.threshold === "number"
                  ? (meta.threshold as number)
                  : null,
              pending:
                typeof meta?.pending === "number"
                  ? (meta.pending as number)
                  : null,
              pendingNow:
                typeof meta?.pendingNow === "number"
                  ? (meta.pendingNow as number)
                  : null,
              windowCapturedAt:
                typeof meta?.windowCapturedAt === "string"
                  ? (meta.windowCapturedAt as string)
                  : null,
            };
          });
          res.json({ config, recent });
        } catch (err: any) {
          console.error(
            "[QueueControl] starvation-alerts GET failed:",
            err?.message,
          );
          res
            .status(500)
            .json({ error: "Failed to load starvation-alert config" });
        }
      },
    );

    app.post(
      "/api/admin/queue-control/starvation-alerts/config",
      isAuthenticated,
      requireTeamLead,
      async (req: any, res) => {
        try {
          const body = req.body ?? {};
          const errors: string[] = [];

          let enabled: boolean | undefined;
          if (body.enabled !== undefined) {
            if (typeof body.enabled !== "boolean") {
              errors.push("enabled must be a boolean");
            } else {
              enabled = body.enabled;
            }
          }

          function parsePosInt(field: string, max: number): number | undefined {
            const raw = body[field];
            if (raw === undefined) return undefined;
            const n =
              typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
            if (!Number.isInteger(n) || n <= 0 || n > max) {
              errors.push(`${field} must be a positive integer ≤ ${max}`);
              return undefined;
            }
            return n;
          }
          function parseNonNegInt(field: string, max: number): number | undefined {
            const raw = body[field];
            if (raw === undefined) return undefined;
            const n =
              typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
            if (!Number.isInteger(n) || n < 0 || n > max) {
              errors.push(`${field} must be a non-negative integer ≤ ${max}`);
              return undefined;
            }
            return n;
          }

          const consecutiveWindows = parsePosInt("consecutiveWindows", 1_000);
          const minPending = parseNonNegInt("minPending", 1_000_000);
          const cooldownMinutes = parsePosInt("cooldownMinutes", 60 * 24 * 7);

          if (errors.length > 0) {
            return res.status(400).json({ error: errors.join("; ") });
          }

          const actor = req.user?.claims?.sub ?? null;
          const writes: Array<Promise<unknown>> = [];
          if (enabled !== undefined) {
            writes.push(
              setSystemSetting(
                STARVATION_SETTING_ENABLED,
                enabled ? "true" : "false",
                actor,
              ),
            );
          }
          if (consecutiveWindows !== undefined) {
            writes.push(
              setSystemSetting(
                STARVATION_SETTING_WINDOWS,
                String(consecutiveWindows),
                actor,
              ),
            );
          }
          if (minPending !== undefined) {
            writes.push(
              setSystemSetting(
                STARVATION_SETTING_MIN_PENDING,
                String(minPending),
                actor,
              ),
            );
          }
          if (cooldownMinutes !== undefined) {
            writes.push(
              setSystemSetting(
                STARVATION_SETTING_COOLDOWN,
                String(cooldownMinutes),
                actor,
              ),
            );
          }
          await Promise.all(writes);

          const config = await getQueueStarvationAlertConfig();
          res.json({ config });
        } catch (err: any) {
          console.error(
            "[QueueControl] starvation-alerts config POST failed:",
            err?.message,
          );
          res
            .status(500)
            .json({ error: err?.message ?? "Failed to update config" });
        }
      },
    );

  // Task #1025: per-client pending-count observability for the
  // `retroactive_reprocess` queue. Surfaces which clients are at or
  // approaching the per-client ceiling so operators can spot a stuck
  // consumer or a rogue producer without running ad-hoc SQL.
  app.get(
    "/api/admin/queue-control/retroactive-reprocess/pending-by-client",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getPendingCountsByClient } = await import(
          "../services/retroactiveReprocessControl"
        );
        const { PERF } = await import("../perfConfig");
        const rows = await getPendingCountsByClient();
        res.json({
          ceiling: PERF.RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX,
          concurrency: PERF.RETROACTIVE_REPROCESS_CONCURRENCY,
          totalPending: rows.reduce((s, r) => s + r.pendingCount, 0),
          clientCount: rows.length,
          atOrOverCeiling: rows.filter(
            (r) => r.pendingCount >= PERF.RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX,
          ).length,
          rows,
        });
      } catch (err: any) {
        console.error(
          "[QueueControl] retroactive-reprocess pending-by-client failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load retroactive reprocess pending counts" });
      }
    },
  );

  // Task #997: recent drain action history (pause/resume/rate-limit/cancel).
  // Backed by the existing `admin_setting_audit` store under setting key
  // `queue_drain_action`, scope = queueName — same audit trail used for
  // rate-limit thresholds and other admin-tunable settings.
  app.get(
    "/api/admin/queue-control/history",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { listQueueDrainHistory, isQueueDrainHistoryAction } =
          await import("../services/queueDrainControl");
        const queueName =
          typeof req.query.queueName === "string" && req.query.queueName.trim() !== ""
            ? (req.query.queueName as string)
            : undefined;
        const actionRaw =
          typeof req.query.action === "string" && req.query.action.trim() !== ""
            ? (req.query.action as string)
            : undefined;
        if (actionRaw !== undefined && !isQueueDrainHistoryAction(actionRaw)) {
          return res.status(400).json({ error: `unknown action: ${actionRaw}` });
        }
        let limit: number | undefined;
        if (req.query.limit !== undefined) {
          const n = Number.parseInt(String(req.query.limit), 10);
          // Capped at 100 to match the storage-layer clamp inside
          // `listAdminSettingAudit` — see `QUEUE_DRAIN_HISTORY_MAX_LIMIT`.
          if (!Number.isFinite(n) || n <= 0 || n > 100) {
            return res
              .status(400)
              .json({ error: "limit must be a positive integer <= 100" });
          }
          limit = n;
        }
        const entries = await listQueueDrainHistory({
          queueName,
          action: actionRaw,
          limit,
        });
        res.json({ entries });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[QueueControl] history GET failed:", msg);
        res.status(500).json({ error: msg || "Failed to load history" });
      }
    },
  );

  app.post(
    "/api/admin/queue-control/:queueName/cancel-pending",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { queueName } = req.params as { queueName: string };
        const raw = req.body?.limit;
        const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "100"), 10);
        if (!Number.isFinite(limit) || limit <= 0 || limit > 10_000) {
          return res.status(400).json({ error: "limit must be a positive integer <= 10000" });
        }
        const { cancelPendingJobs } = await import("../services/queueDrainControl");
        const actor = req.user?.claims?.sub ?? null;
        const result = await cancelPendingJobs(queueName, limit, actor);
        res.json({ queueName, ...result });
      } catch (err: any) {
        console.error("[QueueControl] cancel-pending failed:", err?.message);
        res.status(500).json({ error: err?.message ?? "Failed to cancel pending jobs" });
      }
    },
  );
}
