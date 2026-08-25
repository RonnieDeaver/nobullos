/**
 * Integrations routes — pipeline health.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 5386–5415, 6363–6418); sections: pipeline health; Front pipeline metrics; cutover status.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager } from "../middleware";

export function registerIntegrationsPipelineRoutes(app: Express) {
  app.get("/api/integrations/pipeline/health", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getPipelineHealth, getSourceSpecificHealth } = await import("../../services/pipelineObservability");
      const [pipelineHealth, sourceHealth] = await Promise.all([
        getPipelineHealth(),
        getSourceSpecificHealth(),
      ]);
      res.json({
        pipeline: pipelineHealth,
        sources: sourceHealth,
        generatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("[Pipeline] Health endpoint error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/pipeline-metrics", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getPipelineMetrics } = await import("../../services/frontPipelineMetrics");
      const metrics = await getPipelineMetrics();
      res.set("Cache-Control", "no-store");
      res.json(metrics);
    } catch (error: any) {
      console.error("[Integrations] Pipeline metrics error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/pipeline/cutover-status", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { PERF } = await import("../../perfConfig");
      const { getCutoverDecision, getShadowComparisonSummary, getShadowComparisonLog } = await import("../../services/cutoverGuard");

      const source = req.query.source as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 200);

      const frontDecision = getCutoverDecision("front");
      const zoomDecision = getCutoverDecision("zoom");
      const semrushDecision = getCutoverDecision("semrush");

      const shadowSummary = getShadowComparisonSummary();
      const recentComparisons = getShadowComparisonLog(
        source as any || undefined,
        limit,
      );

      res.json({
        flags: {
          frontEventIngestEnabled: PERF.FRONT_EVENT_INGEST_ENABLED,
          frontReconciliationEnabled: PERF.FRONT_RECONCILIATION_ENABLED,
          zoomEventIngestEnabled: PERF.ZOOM_EVENT_INGEST_ENABLED,
          zoomReconciliationEnabled: PERF.ZOOM_RECONCILIATION_ENABLED,
          semrushInventorySyncEnabled: PERF.SEMRUSH_INVENTORY_SYNC_ENABLED,
          semrushReportRefreshEnabled: PERF.SEMRUSH_REPORT_REFRESH_ENABLED,
          durableApplyEnabled: PERF.DURABLE_APPLY_ENABLED,
          legacyDirectMutationFrontEnabled: PERF.LEGACY_DIRECT_MUTATION_FRONT_ENABLED,
          legacyDirectMutationZoomEnabled: PERF.LEGACY_DIRECT_MUTATION_ZOOM_ENABLED,
          legacyDirectMutationSemrushEnabled: PERF.LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED,
          frontPipelineFetchSplitEnabled: PERF.FRONT_PIPELINE_FETCH_SPLIT_ENABLED,
          frontPipelineVersionedDiscoveryEnabled: PERF.FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED,
          frontPipelineHydrateEnabled: PERF.FRONT_PIPELINE_HYDRATE_ENABLED,
          frontPipelineProcessSplitEnabled: PERF.FRONT_PIPELINE_PROCESS_SPLIT_ENABLED,
          frontPipelineApplyEnabled: PERF.FRONT_PIPELINE_APPLY_ENABLED,
          frontBackgroundJobsEnqueueEnabled: PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED,
          frontLegacyInlineProcessingEnabled: PERF.FRONT_LEGACY_INLINE_PROCESSING_ENABLED,
          frontLegacyDoubleFetchEnabled: PERF.FRONT_LEGACY_DOUBLE_FETCH_ENABLED,
        },
        decisions: {
          front: frontDecision,
          zoom: zoomDecision,
          semrush: semrushDecision,
        },
        shadowComparison: {
          summary: shadowSummary,
          recent: recentComparisons,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("[Pipeline] Cutover status error:", error);
      res.status(500).json({ error: error.message });
    }
  });

}
