/**
 * Task #2075 — operator surface for the feedback → Slack auto-resend
 * scheduler (Task #2066):
 *
 *   GET  /api/feedback/slack-retry/status
 *   POST /api/feedback/slack-retry/run
 *
 * Both are gated by `isAuthenticated` + `requireTeamLead`. The status
 * route returns the live config (master switch + bounding knobs) plus
 * the persisted last-run summary so an operator can confirm Slack
 * reconnected and the backlog is draining without querying
 * `system_settings`. The run route executes a single retry tick on
 * demand — the SAME `runFeedbackSlackRetryTick()` the scheduler uses, so
 * it honors every gate (master switch, queue-drain pause, kill switch,
 * and the live Slack connectivity probe). It is wrapped in
 * `runWithWorkerDb` to keep the tick's DB work on the worker pool,
 * matching the `@db-pool-intent: worker` contract on
 * `services/feedbackSlackRetry.ts`.
 *
 * Extracted from `server/routes.ts` so the two endpoints can be
 * registered onto a bare Express app in tests (see
 * `tests/feedback-slack-retry-routes.test.ts`).
 */
import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";

export function registerFeedbackSlackRetryRoutes(app: Express): void {
  // Task #2075 — surface the feedback → Slack auto-resend (Task #2066)
  // last-run readout plus the current enabled/backoff/max-per-tick config
  // so operators can confirm Slack reconnected and the backlog is draining
  // without querying `system_settings` directly.
  app.get(
    "/api/feedback/slack-retry/status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { readLastFeedbackSlackRetryRun, getFeedbackSlackRetryConfig } =
          await import("../services/feedbackSlackRetry");
        const [lastRunRead, config] = await Promise.all([
          readLastFeedbackSlackRetryRun(),
          getFeedbackSlackRetryConfig(),
        ]);
        // `lastRun` is the parsed summary or null (contract preserved).
        // `lastRunStatus` distinguishes "never_run" (normal on a fresh
        // deploy) from "unreadable" (a persisted-value parse failure →
        // real persistence bug), with `lastRunError` carrying the
        // plain-English reason when unreadable.
        const { MAX_PER_TICK_CAP, BACKOFF_MINUTES_CAP } = await import(
          "../services/feedbackSlackRetry"
        );
        res.json({
          config,
          caps: {
            maxPerTick: MAX_PER_TICK_CAP,
            backoffMinutes: BACKOFF_MINUTES_CAP,
          },
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
        });
      } catch (err: any) {
        console.error(
          "[FeedbackSlackRetry] status endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to fetch feedback Slack retry status" });
      }
    },
  );

  // Task #2127 — persist the feedback → Slack auto-resend config (master
  // switch + bounding knobs) so operators flip/tune it from the admin
  // console instead of editing `system_settings` by hand. Each field is
  // optional and validated against the same caps the service enforces
  // (`MAX_PER_TICK_CAP` / `BACKOFF_MINUTES_CAP`); the response re-reads the
  // live config via `getFeedbackSlackRetryConfig()` so the UI reflects what
  // the next tick will actually use.
  app.put(
    "/api/feedback/slack-retry/config",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          SETTING_ENABLED,
          SETTING_MAX_PER_TICK,
          SETTING_BACKOFF_MINUTES,
          MAX_PER_TICK_CAP,
          BACKOFF_MINUTES_CAP,
          getFeedbackSlackRetryConfig,
        } = await import("../services/feedbackSlackRetry");
        const { setSystemSetting } = await import("../storage/settingsStorage");

        const body = req.body ?? {};
        const hasEnabled = body.enabled !== undefined;
        const hasMaxPerTick = body.maxPerTick !== undefined;
        const hasBackoff = body.backoffMinutes !== undefined;

        if (!hasEnabled && !hasMaxPerTick && !hasBackoff) {
          return res.status(400).json({
            error:
              "At least one of enabled, maxPerTick, backoffMinutes is required",
          });
        }
        if (hasEnabled && typeof body.enabled !== "boolean") {
          return res
            .status(400)
            .json({ error: "enabled must be a boolean" });
        }
        if (hasMaxPerTick) {
          const n = Number(body.maxPerTick);
          if (!Number.isInteger(n) || n < 1 || n > MAX_PER_TICK_CAP) {
            return res.status(400).json({
              error: `maxPerTick must be an integer between 1 and ${MAX_PER_TICK_CAP}`,
            });
          }
        }
        if (hasBackoff) {
          const n = Number(body.backoffMinutes);
          if (!Number.isInteger(n) || n < 0 || n > BACKOFF_MINUTES_CAP) {
            return res.status(400).json({
              error: `backoffMinutes must be an integer between 0 and ${BACKOFF_MINUTES_CAP}`,
            });
          }
        }

        const by = req.user?.claims?.sub ?? "unknown";
        if (hasEnabled) {
          await setSystemSetting(
            SETTING_ENABLED,
            body.enabled ? "true" : "false",
            by,
          );
        }
        if (hasMaxPerTick) {
          await setSystemSetting(
            SETTING_MAX_PER_TICK,
            String(Math.floor(Number(body.maxPerTick))),
            by,
          );
        }
        if (hasBackoff) {
          await setSystemSetting(
            SETTING_BACKOFF_MINUTES,
            String(Math.floor(Number(body.backoffMinutes))),
            by,
          );
        }

        const config = await getFeedbackSlackRetryConfig();
        res.json({ ok: true, config });
      } catch (err: any) {
        console.error(
          "[FeedbackSlackRetry] config update endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to update feedback Slack retry config" });
      }
    },
  );

  // Task #2075 — run a single feedback → Slack retry tick on demand. Runs
  // the same `runFeedbackSlackRetryTick()` the scheduler uses (so it honors
  // every gate: master switch, queue-drain pause, kill switch, and the live
  // Slack connectivity probe) and returns the resulting summary. Wrapped in
  // `runWithWorkerDb` to keep the tick's DB work on the worker pool, matching
  // the `@db-pool-intent: worker` contract on feedbackSlackRetry.ts.
  app.post(
    "/api/feedback/slack-retry/run",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { runFeedbackSlackRetryTick } = await import(
          "../services/feedbackSlackRetry"
        );
        const { runWithWorkerDb } = await import("../db");
        const result = await runWithWorkerDb(() => runFeedbackSlackRetryTick());
        res.json({ ok: true, result });
      } catch (err: any) {
        console.error(
          "[FeedbackSlackRetry] manual run endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to run feedback Slack retry tick" });
      }
    },
  );
}
