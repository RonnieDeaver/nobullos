// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — bookmarks & channel broadcast.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: @channel broadcast, Bookmarks.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { getUser } from "../../storage/clientStorage";
import { getUserId, isChannelAdminFor } from "./shared";

export function registerCommsBookmarkRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // @channel / @here broadcast notifications
  // ──────────────────────────────────────────────────────────────────────────
  // These tokens are detected server-side when messages are sent via the normal
  // POST /api/comms/channels/:id/messages path. The existing broadcast path
  // already delivers the SSE event to all channel members. @channel/@here
  // trigger additional in-app notifications to non-muted members.
  // This helper is called inline from the message-send path.

  // ──────────────────────────────────────────────────────────────────────────
  // Channel bookmarks
  const MAX_BOOKMARKS_PER_CHANNEL = 25;
  // ──────────────────────────────────────────────────────────────────────────

  const createBookmarkSchema = z.union([
    z.object({
      type: z.literal("link"),
      label: z.string().min(1).max(200),
      emoji: z.string().max(64).nullable().optional(),
      url: z.string().url().max(2000),
    }),
    z.object({
      type: z.literal("file"),
      label: z.string().min(1).max(200),
      emoji: z.string().max(64).nullable().optional(),
      attachmentId: z.string().optional(),
      objectKey: z.string().max(512).optional(),
      filename: z.string().max(512).optional(),
    }),
  ]);

  const updateBookmarkSchema = z.object({
    label: z.string().min(1).max(200).optional(),
    emoji: z.string().max(64).nullable().optional(),
    url: z.string().url().max(2000).nullable().optional(),
  });

  const reorderBookmarksSchema = z.object({
    ids: z.array(z.string()).min(1).max(MAX_BOOKMARKS_PER_CHANNEL),
  });

  // GET /api/comms/channels/:id/bookmarks — list bookmarks (any member)
  app.get("/api/comms/channels/:id/bookmarks", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const isMember = await commsStorage.isChannelMember(channelId, userId, { allowArchived: true });
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const bookmarks = await commsStorage.listBookmarksForChannel(channelId);
      res.json(bookmarks);
    } catch (err: any) {
      console.error("[Comms] List bookmarks error:", err.message);
      res.status(500).json({ error: "Failed to list bookmarks" });
    }
  });

  // POST /api/comms/channels/:id/bookmarks — create bookmark (any member)
  app.post("/api/comms/channels/:id/bookmarks", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const channel = await commsStorage.getChannelById(channelId);
      if (!channel || channel.archivedAt) return res.status(404).json({ error: "Channel not found" });
      const isMember = await commsStorage.isChannelMember(channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const parsed = createBookmarkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const existing = await commsStorage.listBookmarksForChannel(channelId);
      if (existing.length >= MAX_BOOKMARKS_PER_CHANNEL) {
        return res.status(422).json({
          error: `This channel already has the maximum of ${MAX_BOOKMARKS_PER_CHANNEL} bookmarks. Remove one before adding another.`,
        });
      }
      const data = parsed.data;
      const bookmark = await commsStorage.createBookmark({
        channelId,
        type: data.type,
        label: data.label,
        emoji: data.emoji ?? null,
        url: data.type === "link" ? data.url : null,
        attachmentId: data.type === "file" ? (data.attachmentId ?? null) : null,
        objectKey: data.type === "file" ? (data.objectKey ?? null) : null,
        filename: data.type === "file" ? (data.filename ?? null) : null,
        createdBy: userId,
      });
      // System message
      const actor = await getUser(userId).catch(() => null);
      const actorName = actor ? [actor.firstName, actor.lastName].filter(Boolean).join(" ") : "Someone";
      await commsStorage.createMessage({
        channelId,
        userId: null,
        content: `${actorName} added a bookmark: ${bookmark.label}`,
        contentType: "system",
        metadata: { type: "bookmark_added", bookmarkId: bookmark.id },
      });
      const memberIds = await commsStorage.getChannelMemberIds(channelId);
      broadcastTwilioEvent({
        type: "comms:bookmark",
        action: "created",
        channelId,
        bookmark,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.status(201).json(bookmark);
    } catch (err: any) {
      console.error("[Comms] Create bookmark error:", err.message);
      res.status(500).json({ error: "Failed to create bookmark" });
    }
  });

  // PATCH /api/comms/channels/:id/bookmarks/:bId — update bookmark (channel_admin or team_lead)
  app.patch("/api/comms/channels/:id/bookmarks/:bId", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { id: channelId, bId } = req.params;
      const existing = await commsStorage.getBookmarkById(bId);
      if (!existing || existing.channelId !== channelId) return res.status(404).json({ error: "Bookmark not found" });
      const channelForUpdate = await commsStorage.getChannelById(channelId);
      if (!channelForUpdate) return res.status(404).json({ error: "Channel not found" });
      if (channelForUpdate.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isAdmin = await isChannelAdminFor(req, channelId);
      if (!isAdmin) return res.status(403).json({ error: "Requires channel admin or team lead role" });
      const parsed = updateBookmarkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const updated = await commsStorage.updateBookmark(bId, parsed.data);
      if (!updated) return res.status(404).json({ error: "Bookmark not found" });
      const memberIds = await commsStorage.getChannelMemberIds(channelId);
      broadcastTwilioEvent({
        type: "comms:bookmark",
        action: "updated",
        channelId,
        bookmark: updated,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.json(updated);
    } catch (err: any) {
      console.error("[Comms] Update bookmark error:", err.message);
      res.status(500).json({ error: "Failed to update bookmark" });
    }
  });

  // DELETE /api/comms/channels/:id/bookmarks/:bId — delete bookmark (channel_admin or team_lead)
  app.delete("/api/comms/channels/:id/bookmarks/:bId", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { id: channelId, bId } = req.params;
      const existing = await commsStorage.getBookmarkById(bId);
      if (!existing || existing.channelId !== channelId) return res.status(404).json({ error: "Bookmark not found" });
      const channelForDelete = await commsStorage.getChannelById(channelId);
      if (!channelForDelete) return res.status(404).json({ error: "Channel not found" });
      if (channelForDelete.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isAdmin = await isChannelAdminFor(req, channelId);
      if (!isAdmin) return res.status(403).json({ error: "Requires channel admin or team lead role" });
      await commsStorage.deleteBookmark(bId);
      // System message
      const actor = await getUser(userId).catch(() => null);
      const actorName = actor ? [actor.firstName, actor.lastName].filter(Boolean).join(" ") : "Someone";
      await commsStorage.createMessage({
        channelId,
        userId: null,
        content: `${actorName} removed a bookmark: ${existing.label}`,
        contentType: "system",
        metadata: { type: "bookmark_removed", bookmarkId: bId },
      });
      const memberIds = await commsStorage.getChannelMemberIds(channelId);
      broadcastTwilioEvent({
        type: "comms:bookmark",
        action: "deleted",
        channelId,
        bookmarkId: bId,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Delete bookmark error:", err.message);
      res.status(500).json({ error: "Failed to delete bookmark" });
    }
  });

  // PUT /api/comms/channels/:id/bookmarks/reorder — reorder (channel_admin or team_lead)
  app.put("/api/comms/channels/:id/bookmarks/reorder", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const { id: channelId } = req.params;
      const channelForReorder = await commsStorage.getChannelById(channelId);
      if (!channelForReorder) return res.status(404).json({ error: "Channel not found" });
      if (channelForReorder.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isAdmin = await isChannelAdminFor(req, channelId);
      if (!isAdmin) return res.status(403).json({ error: "Requires channel admin or team lead role" });
      const parsed = reorderBookmarksSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      await commsStorage.reorderBookmarks(channelId, parsed.data.ids);
      const bookmarks = await commsStorage.listBookmarksForChannel(channelId);
      const memberIds = await commsStorage.getChannelMemberIds(channelId);
      broadcastTwilioEvent({
        type: "comms:bookmark",
        action: "reordered",
        channelId,
        bookmarks,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.json(bookmarks);
    } catch (err: any) {
      console.error("[Comms] Reorder bookmarks error:", err.message);
      res.status(500).json({ error: "Failed to reorder bookmarks" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Incoming webhooks — public token-authenticated POST endpoint
  // ──────────────────────────────────────────────────────────────────────────
  // No session auth required. Rate-limited by IP (60 req/min, not role-scaled).

  app.post("/api/comms/incoming/:token", async (req: any, res) => {
    const rawToken = req.params.token;
    if (!rawToken || rawToken.length < 8) {
      res.status(400).json({ error: "Invalid token" });
      return;
    }

    const hash = createHash("sha256").update(rawToken).digest("hex");

    let wh;
    try {
      wh = await commsStorage.getWebhookByTokenHash(hash);
    } catch (err: any) {
      console.error("[Comms] Webhook token lookup error:", err.message);
      res.status(500).json({ error: "Internal error" });
      return;
    }

    if (!wh || !wh.enabled) {
      res.status(401).json({ error: "Invalid or revoked webhook token" });
      return;
    }

    const body = req.body ?? {};
    const { text, fields, link, source } = body;

    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({ error: "text exceeds 4000-character limit" });
      return;
    }

    let channel;
    try {
      channel = await commsStorage.getChannelById(wh.channelId);
    } catch (err: any) {
      console.error("[Comms] Webhook channel lookup error:", err.message);
      res.status(500).json({ error: "Internal error" });
      return;
    }

    if (!channel || channel.archivedAt) {
      res.status(404).json({ error: "Channel not found or archived" });
      return;
    }

    const metadata: Record<string, unknown> = { type: "bot_message" };
    if (source) metadata.source = source;
    if (fields) metadata.fields = fields;
    if (link) metadata.link = link;

    try {
      const msg = await commsStorage.createMessage({
        channelId: wh.channelId,
        userId: null,
        content: text.trim(),
        contentType: "bot",
        metadata,
      });

      // Touch last_used_at (fire-and-forget, non-critical)
      commsStorage.touchWebhookLastUsed(wh.id).catch(() => {});

      // Broadcast SSE to channel members
      const memberIds = await commsStorage.getChannelMemberIds(wh.channelId).catch(() => null);
      broadcastTwilioEvent({
        type: "comms:message",
        channelId: wh.channelId,
        message: {
          ...msg,
          user: null,
          createdAt: msg.createdAt.toISOString(),
          updatedAt: msg.updatedAt.toISOString(),
          editedAt: null,
          deletedAt: null,
        },
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      res.status(200).json({ ok: true, messageId: msg.id });
    } catch (err: any) {
      console.error("[Comms] Webhook post error:", err.message);
      res.status(500).json({ error: "Failed to post message" });
    }
  });

}
