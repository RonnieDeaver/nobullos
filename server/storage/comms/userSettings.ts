// @db-pool-intent: ambient
/**
 * NoBull Comms storage — user status & notification settings.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: User status, User notification settings.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsMessages,
  commsReadStates,
  commsUserStatuses,
  commsUserNotificationSettings,
  type CommsUserStatus,
  type CommsManualStatus,
  type CommsUserNotificationSettings,
  type InsertCommsUserNotificationSettings,
} from "@shared/schema";

// ─── User status ──────────────────────────────────────────────────────────────

const MAX_RECENT_CUSTOM_STATUSES = 5;

export async function getUserStatus(userId: string): Promise<CommsUserStatus | null> {
  return withDbAttribution("comms:getUserStatus", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsUserStatuses)
          .where(eq(commsUserStatuses.userId, userId))
          .limit(1),
      "comms.getUserStatus",
    );
    return row ?? null;
  });
}

export async function getUserStatusBulk(
  userIds: string[],
): Promise<Map<string, CommsUserStatus>> {
  if (userIds.length === 0) return new Map();
  return withDbAttribution("comms:getUserStatusBulk", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsUserStatuses)
          .where(inArray(commsUserStatuses.userId, userIds)),
      "comms.getUserStatusBulk",
    );
    return new Map(rows.map((r) => [r.userId, r]));
  });
}

export async function setUserManualStatus(
  userId: string,
  manualStatus: CommsManualStatus,
  dndExpiresAt?: Date | null,
): Promise<CommsUserStatus> {
  return withDbAttribution("comms:setUserManualStatus", async () => {
    const now = new Date();
    const current = await getUserStatus(userId);

    // When entering DND, persist prior status so we can restore it on expiry.
    // If already DND, keep the prior_status that was saved when DND started.
    const priorStatus: CommsManualStatus | null =
      manualStatus === "dnd"
        ? current?.manualStatus !== "dnd"
          ? ((current?.manualStatus ?? "online") as CommsManualStatus)
          : (current?.priorStatus as CommsManualStatus | null ?? "online")
        : null;

    const [row] = await getDb()
      .insert(commsUserStatuses)
      .values({
        userId,
        manualStatus,
        dndExpiresAt: manualStatus === "dnd" ? (dndExpiresAt ?? null) : null,
        priorStatus: manualStatus === "dnd" ? priorStatus : null,
        customEmoji: current?.customEmoji ?? null,
        customText: current?.customText ?? null,
        customExpiresAt: current?.customExpiresAt ?? null,
        recentCustomStatuses: current?.recentCustomStatuses ?? [],
        lastActivityAt: current?.lastActivityAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: commsUserStatuses.userId,
        set: {
          manualStatus,
          dndExpiresAt: manualStatus === "dnd" ? (dndExpiresAt ?? null) : null,
          priorStatus: manualStatus === "dnd" ? priorStatus : null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  });
}

export async function setUserCustomStatus(
  userId: string,
  custom: { emoji: string; text: string; expiresAt?: Date | null } | null,
): Promise<CommsUserStatus> {
  return withDbAttribution("comms:setUserCustomStatus", async () => {
    const now = new Date();
    const current = await getUserStatus(userId);

    let recentCustomStatuses: Array<{ emoji: string; text: string }> =
      current?.recentCustomStatuses ?? [];

    if (custom) {
      // Deduplicate by emoji+text, prepend new entry, cap at MAX_RECENT.
      recentCustomStatuses = [
        { emoji: custom.emoji, text: custom.text },
        ...recentCustomStatuses.filter(
          (r) => !(r.emoji === custom.emoji && r.text === custom.text),
        ),
      ].slice(0, MAX_RECENT_CUSTOM_STATUSES);
    }

    const [row] = await getDb()
      .insert(commsUserStatuses)
      .values({
        userId,
        manualStatus: current?.manualStatus ?? null,
        dndExpiresAt: current?.dndExpiresAt ?? null,
        priorStatus: current?.priorStatus ?? null,
        customEmoji: custom?.emoji ?? null,
        customText: custom?.text ?? null,
        customExpiresAt: custom?.expiresAt ?? null,
        recentCustomStatuses,
        lastActivityAt: current?.lastActivityAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: commsUserStatuses.userId,
        set: {
          customEmoji: custom?.emoji ?? null,
          customText: custom?.text ?? null,
          customExpiresAt: custom?.expiresAt ?? null,
          recentCustomStatuses,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  });
}

/**
 * Updates last_activity_at for a user on each heartbeat.
 * Called from the heartbeat endpoint to persist the activity anchor.
 */
