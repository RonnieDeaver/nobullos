// @db-pool-intent: api
/**
 * Service Desk routes — ticket read model & mapping queue.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: All active department members, Eligibility, Needs-mapping surface, View counts, All tickets, Re-run automatic mapping, Dismiss / restore mapping, Ticket events read.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireCeo } from "../middleware";
import { getDb, withDbAttribution } from "../../db";
import { sdDepartmentMembers, sdTicketMapping, sdTicketEvents, clickupTasks } from "@shared/schema";
import { users } from "@shared/models/auth";
import { eq, and, asc, sql } from "drizzle-orm";
import { getListMappingConfig, getCeoToken, getEligibleAssignees, resolveTickets, getUserDeptIds, applyViewFilter } from "./helpers";
import { resolveClickUpIdentities } from "../../services/sdRoleResolution";

export function registerServiceDeskTicketReadRoutes(app: Express): void {
  // ── All active department members (for reassign / change-dept UI) ──────────

  app.get("/api/service-desk/eligible-assignees", isAuthenticated, async (_req, res) => {
    try {
      const rows = await withDbAttribution("serviceDesk:eligibleAssignees", async () => {
        const db = getDb();
        return db
          .selectDistinct({
            departmentId: sdDepartmentMembers.departmentId,
            userId: sdDepartmentMembers.userId,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(sdDepartmentMembers)
          .innerJoin(users, eq(users.id, sdDepartmentMembers.userId))
          .where(eq(sdDepartmentMembers.active, true));
      });
      const config = await getListMappingConfig();
      const identities = await resolveClickUpIdentities(
        rows.map((row) => ({ userId: row.userId, departmentId: row.departmentId })),
        config?.clickupWorkspaceId ?? null,
      );
      const seen = new Set<string>();
      const assignees = rows.flatMap((row) => {
        const identity = identities.get(`${row.userId}|${row.departmentId}`);
        const key = `${row.userId}|${identity?.externalUserId ?? ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{
          userId: row.userId,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          clickupUserId: identity?.ready ? identity.externalUserId : null,
          projectionIdentity: identity ?? null,
        }];
      });
      res.json({ assignees });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Eligibility ────────────────────────────────────────────────────────────

  app.get(
    "/api/service-desk/eligibility/:departmentId",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { departmentId } = req.params;
        const config = await getListMappingConfig();
        const ceoToken = await getCeoToken(req).catch(() => null);
        const result = await getEligibleAssignees(departmentId, {
          ceoToken,
          workspaceId: config?.clickupWorkspaceId ?? null,
        });
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Ticket read model ──────────────────────────────────────────────────────

  // ── Needs-mapping surface ─────────────────────────────────────────────────
  // Returns tickets whose NoBull mapping is incomplete (no resolved client
  // or no resolved requester). Surfaced to admins for manual completion.

  app.get("/api/service-desk/tickets/needs-mapping", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const config = await getListMappingConfig();
      if (!config?.clickupListId) {
        return res.json({ tickets: [], configured: false });
      }
      const allTickets = await resolveTickets(config);
      // Tickets a CEO explicitly dismissed from the unmapped queue (test/spam
      // submissions) are excluded via the nts.mappingDismissed flag.
      const dismissedRows = await withDbAttribution("serviceDesk:needsMappingDismissed", async () => {
        const db = getDb();
        return db
          .select({ clickupTaskId: sdTicketMapping.clickupTaskId })
          .from(sdTicketMapping)
          .where(sql`${sdTicketMapping.nts} ->> 'mappingDismissed' = 'true'`);
      });
      const dismissedIds = new Set(dismissedRows.map((r) => r.clickupTaskId));
      const needsMapping = allTickets.filter(
        (t) => (!t.requesterUserId || !t.resolvedClientId) && !dismissedIds.has(t.clickupTaskId),
      );
      res.json({
        tickets: needsMapping,
        total: allTickets.length,
        dismissedCount: dismissedIds.size,
        configured: true,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── View counts endpoint (Task #3059) ───────────────────────────────────────
  // Returns badge counts for all 9 home-page views without the full payload.

  app.get("/api/service-desk/views/counts", isAuthenticated, async (req: any, res) => {
    try {
      const currentUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const config = await getListMappingConfig();
      if (!config?.clickupListId) {
        return res.json({ counts: {}, configured: false });
      }
      const [allTickets, userDeptIds] = await Promise.all([
        resolveTickets(config),
        getUserDeptIds(currentUserId),
      ]);
      const views = [
        "my_submitted", "assigned_to_me", "waiting_on_me", "my_department",
        "due_today", "overdue", "recently_updated", "delivered_for_review", "closed",
      ];
      const counts: Record<string, number> = {};
      for (const v of views) {
        counts[v] = applyViewFilter(allTickets, v, currentUserId, userDeptIds).length;
      }
      res.json({ counts, configured: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── All tickets (optionally filtered by view or clientId) ───────────────────

  app.get("/api/service-desk/tickets", isAuthenticated, async (req: any, res) => {
    try {
      const { view, clientId } = req.query as { view?: string; clientId?: string };
      const currentUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const config = await getListMappingConfig();
      if (!config?.clickupListId) {
        return res.json({ tickets: [], configured: false });
      }
      let tickets = await resolveTickets(config);
      if (view) {
        const userDeptIds = await getUserDeptIds(currentUserId);
        tickets = applyViewFilter(tickets, view, currentUserId, userDeptIds);
      }
      if (clientId) {
        tickets = tickets.filter(
          (t) => String(t.clientId) === clientId || String(t.resolvedClientId) === clientId,
        );
      }
      res.json({ tickets, configured: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/service-desk/tickets/:taskId", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const config = await getListMappingConfig();
      if (!config?.clickupListId) {
        return res.status(404).json({ error: "Service desk not configured" });
      }
      const tickets = await resolveTickets(config, [taskId]);
      if (!tickets.length) return res.status(404).json({ error: "Ticket not found" });
      res.json({ ticket: tickets[0] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/service-desk/tickets/:taskId/mapping",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { taskId } = req.params;
        const { clientId, requesterUserId, ownerUserId, departmentId, nts } = req.body as {
          clientId?: number | null;
          requesterUserId?: string | null;
          ownerUserId?: string | null;
          departmentId?: string | null;
          nts?: Record<string, any> | null;
        };
        const [row] = await withDbAttribution("serviceDesk:upsertTicketMapping", async () => {
          const db = getDb();
          const vals: Record<string, any> = {
            clickupTaskId: taskId,
            updatedAt: new Date(),
          };
          if (clientId !== undefined) vals.clientId = clientId;
          if (requesterUserId !== undefined) vals.requesterUserId = requesterUserId;
          if (ownerUserId !== undefined) vals.ownerUserId = ownerUserId;
          if (departmentId !== undefined) vals.departmentId = departmentId;
          if (nts !== undefined) vals.nts = nts;
          return db
            .insert(sdTicketMapping)
            .values({ clickupTaskId: taskId, ...vals })
            .onConflictDoUpdate({
              target: sdTicketMapping.clickupTaskId,
              set: { ...vals },
            })
            .returning();
        });
        res.json({ mapping: row });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Re-run automatic mapping for one ticket (CEO) ─────────────────────────
  // Re-triggers tryCompleteSdTicketMapping using the mirrored ClickUp task data.
  // Useful after the submitter's email has been added as a NoBull user.

  app.post(
    "/api/service-desk/tickets/:taskId/rerun-mapping",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { taskId } = req.params;
        const config = await getListMappingConfig();
        if (!config?.clickupListId) {
          return res.status(404).json({ error: "Service desk not configured" });
        }
        const [taskRow] = await withDbAttribution("serviceDesk:rerunMapping:read", async () => {
          const db = getDb();
          return db
            .select()
            .from(clickupTasks)
            .where(and(eq(clickupTasks.id, taskId), eq(clickupTasks.listId, config.clickupListId!)))
            .limit(1);
        });
        if (!taskRow) return res.status(404).json({ error: "Ticket not found" });

        const { tryCompleteSdTicketMapping } = await import("../../services/clickUpWorkerHandlers");
        await tryCompleteSdTicketMapping(
          { id: taskRow.id, customFields: taskRow.customFields },
          taskRow.listId ?? config.clickupListId!,
        );

        const [ticket] = await resolveTickets(config, [taskId]);
        res.json({ ticket: ticket ?? null });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Dismiss / restore a ticket from the unmapped queue (CEO) ──────────────
  // Sets nts.mappingDismissed on the ticket mapping row. Dismissed tickets are
  // excluded from the needs-mapping surface (test or spam submissions).

  app.post(
    "/api/service-desk/tickets/:taskId/dismiss-mapping",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { taskId } = req.params;
        const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
        const dismissed = req.body?.dismissed !== false;
        const patch = JSON.stringify({ mappingDismissed: dismissed });
        const [row] = await withDbAttribution("serviceDesk:dismissMapping", async () => {
          const db = getDb();
          return db
            .insert(sdTicketMapping)
            .values({ clickupTaskId: taskId, nts: { mappingDismissed: dismissed } })
            .onConflictDoUpdate({
              target: sdTicketMapping.clickupTaskId,
              set: {
                nts: sql`COALESCE(${sdTicketMapping.nts}, '{}'::jsonb) || ${patch}::jsonb`,
                updatedAt: new Date(),
              },
            })
            .returning();
        });
        await withDbAttribution("serviceDesk:dismissMapping:event", async () => {
          const db = getDb();
          await db.insert(sdTicketEvents).values({
            clickupTaskId: taskId,
            eventType: dismissed ? "mapping_dismissed" : "mapping_restored",
            actorUserId: actorUserId || undefined,
            data: { dismissed },
          } as any);
        });
        res.json({ mapping: row });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Ticket events read ────────────────────────────────────────────────────

  app.get("/api/service-desk/tickets/:taskId/events", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const events = await withDbAttribution("serviceDesk:getEvents", async () => {
        const db = getDb();
        return db
          .select()
          .from(sdTicketEvents)
          .where(eq(sdTicketEvents.clickupTaskId, taskId))
          .orderBy(asc(sdTicketEvents.createdAt));
      });
      res.json({ events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
