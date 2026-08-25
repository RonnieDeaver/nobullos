// @db-pool-intent: ambient
/**
 * NoBull Comms storage — reminders & forwarding.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Reminders, Forwarding.
 */

import { and, asc, eq, lte } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsMessages,
  commsMessageReminders,
  users,
  type CommsMessage,
  type CommsMessageReminder,
} from "@shared/schema";

// ─── Reminders ───────────────────────────────────────────────────────────────

export async function createReminder(
  userId: string,
  messageId: string,
  channelId: string,
  remindAt: Date,
  note?: string,
): Promise<CommsMessageReminder> {
  return withDbAttribution("comms:createReminder", async () => {
    const [row] = await getDb()
      .insert(commsMessageReminders)
      .values({ userId, messageId, channelId, remindAt, note: note ?? null, status: "pending" })
      .returning();
    return row;
  });
}

export async function listRemindersForUser(
  userId: string,
): Promise<CommsMessageReminder[]> {
  return withDbAttribution("comms:listRemindersForUser", async () =>
    getDb()
      .select()
      .from(commsMessageReminders)
      .where(and(eq(commsMessageReminders.userId, userId), eq(commsMessageReminders.status, "pending")))
      .orderBy(asc(commsMessageReminders.remindAt)),
  );
}

export async function cancelReminder(
  id: string,
  userId: string,
): Promise<boolean> {
  return withDbAttribution("comms:cancelReminder", async () => {
    const [row] = await getDb()
      .update(commsMessageReminders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(commsMessageReminders.id, id), eq(commsMessageReminders.userId, userId)))
      .returning({ id: commsMessageReminders.id });
    return !!row;
  });
}

export async function claimDueReminders(limit: number): Promise<CommsMessageReminder[]> {
  return withDbAttribution("comms:claimDueReminders", async () =>
    getDb()
      .select()
      .from(commsMessageReminders)
      .where(and(
        eq(commsMessageReminders.status, "pending"),
        lte(commsMessageReminders.remindAt, new Date()),
      ))
      .limit(limit),
  );
}

export async function markReminderDelivered(id: string): Promise<void> {
  return withDbAttribution("comms:markReminderDelivered", async () => {
    await getDb()
      .update(commsMessageReminders)
      .set({ status: "delivered", updatedAt: new Date() })
      .where(eq(commsMessageReminders.id, id));
  });
}

// ─── Forwarding ───────────────────────────────────────────────────────────────

export async function forwardMessage(
  sourceMessageId: string,
  targetChannelId: string,
  senderId: string,
  comment?: string,
): Promise<CommsMessage | null> {
  return withDbAttribution("comms:forwardMessage", async () => {
    const [source] = await getDb()
      .select({
        msg: commsMessages,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(commsMessages)
      .leftJoin(users, eq(commsMessages.userId, users.id))
      .where(eq(commsMessages.id, sourceMessageId))
      .limit(1);
    if (!source?.msg) return null;

    const [ch] = await getDb()
      .select({ name: commsChannels.name })
      .from(commsChannels)
      .where(eq(commsChannels.id, source.msg.channelId))
      .limit(1);

    const authorName = source.firstName || source.lastName
      ? [source.firstName, source.lastName].filter(Boolean).join(" ")
      : "Unknown";

    const forwardedFrom = {
      messageId: source.msg.id,
      channelId: source.msg.channelId,
      channelName: ch?.name ?? null,
      authorName,
      content: source.msg.content,
      createdAt: source.msg.createdAt,
    };

    const content = comment ? comment : "";

    const now = new Date();
    const [row] = await getDb()
      .insert(commsMessages)
      .values({
        channelId: targetChannelId,
        userId: senderId,
        content,
        contentType: "text",
        metadata: { forwardedFrom },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row ?? null;
  });
}
