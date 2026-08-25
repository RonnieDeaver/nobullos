// @db-pool-intent: ambient
/**
 * NoBull Comms storage — messages.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Messages, Reactions, Read states, Unread + mention summary.
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsMessages,
  commsReactions,
  commsReadStates,
  commsAttachments,
  commsMessageEditHistory,
  users,
  type CommsMessage,
  type CommsReadState,
  type CommsAttachment,
  type CommsMessageEditHistory,
  type InsertCommsMessage,
} from "@shared/schema";
import { searchMessagesV2 } from "./searchAndLifecycle";

// ─── Messages ────────────────────────────────────────────────────────────────

export interface ListMessagesOptions {
  before?: string;
  after?: string;
  /** Fetch exactly one message by ID (ignores before/after, uses this channel's scope). */
  id?: string;
  limit?: number;
  parentId?: string | null;
  /** When set, each message's `myReactions` lists the emoji this user reacted with. */
  currentUserId?: string;
}

export type MessageWithUser = CommsMessage & {
  user: { id: string; firstName: string | null; lastName: string | null; email: string | null; profileImageUrl: string | null } | null;
  reactionCounts: Record<string, number>;
  /** Emoji strings the requesting user reacted with (exact strings — skin-tone variants independent). */
  myReactions: string[];
  /** First 10 reactor display names per emoji (earliest first), for hover tooltips. */
  reactionNames?: Record<string, string[]>;
  replyCount: number;
};

