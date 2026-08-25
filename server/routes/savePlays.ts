/**
 * Task #3696 — Save-play tracker for at-risk clients.
 *
 * A "save play" is an accountable intervention on a client: title, why,
 * assigned owner, due date, notes; status flows active → completed |
 * abandoned with an outcome note. Plays can be pre-filled from a daily
 * judgment's recommended action (source_judgment_id).
 *
 * Per-client CRUD — /api/clients/:clientId/save-plays[...]. Access mirrors
 * the daily-judgment routes in server/routes/agents.ts: any user whose
 * legacy role is account_manager+ OR the client's owner. Assigned owner and
 * (when provided) source judgment are validated explicitly so a bad id is a
 * 400, never an FK 500.
 *
 * Cross-client rollup — GET /api/churn/save-plays. Director-gated with the
 * same STRICT gate as the churn leaderboard (canAccessChurnCommandCenter:
 * no permissive-mode opening; below-director gets 403 in all modes).
 * Returns:
 *   - riskyClients: every active (non-archived, non-demo) client whose
 *     LATEST daily judgment is At Risk/Critical, with activePlayCount /
 *     hasActivePlay so the UI can highlight risky clients nobody is saving.
 *     Uncovered clients sort first (Critical before At Risk, then risk
 *     score desc).
 *   - plays: every save play on a non-demo client — archived clients stay
 *     listed (clientArchived=true) so the director can review what was
 *     tried on a client that later churned. Each play carries the client
 *     name, assignee display name, the client's current judgment status,
 *     and a server-derived `overdue` flag (active AND due_date <
 *     CURRENT_DATE — one clock, the DB's, decides).
 *
 * Runs on the request-scoped API pool `db` for the rollup aggregation
 * (same as server/routes/churn.ts); CRUD goes through storage.
 */
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { canAccessChurnCommandCenter } from "../auth/permissions";
import { hasRole } from "./middleware";
import { savePlayStatusOptions, type ClientSavePlay , type UpdateClientSavePlay } from "@shared/schema";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const createSavePlaySchema = z.object({
  title: z.string().trim().min(1, "title is required").max(300),
  why: z.string().trim().max(4000).nullish(),
  sourceJudgmentId: z.string().trim().min(1).nullish(),
  assignedToUserId: z.string().trim().min(1, "assignedToUserId is required"),
  dueDate: z.string().regex(DATE_RE, "dueDate must be YYYY-MM-DD"),
  notes: z.string().trim().max(8000).nullish(),
}).strict();

const updateSavePlaySchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  why: z.string().trim().max(4000).nullable().optional(),
  assignedToUserId: z.string().trim().min(1).optional(),
  dueDate: z.string().regex(DATE_RE, "dueDate must be YYYY-MM-DD").optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  status: z.enum(savePlayStatusOptions).optional(),
  outcomeNote: z.string().trim().max(4000).nullable().optional(),
}).strict();

