// @db-pool-intent: ambient
/**
 * NoBull Comms storage — search, DM privacy, channel lifecycle & SSE catch-up.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Improved full-text search, DM privacy, Channel lifecycle & membership management, SSE catch-up.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsReactions,
  users,
  type CommsChannel,
  type CommsChannelMember,
} from "@shared/schema";
import { type MessageWithUser } from "./messages";

// ─── Improved full-text search ────────────────────────────────────────────────

export async function searchMessagesV2(
  userId: string,
  query: string,
  opts: {
    limit?: number;
    channelId?: string;
    fromUserId?: string;
    dateFrom?: Date;
    dateTo?: Date;
  } = {},
): Promise<MessageWithUser[]> {
  return withDbAttribution("comms:searchMessagesV2", async () => {
    const limit = Math.min(opts.limit ?? 25, 50);
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Build the accessible channel set for this user (public channels + explicit member channels).
    // DM channels: strictly requires an explicit membership row — no team-lead bypass.
    const accessibleChannels = await dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsChannels.id,
            type: commsChannels.type,
          })
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
      "comms.searchMessagesV2.channels",
    );

    let accessibleIds = accessibleChannels.map((c) => c.channelId);
    if (accessibleIds.length === 0) return [];

    // Narrow to the requested channelId if provided (still must be accessible).
    if (opts.channelId) {
      if (!accessibleIds.includes(opts.channelId)) return [];
      accessibleIds = [opts.channelId];
    }

    // Build FTS condition: prefer plainto_tsquery for natural multi-word queries.
    const ftsCondition = sql`to_tsvector('english', ${commsMessages.content}) @@ plainto_tsquery('english', ${trimmed})`;

    const conditions = [
      inArray(commsMessages.channelId, accessibleIds),
      isNull(commsMessages.deletedAt),
      ftsCondition,
    ];
    if (opts.fromUserId) conditions.push(eq(commsMessages.userId, opts.fromUserId));
    if (opts.dateFrom) conditions.push(gte(commsMessages.createdAt, opts.dateFrom));
    if (opts.dateTo) conditions.push(lte(commsMessages.createdAt, opts.dateTo));

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
          .orderBy(desc(commsMessages.createdAt))
          .limit(limit),
      "comms.searchMessagesV2",
    );
    return rows.map((r) => ({
      ...r.message,
      user: r.user?.id ? r.user : null,
      reactionCounts: {}, myReactions: [],
      replyCount: 0,
    }));
  });
}

// ─── DM privacy: strict membership check for DM channels ─────────────────────

/**
 * Returns true if the user is an explicit member of this channel.
 * For DM/group_dm channels this is the ONLY valid access gate —
 * no role bypass (team-lead, CEO) may skip it. Fail closed: any
 * uncertainty (channel not found, null result) returns false.
 */
export async function isStrictChannelMember(
  channelId: string,
  userId: string,
): Promise<boolean> {
  return withDbAttribution("comms:isStrictChannelMember", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ userId: commsChannelMembers.userId })
          .from(commsChannelMembers)
          .where(
            and(
              eq(commsChannelMembers.channelId, channelId),
              eq(commsChannelMembers.userId, userId),
            ),
          )
          .limit(1),
      "comms.isStrictChannelMember",
    );
    return !!row;
  });
}

// ─── Channel lifecycle & membership management ────────────────────────────────

/**
 * Returns the role of the given user in a channel, or null if not a member.
 * Treats "owner" and "channel_admin" as equivalent management roles.
 */
export async function getChannelMemberRole(
  channelId: string,
  userId: string,
): Promise<string | null> {
  return withDbAttribution("comms:getChannelMemberRole", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ role: commsChannelMembers.role })
          .from(commsChannelMembers)
          .where(
            and(
              eq(commsChannelMembers.channelId, channelId),
              eq(commsChannelMembers.userId, userId),
            ),
          )
          .limit(1),
      "comms.getChannelMemberRole",
    );
    return row?.role ?? null;
  });
}

/**
 * Update the role of a channel member to "channel_admin" or "member".
 * Returns null if the membership row does not exist.
 */