export async function listMessages(
  channelId: string,
  opts: ListMessagesOptions = {},
): Promise<MessageWithUser[]> {
  return withDbAttribution("comms:listMessages", async () => {
    const limit = Math.min(opts.limit ?? 50, 100);
    let conditions = [
      eq(commsMessages.channelId, channelId),
      isNull(commsMessages.deletedAt),
    ];
    if (opts.id) {
      conditions.push(eq(commsMessages.id, opts.id));
    }
    if (opts.parentId !== undefined) {
      if (opts.parentId === null) {
        conditions.push(isNull(commsMessages.parentId));
      } else {
        conditions.push(eq(commsMessages.parentId, opts.parentId));
      }
    }
    if (opts.before) {
      const beforeConditions = [
        eq(commsMessages.id, opts.before),
        eq(commsMessages.channelId, channelId),
      ];
      if (opts.parentId !== undefined) {
        beforeConditions.push(
          opts.parentId === null
            ? isNull(commsMessages.parentId)
            : eq(commsMessages.parentId, opts.parentId),
        );
      }
      const [anchor] = await getDb()
        .select({ createdAt: commsMessages.createdAt })
        .from(commsMessages)
        .where(and(...beforeConditions))
        .limit(1);
      if (anchor) conditions.push(lt(commsMessages.createdAt, anchor.createdAt));
    }
    if (opts.after) {
      const afterConditions = [
        eq(commsMessages.id, opts.after),
        eq(commsMessages.channelId, channelId),
      ];
      if (opts.parentId !== undefined) {
        afterConditions.push(
          opts.parentId === null
            ? isNull(commsMessages.parentId)
            : eq(commsMessages.parentId, opts.parentId),
        );
      }
      const [anchor] = await getDb()
        .select({ createdAt: commsMessages.createdAt })
        .from(commsMessages)
        .where(and(...afterConditions))
        .limit(1);
      if (anchor) conditions.push(gt(commsMessages.createdAt, anchor.createdAt));
    }

    // For "after" queries (newer-window only), use ASC ordering so LIMIT captures
    // the N messages *nearest* to the anchor, not the N latest in the channel.
    // For "before" (and default tail) queries use DESC + reverse for the same effect.
    const useAsc = !!opts.after && !opts.before;
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            message: commsMessages,
            user: {
              id: users.id,
              firstName: users.firstName,
              lastName: users.lastName,
              email: users.email,
              profileImageUrl: users.profileImageUrl,
            },
          })
          .from(commsMessages)
          .leftJoin(users, eq(commsMessages.userId, users.id))
          .where(and(...conditions))
          .orderBy(useAsc ? asc(commsMessages.createdAt) : desc(commsMessages.createdAt))
          .limit(limit),
      "comms.listMessages",
    );

    const messageIds = rows.map((r) => r.message.id);
    if (messageIds.length === 0) return [];

    const [reactions, replyCounts, attachmentRows] = await Promise.all([
      dbRetry(
        () =>
          getDb()
            .select({
              messageId: commsReactions.messageId,
              emoji: commsReactions.emoji,
              count: sql<number>`count(*)::int`,
              mine: opts.currentUserId
                ? sql<boolean>`bool_or(${commsReactions.userId} = ${opts.currentUserId})`
                : sql<boolean>`false`,
              // First 10 reactor names (earliest first) for the pill hover tooltip.
              names: sql<string[]>`(array_agg(nullif(trim(coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')), '') order by ${commsReactions.createdAt} asc))[1:10]`,
            })
            .from(commsReactions)
            .leftJoin(users, eq(commsReactions.userId, users.id))
            .where(inArray(commsReactions.messageId, messageIds))
            .groupBy(commsReactions.messageId, commsReactions.emoji),
        "comms.listMessages.reactions",
      ),
      dbRetry(
        () =>
          getDb()
            .select({
              parentId: commsMessages.parentId,
              count: sql<number>`count(*)::int`,
            })
            .from(commsMessages)
            .where(
              and(
                inArray(commsMessages.parentId, messageIds),
                isNull(commsMessages.deletedAt),
              ),
            )
            .groupBy(commsMessages.parentId),
        "comms.listMessages.replyCounts",
      ),
      dbRetry(
        () =>
          getDb()
            .select()
            .from(commsAttachments)
            .where(inArray(commsAttachments.messageId, messageIds))
            .orderBy(asc(commsAttachments.createdAt)),
        "comms.listMessages.attachments",
      ),
    ]);

    const reactionMap = new Map<string, Record<string, number>>();
    const myReactionsMap = new Map<string, string[]>();
    const reactionNamesMap = new Map<string, Record<string, string[]>>();
    for (const r of reactions) {
      if (!reactionMap.has(r.messageId)) reactionMap.set(r.messageId, {});
      reactionMap.get(r.messageId)![r.emoji] = Number(r.count);
      if (r.mine) {
        if (!myReactionsMap.has(r.messageId)) myReactionsMap.set(r.messageId, []);
        myReactionsMap.get(r.messageId)!.push(r.emoji);
      }
      if (!reactionNamesMap.has(r.messageId)) reactionNamesMap.set(r.messageId, {});
      reactionNamesMap.get(r.messageId)![r.emoji] = (r.names ?? []).filter(
        (n): n is string => typeof n === "string" && n.length > 0,
      );
    }
    const replyCountMap = new Map<string, number>();
    for (const r of replyCounts) {
      if (r.parentId) replyCountMap.set(r.parentId, Number(r.count));
    }
    const attachmentMap = new Map<string, CommsAttachment[]>();
    for (const a of attachmentRows) {
      if (!attachmentMap.has(a.messageId)) attachmentMap.set(a.messageId, []);
      attachmentMap.get(a.messageId)!.push(a);
    }

    const mapped = rows.map((r) => ({
      ...r.message,
      user: r.user?.id ? r.user : null,
      reactionCounts: reactionMap.get(r.message.id) ?? {},
      myReactions: myReactionsMap.get(r.message.id) ?? [],
      reactionNames: reactionNamesMap.get(r.message.id) ?? {},
      replyCount: replyCountMap.get(r.message.id) ?? 0,
      attachments: attachmentMap.get(r.message.id) ?? [],
    }));
    // DESC queries are reversed in memory to produce chronological ASC output.
    // ASC queries (after-only) are already in the correct order — skip reverse.
    return useAsc ? mapped : mapped.reverse();
  });
}

export async function getMessageById(id: string): Promise<CommsMessage | null> {
  return withDbAttribution("comms:getMessageById", async () => {
    const [row] = await dbRetry(
      () => getDb().select().from(commsMessages).where(eq(commsMessages.id, id)).limit(1),
      "comms.getMessageById",
    );
    return row ?? null;
  });
}

export async function createMessage(data: InsertCommsMessage): Promise<CommsMessage> {
  return withDbAttribution("comms:createMessage", async () => {
    const [row] = await dbRetry(
      () => getDb().insert(commsMessages).values(data).returning(),
      "comms.createMessage",
    );
    return row;
  });
}

