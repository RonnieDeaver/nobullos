/**
 * Integrations routes — filter rules CRUD + retroactive apply.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 5530–5743); sections: filter rules CRUD + retroactive apply.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { db } from "../../db";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import type {
  FilterRuleCreateInput,
  FilterRuleUpdateInput,
} from "../../services/frontFilterRules";
import type { AuthenticatedRequest } from "../requestContext";

export function registerIntegrationsFrontFilterRulesRoutes(app: Express) {
  // ============================================
  // FRONT CONSOLE — Phase 4: filter rules CRUD + retroactive apply
  // Rules are evaluated at ingest/match time (precedence:
  //   block > dismiss > never_match) and can be applied retroactively
  // via a background job (queueName='front_filter_rule_apply') that
  // reuses the Phase 3 bulk-action paths.
  // ============================================
  app.get("/api/integrations/front/filter-rules", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { listFilterRules } = await import("../../services/frontFilterRules");
      const rules = await listFilterRules();
      res.set("Cache-Control", "no-store");
      res.json({ rules });
    } catch (error: any) {
      console.error("[FrontFilterRules] list error:", error);
      res.status(500).json({ error: error?.message ?? "list failed" });
    }
  });

  app.post("/api/integrations/front/filter-rules", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res) => {
    try {
      const { createFilterRule } = await import("../../services/frontFilterRules");
      const userId = req.user?.claims?.sub ?? req.user?.id ?? "system";
      // F9: the service is the validator (throws invalid_type/invalid_scope…);
      // the cast documents the contract it enforces — no new validation here.
      const rule = await createFilterRule((req.body ?? {}) as FilterRuleCreateInput, userId);
      res.set("Cache-Control", "no-store");
      res.status(201).json({ rule });
    } catch (error: any) {
      console.error("[FrontFilterRules] create error:", error);
      const msg = error?.message ?? "create failed";
      const status = msg.includes("duplicate") || msg.includes("unique") ? 409 : 400;
      res.status(status).json({ error: msg });
    }
  });

  app.patch("/api/integrations/front/filter-rules/:id", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }>, res) => {
    try {
      const { updateFilterRule } = await import("../../services/frontFilterRules");
      const userId = req.user?.claims?.sub ?? req.user?.id ?? "system";
      const rule = await updateFilterRule(req.params.id, (req.body ?? {}) as FilterRuleUpdateInput, userId);
      res.set("Cache-Control", "no-store");
      res.json({ rule });
    } catch (error: any) {
      console.error("[FrontFilterRules] update error:", error);
      const msg = error?.message ?? "update failed";
      const status = msg === "rule_not_found" ? 404 : (msg.includes("duplicate") || msg.includes("unique") ? 409 : 400);
      res.status(status).json({ error: msg });
    }
  });

  app.delete("/api/integrations/front/filter-rules/:id", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }>, res) => {
    try {
      const { deleteFilterRule } = await import("../../services/frontFilterRules");
      const userId = req.user?.claims?.sub ?? req.user?.id ?? "system";
      await deleteFilterRule(req.params.id, userId);
      res.set("Cache-Control", "no-store");
      res.status(204).end();
    } catch (error: any) {
      console.error("[FrontFilterRules] delete error:", error);
      const status = error?.message === "rule_not_found" ? 404 : 400;
      res.status(status).json({ error: error?.message ?? "delete failed" });
    }
  });

  app.post("/api/integrations/front/filter-rules/preview", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { previewFilterRule } = await import("../../services/frontFilterRules");
      const { ruleId, type, scope, value } = req.body ?? {};
      let preview;
      if (typeof ruleId === "string" && ruleId.length > 0) {
        preview = await previewFilterRule({ ruleId });
      } else {
        if (!type || !scope || !value) {
          return res.status(400).json({ error: "ruleId or (type, scope, value) is required" });
        }
        preview = await previewFilterRule({ type, scope, value });
      }
      res.set("Cache-Control", "no-store");
      res.json(preview);
    } catch (error: any) {
      console.error("[FrontFilterRules] preview error:", error);
      res.status(400).json({ error: error?.message ?? "preview failed" });
    }
  });

  app.post("/api/integrations/front/filter-rules/:id/apply", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }>, res) => {
    try {
      const { applyFilterRuleRetroactively } = await import("../../services/frontFilterRules");
      const userId = req.user?.claims?.sub ?? req.user?.id ?? "system";
      const result = await applyFilterRuleRetroactively(req.params.id, userId);
      res.set("Cache-Control", "no-store");
      res.status(202).json(result);
    } catch (error: any) {
      console.error("[FrontFilterRules] apply error:", error);
      const status = error?.message === "rule_not_found" ? 404 : 400;
      res.status(status).json({ error: error?.message ?? "apply failed" });
    }
  });

  app.get("/api/integrations/front/filter-rules/apply-status/:jobId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getFilterRuleApplyJobState } = await import("../../services/frontFilterRules");
      const state = await getFilterRuleApplyJobState(req.params.jobId);
      res.set("Cache-Control", "no-store");
      if (!state) return res.status(404).json({ error: "job_not_found_or_reaped" });
      res.json(state);
    } catch (error: any) {
      console.error("[FrontFilterRules] apply-status error:", error);
      res.status(400).json({ error: error?.message ?? "status failed" });
    }
  });

  // Task #1264: per-jobId audit drawer source. Returns every front_filter_rule_apply_*
  // activity-log entry whose metadata.jobId matches, ordered oldest-first so
  // the drawer reads top-to-bottom as the job progressed (started → delegated
  // → completed/failed). Resolves the actor's display name like other audit
  // surfaces do so the drawer doesn't render bare user UUIDs.
  app.get(
    "/api/integrations/front/filter-rules/apply-jobs/:jobId/audit",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const jobId = String(req.params.jobId || "").trim();
        if (!jobId) return res.status(400).json({ error: "jobId required" });
        const { userActivityLogs } = await import("@shared/schema");
        const { users } = await import("@shared/models/auth");
        const { sql: dsql, eq: deq, and: dand, inArray: din, asc } = await import("drizzle-orm");
        const actionTypes = [
          "front_filter_rule_apply_started",
          "front_filter_rule_apply_delegated",
          "front_filter_rule_apply_completed",
          "front_filter_rule_apply_failed",
        ];
        const rows = await db
          .select({
            id: userActivityLogs.id,
            userId: userActivityLogs.userId,
            actionType: userActivityLogs.actionType,
            actionDetail: userActivityLogs.actionDetail,
            metadata: userActivityLogs.metadata,
            timestamp: userActivityLogs.timestamp,
            userFirstName: users.firstName,
            userLastName: users.lastName,
            userEmail: users.email,
          })
          .from(userActivityLogs)
          .leftJoin(users, deq(userActivityLogs.userId, users.id))
          .where(
            dand(
              din(userActivityLogs.actionType, actionTypes),
              dsql`${userActivityLogs.metadata}->>'jobId' = ${jobId}`,
            ),
          )
          .orderBy(asc(userActivityLogs.timestamp))
          .limit(200);
        const items = rows.map((r) => ({
          id: r.id,
          actionType: r.actionType,
          actionDetail: r.actionDetail,
          metadata: r.metadata,
          timestamp: r.timestamp,
          userId: r.userId,
          userName:
            [r.userFirstName, r.userLastName].filter(Boolean).join(" ").trim() ||
            r.userEmail ||
            null,
        }));
        res.set("Cache-Control", "no-store");
        res.json({ jobId, items });
      } catch (error: any) {
        console.error("[FrontFilterRules] apply-job audit lookup error:", error);
        res.status(500).json({ error: error?.message ?? "audit lookup failed" });
      }
    },
  );


  // Task #1270: per-rule recent-hit drill-down. Returns the last N rows that
  // fired this rule (sender, subject, conversation id, when) so admins can
  // see exactly what a rule is catching instead of only the aggregate count.
  app.get("/api/integrations/front/filter-rules/:id/hits", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listRecentRuleHits, getFilterRule } = await import("../../services/frontFilterRules");
      const rule = await getFilterRule(req.params.id);
      if (!rule) return res.status(404).json({ error: "rule_not_found" });
      const limitRaw = Number.parseInt(String(req.query.limit ?? "25"), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
      const hits = await listRecentRuleHits(rule.id, limit);
      res.set("Cache-Control", "no-store");
      res.json({ ruleId: rule.id, hits });
    } catch (error: any) {
      console.error("[FrontFilterRules] hits error:", error);
      res.status(400).json({ error: error?.message ?? "hits failed" });
    }
  });

  // Per-rule latest apply-job state, keyed by ruleId. The admin UI polls
  // this to render live "applying…" progress and post-completion totals on
  // each filter-rule card without remembering jobIds across reloads.
  // Sources: in-memory mirror (live progress) merged with the most recent
  // durable work_queue row per rule (rebuilt from cursor_json), so totals
  // persist after the 30-minute mirror reap and across server restarts.
  // A missing ruleId means the rule has never been applied retroactively.
  app.get("/api/integrations/front/filter-rules/apply-jobs/active", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getLatestFilterRuleApplyJobsByRule } = await import("../../services/frontFilterRules");
      res.set("Cache-Control", "no-store");
      res.json({ byRuleId: await getLatestFilterRuleApplyJobsByRule() });
    } catch (error: any) {
      console.error("[FrontFilterRules] apply-jobs/active error:", error);
      res.status(400).json({ error: error?.message ?? "status failed" });
    }
  });

}
