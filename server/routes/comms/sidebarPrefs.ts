// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — sidebar & preferences.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Sidebar categories, Notification preferences, Global notification settings, Pins, Saved messages.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { getUserId, objectStorage } from "./shared";

export function registerCommsSidebarPrefRoutes(app: Express): void {
  // ─── Sidebar Categories ──────────────────────────────────────────────────────
  // Per-user sidebar categories: favorites, channels, dms (built-in) + custom.
  // Favorites toggle is the primary "pin" migration surface.
  // ─────────────────────────────────────────────────────────────────────────────

  // GET /api/comms/sidebar/categories
  app.get("/api/comms/sidebar/categories", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    try {
      const categories = await commsStorage.getSidebarCategoriesForUser(userId);
      res.json(categories);
    } catch (err: any) {
      console.error("[Comms] getSidebarCategories error:", err.message);
      res.status(500).json({ error: "Failed to load sidebar categories" });
    }
  });

  const createCategorySchema = z.object({ name: z.string().min(1).max(80) });

  // POST /api/comms/sidebar/categories
  app.post("/api/comms/sidebar/categories", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const parsed = createCategorySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "name is required (max 80 chars)" }); return;
    }
    try {
      const cat = await commsStorage.createSidebarCategory(userId, parsed.data.name);
      res.status(201).json(cat);
    } catch (err: any) {
      console.error("[Comms] createSidebarCategory error:", err.message);
      res.status(500).json({ error: "Failed to create category" });
    }
  });

  const updateCategorySchema = z.object({
    name: z.string().min(1).max(80).optional(),
    collapsed: z.boolean().optional(),
    clientSubgroupCollapsed: z.boolean().optional(),
    sorting: z.enum(["recent", "alpha", "manual"]).optional(),
    unreadsOnTop: z.boolean().optional(),
  });

  // PATCH /api/comms/sidebar/categories/:id
  app.patch("/api/comms/sidebar/categories/:id", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const parsed = updateCategorySchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Invalid data" }); return; }
    try {
      const cat = await commsStorage.updateSidebarCategory(req.params.id, userId, parsed.data);
      if (!cat) { res.status(404).json({ error: "Category not found" }); return; }
      res.json(cat);
    } catch (err: any) {
      console.error("[Comms] updateSidebarCategory error:", err.message);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  // DELETE /api/comms/sidebar/categories/:id  (custom only)
  app.delete("/api/comms/sidebar/categories/:id", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    try {
      const ok = await commsStorage.deleteSidebarCategory(req.params.id, userId);
      if (!ok) { res.status(404).json({ error: "Category not found or cannot be deleted" }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] deleteSidebarCategory error:", err.message);
      res.status(500).json({ error: "Failed to delete category" });
    }
  });

  const reorderCategoriesSchema = z.object({ orderedIds: z.array(z.string()).min(1) });

  // PUT /api/comms/sidebar/categories/order
  app.put("/api/comms/sidebar/categories/order", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const parsed = reorderCategoriesSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "orderedIds required" }); return; }
    try {
      await commsStorage.reorderSidebarCategories(userId, parsed.data.orderedIds);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] reorderSidebarCategories error:", err.message);
      res.status(500).json({ error: "Failed to reorder categories" });
    }
  });

  const addChannelSchema = z.object({ channelId: z.string().min(1) });

  // POST /api/comms/sidebar/categories/:id/channels  { channelId }
  app.post("/api/comms/sidebar/categories/:id/channels", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const categoryId = req.params.id;
    const parsed = addChannelSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "channelId required" }); return; }
    try {
      const isMember = await commsStorage.isChannelMember(parsed.data.channelId, userId);
      if (!isMember) { res.status(403).json({ error: "Not a channel member" }); return; }
      await commsStorage.addChannelToCategory(categoryId, userId, parsed.data.channelId);
      res.status(201).json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] addChannelToCategory error:", err.message);
      res.status(500).json({ error: "Failed to add channel to category" });
    }
  });

  // DELETE /api/comms/sidebar/categories/:id/channels/:channelId
  app.delete(
    "/api/comms/sidebar/categories/:id/channels/:channelId",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      try {
        await commsStorage.removeChannelFromCategory(req.params.id, userId, req.params.channelId);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[Comms] removeChannelFromCategory error:", err.message);
        res.status(500).json({ error: "Failed to remove channel from category" });
      }
    },
  );

  const reorderItemsSchema = z.object({ orderedChannelIds: z.array(z.string()).min(1) });

  // PUT /api/comms/sidebar/categories/:id/channels/order
  app.put(
    "/api/comms/sidebar/categories/:id/channels/order",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      const parsed = reorderItemsSchema.safeParse(req.body ?? {});
      if (!parsed.success) { res.status(400).json({ error: "orderedChannelIds required" }); return; }
      try {
        await commsStorage.reorderCategoryItems(req.params.id, userId, parsed.data.orderedChannelIds);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[Comms] reorderCategoryItems error:", err.message);
        res.status(500).json({ error: "Failed to reorder items" });
      }
    },
  );

  const migratePinsSchema = z.object({ channelIds: z.array(z.string()) });

  // POST /api/comms/sidebar/favorites/migrate  — must be registered BEFORE :channelId
  app.post("/api/comms/sidebar/favorites/migrate", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const parsed = migratePinsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "channelIds required" }); return; }
    try {
      await commsStorage.migratePinsToFavorites(userId, parsed.data.channelIds);
      broadcastTwilioEvent({ type: "comms:sidebar", userId });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] migratePins error:", err.message);
      res.status(500).json({ error: "Failed to migrate pins" });
    }
  });

  // POST /api/comms/sidebar/favorites/:channelId  (toggle add/remove) — after /migrate
  app.post("/api/comms/sidebar/favorites/:channelId", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const { channelId } = req.params;
    try {
      const isMember = await commsStorage.isChannelMember(channelId, userId);
      if (!isMember) { res.status(403).json({ error: "Not a channel member" }); return; }
      const favorited = await commsStorage.toggleFavoriteChannel(userId, channelId);
      broadcastTwilioEvent({ type: "comms:sidebar", userId });
      res.json({ favorited });
    } catch (err: any) {
      console.error("[Comms] toggleFavorite error:", err.message);
      res.status(500).json({ error: "Failed to toggle favorite" });
    }
  });

  // The objectKey may contain slashes (e.g. "comms-attachments/uuid.ext")
  app.get("/api/comms/attachments/*", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const objectKey = (req.params as any)[0] as string;
      if (!objectKey) return res.status(400).json({ error: "objectKey required" });

      // Draft pre-upload files live under a separate prefix and have no DB row.
      // Authentication is already checked by isAuthenticated; the UUID provides
      // sufficient entropy to prevent enumeration.
      if (objectKey.startsWith("comms-draft-attachments/")) {
        let draftFile: any;
        try {
          draftFile = await objectStorage.getPrivateObjectFileByKey(objectKey);
        } catch {
          return res.status(404).json({ error: "Draft attachment not found" });
        }
        const filename = objectKey.split("/").pop() ?? "attachment";
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
        await objectStorage.downloadObject(draftFile, res, 3600);
        return;
      }

      // Thumbnail keys live under a thumb/ prefix and are recorded on the
      // attachment row's thumbnail_key column rather than object_key.
      const isThumb = objectKey.startsWith("comms-attachments/thumb/");
      const att = isThumb
        ? await commsStorage.getAttachmentByThumbnailKey(objectKey)
        : await commsStorage.getAttachmentByKey(objectKey);
      if (!att) return res.status(404).json({ error: "Attachment not found" });

      const msg = await commsStorage.getMessageById(att.messageId);
      if (!msg) return res.status(404).json({ error: "Message not found" });

      const isMember = await commsStorage.isChannelMember(msg.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Access denied" });

      let file: any;
      try {
        file = await objectStorage.getPrivateObjectFileByKey(objectKey);
      } catch {
        return res.status(404).json({ error: "File not found in storage" });
      }
      res.setHeader("Content-Disposition", `inline; filename="${att.filename}"`);
      await objectStorage.downloadObject(file, res, 3600);
    } catch (err: any) {
      console.error("[Comms] Attachment download error:", err.message);
      res.status(500).json({ error: "Failed to download attachment" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Notification preferences
  // ──────────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // Global notification settings (per-user)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/comms/notification-settings
   * Returns the current user's global notification preferences and keyword list.
   * Absent DB row → all-defaults response (no 404).
   */
  app.get("/api/comms/notification-settings", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const settings = await commsStorage.getUserNotificationSettings(userId);
      res.json({
        globalDefault: settings?.globalDefault ?? "all",
        soundEnabled: settings?.soundEnabled ?? true,
        soundChoice: settings?.soundChoice ?? "default",
        desktopEnabled: settings?.desktopEnabled ?? false,
        suppressSnippetPrivate: settings?.suppressSnippetPrivate ?? false,
        keywords: settings?.keywords ?? [],
      });
    } catch (err: any) {
      console.error("[Comms] Get notification settings error:", err.message);
      res.status(500).json({ error: "Failed to get notification settings" });
    }
  });

  const notifSettingsSchema = z.object({
    globalDefault: z.enum(["all", "mentions", "nothing"]).optional(),
    soundEnabled: z.boolean().optional(),
    soundChoice: z.enum(["default", "ding", "subtle"]).optional(),
    desktopEnabled: z.boolean().optional(),
    suppressSnippetPrivate: z.boolean().optional(),
    keywords: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  });

  /**
   * PUT /api/comms/notification-settings
   * Upserts global notification preferences. Partial updates are fine —
   * only provided fields are updated.
   */
  app.put("/api/comms/notification-settings", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = notifSettingsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const data = parsed.data;
      // Deduplicate and normalise keywords
      if (data.keywords) {
        data.keywords = [...new Set(data.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
      }
      const row = await commsStorage.upsertUserNotificationSettings(userId, data);
      res.json({
        globalDefault: row.globalDefault,
        soundEnabled: row.soundEnabled,
        soundChoice: row.soundChoice,
        desktopEnabled: row.desktopEnabled,
        suppressSnippetPrivate: row.suppressSnippetPrivate,
        keywords: row.keywords,
      });
    } catch (err: any) {
      console.error("[Comms] Update notification settings error:", err.message);
      res.status(500).json({ error: "Failed to update notification settings" });
    }
  });

  app.get("/api/comms/channels/:id/notification-pref", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const isMember = await commsStorage.isChannelMember(req.params.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const pref = await commsStorage.getNotificationPref(req.params.id, userId);
      res.json({ pref: pref?.pref ?? "all" });
    } catch (err: any) {
      console.error("[Comms] Get notif pref error:", err.message);
      res.status(500).json({ error: "Failed to get notification preference" });
    }
  });

  app.put("/api/comms/channels/:id/notification-pref", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const isMember = await commsStorage.isChannelMember(req.params.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const pref = req.body?.pref;
      if (!["all", "mentions", "muted"].includes(pref)) {
        return res.status(400).json({ error: "pref must be all|mentions|muted" });
      }
      const row = await commsStorage.setNotificationPref(req.params.id, userId, pref);
      res.json(row);
    } catch (err: any) {
      console.error("[Comms] Set notif pref error:", err.message);
      res.status(500).json({ error: "Failed to set notification preference" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pins
  // ──────────────────────────────────────────────────────────────────────────

  app.post("/api/comms/messages/:id/pin", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const msg = await commsStorage.getMessageById(req.params.id);
      if (!msg) return res.status(404).json({ error: "Message not found" });
      const channelForPin = await commsStorage.getChannelById(msg.channelId);
      if (channelForPin?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isMember = await commsStorage.isChannelMember(msg.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const result = await commsStorage.pinMessage(msg.channelId, msg.id, userId);
      if (result.pinned) {
        const memberIds = await commsStorage.getChannelMemberIds(msg.channelId);
        broadcastTwilioEvent({
          type: "comms:pin",
          channelId: msg.channelId,
          messageId: msg.id,
          pinAction: "pin",
          pinnedBy: userId,
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });
      }
      res.json(result);
    } catch (err: any) {
      console.error("[Comms] Pin error:", err.message);
      res.status(500).json({ error: "Failed to pin message" });
    }
  });

  app.delete("/api/comms/messages/:id/pin", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const msg = await commsStorage.getMessageById(req.params.id);
      if (!msg) return res.status(404).json({ error: "Message not found" });
      const channelForUnpin = await commsStorage.getChannelById(msg.channelId);
      if (channelForUnpin?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isMember = await commsStorage.isChannelMember(msg.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const result = await commsStorage.unpinMessage(msg.channelId, msg.id);
      if (result.unpinned) {
        const memberIds = await commsStorage.getChannelMemberIds(msg.channelId);
        broadcastTwilioEvent({
          type: "comms:pin",
          channelId: msg.channelId,
          messageId: msg.id,
          pinAction: "unpin",
          pinnedBy: userId,
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });
      }
      res.json(result);
    } catch (err: any) {
      console.error("[Comms] Unpin error:", err.message);
      res.status(500).json({ error: "Failed to unpin message" });
    }
  });

  app.get("/api/comms/channels/:id/pins", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const isMember = await commsStorage.isChannelMember(req.params.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const pins = await commsStorage.getPinnedMessages(req.params.id);
      res.json(pins);
    } catch (err: any) {
      console.error("[Comms] Get pins error:", err.message);
      res.status(500).json({ error: "Failed to get pinned messages" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Saved messages
  // ──────────────────────────────────────────────────────────────────────────

  app.post("/api/comms/messages/:id/save", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const msg = await commsStorage.getMessageById(req.params.id);
      if (!msg) return res.status(404).json({ error: "Message not found" });
      const isMember = await commsStorage.isChannelMember(msg.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const result = await commsStorage.saveMessage(userId, msg.id);
      res.json(result);
    } catch (err: any) {
      console.error("[Comms] Save error:", err.message);
      res.status(500).json({ error: "Failed to save message" });
    }
  });

  app.delete("/api/comms/messages/:id/save", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const result = await commsStorage.unsaveMessage(userId, req.params.id);
      res.json(result);
    } catch (err: any) {
      console.error("[Comms] Unsave error:", err.message);
      res.status(500).json({ error: "Failed to unsave message" });
    }
  });

  app.get("/api/comms/saved", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const limit = parseInt(req.query.limit as string) || 50;
      const messages = await commsStorage.getSavedMessages(userId, { limit });
      res.json(messages);
    } catch (err: any) {
      console.error("[Comms] Get saved error:", err.message);
      res.status(500).json({ error: "Failed to get saved messages" });
    }
  });

}