export async function editMessage(
  id: string,
  userId: string,
  content: string,
): Promise<CommsMessage | null> {
  return withDbAttribution("comms:editMessage", async () => {
    const now = new Date();
    // Save prior version before overwriting
    const [current] = await getDb()
      .select({ content: commsMessages.content })
      .from(commsMessages)
      .where(and(eq(commsMessages.id, id), eq(commsMessages.userId, userId)))
      .limit(1);
    if (!current) return null;
    const [versionRow] = await getDb()
      .select({ maxVer: sql<number>`coalesce(max(version),0)::int` })
      .from(commsMessageEditHistory)
      .where(eq(commsMessageEditHistory.messageId, id));
    const nextVersion = (versionRow?.maxVer ?? 0) + 1;
    await getDb().insert(commsMessageEditHistory).values({
      messageId: id,
      editorId: userId,
      priorContent: current.content,
      version: nextVersion,
    });
    const [row] = await getDb()
      .update(commsMessages)
      .set({ content, editedAt: now, updatedAt: now })
      .where(and(eq(commsMessages.id, id), eq(commsMessages.userId, userId)))
      .returning();
    return row ?? null;
  });
}

export async function getMessageEditHistory(
  messageId: string,
): Promise<Array<CommsMessageEditHistory & { editorName: string | null }>> {
  return withDbAttribution("comms:getMessageEditHistory", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            history: commsMessageEditHistory,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(commsMessageEditHistory)
          .leftJoin(users, eq(commsMessageEditHistory.editorId, users.id))
          .where(eq(commsMessageEditHistory.messageId, messageId))
          .orderBy(desc(commsMessageEditHistory.version)),
      "comms.getMessageEditHistory",
    );
    return rows.map((r) => ({
      ...r.history,
      editorName: r.firstName || r.lastName
        ? [r.firstName, r.lastName].filter(Boolean).join(" ")
        : null,
    }));
  });
}

export async function restoreEditVersion(
  messageId: string,
  historyId: string,
  actorId: string,
): Promise<CommsMessage | null> {
  return withDbAttribution("comms:restoreEditVersion", async () => {
    const [histRow] = await getDb()
      .select()
      .from(commsMessageEditHistory)
      .where(and(
        eq(commsMessageEditHistory.id, historyId),
        eq(commsMessageEditHistory.messageId, messageId),
      ))
      .limit(1);
    if (!histRow) return null;
    const [msg] = await getDb()
      .select()
      .from(commsMessages)
      .where(eq(commsMessages.id, messageId))
      .limit(1);
    if (!msg) return null;
    // Save current as a new history entry
    const [versionRow] = await getDb()
      .select({ maxVer: sql<number>`coalesce(max(version),0)::int` })
      .from(commsMessageEditHistory)
      .where(eq(commsMessageEditHistory.messageId, messageId));
    const nextVersion = (versionRow?.maxVer ?? 0) + 1;
    await getDb().insert(commsMessageEditHistory).values({
      messageId,
      editorId: actorId,
      priorContent: msg.content,
      version: nextVersion,
    });
    const now = new Date();
    const [updated] = await getDb()
      .update(commsMessages)
      .set({ content: histRow.priorContent, editedAt: now, updatedAt: now })
      .where(eq(commsMessages.id, messageId))
      .returning();
    return updated ?? null;
  });
}

export async function softDeleteMessage(
  id: string,
  userId: string,
): Promise<CommsMessage | null> {
  return withDbAttribution("comms:softDeleteMessage", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsMessages)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(commsMessages.id, id), eq(commsMessages.userId, userId)))
      .returning();
    return row ?? null;
  });
}

export async function searchMessages(
  userId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<MessageWithUser[]> {
  return searchMessagesV2(userId, query, opts);
}

// ─── Reactions ───────────────────────────────────────────────────────────────

export async function addReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ added: boolean }> {
  return withDbAttribution("comms:addReaction", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .insert(commsReactions)
          .values({ messageId, userId, emoji })
          .onConflictDoNothing()
          .returning({ id: commsReactions.id }),
      "comms.addReaction",
    );
    return { added: rows.length > 0 };
  });
}

