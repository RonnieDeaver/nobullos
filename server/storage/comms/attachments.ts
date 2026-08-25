// @db-pool-intent: ambient
/**
 * NoBull Comms storage — attachments.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Attachments, Attachment search.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsAttachments,
  users,
  type CommsAttachment,
} from "@shared/schema";

// ─── Attachments ─────────────────────────────────────────────────────────────

export async function createAttachment(data: {
  messageId: string;
  uploadedBy: string;
  objectKey: string;
  thumbnailKey?: string | null;
  filename: string;
  contentType: string;
  sizeBytes?: number | null;
}): Promise<CommsAttachment> {
  return withDbAttribution("comms:createAttachment", async () => {
    const [row] = await getDb()
      .insert(commsAttachments)
      .values({
        messageId: data.messageId,
        uploadedBy: data.uploadedBy,
        objectKey: data.objectKey,
        thumbnailKey: data.thumbnailKey ?? null,
        filename: data.filename,
        contentType: data.contentType,
        sizeBytes: data.sizeBytes ?? null,
      })
      .returning();
    return row;
  });
}

export async function getAttachmentsByMessageId(messageId: string): Promise<CommsAttachment[]> {
  return withDbAttribution("comms:getAttachmentsByMessageId", () =>
    dbRetry(
      () =>
        getDb()
          .select()
          .from(commsAttachments)
          .where(eq(commsAttachments.messageId, messageId))
          .orderBy(asc(commsAttachments.createdAt)),
      "comms.getAttachmentsByMessageId",
    ),
  );
}

export async function getAttachmentByKey(objectKey: string): Promise<CommsAttachment | null> {
  return withDbAttribution("comms:getAttachmentByKey", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsAttachments)
          .where(eq(commsAttachments.objectKey, objectKey))
          .limit(1),
      "comms.getAttachmentByKey",
    );
    return row ?? null;
  });
}

export async function getAttachmentByThumbnailKey(
  thumbnailKey: string,
): Promise<CommsAttachment | null> {
  return withDbAttribution("comms:getAttachmentByThumbnailKey", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsAttachments)
          .where(eq(commsAttachments.thumbnailKey, thumbnailKey))
          .limit(1),
      "comms.getAttachmentByThumbnailKey",
    );
    return row ?? null;
  });
}

// ─── Attachment search ────────────────────────────────────────────────────────

export interface AttachmentSearchResult {
  id: string;
  messageId: string;
  channelId: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
  uploadedBy: string | null;
  uploaderFirstName: string | null;
  uploaderLastName: string | null;
  channelName: string | null;
  channelSlug: string | null;
  channelType: string;
  messageCreatedAt: string;
}

export async function searchAttachments(
  userId: string,
  opts: {
    q?: string;
    channelId?: string;
    uploadedBy?: string;
    contentType?: string;
    dateFrom?: Date;
    dateTo?: Date;
    limit?: number;
  } = {},
): Promise<AttachmentSearchResult[]> {
  return withDbAttribution("comms:searchAttachments", async () => {
    const limit = Math.min(opts.limit ?? 25, 50);

    const accessibleChannels = await dbRetry(
      () =>
        getDb()
          .select({ channelId: commsChannels.id })
          .from(commsChannels)
          .leftJoin(
            commsChannelMembers,
            and(
              eq(commsChannelMembers.channelId, commsChannels.id),
              eq(commsChannelMembers.userId, userId),
            ),
          )
          .where(
            and(
              isNull(commsChannels.archivedAt),
              or(
                eq(commsChannels.visibility, "public"),
                isNotNull(commsChannelMembers.userId),
                isNotNull(commsChannels.clientId),
              ),
            ),
          ),
      "comms.searchAttachments.channels",
    );

    let accessibleIds = accessibleChannels.map((c) => c.channelId);
    if (accessibleIds.length === 0) return [];

    if (opts.channelId) {
      if (!accessibleIds.includes(opts.channelId)) return [];
      accessibleIds = [opts.channelId];
    }

    const conditions = [
      inArray(commsMessages.channelId, accessibleIds),
      isNull(commsMessages.deletedAt),
    ];
    if (opts.uploadedBy) conditions.push(eq(commsAttachments.uploadedBy, opts.uploadedBy));
    if (opts.contentType) conditions.push(sql`${commsAttachments.contentType} ILIKE ${opts.contentType + "%"}`);
    if (opts.q) conditions.push(sql`${commsAttachments.filename} ILIKE ${"%" + opts.q.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%"}`);
    if (opts.dateFrom) conditions.push(gte(commsAttachments.createdAt, opts.dateFrom));
    if (opts.dateTo) conditions.push(lte(commsAttachments.createdAt, opts.dateTo));

    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            id: commsAttachments.id,
            messageId: commsAttachments.messageId,
            channelId: commsMessages.channelId,
            objectKey: commsAttachments.objectKey,
            filename: commsAttachments.filename,
            contentType: commsAttachments.contentType,
            sizeBytes: commsAttachments.sizeBytes,
            createdAt: commsAttachments.createdAt,
            uploadedBy: commsAttachments.uploadedBy,
            uploaderFirstName: users.firstName,
            uploaderLastName: users.lastName,
            channelName: commsChannels.name,
            channelSlug: commsChannels.slug,
            channelType: commsChannels.type,
            messageCreatedAt: commsMessages.createdAt,
          })
          .from(commsAttachments)
          .innerJoin(commsMessages, eq(commsAttachments.messageId, commsMessages.id))
          .innerJoin(commsChannels, eq(commsMessages.channelId, commsChannels.id))
          .leftJoin(users, eq(commsAttachments.uploadedBy, users.id))
          .where(and(...conditions))
          .orderBy(desc(commsAttachments.createdAt))
          .limit(limit),
      "comms.searchAttachments",
    );

    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      messageCreatedAt: r.messageCreatedAt instanceof Date ? r.messageCreatedAt.toISOString() : String(r.messageCreatedAt),
      channelType: r.channelType ?? "channel",
    }));
  });
}
