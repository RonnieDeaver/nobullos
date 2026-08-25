// @db-pool-intent: api
/**
 * Task #2927 / Epic 4 — ClickUp in-app module routes.
 *
 * Mounted prefix: /api/clickup (authenticated unless noted).
 *
 * OAuth flow (per-user):
 *   GET  /api/integrations/clickup/authorize   → redirect to ClickUp OAuth
 *   GET  /api/integrations/clickup/callback    → exchange code, store token
 *   POST /api/integrations/clickup/disconnect  → remove user token
 *   GET  /api/integrations/clickup/status      → connection status for current user
 *
 * Data routes (read from mirror where possible; writes go to ClickUp + update mirror):
 *   GET  /api/clickup/workspaces
 *   GET  /api/clickup/workspaces/:workspaceId/spaces
 *   GET  /api/clickup/workspaces/:workspaceId/hierarchy  (spaces+folders+lists tree)
 *   GET  /api/clickup/workspaces/:workspaceId/search     (task search by query)
 *   GET  /api/clickup/lists/:listId/tasks
 *   GET  /api/clickup/tasks/:taskId
 *   POST /api/clickup/lists/:listId/tasks
 *   PUT  /api/clickup/tasks/:taskId
 *   DELETE /api/clickup/tasks/:taskId
 *   GET  /api/clickup/tasks/:taskId/comments
 *   POST /api/clickup/tasks/:taskId/comments
 *   PUT  /api/clickup/comments/:commentId
 *   DELETE /api/clickup/comments/:commentId
 *   POST /api/clickup/tasks/:taskId/checklists
 *   PUT  /api/clickup/checklists/:checklistId/items/:itemId
 *   GET  /api/clickup/tasks/:taskId/attachments           (list via v3)
 *   POST /api/clickup/tasks/:taskId/attachments          (upload relay — credentials never reach browser)
 *   GET  /api/clickup/attachments/proxy                  (proxy-stream by URL, SSRF-guarded)
 *   POST /api/clickup/entity/:entityId/attachments       (upload to CF entity via v3)
 *   DELETE /api/clickup/tasks/:taskId/attachments/:id   (delete via v2)
 *   GET  /api/clickup/workspaces/:workspaceId/time-entries        (start_date/end_date/assignee/space_id/folder_id/list_id/task_id/tags)
 *   POST /api/clickup/workspaces/:workspaceId/time-entries
 *   PUT  /api/clickup/workspaces/:workspaceId/time-entries/:entryId
 *   DELETE /api/clickup/workspaces/:workspaceId/time-entries/:entryId
 *   GET  /api/clickup/workspaces/:workspaceId/time-entries/:entryId/history
 *   GET  /api/clickup/workspaces/:workspaceId/time-entry-tags
 *   POST /api/clickup/workspaces/:workspaceId/time-entries/:entryId/tags
 *   DELETE /api/clickup/workspaces/:workspaceId/time-entries/:entryId/tags
 *   PUT  /api/clickup/workspaces/:workspaceId/time-entry-tags/rename
 *   POST /api/clickup/workspaces/:workspaceId/timer/start
 *   POST /api/clickup/workspaces/:workspaceId/timer/stop
 *   GET  /api/clickup/workspaces/:workspaceId/timer/current
 *   PUT  /api/clickup/tasks/:taskId/time-estimates/user/:userId   (Business plan+; plan_limited notice on 403)
 *   GET  /api/clickup/tasks/:taskId/time-in-status
 *   GET  /api/clickup/workspaces/:workspaceId/tasks/time-in-status?task_ids=id1,id2
 *   GET    /api/clickup/workspaces/:workspaceId/goals
 *   POST   /api/clickup/workspaces/:workspaceId/goals
 *   GET    /api/clickup/goals/:goalId
 *   PUT    /api/clickup/goals/:goalId
 *   DELETE /api/clickup/goals/:goalId
 *   POST   /api/clickup/goals/:goalId/key-results
 *   PUT    /api/clickup/goals/:goalId/key-results/:krId
 *   DELETE /api/clickup/goals/:goalId/key-results/:krId
 *   GET  /api/clickup/workspaces/:workspaceId/docs
 *   GET  /api/clickup/workspaces/:workspaceId/docs/:docId/pages
 *   GET  /api/clickup/workspaces/:workspaceId/docs/:docId/pages/:pageId
 *   PUT  /api/clickup/workspaces/:workspaceId/docs/:docId/pages/:pageId
 *   GET  /api/clickup/spaces/:spaceId/tags
 *   POST /api/clickup/spaces/:spaceId/tags
 *   PUT  /api/clickup/spaces/:spaceId/tags/:tagName
 *   DELETE /api/clickup/spaces/:spaceId/tags/:tagName
 *   POST /api/clickup/tasks/:taskId/tags/:tagName
 *   DELETE /api/clickup/tasks/:taskId/tags/:tagName
 *   GET  /api/clickup/workspaces/:workspaceId/webhooks   (admin)
 *   POST /api/clickup/workspaces/:workspaceId/webhooks   (admin)
 *   DELETE /api/clickup/webhooks/:webhookId             (admin)
 *
 * Task relationship routes (Epic 4/16):
 *   POST   /api/clickup/tasks/:taskId/dependencies       (add dep: body {depends_on} or {dependency_of})
 *   DELETE /api/clickup/tasks/:taskId/dependencies       (remove dep: body {depends_on} or {dependency_of})
 *   POST   /api/clickup/tasks/:taskId/links/:linksTo     (add task link)
 *   DELETE /api/clickup/tasks/:taskId/links/:linksTo     (remove task link)
 *   POST   /api/clickup/tasks/:taskId/merge              (merge source tasks into target; body {task_ids})
 *   POST   /api/clickup/tasks/:taskId/watchers           (add watchers; body {add:[userId,…]})
 *   DELETE /api/clickup/tasks/:taskId/watchers/:userId   (remove a watcher)
 *
 * Move + Tasks in Multiple Lists (Epic 5/16):
 *   POST   /api/clickup/tasks/:taskId/move               (move home list; body {listId})
 *   POST   /api/clickup/tasks/:taskId/lists/:listId      (add task to additional list — TIML ClickApp required)
 *   DELETE /api/clickup/tasks/:taskId/lists/:listId      (remove task from additional list — cannot be home list)
 *
 * Webhook receiver:
 *   POST /api/webhooks/clickup                          (unauthenticated; HMAC-verified)
 *
 * Backfill trigger:
 *   POST /api/clickup/workspaces/:workspaceId/sync      (admin)
 */

import type { Express, Request, Response, NextFunction } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "./middleware";
import { toVoidRequestHandler } from "../lib/voidRequestHandler";
import { registerClickUpCompanyTokenRoutes } from "./clickupCompanyToken";
import * as clickUpIntegration from "../services/clickUpIntegration";
import * as cu from "../services/clickUpClient";
import { invalidateIntegrationStatus } from "../services/integrationStatusCache";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";
import { getDb, withDbAttribution } from "../db";
import { getClickUpUserId } from "../utils/clickupAuth";
import {
  clickupUserTokens,
  clickupWebhooks,
  clickupTasks,
  clickupWorkspaces,
  clickupSpaces,
  clickupFolders,
  clickupLists,
  clickupCustomFields,
  clickupComments,
  clickupChecklists,
  clickupTimeEntries,
  clickupGoals,
  clickupDocs,
  clickupFilterPresets,
} from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { enqueueJob } from "../services/workScheduler";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

async function requireClickUpToken(
  req: Request & { user?: any },
  res: Response,
): Promise<string | null> {
  const userId = getClickUpUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const token = await clickUpIntegration.getAccessToken(userId);
  if (!token) {
    res.status(403).json({ error: "ClickUp not connected. Visit your Profile page to connect." });
    return null;
  }
  return token;
}