export function registerSavePlayRoutes(app: Express) {
  // Shared per-client access check (mirrors the daily-judgment routes):
  // 404 for a missing client, 403 unless account_manager+ role or owner.
  // Returns null after writing the response when access is denied.
  async function authorizeClientAccess(req: any, res: any): Promise<{ clientId: string; userId: string } | null> {
    const clientId = req.params.clientId as string;
    const client = await storage.getClient(clientId);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return null;
    }
    const userId = req.user?.claims?.sub as string;
    const user = await storage.getUser(userId);
    if (!hasRole(user?.role, "account_manager") && client.ownerId !== userId) {
      res.status(403).json({ error: "Access denied" });
      return null;
    }
    return { clientId, userId };
  }

  async function validateAssignee(assignedToUserId: string, res: any): Promise<boolean> {
    const assignee = await storage.getUser(assignedToUserId);
    if (!assignee) {
      res.status(400).json({ error: "Assigned owner not found" });
      return false;
    }
    return true;
  }

  app.get("/api/clients/:clientId/save-plays", isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await authorizeClientAccess(req, res);
      if (!ctx) return;
      const filters: { status?: string } = {};
      if (typeof req.query.status === "string" && req.query.status) filters.status = req.query.status;
      const plays = await storage.listClientSavePlays(ctx.clientId, filters);
      res.json(plays);
    } catch (error) {
      console.error("Error listing save plays:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/save-plays/:playId", isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await authorizeClientAccess(req, res);
      if (!ctx) return;
      const play = await storage.getClientSavePlay(req.params.playId);
      if (!play || play.clientId !== ctx.clientId) {
        return res.status(404).json({ error: "Save play not found" });
      }
      res.json(play);
    } catch (error) {
      console.error("Error fetching save play:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/save-plays", isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await authorizeClientAccess(req, res);
      if (!ctx) return;

      const parsed = createSavePlaySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid save play" });
      }
      const body = parsed.data;

      if (!(await validateAssignee(body.assignedToUserId, res))) return;

      if (body.sourceJudgmentId) {
        const judgment = await storage.getClientDailyJudgment(body.sourceJudgmentId);
        if (!judgment || judgment.clientId !== ctx.clientId) {
          return res.status(400).json({ error: "Source judgment does not belong to this client" });
        }
      }

      const play = await storage.createClientSavePlay({
        clientId: ctx.clientId,
        title: body.title,
        why: body.why ?? null,
        sourceJudgmentId: body.sourceJudgmentId ?? null,
        assignedToUserId: body.assignedToUserId,
        dueDate: body.dueDate,
        notes: body.notes ?? null,
        status: "active",
        createdByUserId: ctx.userId,
      });
      res.status(201).json(play);
    } catch (error) {
      console.error("Error creating save play:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/save-plays/:playId", isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await authorizeClientAccess(req, res);
      if (!ctx) return;

      const play = await storage.getClientSavePlay(req.params.playId);
      if (!play || play.clientId !== ctx.clientId) {
        return res.status(404).json({ error: "Save play not found" });
      }

      const parsed = updateSavePlaySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid update" });
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        return res.status(400).json({ error: "Empty update" });
      }

      if (body.assignedToUserId && !(await validateAssignee(body.assignedToUserId, res))) return;

      const patch: UpdateClientSavePlay = { ...body };

      // Status transitions stamp/clear closure metadata. Reactivating a
      // closed play clears closed_at/closed_by (the outcome note is kept
      // unless the caller explicitly rewrites it).
      if (body.status && body.status !== play.status) {
        if (body.status === "active") {
          patch.closedAt = null;
          patch.closedByUserId = null;
        } else {
          patch.closedAt = new Date();
          patch.closedByUserId = ctx.userId;
        }
      }

      const updated = await storage.updateClientSavePlay(play.id, patch);
      res.json(updated);
    } catch (error) {
      console.error("Error updating save play:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.delete("/api/clients/:clientId/save-plays/:playId", isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await authorizeClientAccess(req, res);
      if (!ctx) return;
      const play = await storage.getClientSavePlay(req.params.playId);
      if (!play || play.clientId !== ctx.clientId) {
        return res.status(404).json({ error: "Save play not found" });
      }
      await storage.deleteClientSavePlay(play.id);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting save play:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── Director-gated cross-client rollup ─────────────────────────────────
  app.get("/api/churn/save-plays", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      // Risky-client coverage: latest judgment per client (judgment_date is
      // a 'YYYY-MM-DD' varchar, so lexicographic DESC is chronological
      // DESC — same CTE as the churn leaderboard), restricted to active
      // clients whose latest status is At Risk/Critical, with the count of
      // their ACTIVE save plays. Uncovered clients sort first.
      const coverageResult = await db.execute(sql`
        WITH latest_judgment AS (
          SELECT DISTINCT ON (j.client_id)
                 j.client_id, j.status, j.risk_score, j.judgment_date
          FROM client_daily_judgments j
          ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
        ),
        active_plays AS (
          SELECT p.client_id, COUNT(*)::int AS active_count
          FROM client_save_plays p
          WHERE p.status = 'active'
          GROUP BY p.client_id
        )
        SELECT c.id, c.firm_name, c.client_code, c.owner_id,
               u.first_name AS owner_first_name,
               u.last_name  AS owner_last_name,
               u.email      AS owner_email,
               l.status, l.risk_score, l.judgment_date,
               COALESCE(ap.active_count, 0) AS active_play_count
        FROM clients c
        JOIN latest_judgment l ON l.client_id = c.id
        LEFT JOIN users u ON u.id = c.owner_id
        LEFT JOIN active_plays ap ON ap.client_id = c.id
        WHERE COALESCE(c.is_archived, false) = false
          AND COALESCE(c.is_demo, false) = false
          AND l.status IN ('At Risk', 'Critical')
        ORDER BY (COALESCE(ap.active_count, 0) > 0),
                 CASE l.status WHEN 'Critical' THEN 0 ELSE 1 END,
                 l.risk_score DESC NULLS LAST,
                 c.firm_name ASC
      `);

      // All plays (history included). Demo clients are excluded outright;
      // archived clients stay so closed plays remain reviewable after a
      // client churns — flagged clientArchived for the UI.
      const playsResult = await db.execute(sql`
        WITH latest_judgment AS (
          SELECT DISTINCT ON (j.client_id)
                 j.client_id, j.status
          FROM client_daily_judgments j
          ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
        )
        SELECT p.id, p.client_id, p.title, p.why, p.source_judgment_id,
               p.assigned_to_user_id, p.due_date::text AS due_date,
               p.status, p.notes, p.outcome_note,
               p.created_by_user_id, p.closed_at, p.closed_by_user_id,
               p.created_at, p.updated_at,
               c.firm_name, c.client_code,
               COALESCE(c.is_archived, false) AS client_archived,
               au.first_name AS assignee_first_name,
               au.last_name  AS assignee_last_name,
               au.email      AS assignee_email,
               l.status AS client_judgment_status,
               (p.status = 'active' AND p.due_date < CURRENT_DATE) AS overdue,
               CURRENT_DATE::text AS today
        FROM client_save_plays p
        JOIN clients c ON c.id = p.client_id
        LEFT JOIN users au ON au.id = p.assigned_to_user_id
        LEFT JOIN latest_judgment l ON l.client_id = p.client_id
        WHERE COALESCE(c.is_demo, false) = false
        ORDER BY (p.status <> 'active'),
                 (p.status = 'active' AND p.due_date < CURRENT_DATE) DESC,
                 p.due_date ASC,
                 p.created_at DESC
      `);

      const coverageRows: any[] = (coverageResult as any).rows ?? [];
      const playRows: any[] = (playsResult as any).rows ?? [];

      const displayName = (first: unknown, last: unknown, email: unknown): string | null =>
        [first, last].filter(Boolean).join(" ") || (email as string | null) || null;

      const riskyClients = coverageRows.map((r: any) => ({
        clientId: r.id as string,
        firmName: r.firm_name as string,
        clientCode: (r.client_code ?? null) as string | null,
        ownerId: (r.owner_id ?? null) as string | null,
        ownerName: displayName(r.owner_first_name, r.owner_last_name, r.owner_email),
        status: r.status as string,
        riskScore: r.risk_score === null || r.risk_score === undefined ? null : Number(r.risk_score),
        judgmentDate: r.judgment_date as string,
        activePlayCount: Number(r.active_play_count ?? 0),
        hasActivePlay: Number(r.active_play_count ?? 0) > 0,
      }));

      const plays = playRows.map((r: any) => ({
        id: r.id as string,
        clientId: r.client_id as string,
        firmName: r.firm_name as string,
        clientCode: (r.client_code ?? null) as string | null,
        clientArchived: Boolean(r.client_archived),
        clientJudgmentStatus: (r.client_judgment_status ?? null) as string | null,
        title: r.title as string,
        why: (r.why ?? null) as string | null,
        sourceJudgmentId: (r.source_judgment_id ?? null) as string | null,
        assignedToUserId: (r.assigned_to_user_id ?? null) as string | null,
        assignedToName: displayName(r.assignee_first_name, r.assignee_last_name, r.assignee_email),
        dueDate: r.due_date as string,
        status: r.status as string,
        notes: (r.notes ?? null) as string | null,
        outcomeNote: (r.outcome_note ?? null) as string | null,
        createdByUserId: (r.created_by_user_id ?? null) as string | null,
        closedAt: r.closed_at ?? null,
        closedByUserId: (r.closed_by_user_id ?? null) as string | null,
        createdAt: r.created_at ?? null,
        overdue: Boolean(r.overdue),
      }));

      res.json({
        riskyClients,
        plays,
        today: (playRows[0]?.today as string | undefined) ?? new Date().toISOString().slice(0, 10),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[SavePlays] Failed to build rollup:", error);
      res.status(500).json({ error: "Server error" });
    }
  });
}
