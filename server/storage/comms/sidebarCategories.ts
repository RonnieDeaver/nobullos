// @db-pool-intent: ambient
/**
 * NoBull Comms storage — sidebar categories.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Sidebar Categories.
 */

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import {
  commsMessages,
  commsThreadMembers,
  commsSidebarCategories,
  commsSidebarCategoryItems,
  type CommsSidebarCategory,
} from "@shared/schema";
import { type FollowedThreadItem } from "./bookmarks";

// ─── Sidebar Categories ───────────────────────────────────────────────────────

export interface SidebarCategoryResponse {
  id: string;
  userId: string;
  name: string;
  type: string;
  sortOrder: number;
  collapsed: boolean;
  clientSubgroupCollapsed: boolean;
  sorting: string;
  unreadsOnTop: boolean;
  channelIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export async function getSidebarCategoriesForUser(userId: string): Promise<SidebarCategoryResponse[]> {
  return withDbAttribution("comms:getSidebarCategoriesForUser", async () => {
    const db = getDb();
    let cats = await db
      .select()
      .from(commsSidebarCategories)
      .where(eq(commsSidebarCategories.userId, userId))
      .orderBy(asc(commsSidebarCategories.sortOrder), asc(commsSidebarCategories.createdAt));

    // Lazily create any missing built-in categories so the client always
    // receives real, persistable rows (needed for collapse/reorder/drop targets).
    const builtIns: Array<"favorites" | "channels" | "dms"> = ["favorites", "channels", "dms"];
    const missing = builtIns.filter((t) => !cats.some((c) => c.type === t));
    if (missing.length > 0) {
      for (const type of missing) {
        await ensureBuiltInCategory(userId, type);
      }
      cats = await db
        .select()
        .from(commsSidebarCategories)
        .where(eq(commsSidebarCategories.userId, userId))
        .orderBy(asc(commsSidebarCategories.sortOrder), asc(commsSidebarCategories.createdAt));
    }

    if (cats.length === 0) return [];

    const catIds = cats.map((c) => c.id);
    const items = await db
      .select()
      .from(commsSidebarCategoryItems)
      .where(
        and(
          eq(commsSidebarCategoryItems.userId, userId),
          inArray(commsSidebarCategoryItems.categoryId, catIds),
        ),
      )
      .orderBy(asc(commsSidebarCategoryItems.position), asc(commsSidebarCategoryItems.createdAt));

    const itemsByCategory = new Map<string, string[]>();
    for (const item of items) {
      const list = itemsByCategory.get(item.categoryId) ?? [];
      list.push(item.channelId);
      itemsByCategory.set(item.categoryId, list);
    }

    return cats.map((c) => ({
      id: c.id,
      userId: c.userId,
      name: c.name,
      type: c.type,
      sortOrder: c.sortOrder,
      collapsed: c.collapsed,
      clientSubgroupCollapsed: c.clientSubgroupCollapsed,
      sorting: c.sorting,
      unreadsOnTop: c.unreadsOnTop,
      channelIds: itemsByCategory.get(c.id) ?? [],
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  });
}

export async function ensureBuiltInCategory(
  userId: string,
  type: "favorites" | "channels" | "dms",
): Promise<CommsSidebarCategory> {
  return withDbAttribution("comms:ensureBuiltInCategory", async () => {
    const db = getDb();
    const existing = await db
      .select()
      .from(commsSidebarCategories)
      .where(
        and(
          eq(commsSidebarCategories.userId, userId),
          eq(commsSidebarCategories.type, type),
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0];

    const nameMap: Record<string, string> = {
      favorites: "Favorites",
      channels: "Channels",
      dms: "Direct Messages",
    };
    const sortMap: Record<string, number> = { favorites: 0, channels: 1, dms: 2 };

    const [created] = await db
      .insert(commsSidebarCategories)
      .values({
        userId,
        name: nameMap[type],
        type,
        sortOrder: sortMap[type],
        sorting: type === "favorites" ? "manual" : "recent",
      })
      .returning();
    return created;
  });
}

export async function createSidebarCategory(
  userId: string,
  name: string,
): Promise<CommsSidebarCategory> {
  return withDbAttribution("comms:createSidebarCategory", async () => {
    const db = getDb();
    const existing = await db
      .select({ sortOrder: commsSidebarCategories.sortOrder })
      .from(commsSidebarCategories)
      .where(eq(commsSidebarCategories.userId, userId))
      .orderBy(desc(commsSidebarCategories.sortOrder))
      .limit(1);
    const nextOrder = existing.length > 0 ? existing[0].sortOrder + 1 : 3;

    const [created] = await db
      .insert(commsSidebarCategories)
      .values({ userId, name: name.slice(0, 80), type: "custom", sortOrder: nextOrder, sorting: "manual" })
      .returning();
    return created;
  });
}

export async function updateSidebarCategory(
  id: string,
  userId: string,
  data: {
    name?: string;
    collapsed?: boolean;
    clientSubgroupCollapsed?: boolean;
    sorting?: string;
    unreadsOnTop?: boolean;
  },
): Promise<CommsSidebarCategory | null> {
  return withDbAttribution("comms:updateSidebarCategory", async () => {
    const db = getDb();
    const setData: Partial<typeof commsSidebarCategories.$inferInsert> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) setData.name = data.name.slice(0, 80);
    if (data.collapsed !== undefined) setData.collapsed = data.collapsed;
    if (data.clientSubgroupCollapsed !== undefined) setData.clientSubgroupCollapsed = data.clientSubgroupCollapsed;
    if (data.sorting !== undefined) setData.sorting = data.sorting;
    if (data.unreadsOnTop !== undefined) setData.unreadsOnTop = data.unreadsOnTop;

    const rows = await db
      .update(commsSidebarCategories)
      .set(setData)
      .where(
        and(
          eq(commsSidebarCategories.id, id),
          eq(commsSidebarCategories.userId, userId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

export async function deleteSidebarCategory(id: string, userId: string): Promise<boolean> {
  return withDbAttribution("comms:deleteSidebarCategory", async () => {
    const db = getDb();
    const [cat] = await db
      .select()
      .from(commsSidebarCategories)
      .where(
        and(
          eq(commsSidebarCategories.id, id),
          eq(commsSidebarCategories.userId, userId),
        ),
      )
      .limit(1);
    if (!cat || cat.type !== "custom") return false;

    await db
      .delete(commsSidebarCategories)
      .where(
        and(
          eq(commsSidebarCategories.id, id),
          eq(commsSidebarCategories.userId, userId),
        ),
      );
    return true;
  });
}

export async function reorderSidebarCategories(
  userId: string,
  orderedIds: string[],
): Promise<void> {
  await withDbAttribution("comms:reorderSidebarCategories", async () => {
    const db = getDb();
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(commsSidebarCategories)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(
            and(
              eq(commsSidebarCategories.id, orderedIds[i]),
              eq(commsSidebarCategories.userId, userId),
            ),
          );
      }
    });
  });
}


/**
 * Get aggregate thread unread counts for a user across all followed threads.
 * Returns { totalUnreadReplies, totalMentions }.
 */
export async function getThreadUnreadSummary(
  userId: string,
): Promise<{ totalUnreadReplies: number; totalMentions: number }> {
  return withDbAttribution("comms:getThreadUnreadSummary", async () => {
    const memberRows = await getDb()
      .select({
        rootMessageId: commsThreadMembers.rootMessageId,
        channelId: commsThreadMembers.channelId,
        lastReadReplyAt: commsThreadMembers.lastReadReplyAt,
      })
      .from(commsThreadMembers)
      .where(
        and(eq(commsThreadMembers.userId, userId), eq(commsThreadMembers.following, true)),
      );

    if (memberRows.length === 0) return { totalUnreadReplies: 0, totalMentions: 0 };

    const mentionPatternForUser = `%(user:${userId})%`;

    let totalUnreadReplies = 0;
    let totalMentions = 0;

    for (const member of memberRows) {
      const [counts] = await getDb()
        .select({
          unread: sql<number>`count(*)::int`,
          mentions: sql<number>`sum(case when ${commsMessages.content} like ${mentionPatternForUser} then 1 else 0 end)::int`,
        })
        .from(commsMessages)
        .where(
          and(
            eq(commsMessages.channelId, member.channelId),
            eq(commsMessages.parentId, member.rootMessageId),
            gt(commsMessages.createdAt, member.lastReadReplyAt),
            isNull(commsMessages.deletedAt),
          ),
        );
      totalUnreadReplies += counts?.unread ?? 0;
      totalMentions += counts?.mentions ?? 0;
    }

    return { totalUnreadReplies, totalMentions };
  });
}

/**
 * Enrich a listFollowedThreads result with per-thread unread counts.
 * Kept separate to allow callers to batch or skip as needed.
 */
export async function enrichFollowedThreadsWithUnread(
  userId: string,
  items: FollowedThreadItem[],
): Promise<FollowedThreadItem[]> {
  if (items.length === 0) return items;
  return withDbAttribution("comms:enrichFollowedThreadsWithUnread", async () => {
    const mentionPatternForUser = `%(user:${userId})%`;
    const enriched = await Promise.all(
      items.map(async (item) => {
        const [counts] = await getDb()
          .select({
            unread: sql<number>`count(*)::int`,
            mentions: sql<number>`sum(case when ${commsMessages.content} like ${mentionPatternForUser} then 1 else 0 end)::int`,
          })
          .from(commsMessages)
          .where(
            and(
              eq(commsMessages.channelId, item.channelId),
              eq(commsMessages.parentId, item.rootMessageId),
              gt(commsMessages.createdAt, item.lastReadReplyAt),
              isNull(commsMessages.deletedAt),
            ),
          );
        return {
          ...item,
          unreadReplies: counts?.unread ?? 0,
          mentionCount: counts?.mentions ?? 0,
        };
      }),
    );
    return enriched;
  });
}

export async function addChannelToCategory(
  categoryId: string,
  userId: string,
  channelId: string,
): Promise<void> {
  await withDbAttribution("comms:addChannelToCategory", async () => {
    const db = getDb();
    const existing = await db
      .select({ position: commsSidebarCategoryItems.position })
      .from(commsSidebarCategoryItems)
      .where(eq(commsSidebarCategoryItems.categoryId, categoryId))
      .orderBy(desc(commsSidebarCategoryItems.position))
      .limit(1);
    const nextPosition = existing.length > 0 ? existing[0].position + 1 : 0;

    await db
      .insert(commsSidebarCategoryItems)
      .values({ categoryId, userId, channelId, position: nextPosition })
      .onConflictDoNothing();
  });
}

export async function removeChannelFromCategory(
  categoryId: string,
  userId: string,
  channelId: string,
): Promise<void> {
  await withDbAttribution("comms:removeChannelFromCategory", async () => {
    await getDb()
      .delete(commsSidebarCategoryItems)
      .where(
        and(
          eq(commsSidebarCategoryItems.categoryId, categoryId),
          eq(commsSidebarCategoryItems.userId, userId),
          eq(commsSidebarCategoryItems.channelId, channelId),
        ),
      );
  });
}

export async function reorderCategoryItems(
  categoryId: string,
  userId: string,
  orderedChannelIds: string[],
): Promise<void> {
  await withDbAttribution("comms:reorderCategoryItems", async () => {
    const db = getDb();
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedChannelIds.length; i++) {
        await tx
          .update(commsSidebarCategoryItems)
          .set({ position: i })
          .where(
            and(
              eq(commsSidebarCategoryItems.categoryId, categoryId),
              eq(commsSidebarCategoryItems.userId, userId),
              eq(commsSidebarCategoryItems.channelId, orderedChannelIds[i]),
            ),
          );
      }
    });
  });
}

export async function toggleFavoriteChannel(
  userId: string,
  channelId: string,
): Promise<boolean> {
  return withDbAttribution("comms:toggleFavoriteChannel", async () => {
    const favCat = await ensureBuiltInCategory(userId, "favorites");
    const db = getDb();

    const existing = await db
      .select()
      .from(commsSidebarCategoryItems)
      .where(
        and(
          eq(commsSidebarCategoryItems.categoryId, favCat.id),
          eq(commsSidebarCategoryItems.channelId, channelId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .delete(commsSidebarCategoryItems)
        .where(
          and(
            eq(commsSidebarCategoryItems.categoryId, favCat.id),
            eq(commsSidebarCategoryItems.channelId, channelId),
          ),
        );
      return false;
    }

    const posRows = await db
      .select({ position: commsSidebarCategoryItems.position })
      .from(commsSidebarCategoryItems)
      .where(eq(commsSidebarCategoryItems.categoryId, favCat.id))
      .orderBy(desc(commsSidebarCategoryItems.position))
      .limit(1);
    const nextPosition = posRows.length > 0 ? posRows[0].position + 1 : 0;

    await db
      .insert(commsSidebarCategoryItems)
      .values({ categoryId: favCat.id, userId, channelId, position: nextPosition })
      .onConflictDoNothing();
    return true;
  });
}

export async function migratePinsToFavorites(
  userId: string,
  channelIds: string[],
): Promise<void> {
  if (channelIds.length === 0) return;
  await withDbAttribution("comms:migratePinsToFavorites", async () => {
    const favCat = await ensureBuiltInCategory(userId, "favorites");
    const db = getDb();

    const existing = await db
      .select({ channelId: commsSidebarCategoryItems.channelId })
      .from(commsSidebarCategoryItems)
      .where(eq(commsSidebarCategoryItems.categoryId, favCat.id));
    const existingIds = new Set(existing.map((r) => r.channelId));
    const toAdd = channelIds.filter((id) => !existingIds.has(id));
    if (toAdd.length === 0) return;

    await db
      .insert(commsSidebarCategoryItems)
      .values(
        toAdd.map((channelId, i) => ({
          categoryId: favCat.id,
          userId,
          channelId,
          position: i,
        })),
      )
      .onConflictDoNothing();
  });
}
