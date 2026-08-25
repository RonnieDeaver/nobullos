import type { Express } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { eq, sql, and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCommandCenterAccess, requireAccountManager, requireTeamLead } from "./middleware";
import { clients, aiSuggestionStatuses } from "@shared/schema";
import { bindArrayParam } from "../utils/sqlArray";
import { composeEmailThreadTextFromSiblings } from "../storage/communicationStorage";

  async function attachAgentDecisionInfo(
    messages: Array<Record<string, any>>,
    communicationType: "zoom" | "slack" | "front_email",
  ): Promise<void> {
    for (const m of messages) {
      m.review = null;
      m.resolved = null;
    }

    const reviewLookupKeys = new Set<string>();
    for (const m of messages) {
      if (m.id) reviewLookupKeys.add(String(m.id));
      if (m.externalSourceId) reviewLookupKeys.add(String(m.externalSourceId));
    }
    if (reviewLookupKeys.size === 0) return;

    const keys = Array.from(reviewLookupKeys);
    const decisionRows = await db.execute(sql`
      SELECT DISTINCT ON (amd.communication_id)
             amd.id as "decisionId",
             amd.communication_id as "communicationId",
             amd.status as "status",
             amd.client_id as "clientId",
             amd.confidence_score as "confidenceScore",
             amd.review_reason as "reviewReason",
             amd.explanation_summary as "explanationSummary",
             amd.candidate_shortlist_json as "candidateShortlist",
             amd.prior_client_id as "priorClientId",
             amd.review_resolution as "reviewResolution",
             amd.reviewed_at as "reviewedAt",
             amd.corrected_to_client_id as "correctedToClientId",
             sc.firm_name as "suggestedClientName",
             pc.firm_name as "priorClientName",
             cc.firm_name as "correctedToClientName",
             u.email as "reviewerEmail",
             u.first_name as "reviewerFirstName",
             u.last_name as "reviewerLastName"
      FROM agent_match_decisions amd
      LEFT JOIN clients sc ON amd.client_id = sc.id
      LEFT JOIN clients pc ON amd.prior_client_id = pc.id
      LEFT JOIN clients cc ON amd.corrected_to_client_id = cc.id
      LEFT JOIN users u ON amd.reviewed_by_user_id = u.id
      WHERE amd.communication_type = ${communicationType}
        AND amd.status = 'review_required'
        AND amd.communication_id = ANY(${bindArrayParam(keys)})
      ORDER BY amd.communication_id, amd.created_at DESC
    `);

    const decisionByKey = new Map<string, any>();
    const candidateClientIds = new Set<string>();
    for (const row of decisionRows.rows as any[]) {
      decisionByKey.set(String(row.communicationId), row);
      const list = Array.isArray(row.candidateShortlist) ? row.candidateShortlist : [];
      for (const c of list) {
        if (c?.clientId) candidateClientIds.add(String(c.clientId));
      }
    }

    const candidateNameMap = new Map<string, string>();
    if (candidateClientIds.size > 0) {
      const candIdList = Array.from(candidateClientIds);
      const clientRows = await db.execute(sql`
        SELECT id, firm_name as "firmName"
        FROM clients
        WHERE id = ANY(${bindArrayParam(candIdList)})
      `);
      for (const cr of clientRows.rows as any[]) {
        candidateNameMap.set(String(cr.id), cr.firmName);
      }
    }

    const formatReviewerName = (row: any): string | null => {
      const first = (row.reviewerFirstName || "").trim();
      const last = (row.reviewerLastName || "").trim();
      const full = `${first} ${last}`.trim();
      return full || row.reviewerEmail || null;
    };

    const parseDismissReason = (matchMethod: string | null): string | null => {
      if (!matchMethod || typeof matchMethod !== "string") return null;
      const lower = matchMethod.toLowerCase();
      if (!lower.startsWith("dismissed:")) return null;
      const reason = matchMethod.slice("dismissed:".length).trim();
      return reason || null;
    };

    for (const m of messages) {
      const decision =
        decisionByKey.get(String(m.id)) ||
        (m.externalSourceId ? decisionByKey.get(String(m.externalSourceId)) : null);
      if (!decision) continue;

      if (decision.reviewResolution) {
        const resolution = decision.reviewResolution as "approved" | "reassigned" | "dismissed";
        let finalClientId: string | null = null;
        let finalClientName: string | null = null;
        if (resolution === "approved") {
          finalClientId = decision.clientId || null;
          finalClientName = decision.suggestedClientName || null;
        } else if (resolution === "reassigned") {
          finalClientId = decision.correctedToClientId || null;
          finalClientName = decision.correctedToClientName || null;
        }
        m.resolved = {
          decisionId: decision.decisionId,
          resolution,
          reviewedAt: decision.reviewedAt,
          reviewerName: formatReviewerName(decision),
          reviewReason: decision.reviewReason,
          suggestedClientId: decision.clientId || null,
          suggestedClientName: decision.suggestedClientName || null,
          finalClientId,
          finalClientName,
          dismissReason: resolution === "dismissed" ? parseDismissReason(m.matchMethod) : null,
        };
      } else if (decision.status === "review_required") {
        const candidates = Array.isArray(decision.candidateShortlist) ? decision.candidateShortlist : [];
        m.review = {
          decisionId: decision.decisionId,
          reviewReason: decision.reviewReason,
          explanationSummary: decision.explanationSummary,
          suggestedClientId: decision.clientId,
          suggestedClientName: decision.suggestedClientName,
          suggestedConfidence: decision.confidenceScore,
          priorClientId: decision.priorClientId,
          priorClientName: decision.priorClientName,
          candidates: candidates.map((c: any) => ({
            clientId: c?.clientId || null,
            clientName: c?.clientId ? candidateNameMap.get(String(c.clientId)) || null : null,
            confidenceScore: typeof c?.confidenceScore === "number" ? c.confidenceScore : null,
            evidenceType: c?.evidenceType || null,
            explanationSummary: c?.explanationSummary || null,
          })),
        };
      }
    }
  }

  export function registerCommunicationRoutes(app: Express) {
    // ============================================
  // RAW COMMUNICATION LOG
  // ============================================

  app.get("/api/clients/:clientId/communications", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const filters: any = {};
      if (req.query.sourceType) filters.sourceType = req.query.sourceType;
      if (req.query.direction) filters.direction = req.query.direction;
      if (req.query.processingStatus) filters.processingStatus = req.query.processingStatus;
      if (req.query.reviewStatus) filters.reviewStatus = req.query.reviewStatus;
      if (req.query.dateFrom) filters.dateFrom = new Date(req.query.dateFrom as string);
      if (req.query.dateTo) filters.dateTo = new Date(req.query.dateTo as string);
      if (req.query.hasSuggestions !== undefined) filters.hasSuggestions = req.query.hasSuggestions === "true";
      if (req.query.search) filters.search = req.query.search;
      const records = await storage.listRawCommunications(req.params.clientId, filters);
      res.json(records);
    } catch (error) {
      console.error("[CommLog] Error listing communications:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/communications", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { insertRawCommunicationSchema } = await import("@shared/schema");
      const parsed = insertRawCommunicationSchema.safeParse({
        ...req.body,
        clientId: req.params.clientId,
        createdBy: req.user.claims.sub,
        timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
      });
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
      const isTouchpoint = classifyTouchpoint({ sourceType: parsed.data.sourceType ?? "" });
      const record = await storage.createRawCommunication(parsed.data, { isTouchpoint });

      // fire-and-forget after 201: background analysis, errors logged inside
      void (async () => {
        try {
          const { analyzeCommunication } = await import("../services/communicationAnalysis");
          await analyzeCommunication(record.id);
          const suggestions = await storage.listAiSuggestions(req.params.clientId, {
            rawCommunicationRecordId: record.id,
          });
          if (suggestions.length > 0) {
            // Task #1713 — Stage B: per-user inbox via notifyUser().
            const { notifyOwnerOfCommSuggestions } = await import(
              "../services/notifications/commSuggestions"
            );
            await notifyOwnerOfCommSuggestions({
              clientId: req.params.clientId,
              recordId: record.id,
              recordTitle: record.title ?? "communication",
              suggestionCount: suggestions.length,
            });
          }
        } catch (err) {
          console.error("[CommLog] Background analysis failed for", record.id, err);
        }
      })();

      res.status(201).json(record);
    } catch (error) {
      console.error("[CommLog] Error creating communication:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/communications/:commId", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const record = await storage.getRawCommunication(req.params.commId);
      if (!record || record.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Communication not found" });
      }
      const suggestions = await storage.listAiSuggestions(req.params.clientId, {
        rawCommunicationRecordId: req.params.commId,
      });

      let composedThreadContent: string | null = null;
      let threadContentUnavailable = false;

      const isEmailThread =
        record.sourceType === "front_email" &&
        record.sourceSubtype === "email_thread";

      if (isEmailThread && !record.contentText && record.externalThreadId) {
        const siblings = await storage.listEmailMessageSiblingsByThreadId(
          record.externalThreadId,
          req.params.clientId,
        );
        composedThreadContent = composeEmailThreadTextFromSiblings(siblings);
        if (!composedThreadContent) threadContentUnavailable = true;
      }

      res.json({ ...record, suggestions, composedThreadContent, threadContentUnavailable });
    } catch (error) {
      console.error("[CommLog] Error fetching communication:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.delete("/api/clients/:clientId/communications/:commId", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const record = await storage.getRawCommunication(req.params.commId);
      if (!record || record.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Communication not found" });
      }
      await storage.deleteRawCommunication(req.params.commId);
      res.json({ success: true });
    } catch (error) {
      console.error("[CommLog] Error deleting communication:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/communications/:commId/analyze", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const record = await storage.getRawCommunication(req.params.commId);
      if (!record || record.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Communication not found" });
      }
      const { analyzeCommunication } = await import("../services/communicationAnalysis");
      await analyzeCommunication(req.params.commId);
      const updated = await storage.getRawCommunication(req.params.commId);
      const suggestions = await storage.listAiSuggestions(req.params.clientId, {
        rawCommunicationRecordId: req.params.commId,
      });

      if (suggestions.length > 0) {
        // Task #1713 — Stage B: per-user inbox via notifyUser().
        const { notifyOwnerOfCommSuggestions } = await import(
          "../services/notifications/commSuggestions"
        );
        await notifyOwnerOfCommSuggestions({
          clientId: req.params.clientId,
          recordId: req.params.commId,
          recordTitle: record.title ?? "communication",
          suggestionCount: suggestions.length,
        });
      }

      res.json({ ...updated, suggestions });
    } catch (error) {
      console.error("[CommLog] Error analyzing communication:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/suggestions", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const filters: any = {};
      if (req.query.status) filters.status = req.query.status;
      if (req.query.destinationType) filters.destinationType = req.query.destinationType;
      if (req.query.rawCommunicationRecordId) filters.rawCommunicationRecordId = req.query.rawCommunicationRecordId;
      const suggestions = await storage.listAiSuggestions(req.params.clientId, filters);
      res.json(suggestions);
    } catch (error) {
      console.error("[CommLog] Error listing suggestions:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/suggestions/count", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const count = await storage.countPendingSuggestions(req.params.clientId);
      res.json({ count });
    } catch (error) {
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/suggestions/:suggestionId", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const suggestion = await storage.getAiSuggestion(req.params.suggestionId);
      if (!suggestion || suggestion.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Suggestion not found" });
      }
      const { action, editedTitle, editedBody, resolutionNotes } = req.body;
      const validActions = ["approve", "edit_and_approve", "reject", "snooze", "no_update_needed"];
      if (!validActions.includes(action)) {
        return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(", ")}` });
      }

      let resultingRecordId: string | undefined;

      if (action === "approve" || action === "edit_and_approve") {
        const title = action === "edit_and_approve" && editedTitle ? editedTitle : suggestion.suggestedTitle;
        const body = action === "edit_and_approve" && editedBody ? editedBody : suggestion.suggestedBody;

        if (suggestion.destinationType === "command_panel") {
          const existingPanel = await storage.getCommandPanel(req.params.clientId);
          const fieldChanges = suggestion.suggestedFieldChangesJson as Record<string, any> | null;
          if (fieldChanges && Object.keys(fieldChanges).length > 0) {
            const panelData: any = {
              clientId: req.params.clientId,
              ...fieldChanges,
            };
            const panel = await storage.upsertCommandPanel(panelData);
            resultingRecordId = panel.clientId;
            await storage.createCommandPanelHistory({
              clientId: req.params.clientId,
              commandPanelId: panel.id,
              changedBy: req.user.claims.sub,
              fieldName: Object.keys(fieldChanges).join(", "),
              oldValue: null,
              newValue: JSON.stringify(fieldChanges),
            });
          } else {
            const entry = await storage.createIntelligenceFeedEntry({
              clientId: req.params.clientId,
              createdBy: req.user.claims.sub,
              entryType: "strategy_insight",
              title: `[Command Panel] ${title}`,
              body: body || "",
              aiConfidence: "medium",
              status: "approved",
            });
            resultingRecordId = entry.id;
          }
        } else if (suggestion.destinationType === "intelligence_feed") {
          const entry = await storage.createIntelligenceFeedEntry({
            clientId: req.params.clientId,
            createdBy: req.user.claims.sub,
            entryType: "strategy_insight",
            title,
            body: body || "",
            aiConfidence: suggestion.confidenceScore && suggestion.confidenceScore > 0.7 ? "high" : suggestion.confidenceScore && suggestion.confidenceScore > 0.4 ? "medium" : "low",
            status: "approved",
          });
          resultingRecordId = entry.id;
        } else if (suggestion.destinationType === "action_log") {
          const entry = await storage.createActionLogEntry({
            clientId: req.params.clientId,
            createdBy: req.user.claims.sub,
            actionType: "other",
            title,
            whatChanged: body || "",
            sourceReferences: { rawCommunicationRecordId: suggestion.rawCommunicationRecordId },
          });
          resultingRecordId = entry.id;
        }
      }

      const statusMap: Record<string, typeof aiSuggestionStatuses[number]> = {
        approve: "approved",
        edit_and_approve: "edited_and_approved",
        reject: "rejected",
        snooze: "snoozed",
        no_update_needed: "no_update_needed",
      };

      const updated = await storage.updateAiSuggestion(req.params.suggestionId, {
        status: statusMap[action],
        resolvedAt: action !== "snooze" ? new Date() : null,
        resolutionNotes: resolutionNotes || null,
        resultingRecordId: resultingRecordId || null,
      });

      const allSuggestions = await storage.listAiSuggestions(req.params.clientId, {
        rawCommunicationRecordId: suggestion.rawCommunicationRecordId,
      });
      const pending = allSuggestions.filter(s => s.status === "pending" || s.status === "snoozed");
      const resolved = allSuggestions.filter(s => !["pending", "snoozed"].includes(s.status));
      let newReviewStatus = "suggestions_pending";
      if (pending.length === 0 && resolved.length > 0) {
        const hasApproved = resolved.some(s => s.status === "approved" || s.status === "edited_and_approved");
        newReviewStatus = hasApproved ? "resolved" : "no_updates_needed";
      } else if (pending.length > 0 && resolved.length > 0) {
        newReviewStatus = "partially_resolved";
      }
      await storage.updateRawCommunication(suggestion.rawCommunicationRecordId, {
        reviewStatus: newReviewStatus,
      } as any);

      const feedbackTypeMap: Record<string, string> = {
        approve: "confirmed",
        edit_and_approve: "corrected",
        reject: "dismissed",
        no_update_needed: "dismissed",
      };
      const mappedFeedback = feedbackTypeMap[action];
      if (mappedFeedback) {
        try {
          await storage.createAgentFeedback({
            agentType: "communication_analysis",
            targetRecordId: req.params.suggestionId,
            targetRecordType: "ai_suggestion",
            clientId: req.params.clientId,
            feedbackType: mappedFeedback,
            correctedValue: action === "edit_and_approve" ? (editedBody || editedTitle || null) : null,
            userId: req.user?.claims?.sub || req.user?.id || null,
          });
          const { propagateFeedbackToKnowledge } = await import("../services/agentKnowledgeService");
          await propagateFeedbackToKnowledge(
            req.params.clientId,
            "communication_analysis",
            suggestion.rawCommunicationRecordId,
            mappedFeedback as "confirmed" | "corrected" | "dismissed",
          );
        } catch (err: any) {
          console.error("[CommLog] Agent feedback recording failed:", err.message);
        }
      }

      res.json(updated);
    } catch (error) {
      console.error("[CommLog] Error updating suggestion:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // FRONT EMAIL INTEGRATION
  // ============================================

  app.get("/api/integrations/front/status", isAuthenticated, async (req: any, res) => {
    try {
      const { isConnected } = await import("../services/frontIntegration");
      const connected = await isConnected();
      res.json({ connected });
    } catch (error: any) {
      // Task #2811 — a THROWN token read (DB blip / pool saturation) is NOT
      // a confirmed disconnect. The old catch answered `connected: false`,
      // flashing "Not Connected" for a healthy integration. Mirror the
      // Google Ads route (Task #2807): explicit status-unknown 503 so the
      // client preserves last-known-good instead of committing a downgrade.
      console.error("[Front] /status error:", error?.message || error);
      res.status(503).json({
        statusUnknown: true,
        probeFailed: true,
        connected: null,
        reason: String(error?.message ?? error).slice(0, 200),
      });
    }
  });

  app.get("/api/integrations/front/authorize", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getAuthorizationUrl } = await import("../services/frontIntegration");
      const url = await getAuthorizationUrl();
      res.json({ url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code) {
        return res.status(400).send("Missing authorization code");
      }
      if (!state) {
        return res.status(400).send("Missing state parameter");
      }
      const { validateOAuthState, exchangeCodeForToken, startPeriodicClientMatching } = await import("../services/frontIntegration");
      const stateValid = await validateOAuthState(state);
      if (!stateValid) {
        return res.status(403).send("Invalid or expired OAuth state — possible CSRF. Please try authorizing again.");
      }
      const actingUserId = (req as any).user?.claims?.sub as string | undefined;
      await exchangeCodeForToken(code, actingUserId);
      const { invalidateIntegrationStatus: invalidateFront } = await import("../services/integrationStatusCache");
      await invalidateFront("front");
      res.send(`
        <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f0eb;">
          <div style="text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
            <!-- COLOR DECISION (Task #4567): ALIGNED — success heading uses status-ok
                 green #2A6F47 (5.9:1 on white), not the retired burgundy #6B2C3E,
                 so a success state never reads as a danger hue. -->
            <h2 style="color:#2A6F47;">Front Connected Successfully</h2>
            <p style="color:#666;">You can close this tab and return to the app.</p>
          </div>
        </body></html>
      `);
      // fire-and-forget after response sent: start maintenance jobs, errors logged
      void Promise.resolve().then(() => {
        try {
          startPeriodicClientMatching();
          console.log("[Front] Maintenance jobs started successfully");
        } catch (err) {
          console.error("[Front] Maintenance jobs startup error:", err);
        }
      });
    } catch (error: any) {
      console.error("[Front] OAuth callback error:", error);
      res.status(500).send(`Authorization failed: ${error.message}`);
    }
  });

  app.get("/api/integrations/front/inboxes", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listInboxes } = await import("../services/frontIntegration");
      const inboxes = await listInboxes();
      res.json(inboxes);
    } catch (error: any) {
      console.error("[Front] List inboxes error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/tags", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listTags } = await import("../services/frontIntegration");
      const tags = await listTags();
      res.json(tags);
    } catch (error: any) {
      console.error("[Front] List tags error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/search", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const query = req.query.q as string;
      if (!query) return res.status(400).json({ error: "Query parameter 'q' is required" });
      const { searchConversations } = await import("../services/frontIntegration");
      const conversations = await searchConversations(query, Number(req.query.limit) || 25);
      res.json(conversations);
    } catch (error: any) {
      console.error("[Front] Search error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/sync/status", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { validateConnection } = await import("../services/frontIntegration");
      const validation = await validateConnection();
      const unmatchedCount = await storage.countUnmatchedFrontSyncEmails();
      res.json({ connected: validation.valid, unmatchedCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #980: ranked client suggestions for the Front "Assign to client"
  // picker. Mirrors `/api/twilio/client-suggestions` (Task #969) but keyed
  // off sender email instead of phone. Surfaces the most likely firm(s)
  // for an unmatched email so an admin can one-click instead of scrolling
  // the full firm list.
  app.get("/api/integrations/front/client-suggestions", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const email = typeof req.query.email === "string" ? req.query.email : "";
      const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 5;
      if (!email || !email.includes("@")) {
        return res.json([]);
      }
      const { getClientSuggestionsForFrontEmail } = await import("../services/frontIntegration");
      const suggestions = await getClientSuggestionsForFrontEmail(email, limit);
      res.json(suggestions);
    } catch (error: any) {
      console.error("[Front] Client suggestions error:", error?.message);
      res.status(500).json({ error: "Failed to fetch suggestions" });
    }
  });

  app.get("/api/integrations/front/unmatched", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const emails = await storage.listFrontSyncEmails({ matchStatus: "unmatched", limit: Number(req.query.limit) || 50 });
      res.json(emails);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/unmatched/count", isAuthenticated, async (req: any, res) => {
    try {
      const count = await storage.countUnmatchedFrontSyncEmails();
      res.json({ count });
    } catch (error: any) {
      res.json({ count: 0 });
    }
  });

  app.post("/api/integrations/front/unmatched/:id/assign", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { clientId } = req.body;
      if (!clientId) return res.status(400).json({ error: "clientId is required" });
      const { assignUnmatchedEmail } = await import("../services/frontIntegration");
      const result = await assignUnmatchedEmail(req.params.id, clientId, req.user.claims.sub);

      // fire-and-forget: background analysis, errors logged inside
      void (async () => {
        try {
          const { analyzeCommunication } = await import("../services/communicationAnalysis");
          await analyzeCommunication(result.recordId);
        } catch (err) {
          console.error("[Front] Background analysis failed:", err);
        }
      })();

      res.json({ success: true, ...result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/front/unmatched/:id/dismiss", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { dismissUnmatchedEmail } = await import("../services/frontIntegration");
      await dismissUnmatchedEmail(req.params.id, req.user.claims.sub);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/communications/ingest-front", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { conversationId, tagId, inboxId, query: searchQuery, limit } = req.body;
      const { ingestConversation, ingestRecentConversations } = await import("../services/frontIntegration");

      if (conversationId) {
        const result = await ingestConversation(conversationId, req.params.clientId, req.user.claims.sub);

        // fire-and-forget: background analysis, errors logged inside
        void (async () => {
          try {
            const { analyzeCommunication } = await import("../services/communicationAnalysis");
            await analyzeCommunication(result.recordId);
            const suggestions = await storage.listAiSuggestions(req.params.clientId, {
              rawCommunicationRecordId: result.recordId,
            });
            if (suggestions.length > 0) {
              // Task #1713 — Stage B: per-user inbox via notifyUser().
              const { notifyOwnerOfCommSuggestions } = await import(
                "../services/notifications/commSuggestions"
              );
              await notifyOwnerOfCommSuggestions({
                clientId: req.params.clientId,
                recordId: result.recordId,
                recordTitle: "Front conversation",
                suggestionCount: suggestions.length,
                sourceLabel: "Front conversation",
              });
            }
          } catch (err) {
            console.error("[Front] Background analysis failed:", err);
          }
        })();

        res.json({ success: true, ...result });
      } else {
        const result = await ingestRecentConversations(req.params.clientId, req.user.claims.sub, {
          tagId, inboxId, query: searchQuery, limit: limit || 10,
        });

        res.json({ success: true, ...result });
      }
    } catch (error: any) {
      console.error("[Front] Ingest error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // SLACK INTEGRATION
  // ============================================


  app.get("/api/integrations/slack/status", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { isConnected, testConnection, SLACK_BOT_TOKEN_SETTING_KEY } = await import("../services/slackIntegration");
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const { storage } = await import("../storage");
      const connected = await isConnected();
      const setting = await storage.getSystemSetting(SLACK_BOT_TOKEN_SETTING_KEY);
      const userMap = await resolveLastEditedUsers([setting?.updatedBy]);
      const lastEdited = { botToken: buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap) };
      if (connected) {
        const test = await testConnection();
        res.json({ connected: true, team: test.team, user: test.user, valid: test.ok, lastEdited });
      } else {
        res.json({ connected: false, lastEdited });
      }
    } catch (error: any) {
      // Task #2811 — read-threw ≠ not connected (same contract as the
      // Google Ads route, Task #2807). `isConnected()` already guards its
      // own fresh-read fallback, but the cached settings read, the
      // lastEdited settings read, or `testConnection()` can still throw on
      // a DB blip; that must never render as "Not Connected".
      console.error("[Slack] /status error:", error?.message || error);
      res.status(503).json({
        statusUnknown: true,
        probeFailed: true,
        connected: null,
        reason: String(error?.message ?? error).slice(0, 200),
      });
    }
  });

  app.post("/api/integrations/slack/connect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== "string" || !token.startsWith("xoxb-")) {
        return res.status(400).json({ error: "A valid Slack Bot token (starting with xoxb-) is required" });
      }
      // Task #1968: classify the post-save probe so a transient Slack 5xx,
      // 429-exhaust, network blip, or `missing_scope` no longer wipes the
      // freshly-saved token. Only a confirmed terminal Slack auth error
      // (invalid_auth / token_revoked / token_expired / not_authed /
      // account_inactive / invalid_token) clears the token here; everything
      // else preserves it and tells the operator the status cache will
      // re-probe it. Mirrors the Zoom (Task #1843) and badge (Task #1876)
      // fixes that left this connect path behind.
      const { setToken, probeConnection, disconnect, isTerminalSlackAuthCode } = await import("../services/slackIntegration");
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      await setToken(token, userId ?? undefined);
      const probe = await probeConnection();
      await invalidateIntegrationStatus("slack");

      if (probe.outcome === "connected") {
        return res.json({ success: true, team: probe.team ?? null });
      }
      // Task #1968: an `unauthorized` outcome only earns a token wipe when
      // the reason is a confirmed terminal Slack auth code. Anything else
      // (notably `no_token_stored`, which can leak through on a stale read
      // immediately after `setToken`) is treated as transient — token
      // preserved, status cache re-probes.
      if (probe.outcome === "unauthorized" && isTerminalSlackAuthCode(probe.reason)) {
        await disconnect(userId ?? undefined, {
          trigger: "connect_terminal_auth_error",
          slackErrorCode: probe.reason ?? null,
          notes: "Cleared by connect handler after auth.test returned a terminal Slack auth code",
        });
        await invalidateIntegrationStatus("slack");
        return res.status(400).json({
          error: `Slack rejected the token (${probe.reason}) — re-enter the bot token.`,
          reason: probe.reason,
        });
      }
      // probe_failed OR non-terminal unauthorized → token preserved.
      return res.status(202).json({
        success: true,
        warning: `Token saved but verification failed (${probe.reason ?? "probe_failed"}). It will be probed again automatically; no action required unless it stays unhealthy.`,
        reason: probe.reason ?? "probe_failed",
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/slack/disconnect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { disconnect } = await import("../services/slackIntegration");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      // Task #1968: tag the audit row so we can tell manual clicks apart
      // from the connect handler's terminal-error self-wipe.
      await disconnect(userId ?? undefined, { trigger: "manual_disconnect" });
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      await invalidateIntegrationStatus("slack");
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/slack/sync", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { syncAllChannels, syncSlackProfiles } = await import("../services/slackIntegration");
      const userId = req.user?.claims?.sub || req.user?.id;
      const result = await syncAllChannels(userId);
      syncSlackProfiles().catch(err => console.warn("[Slack] Background profile sync failed:", err?.message));
      res.json(result);
    } catch (error: any) {
      console.error("[Slack] Sync error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/slack/sync-profiles", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { syncSlackProfiles } = await import("../services/slackIntegration");
      const result = await syncSlackProfiles();
      res.json(result);
    } catch (error: any) {
      console.error("[Slack] Profile sync error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/slack/sync-history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const history = await storage.listSlackSyncHistory(limit);
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/integrations/slack/recent-messages", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const result = await db.execute(sql`
        SELECT r.id, r.client_id as "clientId", r.title as subject, r.ai_summary as summary, 
               r.direction, r.match_confidence as "matchConfidence",
               r.created_at as "createdAt", r.external_source_id as "externalSourceId",
               c.firm_name as "clientName"
        FROM raw_communication_records r
        LEFT JOIN clients c ON r.client_id = c.id
        WHERE r.source_type = 'slack'
          AND (r.match_status IS NULL OR r.match_status <> 'orphaned')
        ORDER BY r.created_at DESC
        LIMIT ${limit}
      `);
      res.json(result.rows);
    } catch (error) {
      console.error("[Slack] Error fetching recent messages:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/integrations/slack/messages", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
      const offset = (page - 1) * limit;
      const matchFilter = req.query.match as string;
      const clientFilter = req.query.clientId as string;
      const channelFilter = req.query.channel as string;
      const dateFrom = req.query.dateFrom as string;
      const dateTo = req.query.dateTo as string;

      // Task #904: orphaned rows (parent client deleted) are kept for forensic
      // queries but excluded from this client-facing admin view by default.
      // Pass `?includeOrphaned=true` to opt back in for forensic investigation.
      const includeOrphaned = req.query.includeOrphaned === "true";
      const conditions = [sql`r.source_type = 'slack'`];
      if (!includeOrphaned) {
        conditions.push(sql`(r.match_status IS NULL OR r.match_status <> 'orphaned')`);
      }

      if (matchFilter === "matched") {
        conditions.push(sql`r.client_id IS NOT NULL`);
      } else if (matchFilter === "unmatched") {
        conditions.push(sql`r.client_id IS NULL`);
      }

      if (clientFilter) {
        conditions.push(sql`r.client_id = ${clientFilter}`);
      }

      if (channelFilter) {
        conditions.push(sql`(r.raw_payload_json->>'channelName') ILIKE ${'%' + channelFilter + '%'}`);
      }

      if (dateFrom) {
        conditions.push(sql`r.timestamp >= ${new Date(dateFrom)}`);
      }

      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        conditions.push(sql`r.timestamp <= ${endOfDay}`);
      }

      const whereClause = sql.join(conditions, sql` AND `);

      const globalStatsResult = await db.execute(sql`
        SELECT COUNT(*)::int as total,
               COUNT(CASE WHEN r.client_id IS NOT NULL THEN 1 END)::int as matched,
               COUNT(CASE WHEN r.client_id IS NULL THEN 1 END)::int as unmatched
        FROM raw_communication_records r
        WHERE r.source_type = 'slack'
          ${includeOrphaned ? sql`` : sql`AND (r.match_status IS NULL OR r.match_status <> 'orphaned')`}
      `);

      const globalStats = globalStatsResult.rows[0] as { total: number; matched: number; unmatched: number };

      const countResult = await db.execute(sql`
        SELECT COUNT(*)::int as total
        FROM raw_communication_records r
        WHERE ${whereClause}
      `);

      const filteredCount = (countResult.rows[0] as { total: number }).total || 0;

      const result = await db.execute(sql`
        SELECT r.id, r.client_id as "clientId", r.title, r.content_text as "contentText",
               r.content_preview as "contentPreview", r.timestamp, r.direction,
               r.match_method as "matchMethod", r.match_confidence as "matchConfidence",
               r.external_url as "externalUrl", r.google_drive_file_url as "googleDriveFileUrl",
           r.client_file_id as "clientFileId",
               r.source_subtype as "sourceSubtype",
               r.external_source_id as "externalSourceId",
               r.ai_summary as "aiSummary", r.created_at as "createdAt",
               r.raw_payload_json as "rawPayload",
               r.participants_json as "participants",
               c.firm_name as "clientName"
        FROM raw_communication_records r
        LEFT JOIN clients c ON r.client_id = c.id
        WHERE ${whereClause}
        ORDER BY r.timestamp DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const slackMessages = result.rows as Array<Record<string, any>>;
      await attachAgentDecisionInfo(slackMessages, "slack");

      res.json({
        messages: slackMessages,
        stats: {
          total: globalStats.total || 0,
          matched: globalStats.matched || 0,
          unmatched: globalStats.unmatched || 0,
          matchRate: globalStats.total > 0 ? Math.round((globalStats.matched / globalStats.total) * 100) : 0,
        },
        pagination: {
          page,
          limit,
          total: filteredCount,
          totalPages: Math.ceil(filteredCount / limit),
        },
      });
    } catch (error) {
      console.error("[Slack] Error fetching messages:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/integrations/front/messages", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
      const offset = (page - 1) * limit;

      const matchAllowed = new Set(["all", "matched", "unmatched", "dismissed", "blocked"]);
      const rawMatch = typeof req.query.match === "string" ? req.query.match : "";
      if (rawMatch && !matchAllowed.has(rawMatch)) {
        return res.status(400).json({ error: `Invalid match filter: ${rawMatch}` });
      }
      const matchFilter = rawMatch || "all";

      const trimOrUndef = (v: unknown): string | undefined => {
        if (typeof v !== "string") return undefined;
        const trimmed = v.trim();
        return trimmed.length === 0 ? undefined : trimmed;
      };

      const clientFilter = trimOrUndef(req.query.clientId);
      const dateFrom = trimOrUndef(req.query.dateFrom);
      const dateTo = trimOrUndef(req.query.dateTo);
      const search = trimOrUndef(req.query.search);
      const senderEmailRaw = trimOrUndef(req.query.senderEmail);
      const senderDomainRaw = trimOrUndef(req.query.senderDomain);
      const inboxRaw = trimOrUndef(req.query.inbox);

      const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      const isValidDomain = (s: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);

      if (senderEmailRaw && !isValidEmail(senderEmailRaw)) {
        return res.status(400).json({ error: `Invalid senderEmail: ${senderEmailRaw}` });
      }
      if (senderDomainRaw && !isValidDomain(senderDomainRaw)) {
        return res.status(400).json({ error: `Invalid senderDomain: ${senderDomainRaw}` });
      }
      if (inboxRaw && inboxRaw.length > 320) {
        return res.status(400).json({ error: "Invalid inbox value" });
      }
      if (search && search.length > 200) {
        return res.status(400).json({ error: "Search query is too long (max 200 characters)" });
      }
      if (dateFrom && Number.isNaN(Date.parse(dateFrom))) {
        return res.status(400).json({ error: `Invalid dateFrom: ${dateFrom}` });
      }
      if (dateTo && Number.isNaN(Date.parse(dateTo))) {
        return res.status(400).json({ error: `Invalid dateTo: ${dateTo}` });
      }

      const senderEmail = senderEmailRaw?.toLowerCase();
      const senderDomain = senderDomainRaw?.toLowerCase();
      const inbox = inboxRaw?.toLowerCase();

      // Task #904: hide orphaned rows (parent client deleted) from this client-
      // facing admin view by default. Forensic callers can opt back in via
      // `?includeOrphaned=true`.
      const includeOrphaned = req.query.includeOrphaned === "true";
      const conditions = [sql`r.source_type = 'front_email'`];
      if (!includeOrphaned) {
        conditions.push(sql`(r.match_status IS NULL OR r.match_status <> 'orphaned')`);
      }

      if (matchFilter === "matched") {
        conditions.push(sql`r.client_id IS NOT NULL`);
      } else if (matchFilter === "unmatched") {
        conditions.push(sql`r.client_id IS NULL AND (r.match_status IS NULL OR r.match_status = 'unmatched')`);
      } else if (matchFilter === "dismissed") {
        // "dismissed" can come from two paths:
        //   1) raw_communication_records.match_status = 'dismissed_operational'
        //      (post-ingestion operational dismiss)
        //   2) front_sync_emails.match_status IN ('dismissed','dismissed_operational')
        //      (pre-ingestion / Phase-3 reviewer dismiss surfaces here once
        //       the conversation row is created)
        // Effective-status semantics in the response prefer front_sync_emails,
        // so the filter must accept either source to stay consistent.
        conditions.push(sql`(
          r.match_status = 'dismissed_operational'
          OR EXISTS (
            SELECT 1 FROM front_sync_emails fse
            WHERE fse.conversation_id = r.external_thread_id
              AND fse.match_status IN ('dismissed', 'dismissed_operational')
          )
        )`);
      } else if (matchFilter === "blocked") {
        // 'blocked' status is tracked on front_sync_emails (pre-ingestion). A
        // raw_communication_records row only exists once the conversation has
        // been ingested, so blocked rows are surfaced via the front_sync_emails
        // join below.
        conditions.push(sql`EXISTS (
          SELECT 1 FROM front_sync_emails fse
          WHERE fse.conversation_id = r.external_thread_id
            AND fse.match_status = 'blocked'
        )`);
      }
      if (clientFilter) {
        conditions.push(sql`r.client_id = ${clientFilter}`);
      }
      if (dateFrom) {
        conditions.push(sql`r.timestamp >= ${new Date(dateFrom)}`);
      }
      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        conditions.push(sql`r.timestamp <= ${endOfDay}`);
      }
      if (search) {
        const like = `%${search}%`;
        // Searches subject (title), content preview, and participant names/emails (no body — deferred per Phase 0).
        conditions.push(sql`(
          r.title ILIKE ${like}
          OR r.content_preview ILIKE ${like}
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
            WHERE p->>'name' ILIKE ${like} OR p->>'email' ILIKE ${like}
          )
        )`);
      }
      if (senderEmail) {
        conditions.push(sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
          WHERE LOWER(p->>'email') = ${senderEmail}
        )`);
      }
      if (senderDomain) {
        const domainLike = `%@${senderDomain}`;
        conditions.push(sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
          WHERE LOWER(p->>'email') LIKE ${domainLike}
        )`);
      }
      if (inbox) {
        // Inbox addresses are not stored on raw_communication_records directly;
        // the closest stable proxy is the participant handle for non-author
        // recipients (e.g. role 'to', 'cc', 'recipient', 'team').
        conditions.push(sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
          WHERE LOWER(p->>'email') = ${inbox}
            AND LOWER(COALESCE(p->>'role', 'recipient')) IN ('to', 'cc', 'bcc', 'recipient', 'team')
        )`);
      }

      const whereClause = sql.join(conditions, sql` AND `);

      // Task #2633 — globalStats and filteredStats are MESSAGE-grain and come
      // from the SAME canonical helper the KPI strip + match-stats tile use, so
      // the Messages-tab "Match rate" can never disagree with the KPI "Match
      // rate" (the no-filter case is byte-for-byte the same computation).
      // matchable = matched + unmatched (so the rate is not diluted by
      // operational dismissals / non-matchable rows).
      const { getFrontMessageGrainStats } = await import("../services/frontMessageGrainStats");
      const globalStats = await getFrontMessageGrainStats(db);

      // filteredStats reflect the *current filter* (same WHERE clause as the
      // message list itself). The user-supplied `conditions` already reference
      // the `r` alias; the helper re-applies the Front-email + non-orphaned base
      // predicate (idempotent) and AND-s these on top.
      const filteredStats = await getFrontMessageGrainStats(db, conditions);
      const filteredCount = filteredStats.total;

      const result = await db.execute(sql`
        SELECT r.id, r.client_id as "clientId", r.title, r.content_text as "contentText",
               r.content_preview as "contentPreview", r.timestamp, r.direction,
               r.match_method as "matchMethod", r.match_confidence as "matchConfidence",
               r.match_status as "matchStatus",
               r.external_url as "externalUrl",
               r.source_subtype as "sourceSubtype",
               r.external_source_id as "externalSourceId",
               r.ai_summary as "aiSummary", r.created_at as "createdAt",
               r.raw_payload_json as "rawPayload",
               r.participants_json as "participants",
               c.firm_name as "clientName",
               fse.match_status as "frontSyncMatchStatus"
        FROM raw_communication_records r
        LEFT JOIN clients c ON r.client_id = c.id
        LEFT JOIN front_sync_emails fse ON fse.conversation_id = r.external_thread_id
        WHERE ${whereClause}
        ORDER BY r.timestamp DESC, r.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const frontMessages = result.rows as Array<Record<string, any>>;
      await attachAgentDecisionInfo(frontMessages, "front_email");

      // Enrich each row with sender/domain/inbox metadata + eligibleActions
      // (Phase 3 will consume this contract for safe bulk operations.)
      for (const m of frontMessages) {
        const participants: Array<{ name?: string; email?: string; role?: string }> = Array.isArray(m.participants)
          ? m.participants
          : [];

        const externalSender = participants.find(p => (p?.role || "").toLowerCase() === "external" && p?.email);
        const fallbackSender = participants.find(p => p?.email);
        const sender = externalSender || fallbackSender || null;
        const sEmail = sender?.email ? sender.email.toLowerCase() : null;
        m.senderEmail = sEmail;
        m.senderName = sender?.name || null;
        m.senderDomain = sEmail && sEmail.includes("@") ? sEmail.split("@")[1] : null;

        const inboxEmails = participants
          .filter(p => {
            const role = (p?.role || "recipient").toLowerCase();
            return ["to", "cc", "bcc", "recipient", "team"].includes(role);
          })
          .map(p => p?.email?.toLowerCase())
          .filter((e): e is string => !!e);
        m.inboxes = Array.from(new Set(inboxEmails));

        const effectiveStatus: string =
          m.frontSyncMatchStatus ||
          m.matchStatus ||
          (m.clientId ? "matched" : "unmatched");

        const eligible: string[] = [];
        if (effectiveStatus === "matched" || effectiveStatus === "auto_matched" || effectiveStatus === "manually_matched") {
          eligible.push("markNotAMatch", "dismiss");
        } else if (effectiveStatus === "dismissed_operational" || effectiveStatus === "dismissed") {
          eligible.push("assign", "block");
        } else if (effectiveStatus === "blocked") {
          eligible.push("assign");
        } else {
          // unmatched / null
          eligible.push("assign", "dismiss", "block");
        }
        m.eligibleActions = eligible;
        m.effectiveMatchStatus = effectiveStatus;
      }

      res.json({
        messages: frontMessages,
        // Task #828: `stats` was historically a global, unfiltered count even
        // though the Messages browser tiles label themselves as filter-scoped.
        // We now return both `filteredStats` (matches the message list's WHERE
        // clause — what the browser tiles render) and `globalStats` (full
        // `source_type='front_email'` corpus — what Overview & Jobs renders),
        // so the contract is self-documenting for any future caller.
        filteredStats,
        globalStats,
        pagination: {
          page,
          limit,
          total: filteredCount,
          totalPages: Math.ceil(filteredCount / limit),
        },
      });
    } catch (error) {
      console.error("[Front] Error fetching messages:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/integrations/slack/messages/:id/reassign", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { clientId } = req.body;

      if (clientId !== undefined && clientId !== null && typeof clientId !== "string") {
        return res.status(400).json({ error: "clientId must be a string or null" });
      }

      if (clientId) {
        const clientExists = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
        if (clientExists.length === 0) {
          return res.status(404).json({ error: "Client not found" });
        }
      }

      const record = await storage.getRawCommunication(id);
      if (!record || record.sourceType !== "slack") {
        return res.status(404).json({ error: "Slack message not found" });
      }

      const updated = await storage.updateRawCommunication(id, {
        clientId: clientId || null,
        matchMethod: clientId ? "manual" : null,
        matchConfidence: clientId ? 1.0 : null,
        updatedAt: new Date(),
      });

      if (updated && clientId) {
        const [clientRow] = await db.select({ firmName: clients.firmName }).from(clients).where(eq(clients.id, clientId));
        return res.json({ ...updated, clientName: clientRow?.firmName || null });
      }

      res.json({ ...updated, clientName: null });
    } catch (error) {
      console.error("[Slack] Error reassigning message:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // ZOOM INTEGRATION
  // ============================================

  app.get("/api/integrations/zoom/messages", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
      const offset = (page - 1) * limit;
      const matchFilter = req.query.match as string;
      const clientFilter = req.query.clientId as string;
      const hostFilter = req.query.host as string;
      const dateFrom = req.query.dateFrom as string;
      const dateTo = req.query.dateTo as string;

      // Task #904: orphaned rows (parent client deleted) are excluded from
      // this client-facing admin view by default. Forensic callers can opt
      // back in with `?includeOrphaned=true`.
      const includeOrphaned = req.query.includeOrphaned === "true";
      const conditions = [sql`r.source_type = 'zoom'`];
      if (!includeOrphaned) {
        conditions.push(sql`(r.match_status IS NULL OR r.match_status <> 'orphaned')`);
      }

      if (matchFilter === "matched") {
        conditions.push(sql`r.client_id IS NOT NULL`);
      } else if (matchFilter === "unmatched") {
        conditions.push(sql`r.client_id IS NULL`);
      } else if (matchFilter === "review") {
        conditions.push(sql`EXISTS (
          SELECT 1 FROM agent_match_decisions amd
          WHERE amd.source_type = 'zoom'
            AND amd.status = 'review_required'
            AND amd.review_resolution IS NULL
            AND (amd.communication_id = r.id::text OR amd.communication_id = r.external_source_id)
        )`);
      }

      if (clientFilter) {
        conditions.push(sql`r.client_id = ${clientFilter}`);
      }

      if (hostFilter) {
        conditions.push(sql`(r.raw_payload_json->>'hostName') ILIKE ${'%' + hostFilter + '%'}`);
      }

      if (dateFrom) {
        conditions.push(sql`r.timestamp >= ${new Date(dateFrom)}`);
      }

      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        conditions.push(sql`r.timestamp <= ${endOfDay}`);
      }

      const whereClause = sql.join(conditions, sql` AND `);

      const globalStatsResult = await db.execute(sql`
        SELECT COUNT(*)::int as total,
               COUNT(CASE WHEN r.client_id IS NOT NULL OR EXISTS (
                 SELECT 1 FROM communication_client_links ccl
                 WHERE ccl.raw_communication_record_id = r.id AND ccl.status != 'rejected'
               ) THEN 1 END)::int as matched,
               COUNT(CASE WHEN r.client_id IS NULL AND NOT EXISTS (
                 SELECT 1 FROM communication_client_links ccl
                 WHERE ccl.raw_communication_record_id = r.id AND ccl.status != 'rejected'
               ) THEN 1 END)::int as unmatched,
               COUNT(CASE WHEN EXISTS (
                 SELECT 1 FROM agent_match_decisions amd
                 WHERE amd.source_type = 'zoom'
                   AND amd.status = 'review_required'
                   AND amd.review_resolution IS NULL
                   AND (amd.communication_id = r.id::text OR amd.communication_id = r.external_source_id)
               ) THEN 1 END)::int as "needsReview"
        FROM raw_communication_records r
        WHERE r.source_type = 'zoom'
          ${includeOrphaned ? sql`` : sql`AND (r.match_status IS NULL OR r.match_status <> 'orphaned')`}
      `);

      const globalStats = globalStatsResult.rows[0] as { total: number; matched: number; unmatched: number; needsReview: number };

      const countResult = await db.execute(sql`
        SELECT COUNT(*)::int as total
        FROM raw_communication_records r
        WHERE ${whereClause}
      `);

      const filteredCount = (countResult.rows[0] as { total: number }).total || 0;

      const result = await db.execute(sql`
        SELECT r.id, r.client_id as "clientId", r.title, r.content_text as "contentText",
               r.content_preview as "contentPreview", r.timestamp, r.direction,
               r.match_method as "matchMethod", r.match_confidence as "matchConfidence",
               r.external_url as "externalUrl", r.google_drive_file_url as "googleDriveFileUrl",
           r.client_file_id as "clientFileId",
               r.source_subtype as "sourceSubtype",
               r.external_source_id as "externalSourceId",
               r.ai_summary as "aiSummary", r.created_at as "createdAt",
               r.raw_payload_json as "rawPayload",
               r.participants_json as "participants",
               c.firm_name as "clientName"
        FROM raw_communication_records r
        LEFT JOIN clients c ON r.client_id = c.id
        WHERE ${whereClause}
        ORDER BY r.timestamp DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const messages = result.rows as Array<Record<string, any>>;
      await attachAgentDecisionInfo(messages, "zoom");

      res.json({
        messages,
        stats: {
          total: globalStats.total || 0,
          matched: globalStats.matched || 0,
          unmatched: globalStats.unmatched || 0,
          needsReview: globalStats.needsReview || 0,
          matchRate: globalStats.total > 0 ? Math.round((globalStats.matched / globalStats.total) * 100) : 0,
        },
        pagination: {
          page,
          limit,
          total: filteredCount,
          totalPages: Math.ceil(filteredCount / limit),
        },
      });
    } catch (error) {
      console.error("[Zoom] Error fetching messages:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/integrations/zoom/messages/:id/reassign", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { clientId } = req.body;

      // Task #4050 + #4057: one shared reassignment path for the comms feed
      // and the Transcript Match Assistant — validation, sibling stamping
      // (recording + transcript share one externalSourceId), matchStatus,
      // client links, review-decision resolution, analysis re-queue, and the
      // delivery-mode-aware recording fan-out all live in the shared service
      // so the two flows cannot drift.
      const { reassignZoomRecordToClient } = await import("../services/zoomManualReassign");
      const result = await reassignZoomRecordToClient(id, clientId, req.user.claims.sub);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }

      res.json({ ...result.updated, clientName: result.clientName });
    } catch (error) {
      console.error("[Zoom] Error reassigning meeting:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/integrations/zoom/status", isAuthenticated, async (req: any, res) => {
    try {
      const { isConnected, validateConnection } = await import("../services/zoomIntegration");
      const connected = await isConnected();
      if (!connected) {
        return res.json({ connected: false });
      }
      const validation = await validateConnection();
      res.json({ connected: validation.valid, tokenValid: validation.valid, error: validation.error });
    } catch (error: any) {
      // Task #2811 — a thrown token read (DB blip) must surface as an
      // explicit status-unknown 503, never a hard `connected: false`
      // (mirrors the Google Ads route fix, Task #2807).
      console.error("[Zoom] /zoom/status: error during status check:", error?.message || error);
      res.status(503).json({
        statusUnknown: true,
        probeFailed: true,
        connected: null,
        tokenValid: null,
        reason: String(error?.message ?? error).slice(0, 200),
      });
    }
  });

  app.get("/api/integrations/zoom/authorize", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getAuthorizationUrl } = await import("../services/zoomIntegration");
      const url = await getAuthorizationUrl();
      res.json({ url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/zoom/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code) return res.status(400).send("Missing authorization code");
      if (!state) return res.status(400).send("Missing state parameter");

      const { validateOAuthState, exchangeCodeForToken } = await import("../services/zoomIntegration");
      const stateValid = await validateOAuthState(state);
      if (!stateValid) {
        return res.status(403).send("Invalid or expired OAuth state — possible CSRF. Please try authorizing again.");
      }
      const actingUserId = (req as any).user?.claims?.sub as string | undefined;
      await exchangeCodeForToken(code, actingUserId);
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      await invalidateIntegrationStatus("zoom");

      void import("../services/zoomIntegration").then(({ initZoomAutoSync }) => {
        // fire-and-forget: auto-sync kick, failures logged
        return initZoomAutoSync();
      }).catch(err => {
        console.error("[Zoom] Failed to start auto-sync after connect:", err);
      });

      res.send(`
        <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f0eb;">
          <div style="text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
            <!-- COLOR DECISION (Task #4567): ALIGNED — success heading uses status-ok
                 green #2A6F47 (5.9:1 on white), not the retired burgundy #6B2C3E,
                 so a success state never reads as a danger hue. -->
            <h2 style="color:#2A6F47;">Zoom Connected Successfully</h2>
            <p style="color:#666;">You can close this tab and return to the app.</p>
          </div>
        </body></html>
      `);
    } catch (error: any) {
      console.error("[Zoom] OAuth callback error:", error);
      res.status(500).send(`Authorization failed: ${error.message}`);
    }
  });

  app.post("/api/integrations/zoom/disconnect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { disconnect, stopZoomReconciliation } = await import("../services/zoomIntegration");
      await disconnect(req.user?.claims?.sub, { trigger: "manual_disconnect" });
      stopZoomReconciliation();
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      await invalidateIntegrationStatus("zoom");
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #3973 — Server-to-Server OAuth cutover surface. GET reports the
  // active mode; the preflight proves the S2S app (mint + scope parity +
  // API reachability) WITHOUT touching live auth state; POST flips the
  // mode. Cutover: preflight → POST {mode:"s2s"}; rollback: POST
  // {mode:"oauth"}. See ZOOM.md § Server-to-Server OAuth.
  app.get("/api/integrations/zoom/auth-mode", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getZoomAuthMode, hasZoomS2sCredentials } = await import("../services/zoomIntegration");
      res.json({ mode: await getZoomAuthMode(), s2sCredentialsPresent: hasZoomS2sCredentials() });
    } catch (error: any) {
      // Mode unreadable = status unknown (transient), mirroring the zoom
      // status route's 503 contract — never guess a mode here.
      res.status(503).json({ error: `auth mode read failed: ${error?.message ?? String(error)}` });
    }
  });

  app.get("/api/integrations/zoom/s2s/preflight", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { runZoomS2sPreflight } = await import("../services/zoomIntegration");
      res.json(await runZoomS2sPreflight());
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  app.post("/api/integrations/zoom/auth-mode", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const mode = req.body?.mode;
      if (mode !== "oauth" && mode !== "s2s") {
        return res.status(400).json({ error: 'mode must be "oauth" or "s2s"' });
      }
      const svc = await import("../services/zoomIntegration");
      // Task #4019 — applyZoomAuthModeChange is the ONE shared sequence
      // (equality short-circuit → preflight gate unless force → flip →
      // status-cache invalidation → auto-sync kick) also used by the
      // `zoom_s2s_auth_mode_cutover` prod action, so the CEO-panel button
      // and this team-lead route can never drift. `force: true` stays the
      // documented break-glass override (Task #3973 done-criteria).
      const result = await svc.applyZoomAuthModeChange(mode, {
        actorId: req.user?.claims?.sub ?? null,
        force: req.body?.force === true,
      });
      if (result.kind === "unchanged") {
        return res.json({ mode, changed: false });
      }
      if (result.kind === "not_ready") {
        return res.status(409).json({
          error:
            "S2S preflight not ready — fix the S2S app (credentials/scopes) before cutover, or pass force:true to override",
          preflight: result.preflight,
        });
      }
      res.json({ mode, changed: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  app.get("/api/integrations/zoom/recordings", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listRecentRecordings } = await import("../services/zoomIntegration");
      const fromDate = req.query.from as string | undefined;
      const toDate = req.query.to as string | undefined;
      const recordings = await listRecentRecordings(fromDate, toDate);
      res.json(recordings);
    } catch (error: any) {
      console.error("[Zoom] List recordings error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/zoom/discover", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { discoverUnmatchedRecordings } = await import("../services/zoomIntegration");
      const fromDate = req.query.from as string | undefined;
      const toDate = req.query.to as string | undefined;
      const results = await discoverUnmatchedRecordings({ fromDate, toDate, origin: "user_manual" });
      res.json(results);
    } catch (error: any) {
      console.error("[Zoom] Discover error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/zoom/reprocess", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      const sendSSE = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
      };

      const { rawCommunicationRecords, communicationClientLinks } = await import("@shared/schema");
      const { eq, and, or, isNull, sql: sqlFn } = await import("drizzle-orm");

      const dismissedRecords = await db.select()
        .from(rawCommunicationRecords)
        .where(
          and(
            eq(rawCommunicationRecords.sourceType, "zoom"),
            // Task #965: the explicit list of allowed match_status values
            // below already excludes 'orphaned' — keep this list closed
            // (don't add a wildcard) so deleted-client rows are never
            // reprocessed.
            or(
              eq(rawCommunicationRecords.matchStatus, "dismissed_operational"),
              eq(rawCommunicationRecords.matchStatus, "unmatched"),
              isNull(rawCommunicationRecords.matchStatus),
            ),
          )
        );

      const total = dismissedRecords.length;
      sendSSE("progress", { current: 0, total });

      let reprocessed = 0;
      let matched = 0;
      let multiClientLinked = 0;

      for (const record of dismissedRecords) {
        try {
          // Task #2637: deterministic participant matching only. No fuzzy
          // content matcher and no AI agent matcher are consulted anymore.
          const participants = Array.isArray(record.participantsJson) ? (record.participantsJson as any[]) : [];
          const participantEmails = participants.map((p: any) => p.email).filter(Boolean) as string[];
          const participantNames = participants.map((p: any) => p.name).filter(Boolean) as string[];

          const { matchClientByParticipants } = await import("../services/zoomIntegration");
          // Task #4050: shared deterministic resolution — participant strong
          // signals plus trusted-domain and topic↔firm-name tiers. Ambiguous
          // outcomes now land in review WITH the stored suggestion/shortlist
          // (previously this endpoint dropped suggestions entirely).
          const { resolveZoomClientMatch } = await import("../services/zoomClientMatching");
          const resolution = await resolveZoomClientMatch(
            {
              participantEmails,
              participantNames,
              topic: record.title ?? null,
              source: "zoom",
            },
            { matchParticipants: matchClientByParticipants },
          );

          if (resolution.kind === "auto") {
            await storage.updateRawCommunication(record.id, {
              clientId: resolution.clientId,
              matchMethod: resolution.matchedOn,
              matchStatus: "matched",
              operationalClassificationReason: null,
              processingStatus: "pending",
            });
            matched++;

            try {
              // Task #4083 (pattern from Task #4079): the auto-match stamp is
              // authoritative — sweep every OTHER client's link first. Zoom
              // never deliberately multi-client-tags a record (all writers
              // upsert a single clientId), so any other-client link is stale
              // residue from an earlier match and would double-count the call.
              await db.delete(communicationClientLinks)
                .where(and(
                  eq(communicationClientLinks.rawCommunicationRecordId, record.id),
                  sqlFn`${communicationClientLinks.clientId} <> ${resolution.clientId}`,
                ));
              await db.insert(communicationClientLinks).values({
                rawCommunicationRecordId: record.id,
                clientId: resolution.clientId,
                matchMethod: resolution.matchedOn,
                matchConfidence: null,
                isPrimary: true,
                status: "detected",
              }).onConflictDoUpdate({
                target: [communicationClientLinks.rawCommunicationRecordId, communicationClientLinks.clientId],
                set: {
                  matchMethod: resolution.matchedOn,
                  isPrimary: true,
                },
              });
            } catch (linkErr) { console.error("[Zoom Reprocess] Link upsert failed:", linkErr); }

            // fire-and-forget: background analysis, errors logged inside
            void (async () => {
              try {
                const { analyzeCommunication } = await import("../services/communicationAnalysis");
                await analyzeCommunication(record.id);
              } catch (err) {
                console.error("[Zoom Reprocess] Analysis failed for", record.id, err);
              }
            })();
          } else {
            // Task #993/#2637: no deterministic auto-claim. Persist as
            // unmatched so operators can manually match or dismiss it from the
            // Meeting Review Feed. Task #4050: review demotions keep their
            // sentinel matchMethod so the reason survives on the raw row.
            const isReview = resolution.kind === "review";
            try {
              await storage.updateRawCommunication(record.id, {
                matchStatus: "unmatched",
                matchMethod: isReview
                  ? `review_required:${resolution.reviewReason}:${resolution.matchedOn}`
                  : null,
                operationalClassificationReason: null,
                processingStatus: "pending",
              });
            } catch (updateErr) {
              console.error("[Zoom Reprocess] Unmatched persistence failed:", updateErr);
            }
            // Task #995: surface no-candidate reprocesses in the Review Queue
            // so operators can manually pick a client instead of having to
            // hunt for them in the unmatched bucket. Task #4050: demoted
            // matches store the suggested client + candidate shortlist for
            // one-click confirmation (previously dropped).
            try {
              const { recordZoomReviewDecision, NO_CANDIDATE_REVIEW_REASON } = await import("../services/zoomReviewQueue");
              await recordZoomReviewDecision({
                communicationId: record.id,
                communicationType: "zoom",
                suggestedClientId: isReview ? resolution.suggestedClientId : null,
                confidenceScore: isReview && resolution.suggestedClientId ? 0.5 : 0,
                explanationSummary: isReview
                  ? `Reprocess: deterministic Zoom match demoted (${resolution.matchedOn})`
                  : `Reprocess: no deterministic participant match for Zoom recording "${record.title || record.id}"`,
                reviewReason: isReview ? resolution.reviewReason : NO_CANDIDATE_REVIEW_REASON,
                candidateShortlist: isReview
                  ? resolution.candidates.map((c) => ({
                      clientId: c.clientId,
                      confidenceScore: 0.5,
                      matchedOn: c.matchedOn,
                    }))
                  : [],
                evidenceType: "structured",
                priorClientId: record.clientId ?? null,
              });
            } catch (err) {
              console.error("[Zoom Reprocess] no-candidate recordZoomReviewDecision failed:", err);
            }
          }
          reprocessed++;
          sendSSE("progress", { current: reprocessed, total });
        } catch (err) {
          console.error(`[Zoom Reprocess] Error reprocessing ${record.id}:`, err);
          reprocessed++;
          sendSSE("progress", { current: reprocessed, total });
        }
      }

      sendSSE("complete", {
        total: dismissedRecords.length,
        reprocessed,
        matched,
        multiClientLinked,
      });
      res.end();
    } catch (error: any) {
      console.error("[Zoom Reprocess] Error:", error);
      try {
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        } else {
          res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
          res.end();
        }
      } catch (_) { res.end(); }
    }
  });

  app.post("/api/integrations/zoom/reprocess-matched", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      const sendSSE = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
      };

      const { rawCommunicationRecords, communicationClientLinks } = await import("@shared/schema");
      const { eq, and, sql: sqlFn } = await import("drizzle-orm");

      const { isNotNull, or, isNull } = await import("drizzle-orm");
      const matchedRecords = await db.select()
        .from(rawCommunicationRecords)
        .where(
          and(
            eq(rawCommunicationRecords.sourceType, "zoom"),
            or(
              eq(rawCommunicationRecords.matchStatus, "matched"),
              and(
                isNull(rawCommunicationRecords.matchStatus),
                isNotNull(rawCommunicationRecords.clientId),
              ),
            ),
          )
        );

      console.log(`[Zoom Reprocess Matched] Found ${matchedRecords.length} matched Zoom records to reprocess (includes NULL matchStatus with clientId)`);

      const total = matchedRecords.length;
      sendSSE("progress", { current: 0, total });

      let reprocessed = 0;
      let rematched = 0;
      let changed = 0;
      let multiClientLinked = 0;

      for (const record of matchedRecords) {
        try {
          const originalClientId = record.clientId;

          await db.delete(communicationClientLinks)
            .where(eq(communicationClientLinks.rawCommunicationRecordId, record.id));

          await storage.updateRawCommunication(record.id, {
            clientId: null,
            matchMethod: null,
            matchConfidence: null,
            matchStatus: "unmatched",
            operationalClassificationReason: null,
          });

          const GENERIC_TITLE_RE = /personal meeting room|zoom meeting|quick meeting|scheduled meeting|instant meeting/i;
          const hasRealTranscript = !!(record.contentText && record.contentText.trim().length > 50);
          const hasGenericTitle = !record.title || GENERIC_TITLE_RE.test(record.title);
          const isNoTranscriptGeneric = !hasRealTranscript && hasGenericTitle;

          const textToScan = hasRealTranscript ? record.contentText! : (record.title || "");
          let newClientId: string | null = null;

          const reprocessMatchedParticipants = Array.isArray(record.participantsJson) ? (record.participantsJson as any[]) : [];
          const reprocessMatchedParticipantEmails = reprocessMatchedParticipants
            .map((p: any) => p.email)
            .filter(Boolean) as string[];
          const { hasOnlyInternalParticipants: hasOnlyInternalRP } = await import("../services/matchPolicy");
          if (hasOnlyInternalRP(reprocessMatchedParticipantEmails)) {
            console.log(`[Zoom Reprocess Matched MatchPolicy] Skipping all-internal Zoom meeting ${record.id} (${record.title})`);
            await storage.updateRawCommunication(record.id, {
              matchMethod: `review_required:solo_internal_participants:${record.matchMethod || "unknown"}`,
              matchStatus: "unmatched",
              processingStatus: "pending",
            });
            if (originalClientId) {
              try {
                const { recordZoomReviewDecision } = await import("../services/zoomReviewQueue");
                await recordZoomReviewDecision({
                  communicationId: record.id,
                  communicationType: "zoom",
                  suggestedClientId: originalClientId,
                  confidenceScore: 0.5,
                  explanationSummary: `Reprocess (matched): demoted prior Zoom match — all participants internal (${record.matchMethod || "unknown"})`,
                  reviewReason: "solo_internal_participants",
                  candidateShortlist: [
                    { clientId: originalClientId, confidenceScore: 0.5, matchedOn: record.matchMethod || "unknown" },
                  ],
                  priorClientId: originalClientId,
                });
              } catch (err) {
                console.error("[Zoom Reprocess Matched] recordZoomReviewDecision (solo_internal) failed:", err);
              }
            }
            reprocessed++;
            continue;
          }

          // Task #2637: fuzzy content/transcript matching removed. Deterministic
          // participant matching only.

          if (!newClientId) {
            const participants = Array.isArray(record.participantsJson) ? (record.participantsJson as any[]) : [];
            const participantEmails = participants.map((p: any) => p.email).filter(Boolean) as string[];
            const participantNames = participants.map((p: any) => p.name).filter(Boolean) as string[];

            const allUsers = await storage.getAllUsers();
            const internalEmails = new Set(allUsers.map(u => u.email?.toLowerCase()).filter((e): e is string => !!e));
            const internalDomains = new Set<string>();
            for (const email of internalEmails) {
              const domain = email.split("@")[1];
              if (domain) internalDomains.add(domain);
            }
            const isInternalEmail = (email: string) => {
              const lower = email.toLowerCase();
              if (internalEmails.has(lower)) return true;
              const domain = lower.split("@")[1];
              return domain ? internalDomains.has(domain) : false;
            };
            const allParticipantsInternal = participantEmails.length > 0 &&
              participantEmails.every(e => isInternalEmail(e));
            const isSoloInternalMeeting = isNoTranscriptGeneric && allParticipantsInternal;

            if (isSoloInternalMeeting) {
              console.log(`[Zoom Reprocess Matched] Skipping solo internal no-transcript meeting: ${record.id} (${record.title})`);
              reprocessed++;
              continue;
            }

            const { matchClientByParticipants } = await import("../services/zoomIntegration");
            const participantNamesForMatch = isNoTranscriptGeneric ? [] : participantNames;
            const emailMatch = await matchClientByParticipants(participantEmails, participantNamesForMatch, { source: "zoom" });
            const isStrongEmailSignal = (matchedOn: string) => {
              const mo = matchedOn.toLowerCase();
              return !mo.startsWith("contact_name:") && !mo.startsWith("owner:");
            };
            // Task #2637: auto-claim only on a STRONG participant signal.
            // All-internal meetings already returned early above (solo-internal
            // guard), so reaching here means participants are not all-internal.
            const acceptMatch = !!emailMatch && isStrongEmailSignal(emailMatch.matchedOn);
            if (acceptMatch && emailMatch) {
              newClientId = emailMatch.clientId;
              await storage.updateRawCommunication(record.id, {
                clientId: emailMatch.clientId,
                matchMethod: emailMatch.matchedOn,
                matchStatus: "matched",
                processingStatus: "pending",
              });
              rematched++;

              try {
                // Task #4083 (pattern from Task #4079): defensive other-client
                // sweep before stamping. The loop already deletes all links at
                // its start, but this keeps every automated Zoom link writer
                // self-contained: nothing between the reset and this upsert can
                // leave a stale different-client link that double-counts the call.
                await db.delete(communicationClientLinks)
                  .where(and(
                    eq(communicationClientLinks.rawCommunicationRecordId, record.id),
                    sqlFn`${communicationClientLinks.clientId} <> ${emailMatch.clientId}`,
                  ));
                await db.insert(communicationClientLinks).values({
                  rawCommunicationRecordId: record.id,
                  clientId: emailMatch.clientId,
                  matchMethod: emailMatch.matchedOn,
                  matchConfidence: null,
                  isPrimary: true,
                  status: "detected",
                }).onConflictDoUpdate({
                  target: [communicationClientLinks.rawCommunicationRecordId, communicationClientLinks.clientId],
                  set: { matchMethod: emailMatch.matchedOn, isPrimary: true },
                });
              } catch (linkErr) { console.error("[Zoom Reprocess Matched] Link upsert failed:", linkErr); }
            }
          }

          if (!newClientId) {
            // Task #993/#2637: Zoom Reprocess Matched no longer uses the AI
            // operational classifier or agent matcher. The record was reset to
            // matchStatus="unmatched" earlier in this loop, so a non-match here
            // simply leaves it visible for manual review in the Meeting Review
            // Feed. Task #995: enqueue a no-candidate review row so the recording
            // surfaces in the Review Queue with a client picker (preserving the
            // prior attribution for the operator's reference).
            try {
              const { recordZoomReviewDecision, NO_CANDIDATE_REVIEW_REASON } = await import("../services/zoomReviewQueue");
              await recordZoomReviewDecision({
                communicationId: record.id,
                communicationType: "zoom",
                suggestedClientId: null,
                confidenceScore: 0,
                explanationSummary: `Reprocess (matched): no deterministic participant match for Zoom recording "${record.title || record.id}"`,
                reviewReason: NO_CANDIDATE_REVIEW_REASON,
                candidateShortlist: [],
                evidenceType: "structured",
                priorClientId: originalClientId ?? null,
              });
            } catch (err) {
              console.error("[Zoom Reprocess Matched] no-candidate recordZoomReviewDecision failed:", err);
            }
          }

          if (newClientId && newClientId !== originalClientId) {
            changed++;
          }

          if (newClientId) {
            // fire-and-forget: background analysis, errors logged inside
            void (async () => {
              try {
                const { analyzeCommunication } = await import("../services/communicationAnalysis");
                await analyzeCommunication(record.id);
              } catch (err) {
                console.error("[Zoom Reprocess Matched] Analysis failed for", record.id, err);
              }
            })();
          }

          reprocessed++;
          sendSSE("progress", { current: reprocessed, total });
        } catch (err) {
          console.error(`[Zoom Reprocess Matched] Error reprocessing ${record.id}:`, err);
          reprocessed++;
          sendSSE("progress", { current: reprocessed, total });
        }
      }

      console.log(`[Zoom Reprocess Matched] Done: ${reprocessed} reprocessed, ${rematched} rematched, ${changed} changed client`);
      sendSSE("complete", {
        total: matchedRecords.length,
        reprocessed,
        rematched,
        changed,
        multiClientLinked,
      });
      res.end();
    } catch (error: any) {
      console.error("[Zoom Reprocess Matched] Error:", error);
      try {
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        } else {
          res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
          res.end();
        }
      } catch (_) { res.end(); }
    }
  });

  // ============================================
  // 412G — Zoom auto-claim re-evaluation & backfill
  // ============================================

  app.post("/api/integrations/zoom/backfill-reeval/dry-run", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const windowDays = Math.max(1, Math.min(365, parseInt(req.body?.windowDays, 10) || 90));
      const recordLimit = req.body?.recordLimit ? Math.max(1, Math.min(2000, parseInt(req.body.recordLimit, 10))) : undefined;
      const targetRecordId = typeof req.body?.targetRecordId === "string" ? req.body.targetRecordId : undefined;
      const { runZoomBackfillDryRun, formatBackfillReportText } = await import("../services/zoomBackfillReeval");
      const report = await runZoomBackfillDryRun({ windowDays, recordLimit, targetRecordId });
      res.json({ report, summaryText: formatBackfillReportText(report) });
    } catch (error: any) {
      console.error("[Zoom Backfill 412G] Dry-run failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/zoom/backfill-reeval/apply", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: "Apply requires explicit confirmation. Pass { confirm: true } in the request body after reviewing the dry-run report.",
        });
      }
      const windowDays = Math.max(1, Math.min(365, parseInt(req.body?.windowDays, 10) || 90));
      const recordLimit = req.body?.recordLimit ? Math.max(1, Math.min(2000, parseInt(req.body.recordLimit, 10))) : undefined;
      const targetRecordId = typeof req.body?.targetRecordId === "string" ? req.body.targetRecordId : undefined;
      const { runZoomBackfillApply, formatBackfillReportText } = await import("../services/zoomBackfillReeval");
      const result = await runZoomBackfillApply({ windowDays, recordLimit, targetRecordId });
      res.json({ ...result, summaryText: formatBackfillReportText(result.report) });
    } catch (error: any) {
      console.error("[Zoom Backfill 412G] Apply failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/zoom/backfill-reeval/verify/:recordId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { verifyZoomBackfillRecord, formatVerificationText } = await import("../services/zoomBackfillReeval");
      const verification = await verifyZoomBackfillRecord(req.params.recordId);
      res.json({ verification, summaryText: formatVerificationText(verification) });
    } catch (error: any) {
      console.error("[Zoom Backfill 412G] Verify failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // Task #451 — Backfill Zoom review queue from previously demoted reprocess records
  // ============================================

  function parseBackfillLimit(raw: unknown): number | undefined | { error: string } {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return { error: "limit must be a positive integer" };
    if (n < 1 || n > 5000) return { error: "limit must be between 1 and 5000" };
    return Math.floor(n);
  }

  app.get("/api/integrations/zoom/review-queue/backfill/count", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { rawCommunicationRecords, agentMatchDecisions } = await import("@shared/schema");
      const { like } = await import("drizzle-orm");
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(rawCommunicationRecords)
        .where(
          and(
            eq(rawCommunicationRecords.sourceType, "zoom"),
            like(rawCommunicationRecords.matchMethod, "review_required:%"),
            sql`(${rawCommunicationRecords.matchStatus} IS NULL OR ${rawCommunicationRecords.matchStatus} <> 'orphaned')`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${agentMatchDecisions}
              WHERE ${agentMatchDecisions.communicationId} = ${rawCommunicationRecords.id}
                AND ${agentMatchDecisions.sourceType} = 'zoom'
            )`,
          ),
        );
      res.json({ count: rows[0]?.count ?? 0 });
    } catch (error: any) {
      console.error("[Zoom Review Queue Backfill] Count failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/zoom/review-queue/backfill/dry-run", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const parsedLimit = parseBackfillLimit(req.body?.limit);
      if (parsedLimit && typeof parsedLimit === "object") {
        return res.status(400).json({ error: parsedLimit.error });
      }
      const { runZoomReviewQueueBackfill, formatZoomReviewQueueBackfillReport } = await import("../services/zoomReviewQueueBackfill");
      const report = await runZoomReviewQueueBackfill({ dryRun: true, limit: parsedLimit });
      res.json({ report, summaryText: formatZoomReviewQueueBackfillReport(report) });
    } catch (error: any) {
      console.error("[Zoom Review Queue Backfill] Dry-run failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/zoom/review-queue/backfill/apply", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: "Apply requires explicit confirmation. Pass { confirm: true } in the request body after reviewing the dry-run report.",
        });
      }
      const parsedLimit = parseBackfillLimit(req.body?.limit);
      if (parsedLimit && typeof parsedLimit === "object") {
        return res.status(400).json({ error: parsedLimit.error });
      }
      const { runZoomReviewQueueBackfill, formatZoomReviewQueueBackfillReport } = await import("../services/zoomReviewQueueBackfill");
      const report = await runZoomReviewQueueBackfill({ dryRun: false, limit: parsedLimit });
      res.json({ report, summaryText: formatZoomReviewQueueBackfillReport(report) });
    } catch (error: any) {
      console.error("[Zoom Review Queue Backfill] Apply failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Task #2637: the signals-backfill dry-run/apply routes were removed — they
  // depended on the deleted zoomReviewSignalsBackfill service (which seeded
  // supporting-signal telemetry for the now-removed AI matcher). Task #5004
  // finished the retirement: the leftover GET
  // /api/integrations/zoom/review-queue/signals-backfill/count route (Task
  // #504) and the admin ZoomReviewQueue card that consumed it are gone too.
  // The ~949 legacy review rows stay signal-less by design; the review UI
  // presence-gates its signals section, so they render fine without one.

  app.get("/api/communications/:commId/client-links", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const links = await storage.listCommunicationClientLinks(req.params.commId);
      const allClients = await storage.getClients();
      const clientMap = new Map(allClients.map(c => [c.id, c]));
      const enrichedLinks = links.map(link => ({
        ...link,
        clientName: clientMap.get(link.clientId)?.firmName || "Unknown",
      }));
      res.json(enrichedLinks);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/communications/client-links/:linkId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { status } = req.body;
      if (!["detected", "confirmed", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const updated = await storage.updateCommunicationClientLink(req.params.linkId, { status });
      if (!updated) return res.status(404).json({ error: "Link not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/communications/ingest-zoom", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { ingestMeeting, ingestRecentMeetings } = await import("../services/zoomIntegration");
      const { meeting, fromDate, toDate } = req.body;

      if (meeting) {
        const { recordId, action } = await ingestMeeting(meeting, req.params.clientId, req.user.claims.sub, false, undefined, undefined, { origin: "user_manual" });

        if (action === "created" || action === "updated") {
          // fire-and-forget: background analysis, errors logged inside
          void (async () => {
            try {
              const { analyzeCommunication } = await import("../services/communicationAnalysis");
              await analyzeCommunication(recordId);
              const suggestions = await storage.listAiSuggestions(req.params.clientId, {
                rawCommunicationRecordId: recordId,
              });
              if (suggestions.length > 0) {
                // Task #1713 — Stage B: per-user inbox via notifyUser().
                const { notifyOwnerOfCommSuggestions } = await import(
                  "../services/notifications/commSuggestions"
                );
                await notifyOwnerOfCommSuggestions({
                  clientId: req.params.clientId,
                  recordId,
                  recordTitle: "Zoom recording",
                  suggestionCount: suggestions.length,
                  sourceLabel: "Zoom recording",
                });
              }
            } catch (err) {
              console.error("[Zoom] Background analysis failed:", err);
            }
          })();

          if (meeting) {
            // fire-and-forget: background Drive upload, errors logged inside
            void (async () => {
              try {
                // Task #4025: delivery-mode-aware fan-out (in-app + Drive).
                const { deliverZoomRecording } = await import("../services/clientFileDelivery");
                await deliverZoomRecording(recordId, meeting, req.params.clientId);
              } catch (err) {
                console.error("[GoogleDrive] Background upload failed:", err);
              }
            })();
          }
        }

        res.json({ success: true, recordId, action });
      } else {
        const result = await ingestRecentMeetings(req.params.clientId, req.user.claims.sub, { fromDate, toDate, origin: "user_manual" });

        for (const rec of result.records) {
          // fire-and-forget: background analysis, errors logged inside
          void (async () => {
            try {
              const { analyzeCommunication } = await import("../services/communicationAnalysis");
              await analyzeCommunication(rec.recordId);
            } catch (err) {
              console.error("[Zoom] Background analysis failed for", rec.recordId, err);
            }
          })();

          if (rec.meeting) {
            // fire-and-forget: background Drive upload, errors logged inside
            void (async () => {
              try {
                // Task #4025: delivery-mode-aware fan-out (in-app + Drive).
                const { deliverZoomRecording } = await import("../services/clientFileDelivery");
                await deliverZoomRecording(rec.recordId, rec.meeting, req.params.clientId);
              } catch (err) {
                console.error("[GoogleDrive] Background upload failed for", rec.recordId, err);
              }
            })();
          }
        }

        res.json({ success: true, ...result });
      }
    } catch (error: any) {
      console.error("[Zoom] Ingest error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // CONVERSATION SUMMARY
  // ============================================

  app.get("/api/clients/:clientId/conversation-summary", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const summary = await storage.getClientConversationSummary(req.params.clientId);
      if (!summary) {
        return res.json(null);
      }
      res.json(summary);
    } catch (error) {
      console.error("[ConvSummary] Error fetching summary:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/conversation-summary/regenerate", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { generateConversationSummary } = await import("../services/conversationSummaryService");
      await generateConversationSummary(req.params.clientId);
      const summary = await storage.getClientConversationSummary(req.params.clientId);
      res.json(summary);
    } catch (error: any) {
      console.error("[ConvSummary] Error regenerating summary:", error);
      res.status(500).json({ error: "Failed to generate conversation summary" });
    }
  });

  }
  
