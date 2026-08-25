// @db-pool-intent: ambient
/**
 * NoBull Comms storage — notification prefs, pins & saved messages.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Notification prefs, Pins, Saved messages.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsMessages,
  commsNotificationPrefs,
  commsPinnedMessages,
  commsSavedMessages,
  users,
  type CommsNotificationPref,
  type CommsPinnedMessage,
} from "@shared/schema";
import { type MessageWithUser } from "./messages";

// ─── Notification prefs ───────────────────────────────────────────────────────

export type NotifPref = "all" | "mentions" | "muted";

export async function getNotificationPref(
  channelId: string,
  userId: string,
): Promise<CommsNotificationPref | null> {
  return withDbAttribution("comms:getNotificationPref", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsNotificationPrefs)
          .where(
            and(
              eq(commsNotificationPrefs.channelId, channelId),
              eq(commsNotificationPrefs.userId, userId),
            ),
          )
          .limit(1),
      "comms.getNotificationPref",
    );
    return row ?? null;
  });
}

export async function setNotificationPref(
  channelId: string,
  userId: string,
  pref: NotifPref,
): Promise<CommsNotificationPref> {
  return withDbAttribution("comms:setNotificationPref", async () => {
    const [row] = await getDb()
      .insert(commsNotificationPrefs)
      .values({ channelId, userId, pref })
      .onConflictDoUpdate({
        target: [commsNotificationPrefs.channelId, commsNotificationPrefs.userId],
        set: { pref, updatedAt: new Date() },
      })
      .returning();
    return row;
  });
}

export async function getMutedChannelIds(userId: string): Promise<string[]> {
  return withDbAttribution("comms:getMutedChannelIds", () =>
    dbRetry(
      () =>
        getDb()
          .select({ channelId: commsNotificationPrefs.channelId })
          .from(commsNotificationPrefs)
          .where(
            and(
              eq(commsNotificationPrefs.userId, userId),
              eq(commsNotificationPrefs.pref, "muted"),
            ),
          )
          .then((rows) => rows.map((r) => r.channelId)),
      "comms.getMutedChannelIds",
    ),
  );
}

export async function getChannelNotifPrefMap(
  userId: string,
  channelIds: string[],
): Promise<Map<string, NotifPref>> {
  if (channelIds.length === 0) return new Map();
  return withDbAttribution("comms:getChannelNotifPrefMap", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsNotificationPrefs.channelId,
            pref: commsNotificationPrefs.pref,
          })
          .from(commsNotificationPrefs)
          .where(
            and(
              eq(commsNotificationPrefs.userId, userId),
              inArray(commsNotificationPrefs.channelId, channelIds),
            ),
          ),
      "comms.getChannelNotifPrefMap",
    );
    const m = new Map<string, NotifPref>();
    for (const r of rows) m.set(r.channelId, r.pref as NotifPref);
    return m;
  });
}

/**
 * Returns a map of userId → NotifPref for the given channel and user IDs.
 * Used by the @channel / @here broadcast path to skip muted members.
 */
export async function getChannelMemberPrefMap(
  channelId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  return withDbAttribution("comms:getChannelMemberPrefMap", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            userId: commsNotificationPrefs.userId,
            pref: commsNotificationPrefs.pref,
          })
          .from(commsNotificationPrefs)
          .where(
            and(
              eq(commsNotificationPrefs.channelId, channelId),
              inArray(commsNotificationPrefs.userId, userIds),
            ),
          ),
      "comms.getChannelMemberPrefMap",
    );
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.userId, r.pref);
    return m;
  });
}

// ─── Pins ─────────────────────────────────────────────────────────────────────

export interface PinnedMessageWithUser extends CommsPinnedMessage {
  message: MessageWithUser;
}

export async function pinMessage(
  channelId: string,
  messageId: string,
  pinnedBy: string,
): Promise<{ pinned: boolean }> {
  return withDbAttribution("comms:pinMessage", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .insert(commsPinnedMessages)
          .values({ channelId, messageId, pinnedBy })
          .onConflictDoNothing()
          .returning({ id: commsPinnedMessages.id }),
      "comms.pinMessage",
    );
    return { pinned: rows.length > 0 };
  });
}