export async function touchUserActivity(userId: string): Promise<void> {
  await withDbAttribution("comms:touchUserActivity", async () => {
    const now = new Date();
    await getDb()
      .insert(commsUserStatuses)
      .values({
        userId,
        manualStatus: null,
        recentCustomStatuses: [],
        lastActivityAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: commsUserStatuses.userId,
        set: { lastActivityAt: now, updatedAt: now },
      });
  });
}

/**
 * Applies DND expiry lazily: if the row is in "dnd" and dnd_expires_at has
 * passed, restore prior_status and return the updated row.
 */
export async function resolveDndExpiry(
  userId: string,
  row: CommsUserStatus,
): Promise<CommsUserStatus> {
  if (
    row.manualStatus !== "dnd" ||
    !row.dndExpiresAt ||
    row.dndExpiresAt.getTime() > Date.now()
  ) {
    return row;
  }
  const restored = (row.priorStatus as CommsManualStatus | null) ?? "online";
  return setUserManualStatus(userId, restored === "dnd" ? "online" : restored);
}

// ─── User notification settings ──────────────────────────────────────────────

/**
 * Returns the global notification settings for a user, or null if the row
 * doesn't exist yet (callers should treat absent row as all-defaults).
 */
export async function getUserNotificationSettings(
  userId: string,
): Promise<CommsUserNotificationSettings | null> {
  return withDbAttribution("comms:getUserNotificationSettings", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsUserNotificationSettings)
          .where(eq(commsUserNotificationSettings.userId, userId))
          .limit(1),
      "comms.getUserNotificationSettings",
    );
    return row ?? null;
  });
}

/**
 * Upserts the global notification settings for a user.
 * Only the fields present in `data` are updated; all others keep their defaults.
 */
export async function upsertUserNotificationSettings(
  userId: string,
  data: Omit<InsertCommsUserNotificationSettings, "userId">,
): Promise<CommsUserNotificationSettings> {
  return withDbAttribution("comms:upsertUserNotificationSettings", async () => {
    const now = new Date();
    const [row] = await getDb()
      .insert(commsUserNotificationSettings)
      .values({ userId, ...data, updatedAt: now })
      .onConflictDoUpdate({
        target: commsUserNotificationSettings.userId,
        set: { ...data, updatedAt: now },
      })
      .returning();
    return row;
  });
}

/**
 * Returns per-channel keyword-hit unread counts for channels where at least one
 * of the user's keywords appears word-boundary (case-insensitive) in an unread
 * message that was NOT already counted as a direct @mention.
 *
 * Uses Postgres ~* (case-insensitive regex) with \m / \M word-boundary markers.
 */
export async function getKeywordUnreadCountsForUser(
  userId: string,
  channelIds: string[],
  keywords: string[],
): Promise<Map<string, number>> {
  if (keywords.length === 0 || channelIds.length === 0) return new Map();

  // Build a single alternation pattern for all keywords
  const escapedTerms = keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escapedTerms.length === 0) return new Map();

  const kwPattern = `\\m(${escapedTerms.join("|")})\\M`;
  // Exclude already-direct-mentioned messages to avoid double-counting
  const mentionLike = `%(user:${userId})%`;

  return withDbAttribution("comms:getKeywordUnreadCountsForUser", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsMessages.channelId,
            hitCount: sql<number>`count(*)::int`,
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
              // Only count messages that are NOT already direct @mentions
              sql`${commsMessages.content} NOT LIKE ${mentionLike}`,
              // Match any keyword with word boundary
              sql`${commsMessages.content} ~* ${kwPattern}`,
            ),
          )
          .groupBy(commsMessages.channelId),
      "comms.getKeywordUnreadCountsForUser",
    );
    return new Map(rows.map((r) => [r.channelId, Number(r.hitCount ?? 0)]));
  });
}

/**
 * Applies custom-status expiry lazily: if custom_expires_at has passed,
 * clears the custom status fields and returns the updated row.
 */
export async function resolveCustomStatusExpiry(
  userId: string,
  row: CommsUserStatus,
): Promise<CommsUserStatus> {
  if (!row.customExpiresAt || row.customExpiresAt.getTime() > Date.now()) {
    return row;
  }
  return setUserCustomStatus(userId, null);
}