export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ removed: boolean }> {
  return withDbAttribution("comms:removeReaction", async () => {
    const rows = await getDb()
      .delete(commsReactions)
      .where(
        and(
          eq(commsReactions.messageId, messageId),
          eq(commsReactions.userId, userId),
          eq(commsReactions.emoji, emoji),
        ),
      )
      .returning({ id: commsReactions.id });
    return { removed: rows.length > 0 };
  });
}

// ─── Read states ─────────────────────────────────────────────────────────────

export async function getReadState(
  channelId: string,
  userId: string,
): Promise<CommsReadState | null> {
  return withDbAttribution("comms:getReadState", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsReadStates)
          .where(
            and(
              eq(commsReadStates.channelId, channelId),
              eq(commsReadStates.userId, userId),
            ),
          )
          .limit(1),
      "comms.getReadState",
    );
    return row ?? null;
  });
}

export async function upsertReadState(
  channelId: string,
  userId: string,
  lastReadMessageId: string | null,
): Promise<CommsReadState> {
  return withDbAttribution("comms:upsertReadState", async () => {
    const now = new Date();
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsReadStates)
          .values({ channelId, userId, lastReadMessageId, lastReadAt: now })
          .onConflictDoUpdate({
            target: [commsReadStates.channelId, commsReadStates.userId],
            set: { lastReadMessageId, lastReadAt: now, updatedAt: now },
          })
          .returning(),
      "comms.upsertReadState",
    );
    return row;
  });
}

export async function getUnreadCountsForUser(
  userId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  return withDbAttribution("comms:getUnreadCountsForUser", async () => {
    // Single grouped query (was a per-channel COUNT loop — N+1 on every
    // channel-list fetch). LEFT JOIN read states so channels with no read
    // state count everything since epoch.
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsMessages.channelId,
            count: sql<number>`count(*)::int`,
          })
          .from(commsMessages)
          .leftJoin(
            commsReadStates,
            and(
              eq(commsReadStates.channelId, commsMessages.channelId),
              eq(commsReadStates.userId, userId),
            ),
          )
          .where(
            and(
              inArray(commsMessages.channelId, channelIds),
              isNull(commsMessages.deletedAt),
              sql`${commsMessages.createdAt} > COALESCE(${commsReadStates.lastReadAt}, to_timestamp(0))`,
              sql`${commsMessages.userId} != ${userId}`,
            ),
          )
          .groupBy(commsMessages.channelId),
      "comms.getUnreadCounts",
    );
    const result = new Map<string, number>();
    for (const channelId of channelIds) result.set(channelId, 0);
    for (const row of rows) result.set(row.channelId, Number(row.count ?? 0));
    return result;
  });
}

// ─── Unread + mention summary ─────────────────────────────────────────────────

export interface ChannelUnreadSummary {
  unreadCount: number;
  mentionCount: number;
  oldestUnreadMessageId: string | null;
}

/**
 * Returns unread count, mention count, and oldest unread message ID for each
 * channel. Mention detection checks for @[name](user:<userId>) format or
 * any message in a DM/group_dm channel (all DM unreads count as mentions).
 */
