import type { Express } from "express";
import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, requireTeamLead, requireCeoToolsAuth } from "./middleware";
import * as callAnalysis from "../services/callAnalysis";
import { callAnalysisJobs } from "@shared/schema";
import {
  callAnalysisFailureReasons,
  callAnalysisLanes,
  type CallAnalysisFailureReason,
  type CallAnalysisLane,
} from "@shared/models/ceoTools";
import {
  checkCallAnalysisFailureSpikes,
  getCallAnalysisFailureSpikeAlertConfig,
  SETTING_ENABLED as SPIKE_SETTING_ENABLED,
  SETTING_WINDOW_MINUTES as SPIKE_SETTING_WINDOW_MINUTES,
  SETTING_BASELINE_DAYS as SPIKE_SETTING_BASELINE_DAYS,
  SETTING_ABSOLUTE_THRESHOLD as SPIKE_SETTING_ABSOLUTE_THRESHOLD,
  SETTING_RATIO_THRESHOLD as SPIKE_SETTING_RATIO_THRESHOLD,
  SETTING_MIN_COUNT_FOR_RATIO as SPIKE_SETTING_MIN_COUNT_FOR_RATIO,
  SETTING_COOLDOWN as SPIKE_SETTING_COOLDOWN,
  SETTING_MUTED_REASONS as SPIKE_SETTING_MUTED_REASONS,
} from "../services/callAnalysisFailureSpikeAlerts";
import { setSystemSetting } from "../storage/settingsStorage";