export async function unpinMessage(
  channelId: string,
  messageId: string,
): Promise<{ unpinned: boolean }> {
  return withDbAttribution("comms:unpinMessage", async () => {
    const rows = await getDb()
      .delete(commsPinnedMessages)
      .where(
        and(
          eq(commsPinnedMessages.channelId, channelId),
          eq(commsPinnedMessages.messageId, messageId),
        ),
      )
      .returning({ id: commsPinnedMessages.id });
    return { unpinned: rows.length > 0 };
  });
}

export async function getPinnedMessages(channelId: string): Promise<PinnedMessageWithUser[]> {
  return withDbAttribution("comms:getPinnedMessages", async () => {
    const pins = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsPinnedMessages)
          .where(eq(commsPinnedMessages.channelId, channelId))
          .orderBy(desc(commsPinnedMessages.createdAt)),
      "comms.getPinnedMessages",
    );
    if (pins.length === 0) return [];
    const messageIds = pins.map((p) => p.messageId);
    const msgs = await dbRetry(
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
          .where(inArray(commsMessages.id, messageIds)),
      "comms.getPinnedMessages.messages",
    );
    const msgMap = new Map<string, MessageWithUser>(
      msgs.map((r) => [
        r.message.id,
        { ...r.message, user: r.user?.id ? r.user : null, reactionCounts: {}, myReactions: [], replyCount: 0 },
      ]),
    );
    return pins
      .map((pin) => {
        const msg = msgMap.get(pin.messageId);
        if (!msg) return null;
        return { ...pin, message: msg };
      })
      .filter((p): p is PinnedMessageWithUser => p !== null);
  });
}

// ─── Saved messages ───────────────────────────────────────────────────────────

export async function saveMessage(
  userId: string,
  messageId: string,
): Promise<{ saved: boolean }> {
  return withDbAttribution("comms:saveMessage", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .insert(commsSavedMessages)
          .values({ userId, messageId })
          .onConflictDoNothing()
          .returning({ id: commsSavedMessages.id }),
      "comms.saveMessage",
    );
    return { saved: rows.length > 0 };
  });
}

export async function unsaveMessage(
  userId: string,
  messageId: string,
): Promise<{ unsaved: boolean }> {
  return withDbAttribution("comms:unsaveMessage", async () => {
    const rows = await getDb()
      .delete(commsSavedMessages)
      .where(
        and(
          eq(commsSavedMessages.userId, userId),
          eq(commsSavedMessages.messageId, messageId),
        ),
      )
      .returning({ id: commsSavedMessages.id });
    return { unsaved: rows.length > 0 };
  });
}

export async function getSavedMessages(
  userId: string,
  opts: { limit?: number } = {},
): Promise<MessageWithUser[]> {
  return withDbAttribution("comms:getSavedMessages", async () => {
    const limit = Math.min(opts.limit ?? 50, 100);
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
          .from(commsSavedMessages)
          .innerJoin(commsMessages, eq(commsSavedMessages.messageId, commsMessages.id))
          .leftJoin(users, eq(commsMessages.userId, users.id))
          .where(
            and(
              eq(commsSavedMessages.userId, userId),
              isNull(commsMessages.deletedAt),
            ),
          )
          .orderBy(desc(commsSavedMessages.createdAt))
          .limit(limit),
      "comms.getSavedMessages",
    );
    return rows.map((r) => ({
      ...r.message,
      user: r.user?.id ? r.user : null,
      reactionCounts: {}, myReactions: [],
      replyCount: 0,
    }));
  });
}

export async function isMessageSavedByUser(userId: string, messageId: string): Promise<boolean> {
  return withDbAttribution("comms:isMessageSavedByUser", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ id: commsSavedMessages.id })
          .from(commsSavedMessages)
          .where(
            and(
              eq(commsSavedMessages.userId, userId),
              eq(commsSavedMessages.messageId, messageId),
            ),
          )
          .limit(1),
      "comms.isMessageSavedByUser",
    );
    return !!row;
  });
}
