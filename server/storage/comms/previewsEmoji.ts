// @db-pool-intent: ambient
/**
 * NoBull Comms storage — link previews & custom emoji.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Link previews, Custom emoji, Emoji usage (frequently used).
 */

import { desc, eq, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import type { UnfurlResult } from "../../services/commsUnfurl";
import {
  commsMessages,
  commsLinkPreviews,
  commsCustomEmoji,
  commsEmojiUsage,
  type CommsCustomEmoji,
  type CommsEmojiUsage,
  type CommsLinkPreview,
} from "@shared/schema";

// ─── Link previews ──────────────────────────────────────────────────────────

/**
 * Upsert a link preview result. ON CONFLICT on url updates the OG fields.
 * Runs outside any DB hold (callers fire-and-forget from the route layer).
 */
export async function upsertLinkPreview(result: UnfurlResult): Promise<CommsLinkPreview> {
  return withDbAttribution("comms:upsertLinkPreview", async () => {
    const cachedUntil = new Date(result.fetchedAt.getTime() + 24 * 60 * 60 * 1000);
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsLinkPreviews)
          .values({
            url: result.url,
            title: result.title,
            description: result.description,
            imageUrl: result.imageUrl,
            siteName: result.siteName,
            faviconUrl: result.faviconUrl,
            error: result.error,
            fetchedAt: result.fetchedAt,
            cachedUntil,
          })
          .onConflictDoUpdate({
            target: commsLinkPreviews.url,
            set: {
              title: result.title,
              description: result.description,
              imageUrl: result.imageUrl,
              siteName: result.siteName,
              faviconUrl: result.faviconUrl,
              error: result.error,
              fetchedAt: result.fetchedAt,
              cachedUntil,
            },
          })
          .returning(),
      "comms.upsertLinkPreview",
    );
    return row;
  });
}

/**
 * Fetch a persisted link preview by URL (for cache hydration on startup).
 */
export async function getLinkPreviewByUrl(url: string): Promise<CommsLinkPreview | null> {
  return withDbAttribution("comms:getLinkPreviewByUrl", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsLinkPreviews)
          .where(eq(commsLinkPreviews.url, url))
          .limit(1),
      "comms.getLinkPreviewByUrl",
    );
    return row ?? null;
  });
}

/**
 * Patch a message's metadata to append/replace linkPreviews.
 * Uses a JSON merge so other existing metadata keys are preserved.
 */
// ─── Custom emoji ─────────────────────────────────────────────────────────────

export async function listCustomEmoji(): Promise<CommsCustomEmoji[]> {
  return withDbAttribution("comms:listCustomEmoji", () =>
    dbRetry(
      () => getDb().select().from(commsCustomEmoji).orderBy(commsCustomEmoji.name),
      "comms.listCustomEmoji",
    ),
  );
}

export async function getCustomEmojiByName(name: string): Promise<CommsCustomEmoji | null> {
  return withDbAttribution("comms:getCustomEmojiByName", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsCustomEmoji)
          .where(eq(commsCustomEmoji.name, name))
          .limit(1),
      "comms.getCustomEmojiByName",
    );
    return row ?? null;
  });
}

export async function getCustomEmojiById(id: string): Promise<CommsCustomEmoji | null> {
  return withDbAttribution("comms:getCustomEmojiById", async () => {
    const [row] = await dbRetry(
      () =>
        getDb().select().from(commsCustomEmoji).where(eq(commsCustomEmoji.id, id)).limit(1),
      "comms.getCustomEmojiById",
    );
    return row ?? null;
  });
}

export async function createCustomEmoji(data: {
  name: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number | null;
  createdBy: string | null;
}): Promise<CommsCustomEmoji> {
  return withDbAttribution("comms:createCustomEmoji", async () => {
    const [row] = await dbRetry(
      () => getDb().insert(commsCustomEmoji).values(data).returning(),
      "comms.createCustomEmoji",
    );
    return row;
  });
}

export async function deleteCustomEmoji(id: string): Promise<boolean> {
  return withDbAttribution("comms:deleteCustomEmoji", async () => {
    const rows = await getDb()
      .delete(commsCustomEmoji)
      .where(eq(commsCustomEmoji.id, id))
      .returning({ id: commsCustomEmoji.id });
    return rows.length > 0;
  });
}

export async function searchCustomEmoji(
  query: string,
  limit = 20,
): Promise<CommsCustomEmoji[]> {
  return withDbAttribution("comms:searchCustomEmoji", () =>
    dbRetry(
      () =>
        getDb()
          .select()
          .from(commsCustomEmoji)
          .where(sql`${commsCustomEmoji.name} ILIKE ${`%${query}%`}`)
          .orderBy(commsCustomEmoji.name)
          .limit(limit),
      "comms.searchCustomEmoji",
    ),
  );
}

// ─── Emoji usage (frequently used) ───────────────────────────────────────────

/**
 * Record one use of an emoji for a user.
 * Upserts the usage row: increments use_count and refreshes last_used_at.
 */
export async function trackEmojiUsage(userId: string, emoji: string): Promise<void> {
  return withDbAttribution("comms:trackEmojiUsage", async () => {
    await dbRetry(
      () =>
        getDb()
          .insert(commsEmojiUsage)
          .values({ userId, emoji, useCount: 1, lastUsedAt: new Date() })
          .onConflictDoUpdate({
            target: [commsEmojiUsage.userId, commsEmojiUsage.emoji],
            set: {
              useCount: sql`${commsEmojiUsage.useCount} + 1`,
              lastUsedAt: new Date(),
            },
          }),
      "comms.trackEmojiUsage",
    );
  });
}

export async function getFrequentlyUsedEmoji(
  userId: string,
  limit = 24,
): Promise<CommsEmojiUsage[]> {
  return withDbAttribution("comms:getFrequentlyUsedEmoji", () =>
    dbRetry(
      () =>
        getDb()
          .select()
          .from(commsEmojiUsage)
          .where(eq(commsEmojiUsage.userId, userId))
          .orderBy(desc(commsEmojiUsage.useCount), desc(commsEmojiUsage.lastUsedAt))
          .limit(limit),
      "comms.getFrequentlyUsedEmoji",
    ),
  );
}

export async function setMessageLinkPreviews(
  messageId: string,
  previews: Array<{
    url: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
    faviconUrl: string | null;
  }>,
): Promise<void> {
  return withDbAttribution("comms:setMessageLinkPreviews", async () => {
    await dbRetry(
      () =>
        getDb()
          .update(commsMessages)
          .set({
            metadata: sql`COALESCE(${commsMessages.metadata}, '{}'::jsonb) || ${JSON.stringify({ linkPreviews: previews })}::jsonb`,
          })
          .where(eq(commsMessages.id, messageId)),
      "comms.setMessageLinkPreviews",
    );
  });
}
