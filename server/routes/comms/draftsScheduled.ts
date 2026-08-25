// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — drafts & scheduled sends.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Drafts, Scheduled messages.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { RESIZABLE_IMAGE_TYPES, generateAttachmentThumbnail } from "../../services/commsAttachmentThumbnailBackfill";
import { getUserId, objectStorage } from "./shared";
import { commsUpload } from "./clientAndAttachments";

export function registerCommsDraftScheduledRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Drafts
  // ──────────────────────────────────────────────────────────────────────────

  // PUT /api/comms/channels/:id/draft — upsert a draft for the current user
  app.put("/api/comms/channels/:id/draft", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const { content = "", parentId = null, metadata } = req.body ?? {};
      // Delete the draft when both content and metadata attachments are empty.
      // An attachment-only draft (no text yet) must not be prematurely cleared.
      const hasAttachments = Array.isArray(metadata?.attachments) && metadata.attachments.length > 0;
      if (!content.trim() && !hasAttachments) {
        await commsStorage.deleteDraft(userId, channelId, parentId ?? null);
        // SSE so other sessions by same user know the draft was cleared.
        broadcastTwilioEvent({
          type: "comms:draft",
          action: "deleted",
          channelId,
          parentId: parentId ?? null,
          targetUserIds: [userId],
        });
        return res.json({ ok: true, deleted: true });
      }
      const draft = await commsStorage.upsertDraft(userId, channelId, parentId ?? null, content, metadata);
      broadcastTwilioEvent({
        type: "comms:draft",
        action: "upserted",
        channelId,
        parentId: parentId ?? null,
        targetUserIds: [userId],
      });
      res.json(draft);
    } catch (err: any) {
      console.error("[Comms] Draft upsert error:", err.message);
      res.status(500).json({ error: "Failed to save draft" });
    }
  });

  // GET /api/comms/channels/:id/draft — fetch draft for the current user
  app.get("/api/comms/channels/:id/draft", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const parentId = (req.query.parentId as string) ?? null;
      const draft = await commsStorage.getDraft(userId, channelId, parentId);
      res.json(draft ?? null);
    } catch (err: any) {
      console.error("[Comms] Draft get error:", err.message);
      res.status(500).json({ error: "Failed to get draft" });
    }
  });

  // DELETE /api/comms/channels/:id/draft — delete draft for the current user
  app.delete("/api/comms/channels/:id/draft", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const parentId = (req.query.parentId as string) ?? null;
      await commsStorage.deleteDraft(userId, channelId, parentId);
      broadcastTwilioEvent({
        type: "comms:draft",
        action: "deleted",
        channelId,
        parentId,
        targetUserIds: [userId],
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Draft delete error:", err.message);
      res.status(500).json({ error: "Failed to delete draft" });
    }
  });

  // GET /api/comms/drafts — list all drafts for the current user
  app.get("/api/comms/drafts", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const drafts = await commsStorage.listDraftsForUser(userId);
      res.json(drafts);
    } catch (err: any) {
      console.error("[Comms] List drafts error:", err.message);
      res.status(500).json({ error: "Failed to list drafts" });
    }
  });

  // POST /api/comms/channels/:id/draft/attachments — pre-upload a file so
  // draft attachments can be fully restored across sessions (not metadata-only).
  // Returns { objectKey, filename, contentType, sizeBytes } for storage in
  // draft.metadata.attachments; the attachment download endpoint serves it back.
  app.post(
    "/api/comms/channels/:id/draft/attachments",
    isAuthenticated,
    commsUpload.single("file"),
    async (req: any, res) => {
      try {
        const userId = getUserId(req);
        const channel = await commsStorage.getChannelById(req.params.id);
        if (!channel) return res.status(404).json({ error: "Channel not found" });
        const isMember = await commsStorage.isChannelMember(channel.id, userId);
        if (!isMember) return res.status(403).json({ error: "Not a member" });
        if (!req.file) return res.status(400).json({ error: "No file provided" });
        const ext = req.file.originalname.split(".").pop() ?? "bin";
        const fileId = randomUUID();
        const objectKey = `comms-draft-attachments/${fileId}.${ext}`;
        const stream = Readable.from(req.file.buffer);
        await objectStorage.streamUploadToPrivateKey(objectKey, stream, req.file.mimetype);

        // Same best-effort 600px webp thumbnail pipeline as message uploads,
        // stored under the draft prefix so the DB-row-less draft serving
        // branch of GET /api/comms/attachments/* covers it. Restoring a
        // draft can then preview the small thumb instead of full-size bytes.
        let thumbnailKey: string | null = null;
        if (RESIZABLE_IMAGE_TYPES.has(req.file.mimetype)) {
          try {
            thumbnailKey = await generateAttachmentThumbnail(
              req.file.buffer,
              fileId,
              "comms-draft-attachments/thumb/",
            );
          } catch (thumbErr: any) {
            console.warn(
              "[Comms] Draft pre-upload thumbnail generation failed (falling back to full-res):",
              thumbErr?.message ?? thumbErr,
            );
          }
        }

        res.json({
          objectKey,
          thumbnailKey,
          filename: req.file.originalname,
          contentType: req.file.mimetype,
          sizeBytes: req.file.size,
        });
      } catch (err: any) {
        console.error("[Comms] Draft attachment pre-upload error:", err.message);
        res.status(500).json({ error: "Failed to pre-upload draft attachment" });
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Scheduled messages
  // ──────────────────────────────────────────────────────────────────────────

  const scheduleSchema = z.object({
    content: z.string().min(1),
    scheduledFor: z.string().refine((s) => !isNaN(Date.parse(s)), { message: "Invalid date" }),
    parentId: z.string().nullish(),
    metadata: z.unknown().optional(),
  });

  // POST /api/comms/channels/:id/scheduled-messages — schedule a message
  app.post("/api/comms/channels/:id/scheduled-messages", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const isMember = await commsStorage.isChannelMember(channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Access denied" });
      const parsed = scheduleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const scheduledFor = new Date(parsed.data.scheduledFor);
      if (scheduledFor <= new Date()) {
        return res.status(400).json({ error: "scheduledFor must be in the future" });
      }
      const msg = await commsStorage.createScheduledMessage({
        userId,
        channelId,
        parentId: parsed.data.parentId ?? null,
        content: parsed.data.content,
        metadata: parsed.data.metadata,
        scheduledFor,
      });
      broadcastTwilioEvent({
        type: "comms:scheduled_message",
        action: "created",
        channelId,
        scheduledMessageId: msg.id,
        targetUserIds: [userId],
      });
      res.status(201).json(msg);
    } catch (err: any) {
      console.error("[Comms] Schedule message error:", err.message);
      res.status(500).json({ error: "Failed to schedule message" });
    }
  });

  // GET /api/comms/channels/:id/scheduled-messages — list pending scheduled messages for channel
  app.get("/api/comms/channels/:id/scheduled-messages", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channelId = req.params.id;
      const msgs = await commsStorage.listScheduledMessagesForChannel(channelId, userId);
      res.json(msgs);
    } catch (err: any) {
      console.error("[Comms] List scheduled messages error:", err.message);
      res.status(500).json({ error: "Failed to list scheduled messages" });
    }
  });

  // GET /api/comms/scheduled-messages — list all pending scheduled messages for the user
  app.get("/api/comms/scheduled-messages", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const msgs = await commsStorage.listAllScheduledMessagesForUser(userId);
      res.json(msgs);
    } catch (err: any) {
      console.error("[Comms] List all scheduled messages error:", err.message);
      res.status(500).json({ error: "Failed to list scheduled messages" });
    }
  });

  // PATCH /api/comms/scheduled-messages/:id — edit content or scheduled time (while pending)
  app.patch("/api/comms/scheduled-messages/:id", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;
      const existing = await commsStorage.getScheduledMessageById(id);
      if (!existing) return res.status(404).json({ error: "Scheduled message not found" });
      if (existing.userId !== userId) return res.status(403).json({ error: "Forbidden" });
      if (existing.status !== "pending") {
        return res.status(409).json({ error: "Cannot edit a message that is not pending" });
      }
      const updateSchema = z.object({
        content: z.string().min(1).optional(),
        scheduledFor: z.string().refine((s) => !isNaN(Date.parse(s)), { message: "Invalid date" }).optional(),
      });
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const updates: Record<string, any> = {};
      if (parsed.data.content) updates.content = parsed.data.content;
      if (parsed.data.scheduledFor) {
        const sf = new Date(parsed.data.scheduledFor);
        if (sf <= new Date()) return res.status(400).json({ error: "scheduledFor must be in the future" });
        updates.scheduledFor = sf;
      }
      const updated = await commsStorage.updateScheduledMessage(id, updates);
      broadcastTwilioEvent({
        type: "comms:scheduled_message",
        action: "updated",
        channelId: existing.channelId,
        scheduledMessageId: id,
        targetUserIds: [userId],
      });
      res.json(updated);
    } catch (err: any) {
      console.error("[Comms] Edit scheduled message error:", err.message);
      res.status(500).json({ error: "Failed to edit scheduled message" });
    }
  });

  // DELETE /api/comms/scheduled-messages/:id — cancel a scheduled message
  app.delete("/api/comms/scheduled-messages/:id", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;
      const existing = await commsStorage.getScheduledMessageById(id);
      if (!existing || existing.status !== "pending") {
        return res.status(404).json({ error: "Scheduled message not found or not pending" });
      }
      if (existing.userId !== userId) return res.status(403).json({ error: "Forbidden" });
      const cancelled = await commsStorage.cancelScheduledMessage(id, userId);
      if (!cancelled) {
        return res.status(404).json({ error: "Scheduled message not found or not pending" });
      }
      broadcastTwilioEvent({
        type: "comms:scheduled_message",
        action: "cancelled",
        channelId: cancelled.channelId,
        scheduledMessageId: id,
        targetUserIds: [userId],
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Cancel scheduled message error:", err.message);
      res.status(500).json({ error: "Failed to cancel scheduled message" });
    }
  });

}
