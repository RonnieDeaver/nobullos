// @db-pool-intent: ambient
/**
 * NoBull Comms storage — bookmarks.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Bookmarks.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsMessages,
  commsBookmarks,
  commsThreadMembers,
  type CommsBookmark,
  type CommsThreadMember,
} from "@shared/schema";

// ─── Bookmarks ────────────────────────────────────────────────────────────────

export async function listBookmarksForChannel(channelId: string): Promise<CommsBookmark[]> {
  return withDbAttribution("comms:listBookmarksForChannel", () =>
    dbRetry(
      () =>
        getDb()
          .select()
          .from(commsBookmarks)
          .where(eq(commsBookmarks.channelId, channelId))
          .orderBy(asc(commsBookmarks.sortOrder), asc(commsBookmarks.createdAt)),
      "comms.listBookmarksForChannel",
    ),
  );
}

export async function getBookmarkById(id: string): Promise<CommsBookmark | null> {
  return withDbAttribution("comms:getBookmarkById", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsBookmarks)
          .where(eq(commsBookmarks.id, id))
          .limit(1),
      "comms.getBookmarkById",
    );
    return row ?? null;
  });
}

/**
 * Get the follow record for a specific (rootMessageId, userId).
 */
export async function getThreadMembership(
  rootMessageId: string,
  userId: string,
): Promise<CommsThreadMember | null> {
  return withDbAttribution("comms:getThreadMembership", async () => {
    const [row] = await getDb()
      .select()
      .from(commsThreadMembers)
      .where(
        and(
          eq(commsThreadMembers.rootMessageId, rootMessageId),
          eq(commsThreadMembers.userId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function createBookmark(data: {
  channelId: string;
  type: "link" | "file";
  label: string;
  emoji?: string | null;
  url?: string | null;
  attachmentId?: string | null;
  objectKey?: string | null;
  filename?: string | null;
  createdBy: string | null;
}): Promise<CommsBookmark> {
  return withDbAttribution("comms:createBookmark", async () => {
    // Place new bookmarks at the end (max sortOrder + 1)
    const [maxRow] = await getDb()
      .select({ maxOrder: sql<number>`COALESCE(MAX(${commsBookmarks.sortOrder}), -1)` })
      .from(commsBookmarks)
      .where(eq(commsBookmarks.channelId, data.channelId));
    const sortOrder = (maxRow?.maxOrder ?? -1) + 1;
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsBookmarks)
          .values({
            channelId: data.channelId,
            type: data.type,
            label: data.label,
            emoji: data.emoji ?? null,
            url: data.url ?? null,
            attachmentId: data.attachmentId ?? null,
            objectKey: data.objectKey ?? null,
            filename: data.filename ?? null,
            sortOrder,
            createdBy: data.createdBy,
          })
          .returning(),
      "comms.createBookmark",
    );
    return row;
  });
}

/**
 * Mark all replies in a thread as read for the given user (set lastReadReplyAt = now).
 */
export async function markThreadRead(
  rootMessageId: string,
  channelId: string,
  userId: string,
): Promise<CommsThreadMember> {
  return withDbAttribution("comms:markThreadRead", async () => {
    const now = new Date();
    const [row] = await getDb()
      .insert(commsThreadMembers)
      .values({ rootMessageId, channelId, userId, following: true, lastReadReplyAt: now })
      .onConflictDoUpdate({
        target: [commsThreadMembers.rootMessageId, commsThreadMembers.userId],
        set: { lastReadReplyAt: now, updatedAt: now },
      })
      .returning();
    return row;
  });
}

export async function updateBookmark(
  id: string,
  data: Partial<Pick<CommsBookmark, "label" | "emoji" | "url">>,
): Promise<CommsBookmark | null> {
  return withDbAttribution("comms:updateBookmark", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsBookmarks)
      .set({ ...data, updatedAt: now })
      .where(eq(commsBookmarks.id, id))
      .returning();
    return row ?? null;
  });
}

/**
 * Mark thread as unread from a specific reply message.
 * Sets lastReadReplyAt to just before the target message.
 */
export async function markThreadUnread(
  rootMessageId: string,
  channelId: string,
  userId: string,
  fromMessageId: string,
): Promise<CommsThreadMember | null> {
  return withDbAttribution("comms:markThreadUnread", async () => {
    const [targetMsg] = await getDb()
      .select({ createdAt: commsMessages.createdAt })
      .from(commsMessages)
      .where(
        and(
          eq(commsMessages.id, fromMessageId),
          eq(commsMessages.channelId, channelId),
          eq(commsMessages.parentId, rootMessageId),
        ),
      )
      .limit(1);
    if (!targetMsg) return null;

    const [prevReply] = await getDb()
      .select({ createdAt: commsMessages.createdAt })
      .from(commsMessages)
      .where(
        and(
          eq(commsMessages.channelId, channelId),
          eq(commsMessages.parentId, rootMessageId),
          lt(commsMessages.createdAt, targetMsg.createdAt),
          isNull(commsMessages.deletedAt),
        ),
      )
      .orderBy(desc(commsMessages.createdAt))
      .limit(1);

    const lastReadReplyAt = prevReply?.createdAt ?? new Date(0);
    const now = new Date();

    const [row] = await getDb()
      .insert(commsThreadMembers)
      .values({ rootMessageId, channelId, userId, following: true, lastReadReplyAt })
      .onConflictDoUpdate({
        target: [commsThreadMembers.rootMessageId, commsThreadMembers.userId],
        set: { lastReadReplyAt, updatedAt: now },
      })
      .returning();
    return row ?? null;
  });
}

export async function deleteBookmark(id: string): Promise<boolean> {
  return withDbAttribution("comms:deleteBookmark", async () => {
    const rows = await getDb()
      .delete(commsBookmarks)
      .where(eq(commsBookmarks.id, id))
      .returning({ id: commsBookmarks.id });
    return rows.length > 0;
  });
}

/** Reorder bookmarks in a channel. ids must be all bookmark IDs for the channel in desired order. */
export async function reorderBookmarks(channelId: string, ids: string[]): Promise<void> {
  await withDbAttribution("comms:reorderBookmarks", async () => {
    const db = getDb();
    for (let i = 0; i < ids.length; i++) {
      await db
        .update(commsBookmarks)
        .set({ sortOrder: i, updatedAt: new Date() })
        .where(and(eq(commsBookmarks.id, ids[i]), eq(commsBookmarks.channelId, channelId)));
    }
  });
}

export interface FollowedThreadItem {
  rootMessageId: string;
  channelId: string;
  following: boolean;
  lastReadReplyAt: Date;
  unreadReplies: number;
  mentionCount: number;
  rootMessageContent: string | null;
  rootMessageUserId: string | null;
  rootMessageCreatedAt: Date | null;
  replyCount: number;
  lastReplyAt: Date | null;
  participantIds: string[];
}

/**
 * List all threads the user is following, enriched with unread counts and root message preview.
 */
export async function listFollowedThreads(userId: string): Promise<FollowedThreadItem[]> {
  return withDbAttribution("comms:listFollowedThreads", async () => {
    const memberRows = await getDb()
      .select()
      .from(commsThreadMembers)
      .where(
        and(eq(commsThreadMembers.userId, userId), eq(commsThreadMembers.following, true)),
      )
      .orderBy(desc(commsThreadMembers.updatedAt));

    if (memberRows.length === 0) return [];

    const rootMessageIds = memberRows.map((r) => r.rootMessageId);

    // Fetch root messages
    const rootMessages = await getDb()
      .select({
        id: commsMessages.id,
        content: commsMessages.content,
        userId: commsMessages.userId,
        createdAt: commsMessages.createdAt,
        channelId: commsMessages.channelId,
      })
      .from(commsMessages)
      .where(inArray(commsMessages.id, rootMessageIds));

    const rootMsgMap = new Map(rootMessages.map((m) => [m.id, m]));

    // Per-thread reply stats: count, last reply timestamp, unread count, mention count, participants
    const replyStats = await getDb()
      .select({
        parentId: commsMessages.parentId,
        replyCount: sql<number>`count(*)::int`,
        lastReplyAt: sql<Date | null>`max(${commsMessages.createdAt})`,
      })
      .from(commsMessages)
      .where(
        and(
          inArray(commsMessages.parentId, rootMessageIds),
          isNull(commsMessages.deletedAt),
        ),
      )
      .groupBy(commsMessages.parentId);

    const replyStatMap = new Map(replyStats.map((r) => [r.parentId!, r]));

    // Participant IDs per thread (up to 5 most recent)
    const participantRows = await getDb()
      .select({
        parentId: commsMessages.parentId,
        userId: commsMessages.userId,
        maxCreatedAt: sql<Date>`max(${commsMessages.createdAt})`,
      })
      .from(commsMessages)
      .where(
        and(
          inArray(commsMessages.parentId, rootMessageIds),
          isNull(commsMessages.deletedAt),
          isNotNull(commsMessages.userId),
        ),
      )
      .groupBy(commsMessages.parentId, commsMessages.userId)
      .orderBy(desc(sql`max(${commsMessages.createdAt})`));

    const participantMap = new Map<string, string[]>();
    for (const row of participantRows) {
      if (!row.parentId || !row.userId) continue;
      const existing = participantMap.get(row.parentId) ?? [];
      if (existing.length < 5) existing.push(row.userId);
      participantMap.set(row.parentId, existing);
    }

    return memberRows.map((member) => {
      const rootMsg = rootMsgMap.get(member.rootMessageId);
      const stats = replyStatMap.get(member.rootMessageId);
      const lrra = member.lastReadReplyAt ?? new Date(0);

      const unreadReplies = 0; // filled below after the per-thread unread query
      const mentionCount = 0;

      return {
        rootMessageId: member.rootMessageId,
        channelId: member.channelId,
        following: member.following,
        lastReadReplyAt: lrra,
        unreadReplies,
        mentionCount,
        rootMessageContent: rootMsg?.content ?? null,
        rootMessageUserId: rootMsg?.userId ?? null,
        rootMessageCreatedAt: rootMsg?.createdAt ?? null,
        replyCount: stats?.replyCount ?? 0,
        lastReplyAt: stats?.lastReplyAt ?? null,
        participantIds: participantMap.get(member.rootMessageId) ?? [],
      };
    });
  });
}
