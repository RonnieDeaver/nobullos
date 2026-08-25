import type { Express, Response, NextFunction } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { eq, sql, and, isNull, ne, or, desc } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead, requireAccountManager, hasRole, requireCommandCenterAccess } from "./middleware";
import { normalizeProductList, validateProductList, CANONICAL_PRODUCTS } from "../utils/productResolution";
import { bindArrayParam } from "../utils/sqlArray";
import { kickWinProgressSlackRelay } from "../services/winSlackRelay";

import type { User, RawCommunicationRecord, UpdateCommandPanel } from "@shared/schema";
  import {
    insertIntelligenceFeedEntrySchema,
    insertActionLogEntrySchema,
    updateIntelligenceFeedEntrySchema,
    updateActionLogEntrySchema,
    updateCommandPanelSchema,
    updateCommandPanelRequestSchema,
    assignCommandPanelKeyCallRequestSchema,
    assignCommandPanelRerRecordingRequestSchema,
    atsFinalDecisions,
    rawCommunicationRecords,
  } from "@shared/schema";

// Surface a Command Panel claim of a previously-unmatched recording in the
// audit trail / unmatched-feed. The deterministic manual-match write happens
// in linkRawToClientForCommandPanel; here we best-effort stamp any existing
// `claimed` agent_match_decisions row with the claimer so reviewers can see
// who claimed it from the Command Panel. (Task #2637: the agent-learning
// side-effect was removed — no AI matcher is consulted anymore.)
async function recordCommandPanelClaim(args: {
  comm: RawCommunicationRecord;
  clientId: string;
  userId: string;
}): Promise<void> {
  try {
    const sourceType = args.comm.sourceType || "zoom";
    const externalId = args.comm.externalSourceId || args.comm.id;
    const learningId = sourceType === "zoom"
      ? (externalId.startsWith("zoom_") ? externalId : `zoom_${externalId}`)
      : args.comm.id;
    // Stamp an existing claim decision with reviewer + a Command-Panel marker.
    // Find the most recent `claimed` decision for this comm/client, then update
    // it. If no such row exists, this is a best-effort no-op.
    const decisions = await storage.listAgentMatchDecisions({
      communicationId: learningId,
      clientId: args.clientId,
    });
    const claimDecision = decisions
      .filter((d) => d.status === "claimed")
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))[0];
    if (claimDecision) {
      await storage.updateAgentMatchDecision(claimDecision.id, {
        explanationSummary: "Manually matched via Command Panel",
        reviewedByUserId: args.userId,
        reviewedAt: new Date(),
      });
    }
  } catch (err) {
    console.error("[CommandPanel] Claim audit stamp failed for manual claim:", err);
  }
}

  export function registerCommandCenterRoutes(app: Express) {
    // ============================================
  // COMMAND PANEL ROUTES
  // ============================================

  // The persistable panel fields for the PUT endpoint = exactly the keys of
  // updateCommandPanelSchema (shared/models/commandCenter.ts), which omits the
  // server-managed columns (clientId, review/update stamps, call-archive
  // subfolder ids). Deriving the whitelist from the schema keeps the two in
  // lockstep by construction; field values are type-validated by the schema
  // before this list is consulted (audit A-007).
  const ALLOWED_PANEL_FIELDS = Object.keys(
    updateCommandPanelSchema.shape,
  ) as Array<keyof UpdateCommandPanel>;

  // Look up an open (unresolved) review_required Zoom decision targeting the
  // given raw record. The decision's communication_id may reference either the
  // raw record's id or its external_source_id, so we check both.
  //
  // Zoom-only by design (see linkRawToClientForCommandPanel below for the full
  // rationale): agent_match_decisions rows are only ever written with
  // source_type='zoom' (search server/services for `sourceType: "zoom"`), and
  // the unmatched-feed query in server/routes/integrations.ts explicitly
  // states "Slack stays client_id IS NULL only — it has no review-queue
  // concept." If Slack ever grows a review queue, mirror this lookup there
  // (and extend zoomReviewQueue.ts, which currently hard-rejects non-Zoom
  // decisions in approveReviewDecision/reassignReviewDecision).
  async function findOpenZoomReviewForRaw(raw: { id: string; externalSourceId?: string | null }): Promise<{ id: string } | null> {
    const keys = [raw.id];
    if (raw.externalSourceId) keys.push(raw.externalSourceId);
    const result = await db.execute(sql`
      SELECT id FROM agent_match_decisions
      WHERE source_type = 'zoom'
        AND status = 'review_required'
        AND review_resolution IS NULL
        AND communication_id = ANY(${bindArrayParam(keys)})
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = result.rows[0] as { id: string } | undefined;
    return row && row.id ? { id: String(row.id) } : null;
  }

  // Link a raw Zoom or Slack recording to the given client when assigning it
  // from a Command Panel picker. Handles three cases:
  //  1) raw has no client_id → simple manual link, plus surface the claim in
  //     the unmatched-feed audit trail via recordCommandPanelClaim.
  //  2) raw has an unresolved review_required decision → resolve via the
  //     review queue (approve or reassign) so the audit trail and
  //     communication_client_links stay consistent. Currently Zoom-only:
  //     agent_match_decisions is only ever written with source_type='zoom'
  //     (Slack ingestion does not produce review_required decisions), and
  //     server/routes/integrations.ts mirrors this in its unmatched-feed
  //     query ("Slack stays client_id IS NULL only — it has no review-queue
  //     concept"). Slack records therefore always fall through to case (1)
  //     or (3). If Slack ever grows a review queue, broaden the source_type
  //     check below and update zoomReviewQueue.ts accordingly.
  //  3) raw is already linked to this client → no-op.
  // Returns an HTTP-style { error, status } if the assignment is rejected.
  async function linkRawToClientForCommandPanel(
    rawId: string,
    targetClientId: string,
    userId: string,
  ): Promise<{ error: string; status: number } | null> {
    const comm = await storage.getRawCommunication(rawId);
    if (!comm) return { error: "Recording not found", status: 404 };

    // Always check for an open review first — even if the raw record is
    // already tentatively linked to this client, resolving the review clears
    // it from the agent queue so it doesn't keep nagging.
    if (comm.sourceType === "zoom") {
      const openReview = await findOpenZoomReviewForRaw(comm);
      if (openReview) {
        const { approveReviewDecision } = await import("../services/zoomReviewQueue");
        await approveReviewDecision({
          decisionId: openReview.id,
          userId,
          approvedClientId: targetClientId,
        });
        return null;
      }
    }

    if (comm.clientId === targetClientId) return null;
    if (comm.clientId && comm.clientId !== targetClientId) {
      return { error: "Recording belongs to a different client and cannot be assigned", status: 400 };
    }
    await storage.updateRawCommunication(rawId, {
      clientId: targetClientId,
      matchStatus: "matched",
      matchMethod: "manual_command_panel",
    });
    // Surface this claim in the unmatched-feed audit trail (recently
    // claimed view) so reviewers see who picked up the recording vs.
    // it silently disappearing.
    void recordCommandPanelClaim({
      comm,
      clientId: targetClientId,
      userId,
    });
    return null;
  }

  async function authorizeClientAccess(req: any, res: any, requireWrite: boolean = false): Promise<{ user: User; client: any } | null> {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const user = await storage.getUser(userId);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const clientId = req.params.clientId;
    const client = await storage.getClient(clientId);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return null;
    }

    if (hasRole(user.role, 'account_manager')) {
      return { user, client };
    }

    if (requireWrite && user.role === "sales") {
      res.status(403).json({ error: "Sales role has read-only access to command panels" });
      return null;
    }

    if (user.role === "sales" && !requireWrite) {
      return { user, client };
    }

    res.status(403).json({ error: "You do not have access to this client's command panel" });
    return null;
  }

  app.get("/api/clients/:clientId/command-panel", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      // Task #1796: operator opening the Client Command Center counts
      // as activity for the demand-driven SEMrush gate. Best-effort.
      try {
        const { markClientViewed } = await import(
          "../services/semrushCadenceGate"
        );
        void markClientViewed(req.params.clientId, "command_center:load");
      } catch {}
      const panel = await storage.getCommandPanel(req.params.clientId);
      res.json(panel || null);
    } catch (error: any) {
      console.error("[CommandPanel] Error fetching:", error);
      res.status(500).json({ error: "Failed to fetch command panel" });
    }
  });

  app.put("/api/clients/:clientId/command-panel", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;

      const { user } = auth;
      const clientId = req.params.clientId;

      const parsedBody = updateCommandPanelRequestSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({ error: parsedBody.error.issues });
      }
      const { reason, ...validatedFields } = parsedBody.data;

      // Explicit whitelist construction of the persistence payload: copy only
      // known panel fields the caller actually supplied (explicit null is a
      // deliberate "clear this field"; unknown keys were already stripped).
      const panelData: UpdateCommandPanel = {};
      for (const field of ALLOWED_PANEL_FIELDS) {
        if (validatedFields[field] !== undefined) {
          (panelData as Record<string, unknown>)[field] = validatedFields[field];
        }
      }

      // Task #4510: canonicalize productTypes at the write boundary. The panel
      // used to persist the caller's array raw (only the clients.products
      // mirror was normalized), so legacy aliases like plural "webinars" —
      // invisible to the canonical-id edit checkboxes — survived every save
      // and could never be removed. Normalizing here means any stored alias
      // heals on the next save, and unrecognized values are rejected with the
      // same INVALID_PRODUCTS envelope the clients routes use, before any
      // write. Explicit null keeps its "clear the column" meaning, and the
      // panel PUT continues to allow an empty list.
      if (Array.isArray(panelData.productTypes)) {
        const { normalized, invalid } = validateProductList(panelData.productTypes);
        if (invalid.length > 0) {
          return res.status(400).json({
            error: "Unknown product value(s) submitted. Allowed products: " + CANONICAL_PRODUCTS.join(", ") + ".",
            code: "INVALID_PRODUCTS",
            invalid,
            allowed: [...CANONICAL_PRODUCTS],
          });
        }
        panelData.productTypes = normalized;
      }

      const existingPanel = await storage.getCommandPanel(clientId);

      if (!existingPanel && panelData.productTypes === undefined) {
        const client = await storage.getClient(clientId);
        if (client?.products && client.products.length > 0) {
          panelData.productTypes = normalizeProductList(client.products);
        }
      }

      const panel = await storage.upsertCommandPanel({
        ...panelData,
        clientId,
        lastUpdatedBy: user.id,
      });

      if (existingPanel) {
        for (const field of ALLOWED_PANEL_FIELDS) {
          if (panelData[field] !== undefined) {
            const oldVal = (existingPanel as any)[field];
            const newVal = panelData[field];
            const oldStr = oldVal != null ? (typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal)) : null;
            const newStr = newVal != null ? (typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal)) : null;

            if (oldStr !== newStr) {
              await storage.createCommandPanelHistory({
                commandPanelId: panel.id,
                clientId,
                fieldName: field,
                oldValue: oldStr,
                newValue: newStr,
                changedBy: user.id,
                reason: reason || null,
              });
              await storage.createCommandPanelVersion({
                clientId,
                fieldName: field,
                previousValue: oldStr,
                newValue: newStr,
                changedBy: user.id,
                sourceReference: null,
                changeReason: reason || null,
              });
            }
          }
        }
      } else {
        for (const field of ALLOWED_PANEL_FIELDS) {
          if (panelData[field] != null) {
            const val = panelData[field];
            const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
            await storage.createCommandPanelHistory({
              commandPanelId: panel.id,
              clientId,
              fieldName: field,
              oldValue: null,
              newValue: valStr,
              changedBy: user.id,
              reason: reason || null,
            });
            await storage.createCommandPanelVersion({
              clientId,
              fieldName: field,
              previousValue: null,
              newValue: valStr,
              changedBy: user.id,
              sourceReference: null,
              changeReason: reason || null,
            });
          }
        }
      }

      if (panelData.productTypes !== undefined) {
        const cpProducts = Array.isArray(panelData.productTypes) ? panelData.productTypes : [];
        const canonical = normalizeProductList(cpProducts);
        try {
          await storage.updateClient(clientId, { products: canonical.length > 0 ? [...canonical] : [] } as any);
          console.log(`[CommandPanel] Synced products for client ${clientId}: CP ${JSON.stringify(cpProducts)} → canonical ${JSON.stringify(canonical)}`);
        } catch (syncErr: any) {
          console.error(`[CommandPanel] ⚠ PRODUCT SYNC DRIFT: Failed to mirror products to clients.products for client ${clientId}. Command panel saved with ${JSON.stringify(cpProducts)} but client mirror is now stale. Error:`, syncErr);
        }
      }

      res.json(panel);
    } catch (error: any) {
      console.error("[CommandPanel] Error saving:", error);
      res.status(500).json({ error: "Failed to save command panel" });
    }
  });

  app.post("/api/clients/:clientId/command-panel/review", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;
      const panel = await storage.markCommandPanelReviewed(req.params.clientId, auth.user.id);
      res.json(panel);
    } catch (error: any) {
      console.error("[CommandPanel] Error marking reviewed:", error);
      res.status(500).json({ error: "Failed to mark as reviewed" });
    }
  });

  app.get("/api/clients/:clientId/command-panel/history", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;

      const { fieldName, changedBy, dateFrom, dateTo, sinceLastReview } = req.query;

      let filters: {
        fieldName?: string;
        changedBy?: string;
        dateFrom?: Date;
        dateTo?: Date;
      } = {};

      if (fieldName) filters.fieldName = fieldName as string;
      if (changedBy) filters.changedBy = changedBy as string;
      if (dateFrom) {
        const d = new Date(dateFrom as string);
        if (!isNaN(d.getTime())) filters.dateFrom = d;
      }
      if (dateTo) {
        const d = new Date(dateTo as string);
        if (!isNaN(d.getTime())) filters.dateTo = d;
      }

      if (sinceLastReview === "true") {
        const panel = await storage.getCommandPanel(req.params.clientId);
        if (panel?.lastReviewedAt) {
          filters.dateFrom = new Date(panel.lastReviewedAt);
        }
      }

      const history = await storage.getCommandPanelHistory(req.params.clientId, Object.keys(filters).length > 0 ? filters : undefined);
      res.json(history);
    } catch (error: any) {
      console.error("[CommandPanel] Error fetching history:", error);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // Key Calls endpoints
  app.get("/api/clients/:clientId/command-panel/key-calls", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const keyCalls = await storage.getKeyCallsForClient(req.params.clientId);
      const commIds = keyCalls
        .map(kc => kc.rawCommunicationRecordId)
        .filter((id): id is string => !!id);
      const communications = await storage.getRawCommunicationsByIds(commIds);
      const commMap = new Map(communications.map(c => [c.id, c]));
      const enriched = keyCalls.map(kc => {
        const communication = kc.rawCommunicationRecordId ? commMap.get(kc.rawCommunicationRecordId) : null;
        return {
          ...kc,
          communication: communication ? {
            id: communication.id,
            title: communication.title,
            timestamp: communication.timestamp,
            sourceType: communication.sourceType,
            contentText: communication.contentText,
            aiSummary: communication.aiSummary,
            contentPreview: communication.contentPreview,
          } : null,
        };
      });
      res.json(enriched);
    } catch (error: any) {
      console.error("[KeyCalls] Error fetching key calls:", error);
      res.status(500).json({ error: "Failed to fetch key calls" });
    }
  });

  app.post("/api/clients/:clientId/command-panel/key-calls", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;
      const parsedBody = assignCommandPanelKeyCallRequestSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        // Preserve the pre-Zod envelope for a missing/unknown callType; any
        // other field failure reports the shared issues envelope.
        if (parsedBody.error.issues.some((issue) => issue.path[0] === "callType")) {
          return res.status(400).json({ error: "Invalid callType" });
        }
        return res.status(400).json({ error: parsedBody.error.issues });
      }
      const { callType, rawCommunicationRecordId } = parsedBody.data;
      const panel = await storage.getCommandPanel(req.params.clientId);
      if (!panel) {
        return res.status(404).json({ error: "Command panel not found. Create one first." });
      }
      if (rawCommunicationRecordId) {
        const linkErr = await linkRawToClientForCommandPanel(
          rawCommunicationRecordId,
          req.params.clientId,
          auth.user.id,
        );
        if (linkErr) {
          return res.status(linkErr.status).json({ error: linkErr.error });
        }
      }
      const keyCall = await storage.upsertKeyCall({
        commandPanelId: panel.id,
        clientId: req.params.clientId,
        callType,
        rawCommunicationRecordId: rawCommunicationRecordId || null,
        assignedBy: auth.user.id,
      });
      res.json(keyCall);
    } catch (error: any) {
      console.error("[KeyCalls] Error assigning key call:", error);
      res.status(500).json({ error: "Failed to assign key call" });
    }
  });

  app.delete("/api/clients/:clientId/command-panel/key-calls/:callType", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;
      await storage.deleteKeyCall(req.params.clientId, req.params.callType);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[KeyCalls] Error deleting key call:", error);
      res.status(500).json({ error: "Failed to delete key call" });
    }
  });

  // RER Recordings endpoints
  app.get("/api/clients/:clientId/command-panel/rer-recordings", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const rerRecordings = await storage.getRerRecordingsForClient(req.params.clientId);
      const commIds = rerRecordings.map(rer => rer.rawCommunicationRecordId).filter(Boolean);
      const communications = await storage.getRawCommunicationsByIds(commIds);
      const commMap = new Map(communications.map(c => [c.id, c]));
      const enriched = rerRecordings.map(rer => {
        const communication = commMap.get(rer.rawCommunicationRecordId);
        return {
          ...rer,
          communication: communication ? {
            id: communication.id,
            title: communication.title,
            timestamp: communication.timestamp,
            sourceType: communication.sourceType,
            contentText: communication.contentText,
            aiSummary: communication.aiSummary,
            contentPreview: communication.contentPreview,
          } : null,
        };
      });
      res.json(enriched);
    } catch (error: any) {
      console.error("[RER] Error fetching RER recordings:", error);
      res.status(500).json({ error: "Failed to fetch RER recordings" });
    }
  });

  app.post("/api/clients/:clientId/command-panel/rer-recordings", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;
      // Zod trims both ids and rejects non-strings/blanks; keep the pre-Zod
      // envelope (a single fixed message) for every malformed-body shape.
      const parsedBody = assignCommandPanelRerRecordingRequestSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({ error: "rawCommunicationRecordId and reportingMonth are required" });
      }
      const { rawCommunicationRecordId: rawId, reportingMonth } = parsedBody.data;
      const panel = await storage.getCommandPanel(req.params.clientId);
      if (!panel) {
        return res.status(404).json({ error: "Command panel not found. Create one first." });
      }
      const linkErr = await linkRawToClientForCommandPanel(
        rawId,
        req.params.clientId,
        auth.user.id,
      );
      if (linkErr) {
        return res.status(linkErr.status).json({ error: linkErr.error });
      }
      const { recording, duplicate } = await storage.createRerRecording({
        commandPanelId: panel.id,
        clientId: req.params.clientId,
        rawCommunicationRecordId: rawId,
        reportingMonth,
        assignedBy: auth.user.id,
      });
      res.json(duplicate ? { ...recording, duplicate: true } : recording);
    } catch (error: any) {
      console.error("[RER] Error creating RER recording:", error);
      res.status(500).json({ error: "Failed to create RER recording" });
    }
  });

  app.delete("/api/clients/:clientId/command-panel/rer-recordings/:id", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;
      await storage.deleteRerRecording(req.params.id, req.params.clientId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[RER] Error deleting RER recording:", error);
      res.status(500).json({ error: "Failed to delete RER recording" });
    }
  });

  // Unmatched Zoom recordings, surfaced inside the Command Panel pickers so an
  // admin can assign an unmatched recording directly to the current client.
  app.get("/api/clients/:clientId/command-panel/unmatched-zoom", isAuthenticated, async (req: any, res) => {
    try {
      // requireWrite=true: this endpoint exposes globally unmatched Zoom
      // recordings (clientId IS NULL), not data scoped to this client. Only
      // roles that can actually assign one (account_manager+, not sales) need
      // to see it, mirroring the unmatched-feed permission model.
      const auth = await authorizeClientAccess(req, res, true);
      if (!auth) return;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 200);
      // Include both: (a) zoom records with no client_id, and (b) zoom records
      // already tentatively linked but still sitting in the agent review queue
      // (review_required, unresolved). Admins can override the pending review
      // and claim the recording for the current client from the picker.
      // Correlated EXISTS against the outer alias `r` (the FROM clause below
      // aliases raw_communication_records AS r, so the bare table name is no
      // longer in scope here).
      const zoomHasOpenReview = sql`EXISTS (
        SELECT 1 FROM agent_match_decisions amd
        WHERE amd.source_type = 'zoom'
          AND amd.status = 'review_required'
          AND amd.review_resolution IS NULL
          AND (amd.communication_id = r.id
               OR amd.communication_id = r.external_source_id)
      )`;
      // Decorate each row with the open review's reason / suggested client so
      // the picker can show "Pending review · suggested: Acme (78%)" instead
      // of looking identical to truly-unmatched recordings (#654).
      const rows = await db.execute(sql`
        SELECT r.id, r.title, r.timestamp, r.source_type AS "sourceType",
               amd."decisionId" AS "decisionId",
               amd.review_reason AS "reviewReason",
               amd.client_id AS "suggestedClientId",
               amd.confidence_score AS "suggestedConfidence",
               amd.prior_client_id AS "priorClientId",
               sc.firm_name AS "suggestedClientName",
               pc.firm_name AS "priorClientName"
        FROM raw_communication_records r
        LEFT JOIN LATERAL (
          SELECT d.id AS "decisionId", d.review_reason, d.client_id, d.confidence_score, d.prior_client_id
          FROM agent_match_decisions d
          WHERE d.source_type = 'zoom'
            AND d.status = 'review_required'
            AND d.review_resolution IS NULL
            AND (d.communication_id = r.id OR d.communication_id = r.external_source_id)
          ORDER BY d.created_at DESC
          LIMIT 1
        ) amd ON TRUE
        LEFT JOIN clients sc ON sc.id = amd.client_id
        LEFT JOIN clients pc ON pc.id = amd.prior_client_id
        WHERE r.source_type = 'zoom'
          AND (r.client_id IS NULL OR ${zoomHasOpenReview})
          AND (r.match_status IS NULL OR r.match_status <> 'dismissed_operational')
          -- Task #904: don't surface zoom recordings whose parent client was
          -- deleted (match_status='orphaned'); they're forensic-only.
          AND (r.match_status IS NULL OR r.match_status <> 'orphaned')
        ORDER BY r.timestamp DESC NULLS LAST
        LIMIT ${limit}
      `);
      type ZoomPickerRow = {
        id: string;
        title: string | null;
        timestamp: Date | string | null;
        sourceType: string | null;
        decisionId: string | null;
        reviewReason: string | null;
        suggestedClientId: string | null;
        suggestedClientName: string | null;
        suggestedConfidence: number | string | null;
        priorClientId: string | null;
        priorClientName: string | null;
      };
      const records = (rows.rows as ZoomPickerRow[]).map((r) => ({
        id: r.id,
        title: r.title,
        timestamp: r.timestamp,
        sourceType: r.sourceType,
        decisionId: r.decisionId || null,
        reviewReason: r.reviewReason || null,
        suggestedClientId: r.suggestedClientId || null,
        suggestedClientName: r.suggestedClientName || null,
        suggestedConfidence: r.suggestedConfidence != null ? Number(r.suggestedConfidence) : null,
        priorClientId: r.priorClientId || null,
        priorClientName: r.priorClientName || null,
        isPendingReview: !!r.reviewReason,
      }));
      res.json(records);
    } catch (error: any) {
      console.error("[CommandPanel] Error fetching unmatched zoom recordings:", error);
      res.status(500).json({ error: "Failed to fetch unmatched zoom recordings" });
    }
  });

  app.post("/api/ats/candidates/:id/final-decision/approve", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const decisions = await db.select().from(atsFinalDecisions)
        .where(eq(atsFinalDecisions.candidateId, req.params.id))
        .orderBy(sql`created_at DESC`)
        .limit(1);
      if (decisions.length === 0) return res.status(404).json({ error: "No final decision found" });

      const [updated] = await db.update(atsFinalDecisions)
        .set({ approvedBy: req.user?.id, approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(atsFinalDecisions.id, decisions[0].id)).returning();
      res.json(updated);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // ============================================
  // COMMAND CENTER API
  // ============================================


  // --- Command Panel ---

  app.get("/api/command-panel-summaries", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const rawSummaries = await storage.getAllCommandPanelSummaries();

      // Task #4038: derive per-panel missing-budget flags (product selected
      // but its budget NULL) so the client list can surface gaps without
      // opening each panel. Mirrors renderMissingBudgetNotice in
      // client/src/components/CommandPanel.tsx (lsa/google_ads/webinar).
      const BUDGETED_PRODUCTS: Array<{ id: string; budget: (s: { lsaBudget: number | null; googleAdsBudget: number | null; webinarBudget: number | null }) => number | null }> = [
        { id: "lsa", budget: (s) => s.lsaBudget },
        { id: "google_ads", budget: (s) => s.googleAdsBudget },
        { id: "webinar", budget: (s) => s.webinarBudget },
      ];
      const allSummaries = rawSummaries.map((s) => ({
        clientId: s.clientId,
        lastReviewedAt: s.lastReviewedAt,
        missingBudgets: BUDGETED_PRODUCTS
          .filter((p) => (s.productTypes || []).includes(p.id) && p.budget(s) == null)
          .map((p) => p.id),
      }));

      if (hasRole(user.role, 'account_manager')) {
        return res.json(allSummaries);
      }

      const userClients = await storage.getClientsByOwner(userId);
      const userClientIds = new Set(userClients.map((c: any) => c.id));
      const filtered = allSummaries.filter(s => userClientIds.has(s.clientId));
      res.json(filtered);
    } catch (error) {
      console.error("[CommandCenter] Error fetching summaries:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // --- Command Panel Versions (Task #41 version tracking) ---

  app.get("/api/clients/:clientId/command-panel/versions", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const versions = await storage.getCommandPanelVersions(req.params.clientId);
      res.json(versions);
    } catch (error) {
      console.error("[CommandCenter] Error fetching versions:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // --- Intelligence Feed ---

  app.get("/api/clients/:clientId/intelligence-feed", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const filters: any = {};
      if (req.query.type) filters.type = req.query.type;
      if (req.query.author) filters.author = req.query.author;
      if (req.query.dateFrom) filters.dateFrom = new Date(req.query.dateFrom as string);
      if (req.query.dateTo) filters.dateTo = new Date(req.query.dateTo as string);
      if (req.query.status) filters.status = req.query.status;
      if (req.query.pinned !== undefined) filters.pinned = req.query.pinned === 'true';
      if (req.query.search) filters.search = req.query.search;

      const entries = await storage.listIntelligenceFeedEntries(req.params.clientId, filters);
      res.json(entries);
    } catch (error) {
      console.error("[CommandCenter] Error listing intelligence feed:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/intelligence-feed", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const user = (req as any).dbUser;
      const data = {
        ...req.body,
        clientId: req.params.clientId,
        createdBy: user.id,
      };

      const parsed = insertIntelligenceFeedEntrySchema.safeParse(data);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }

      const entry = await storage.createIntelligenceFeedEntry(parsed.data);

      // Task #4985 — a logged "Win Progress" entry also announces to the
      // team's #general Slack channel. Fire-and-forget: single best-effort
      // background attempt (the kick never throws and its promise never
      // rejects), so the request never waits on Slack and a Slack failure
      // can never fail the creation. Demo/archived-client and retracted-
      // entry gating lives inside the kick (Win Feed semantics); the
      // client row was already loaded by requireCommandCenterAccess.
      if (entry.entryType === "win_progress") {
        void kickWinProgressSlackRelay({
          entry,
          client: (req as any).client ?? null,
          author: user ?? null,
        });
      }

      res.status(201).json(entry);
    } catch (error) {
      console.error("[CommandCenter] Error creating intelligence feed entry:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/intelligence-feed/:id", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { id: _id, clientId: _cid, createdBy: _cb, createdAt: _ca, updatedAt: _ua, ...rawData } = req.body;
      const parsed = updateIntelligenceFeedEntrySchema.safeParse(rawData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const entry = await storage.updateIntelligenceFeedEntry(req.params.id, req.params.clientId, parsed.data);
      if (!entry) {
        return res.status(404).json({ error: "Intelligence feed entry not found" });
      }
      res.json(entry);
    } catch (error) {
      console.error("[CommandCenter] Error updating intelligence feed entry:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/intelligence-feed/:id/pin", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const entry = await storage.updateIntelligenceFeedEntry(req.params.id, req.params.clientId, {
        pinned: req.body.pinned !== undefined ? req.body.pinned : true,
      });
      if (!entry) {
        return res.status(404).json({ error: "Intelligence feed entry not found" });
      }
      res.json(entry);
    } catch (error) {
      console.error("[CommandCenter] Error pinning intelligence feed entry:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/intelligence-feed/:id/archive", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const entry = await storage.updateIntelligenceFeedEntry(req.params.id, req.params.clientId, {
        status: "archived",
      });
      if (!entry) {
        return res.status(404).json({ error: "Intelligence feed entry not found" });
      }
      res.json(entry);
    } catch (error) {
      console.error("[CommandCenter] Error archiving intelligence feed entry:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── Task #4874: cross-client Win Feed ─────────────────────────────────────
  // Team-wide read of recent wins for the OS dashboard. Deliberately NOT
  // requireCommandCenterAccess — that gate is per-client, while this read
  // spans every client, so it takes the account-manager+ role gate instead.
  // Read-only and LIMIT-bounded (validated clamp 1–50, default 20).
  app.get("/api/dashboard/wins", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
      const wins = await storage.listRecentWins(limit);
      res.json(wins);
    } catch (error) {
      console.error("[CommandCenter] Error listing recent wins:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // --- Action Log ---

  app.get("/api/clients/:clientId/action-log", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const filters: any = {};
      if (req.query.actionType) filters.actionType = req.query.actionType;
      if (req.query.actor) filters.actor = req.query.actor;
      if (req.query.dateFrom) filters.dateFrom = new Date(req.query.dateFrom as string);
      if (req.query.dateTo) filters.dateTo = new Date(req.query.dateTo as string);
      if (req.query.impactedSystem) filters.impactedSystem = req.query.impactedSystem;
      if (req.query.search) filters.search = req.query.search;

      const entries = await storage.listActionLogEntries(req.params.clientId, filters);
      res.json(entries);
    } catch (error) {
      console.error("[CommandCenter] Error listing action log:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/action-log", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const user = (req as any).dbUser;
      const data = {
        ...req.body,
        clientId: req.params.clientId,
        createdBy: user.id,
      };

      const parsed = insertActionLogEntrySchema.safeParse(data);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }

      const entry = await storage.createActionLogEntry(parsed.data);
      res.status(201).json(entry);
    } catch (error) {
      console.error("[CommandCenter] Error creating action log entry:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/action-log/:id", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { id: _id, clientId: _cid, createdBy: _cb, createdAt: _ca, updatedAt: _ua, ...rawData } = req.body;
      const parsed = updateActionLogEntrySchema.safeParse(rawData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const entry = await storage.updateActionLogEntry(req.params.id, req.params.clientId, parsed.data);
      if (!entry) {
        return res.status(404).json({ error: "Action log entry not found" });
      }
      res.json(entry);
    } catch (error) {
      console.error("[CommandCenter] Error updating action log entry:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  }
  