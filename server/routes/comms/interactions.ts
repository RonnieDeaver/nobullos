// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — message interactions.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Reminders, Forwarding, Typing indicators, Reactions, Read states, DMs, Search.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { getUser } from "../../storage/clientStorage";
import { getUserId } from "./shared";

export function registerCommsInteractionRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Reminders (Task #3254)

  const createReminderSchema = z.object({
    remindAt: z.string().refine((v) => !isNaN(new Date(v).getTime()), "Invalid date"),
    note: z.string().max(500).optional(),
  });

  // POST /api/comms/messages/:id/reminders — set a reminder on a message
  app.post("/api/comms/messages/:id/reminders", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const message = await commsStorage.getMessageById(req.params.id);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const isMember = await commsStorage.isChannelMember(message.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const parsed = createReminderSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const remindAt = new Date(parsed.data.remindAt);
      if (remindAt.getTime() <= Date.now()) {
        return res.status(400).json({ error: "Reminder must be in the future" });
      }
      const reminder = await commsStorage.createReminder(
        userId,
        message.id,
        message.channelId,
        remindAt,
        parsed.data.note,
      );
      res.status(201).json(reminder);
    } catch (err: any) {
      console.error("[Comms] Create reminder error:", err.message);
      res.status(500).json({ error: "Failed to create reminder" });
    }
  });

  // GET /api/comms/reminders — list own pending reminders
  app.get("/api/comms/reminders", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const reminders = await commsStorage.listRemindersForUser(userId);
      res.json(reminders);
    } catch (err: any) {
      console.error("[Comms] List reminders error:", err.message);
      res.status(500).json({ error: "Failed to list reminders" });
    }
  });

  // DELETE /api/comms/reminders/:id — cancel own pending reminder
  app.delete("/api/comms/reminders/:id", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const ok = await commsStorage.cancelReminder(req.params.id, userId);
      if (!ok) return res.status(404).json({ error: "Reminder not found" });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Cancel reminder error:", err.message);
      res.status(500).json({ error: "Failed to cancel reminder" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Forwarding (Task #3254)

  const forwardSchema = z.object({
    targetChannelId: z.string().min(1),
    comment: z.string().max(10000).optional(),
  });

  // POST /api/comms/messages/:id/forward — forward a message to another channel.
  // Requires membership of BOTH the source and target channels.
  app.post("/api/comms/messages/:id/forward", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const parsed = forwardSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { targetChannelId, comment } = parsed.data;

      const source = await commsStorage.getMessageById(req.params.id);
      if (!source) return res.status(404).json({ error: "Message not found" });
      if (source.deletedAt) return res.status(410).json({ error: "Message was deleted" });
      const isSourceMember = await commsStorage.isChannelMember(source.channelId, userId);
      if (!isSourceMember) return res.status(403).json({ error: "Not a member of the source channel" });

      const target = await commsStorage.getChannelById(targetChannelId);
      if (!target) return res.status(404).json({ error: "Target channel not found" });
      if (target.archivedAt) return res.status(423).json({ error: "Target channel is archived" });
      const isTargetMember = await commsStorage.isChannelMember(target.id, userId);
      if (!isTargetMember) return res.status(403).json({ error: "Not a member of the target channel" });

      const forwarded = await commsStorage.forwardMessage(source.id, target.id, userId, comment);
      if (!forwarded) return res.status(404).json({ error: "Message not found" });

      const memberIds = await commsStorage.getChannelMemberIds(target.id);
      const sender = await getUser(userId).catch(() => undefined);
      broadcastTwilioEvent({
        type: "comms:message" as const,
        channelId: target.id,
        message: {
          ...forwarded,
          user: sender
            ? {
                id: sender.id,
                firstName: sender.firstName ?? undefined,
                lastName: sender.lastName ?? undefined,
                profileImageUrl: sender.profileImageUrl ?? undefined,
              }
            : null,
          createdAt: forwarded.createdAt.toISOString(),
          updatedAt: forwarded.updatedAt.toISOString(),
          editedAt: forwarded.editedAt?.toISOString() ?? null,
          deletedAt: forwarded.deletedAt?.toISOString() ?? null,
        },
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.status(201).json(forwarded);
    } catch (err: any) {
      console.error("[Comms] Forward message error:", err.message);
      res.status(500).json({ error: "Failed to forward message" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Typing indicators
  // ──────────────────────────────────────────────────────────────────────────
  app.post("/api/comms/channels/:id/typing", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      const isMember = await commsStorage.isChannelMember(channel.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const isTyping = req.body.isTyping !== false;
      const memberIds = await commsStorage.getChannelMemberIds(channel.id);
      broadcastTwilioEvent({
        type: "comms:typing",
        channelId: channel.id,
        userId,
        isTyping,
        // null = team-wide channel; filter is only meaningful on member arrays
        ...(memberIds !== null ? { targetUserIds: memberIds.filter((id) => id !== userId) } : {}),
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Typing error:", err.message);
      res.status(500).json({ error: "Failed to send typing indicator" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Reactions
  // ──────────────────────────────────────────────────────────────────────────
  const reactionSchema = z.object({ emoji: z.string().min(1).max(64) });

  app.post("/api/comms/messages/:id/reactions", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const message = await commsStorage.getMessageById(req.params.id);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const channelForReaction = await commsStorage.getChannelById(message.channelId);
      if (channelForReaction?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isMember = await commsStorage.isChannelMember(message.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });

      const parsed = reactionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { emoji } = parsed.data;

      const { added } = await commsStorage.addReaction(message.id, userId, emoji);
      if (added) {
        const memberIds = await commsStorage.getChannelMemberIds(message.channelId);
        broadcastTwilioEvent({
          type: "comms:reaction",
          channelId: message.channelId,
          messageId: message.id,
          emoji,
          userId,
          action: "add",
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });
      }
      res.json({ ok: true, added });
    } catch (err: any) {
      console.error("[Comms] Add reaction error:", err.message);
      res.status(500).json({ error: "Failed to add reaction" });
    }
  });

  app.delete(
    "/api/comms/messages/:id/reactions/:emoji",
    isAuthenticated,
    commsWriteLimiter,
    async (req: any, res) => {
      try {
        const userId = getUserId(req);
        const message = await commsStorage.getMessageById(req.params.id);
        if (!message) return res.status(404).json({ error: "Message not found" });
        const channelForReactionRemove = await commsStorage.getChannelById(message.channelId);
        if (channelForReactionRemove?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
        const isMember = await commsStorage.isChannelMember(message.channelId, userId);
        if (!isMember) return res.status(403).json({ error: "Not a member" });

        const emoji = decodeURIComponent(req.params.emoji);
        const { removed } = await commsStorage.removeReaction(message.id, userId, emoji);
        if (removed) {
          const memberIds = await commsStorage.getChannelMemberIds(message.channelId);
          broadcastTwilioEvent({
            type: "comms:reaction",
            channelId: message.channelId,
            messageId: message.id,
            emoji,
            userId,
            action: "remove",
            ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
          });
        }
        res.json({ ok: true, removed });
      } catch (err: any) {
        console.error("[Comms] Remove reaction error:", err.message);
        res.status(500).json({ error: "Failed to remove reaction" });
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Read states
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/channels/:id/read-state", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const isMember = await commsStorage.isChannelMember(req.params.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const rs = await commsStorage.getReadState(req.params.id, userId);
      res.json(rs ?? { channelId: req.params.id, userId, lastReadMessageId: null, lastReadAt: null });
    } catch (err: any) {
      console.error("[Comms] Get read state error:", err.message);
      res.status(500).json({ error: "Failed to get read state" });
    }
  });

  app.post("/api/comms/channels/:id/read-state", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const isMember = await commsStorage.isChannelMember(req.params.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const { lastReadMessageId } = req.body;
      const rs = await commsStorage.upsertReadState(
        req.params.id,
        userId,
        lastReadMessageId ?? null,
      );
      broadcastTwilioEvent({
        type: "comms:read_state",
        channelId: req.params.id,
        userId,
        lastReadMessageId: rs.lastReadMessageId ?? null,
        lastReadAt: rs.lastReadAt.toISOString(),
      });
      res.json(rs);
    } catch (err: any) {
      console.error("[Comms] Update read state error:", err.message);
      res.status(500).json({ error: "Failed to update read state" });
    }
  });

  app.post("/api/comms/channels/:id/mark-unread", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const isMember = await commsStorage.isChannelMember(req.params.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });
      const { messageId } = req.body;
      if (!messageId || typeof messageId !== "string") {
        return res.status(400).json({ error: "messageId required" });
      }
      const rs = await commsStorage.markUnreadFromMessage(req.params.id, userId, messageId);
      if (!rs) return res.status(404).json({ error: "Message not found in channel" });
      broadcastTwilioEvent({
        type: "comms:read_state",
        channelId: req.params.id,
        userId,
        lastReadMessageId: rs.lastReadMessageId ?? null,
        lastReadAt: rs.lastReadAt.toISOString(),
      });
      res.json(rs);
    } catch (err: any) {
      console.error("[Comms] Mark unread error:", err.message);
      res.status(500).json({ error: "Failed to mark unread" });
    }
  });

  app.post("/api/comms/read-all", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channels = await commsStorage.listChannelsForUser(userId);
      const channelIds = channels.map((c) => c.id);
      await commsStorage.markAllChannelsRead(userId, channelIds);
      broadcastTwilioEvent({
        type: "comms:read_state",
        channelId: null,
        userId,
        bulk: true,
      });
      res.json({ ok: true, count: channelIds.length });
    } catch (err: any) {
      console.error("[Comms] Read all error:", err.message);
      res.status(500).json({ error: "Failed to mark all as read" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DMs
  // ──────────────────────────────────────────────────────────────────────────
  app.post("/api/comms/dms", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const targetUserIds: string[] = req.body.userIds ?? [];
      if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return res.status(400).json({ error: "userIds required" });
      }
      const allIds = [...new Set([userId, ...targetUserIds])];
      const { channel, created } = await commsStorage.findOrCreateDmChannel(allIds);
      res.status(created ? 201 : 200).json(channel);
    } catch (err: any) {
      console.error("[Comms] Create DM error:", err.message);
      res.status(500).json({ error: "Failed to create DM" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Search
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/search", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (q.length < 2) return res.json([]);
      const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
      const fromUserId = typeof req.query.fromUserId === "string" ? req.query.fromUserId : undefined;
      const dateFrom = typeof req.query.dateFrom === "string" ? new Date(req.query.dateFrom) : undefined;
      const dateTo = typeof req.query.dateTo === "string" ? new Date(req.query.dateTo) : undefined;
      const messages = await commsStorage.searchMessagesV2(userId, q, {
        limit: 25,
        channelId,
        fromUserId,
        dateFrom: dateFrom && !isNaN(dateFrom.getTime()) ? dateFrom : undefined,
        dateTo: dateTo && !isNaN(dateTo.getTime()) ? dateTo : undefined,
      });
      res.json(messages);
    } catch (err: any) {
      console.error("[Comms] Search error:", err.message);
      res.status(500).json({ error: "Failed to search" });
    }
  });

  app.get("/api/comms/search/files", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
      const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
      const uploadedBy = typeof req.query.uploadedBy === "string" ? req.query.uploadedBy : undefined;
      const contentType = typeof req.query.contentType === "string" ? req.query.contentType : undefined;
      const dateFrom = typeof req.query.dateFrom === "string" ? new Date(req.query.dateFrom) : undefined;
      const dateTo = typeof req.query.dateTo === "string" ? new Date(req.query.dateTo) : undefined;
      const limit = typeof req.query.limit === "string" ? Math.min(parseInt(req.query.limit, 10) || 25, 50) : 25;

      if (!q && !channelId && !uploadedBy && !contentType && !dateFrom && !dateTo) {
        return res.json([]);
      }

      const results = await commsStorage.searchAttachments(userId, {
        q: q ?? undefined,
        channelId,
        uploadedBy,
        contentType,
        dateFrom: dateFrom && !isNaN(dateFrom.getTime()) ? dateFrom : undefined,
        dateTo: dateTo && !isNaN(dateTo.getTime()) ? dateTo : undefined,
        limit,
      });
      res.json(results);
    } catch (err: any) {
      console.error("[Comms] File search error:", err.message);
      res.status(500).json({ error: "Failed to search files" });
    }
  });

}