export function registerClickUpRoutes(app: Express): void {

  // Task #3662 — Ads OS COMPANY token admin surface (status / test / rotate /
  // clear). Separate module so its hermetic route tests stay import-light.
  registerClickUpCompanyTokenRoutes(app, {
    isAuthenticated,
    // Wrap the Promise-returning role middleware in void-returning RequestHandlers
    // so no-misused-promises is satisfied; rejections route to Express error handling.
    requireRead: toVoidRequestHandler(requireAccountManager),
    requireWrite: toVoidRequestHandler(requireTeamLead),
  });

  // ─── OAuth ─────────────────────────────────────────────────────────────────

  app.get(
    "/api/integrations/clickup/authorize",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = getClickUpUserId(req);
        if (!userId) return res.status(401).json({ error: "Not authenticated" });
        if (!clickUpIntegration.isClickUpOAuthConfigured()) {
          return res.status(503).json({
            error: "ClickUp OAuth not configured. Add CLICKUP_CLIENT_ID and CLICKUP_CLIENT_SECRET in Secrets.",
          });
        }
        const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : undefined;
        const allowedReturnPaths = ["/profile", "/admin/integrations", "/admin/clickup"];
        const safeReturnTo = returnTo && allowedReturnPaths.some((p) => returnTo.startsWith(p)) ? returnTo : undefined;
        const url = await clickUpIntegration.getAuthorizationUrl(userId, safeReturnTo);
        const effectiveRedirectUri = clickUpIntegration.getRedirectUri();
        console.log(`[ClickUp] authorize: redirect_uri=${effectiveRedirectUri} user=${userId}`);
        res.json({ url });
      } catch (err: any) {
        console.error("[ClickUp] authorize error:", err?.message || err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get("/api/integrations/clickup/callback", async (req: any, res) => {
    let returnTo: string | undefined;
    try {
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (!code) return res.status(400).send("Missing code");

      let userId: string | undefined;
      if (state) {
        const v = await clickUpIntegration.validateOAuthState(state);
        if (v.valid && v.userId) {
          userId = v.userId;
          returnTo = v.returnTo;
        }
      }
      if (!userId && req.session?.passport?.user) userId = req.session.passport.user;
      if (!userId) return res.status(400).send("Cannot determine user from callback state");

      await clickUpIntegration.exchangeCodeForToken(userId, code);
      await invalidateIntegrationStatus("clickup");
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const host = req.get("host");
      const destination = returnTo ?? "/admin/integrations";
      const sep = destination.includes("?") ? "&" : "?";
      res.redirect(`${proto}://${host}${destination}${sep}clickup=connected`);
    } catch (err: any) {
      console.error("[ClickUp] callback error:", err?.message || err);
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const destination = returnTo ?? "/admin/integrations";
      const sep = destination.includes("?") ? "&" : "?";
      res.redirect(`${proto}://${req.get("host")}${destination}${sep}clickup=error`);
    }
  });

  app.post(
    "/api/integrations/clickup/disconnect",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = getClickUpUserId(req);
        if (!userId) return res.status(401).json({ error: "Not authenticated" });
        await clickUpIntegration.disconnect(userId);
        await invalidateIntegrationStatus("clickup");
        res.json({ success: true });
      } catch (err: any) {
        console.error("[ClickUp] disconnect error:", err?.message || err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/integrations/clickup/status",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = getClickUpUserId(req);
        if (!userId) return res.status(401).json({ error: "Not authenticated" });
        const status = await clickUpIntegration.getStatus(userId);
        res.json(status);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Task #3122 — admin roster of which team members have connected ClickUp.
  // Metadata only (names/emails/status), never tokens. Works regardless of
  // whether the calling admin has their own ClickUp token.
  app.get(
    "/api/integrations/clickup/connected-users",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const result = await clickUpIntegration.getAllConnectedUsers();
        let redirectUri: string | null = null;
        try {
          redirectUri = clickUpIntegration.getRedirectUri();
        } catch {
          redirectUri = null;
        }
        res.json({
          ...result,
          oauthConfigured: clickUpIntegration.isClickUpOAuthConfigured(),
          redirectUri,
        });
      } catch (err: any) {
        console.error("[ClickUp] connected-users error:", err?.message || err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Workspaces & hierarchy ────────────────────────────────────────────────

  app.get("/api/clickup/workspaces", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const workspaces = await cu.getWorkspaces(token);
      res.json({ workspaces });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(
    "/api/clickup/workspaces/:workspaceId/hierarchy",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { workspaceId } = req.params;
        const spaces = await cu.getSpaces(token, workspaceId);
        const hierarchy = await Promise.all(
          spaces.map(async (space: any) => {
            const [folders, folderlesLists] = await Promise.all([
              cu.getFolders(token, space.id),
              cu.getListsInSpace(token, space.id),
            ]);
            const foldersWithLists = await Promise.all(
              folders.map(async (folder: any) => ({
                ...folder,
                lists: await cu.getListsInFolder(token, folder.id),
              })),
            );
            return { ...space, folders: foldersWithLists, lists: folderlesLists };
          }),
        );
        res.json({ hierarchy });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Spaces (individual GET + write) ──────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/spaces",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const spaces = await cu.getSpaces(token, req.params.workspaceId);
        res.json({ spaces });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/spaces",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { workspaceId } = req.params;
        const space = await cu.createSpace(token, workspaceId, req.body);
        // Mirror
        if (space?.id) {
          await withDbAttribution("clickup:createSpace:mirror", async () => {
            const db = getDb();
            await db.insert(clickupSpaces).values({
              id: String(space.id),
              workspaceId,
              name: space.name ?? req.body.name,
              color: space.color ?? null,
              private: !!space.private,
              statuses: space.statuses ?? null,
              features: space.features ?? null,
              archived: false,
              syncedAt: new Date(),
              updatedAt: new Date(),
            }).onConflictDoUpdate({
              target: clickupSpaces.id,
              set: {
                name: space.name ?? req.body.name,
                color: space.color ?? null,
                features: space.features ?? null,
                syncedAt: new Date(),
                updatedAt: new Date(),
              },
            });
          });
        }
        res.json({ space });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put("/api/clickup/spaces/:spaceId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { spaceId } = req.params;
      const space = await cu.updateSpace(token, spaceId, req.body);
      // Mirror
      await withDbAttribution("clickup:updateSpace:mirror", async () => {
        const db = getDb();
        const upd: Record<string, any> = { syncedAt: new Date(), updatedAt: new Date() };
        if (req.body.name != null) upd.name = req.body.name;
        if (req.body.color !== undefined) upd.color = req.body.color;
        if (req.body.features != null) upd.features = req.body.features;
        await db.update(clickupSpaces).set(upd).where(eq(clickupSpaces.id, spaceId));
      });
      res.json({ space });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/spaces/:spaceId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { spaceId } = req.params;
      await cu.deleteSpace(token, spaceId);
      // Remove from mirror
      await withDbAttribution("clickup:deleteSpace:mirror", async () => {
        const db = getDb();
        await db.delete(clickupSpaces).where(eq(clickupSpaces.id, spaceId));
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Folders (individual GET + write) ─────────────────────────────────────

  app.get("/api/clickup/spaces/:spaceId/folders", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const folders = await cu.getFolders(token, req.params.spaceId);
      res.json({ folders });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/spaces/:spaceId/folders", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { spaceId } = req.params;
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      const folder = await cu.createFolder(token, spaceId, name.trim());
      // Mirror
      if (folder?.id) {
        await withDbAttribution("clickup:createFolder:mirror", async () => {
          const db = getDb();
          await db.insert(clickupFolders).values({
            id: String(folder.id),
            spaceId,
            name: folder.name ?? name.trim(),
            orderIndex: folder.orderindex ?? null,
            override_statuses: folder.override_statuses ?? null,
            hidden: !!folder.hidden,
            archived: false,
            syncedAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: clickupFolders.id,
            set: {
              name: folder.name ?? name.trim(),
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        });
      }
      res.json({ folder });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/clickup/folders/:folderId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { folderId } = req.params;
      const folder = await cu.updateFolder(token, folderId, req.body);
      // Mirror
      await withDbAttribution("clickup:updateFolder:mirror", async () => {
        const db = getDb();
        const upd: Record<string, any> = { syncedAt: new Date(), updatedAt: new Date() };
        if (req.body.name != null) upd.name = req.body.name;
        await db.update(clickupFolders).set(upd).where(eq(clickupFolders.id, folderId));
      });
      res.json({ folder });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/folders/:folderId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { folderId } = req.params;
      await cu.deleteFolder(token, folderId);
      await withDbAttribution("clickup:deleteFolder:mirror", async () => {
        const db = getDb();
        await db.delete(clickupFolders).where(eq(clickupFolders.id, folderId));
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Lists (individual GET + write) ───────────────────────────────────────

  app.get("/api/clickup/spaces/:spaceId/lists", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const lists = await cu.getListsInSpace(token, req.params.spaceId);
      res.json({ lists });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/folders/:folderId/lists", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const lists = await cu.getListsInFolder(token, req.params.folderId);
      res.json({ lists });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/spaces/:spaceId/lists", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { spaceId } = req.params;
      const { name, ...rest } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      const list = await cu.createFolderlessList(token, spaceId, { name: name.trim(), ...rest });
      if (list?.id) {
        await withDbAttribution("clickup:createFolderlessList:mirror", async () => {
          const db = getDb();
          await db.insert(clickupLists).values({
            id: String(list.id),
            spaceId,
            folderId: null,
            name: list.name ?? name.trim(),
            content: list.content ?? null,
            status: list.status?.status ?? null,
            priority: list.priority?.id != null ? Number(list.priority.id) : null,
            taskCount: null,
            archived: false,
            syncedAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: clickupLists.id,
            set: { name: list.name ?? name.trim(), syncedAt: new Date(), updatedAt: new Date() },
          });
        });
      }
      res.json({ list });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/folders/:folderId/lists", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { folderId } = req.params;
      const { name, spaceId, ...rest } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      const list = await cu.createListInFolder(token, folderId, { name: name.trim(), ...rest });
      if (list?.id) {
        await withDbAttribution("clickup:createListInFolder:mirror", async () => {
          const db = getDb();
          await db.insert(clickupLists).values({
            id: String(list.id),
            spaceId: spaceId ? String(spaceId) : list.space?.id ? String(list.space.id) : "",
            folderId,
            name: list.name ?? name.trim(),
            content: list.content ?? null,
            status: list.status?.status ?? null,
            priority: list.priority?.id != null ? Number(list.priority.id) : null,
            taskCount: null,
            archived: false,
            syncedAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: clickupLists.id,
            set: { name: list.name ?? name.trim(), syncedAt: new Date(), updatedAt: new Date() },
          });
        });
      }
      res.json({ list });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/clickup/lists/:listId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { listId } = req.params;
      const list = await cu.updateList(token, listId, req.body);
      // Mirror
      await withDbAttribution("clickup:updateList:mirror", async () => {
        const db = getDb();
        const upd: Record<string, any> = { syncedAt: new Date(), updatedAt: new Date() };
        if (req.body.name != null) upd.name = req.body.name;
        if (req.body.content !== undefined) upd.content = req.body.content;
        if (req.body.priority !== undefined) upd.priority = req.body.priority;
        if (req.body.due_date !== undefined) upd.dueDate = req.body.due_date != null ? String(req.body.due_date) : null;
        await db.update(clickupLists).set(upd).where(eq(clickupLists.id, listId));
      });
      res.json({ list });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/lists/:listId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { listId } = req.params;
      await cu.deleteList(token, listId);
      await withDbAttribution("clickup:deleteList:mirror", async () => {
        const db = getDb();
        await db.delete(clickupLists).where(eq(clickupLists.id, listId));
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Lists ────────────────────────────────────────────────────────────────

  app.get("/api/clickup/lists/:listId/custom-fields", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const fields = await cu.getCustomFields(token, req.params.listId);
      res.json({ fields });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Tasks ────────────────────────────────────────────────────────────────

  app.get("/api/clickup/lists/:listId/tasks", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { listId } = req.params;
      const page = parseInt(String(req.query.page || "0"), 10);
      const subtasks = req.query.subtasks === "true";
      const statuses = req.query.statuses ? String(req.query.statuses).split(",") : undefined;
      const assignees = req.query.assignees ? String(req.query.assignees).split(",") : undefined;
      const tags = req.query.tags ? String(req.query.tags).split(",") : undefined;
      const includeTiml = req.query.include_timl === "true";
      const result = await cu.getTasksInList(token, listId, {
        page,
        subtasks,
        statuses,
        assignees,
        tags,
        includeMarkdownDescription: true,
        includeTiml,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/tasks/:taskId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const task = await cu.getTask(token, req.params.taskId);
      res.json({ task });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/lists/:listId/tasks", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const task = await cu.createTask(token, req.params.listId, req.body);
      res.json({ task });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/clickup/tasks/:taskId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const task = await cu.updateTask(token, req.params.taskId, req.body);
      res.json({ task });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/tasks/:taskId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      await cu.deleteTask(token, req.params.taskId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/clickup/tasks/:taskId/fields/:fieldId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.setCustomFieldValue(token, req.params.taskId, req.params.fieldId, req.body.value);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Remove (clear) a custom field value from a task.
   * DELETE /api/v2/task/{task_id}/field/{field_id}
   */
  app.delete(
    "/api/clickup/tasks/:taskId/fields/:fieldId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.removeCustomFieldValue(token, req.params.taskId, req.params.fieldId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Get custom task types (custom items) for a workspace.
   * GET /api/v2/team/{team_id}/custom_item
   */
  app.get(
    "/api/clickup/workspaces/:workspaceId/custom-item-types",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const types = await cu.getCustomTaskTypes(token, req.params.workspaceId);
        res.json({ types });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Get accessible custom fields for a folder.
   * GET /api/v2/folder/{folder_id}/field
   */
  app.get(
    "/api/clickup/folders/:folderId/custom-fields",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const fields = await cu.getCustomFieldsForFolder(token, req.params.folderId);
        res.json({ fields });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Get accessible custom fields for a space.
   * GET /api/v2/space/{space_id}/field
   */
  app.get(
    "/api/clickup/spaces/:spaceId/custom-fields",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const fields = await cu.getCustomFieldsForSpace(token, req.params.spaceId);
        res.json({ fields });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Get accessible custom fields for a workspace (team).
   * GET /api/v2/team/{team_id}/field
   */
  app.get(
    "/api/clickup/workspaces/:workspaceId/custom-fields",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const fields = await cu.getCustomFieldsForWorkspace(token, req.params.workspaceId);
        res.json({ fields });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Checklists ───────────────────────────────────────────────────────────

  app.post("/api/clickup/tasks/:taskId/checklists", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const result = await cu.createChecklist(token, req.params.taskId, req.body.name);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/clickup/checklists/:checklistId/items",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.createChecklistItem(token, req.params.checklistId, req.body);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/clickup/checklists/:checklistId/items/:itemId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.updateChecklistItem(
          token,
          req.params.checklistId,
          req.params.itemId,
          req.body,
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/checklists/:checklistId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.deleteChecklist(token, req.params.checklistId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Comments ─────────────────────────────────────────────────────────────
  //
  // Task comments — paginated (newest→oldest, 25/page):
  //   GET  /api/clickup/tasks/:taskId/comments?start=<epoch-ms>&start_id=<id>
  //   POST /api/clickup/tasks/:taskId/comments
  //
  // Threaded replies (parent comment NOT included in GET response):
  //   GET  /api/clickup/comments/:commentId/replies
  //   POST /api/clickup/comments/:commentId/replies
  //
  // Update / delete:
  //   PUT    /api/clickup/comments/:commentId   (content, assignee, resolved)
  //   DELETE /api/clickup/comments/:commentId
  //
  // List-level comments (same start/start_id pagination):
  //   GET  /api/clickup/lists/:listId/comments?start=<epoch-ms>&start_id=<id>
  //   POST /api/clickup/lists/:listId/comments

  app.get("/api/clickup/tasks/:taskId/comments", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const start = req.query.start ? Number(req.query.start) : undefined;
      const start_id = req.query.start_id ? String(req.query.start_id) : undefined;
      const result = await cu.getTaskComments(token, req.params.taskId, { start, start_id });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/tasks/:taskId/comments", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const result = await cu.createTaskComment(token, req.params.taskId, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/comments/:commentId/replies", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const comments = await cu.getThreadedComments(token, req.params.commentId);
      res.json({ comments });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/comments/:commentId/replies", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const result = await cu.createThreadedComment(token, req.params.commentId, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/clickup/comments/:commentId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      await cu.updateComment(token, req.params.commentId, req.body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/comments/:commentId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      await cu.deleteComment(token, req.params.commentId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/lists/:listId/comments", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const start = req.query.start ? Number(req.query.start) : undefined;
      const start_id = req.query.start_id ? String(req.query.start_id) : undefined;
      const result = await cu.getListComments(token, req.params.listId, { start, start_id });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/lists/:listId/comments", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const result = await cu.createListComment(token, req.params.listId, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Attachments (relay — credentials never reach browser) ───────────────
  //
  // Routes:
  //   GET  /api/clickup/tasks/:taskId/attachments          list (v3)
  //   POST /api/clickup/tasks/:taskId/attachments          upload to task (v3)
  //   GET  /api/clickup/attachments/proxy                  stream by URL (SSRF-guarded)
  //   POST /api/clickup/entity/:entityId/attachments       upload to CF entity (v3)
  //   DELETE /api/clickup/tasks/:taskId/attachments/:id    delete (v2)

  app.get(
    "/api/clickup/tasks/:taskId/attachments",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const attachments = await cu.listTaskAttachments(token, req.params.taskId);
        res.json({ attachments });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/tasks/:taskId/attachments",
    isAuthenticated,
    upload.single("file"),
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        const result = await cu.uploadAttachment(
          token,
          req.params.taskId,
          req.file.originalname,
          req.file.buffer,
          req.file.mimetype,
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Proxy-stream a ClickUp attachment through the server so credentials never
   * reach the browser.  The `url` query param must be a ClickUp attachment URL;
   * the client helper validates the domain server-side (SSRF guard).
   */
  app.get(
    "/api/clickup/attachments/proxy",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const rawUrl = String(req.query.url ?? "");
        if (!rawUrl) return res.status(400).json({ error: "url query param required" });
        const upstream = await cu.fetchAttachmentForProxy(token, rawUrl);
        if (!upstream.ok) {
          return res.status(upstream.status).json({ error: "Upstream fetch failed" });
        }
        const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
        const cl = upstream.headers.get("content-length");
        const cd = upstream.headers.get("content-disposition");
        res.setHeader("Content-Type", ct);
        // Force download when the browser requests it via ?download=1
        if (req.query.download === "1") {
          const filename = String(req.query.filename ?? "attachment").replace(/[^\w.\-]/g, "_");
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        } else if (cd) {
          res.setHeader("Content-Disposition", cd);
        }
        if (cl) res.setHeader("Content-Length", cl);
        // No-cache so browsers re-validate through our auth layer
        res.setHeader("Cache-Control", "private, no-store");
        if (upstream.body) {
          const { Readable } = await import("stream");
          Readable.fromWeb(upstream.body as any).pipe(res);
        } else {
          const buf = await upstream.arrayBuffer();
          res.end(Buffer.from(buf));
        }
      } catch (err: any) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Upload to a file-type custom field entity (v3 PostEntityAttachment).
   * The caller should follow up with setCustomFieldValue to associate the file.
   * This endpoint is exposed for the custom-fields epic task to reuse.
   */
  app.post(
    "/api/clickup/entity/:entityId/attachments",
    isAuthenticated,
    upload.single("file"),
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        const result = await cu.uploadEntityAttachment(
          token,
          req.params.entityId,
          req.file.originalname,
          req.file.buffer,
          req.file.mimetype,
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Delete an attachment.  ClickUp v2 supports deletion via
   * DELETE /attachment/{attachment_id}. Returns success or a descriptive error.
   */
  app.delete(
    "/api/clickup/tasks/:taskId/attachments/:attachmentId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.deleteAttachment(token, req.params.attachmentId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Time tracking (Epic 9/16) ────────────────────────────────────────────
  //
  // Plan-gate helper: ClickUp returns 403 with body mentioning "upgrade" / "plan"
  // when a feature needs a higher plan.  Surface these as HTTP 402 so the UI can
  // render a notice instead of a generic error banner.
  function planGateError(err: any): boolean {
    return cu.isPlanLimitError(String(err?.message ?? ""));
  }
  function sendPlanLimited(res: any): void {
    res.status(402).json({
      plan_limited: true,
      message:
        "This feature requires a Business Plus or higher ClickUp plan. Upgrade at app.clickup.com/settings/billing.",
    });
  }

  /**
   * GET /api/clickup/workspaces/:workspaceId/time-entries
   *
   * Extended to pass date-range and all location/tag filters through to ClickUp.
   * The API only accepts ONE location filter at a time (space_id | folder_id |
   * list_id | task_id); priority: task_id > list_id > folder_id > space_id.
   * Date params must be epoch-milliseconds strings.
   * Assignee lookup of other users requires Business Plus plan.
   */
  app.get(
    "/api/clickup/workspaces/:workspaceId/time-entries",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const q = req.query as Record<string, string | undefined>;
        const tags = q.tags ? q.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
        const entries = await cu.getTimeEntriesRange(token, req.params.workspaceId, {
          start_date: q.start_date ? Number(q.start_date) : undefined,
          end_date: q.end_date ? Number(q.end_date) : undefined,
          assignee: q.assignee,
          task_id: q.task_id,
          list_id: q.list_id,
          folder_id: q.folder_id,
          space_id: q.space_id,
          tags: tags?.length ? tags : undefined,
          include_location_names: q.include_location_names === "true",
        });
        res.json({ entries });
      } catch (err: any) {
        if (planGateError(err)) return sendPlanLimited(res);
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/time-entries",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const entry = await cu.createTimeEntry(token, req.params.workspaceId, req.body);
        res.json(entry);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/clickup/workspaces/:workspaceId/time-entries/:entryId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const entry = await cu.updateTimeEntry(
          token,
          req.params.workspaceId,
          req.params.entryId,
          req.body,
        );
        res.json(entry);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/workspaces/:workspaceId/time-entries/:entryId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.deleteTimeEntry(token, req.params.workspaceId, req.params.entryId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/timer/start",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.startTimer(
          token,
          req.params.workspaceId,
          req.body.taskId,
          req.body.description,
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/timer/stop",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.stopTimer(token, req.params.workspaceId);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/timer/current",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const running = await cu.getRunningTimer(token, req.params.workspaceId);
        res.json({ running });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Time entry history ────────────────────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/time-entries/:entryId/history",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const history = await cu.getTimeEntryHistory(
          token,
          req.params.workspaceId,
          req.params.entryId,
        );
        res.json({ history });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Time entry tags ───────────────────────────────────────────────────────

  /** GET all tag names used in this workspace. */
  app.get(
    "/api/clickup/workspaces/:workspaceId/time-entry-tags",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const tags = await cu.getTimeEntryTags(token, req.params.workspaceId);
        res.json({ tags });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /** POST — add tags to a specific time entry. */
  app.post(
    "/api/clickup/workspaces/:workspaceId/time-entries/:entryId/tags",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const tags: Array<{ name: string }> = req.body.tags ?? [];
        if (!tags.length) return res.status(400).json({ error: "tags[] required" });
        await cu.addTagsToTimeEntry(token, req.params.workspaceId, req.params.entryId, tags);
        res.json({ success: true });
      } catch (err: any) {
        if (planGateError(err)) return sendPlanLimited(res);
        res.status(500).json({ error: err.message });
      }
    },
  );

  /** DELETE — remove tags from a specific time entry. */
  app.delete(
    "/api/clickup/workspaces/:workspaceId/time-entries/:entryId/tags",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const tags: Array<{ name: string }> = req.body.tags ?? [];
        if (!tags.length) return res.status(400).json({ error: "tags[] required" });
        await cu.removeTagsFromTimeEntry(token, req.params.workspaceId, req.params.entryId, tags);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /** PUT — rename a tag across the entire workspace. */
  app.put(
    "/api/clickup/workspaces/:workspaceId/time-entry-tags/rename",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, new_name } = req.body;
        if (!name || !new_name) return res.status(400).json({ error: "name and new_name required" });
        await cu.renameTimeEntryTag(token, req.params.workspaceId, name, new_name);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Per-user time estimates (Business plan+) ──────────────────────────────

  /**
   * PUT /api/clickup/tasks/:taskId/time-estimates/user/:userId
   *
   * Adds or updates per-assignee time estimates.  Requires Business plan.
   * Up to 10 estimates per request.  userId may be "unassigned".
   * Returns plan_limited notice (HTTP 402) when the workspace plan is insufficient.
   */
  app.put(
    "/api/clickup/tasks/:taskId/time-estimates/user/:userId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const estimates: Array<{ duration: number }> = req.body.estimates ?? [];
        if (!estimates.length) return res.status(400).json({ error: "estimates[] required" });
        const result = await cu.updateTimeEstimateForUser(
          token,
          req.params.taskId,
          req.params.userId,
          estimates,
        );
        res.json(result);
      } catch (err: any) {
        if (planGateError(err)) return sendPlanLimited(res);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Task time-in-status ───────────────────────────────────────────────────

  /** GET how long a single task has spent in each status. */
  app.get(
    "/api/clickup/tasks/:taskId/time-in-status",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const data = await cu.getTaskTimeInStatus(token, req.params.taskId);
        res.json(data);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * GET /api/clickup/workspaces/:workspaceId/tasks/time-in-status
   *
   * Bulk time-in-status for multiple tasks.  task_ids query param is comma-separated.
   * All tasks must belong to the same workspace.
   */
  app.get(
    "/api/clickup/workspaces/:workspaceId/tasks/time-in-status",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const raw = (req.query.task_ids as string | undefined) ?? "";
        const taskIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (!taskIds.length) return res.status(400).json({ error: "task_ids required" });
        const data = await cu.getBulkTasksTimeInStatus(token, req.params.workspaceId, taskIds);
        res.json(data);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Goals ────────────────────────────────────────────────────────────────

  app.get("/api/clickup/workspaces/:workspaceId/goals", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const goals = await cu.getGoals(token, req.params.workspaceId);
      res.json({ goals });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/goals/:goalId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const goal = await cu.getGoal(token, req.params.goalId);
      res.json({ goal });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/clickup/workspaces/:workspaceId/goals",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { workspaceId } = req.params;
        const { name, due_date, description, multiple_owners, owners, color } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "name is required" });
        const goal = await cu.createGoal(token, workspaceId, {
          name: name.trim(),
          due_date: due_date ?? null,
          description: description ?? "",
          multiple_owners: !!multiple_owners,
          owners: Array.isArray(owners) ? owners.map(Number) : [],
          color: color ?? null,
        });
        if (goal?.id) {
          await withDbAttribution("clickup:createGoal:mirror", async () => {
            const db = getDb();
            await db.insert(clickupGoals).values({
              id: String(goal.id),
              workspaceId,
              name: goal.name ?? name.trim(),
              dueDate: goal.due_date ? String(goal.due_date) : null,
              description: goal.description ?? null,
              color: goal.color ?? null,
              owners: goal.owners ?? null,
              multipleOwners: !!goal.multiple_owners,
              keyResults: goal.key_results ?? null,
              percentCompleted: goal.percent_completed ?? null,
              completed: !!goal.completed,
              createdBy: goal.creator ?? null,
              prettyId: goal.pretty_id ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            }).onConflictDoUpdate({
              target: clickupGoals.id,
              set: { name: goal.name ?? name.trim(), syncedAt: new Date(), updatedAt: new Date() },
            });
          });
        }
        res.json({ goal });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put("/api/clickup/goals/:goalId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { goalId } = req.params;
      const result = await cu.updateGoalFull(token, goalId, req.body);
      const goal = result?.goal ?? result;
      await withDbAttribution("clickup:updateGoal:mirror", async () => {
        const db = getDb();
        const upd: Record<string, any> = { syncedAt: new Date(), updatedAt: new Date() };
        if (req.body.name != null) upd.name = req.body.name;
        if (req.body.description !== undefined) upd.description = req.body.description;
        if (req.body.color !== undefined) upd.color = req.body.color;
        if (req.body.due_date !== undefined) upd.dueDate = req.body.due_date ? String(req.body.due_date) : null;
        if (goal?.owners) upd.owners = goal.owners;
        await db.update(clickupGoals).set(upd).where(eq(clickupGoals.id, goalId));
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/goals/:goalId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { goalId } = req.params;
      await cu.deleteGoal(token, goalId);
      await withDbAttribution("clickup:deleteGoal:mirror", async () => {
        const db = getDb();
        await db.delete(clickupGoals).where(eq(clickupGoals.id, goalId));
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/clickup/goals/:goalId/key-results",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { goalId } = req.params;
        const { name, type, owners, steps_start, steps_end, unit, task_ids, list_ids } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "name is required" });
        if (!type) return res.status(400).json({ error: "type is required" });
        const kr = await cu.createKeyResult(token, goalId, {
          name: name.trim(),
          type,
          owners: Array.isArray(owners) ? owners.map(Number) : [],
          steps_start: steps_start != null ? Number(steps_start) : undefined,
          steps_end: steps_end != null ? Number(steps_end) : undefined,
          unit: unit ?? undefined,
          task_ids: Array.isArray(task_ids) ? task_ids : undefined,
          list_ids: Array.isArray(list_ids) ? list_ids : undefined,
        });
        // Refresh goal in mirror so key_results jsonb stays current
        const updatedGoal = await cu.getGoal(token, goalId).catch(() => null);
        if (updatedGoal?.id) {
          await withDbAttribution("clickup:createKR:mirrorGoal", async () => {
            const db = getDb();
            await db.update(clickupGoals).set({
              keyResults: updatedGoal.key_results ?? null,
              percentCompleted: updatedGoal.percent_completed ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            }).where(eq(clickupGoals.id, goalId));
          });
        }
        res.json({ key_result: kr });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/clickup/goals/:goalId/key-results/:krId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.updateKeyResult(
          token,
          req.params.goalId,
          req.params.krId,
          req.body,
        );
        // Refresh goal mirror after key-result update
        const updatedGoal = await cu.getGoal(token, req.params.goalId).catch(() => null);
        if (updatedGoal?.id) {
          await withDbAttribution("clickup:updateKR:mirrorGoal", async () => {
            const db = getDb();
            await db.update(clickupGoals).set({
              keyResults: updatedGoal.key_results ?? null,
              percentCompleted: updatedGoal.percent_completed ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            }).where(eq(clickupGoals.id, req.params.goalId));
          });
        }
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/goals/:goalId/key-results/:krId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { goalId, krId } = req.params;
        await cu.deleteKeyResult(token, goalId, krId);
        // Refresh goal mirror
        const updatedGoal = await cu.getGoal(token, goalId).catch(() => null);
        if (updatedGoal?.id) {
          await withDbAttribution("clickup:deleteKR:mirrorGoal", async () => {
            const db = getDb();
            await db.update(clickupGoals).set({
              keyResults: updatedGoal.key_results ?? null,
              percentCompleted: updatedGoal.percent_completed ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            }).where(eq(clickupGoals.id, goalId));
          });
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Docs ─────────────────────────────────────────────────────────────────

  // GET /api/clickup/workspaces/:workspaceId/docs?query=<q>
  // Passes an optional query string to SearchDocsPublic (v3).
  app.get("/api/clickup/workspaces/:workspaceId/docs", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const query = String(req.query.query ?? "").trim();
      const docs = await cu.searchDocs(token, req.params.workspaceId, query);
      res.json({ docs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/clickup/workspaces/:workspaceId/docs — CreateDocPublic (v3)
  app.post("/api/clickup/workspaces/:workspaceId/docs", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { name, parent, visibility, create_page } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      const doc = await cu.createDoc(token, req.params.workspaceId, {
        name: name.trim(),
        ...(parent != null && { parent }),
        ...(visibility != null && { visibility }),
        ...(create_page != null && { create_page }),
      });
      res.json({ doc });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/clickup/workspaces/:workspaceId/docs/:docId — GetDocPublic (v3)
  app.get(
    "/api/clickup/workspaces/:workspaceId/docs/:docId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const doc = await cu.getDoc(token, req.params.workspaceId, req.params.docId);
        res.json({ doc });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // GET /api/clickup/workspaces/:workspaceId/docs/:docId/page-listing — GetDocPageListingPublic (v3)
  app.get(
    "/api/clickup/workspaces/:workspaceId/docs/:docId/page-listing",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const pages = await cu.getDocPageListing(
          token,
          req.params.workspaceId,
          req.params.docId,
        );
        res.json({ pages });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/docs/:docId/pages",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const pages = await cu.getDocPages(token, req.params.workspaceId, req.params.docId);
        res.json({ pages });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // POST /api/clickup/workspaces/:workspaceId/docs/:docId/pages — CreatePagePublic (v3)
  app.post(
    "/api/clickup/workspaces/:workspaceId/docs/:docId/pages",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, content, content_format, parent_page_id } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "name is required" });
        const page = await cu.createDocPage(token, req.params.workspaceId, req.params.docId, {
          name: name.trim(),
          content: content ?? "",
          content_format: content_format ?? "text/md",
          ...(parent_page_id ? { parent_page_id } : {}),
        });
        res.json({ page });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/docs/:docId/pages/:pageId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const page = await cu.getDocPage(
          token,
          req.params.workspaceId,
          req.params.docId,
          req.params.pageId,
        );
        res.json({ page });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/clickup/workspaces/:workspaceId/docs/:docId/pages/:pageId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.updateDocPage(
          token,
          req.params.workspaceId,
          req.params.docId,
          req.params.pageId,
          req.body,
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Space Tags ───────────────────────────────────────────────────────────
  // Tag CRUD is Space-scoped. Removing a tag from a task does NOT delete it from the Space.

  app.get("/api/clickup/spaces/:spaceId/tags", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const tags = await cu.getSpaceTags(token, req.params.spaceId);
      res.json({ tags });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/spaces/:spaceId/tags", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { name, tag_fg, tag_bg } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
      }
      await cu.createSpaceTag(token, req.params.spaceId, {
        name: name.trim(),
        tag_fg: tag_fg ?? "#ffffff",
        tag_bg: tag_bg ?? "#6b7280",
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put(
    "/api/clickup/spaces/:spaceId/tags/:tagName",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, tag_fg, tag_bg } = req.body;
        await cu.editSpaceTag(token, req.params.spaceId, req.params.tagName, {
          ...(name !== undefined && { name }),
          ...(tag_fg !== undefined && { tag_fg }),
          ...(tag_bg !== undefined && { tag_bg }),
        });
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/spaces/:spaceId/tags/:tagName",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.deleteSpaceTag(token, req.params.spaceId, req.params.tagName);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Task tag add / remove ─────────────────────────────────────────────────

  app.post(
    "/api/clickup/tasks/:taskId/tags/:tagName",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.addTagToTask(token, req.params.taskId, req.params.tagName);
        // Mirror: update local task record's tags jsonb
        await withDbAttribution("clickup:addTagToTask", async () => {
          const db = getDb();
          const [row] = await db
            .select({ tags: clickupTasks.tags })
            .from(clickupTasks)
            .where(eq(clickupTasks.id, req.params.taskId))
            .limit(1);
          if (row) {
            const tags: any[] = Array.isArray(row.tags) ? row.tags : [];
            if (!tags.some((t: any) => t.name === req.params.tagName)) {
              tags.push({ name: req.params.tagName });
              await db
                .update(clickupTasks)
                .set({ tags, updatedAt: new Date() })
                .where(eq(clickupTasks.id, req.params.taskId));
            }
          }
        });
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/tasks/:taskId/tags/:tagName",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.removeTagFromTask(token, req.params.taskId, req.params.tagName);
        // Mirror: remove tag from local task record
        await withDbAttribution("clickup:removeTagFromTask", async () => {
          const db = getDb();
          const [row] = await db
            .select({ tags: clickupTasks.tags })
            .from(clickupTasks)
            .where(eq(clickupTasks.id, req.params.taskId))
            .limit(1);
          if (row) {
            const tags: any[] = Array.isArray(row.tags) ? row.tags : [];
            const filtered = tags.filter((t: any) => t.name !== req.params.tagName);
            await db
              .update(clickupTasks)
              .set({ tags: filtered, updatedAt: new Date() })
              .where(eq(clickupTasks.id, req.params.taskId));
          }
        });
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Webhooks (admin) ─────────────────────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/webhooks",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const webhooks = await cu.getWebhooks(token, req.params.workspaceId);
        res.json({ webhooks });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/webhooks",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const endpoint = buildWebhookEndpoint(req);
        const result = await cu.createWebhook(token, req.params.workspaceId, endpoint, ["*"]);
        if (result.id && result.secret) {
          await withDbAttribution("clickup:storeWebhook", async () => {
            const db = getDb();
            await db.insert(clickupWebhooks).values({
              id: String(result.id),
              workspaceId: req.params.workspaceId,
              userId: getClickUpUserId(req) ?? "",
              endpoint,
              secret: encryptToken(result.secret),
              events: ["*"],
              status: "active",
            }).onConflictDoUpdate({
              target: clickupWebhooks.id,
              set: { secret: encryptToken(result.secret), status: "active", updatedAt: new Date() },
            });
          });
        }
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/webhooks/:webhookId",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.deleteWebhook(token, req.params.webhookId);
        await withDbAttribution("clickup:deleteWebhook", async () => {
          const db = getDb();
          await db.delete(clickupWebhooks).where(eq(clickupWebhooks.id, req.params.webhookId));
        });
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Webhook receiver (unauthenticated, HMAC-verified) ────────────────────

  app.post(
    "/api/webhooks/clickup",
    (req, _res, next) => {
      let data = Buffer.alloc(0);
      req.on("data", (chunk: Buffer) => { data = Buffer.concat([data, chunk]); });
      req.on("end", () => { (req as any).__rawBody = data; next(); });
    },
    async (req: any, res) => {
      try {
        const rawBody: Buffer = req.__rawBody ?? Buffer.from(JSON.stringify(req.body));
        const signature = req.headers["x-signature"] as string ?? "";
        const webhookId = req.headers["x-webhook-id"] as string ?? "";

        const verified = await verifyIncomingWebhook(rawBody, signature, webhookId);
        if (!verified) {
          return res.status(401).json({ error: "Invalid webhook signature" });
        }

        res.status(200).json({ ok: true });

        let payload: any;
        try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return; }
        applyWebhookEvent(payload).catch((err) => {
          console.error("[ClickUp] webhook apply error:", err?.message || err);
        });
      } catch (err: any) {
        console.error("[ClickUp] webhook receiver error:", err?.message || err);
        res.status(500).json({ error: "internal error" });
      }
    },
  );

  // ─── Task relationship routes (Epic 4/16) ─────────────────────────────────

  // ─── Facets from mirror (fast, no ClickUp API call) ─────────────────────
  //
  // Returns { statuses, members, tags } for populating filter dropdowns from
  // the local mirror tables so no API budget is spent on facet refreshes.

  app.get(
    "/api/clickup/workspaces/:workspaceId/facets",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = getClickUpUserId(req);
        if (!userId) return res.status(401).json({ error: "Not authenticated" });
        const { workspaceId } = req.params;

        const facets = await withDbAttribution("clickup:facets", async () => {
          const db = getDb();

          const [spaces, workspace, tasks] = await Promise.all([
            db
              .select({ statuses: clickupSpaces.statuses })
              .from(clickupSpaces)
              .where(eq(clickupSpaces.workspaceId, workspaceId)),
            db
              .select({ members: clickupWorkspaces.members })
              .from(clickupWorkspaces)
              .where(eq(clickupWorkspaces.id, workspaceId))
              .limit(1),
            db
              .select({ tags: clickupTasks.tags, assignees: clickupTasks.assignees })
              .from(clickupTasks)
              .where(eq(clickupTasks.workspaceId, workspaceId))
              .limit(500),
          ]);

          // Deduplicate statuses across all spaces
          const statusMap = new Map<string, { status: string; color?: string; type?: string }>();
          for (const s of spaces) {
            const arr = Array.isArray(s.statuses) ? s.statuses : [];
            for (const st of arr as any[]) {
              if (st?.status) statusMap.set(String(st.status).toLowerCase(), st);
            }
          }

          // Members from workspace mirror
          const membersRaw = Array.isArray(workspace[0]?.members) ? workspace[0].members : [];
          const members: Array<{ id: string; username: string; email?: string }> = [];
          for (const m of membersRaw as any[]) {
            const u = m?.user ?? m;
            if (u?.id) members.push({ id: String(u.id), username: String(u.username ?? u.id), email: u.email ?? undefined });
          }

          // Tags from tasks
          const tagMap = new Map<string, string>();
          for (const t of tasks) {
            const arr = Array.isArray(t.tags) ? t.tags : [];
            for (const tag of arr as any[]) {
              if (tag?.name) tagMap.set(String(tag.name), String(tag.tag_fg ?? ""));
            }
          }

          return {
            statuses: Array.from(statusMap.values()),
            members,
            tags: Array.from(tagMap.entries()).map(([name, color]) => ({ name, color })),
          };
        });

        res.json(facets);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Workspace-wide task search ──────────────────────────────────────────
  //
  // Calls ClickUp GetFilteredTeamTasks (GET /team/{id}/task).
  // Rate-limit pacing is handled inside cuFetch; clients should debounce before
  // calling this (400 ms recommended).
  //
  // Query params:
  //   q           free-text search
  //   page        0-indexed page (100 tasks/page)
  //   statuses    comma-separated
  //   assignees   comma-separated clickup user IDs
  //   tags        comma-separated tag names
  //   priorities  comma-separated (1=urgent,2=high,3=normal,4=low)
  //   space_ids   comma-separated
  //   folder_ids  comma-separated
  //   list_ids    comma-separated
  //   due_date_gt / due_date_lt  epoch-ms
  //   start_date_gt / start_date_lt  epoch-ms
  //   include_closed  "true" | "false"
  //   custom_fields  JSON-encoded CUCustomFieldFilter[]

  // Workspace-level task search — simple query wrapper used by task pickers
  app.get(
    "/api/clickup/workspaces/:workspaceId/search",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;

        const q = req.query;
        const opts: cu.GetFilteredTeamTasksOpts = {
          query: q.q ? String(q.q) : undefined,
          page: q.page ? parseInt(String(q.page), 10) : 0,
          includeClosed: q.include_closed === "true",
          includeMarkdownDescription: false,
          subtasks: q.subtasks === "true",
          spaceIds: q.space_ids ? String(q.space_ids).split(",").filter(Boolean) : undefined,
          folderIds: q.folder_ids ? String(q.folder_ids).split(",").filter(Boolean) : undefined,
          listIds: q.list_ids ? String(q.list_ids).split(",").filter(Boolean) : undefined,
          statuses: q.statuses ? String(q.statuses).split(",").filter(Boolean) : undefined,
          assignees: q.assignees ? String(q.assignees).split(",").filter(Boolean) : undefined,
          tags: q.tags ? String(q.tags).split(",").filter(Boolean) : undefined,
          priorities: q.priorities
            ? String(q.priorities).split(",").filter(Boolean).map(Number)
            : undefined,
          dueDateGt: q.due_date_gt ? parseInt(String(q.due_date_gt), 10) : undefined,
          dueDateLt: q.due_date_lt ? parseInt(String(q.due_date_lt), 10) : undefined,
          startDateGt: q.start_date_gt ? parseInt(String(q.start_date_gt), 10) : undefined,
          startDateLt: q.start_date_lt ? parseInt(String(q.start_date_lt), 10) : undefined,
        };

        if (q.custom_fields) {
          try {
            opts.customFields = JSON.parse(String(q.custom_fields));
          } catch {
            return res.status(400).json({ error: "custom_fields must be valid JSON" });
          }
        }

        const result = await cu.getFilteredTeamTasks(token, req.params.workspaceId, opts);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Fetch task with subtasks included
  app.get("/api/clickup/tasks/:taskId/full", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const task = await cu.getTaskWithSubtasks(token, req.params.taskId);
      res.json({ task });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Saved filter presets (per-user, stored in NoBull DB) ────────────────

  app.get("/api/clickup/filter-presets", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getClickUpUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const workspaceId = req.query.workspace_id ? String(req.query.workspace_id) : undefined;
      const presets = await withDbAttribution("clickup:filterPresets:list", async () => {
        const db = getDb();
        const conditions = [eq(clickupFilterPresets.userId, userId)];
        if (workspaceId) conditions.push(eq(clickupFilterPresets.workspaceId, workspaceId));
        return db
          .select()
          .from(clickupFilterPresets)
          .where(and(...conditions))
          .orderBy(desc(clickupFilterPresets.createdAt));
      });
      res.json({ presets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dependencies
  app.post("/api/clickup/tasks/:taskId/dependencies", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { depends_on, dependency_of } = req.body;
      if (!depends_on && !dependency_of) {
        return res.status(400).json({ error: "Provide depends_on or dependency_of" });
      }
      await cu.addDependency(token, req.params.taskId, { depends_on, dependency_of });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clickup/filter-presets", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getClickUpUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { name, workspaceId, filters } = req.body;
      if (!name || !workspaceId || !filters) {
        return res.status(400).json({ error: "name, workspaceId, and filters are required" });
      }
      const [preset] = await withDbAttribution("clickup:filterPresets:create", async () => {
        const db = getDb();
        return db
          .insert(clickupFilterPresets)
          .values({ userId, name, workspaceId, filters })
          .returning();
      });
      res.json({ preset });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/filter-presets/:presetId", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getClickUpUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await withDbAttribution("clickup:filterPresets:delete", async () => {
        const db = getDb();
        await db
          .delete(clickupFilterPresets)
          .where(
            and(
              eq(clickupFilterPresets.id, req.params.presetId),
              eq(clickupFilterPresets.userId, userId),
            ),
          );
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/tasks/:taskId/dependencies", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const depends_on = req.body.depends_on as string | undefined;
      const dependency_of = req.body.dependency_of as string | undefined;
      if (!depends_on && !dependency_of) {
        return res.status(400).json({ error: "Provide depends_on or dependency_of" });
      }
      await cu.deleteDependency(token, req.params.taskId, { depends_on, dependency_of });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Task links
  app.post(
    "/api/clickup/tasks/:taskId/links/:linksTo",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.addTaskLink(token, req.params.taskId, req.params.linksTo);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/tasks/:taskId/links/:linksTo",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.deleteTaskLink(token, req.params.taskId, req.params.linksTo);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Merge tasks
  app.post("/api/clickup/tasks/:taskId/merge", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { task_ids } = req.body;
      if (!Array.isArray(task_ids) || task_ids.length === 0) {
        return res.status(400).json({ error: "task_ids must be a non-empty array" });
      }
      await cu.mergeTasks(token, req.params.taskId, task_ids);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Watchers — add via updateTask watchers.add field
  app.post("/api/clickup/tasks/:taskId/watchers", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const add: string[] = Array.isArray(req.body.add) ? req.body.add : [];
      if (add.length === 0) return res.status(400).json({ error: "add must be a non-empty array" });
      await cu.updateTask(token, req.params.taskId, { watchers: { add, rem: [] } } as any);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Watchers — remove a single watcher
  app.delete(
    "/api/clickup/tasks/:taskId/watchers/:userId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        await cu.updateTask(token, req.params.taskId, {
          watchers: { add: [], rem: [req.params.userId] },
        } as any);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Move Task / Tasks in Multiple Lists (Epic 5/16) ──────────────────────
  //
  // MoveTask: POST /list/{newListId}/task/{taskId} — ClickUp dedicated endpoint.
  // Route updates the mirror immediately (listId); webhook reconciles on taskMoved event.
  // AddTaskToList / RemoveTaskFromList: same path shape, TIML ClickApp must be enabled.
  // TIML-disabled returns HTTP 400 from ClickUp; we surface it as 422 with timl_disabled flag.

  app.post("/api/clickup/tasks/:taskId/move", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { taskId } = req.params;
      const { listId } = req.body as { listId?: string };
      if (!listId || typeof listId !== "string" || !listId.trim()) {
        return res.status(400).json({ error: "listId is required" });
      }
      const result = await cu.moveTask(token, taskId, listId.trim());
      // Optimistic mirror update — webhook will reconcile asynchronously.
      try {
        await withDbAttribution("clickup:moveTask:mirrorUpdate", async () => {
          const db = getDb();
          await db
            .update(clickupTasks)
            .set({ listId: listId.trim() })
            .where(eq(clickupTasks.id, taskId));
        });
      } catch (mirrorErr: any) {
        console.warn("[ClickUp] moveTask mirror update failed (non-fatal):", mirrorErr?.message);
      }
      res.json({ success: true, task: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add task to an additional List (Tasks in Multiple Lists — requires TIML ClickApp)
  app.post(
    "/api/clickup/tasks/:taskId/lists/:listId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { taskId, listId } = req.params;
        const result = await cu.addTaskToList(token, taskId, listId);
        res.json({ success: true, task: result });
      } catch (err: any) {
        if (cu.isTiMlDisabledError(err)) {
          return res.status(422).json({
            error: "The Tasks in Multiple Lists ClickApp is not enabled on this workspace. Enable it in ClickUp Settings → ClickApps.",
            timl_disabled: true,
          });
        }
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Remove task from an additional List (Tasks in Multiple Lists — home list cannot be removed)
  app.delete(
    "/api/clickup/tasks/:taskId/lists/:listId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { taskId, listId } = req.params;
        await cu.removeTaskFromList(token, taskId, listId);
        res.json({ success: true });
      } catch (err: any) {
        if (cu.isTiMlDisabledError(err)) {
          return res.status(422).json({
            error: "The Tasks in Multiple Lists ClickApp is not enabled on this workspace.",
            timl_disabled: true,
          });
        }
        // Detect home-list removal attempt (ClickUp rejects with specific message)
        if (err.message?.toLowerCase().includes("cannot remove") || err.message?.toLowerCase().includes("home")) {
          return res.status(422).json({ error: "Cannot remove a task from its home List. Move the task instead.", home_list: true });
        }
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Views ────────────────────────────────────────────────────────────────
  //
  // All view reads go directly to the ClickUp API (no local mirror — views
  // change frequently and are small). Writes go to ClickUp and the caller
  // invalidates their own React Query cache.
  //
  // Routes:
  //   GET  /api/clickup/workspaces/:workspaceId/views  → GetTeamViews
  //   POST /api/clickup/workspaces/:workspaceId/views  → CreateTeamView
  //   GET  /api/clickup/spaces/:spaceId/views          → GetSpaceViews
  //   POST /api/clickup/spaces/:spaceId/views          → CreateSpaceView
  //   GET  /api/clickup/folders/:folderId/views        → GetFolderViews
  //   POST /api/clickup/folders/:folderId/views        → CreateFolderView
  //   GET  /api/clickup/lists/:listId/views            → GetListViews (views + required_views)
  //   POST /api/clickup/lists/:listId/views            → CreateListView
  //   GET  /api/clickup/views/:viewId                  → GetView
  //   PUT  /api/clickup/views/:viewId                  → UpdateView (name, grouping, sorting, filters, columns)
  //   DELETE /api/clickup/views/:viewId                → DeleteView
  //   GET  /api/clickup/views/:viewId/tasks            → GetViewTasks (page query param, 100/page)

  app.get(
    "/api/clickup/workspaces/:workspaceId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const views = await cu.getTeamViews(token, req.params.workspaceId);
        res.json({ views });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, type } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });
        const view = await cu.createTeamView(token, req.params.workspaceId, { name, type });
        res.json({ view });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/spaces/:spaceId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const views = await cu.getSpaceViews(token, req.params.spaceId);
        res.json({ views });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/spaces/:spaceId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, type } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });
        const view = await cu.createSpaceView(token, req.params.spaceId, { name, type });
        res.json({ view });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/folders/:folderId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const views = await cu.getFolderViews(token, req.params.folderId);
        res.json({ views });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/folders/:folderId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, type } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });
        const view = await cu.createFolderView(token, req.params.folderId, { name, type });
        res.json({ view });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/lists/:listId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const result = await cu.getListViews(token, req.params.listId);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/lists/:listId/views",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { name, type } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });
        const view = await cu.createListView(token, req.params.listId, { name, type });
        res.json({ view });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get("/api/clickup/views/:viewId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const view = await cu.getView(token, req.params.viewId);
      res.json({ view });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/clickup/views/:viewId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const view = await cu.updateView(token, req.params.viewId, req.body);
      res.json({ view });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/views/:viewId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      await cu.deleteView(token, req.params.viewId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/views/:viewId/tasks", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const page = parseInt(String(req.query.page ?? "0"), 10);
      const result = await cu.getViewTasks(token, req.params.viewId, page);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Templates ────────────────────────────────────────────────────────────
  //
  // List routes (GET) — enumerate workspace templates for the picker UI.
  // Create routes (POST) — create a task, List, or Folder from a template.
  //   After creation the route enqueues a targeted sub-tree refresh so
  //   template-created objects appear in the mirror without waiting for the
  //   next scheduled backfill (important for async/return_immediately cases
  //   where webhooks may lag large template expansions).
  //
  // Out of scope: creating or editing template definitions (not in public API).

  app.get(
    "/api/clickup/workspaces/:workspaceId/task-templates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const templates = await cu.getTaskTemplates(token, req.params.workspaceId);
        res.json({ templates });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/list-templates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const templates = await cu.getListTemplates(token, req.params.workspaceId);
        res.json({ templates });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/folder-templates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const templates = await cu.getFolderTemplates(token, req.params.workspaceId);
        res.json({ templates });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Create a task from a task template.
   * Body: { templateId: string; name?: string; workspaceId: string }
   * Response: { task, materializing: false } (task templates are synchronous)
   */
  app.post(
    "/api/clickup/lists/:listId/tasks-from-template",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const userId = getClickUpUserId(req);
        const { listId } = req.params;
        const { templateId, name, workspaceId } = req.body;
        if (!templateId) return res.status(400).json({ error: "templateId is required" });

        const task = await cu.createTaskFromTemplate(token, listId, templateId, name ? { name } : {});

        // Targeted refresh: list level so the new task appears in the mirror.
        if (workspaceId && userId) {
          await enqueueJob({
            queueName: "clickup_subtree_refresh",
            workloadClass: "ingestion",
            payload: { kind: "list", id: listId, workspaceId, userId },
            dedupeKey: `clickup_subtree_refresh:list:${listId}:${Date.now()}`,
          }).catch(() => {});
        }

        res.json({ task, materializing: false });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Create a List in a Folder from a list template.
   * Body: { templateId, name?, workspaceId, spaceId, returnImmediately? }
   * Response: { list?, materializing: boolean }
   */
  app.post(
    "/api/clickup/folders/:folderId/lists-from-template",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const userId = getClickUpUserId(req);
        const { folderId } = req.params;
        const { templateId, name, workspaceId, spaceId, returnImmediately } = req.body;
        if (!templateId) return res.status(400).json({ error: "templateId is required" });

        const returnImm = returnImmediately !== false;
        const result = await cu.createListFromTemplateInFolder(
          token,
          folderId,
          templateId,
          { name: name || undefined, return_immediately: returnImm },
        );

        if (workspaceId && userId) {
          await enqueueJob({
            queueName: "clickup_subtree_refresh",
            workloadClass: "ingestion",
            payload: { kind: "folder", id: folderId, workspaceId, spaceId: spaceId || null, userId },
            dedupeKey: `clickup_subtree_refresh:folder:${folderId}:${Date.now()}`,
          }).catch(() => {});
        }

        res.json({ list: result ?? null, materializing: returnImm });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Create a List in a Space from a list template.
   * Body: { templateId, name?, workspaceId, returnImmediately? }
   * Response: { list?, materializing: boolean }
   */
  app.post(
    "/api/clickup/spaces/:spaceId/lists-from-template",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const userId = getClickUpUserId(req);
        const { spaceId } = req.params;
        const { templateId, name, workspaceId, returnImmediately } = req.body;
        if (!templateId) return res.status(400).json({ error: "templateId is required" });

        const returnImm = returnImmediately !== false;
        const result = await cu.createListFromTemplateInSpace(
          token,
          spaceId,
          templateId,
          { name: name || undefined, return_immediately: returnImm },
        );

        if (workspaceId && userId) {
          await enqueueJob({
            queueName: "clickup_subtree_refresh",
            workloadClass: "ingestion",
            payload: { kind: "space", id: spaceId, workspaceId, userId },
            dedupeKey: `clickup_subtree_refresh:space:${spaceId}:${Date.now()}`,
          }).catch(() => {});
        }

        res.json({ list: result ?? null, materializing: returnImm });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  /**
   * Create a Folder (with nested assets) in a Space from a folder template.
   * Body: { templateId, name?, workspaceId, returnImmediately? }
   * Response: { folder?, materializing: boolean }
   */
  app.post(
    "/api/clickup/spaces/:spaceId/folders-from-template",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const userId = getClickUpUserId(req);
        const { spaceId } = req.params;
        const { templateId, name, workspaceId, returnImmediately } = req.body;
        if (!templateId) return res.status(400).json({ error: "templateId is required" });

        const returnImm = returnImmediately !== false;
        const result = await cu.createFolderFromTemplate(
          token,
          spaceId,
          templateId,
          { name: name || undefined, return_immediately: returnImm },
        );

        if (workspaceId && userId) {
          await enqueueJob({
            queueName: "clickup_subtree_refresh",
            workloadClass: "ingestion",
            payload: { kind: "space", id: spaceId, workspaceId, userId },
            dedupeKey: `clickup_subtree_refresh:space:${spaceId}:${Date.now()}`,
          }).catch(() => {});
        }

        res.json({ folder: result ?? null, materializing: returnImm });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Members (explicit access) ────────────────────────────────────────────
  //
  // GetTaskMembers / GetListMembers — only explicit members, not inherited.
  // Callers must display the inherited-access caveat to users.

  app.get("/api/clickup/tasks/:taskId/members", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const [members, task] = await Promise.all([
        cu.getTaskMembers(token, req.params.taskId),
        cu.getTask(token, req.params.taskId).catch(() => null),
      ]);
      // ClickUp includes `private` on the task object (GetTask, reviewed 2026-07-17).
      const isPrivate = typeof task?.private === "boolean" ? task.private : null;
      res.json({ members, isPrivate, inheritedNote: "Only members with explicit access are shown. Members who inherited access via team membership or location are excluded." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clickup/lists/:listId/members", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const [members, list] = await Promise.all([
        cu.getListMembers(token, req.params.listId),
        cu.getList(token, req.params.listId).catch(() => null),
      ]);
      // ClickUp includes `private` on the list object (GetList, reviewed 2026-07-17).
      const isPrivate = typeof list?.private === "boolean" ? list.private : null;
      res.json({ members, isPrivate, inheritedNote: "Only members with explicit access are shown. Members who inherited access via team membership or location are excluded." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Custom Roles ──────────────────────────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/custom-roles",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const roles = await cu.getCustomRoles(token, req.params.workspaceId);
        res.json({ roles });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Shared Hierarchy ─────────────────────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/shared",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const shared = await cu.getSharedHierarchy(token, req.params.workspaceId);
        res.json(shared);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── User Groups CRUD ─────────────────────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/groups",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const groups = await cu.getGroups(token, req.params.workspaceId);
        res.json({ groups });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/groups",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { workspaceId } = req.params;
        const { name, memberIds } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "name is required" });
        const members = Array.isArray(memberIds)
          ? memberIds.map((id: number | string) => ({ id: Number(id) }))
          : [];
        const group = await cu.createGroup(token, {
          name: name.trim(),
          team_id: workspaceId,
          members,
        });
        res.json({ group });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put("/api/clickup/groups/:groupId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      const { groupId } = req.params;
      const { name, addMemberIds, removeMemberIds } = req.body;
      const body: Parameters<typeof cu.updateGroup>[2] = {};
      if (name != null) body.name = String(name);
      if (Array.isArray(addMemberIds) && addMemberIds.length)
        body.add_users = addMemberIds.map((id: number | string) => ({ id: Number(id) }));
      if (Array.isArray(removeMemberIds) && removeMemberIds.length)
        body.rem_users = removeMemberIds.map((id: number | string) => ({ id: Number(id) }));
      const group = await cu.updateGroup(token, groupId, body);
      res.json({ group });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/clickup/groups/:groupId", isAuthenticated, async (req: any, res) => {
    try {
      const token = await requireClickUpToken(req, res);
      if (!token) return;
      await cu.deleteGroup(token, req.params.groupId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Privacy / ACL (PublicPatchAcl) ───────────────────────────────────────
  //
  // WARNING: Sharing an item may incur charges — the UI must surface this
  // cost-warning confirmation before calling this route.

  app.post(
    "/api/clickup/workspaces/:workspaceId/acl",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { workspaceId } = req.params;
        const { type, id, private: priv } = req.body;
        if (!type || !id) return res.status(400).json({ error: "type and id are required" });
        const result = await cu.updateAcl(token, workspaceId, { type: Number(type), id: String(id), private: !!priv });
        res.json({ result });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Workspace Seats & Plan ───────────────────────────────────────────────

  app.get(
    "/api/clickup/workspaces/:workspaceId/seats",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const seats = await cu.getWorkspaceSeats(token, req.params.workspaceId);
        res.json(seats);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/plan",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        const { workspaceId } = req.params;
        const data = await cu.getWorkspacePlan(token, workspaceId);
        const planName: string = data?.plan?.name ?? "";
        // Persist to mirror so plan-gated features can read without another API call.
        if (planName) {
          await withDbAttribution("clickup:plan:mirror", async () => {
            const db = getDb();
            await db
              .update(clickupWorkspaces)
              .set({ plan: planName, updatedAt: new Date() })
              .where(eq(clickupWorkspaces.id, workspaceId));
          });
        }
        res.json({ plan: planName });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Chat (v3 — experimental ClickUp API) ─────────────────────────────────
  // All Chat routes check the `clickup_chat_enabled` system_settings key.
  // Default: enabled (any value other than "false" = enabled).

  async function requireChatEnabled(req: any, res: Response): Promise<boolean> {
    try {
      const { getSystemSetting } = await import("../storage/settingsStorage");
      const row = await getSystemSetting("clickup_chat_enabled");
      if (row?.value === "false") {
        res.status(503).json({ error: "ClickUp Chat is currently disabled (clickup_chat_enabled=false)" });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  app.get(
    "/api/clickup/workspaces/:workspaceId/chat/subtypes",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const subtypes = await cu.getChatSubtypes(token, req.params.workspaceId);
        res.json({ subtypes });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/chat/channels",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const channels = await cu.getChatChannels(token, req.params.workspaceId);
        res.json({ channels });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/chat/channels",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { name, description, is_private } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "name is required" });
        const channel = await cu.createChatChannel(token, req.params.workspaceId, {
          name: name.trim(),
          description,
          is_private,
        });
        res.json({ channel });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/chat/channels/location",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { name, description, location_type, location_id } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "name is required" });
        if (!location_type || !location_id) return res.status(400).json({ error: "location_type and location_id are required" });
        const channel = await cu.createLocationChatChannel(token, req.params.workspaceId, {
          name: name.trim(),
          description,
          location_type,
          location_id,
        });
        res.json({ channel });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/chat/channels/dm",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { user_ids } = req.body;
        if (!Array.isArray(user_ids) || user_ids.length === 0) {
          return res.status(400).json({ error: "user_ids array is required" });
        }
        if (user_ids.length > 15) {
          return res.status(400).json({ error: "DMs support at most 15 users" });
        }
        const channel = await cu.createDirectMessageChannel(token, req.params.workspaceId, user_ids);
        res.json({ channel });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const channel = await cu.getChatChannel(token, req.params.workspaceId, req.params.channelId);
        res.json({ channel });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.patch(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const channel = await cu.updateChatChannel(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.body,
        );
        res.json({ channel });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        await cu.deleteChatChannel(token, req.params.workspaceId, req.params.channelId);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/members",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const members = await cu.getChatChannelMembers(token, req.params.workspaceId, req.params.channelId);
        res.json({ members });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
        const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 25;
        const result = await cu.getChatMessages(
          token,
          req.params.workspaceId,
          req.params.channelId,
          { cursor, limit },
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { content, type, subtype_id } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: "content is required" });
        const message = await cu.createChatMessage(
          token,
          req.params.workspaceId,
          req.params.channelId,
          { content: content.trim(), type, subtype_id },
        );
        res.json({ message });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.patch(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: "content is required" });
        const message = await cu.patchChatMessage(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.params.messageId,
          { content: content.trim() },
        );
        res.json({ message });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        await cu.deleteChatMessage(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.params.messageId,
        );
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/replies",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
        const result = await cu.getChatMessageReplies(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.params.messageId,
          { cursor },
        );
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/replies",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: "content is required" });
        const reply = await cu.createChatReply(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.params.messageId,
          { content: content.trim() },
        );
        res.json({ reply });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/reactions",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { emoji } = req.body;
        if (!emoji) return res.status(400).json({ error: "emoji is required" });
        const reaction = await cu.createChatReaction(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.params.messageId,
          String(emoji).toLowerCase(),
        );
        res.json({ reaction });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/reactions",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const token = await requireClickUpToken(req, res);
        if (!token) return;
        if (!await requireChatEnabled(req, res)) return;
        const { emoji } = req.body;
        if (!emoji) return res.status(400).json({ error: "emoji is required" });
        await cu.deleteChatReaction(
          token,
          req.params.workspaceId,
          req.params.channelId,
          req.params.messageId,
          String(emoji).toLowerCase(),
        );
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Backfill trigger ─────────────────────────────────────────────────────

  app.post(
    "/api/clickup/workspaces/:workspaceId/sync",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId = getClickUpUserId(req);
        if (!userId) return res.status(401).json({ error: "Not authenticated" });
        const { workspaceId } = req.params;
        await enqueueJob({
          queueName: "clickup_hierarchy_backfill",
          workloadClass: "ingestion",
          payload: { workspaceId, userId },
          dedupeKey: `clickup_backfill:${workspaceId}`,
        });
        res.json({ queued: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildWebhookEndpoint(req: any): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.get("host") ?? "";
  return `${proto}://${host}/api/webhooks/clickup`;
}

async function verifyIncomingWebhook(
  rawBody: Buffer,
  signature: string,
  webhookId: string,
): Promise<boolean> {
  if (!signature) return false;
  try {
    let secret: string | null = null;
    if (webhookId) {
      secret = await withDbAttribution("clickup:verifyWebhook:byId", async () => {
        const db = getDb();
        const [row] = await db
          .select({ secret: clickupWebhooks.secret })
          .from(clickupWebhooks)
          .where(eq(clickupWebhooks.id, webhookId))
          .limit(1);
        return row?.secret ? decryptToken(row.secret) : null;
      });
    }
    if (!secret) {
      return withDbAttribution("clickup:verifyWebhook:allSecrets", async () => {
        const db = getDb();
        const rows = await db.select({ secret: clickupWebhooks.secret }).from(clickupWebhooks);
        for (const row of rows) {
          if (!row.secret) continue;
          try {
            const s = decryptToken(row.secret);
            if (cu.verifyWebhookSignature(rawBody, signature, s)) return true;
          } catch { /* try next */ }
        }
        return false;
      });
    }
    return cu.verifyWebhookSignature(rawBody, signature, secret);
  } catch {
    return false;
  }
}

async function getAnyClickUpToken(): Promise<string | null> {
  return withDbAttribution("clickup:webhook:getAnyToken", async () => {
    const db = getDb();
    const rows = await db.select({ accessTokenEncrypted: clickupUserTokens.accessTokenEncrypted })
      .from(clickupUserTokens)
      .limit(1);
    if (!rows.length || !rows[0].accessTokenEncrypted) return null;
    return decryptToken(rows[0].accessTokenEncrypted);
  });
}

async function applyWebhookEvent(payload: any): Promise<void> {
  const event = payload.event as string;
  if (!event) return;

  if (event.startsWith("task")) {
    const taskId = payload.task_id as string | undefined;
    if (!taskId) return;
    await enqueueJob({
      queueName: "clickup_task_apply",
      workloadClass: "ingestion",
      payload: { taskId, event },
      dedupeKey: `clickup_task_apply:${taskId}:${Date.now()}`,
    }).catch(() => {});
    return;
  }

  // Space events: spaceCreated, spaceUpdated, spaceDeleted
  if (event === "spaceDeleted") {
    const spaceId = String(payload.space_id ?? "");
    if (!spaceId) return;
    await withDbAttribution("clickup:webhook:deleteSpace", async () => {
      const db = getDb();
      await db.delete(clickupSpaces).where(eq(clickupSpaces.id, spaceId));
    });
    return;
  }

  if (event === "spaceCreated" || event === "spaceUpdated") {
    const spaceId = String(payload.space_id ?? "");
    if (!spaceId) return;
    const token = await getAnyClickUpToken();
    if (!token) return;
    const space = await cu.getSpace(token, spaceId).catch(() => null);
    if (!space?.id) return;
    await withDbAttribution("clickup:webhook:upsertSpace", async () => {
      const db = getDb();
      const workspaceId = String(space.team_id ?? payload.team_id ?? "");
      await db.insert(clickupSpaces).values({
        id: String(space.id),
        workspaceId,
        name: space.name ?? "",
        color: space.color ?? null,
        private: !!space.private,
        statuses: space.statuses ?? null,
        features: space.features ?? null,
        archived: !!space.archived,
        syncedAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: clickupSpaces.id,
        set: {
          name: space.name ?? "",
          color: space.color ?? null,
          private: !!space.private,
          statuses: space.statuses ?? null,
          features: space.features ?? null,
          archived: !!space.archived,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
    return;
  }

  // Folder events: folderCreated, folderUpdated, folderDeleted
  if (event === "folderDeleted") {
    const folderId = String(payload.folder_id ?? "");
    if (!folderId) return;
    await withDbAttribution("clickup:webhook:deleteFolder", async () => {
      const db = getDb();
      await db.delete(clickupFolders).where(eq(clickupFolders.id, folderId));
    });
    return;
  }

  if (event === "folderCreated" || event === "folderUpdated") {
    const folderId = String(payload.folder_id ?? "");
    if (!folderId) return;
    const token = await getAnyClickUpToken();
    if (!token) return;
    const folder = await cu.getFolder(token, folderId).catch(() => null);
    if (!folder?.id) return;
    await withDbAttribution("clickup:webhook:upsertFolder", async () => {
      const db = getDb();
      const spaceId = String(folder.space?.id ?? "");
      await db.insert(clickupFolders).values({
        id: String(folder.id),
        spaceId,
        name: folder.name ?? "",
        orderIndex: folder.orderindex ?? null,
        override_statuses: folder.override_statuses ?? null,
        hidden: !!folder.hidden,
        archived: !!folder.archived,
        syncedAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: clickupFolders.id,
        set: {
          name: folder.name ?? "",
          hidden: !!folder.hidden,
          archived: !!folder.archived,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
    return;
  }

  // List events: listCreated, listUpdated, listDeleted
  if (event === "listDeleted") {
    const listId = String(payload.list_id ?? "");
    if (!listId) return;
    await withDbAttribution("clickup:webhook:deleteList", async () => {
      const db = getDb();
      await db.delete(clickupLists).where(eq(clickupLists.id, listId));
    });
    return;
  }

  if (event === "listCreated" || event === "listUpdated") {
    const listId = String(payload.list_id ?? "");
    if (!listId) return;
    const token = await getAnyClickUpToken();
    if (!token) return;
    const list = await cu.getList(token, listId).catch(() => null);
    if (!list?.id) return;
    await withDbAttribution("clickup:webhook:upsertList", async () => {
      const db = getDb();
      const spaceId = String(list.space?.id ?? "");
      const folderId = list.folder?.id && !list.folder?.hidden ? String(list.folder.id) : null;
      await db.insert(clickupLists).values({
        id: String(list.id),
        spaceId,
        folderId,
        name: list.name ?? "",
        orderIndex: list.orderindex ?? null,
        content: list.content ?? null,
        status: list.status?.status ?? null,
        taskCount: typeof list.task_count === "number" ? list.task_count : null,
        archived: !!list.archived,
        statuses: list.statuses ?? null,
        syncedAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: clickupLists.id,
        set: {
          name: list.name ?? "",
          content: list.content ?? null,
          taskCount: typeof list.task_count === "number" ? list.task_count : null,
          archived: !!list.archived,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
    return;
  }
}
