// @db-pool-intent: ambient
/**
 * NoBull Comms storage — incoming webhooks & thread members.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Incoming Webhooks, Thread members (following).
 */

import { and, desc, eq } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsWebhooks,
  commsThreadMembers,
  users,
  type CommsWebhook,
  type CommsThreadMember,
} from "@shared/schema";

// ─── Incoming Webhooks ───────────────────────────────────────────────────────

export interface WebhookWithChannelName extends CommsWebhook {
  channelName: string | null;
  createdByName: string | null;
}

export async function createWebhook(data: {
  channelId: string;
  name: string;
  tokenHash: string;
  createdBy: string | null;
  enabled?: boolean;
}): Promise<CommsWebhook> {
  return withDbAttribution("comms:createWebhook", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsWebhooks)
          .values({
            channelId: data.channelId,
            name: data.name,
            tokenHash: data.tokenHash,
            createdBy: data.createdBy,
            enabled: data.enabled ?? true,
          })
          .returning(),
      "comms.createWebhook",
    );
    return row;
  });
}

// ─── Thread members (following) ───────────────────────────────────────────────

/**
 * Idempotently ensures a follow record exists for (rootMessageId, userId).
 * If the record already exists, flips `following = true` (re-follow after unfollow).
 */
export async function autoFollowThread(
  rootMessageId: string,
  channelId: string,
  userId: string,
): Promise<CommsThreadMember> {
  return withDbAttribution("comms:autoFollowThread", async () => {
    const now = new Date();
    const [row] = await getDb()
      .insert(commsThreadMembers)
      .values({ rootMessageId, channelId, userId, following: true, lastReadReplyAt: new Date(0) })
      .onConflictDoUpdate({
        target: [commsThreadMembers.rootMessageId, commsThreadMembers.userId],
        set: { following: true, updatedAt: now },
      })
      .returning();
    return row;
  });
}

export async function getWebhookByTokenHash(hash: string): Promise<CommsWebhook | null> {
  return withDbAttribution("comms:getWebhookByTokenHash", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsWebhooks)
          .where(eq(commsWebhooks.tokenHash, hash))
          .limit(1),
      "comms.getWebhookByTokenHash",
    );
    return row ?? null;
  });
}

export async function listAllWebhooks(): Promise<WebhookWithChannelName[]> {
  return withDbAttribution("comms:listAllWebhooks", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            webhook: commsWebhooks,
            channelName: commsChannels.name,
            channelSlug: commsChannels.slug,
            createdByFirst: users.firstName,
            createdByLast: users.lastName,
          })
          .from(commsWebhooks)
          .leftJoin(commsChannels, eq(commsWebhooks.channelId, commsChannels.id))
          .leftJoin(users, eq(commsWebhooks.createdBy, users.id))
          .orderBy(desc(commsWebhooks.createdAt)),
      "comms.listAllWebhooks",
    );
    return rows.map((r) => ({
      ...r.webhook,
      channelName: r.channelName ?? r.channelSlug ?? null,
      createdByName:
        r.createdByFirst || r.createdByLast
          ? [r.createdByFirst, r.createdByLast].filter(Boolean).join(" ")
          : null,
    }));
  });
}

export async function revokeWebhook(id: string): Promise<CommsWebhook | null> {
  return withDbAttribution("comms:revokeWebhook", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsWebhooks)
      .set({ enabled: false, updatedAt: now })
      .where(eq(commsWebhooks.id, id))
      .returning();
    return row ?? null;
  });
}

/**
 * Explicitly follow a thread (manual follow).
 */
export async function followThread(
  rootMessageId: string,
  channelId: string,
  userId: string,
): Promise<CommsThreadMember> {
  return autoFollowThread(rootMessageId, channelId, userId);
}

/**
 * Unfollow a thread. Does not delete the row — preserves last_read_reply_at.
 */
export async function unfollowThread(
  rootMessageId: string,
  userId: string,
): Promise<CommsThreadMember | null> {
  return withDbAttribution("comms:unfollowThread", async () => {
    const [row] = await getDb()
      .update(commsThreadMembers)
      .set({ following: false, updatedAt: new Date() })
      .where(
        and(
          eq(commsThreadMembers.rootMessageId, rootMessageId),
          eq(commsThreadMembers.userId, userId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function touchWebhookLastUsed(id: string): Promise<void> {
  await withDbAttribution("comms:touchWebhookLastUsed", async () => {
    const now = new Date();
    await getDb()
      .update(commsWebhooks)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(commsWebhooks.id, id));
  });
}

