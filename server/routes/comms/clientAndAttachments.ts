// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — client bridge & attachments.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Client comms feed, Client channel find-or-create, Attachment upload.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { isAuthenticated } from "../../middlewares/requireAuth";
import multer from "multer";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { getUser } from "../../storage/clientStorage";
import { RESIZABLE_IMAGE_TYPES, generateAttachmentThumbnail } from "../../services/commsAttachmentThumbnailBackfill";
import { getUserId, objectStorage } from "./shared";

// Shared multer instance for comms uploads (attachments here; draft
// attachments in ./draftsScheduled.ts import it). Hoisted to module scope in
// the Task #3787 split — previously function-scoped in registerCommsRoutes.
export const commsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export function registerCommsClientAndAttachmentRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Client comms feed (tagged messages for a client)
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/clients/:id/comms-feed", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const limit = parseInt(req.query.limit as string) || 30;
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      const messages = await commsStorage.getClientCommsFeed(req.params.id, userId, {
        limit,
        before,
      });
      res.json(messages);
    } catch (err: any) {
      console.error("[Comms] Client feed error:", err.message);
      res.status(500).json({ error: "Failed to get client comms feed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Client channel find-or-create (Team chatter send path)
  // ──────────────────────────────────────────────────────────────────────────
  app.post("/api/clients/:id/comms-channel", isAuthenticated, async (req: any, res) => {
    try {
      const clientId = req.params.id;
      // Delegate entirely to the canonical find-or-create helper so all
      // creation paths share the same slug logic, createdBy semantics, and
      // ON CONFLICT DO NOTHING idempotency guard. Client channels are
      // team-wide (no membership rows are needed), so no addChannelMember call.
      const rawName =
        typeof req.body?.name === "string" && req.body.name.trim()
          ? req.body.name.trim().slice(0, 80)
          : "";
      const { channel, created } = await commsStorage.provisionClientChannel(
        clientId,
        rawName,
      );
      res.status(created ? 201 : 200).json(channel);
    } catch (err: any) {
      console.error("[Comms] Client channel find-or-create error:", err.message);
      res.status(500).json({ error: "Failed to get client channel" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Attachment upload
  // ──────────────────────────────────────────────────────────────────────────


  // Image types sharp can safely downscale for thumbnails, plus the shared
  // sharp pipeline (600px webp under comms-attachments/thumb/). Task #3421
  // moved both into the backfill service so upload-time generation and the
  // backfill prod-action can never drift.

  app.post(
    "/api/comms/channels/:id/messages/upload",
    isAuthenticated,
    commsUpload.single("file"),
    async (req: any, res) => {
      try {
        const userId = getUserId(req);
        const channel = await commsStorage.getChannelById(req.params.id);
        if (!channel) return res.status(404).json({ error: "Channel not found" });
        const isMember = await commsStorage.isChannelMember(channel.id, userId);
        if (!isMember) return res.status(403).json({ error: "Not a member" });

        const content =
          typeof req.body?.content === "string" && req.body.content.trim()
            ? req.body.content.trim()
            : " ";
        const parentId =
          typeof req.body?.parentId === "string" && req.body.parentId.trim()
            ? req.body.parentId.trim()
            : null;
        // Optional: attach to an existing message (used when uploading multiple
        // files — the first file creates the message, subsequent ones pass its ID).
        const existingMessageId =
          typeof req.body?.messageId === "string" && req.body.messageId.trim()
            ? req.body.messageId.trim()
            : null;

        // Promotion path: instead of raw file bytes, the client may pass the
        // objectKey of a file pre-uploaded through the draft flow
        // (comms-draft-attachments/). The server re-reads the bytes, copies
        // them to a canonical comms-attachments/ key, and runs the same
        // thumbnail pipeline so draft-attached images get thumbnail_key too.
        const draftObjectKey =
          !req.file &&
          typeof req.body?.draftObjectKey === "string" &&
          req.body.draftObjectKey.startsWith("comms-draft-attachments/") &&
          !req.body.draftObjectKey.includes("..")
            ? req.body.draftObjectKey
            : null;

        // Fetch the draft bytes BEFORE creating the message so a missing
        // draft object never leaves behind an orphan empty message.
        let draftBuffer: Buffer | null = null;
        if (draftObjectKey) {
          try {
            draftBuffer = await objectStorage.downloadPrivateKeyToBuffer(draftObjectKey);
          } catch {
            return res.status(404).json({ error: "Draft attachment not found" });
          }
        }

        let message: Awaited<ReturnType<typeof commsStorage.createMessage>>;
        if (existingMessageId) {
          const existing = await commsStorage.getMessageById(existingMessageId);
          if (!existing) return res.status(404).json({ error: "Message not found" });
          if (existing.channelId !== channel.id)
            return res.status(403).json({ error: "Message not in channel" });
          message = existing;
        } else {
          message = await commsStorage.createMessage({
            channelId: channel.id,
            userId,
            parentId: parentId ?? null,
            content,
          });
        }

        let attachment = null;
        if (req.file) {
          const ext = req.file.originalname.split(".").pop() ?? "bin";
          const fileId = randomUUID();
          const objectKey = `comms-attachments/${fileId}.${ext}`;
          const stream = Readable.from(req.file.buffer);
          await objectStorage.streamUploadToPrivateKey(
            objectKey,
            stream,
            req.file.mimetype,
          );

          // Best-effort thumbnail generation for images: 600px-wide webp
          // stored under a thumb/ prefixed key. Failure falls back to full-res.
          let thumbnailKey: string | null = null;
          if (RESIZABLE_IMAGE_TYPES.has(req.file.mimetype)) {
            try {
              thumbnailKey = await generateAttachmentThumbnail(
                req.file.buffer,
                fileId,
              );
            } catch (thumbErr: any) {
              console.warn(
                "[Comms] Thumbnail generation failed (falling back to full-res):",
                thumbErr?.message ?? thumbErr,
              );
            }
          }

          attachment = await commsStorage.createAttachment({
            messageId: message.id,
            uploadedBy: userId,
            objectKey,
            thumbnailKey,
            filename: req.file.originalname,
            contentType: req.file.mimetype,
            sizeBytes: req.file.size,
          });
        } else if (draftObjectKey && draftBuffer) {
          const providedName =
            typeof req.body?.filename === "string" && req.body.filename.trim()
              ? req.body.filename.trim()
              : (draftObjectKey.split("/").pop() ?? "attachment");
          const contentTypeRaw =
            typeof req.body?.contentType === "string" && req.body.contentType.trim()
              ? req.body.contentType.trim()
              : "application/octet-stream";
          const ext = providedName.split(".").pop() ?? "bin";
          const fileId = randomUUID();
          const objectKey = `comms-attachments/${fileId}.${ext}`;
          await objectStorage.streamUploadToPrivateKey(
            objectKey,
            Readable.from(draftBuffer),
            contentTypeRaw,
          );

          // Same best-effort 600px webp thumbnail pipeline as the raw-file
          // upload path — draft-attached images must get thumbnail_key too.
          // Task #3521: the draft pre-upload already generated a thumbnail
          // under comms-draft-attachments/thumb/<draftFileId>.webp, so prefer
          // copying those bytes to the canonical comms-attachments/thumb/ key
          // (skips a second sharp resize); fall back to fresh generation if
          // the draft thumb is absent (e.g. pre-thumbnail drafts).
          let thumbnailKey: string | null = null;
          if (RESIZABLE_IMAGE_TYPES.has(contentTypeRaw)) {
            const draftFileId = /^comms-draft-attachments\/([^/]+?)(?:\.[A-Za-z0-9]+)?$/.exec(
              draftObjectKey,
            )?.[1];
            const draftThumbKey = draftFileId
              ? `comms-draft-attachments/thumb/${draftFileId}.webp`
              : null;
            if (draftThumbKey) {
              try {
                const draftThumbBuffer =
                  await objectStorage.downloadPrivateKeyToBuffer(draftThumbKey);
                const copiedKey = `comms-attachments/thumb/${fileId}.webp`;
                await objectStorage.streamUploadToPrivateKey(
                  copiedKey,
                  Readable.from(draftThumbBuffer),
                  "image/webp",
                );
                thumbnailKey = copiedKey;
              } catch {
                // Draft thumbnail missing or unreadable — fall through to
                // fresh generation below.
              }
            }
            if (!thumbnailKey) {
              try {
                thumbnailKey = await generateAttachmentThumbnail(draftBuffer, fileId);
              } catch (thumbErr: any) {
                console.warn(
                  "[Comms] Draft-promotion thumbnail generation failed (falling back to full-res):",
                  thumbErr?.message ?? thumbErr,
                );
              }
            }
          }

          attachment = await commsStorage.createAttachment({
            messageId: message.id,
            uploadedBy: userId,
            objectKey,
            thumbnailKey,
            filename: providedName,
            contentType: contentTypeRaw,
            sizeBytes: draftBuffer.length,
          });

          // Task #3520 — the draft original + its thumbnail are now
          // redundant (bytes were copied to comms-attachments/ above), so
          // delete them best-effort. Runs AFTER the attachment row exists
          // and never blocks the send — a failure here is only logged and
          // the retention sweep (commsDraftAttachmentCleanup) backstops it.
          void (async () => {
            try {
              await objectStorage.deletePrivateObjectByKey(draftObjectKey);
              const m = /^comms-draft-attachments\/([^/]+?)(?:\.[A-Za-z0-9]+)?$/.exec(
                draftObjectKey,
              );
              if (m) {
                await objectStorage.deletePrivateObjectByKey(
                  `comms-draft-attachments/thumb/${m[1]}.webp`,
                );
              }
            } catch (cleanupErr: any) {
              console.warn(
                `[Comms] Draft attachment post-promotion cleanup failed for ${draftObjectKey}: ${cleanupErr?.message ?? cleanupErr}`,
              );
            }
          })();
        }

        const memberIds = await commsStorage.getChannelMemberIds(channel.id);
        const sender = await getUser(userId).catch(() => undefined);
        broadcastTwilioEvent({
          type: "comms:message",
          channelId: channel.id,
          message: {
            ...message,
            user: sender
              ? {
                  id: sender.id,
                  firstName: sender.firstName ?? undefined,
                  lastName: sender.lastName ?? undefined,
                  profileImageUrl: sender.profileImageUrl ?? undefined,
                }
              : null,
            createdAt: message.createdAt.toISOString(),
            updatedAt: message.updatedAt.toISOString(),
            editedAt: message.editedAt?.toISOString() ?? null,
            deletedAt: message.deletedAt?.toISOString() ?? null,
          },
          // Include the attachment so live consumers (file search) can update
          // their results without a re-fetch.
          attachment: attachment
            ? {
                id: attachment.id,
                messageId: attachment.messageId,
                objectKey: attachment.objectKey,
                filename: attachment.filename,
                contentType: attachment.contentType,
                sizeBytes: attachment.sizeBytes ?? null,
                uploadedBy: attachment.uploadedBy ?? null,
                createdAt:
                  attachment.createdAt instanceof Date
                    ? attachment.createdAt.toISOString()
                    : String(attachment.createdAt),
              }
            : null,
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });

        res.status(201).json({ message, attachment });
      } catch (err: any) {
        console.error("[Comms] Attachment upload error:", err.message);
        res.status(500).json({ error: "Failed to upload attachment" });
      }
    },
  );

}