export async function getUnreadSummaryForUser(
  userId: string,
  channelIds: string[],
): Promise<Map<string, ChannelUnreadSummary>> {
  if (channelIds.length === 0) return new Map();
  return withDbAttribution("comms:getUnreadSummaryForUser", async () => {
    const mentionLike = `%(user:${userId})%`;

    const [countRows, oldestRows] = await Promise.all([
      dbRetry(
        () =>
          getDb()
            .select({
              channelId: commsMessages.channelId,
              channelType: commsChannels.type,
              unreadCount: sql<number>`count(*)::int`,
              mentionCount: sql<number>`count(*) FILTER (WHERE ${commsMessages.content} LIKE ${mentionLike} OR ${commsChannels.type} IN ('dm', 'group_dm') OR ${commsMessages.content} LIKE '%@channel%' OR ${commsMessages.content} LIKE '%@here%')::int`,
            })
            .from(commsMessages)
            .innerJoin(commsChannels, eq(commsMessages.channelId, commsChannels.id))
            .leftJoin(
              commsReadStates,
              and(
                eq(commsReadStates.channelId, commsMessages.channelId),
                eq(commsReadStates.userId, userId),
              ),
            )
            .where(
              and(
                inArray(commsMessages.channelId, channelIds),
                isNull(commsMessages.deletedAt),
                isNull(commsMessages.parentId),
                sql`${commsMessages.createdAt} > COALESCE(${commsReadStates.lastReadAt}, to_timestamp(0))`,
                sql`${commsMessages.userId} != ${userId}`,
              ),
            )
            .groupBy(commsMessages.channelId, commsChannels.type),
        "comms.getUnreadSummary.counts",
      ),
      dbRetry(
        () =>
          getDb()
            .select({
              channelId: commsMessages.channelId,
              id: commsMessages.id,
            })
            .from(commsMessages)
            .leftJoin(
              commsReadStates,
              and(
                eq(commsReadStates.channelId, commsMessages.channelId),
                eq(commsReadStates.userId, userId),
              ),
            )
            .where(
              and(
                inArray(commsMessages.channelId, channelIds),
                isNull(commsMessages.deletedAt),
                isNull(commsMessages.parentId),
                sql`${commsMessages.createdAt} > COALESCE(${commsReadStates.lastReadAt}, to_timestamp(0))`,
                sql`${commsMessages.userId} != ${userId}`,
              ),
            )
            .orderBy(asc(commsMessages.channelId), asc(commsMessages.createdAt)),
        "comms.getUnreadSummary.oldest",
      ),
    ]);

    const result = new Map<string, ChannelUnreadSummary>();
    for (const channelId of channelIds) {
      result.set(channelId, { unreadCount: 0, mentionCount: 0, oldestUnreadMessageId: null });
    }
    for (const row of countRows) {
      const existing = result.get(row.channelId);
      if (existing) {
        existing.unreadCount = Number(row.unreadCount ?? 0);
        existing.mentionCount = Number(row.mentionCount ?? 0);
      }
    }
    // Rows ordered by channelId, createdAt ASC → first row per channel = oldest
    const seenChannels = new Set<string>();
    for (const row of oldestRows) {
      if (!seenChannels.has(row.channelId)) {
        seenChannels.add(row.channelId);
        const existing = result.get(row.channelId);
        if (existing) existing.oldestUnreadMessageId = row.id;
      }
    }
    return result;
  });
}

/**
 * Move the read pointer back to just before `messageId` so it appears unread.
 * Sets lastReadAt to the previous message's createdAt, or epoch if target is first.
 */
export async function markUnreadFromMessage(
  channelId: string,
  userId: string,
  messageId: string,
): Promise<CommsReadState | null> {
  return withDbAttribution("comms:markUnreadFromMessage", async () => {
    const [targetMsg] = await getDb()
      .select({ createdAt: commsMessages.createdAt })
      .from(commsMessages)
      .where(and(eq(commsMessages.id, messageId), eq(commsMessages.channelId, channelId)))
      .limit(1);
    if (!targetMsg) return null;

    const [prevMsg] = await getDb()
      .select({ id: commsMessages.id, createdAt: commsMessages.createdAt })
      .from(commsMessages)
      .where(
        and(
          eq(commsMessages.channelId, channelId),
          lt(commsMessages.createdAt, targetMsg.createdAt),
          isNull(commsMessages.deletedAt),
          isNull(commsMessages.parentId),
        ),
      )
      .orderBy(desc(commsMessages.createdAt))
      .limit(1);

    const lastReadMessageId = prevMsg?.id ?? null;
    const lastReadAt = prevMsg?.createdAt ?? new Date(0);

    const [row] = await getDb()
      .insert(commsReadStates)
      .values({ channelId, userId, lastReadMessageId, lastReadAt })
      .onConflictDoUpdate({
        target: [commsReadStates.channelId, commsReadStates.userId],
        set: { lastReadMessageId, lastReadAt, updatedAt: new Date() },
      })
      .returning();
    return row ?? null;
  });
}

/**
 * Mark all listed channels as read for `userId` (sets lastReadAt = now).
 */
export async function markAllChannelsRead(userId: string, channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return;
  return withDbAttribution("comms:markAllChannelsRead", async () => {
    const now = new Date();
    await getDb()
      .insert(commsReadStates)
      .values(channelIds.map((channelId) => ({ channelId, userId, lastReadAt: now })))
      .onConflictDoUpdate({
        target: [commsReadStates.channelId, commsReadStates.userId],
        set: { lastReadAt: now, updatedAt: now },
      });
  });
}
