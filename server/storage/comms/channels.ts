// @db-pool-intent: ambient
/**
 * NoBull Comms storage — channels.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Channels, Channel members.
 */

import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  users,
  clients,
  type CommsChannel,
  type CommsChannelMember,
  type InsertCommsChannel,
} from "@shared/schema";

// ─── Channels ────────────────────────────────────────────────────────────────

export async function listChannelsForUser(userId: string): Promise<CommsChannel[]> {
  return withDbAttribution("comms:listChannelsForUser", () =>
    dbRetry(
      () =>
        getDb()
          .select({ channel: commsChannels })
          .from(commsChannels)
          // LEFT JOIN so client-bound channels (team-wide, no membership required)
          // are included even when the user has no membership row.
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
                // User is an explicit member (DMs, general channels, etc.)
                isNotNull(commsChannelMembers.userId),
                // OR it's a client-bound channel (team-wide by default)
                isNotNull(commsChannels.clientId),
              ),
            ),
          )
          .orderBy(commsChannels.name)
          .then((rows) => rows.map((r) => r.channel)),
      "comms.listChannelsForUser",
    ),
  );
}

/**
 * For each DM / group-DM channel, returns the display names of the OTHER
 * participants (i.e. everyone except `currentUserId`).
 * Returns a Map<channelId, string[]> — empty array when no other member row is
 * found (deleted user, race during load).  Channels not in the input list are
 * absent from the map (treat as empty array at the call site).
 */
export async function getDmParticipantNamesForChannels(
  channelIds: string[],
  currentUserId: string,
): Promise<Map<string, string[]>> {
  const participants = await getDmParticipantsForChannels(channelIds, currentUserId);
  const m = new Map<string, string[]>();
  for (const [channelId, list] of participants) {
    m.set(channelId, list.map((p) => p.name));
  }
  return m;
}

/**
 * Like getDmParticipantNamesForChannels, but keeps each name paired with its
 * userId so clients can match a participant name to a per-user presence dot
 * (Task #3342). Returns Map<channelId, { userId, name }[]> sorted by name;
 * rows whose user has no usable display name are skipped (matching the
 * names-only helper's behavior).
 */
export async function getDmParticipantsForChannels(
  channelIds: string[],
  currentUserId: string,
): Promise<Map<string, { userId: string; name: string }[]>> {
  if (channelIds.length === 0) return new Map();
  return withDbAttribution("comms:getDmParticipantNamesForChannels", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsChannelMembers.channelId,
            userId: commsChannelMembers.userId,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(commsChannelMembers)
          .innerJoin(users, eq(commsChannelMembers.userId, users.id))
          .where(
            and(
              inArray(commsChannelMembers.channelId, channelIds),
              sql`${commsChannelMembers.userId} != ${currentUserId}`,
            ),
          )
          .orderBy(asc(users.firstName), asc(users.lastName)),
      "comms.getDmParticipantNamesForChannels",
    );
    const m = new Map<string, { userId: string; name: string }[]>();
    for (const r of rows) {
      const fullName = [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
      // Fall back to email local-part when no first/last name is set.
      // If neither name nor email is available, skip the row (deleted/anonymous user).
      const name = fullName || (r.email ? r.email.split("@")[0] : "");
      if (!name) continue;
      const entry = { userId: r.userId, name };
      const existing = m.get(r.channelId);
      if (existing) {
        existing.push(entry);
      } else {
        m.set(r.channelId, [entry]);
      }
    }
    return m;
  });
}

export async function getClientFirmNamesForChannels(clientIds: string[]): Promise<Map<string, string>> {
  if (clientIds.length === 0) return new Map();
  return withDbAttribution("comms:getClientFirmNamesForChannels", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({ id: clients.id, firmName: clients.firmName })
          .from(clients)
          .where(inArray(clients.id, clientIds)),
      "comms.getClientFirmNamesForChannels",
    );
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.firmName) m.set(r.id, r.firmName);
    }
    return m;
  });
}

export async function getLastMessageTimestampsForChannels(channelIds: string[]): Promise<Map<string, string>> {
  if (channelIds.length === 0) return new Map();
  return withDbAttribution("comms:getLastMessageTimestampsForChannels", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            channelId: commsMessages.channelId,
            lastAt: sql<string>`MAX(${commsMessages.createdAt})`,
          })
          .from(commsMessages)
          .where(
            and(
              inArray(commsMessages.channelId, channelIds),
              isNull(commsMessages.parentId),
              isNull(commsMessages.deletedAt),
            ),
          )
          .groupBy(commsMessages.channelId),
      "comms.getLastMessageTimestampsForChannels",
    );
    return new Map(rows.map((r) => [r.channelId, r.lastAt]));
  });
}

export async function listPublicChannels(): Promise<CommsChannel[]> {
  return withDbAttribution("comms:listPublicChannels", () =>
    dbRetry(
      () =>
        getDb()
          .select()
          .from(commsChannels)
          .where(
            and(
              eq(commsChannels.type, "channel"),
              eq(commsChannels.visibility, "public"),
              isNull(commsChannels.archivedAt),
            ),
          )
          .orderBy(commsChannels.name),
      "comms.listPublicChannels",
    ),
  );
}

