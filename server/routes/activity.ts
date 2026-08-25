import type { Express, Request } from "express";
import { insertActivityLogs, getActivityLogs, getActivityLogsByIds, getActivityStats, getEntityAuditHistory, type EntityAuditEntity } from "../storage/activityStorage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireAccountManager } from "./middleware";
import { ACTIVITY_MAX_EVENTS_PER_FLUSH } from "@shared/activityConfig";
import { asyncHandler } from "../observability/httpErrors";

const MAX_METADATA_SIZE = 2048;

function sanitizeMetadata(meta: any): any {
  if (!meta || typeof meta !== "object") return null;
  const str = JSON.stringify(meta);
  if (str.length > MAX_METADATA_SIZE) return null;
  return meta;
}

export function registerActivityRoutes(app: Express) {
  // Task #3816: the read routes below migrated to asyncHandler — the global
  // error middleware now owns unexpected-error logging (with request IDs)
  // while the legacy-token argument keeps the exact old
  // `{ error: "Server error" }` 500 body. This POST batch route keeps its
  // bespoke catch: it logs flush telemetry (received/coalesced counts,
  // duration) that the global handler cannot reconstruct.
  app.post("/api/activity", isAuthenticated, async (req: any, res) => {
    const startTime = Date.now();
    try {
      const userId = req.user.claims.sub;

      const events = req.body?.events;
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: "events array required" });
      }

      const clientCoalescedCount = typeof req.body?.coalescedCount === "number" ? req.body.coalescedCount : 0;

      const receivedCount = events.length;
      const cappedEvents = events.slice(0, ACTIVITY_MAX_EVENTS_PER_FLUSH);
      const droppedCount = receivedCount - cappedEvents.length;

      const now = Date.now();
      const sanitized = cappedEvents.map((e: any) => {
        const ts = e.timestamp ? new Date(e.timestamp) : new Date();
        const tsTime = ts.getTime();
        const validTs = !isNaN(tsTime) && tsTime > now - 86400000 && tsTime <= now + 60000;

        return {
          userId,
          actionType: String(e.actionType || "unknown").slice(0, 50),
          route: e.route ? String(e.route).slice(0, 500) : null,
          actionDetail: e.actionDetail ? String(e.actionDetail).slice(0, 500) : null,
          metadata: sanitizeMetadata(e.metadata),
          sessionId: e.sessionId ? String(e.sessionId).slice(0, 100) : null,
          duration: typeof e.duration === "number" ? Math.max(0, Math.min(Math.round(e.duration), 86400)) : null,
          timestamp: validTs ? ts : new Date(),
        };
      });

      await insertActivityLogs(sanitized);

      const insertDuration = Date.now() - startTime;
      console.log(
        `[Activity] Batch insert: received=${receivedCount} inserted=${sanitized.length} dropped=${droppedCount} coalesced=${clientCoalescedCount} duration=${insertDuration}ms user=${userId}`
      );

      res.json({ ok: true });
    } catch (err: any) {
      const insertDuration = Date.now() - startTime;
      const receivedCount = Array.isArray(req.body?.events) ? req.body.events.length : 0;
      const clientCoalescedCount = typeof req.body?.coalescedCount === "number" ? req.body.coalescedCount : 0;
      console.error(
        `[Activity] Batch insert failed: received=${receivedCount} coalesced=${clientCoalescedCount} duration=${insertDuration}ms error=${err.message}`
      );
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/activity", isAuthenticated, requireAccountManager, asyncHandler(async (req: any, res) => {
    if (req.query.ids) {
      const ids = String(req.query.ids)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (ids.length === 0) return res.json({ data: [] });
      if (ids.length > 50) return res.status(400).json({ error: "Too many ids (max 50)" });
      const data = await getActivityLogsByIds(ids);
      return res.json({ data });
    }
    const filters: any = {
      limit: Math.min(parseInt(req.query.limit as string) || 100, 500),
      offset: Math.max(0, parseInt(req.query.offset as string) || 0),
    };
    if (req.query.userId) {
      const u = String(req.query.userId);
      if (u === "__system__") filters.systemOnly = true;
      else filters.userId = u;
    }
    if (req.query.actionType) filters.actionType = String(req.query.actionType);
    if (req.query.actionTypes) {
      const list = String(req.query.actionTypes)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length > 0) filters.actionTypes = list;
    }
    if (req.query.dateFrom) {
      const d = new Date(req.query.dateFrom as string);
      if (!isNaN(d.getTime())) filters.dateFrom = d;
    }
    if (req.query.dateTo) {
      const d = new Date(req.query.dateTo as string);
      if (!isNaN(d.getTime())) filters.dateTo = d;
    }

    const result = await getActivityLogs(filters);
    res.json(result);
  }, "Server error"));

  // Task #1941 — Generic entity-audit history. Returns
  // `{ [id]: Event[] }` newest-first per id (and `{ [clientId:product]:
  // Event[] }` when entity=product). Mirrors `/api/users/delete-history`
  // (Task #1912) but is parameterized by entity so the same popover
  // component can render history for clients and products.
  app.get("/api/audit-history", isAuthenticated, requireAccountManager, asyncHandler(async (req: any, res) => {
    const entityRaw = String(req.query.entity ?? "");
    if (entityRaw !== "client" && entityRaw !== "product") {
      return res.status(400).json({ error: "entity must be 'client' or 'product'" });
    }
    const entity = entityRaw as EntityAuditEntity;
    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = raw
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);
    if (ids.length === 0) return res.json({});
    if (ids.length > 200) return res.status(400).json({ error: "Too many ids (max 200)" });
    const history = await getEntityAuditHistory(entity, ids);
    res.json(history);
  }, "Server error"));

  app.get("/api/activity/stats", isAuthenticated, requireAccountManager, asyncHandler(async (req: any, res) => {
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo as string) : undefined;

    if (dateFrom && isNaN(dateFrom.getTime())) return res.status(400).json({ error: "Invalid dateFrom" });
    if (dateTo && isNaN(dateTo.getTime())) return res.status(400).json({ error: "Invalid dateTo" });

    const stats = await getActivityStats(dateFrom, dateTo);
    res.json(stats);
  }, "Server error"));
}
