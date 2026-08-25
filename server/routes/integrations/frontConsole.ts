/**
 * Integrations routes — Front console + sync ops: reprocess-dismissed / rematch-all / full-backfill jobs (in-memory job maps read by the overview).
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 1699–1897, 5486–5529, 5744–6362); sections: Front console + sync ops: reprocess-dismissed / rematch-all / full-backfill jobs (in-memory job maps read by the overview); bulk actions (preview / execute); consolidated read-only overview; bring-to-100.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import type { BulkActionSpec } from "../../services/frontBulkActions";
import type { AuthenticatedRequest } from "../requestContext";

export function registerIntegrationsFrontConsoleRoutes(app: Express) {
  app.post("/api/integrations/front/reprocess-dismissed", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const cohort = req.body?.cohort || "dismissed_operational";
      const maxItems = Math.min(Math.max(Number(req.body?.maxItems) || 50000, 1), 100000);
      const resume = req.body?.resume !== false;
      const dryRun = req.body?.dryRun === true;

      if (dryRun) {
        const { reprocessDismissedNonSpam } = await import("../../services/frontIntegration");
        const { runWithWorkerDb } = await import("../../db");
        const { withClassSlot } = await import("../../services/workloadManager");
        const outcome = await withClassSlot("frontSyncReprocess", async () => {
          return runWithWorkerDb(() => reprocessDismissedNonSpam({ cohort, maxItems, resume, dryRun: true }));
        }, { origin: "user_manual" });
        if (!outcome.acquired) {
          return res.status(429).json({ error: "Too many operations running. Try again shortly." });
        }
        return res.json({ success: true, ...outcome.result });
      }

      const { reprocessDismissedNonSpamProducer } = await import("../../services/frontIntegration");
      const { jobId } = await reprocessDismissedNonSpamProducer({ cohort, maxItems, resume });
      return res.status(202).json({ success: true, jobId, message: "Reprocess job enqueued." });
    } catch (error: any) {
      console.error("[Integrations] Reprocess dismissed error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const rematchJobs = new Map<string, { status: "running" | "complete" | "failed"; result?: any; error?: string; progress?: any; startedAt?: number; updatedAt?: number }>();

  app.post("/api/integrations/front/rematch-all", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const maxItems = Math.min(Math.max(Number(req.body?.maxItems) || 50000, 1), 100000);
      const resume = req.body?.resume === true;
      const dryRun = req.body?.dryRun === true;

      if (dryRun) {
        const { rematchAll } = await import("../../services/frontIntegration");
        const { runWithWorkerDb } = await import("../../db");
        const { withClassSlot } = await import("../../services/workloadManager");
        const outcome = await withClassSlot("frontRematchAll", async () => {
          return runWithWorkerDb(() => rematchAll({ maxItems, resume, dryRun: true }));
        }, { origin: "user_manual" });
        if (!outcome.acquired) {
          return res.status(429).json({ error: "Too many operations running. Try again shortly." });
        }
        return res.json({ success: true, ...outcome.result });
      }

      const alreadyRunning = Array.from(rematchJobs.values()).some(j => j.status === "running");
      if (alreadyRunning) {
        return res.status(409).json({ error: "A rematch job is already running." });
      }

      const { PERF: routePerf } = await import("../../perfConfig");
      if (routePerf.INTERACTIVE_REPAIR_ENQUEUE_ENABLED) {
        const { rematchAllProducer } = await import("../../services/frontIntegration");
        const { jobId } = await rematchAllProducer({ maxItems, resume });

        const queuedStartedAt = Date.now();
        rematchJobs.set(jobId, { status: "running", startedAt: queuedStartedAt, updatedAt: queuedStartedAt });

        // fire-and-forget: background job poller; response already sent
        void (async () => {
          const { getJobById } = await import("../../services/workScheduler");
          const pollMs = 5000;
          const maxWait = 30 * 60 * 1000;
          const start = Date.now();
          while (Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, pollMs));
            const row = await getJobById(jobId);
            if (!row) break;
            const prev = rematchJobs.get(jobId);
            if (row.status === "completed") {
              rematchJobs.set(jobId, { status: "complete", startedAt: prev?.startedAt ?? queuedStartedAt, updatedAt: Date.now() });
              break;
            }
            if (row.status === "failed") {
              rematchJobs.set(jobId, { status: "failed", error: row.errorMessage ?? "unknown error", startedAt: prev?.startedAt ?? queuedStartedAt, updatedAt: Date.now() });
              break;
            }
          }
          setTimeout(() => rematchJobs.delete(jobId), 10 * 60 * 1000);
        })().catch((err) => console.error("[Integrations] Rematch-all poller failed:", err));

        return res.status(202).json({ status: "running", jobId });
      }

      const { rematchAll } = await import("../../services/frontIntegration");
      const { runWithWorkerDb } = await import("../../db");
      const { awaitClassSlot, releaseClassSlot } = await import("../../services/workloadManager");
      const directJobId = `rematch-direct-${Date.now()}`;
      const directStartedAt = Date.now();
      rematchJobs.set(directJobId, { status: "running", startedAt: directStartedAt, updatedAt: directStartedAt });

      // fire-and-forget: response already sent; errors handled inside the IIFE
      void (async () => {
        try {
          await awaitClassSlot("frontRematchAll", { origin: "user_manual" });
          try {
            const result = await runWithWorkerDb(() => rematchAll({ maxItems, resume }));
            rematchJobs.set(directJobId, { status: "complete", result, startedAt: directStartedAt, updatedAt: Date.now() });
          } finally {
            releaseClassSlot("frontRematchAll");
          }
        } catch (err: any) {
          rematchJobs.set(directJobId, { status: "failed", error: err?.message ?? "unknown", startedAt: directStartedAt, updatedAt: Date.now() });
        }
        setTimeout(() => rematchJobs.delete(directJobId), 10 * 60 * 1000);
      })();

      return res.status(202).json({ status: "running", jobId: directJobId });
    } catch (error: any) {
      console.error("[Integrations] Rematch all error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/rematch-all/status/:jobId", isAuthenticated, requireAccountManager, (req: any, res) => {
    const job = rematchJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.set("Cache-Control", "no-store");
    return res.json({ ...job, _ts: Date.now() });
  });

  app.get("/api/integrations/front/rematch-all/running", isAuthenticated, requireAccountManager, (req: any, res) => {
    const running = Array.from(rematchJobs.entries()).find(([, j]) => j.status === "running");
    return res.json({ running: !!running, jobId: running?.[0] ?? null });
  });

  const backfillJobs = new Map<string, { status: "running" | "complete" | "failed"; result?: any; error?: string; updatedAt?: number }>();

  app.post("/api/integrations/front/full-backfill", isAuthenticated, requireTeamLead, (req: any, res) => {
    try {
      const confirmInternal = req.body?.confirmInternal === true || req.query?.confirmInternal === "true";
      if (!confirmInternal) {
        return res.status(410).json({
          error: "deprecated",
          message: "Full Backfill is deprecated. Use POST /api/integrations/front/historical-recovery/execute (the canonical, checkpointed, observable recovery engine). To run the legacy sweep anyway, pass { confirmInternal: true } and accept that it is internal/emergency-only.",
          canonicalEndpoint: "/api/integrations/front/historical-recovery/execute",
        });
      }
      console.warn(`[Integrations] DEPRECATED legacy full-backfill invoked by user ${req.user?.id ?? "?"} with confirmInternal=true`);
      const alreadyRunning = Array.from(backfillJobs.values()).some(j => j.status === "running");
      if (alreadyRunning) {
        return res.status(409).json({ error: "A full backfill job is already running." });
      }

      const jobId = `backfill-${Date.now()}`;
      backfillJobs.set(jobId, { status: "running", updatedAt: Date.now() });

      // fire-and-forget: response already sent; errors handled inside the IIFE
      void (async () => {
        try {
          const { runFrontFullBackfill } = await import("../../services/frontWebhookIngestion");
          const { runWithWorkerDb } = await import("../../db");
          const result = await runWithWorkerDb(() => runFrontFullBackfill({
            onProgress: (progress) => {
              backfillJobs.set(jobId, { status: "running", result: progress, updatedAt: Date.now() });
            },
          }));
          if (result.pages === 0) {
            backfillJobs.set(jobId, {
              status: "failed",
              result,
              error: result.errors[0] || "Backfill produced no pages — check Front token scope and API filters.",
              updatedAt: Date.now(),
            });
          } else if (result.blocked) {
            backfillJobs.set(jobId, {
              status: "failed",
              result,
              error: result.blockedReason || "Backfill blocked: empty first page (no data returned).",
              updatedAt: Date.now(),
            });
          } else {
            backfillJobs.set(jobId, { status: "complete", result, updatedAt: Date.now() });
          }
        } catch (err: any) {
          backfillJobs.set(jobId, { status: "failed", error: err?.message ?? "unknown", updatedAt: Date.now() });
        }
        setTimeout(() => backfillJobs.delete(jobId), 30 * 60 * 1000);
      })();

      return res.status(202).json({ status: "running", jobId });
    } catch (error: any) {
      console.error("[Integrations] Full backfill error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/full-backfill/status/:jobId", isAuthenticated, requireAccountManager, (req: any, res) => {
    const job = backfillJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.set("Cache-Control", "no-store");
    return res.json({ ...job, _ts: Date.now() });
  });

  // ============================================
  // FRONT CONSOLE — Phase 3: safe bulk actions
  // Preview always runs synchronously (read-only count + validation).
  // Execute runs inline for ≤200 eligible items, otherwise enqueues a
  // durable work_queue job (queueName='front_bulk_action') that is
  // mirrored into bulkActionJobs for live progress on the overview.
  // ============================================
  app.post("/api/integrations/front/bulk-action/preview", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { previewBulkAction } = await import("../../services/frontBulkActions");
      const spec = req.body ?? {};
      if (!spec.action || !spec.selection) {
        return res.status(400).json({ error: "action and selection are required" });
      }
      const preview = await previewBulkAction(spec);
      res.set("Cache-Control", "no-store");
      res.json(preview);
    } catch (error: any) {
      console.error("[FrontBulkAction] preview error:", error);
      res.status(400).json({ error: error?.message ?? "preview failed" });
    }
  });

  app.post("/api/integrations/front/bulk-action", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const { executeBulkAction } = await import("../../services/frontBulkActions");
      // F9: the service validates the spec (action/selection resolution); the
      // cast documents the contract it enforces — no new validation here.
      const spec = (req.body ?? {}) as BulkActionSpec;
      if (!spec.action || !spec.selection) {
        return res.status(400).json({ error: "action and selection are required" });
      }
      const userId = req.user?.claims?.sub ?? req.user?.id ?? "system";
      const result = await executeBulkAction(spec, userId);
      res.set("Cache-Control", "no-store");
      if ((result as any).jobId) {
        res.status(202).json(result);
      } else {
        res.status(200).json(result);
      }
    } catch (error: any) {
      console.error("[FrontBulkAction] execute error:", error);
      res.status(400).json({ error: error?.message ?? "execute failed" });
    }
  });

  // ============================================
  // FRONT CONSOLE — consolidated read-only overview
  // (Phase 1: Overview & Jobs)
  // Aggregates connection status, sync metadata, message stats,
  // pipeline metrics, and current/recent jobs across all four
  // job-producing surfaces (historical recovery, rematch-all,
  // bulk classify, deprecated full-backfill). Read-only only.
  // ============================================
  app.get("/api/integrations/front/console/overview", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const frontMod = await import("../../services/frontIntegration");
      const { getPipelineMetrics } = await import("../../services/frontPipelineMetrics");
      const { getSyncState } = await import("../../services/syncProgressTracker");
      const { listRecoveryJobs } = await import("../../services/frontHistoricalRecovery");
      const { getFrontMessageGrainStats, getFrontMessageGrainPipelineByState } = await import("../../services/frontMessageGrainStats");
      const { sql } = await import("drizzle-orm");

      const [validation, syncMeta, pipelineMetrics, recoveryJobsList, messageStatsResult, msgGrainStats, msgPipelineByState, reprocessQueueRows, bulkActionQueueRows, filterRuleApplyQueueRows] = await Promise.all([
        frontMod.validateConnection().catch((err: any) => ({ valid: false, error: err?.message ?? "Validation failed" })),
        frontMod.getSyncMetadata().catch(() => ({ lastError: null, lastSuccess: null })),
        getPipelineMetrics().catch((err: any) => {
          console.error("[FrontConsole] pipeline metrics failed:", err?.message);
          return null;
        }),
        listRecoveryJobs().catch((err: any) => {
          console.error("[FrontConsole] recovery jobs list failed:", err?.message);
          return [] as Awaited<ReturnType<typeof listRecoveryJobs>>;
        }),
        db.execute(sql`
          SELECT COUNT(*)::int as total,
                 COUNT(CASE WHEN client_id IS NOT NULL THEN 1 END)::int as matched,
                 COUNT(CASE WHEN client_id IS NULL THEN 1 END)::int as unmatched
          FROM raw_communication_records
          WHERE source_type = 'front_email'
        `).catch((err: any) => {
          console.error("[FrontConsole] message stats query failed:", err?.message);
          return { rows: [{ total: 0, matched: 0, unmatched: 0 }] } as any;
        }),
        // Task #2633 — canonical MESSAGE-grain stats. The KPI header's Tracked /
        // Matched / Unmatched / Match rate count individual Front-email messages
        // (raw_communication_records), using front_sync_emails only as the
        // internal conversation-state lookup. matchable = matched + unmatched, so
        // the rate is not diluted by operational dismissals (Bug A) and the KPI
        // agrees with the Messages-tab match rate (same helper).
        getFrontMessageGrainStats(db).catch((err: any) => {
          console.error("[FrontConsole] message-grain stats query failed:", err?.message);
          return {
            total: 0, matched: 0, unmatched: 0, matchable: 0,
            nonMatchable: 0, matchRate: 0,
          };
        }),
        // Task #2633 — pipeline-by-state at message grain (counts messages whose
        // conversation sits in each pipeline_state), feeding the backlog / applied
        // / failed / dead-lettered tiles.
        getFrontMessageGrainPipelineByState(db).catch((err: any) => {
          console.error("[FrontConsole] message-grain pipeline-by-state query failed:", err?.message);
          return {} as Record<string, number>;
        }),
        // Reprocess-dismissed jobs are work-scheduler-backed (queueName='front_sync_reprocess').
        // They are durable in the work_queue table. We surface running/queued first
        // and a small tail of recent terminal entries.
        db.execute(sql`
          SELECT id, status, payload, attempt_count, max_attempts,
                 error_message, created_at, updated_at, completed_at, lease_owner
          FROM work_queue
          WHERE queue_name = 'front_sync_reprocess'
          ORDER BY
            CASE WHEN status IN ('pending','leased','processing') THEN 0 ELSE 1 END ASC,
            COALESCE(updated_at, created_at) DESC
          LIMIT 20
        `).catch((err: any) => {
          console.error("[FrontConsole] reprocess queue query failed:", err?.message);
          return { rows: [] } as any;
        }),
        // Bulk-action jobs are work-scheduler-backed (queueName='front_bulk_action').
        // Mirrored ephemerally in bulkActionJobs for live progress; the durable
        // tail is read here so just-completed jobs survive a server restart.
        db.execute(sql`
          SELECT id, status, payload, cursor_json, attempt_count, max_attempts,
                 error_message, created_at, updated_at, completed_at, lease_owner
          FROM work_queue
          WHERE queue_name = 'front_bulk_action'
          ORDER BY
            CASE WHEN status IN ('pending','leased','processing') THEN 0 ELSE 1 END ASC,
            COALESCE(updated_at, created_at) DESC
          LIMIT 20
        `).catch((err: any) => {
          console.error("[FrontConsole] bulk-action queue query failed:", err?.message);
          return { rows: [] } as any;
        }),
        // Filter-rule retroactive-apply jobs (queueName='front_filter_rule_apply').
        // Mirrored ephemerally in frontFilterRuleApplyJobs for live progress; the
        // durable tail is read here so just-completed jobs survive restart.
        db.execute(sql`
          SELECT id, status, payload, cursor_json, attempt_count, max_attempts,
                 error_message, created_at, updated_at, completed_at, lease_owner
          FROM work_queue
          WHERE queue_name = 'front_filter_rule_apply'
          ORDER BY
            CASE WHEN status IN ('pending','leased','processing') THEN 0 ELSE 1 END ASC,
            COALESCE(updated_at, created_at) DESC
          LIMIT 20
        `).catch((err: any) => {
          console.error("[FrontConsole] filter-rule-apply queue query failed:", err?.message);
          return { rows: [] } as any;
        }),
      ]);

      const syncState = getSyncState("front");

      // Raw imported population (raw_communication_records). Largest count;
      // includes per-version duplicates. Surfaced as "raw imported", NOT used
      // for match rate (Bug A) — see shared/frontConsoleMetrics.ts.
      const msgRow = (messageStatsResult as any).rows?.[0] ?? { total: 0, matched: 0, unmatched: 0 };
      const rawImportedTotal = Number(msgRow.total) || 0;
      const rawMatched = Number(msgRow.matched) || 0;
      const rawUnmatched = Number(msgRow.unmatched) || 0;

      // Task #2633 — backlog / applied-done helpers operate on the message-grain
      // pipeline-by-state map (msgPipelineByState). The canonical Matched /
      // Unmatched / Match rate now come from getFrontMessageGrainStats above.
      const { computeFrontBacklogCount, computeFrontAppliedDoneCount } =
        await import("@shared/frontConsoleMetrics");

      type ConsoleJob = {
        id: string;
        type:
          | "historical_recovery"
          | "rematch_all"
          | "reprocess_dismissed"
          | "bulk_action"
          | "filter_rule_apply"
          | "full_backfill_legacy";
        typeLabel: string;
        durability: "durable" | "ephemeral";
        canonical: boolean;
        deprecated: boolean;
        status: string;
        statusReason: string | null;
        progress: Record<string, number | string | null> | null;
        startedAt: string | null;
        startedBy: string | null;
        lastUpdateAt: string | null;
        lastError: string | null;
        // Bounded per-item failure list (bulk_action only) — present when
        // operators need to drill into specific row failures, not just see
        // an aggregate count + first error.
        itemErrors?: Array<{ rawCommId: string; error: string }>;
        finalSummary?: string | null;
        // Per-window detail for historical_recovery jobs. Surfaces every
        // window's status, statusReason, and first error so the operator
        // can see exactly why a window failed without opening the DB.
        windows?: Array<{
          label: string;
          status: string;
          statusReason: string | null;
          scanned: number;
          ingested: number;
          skipped: number;
          pages: number;
          errorCount: number;
          firstError: string | null;
        }>;
      };

      // Map work_queue raw status to ConsoleJob status (the canonical
      // small set the UI knows how to colour). Preserve detail in
      // statusReason so operators can see e.g. "leased" vs "pending".
      const mapWorkQueueStatus = (s: string): { status: string; reason: string | null } => {
        switch (s) {
          case "pending":
            return { status: "queued", reason: "pending" };
          case "leased":
            return { status: "queued", reason: "leased" };
          case "processing":
            return { status: "running", reason: null };
          case "completed":
            return { status: "complete", reason: null };
          case "failed":
            return { status: "failed", reason: null };
          case "dead_letter":
            return { status: "failed", reason: "dead_letter" };
          case "cancelled":
            return { status: "blocked", reason: "cancelled" };
          default:
            return { status: s, reason: null };
        }
      };

      const jobs: ConsoleJob[] = [];

      // 1) Historical recovery — durable, canonical.
      // Per-window detail (status, statusReason, errorCount, firstError)
      // is surfaced so the operator can see *why* a window failed without
      // opening the database. This is what makes silent disappearance
      // impossible from the UI side: every job that has windows shows
      // them, and every window that has errors shows the first one.
      for (const j of recoveryJobsList) {
        jobs.push({
          id: j.jobId,
          type: "historical_recovery",
          typeLabel: "Historical Recovery",
          durability: "durable",
          canonical: true,
          deprecated: false,
          status: j.status,
          statusReason: j.statusReason ?? null,
          progress: {
            scanned: j.totals.scanned,
            ingested: j.totals.ingested,
            skipped: j.totals.skipped,
            errors: j.totals.errors,
            pages: j.totals.pages,
            windows: j.windows.length,
          },
          startedAt: j.startedAt,
          startedBy: null,
          lastUpdateAt: j.completedAt ?? j.startedAt,
          lastError: j.error ?? null,
          windows: j.windows.map((w) => ({
            label: w.windowLabel,
            status: w.status,
            statusReason: w.statusReason ?? null,
            scanned: w.scanned,
            ingested: w.ingested,
            skipped: w.skipped,
            pages: w.pages,
            errorCount: w.errors.length,
            firstError: w.errors[0] ?? null,
          })),
        });
      }

      // 2) Rematch-all — ephemeral
      for (const [id, j] of rematchJobs.entries()) {
        const startedMs = j.startedAt ?? j.updatedAt ?? null;
        const lastUpdateMs = j.updatedAt ?? j.startedAt ?? null;
        jobs.push({
          id,
          type: "rematch_all",
          typeLabel: "Rematch All",
          durability: "ephemeral",
          canonical: true,
          deprecated: false,
          status: j.status,
          statusReason: null,
          progress: j.progress ?? (j.result && typeof j.result === "object"
            ? {
                processed: Number((j.result as any).processed ?? (j.result as any).totalProcessed ?? 0) || null,
                matched: Number((j.result as any).matched ?? 0) || null,
              }
            : null),
          startedAt: startedMs ? new Date(startedMs).toISOString() : null,
          startedBy: null,
          lastUpdateAt: lastUpdateMs ? new Date(lastUpdateMs).toISOString() : null,
          lastError: j.error ?? null,
        });
      }

      // 3) Reprocess-dismissed — durable (work_queue backed).
      // Surface running/queued first plus a tail of recent terminal
      // entries so operators can see what was reprocessed.
      const reprocessRows: any[] = (reprocessQueueRows as any).rows ?? [];
      for (const row of reprocessRows) {
        const mapped = mapWorkQueueStatus(String(row.status));
        const payload = (row.payload && typeof row.payload === "object") ? row.payload : {};
        const startedIso = row.created_at ? new Date(row.created_at).toISOString() : null;
        const updatedIso = row.completed_at
          ? new Date(row.completed_at).toISOString()
          : row.updated_at
          ? new Date(row.updated_at).toISOString()
          : startedIso;
        jobs.push({
          id: String(row.id),
          type: "reprocess_dismissed",
          typeLabel: "Reprocess Dismissed",
          durability: "durable",
          canonical: true,
          deprecated: false,
          status: mapped.status,
          statusReason: mapped.reason,
          progress: {
            cohort: payload.cohort ?? null,
            maxItems: typeof payload.maxItems === "number" ? payload.maxItems : null,
            resume: typeof payload.resume === "boolean" ? String(payload.resume) : null,
            attempts: `${row.attempt_count ?? 0}/${row.max_attempts ?? 0}`,
          },
          startedAt: startedIso,
          startedBy: null,
          lastUpdateAt: updatedIso,
          lastError: row.error_message ?? null,
        });
      }

      // 5) Bulk actions — durable (work_queue) + ephemeral mirror.
      // The mirror exposes per-item progress while the queue row is the
      // canonical source of truth post-restart.
      const { bulkActionJobs } = await import("../../services/frontBulkActions");
      const bulkActionRows: any[] = (bulkActionQueueRows as any).rows ?? [];
      const surfacedBulkIds = new Set<string>();
      for (const row of bulkActionRows) {
        const id = String(row.id);
        surfacedBulkIds.add(id);
        const mapped = mapWorkQueueStatus(String(row.status));
        const payload = (row.payload && typeof row.payload === "object") ? row.payload : {};
        // Durable final result persisted by the worker into cursor_json.result
        // (survives process restarts and the 30-min in-memory mirror reap).
        const cursorJson = (row.cursor_json && typeof row.cursor_json === "object") ? row.cursor_json : {};
        const persistedResult = (cursorJson.result && typeof cursorJson.result === "object") ? cursorJson.result : null;
        const mirror = bulkActionJobs.get(id);
        const startedIso = row.created_at ? new Date(row.created_at).toISOString() : null;
        const updatedIso = row.completed_at
          ? new Date(row.completed_at).toISOString()
          : row.updated_at
          ? new Date(row.updated_at).toISOString()
          : startedIso;
        jobs.push({
          id,
          type: "bulk_action",
          typeLabel: "Bulk Action",
          durability: "durable",
          canonical: true,
          deprecated: false,
          status: mirror?.status ?? persistedResult?.status ?? mapped.status,
          statusReason: persistedResult?.finalSummary ?? mapped.reason ?? null,
          progress: {
            action: payload.action ?? persistedResult?.action ?? mirror?.action ?? null,
            totalSelected:
              mirror?.totalSelected ??
              persistedResult?.totalSelected ??
              (typeof payload.totalSelected === "number" ? payload.totalSelected : null),
            totalProcessed: mirror?.totalProcessed ?? persistedResult?.totalProcessed ?? null,
            succeeded: mirror?.succeeded ?? persistedResult?.succeeded ?? null,
            failed: mirror?.failed ?? persistedResult?.failed ?? null,
            attempts: `${row.attempt_count ?? 0}/${row.max_attempts ?? 0}`,
          },
          startedAt: startedIso,
          startedBy: mirror?.startedBy ?? persistedResult?.startedBy ?? null,
          lastUpdateAt: updatedIso,
          lastError:
            row.error_message ??
            mirror?.errors?.[0]?.error ??
            persistedResult?.errors?.[0]?.error ??
            null,
          // Bounded per-item failure list so the operator can see specific
          // rawCommIds that failed, not just an aggregate count.
          itemErrors:
            (mirror?.errors && mirror.errors.length > 0
              ? mirror.errors.slice(0, 25)
              : Array.isArray(persistedResult?.errors)
              ? persistedResult.errors.slice(0, 25)
              : []) ?? [],
          finalSummary: persistedResult?.finalSummary ?? mirror?.finalSummary ?? null,
        });
      }
      // Mirror-only entries (queue row has been reaped or not yet visible)
      for (const [id, mirror] of bulkActionJobs.entries()) {
        if (surfacedBulkIds.has(id)) continue;
        jobs.push({
          id,
          type: "bulk_action",
          typeLabel: "Bulk Action",
          durability: "durable",
          canonical: true,
          deprecated: false,
          status: mirror.status,
          statusReason: null,
          progress: {
            action: mirror.action,
            totalSelected: mirror.totalSelected,
            totalProcessed: mirror.totalProcessed,
            succeeded: mirror.succeeded,
            failed: mirror.failed,
            attempts: null,
          },
          startedAt: mirror.startedAt ? new Date(mirror.startedAt).toISOString() : null,
          startedBy: mirror.startedBy,
          lastUpdateAt: mirror.updatedAt ? new Date(mirror.updatedAt).toISOString() : null,
          lastError: mirror.errors?.[0]?.error ?? null,
          itemErrors: mirror.errors?.slice(0, 25) ?? [],
          finalSummary: mirror.finalSummary ?? null,
        });
      }

      // 5b) Filter-rule retroactive applies — durable (work_queue) + ephemeral mirror.
      // Each apply queues a child bulk_action job (per matched batch) and the
      // mirror tracks selection/processed/succeeded/failed plus childBulkJobId.
      const { frontFilterRuleApplyJobs } = await import("../../services/frontFilterRules");
      const filterRuleApplyRows: any[] = (filterRuleApplyQueueRows as any).rows ?? [];
      const surfacedFilterRuleApplyIds = new Set<string>();
      for (const row of filterRuleApplyRows) {
        const id = String(row.id);
        surfacedFilterRuleApplyIds.add(id);
        const mapped = mapWorkQueueStatus(String(row.status));
        const payload = (row.payload && typeof row.payload === "object") ? row.payload : {};
        const cursorJson = (row.cursor_json && typeof row.cursor_json === "object") ? row.cursor_json : {};
        const persistedResult = (cursorJson.result && typeof cursorJson.result === "object") ? cursorJson.result : null;
        const mirror = frontFilterRuleApplyJobs.get(id);
        const startedIso = row.created_at ? new Date(row.created_at).toISOString() : null;
        const updatedIso = row.completed_at
          ? new Date(row.completed_at).toISOString()
          : row.updated_at
          ? new Date(row.updated_at).toISOString()
          : startedIso;
        jobs.push({
          id,
          type: "filter_rule_apply",
          typeLabel: "Filter Rule — Retroactive Apply",
          durability: "durable",
          canonical: true,
          deprecated: false,
          status: mirror?.status ?? persistedResult?.status ?? mapped.status,
          statusReason: persistedResult?.finalSummary ?? mirror?.finalSummary ?? mapped.reason ?? null,
          progress: {
            ruleId: payload.ruleId ?? mirror?.ruleId ?? persistedResult?.ruleId ?? null,
            childBulkJobId: mirror?.childBulkJobId ?? persistedResult?.childBulkJobId ?? null,
            totalSelected:
              mirror?.totalSelected ??
              persistedResult?.totalSelected ??
              (typeof payload.totalSelected === "number" ? payload.totalSelected : null),
            totalProcessed: mirror?.totalProcessed ?? persistedResult?.totalProcessed ?? null,
            succeeded: mirror?.succeeded ?? persistedResult?.succeeded ?? null,
            failed: mirror?.failed ?? persistedResult?.failed ?? null,
            attempts: `${row.attempt_count ?? 0}/${row.max_attempts ?? 0}`,
          },
          startedAt: startedIso,
          startedBy: mirror?.startedBy ?? persistedResult?.startedBy ?? null,
          lastUpdateAt: updatedIso,
          lastError: row.error_message ?? persistedResult?.lastError ?? null,
          finalSummary: persistedResult?.finalSummary ?? mirror?.finalSummary ?? null,
        });
      }
      // Mirror-only entries (queue row reaped or not yet visible).
      for (const [id, mirror] of frontFilterRuleApplyJobs.entries()) {
        if (surfacedFilterRuleApplyIds.has(id)) continue;
        jobs.push({
          id,
          type: "filter_rule_apply",
          typeLabel: "Filter Rule — Retroactive Apply",
          durability: "durable",
          canonical: true,
          deprecated: false,
          status: mirror.status,
          statusReason: mirror.finalSummary ?? null,
          progress: {
            ruleId: mirror.ruleId,
            childBulkJobId: mirror.childBulkJobId ?? null,
            totalSelected: mirror.totalSelected,
            totalProcessed: mirror.totalProcessed,
            succeeded: mirror.succeeded,
            failed: mirror.failed,
            attempts: null,
          },
          startedAt: mirror.startedAt ? new Date(mirror.startedAt).toISOString() : null,
          startedBy: mirror.startedBy,
          lastUpdateAt: mirror.updatedAt ? new Date(mirror.updatedAt).toISOString() : null,
          lastError: null,
          finalSummary: mirror.finalSummary ?? null,
        });
      }

      // 6) Legacy full-backfill — ephemeral, DEPRECATED.
      // Per Phase 0: surface only when present so operators can see the
      // tail of any in-flight or just-completed legacy run, but always
      // labelled as deprecated. Canonical path is historical_recovery.
      for (const [id, j] of backfillJobs.entries()) {
        const lastUpdateMs = j.updatedAt ?? null;
        jobs.push({
          id,
          type: "full_backfill_legacy",
          typeLabel: "Full Backfill (legacy)",
          durability: "ephemeral",
          canonical: false,
          deprecated: true,
          status: j.status,
          statusReason: "deprecated_use_historical_recovery",
          progress: j.result && typeof j.result === "object"
            ? {
                pages: Number((j.result as any).pages ?? 0) || null,
                ingested: Number((j.result as any).ingested ?? 0) || null,
                scanned: Number((j.result as any).scanned ?? 0) || null,
                errors: Array.isArray((j.result as any).errors) ? (j.result as any).errors.length : null,
              }
            : null,
          startedAt: lastUpdateMs ? new Date(lastUpdateMs).toISOString() : null,
          startedBy: null,
          lastUpdateAt: lastUpdateMs ? new Date(lastUpdateMs).toISOString() : null,
          lastError: j.error ?? null,
        });
      }

      // Order: running/queued first, then most-recently-updated.
      const isLive = (s: string) => s === "running" || s === "queued";
      jobs.sort((a, b) => {
        const aLive = isLive(a.status) ? 0 : 1;
        const bLive = isLive(b.status) ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        const aTs = a.lastUpdateAt ? new Date(a.lastUpdateAt).getTime() : 0;
        const bTs = b.lastUpdateAt ? new Date(b.lastUpdateAt).getTime() : 0;
        return bTs - aTs;
      });

      const pipelineSummary = pipelineMetrics
        ? {
            // Task #2633 — by-state counts, backlog, applied/done, failed and
            // dead-lettered all count individual MESSAGES (msgPipelineByState),
            // not conversations. Timing/age/cursor fields stay as measured by
            // getPipelineMetrics (they are durations, not conversation counts).
            backlogs: msgPipelineByState,
            // Task #2502 (Bug B) — real backlog excludes terminal-done states
            // (applied / triage_dismissed). `appliedDone` is surfaced as a
            // healthy "done" count, never as backlog.
            backlogCount: computeFrontBacklogCount(msgPipelineByState),
            appliedDoneCount: computeFrontAppliedDoneCount(msgPipelineByState),
            cursorAgeSeconds: pipelineMetrics.cursorFreshness.cursorAgeSeconds,
            pageTokenActive: pipelineMetrics.cursorFreshness.pageTokenActive,
            lastCursorAdvanceAt: pipelineMetrics.cursorFreshness.lastCursorAdvanceAt,
            health: {
              oldestUnprocessedAgeSeconds: pipelineMetrics.health.oldestUnprocessedAgeSeconds,
              avgDiscoveryToApplyMs: pipelineMetrics.health.avgDiscoveryToApplyMs,
              hydrateRetryCount: pipelineMetrics.health.hydrateRetryCount,
              failedCount: Number(msgPipelineByState["failed"]) || 0,
              deadLetteredCount: Number(msgPipelineByState["dead_lettered"]) || 0,
            },
            versionNoopsLast1h: pipelineMetrics.duplicatePrevention.versionNoopsLast1h,
            collectedAt: pipelineMetrics.collectedAt,
          }
        : null;

      res.set("Cache-Control", "no-store");
      res.json({
        connection: {
          connected: validation.valid,
          error: validation.valid ? null : (validation as any).error ?? null,
          lastSyncError: syncMeta.lastError,
          lastSyncSuccess: syncMeta.lastSuccess,
        },
        syncProgress: syncState.progress,
        lastCycle: syncState.lastCycle,
        messages: {
          // Raw imported population (raw_communication_records, incl. dupes).
          rawImportedTotal,
          rawMatched,
          rawUnmatched,
          // Task #2633 — every figure below counts individual MESSAGES.
          // `trackedTotal` is the non-orphaned Front-email message population.
          trackedTotal: msgGrainStats.total,
          matched: msgGrainStats.matched,
          unmatched: msgGrainStats.unmatched,
          matchable: msgGrainStats.matchable,
          matchRate: msgGrainStats.matchRate,
        },
        pipeline: pipelineSummary,
        jobs,
        canonicalRecoveryEndpoint: "/api/integrations/front/historical-recovery/execute",
        generatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("[FrontConsole] Overview endpoint error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // FRONT CONSOLE — "Bring it to 100%" simple view (Task #2691)
  // A dead-simple default surface for the CEO: "% of messages logged" +
  // matched/unmatched/dismissed classification + ONE idempotent button that
  // orchestrates the existing recovery drivers toward the honest reachable
  // (plan-limited-aware) target. No new Front API calls — cache/DB reads only;
  // the button hands off to existing background drains. See frontBringTo100.ts.
  // ============================================

  // GET simple summary (logged %, reachable target, classification, rolled-up status).
  app.get("/api/integrations/front/console/bring-to-100", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getFrontBringTo100Summary } = await import("../../services/frontBringTo100");
      res.set("Cache-Control", "no-store");
      res.json(await getFrontBringTo100Summary(db));
    } catch (error: any) {
      console.error("[FrontConsole] bring-to-100 summary error:", error?.message);
      res.status(500).json({ error: error?.message ?? "summary failed" });
    }
  });

  // GET rolled-up status only (lighter poll target for live progress).
  app.get("/api/integrations/front/console/bring-to-100/status", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getFrontBringTo100Summary } = await import("../../services/frontBringTo100");
      res.set("Cache-Control", "no-store");
      const s = await getFrontBringTo100Summary(db);
      res.json({
        status: s.status,
        statusDetail: s.statusDetail,
        blocked: s.blocked,
        queuePaused: s.queuePaused,
        target: s.target,
        generatedAt: s.generatedAt,
      });
    } catch (error: any) {
      console.error("[FrontConsole] bring-to-100 status error:", error?.message);
      res.status(500).json({ error: error?.message ?? "status failed" });
    }
  });

  // POST idempotent orchestration — kick the existing drivers in order. Team-lead
  // gated (it starts background work). Breaker/pause aware in the service layer.
  app.post("/api/integrations/front/console/bring-to-100", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { startFrontBringTo100 } = await import("../../services/frontBringTo100");
      const actorId = req.user?.claims?.sub || req.user?.id || null;
      const result = await startFrontBringTo100(actorId);
      res.set("Cache-Control", "no-store");
      res.json(result);
    } catch (error: any) {
      console.error("[FrontConsole] bring-to-100 run error:", error?.message);
      res.status(500).json({ error: error?.message ?? "run failed" });
    }
  });

}