export async function getChannelById(id: string): Promise<CommsChannel | null> {
  return withDbAttribution("comms:getChannelById", async () => {
    const [row] = await dbRetry(
      () => getDb().select().from(commsChannels).where(eq(commsChannels.id, id)).limit(1),
      "comms.getChannelById",
    );
    return row ?? null;
  });
}

export async function getChannelBySlug(slug: string): Promise<CommsChannel | null> {
  return withDbAttribution("comms:getChannelBySlug", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsChannels)
          .where(and(eq(commsChannels.slug, slug), isNull(commsChannels.archivedAt)))
          .limit(1),
      "comms.getChannelBySlug",
    );
    return row ?? null;
  });
}

export async function getChannelByClientId(clientId: string): Promise<CommsChannel | null> {
  return withDbAttribution("comms:getChannelByClientId", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsChannels)
          .where(
            and(
              eq(commsChannels.clientId, clientId),
              eq(commsChannels.type, "channel"),
              isNull(commsChannels.archivedAt),
            ),
          )
          .orderBy(commsChannels.createdAt)
          .limit(1),
      "comms.getChannelByClientId",
    );
    return row ?? null;
  });
}

export async function createChannel(data: InsertCommsChannel): Promise<CommsChannel> {
  return withDbAttribution("comms:createChannel", async () => {
    const [row] = await dbRetry(
      () => getDb().insert(commsChannels).values(data).returning(),
      "comms.createChannel",
    );
    return row;
  });
}

export async function updateChannel(
  id: string,
  data: Partial<Pick<CommsChannel, "name" | "slug" | "topic" | "description" | "clientId" | "visibility">>,
): Promise<CommsChannel | null> {
  return withDbAttribution("comms:updateChannel", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsChannels)
      .set({ ...data, updatedAt: now })
      .where(eq(commsChannels.id, id))
      .returning();
    return row ?? null;
  });
}

export async function archiveChannel(id: string): Promise<CommsChannel | null> {
  return withDbAttribution("comms:archiveChannel", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsChannels)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(commsChannels.id, id))
      .returning();
    return row ?? null;
  });
}

// ─── Channel members ─────────────────────────────────────────────────────────

export async function getChannelMembers(channelId: string): Promise<CommsChannelMember[]> {
  return withDbAttribution("comms:getChannelMembers", () =>
    dbRetry(
      () =>
        getDb()
          .select()
          .from(commsChannelMembers)
          .where(eq(commsChannelMembers.channelId, channelId)),
      "comms.getChannelMembers",
    ),
  );
}

export async function getChannelMemberIds(channelId: string): Promise<string[] | null> {
  return withDbAttribution("comms:getChannelMemberIds", async () => {
    // Join commsChannels so we can detect client-bound (team-wide) channels in
    // one query. If clientId is non-null the channel is team-wide; return null
    // so callers omit targetUserIds from their broadcast, causing deliverLocal
    // to fan-out to ALL connected SSE subscribers instead of an empty member set.
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            clientId: commsChannels.clientId,
            userId: commsChannelMembers.userId,
          })
          .from(commsChannels)
          .leftJoin(
            commsChannelMembers,
            eq(commsChannelMembers.channelId, commsChannels.id),
          )
          .where(eq(commsChannels.id, channelId)),
      "comms.getChannelMemberIds",
    );
    if (rows.length > 0 && rows[0].clientId != null) return null;
    return rows
      .map((r) => r.userId)
      .filter((uid): uid is string => uid !== null);
  });
}

export async function isChannelMember(
  channelId: string,
  userId: string,
  opts?: { allowArchived?: boolean },
): Promise<boolean> {
  return withDbAttribution("comms:isChannelMember", async () => {
    // Client-bound channels are team-wide (no membership row needed).
    // Archived channels excluded by default; pass allowArchived:true for read-only history.
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ id: commsChannels.id })
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
              eq(commsChannels.id, channelId),
              opts?.allowArchived ? undefined : isNull(commsChannels.archivedAt),
              or(
                isNotNull(commsChannelMembers.userId),
                isNotNull(commsChannels.clientId),
              ),
            ),
          )
          .limit(1),
      "comms.isChannelMember",
    );
    return !!row;
  });
}

export async function addChannelMember(
  channelId: string,
  userId: string,
  role: "owner" | "channel_admin" | "member" = "member",
): Promise<CommsChannelMember> {
  return withDbAttribution("comms:addChannelMember", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsChannelMembers)
          .values({ channelId, userId, role })
          .onConflictDoNothing()
          .returning(),
      "comms.addChannelMember",
    );
    if (!row) {
      const [existing] = await getDb()
        .select()
        .from(commsChannelMembers)
        .where(
          and(
            eq(commsChannelMembers.channelId, channelId),
            eq(commsChannelMembers.userId, userId),
          ),
        )
        .limit(1);
      return existing;
    }
    return row;
  });
}

export async function removeChannelMember(channelId: string, userId: string): Promise<boolean> {
  return withDbAttribution("comms:removeChannelMember", async () => {
    const rows = await getDb()
      .delete(commsChannelMembers)
      .where(
        and(
          eq(commsChannelMembers.channelId, channelId),
          eq(commsChannelMembers.userId, userId),
        ),
      )
      .returning({ id: commsChannelMembers.id });
    return rows.length > 0;
  });
}