export function registerCeoToolsRoutes(app: Express) {

  app.post("/api/ceo-tools/call-analysis", requireCeoToolsAuth, async (req, res) => {
    try {
      const { external_id, audio_url, rev_transcript_json, rev_transcript_url, max_listen_seconds } = req.body;
      
      if (!external_id) {
        return res.status(400).json({ error: "external_id is required" });
      }
      
      // If rev_transcript_url is provided, fetch the JSON from that URL
      let transcriptJson = rev_transcript_json || null;
      if (!transcriptJson && rev_transcript_url) {
        try {
          transcriptJson = await callAnalysis.fetchTranscriptFromUrl(rev_transcript_url);
        } catch (err: any) {
          console.error("Failed to fetch transcript from URL:", err);
          return res.status(400).json({ 
            error: "Failed to fetch transcript from URL. Make sure the file is publicly accessible." 
          });
        }
      }
      
      // audio_url is required only if no transcript is provided
      if (!audio_url && !transcriptJson) {
        return res.status(400).json({ error: "Either audio_url or rev_transcript_json/rev_transcript_url is required" });
      }
      
      const job = await callAnalysis.createOrGetJob({
        externalId: external_id,
        audioUrl: audio_url,
        revTranscriptJson: transcriptJson,
        maxListenSeconds: max_listen_seconds,
      });
      
      res.json({
        analysis_id: job.analysisId,
        external_id: job.externalId,
        status: job.status,
      });
    } catch (error: any) {
      console.error("Call analysis create error:", error);
      res.status(500).json({ error: "Analysis operation failed" });
    }
  });

  // Task #1057: Failure-mix panel data — counts by failure_reason × lane
  // for the last 24h and last 7d, plus the current slow-lane backlog
  // (status='queued' AND lane='slow'). Used by the ops/health dashboard
  // so operators can spot regressions without dropping into SQL.
  // IMPORTANT: must be registered before the /:analysisId param route
  // below, otherwise Express matches the param route first and treats
  // "failure-mix" as an analysisId.
  app.get("/api/ceo-tools/call-analysis/failure-mix", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      type FailureMixRow = {
        failure_reason: string;
        lane: string;
        count_24h: number;
        count_7d: number;
      };
      const failureRows = await db.execute<FailureMixRow>(sql`
        SELECT
          COALESCE(failure_reason, 'unknown') AS failure_reason,
          COALESCE(lane, 'normal') AS lane,
          COUNT(*) FILTER (WHERE completed_at >= NOW() - INTERVAL '24 hours')::int AS count_24h,
          COUNT(*) FILTER (WHERE completed_at >= NOW() - INTERVAL '7 days')::int AS count_7d
        FROM call_analysis_jobs
        WHERE status = 'failed'
          AND completed_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1, 2
      `);

      const matrix24h: Record<string, Record<string, number>> = {};
      const matrix7d: Record<string, Record<string, number>> = {};
      for (const reason of callAnalysisFailureReasons) {
        matrix24h[reason] = {};
        matrix7d[reason] = {};
        for (const lane of callAnalysisLanes) {
          matrix24h[reason][lane] = 0;
          matrix7d[reason][lane] = 0;
        }
      }

      let total24h = 0;
      let total7d = 0;
      for (const row of failureRows.rows as readonly FailureMixRow[]) {
        const reason: CallAnalysisFailureReason =
          (callAnalysisFailureReasons as readonly string[]).includes(row.failure_reason)
            ? (row.failure_reason as CallAnalysisFailureReason)
            : "unknown";
        const lane: CallAnalysisLane =
          (callAnalysisLanes as readonly string[]).includes(row.lane)
            ? (row.lane as CallAnalysisLane)
            : "normal";
        const c24 = Number(row.count_24h) || 0;
        const c7 = Number(row.count_7d) || 0;
        matrix24h[reason][lane] = (matrix24h[reason][lane] ?? 0) + c24;
        matrix7d[reason][lane] = (matrix7d[reason][lane] ?? 0) + c7;
        total24h += c24;
        total7d += c7;
      }

      type BacklogRow = { lane: string; queued: number };
      const backlogRows = await db.execute<BacklogRow>(sql`
        SELECT
          COALESCE(lane, 'normal') AS lane,
          COUNT(*)::int AS queued
        FROM call_analysis_jobs
        WHERE status = 'queued'
        GROUP BY 1
      `);
      const queuedByLane: Record<string, number> = { normal: 0, slow: 0 };
      for (const row of backlogRows.rows as readonly BacklogRow[]) {
        const lane = String(row.lane ?? "normal");
        queuedByLane[lane] = (queuedByLane[lane] ?? 0) + (Number(row.queued) || 0);
      }

      res.json({
        reasons: callAnalysisFailureReasons,
        lanes: callAnalysisLanes,
        windows: {
          last24h: { byReasonByLane: matrix24h, total: total24h },
          last7d: { byReasonByLane: matrix7d, total: total7d },
        },
        backlog: {
          slowLaneQueued: queuedByLane.slow ?? 0,
          normalLaneQueued: queuedByLane.normal ?? 0,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("Call analysis failure-mix error:", error);
      res.status(500).json({ error: "Failed to load failure mix" });
    }
  });

  // Task #1077: drill-down list behind each failure-mix cell so operators
  // can click a (reason × lane × window) cell and see the actual broken
  // call_analysis_jobs without dropping into SQL. Must stay above the
  // /:analysisId param route so Express doesn't treat "failure-mix" as an
  // analysisId.
  app.get("/api/ceo-tools/call-analysis/failure-mix/jobs", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const reasonParam = String(req.query.reason ?? "");
      const laneParam = String(req.query.lane ?? "");
      const windowParam = String(req.query.window ?? "7d");
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);

      if (!(callAnalysisFailureReasons as readonly string[]).includes(reasonParam)) {
        return res.status(400).json({ error: "Invalid reason" });
      }
      if (!(callAnalysisLanes as readonly string[]).includes(laneParam)) {
        return res.status(400).json({ error: "Invalid lane" });
      }
      if (windowParam !== "24h" && windowParam !== "7d") {
        return res.status(400).json({ error: "Invalid window" });
      }

      const interval = windowParam === "24h" ? sql`INTERVAL '24 hours'` : sql`INTERVAL '7 days'`;
      // `unknown` reason covers both rows where failure_reason IS NULL
      // (legacy / pre-#1049 failures) and rows explicitly classified as
      // 'unknown'. Other reasons match exactly.
      const reasonClause = reasonParam === "unknown"
        ? sql`(failure_reason IS NULL OR failure_reason = 'unknown')`
        : sql`failure_reason = ${reasonParam}`;
      // `normal` lane covers NULL lane rows defensively too (column has
      // NOT NULL DEFAULT 'normal' but be safe).
      const laneClause = laneParam === "normal"
        ? sql`(lane IS NULL OR lane = 'normal')`
        : sql`lane = ${laneParam}`;

      type Row = {
        analysis_id: string;
        external_id: string;
        error_message: string | null;
        failure_reason: string | null;
        lane: string | null;
        status: string;
        completed_at: string | null;
        attempt_count: number | null;
      };
      const result = await db.execute<Row>(sql`
        SELECT
          analysis_id,
          external_id,
          error_message,
          failure_reason,
          lane,
          status,
          completed_at,
          attempt_count
        FROM call_analysis_jobs
        WHERE status = 'failed'
          AND completed_at >= NOW() - ${interval}
          AND ${reasonClause}
          AND ${laneClause}
        ORDER BY completed_at DESC NULLS LAST
        LIMIT ${limit}
      `);

      res.json({
        reason: reasonParam,
        lane: laneParam,
        window: windowParam,
        jobs: (result.rows as readonly Row[]).map((row) => ({
          analysis_id: row.analysis_id,
          external_id: row.external_id,
          error_message: row.error_message,
          failure_reason: row.failure_reason,
          lane: row.lane,
          status: row.status,
          completed_at: row.completed_at,
          attempt_count: row.attempt_count,
        })),
      });
    } catch (error: any) {
      console.error("Call analysis failure-mix jobs error:", error);
      res.status(500).json({ error: "Failed to load failure-mix jobs" });
    }
  });

  // Task #1096: Surface the call-analysis failure-spike alert config (Task
  // #1076) on the admin failure-mix dashboard so operators can tune
  // thresholds, the per-reason mute list, and preview what would alert
  // without writing rows directly into `system_settings`. The spike
  // watcher already exposes both the live config getter and a dry-run
  // diagnostics path — these endpoints are thin wrappers over them.
  // IMPORTANT: must be registered before the /:analysisId param route
  // below so Express doesn't treat "failure-spike-config" / "failure-
  // spike-check" as an analysisId.
  app.get(
    "/api/ceo-tools/call-analysis/failure-spike-config",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const config = await getCallAnalysisFailureSpikeAlertConfig();
        res.json({ config });
      } catch (err: any) {
        console.error("Failure-spike config GET error:", err);
        res.status(500).json({ error: "Failed to load failure-spike alert config" });
      }
    },
  );

  app.post(
    "/api/ceo-tools/call-analysis/failure-spike-config",
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

        function parsePosFloat(field: string, max: number): number | undefined {
          const raw = body[field];
          if (raw === undefined) return undefined;
          const n =
            typeof raw === "number" ? raw : Number.parseFloat(String(raw));
          if (!Number.isFinite(n) || n <= 0 || n > max) {
            errors.push(`${field} must be a positive number ≤ ${max}`);
            return undefined;
          }
          return n;
        }

        const windowMinutes = parsePosInt("windowMinutes", 24 * 60);
        const baselineDays = parsePosInt("baselineDays", 90);
        const absoluteThreshold = parsePosInt("absoluteThreshold", 1_000_000);
        const ratioThreshold = parsePosFloat("ratioThreshold", 1000);
        const minCountForRatio = parsePosInt("minCountForRatio", 1_000_000);
        const cooldownMinutes = parsePosInt("cooldownMinutes", 60 * 24 * 7);

        let mutedReasonsValue: string | undefined;
        if (body.mutedReasons !== undefined) {
          if (!Array.isArray(body.mutedReasons)) {
            errors.push("mutedReasons must be an array of strings");
          } else {
            const cleaned = (body.mutedReasons as unknown[])
              .map((s) => String(s ?? "").trim().toLowerCase())
              .filter((s) => s.length > 0);
            mutedReasonsValue = Array.from(new Set(cleaned)).join(",");
          }
        }

        if (errors.length > 0) {
          return res.status(400).json({ error: errors.join("; ") });
        }

        const actor = req.user?.claims?.sub ?? null;
        const writes: Array<Promise<unknown>> = [];
        if (enabled !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_ENABLED, enabled ? "true" : "false", actor));
        }
        if (windowMinutes !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_WINDOW_MINUTES, String(windowMinutes), actor));
        }
        if (baselineDays !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_BASELINE_DAYS, String(baselineDays), actor));
        }
        if (absoluteThreshold !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_ABSOLUTE_THRESHOLD, String(absoluteThreshold), actor));
        }
        if (ratioThreshold !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_RATIO_THRESHOLD, String(ratioThreshold), actor));
        }
        if (minCountForRatio !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_MIN_COUNT_FOR_RATIO, String(minCountForRatio), actor));
        }
        if (cooldownMinutes !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_COOLDOWN, String(cooldownMinutes), actor));
        }
        if (mutedReasonsValue !== undefined) {
          writes.push(setSystemSetting(SPIKE_SETTING_MUTED_REASONS, mutedReasonsValue, actor));
        }
        await Promise.all(writes);

        const config = await getCallAnalysisFailureSpikeAlertConfig();
        res.json({ config });
      } catch (err: any) {
        console.error("Failure-spike config POST error:", err);
        res.status(500).json({ error: err?.message ?? "Failed to update config" });
      }
    },
  );

  // "Run check now" — uses the watcher's dryRun path so it never sends
  // Slack and never updates the per-reason cooldown cache. Returns the
  // same per-reason diagnostics structure the live tick produces.
  app.post(
    "/api/ceo-tools/call-analysis/failure-spike-check",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const result = await checkCallAnalysisFailureSpikes(Date.now(), { dryRun: true });
        res.json(result);
      } catch (err: any) {
        console.error("Failure-spike check error:", err);
        res.status(500).json({ error: err?.message ?? "Failed to run failure-spike check" });
      }
    },
  );

  // Task #1093: also accept session+role auth so the Call Analysis page's
  // deep-link fallback (browser cookie credentials, no Bearer token) can
  // fetch a job that isn't on the currently loaded page.
  app.get("/api/ceo-tools/call-analysis/:analysisId", (req: any, res, next) => {
    if (req.headers.authorization?.startsWith('Bearer ')) {
      return requireCeoToolsAuth(req, res, next);
    }
    return isAuthenticated(req, res, (err?: any) => {
      if (err) return next(err);
      return requireTeamLead(req, res, next);
    });
  }, async (req, res) => {
    try {
      const job = await callAnalysis.getJob(req.params.analysisId);
      
      if (!job) {
        return res.status(404).json({ error: "Analysis job not found" });
      }
      
      // Task #1093: return the same shape as the list endpoint so the
      // Call Analysis page can render a row when the operator deep-links
      // to a job that isn't on the currently-loaded page.
      res.json({
        analysis_id: job.analysisId,
        external_id: job.externalId,
        audio_url: job.audioUrl ?? null,
        rev_transcript_json: job.revTranscriptJson ?? null,
        max_listen_seconds: job.maxListenSeconds ?? null,
        status: job.status,
        created_at: job.createdAt,
        completed_at: job.completedAt ?? null,
        result: job.resultJson ?? null,
        error_message: job.errorMessage ?? null,
      });
    } catch (error: any) {
      console.error("Call analysis get error:", error);
      res.status(500).json({ error: "Analysis operation failed" });
    }
  });

  app.get("/api/ceo-tools/call-analysis", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;
      
      const jobs = await callAnalysis.getAllJobs(limit, offset);
      
      res.json({
        data: jobs.map(job => ({
          analysis_id: job.analysisId,
          external_id: job.externalId,
          audio_url: job.audioUrl,
          rev_transcript_json: job.revTranscriptJson,
          max_listen_seconds: job.maxListenSeconds,
          status: job.status,
          created_at: job.createdAt,
          completed_at: job.completedAt,
          result: job.resultJson,
          error_message: job.errorMessage,
        })),
        page,
        limit,
      });
    } catch (error: any) {
      console.error("Call analysis list error:", error);
      res.status(500).json({ error: "Analysis operation failed" });
    }
  });

  /**
   * Task #1092: bulk-rerun every failed call_analysis job in a failure-mix
   * cell. Accepts up to 500 analysis IDs and requeues each one through the
   * same code path the per-row /rerun endpoint uses (status='queued',
   * clear errorMessage / resultJson, reset attemptCount). Each row is its
   * own UPDATE statement so a per-row failure (e.g. row deleted between
   * the drill-down fetch and the bulk call) does not abort the batch;
   * failures are returned in `failed[]` with a reason. Mirrors the Zoom
   * Review Queue bulk-action shape (`succeeded`, `failed`).
   */
  app.post("/api/ceo-tools/call-analysis/failure-mix/bulk-rerun", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const rawIds = Array.isArray(req.body?.analysisIds) ? req.body.analysisIds : null;
      if (!rawIds) {
        return res.status(400).json({ error: "analysisIds[] is required" });
      }
      const analysisIds: string[] = Array.from(new Set<string>(
        (rawIds as unknown[])
          .filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0)
          .map((v: string) => v.trim()),
      ));
      if (analysisIds.length === 0) {
        return res.status(400).json({ error: "analysisIds[] must contain at least one id" });
      }
      if (analysisIds.length > 500) {
        return res.status(400).json({ error: "analysisIds[] capped at 500 per call" });
      }

      const succeeded: string[] = [];
      const failed: Array<{ analysisId: string; error: string }> = [];

      for (const analysisId of analysisIds) {
        try {
          const [updated] = await db.update(callAnalysisJobs)
            .set({
              status: "queued",
              errorMessage: null,
              resultJson: null,
              attemptCount: 0,
            })
            .where(eq(callAnalysisJobs.analysisId, analysisId))
            .returning({ analysisId: callAnalysisJobs.analysisId });
          if (!updated) {
            failed.push({ analysisId, error: "not_found" });
          } else {
            succeeded.push(updated.analysisId);
          }
        } catch (err: any) {
          failed.push({ analysisId, error: err?.message ?? "rerun_failed" });
        }
      }

      res.json({
        requested: analysisIds.length,
        succeededCount: succeeded.length,
        failedCount: failed.length,
        succeeded,
        failed,
      });
    } catch (error: any) {
      console.error("Call analysis bulk-rerun error:", error);
      res.status(500).json({ error: "Bulk rerun failed" });
    }
  });

  app.post("/api/ceo-tools/call-analysis/:analysisId/rerun", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const existingJob = await callAnalysis.getJob(req.params.analysisId);
      
      if (!existingJob) {
        return res.status(404).json({ error: "Analysis job not found" });
      }
      
      const [updated] = await db.update(callAnalysisJobs)
        .set({
          status: "queued",
          errorMessage: null,
          resultJson: null,
          attemptCount: 0,
        })
        .where(eq(callAnalysisJobs.analysisId, existingJob.analysisId))
        .returning();
      
      res.json({
        analysis_id: updated.analysisId,
        external_id: updated.externalId,
        status: updated.status,
      });
    } catch (error: any) {
      console.error("Call analysis rerun error:", error);
      res.status(500).json({ error: "Analysis operation failed" });
    }
  });

  app.post("/api/ceo-tools/call-analysis/backfill-duration", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const allJobs = await db.select().from(callAnalysisJobs).where(eq(callAnalysisJobs.status, "complete"));
      let updated = 0;
      for (const job of allJobs) {
        const result = job.resultJson as any;
        if (result && result.callDurationSeconds == null && job.audioUrl) {
          try {
            const tempFile = await callAnalysis.downloadAudio(job.audioUrl);
            const duration = await callAnalysis.getAudioDuration(tempFile);
            if (duration !== null) {
              result.callDurationSeconds = duration;
              await db.update(callAnalysisJobs).set({ resultJson: result }).where(eq(callAnalysisJobs.analysisId, job.analysisId));
              updated++;
            }
            const fs = await import("fs");
            try { await fs.promises.unlink(tempFile); } catch {}
          } catch (e) {
            console.log(`[Backfill] Failed for ${job.analysisId}: ${(e as Error).message}`);
          }
        }
      }
      res.json({ message: `Backfilled call duration for ${updated} of ${allJobs.length} jobs` });
    } catch (error: any) {
      console.error("[Analysis] Error:", error);
      res.status(500).json({ error: "Analysis operation failed" });
    }
  });


  }
  