export async function updateChannelMemberRole(
  channelId: string,
  userId: string,
  role: "channel_admin" | "member",
): Promise<CommsChannelMember | null> {
  return withDbAttribution("comms:updateChannelMemberRole", async () => {
    const [row] = await getDb()
      .update(commsChannelMembers)
      .set({ role })
      .where(
        and(
          eq(commsChannelMembers.channelId, channelId),
          eq(commsChannelMembers.userId, userId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * Restore an archived channel by clearing its archivedAt timestamp.
 * For client-bound channels the caller must ensure no other active channel
 * already exists for the same client (unique partial index will reject it).
 * Returns null if the channel does not exist.
 */
export async function unarchiveChannel(id: string): Promise<CommsChannel | null> {
  return withDbAttribution("comms:unarchiveChannel", async () => {
    const [row] = await getDb()
      .update(commsChannels)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(commsChannels.id, id))
      .returning();
    return row ?? null;
  });
}

/**
 * Returns all archived team channels (type = 'channel', archivedAt IS NOT NULL),
 * ordered most recently archived first.
 */
export async function listArchivedChannels(userId: string): Promise<CommsChannel[]> {
  return withDbAttribution("comms:listArchivedChannels", async () => {
    const db = getDb();
    const rows = await dbRetry(
      () =>
        db
          .select({
            id: commsChannels.id,
            name: commsChannels.name,
            slug: commsChannels.slug,
            type: commsChannels.type,
            visibility: commsChannels.visibility,
            topic: commsChannels.topic,
            description: commsChannels.description,
            clientId: commsChannels.clientId,
            archivedAt: commsChannels.archivedAt,
            createdBy: commsChannels.createdBy,
            createdAt: commsChannels.createdAt,
            updatedAt: commsChannels.updatedAt,
            memberUserId: commsChannelMembers.userId,
          })
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
              eq(commsChannels.type, "channel"),
              isNotNull(commsChannels.archivedAt),
            ),
          )
          .orderBy(desc(commsChannels.archivedAt)),
      "comms.listArchivedChannels",
    );
    return rows
      .filter(
        (r) => r.visibility !== "private" || r.memberUserId !== null,
      )
      .map(({ memberUserId: _m, ...ch }) => ch as CommsChannel);
  });
}

/**
 * Returns member count and non-deleted message count for a channel.
 */
export async function getChannelStats(
  channelId: string,
): Promise<{ memberCount: number; messageCount: number }> {
  return withDbAttribution("comms:getChannelStats", async () => {
    const [memberCount, messageCount] = await Promise.all([
      dbRetry(
        () =>
          getDb()
            .select({ count: sql<number>`count(*)::int` })
            .from(commsChannelMembers)
            .where(eq(commsChannelMembers.channelId, channelId))
            .then((r) => Number(r[0]?.count ?? 0)),
        "comms.getChannelStats.members",
      ),
      dbRetry(
        () =>
          getDb()
            .select({ count: sql<number>`count(*)::int` })
            .from(commsMessages)
            .where(
              and(
                eq(commsMessages.channelId, channelId),
                isNull(commsMessages.deletedAt),
              ),
            )
            .then((r) => Number(r[0]?.count ?? 0)),
        "comms.getChannelStats.messages",
      ),
    ]);
    return { memberCount, messageCount };
  });
}

export interface ChannelMemberWithUser {
  channelId: string;
  userId: string;
  role: string;
  joinedAt: Date;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
    email: string | null;
  } | null;
}

/**
 * Returns channel members joined with their user profile.
 */
export async function getChannelMembersWithUsers(
  channelId: string,
): Promise<ChannelMemberWithUser[]> {
  return withDbAttribution("comms:getChannelMembersWithUsers", () =>
    dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsChannelMembers.channelId,
            userId: commsChannelMembers.userId,
            role: commsChannelMembers.role,
            joinedAt: commsChannelMembers.createdAt,
            user: {
              id: users.id,
              firstName: users.firstName,
              lastName: users.lastName,
              profileImageUrl: users.profileImageUrl,
              email: users.email,
            },
          })
          .from(commsChannelMembers)
          .leftJoin(users, eq(commsChannelMembers.userId, users.id))
          .where(eq(commsChannelMembers.channelId, channelId))
          .orderBy(asc(commsChannelMembers.createdAt)),
      "comms.getChannelMembersWithUsers",
    ).then((rows) =>
      rows.map((r) => ({
        channelId: r.channelId,
        userId: r.userId,
        role: r.role,
        joinedAt: r.joinedAt,
        user: r.user?.id ? r.user : null,
      })),
    ),
  );
}

// ─── SSE catch-up ─────────────────────────────────────────────────────────────

/**
 * Returns the distinct channel IDs that have had any message activity
 * (create, edit, delete, or reaction) since `since` AND that `userId` can
 * access. Used by the SSE reconnect catch-up endpoint so the client can
 * selectively invalidate only the affected message query caches instead of
 * flushing everything.
 *
 * Access rule mirrors listMessages:
 *   - public channels: open to all authenticated users
 *   - private channels: requires an explicit membership row
 *   - client-bound channels (clientId IS NOT NULL): team-wide (any auth user)
 */
export async function getActiveChannelIdsSince(
  userId: string,
  since: Date,
): Promise<string[]> {
  return withDbAttribution("comms:getActiveChannelIdsSince", async () => {
    const db = getDb();

    // ── Path 1: channels with message-level activity ─────────────────────────
    // Covers: new messages, edits, soft-deletes (updated_at / deleted_at).
    const messageRows = await dbRetry(
      () =>
        db
          .selectDistinct({ channelId: commsMessages.channelId })
          .from(commsMessages)
          .innerJoin(commsChannels, eq(commsMessages.channelId, commsChannels.id))
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
                gte(commsMessages.updatedAt, since),
                gte(commsMessages.deletedAt, since),
              ),
              or(
                eq(commsChannels.visibility, "public"),
                isNotNull(commsChannelMembers.userId),
                isNotNull(commsChannels.clientId),
              ),
            ),
          ),
      "comms.getActiveChannelIdsSince.messages",
    );

    // ── Path 2: channels with reaction-only activity ─────────────────────────
    // Covers: emoji reactions added since `since` that might not bump the
    // parent message's updated_at (add/remove reaction events are fire-and-
    // forget on the message row).
    const reactionRows = await dbRetry(
      () =>
        db
          .selectDistinct({ channelId: commsMessages.channelId })
          .from(commsReactions)
          .innerJoin(commsMessages, eq(commsReactions.messageId, commsMessages.id))
          .innerJoin(commsChannels, eq(commsMessages.channelId, commsChannels.id))
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
              gte(commsReactions.createdAt, since),
              or(
                eq(commsChannels.visibility, "public"),
                isNotNull(commsChannelMembers.userId),
                isNotNull(commsChannels.clientId),
              ),
            ),
          ),
      "comms.getActiveChannelIdsSince.reactions",
    );

    // Merge and deduplicate across both paths.
    const seen = new Set<string>();
    for (const r of [...messageRows, ...reactionRows]) {
      seen.add(r.channelId);
    }
    return Array.from(seen);
  });
}
