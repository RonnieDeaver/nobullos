// @db-pool-intent: ambient
/**
 * NoBull Comms storage — client channels & DMs.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Client tags, Client channel provisioning, Teammate picker, DM channels.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsMessageClientTags,
  users,
  clients,
  type CommsChannel,
} from "@shared/schema";
import { type MessageWithUser } from "./messages";
import { getChannelByClientId, getChannelBySlug } from "./channels";

// ─── Client tags ─────────────────────────────────────────────────────────────

export async function tagMessageWithClients(
  messageId: string,
  clientIds: string[],
  method: "channel_bound" | "mention" | "suggestion",
): Promise<void> {
  if (clientIds.length === 0) return;
  return withDbAttribution("comms:tagMessageWithClients", async () => {
    await dbRetry(
      () =>
        getDb()
          .insert(commsMessageClientTags)
          .values(clientIds.map((clientId) => ({ messageId, clientId, tagMethod: method })))
          .onConflictDoNothing(),
      "comms.tagMessageWithClients",
    );
  });
}

export async function getClientCommsFeed(
  clientId: string,
  viewerUserId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<MessageWithUser[]> {
  return withDbAttribution("comms:getClientCommsFeed", async () => {
    const limit = Math.min(opts.limit ?? 30, 100);

    // Visibility: the feed must not leak private-channel/DM content to
    // non-members. A tagged message is visible to the viewer when it lives in
    // (a) a public channel, (b) the client's own bound channel (team chatter,
    // intended for the client page), or (c) a channel the viewer is a member of.
    const visibilityConditions = [
      eq(commsMessageClientTags.clientId, clientId),
      isNull(commsMessages.deletedAt),
      or(
        eq(commsChannels.visibility, "public"),
        eq(commsChannels.clientId, clientId),
        sql`EXISTS (
          SELECT 1 FROM ${commsChannelMembers}
          WHERE ${commsChannelMembers.channelId} = ${commsMessages.channelId}
            AND ${commsChannelMembers.userId} = ${viewerUserId}
        )`,
      ),
    ];

    if (opts.before) {
      const [beforeMsg] = await dbRetry(
        () =>
          getDb()
            .select({ createdAt: commsMessages.createdAt })
            .from(commsMessages)
            .where(eq(commsMessages.id, opts.before!))
            .limit(1),
        "comms.getClientCommsFeed.before",
      );
      if (beforeMsg) {
        visibilityConditions.push(lt(commsMessages.createdAt, beforeMsg.createdAt));
      }
    }

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
          .from(commsMessageClientTags)
          .innerJoin(commsMessages, eq(commsMessageClientTags.messageId, commsMessages.id))
          .innerJoin(commsChannels, eq(commsMessages.channelId, commsChannels.id))
          .leftJoin(users, eq(commsMessages.userId, users.id))
          .where(and(...visibilityConditions))
          .orderBy(desc(commsMessages.createdAt))
          .limit(limit),
      "comms.getClientCommsFeed.messages",
    );
    return rows.map((r) => ({
      ...r.message,
      user: r.user?.id ? r.user : null,
      reactionCounts: {}, myReactions: [],
      replyCount: 0,
    }));
  });
}

// ─── Client channel provisioning ─────────────────────────────────────────────

/**
 * Idempotent find-or-create for a client-bound channel.
 * System-provisioned (createdBy: null), private, type: channel.
 * Safe to call multiple times for the same clientId — always returns the
 * existing channel if one already exists.
 */
export async function provisionClientChannel(
  clientId: string,
  channelName: string,
): Promise<{ channel: CommsChannel; created: boolean }> {
  return withDbAttribution("comms:provisionClientChannel", async () => {
    const existing = await getChannelByClientId(clientId);
    if (existing) return { channel: existing, created: false };

    const rawSlug = channelName
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 70);
    let slug = rawSlug || `client-${clientId.slice(0, 8)}`;

    const slugTaken = await getChannelBySlug(slug);
    if (slugTaken) {
      slug = `${slug}-${clientId.slice(0, 8)}`.slice(0, 80);
    }

    // ON CONFLICT DO NOTHING guards against the TOCTOU race under autoscale:
    // two concurrent callers both see "no existing channel", both attempt to
    // INSERT — the unique partial index (comms_channels_unique_active_client)
    // allows only one to win. The loser gets an empty returning array, then
    // re-reads below to return the winner's row.
    const rows = await dbRetry(
      () =>
        getDb()
          .insert(commsChannels)
          .values({
            name: (channelName || `client-${clientId.slice(0, 8)}`).slice(0, 80),
            type: "channel",
            visibility: "private",
            slug,
            clientId,
            createdBy: null,
          })
          .onConflictDoNothing()
          .returning(),
      "comms.provisionClientChannel",
    );
    if (rows[0]) return { channel: rows[0], created: true };
    // Another concurrent caller won the race — re-read the winner's row.
    const winner = await getChannelByClientId(clientId);
    if (!winner) throw new Error(`provisionClientChannel: race-read miss for client ${clientId}`);
    return { channel: winner, created: false };
  });
}

/**
 * Restore a client's comms channel when the client is un-archived.
 * If an active channel already exists, returns it untouched. Otherwise the
 * most recently archived client channel is un-archived (history preserved).
 * If no channel exists at all, falls back to provisionClientChannel.
 * Idempotent and safe under concurrency: an un-archive that collides with the
 * unique-active-client partial index re-reads the winner's row.
 */
export async function restoreClientChannel(
  clientId: string,
  channelName: string,
): Promise<{ channel: CommsChannel; restored: boolean; created: boolean }> {
  return withDbAttribution("comms:restoreClientChannel", async () => {
    const active = await getChannelByClientId(clientId);
    if (active) return { channel: active, restored: false, created: false };

    const [archived] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsChannels)
          .where(
            and(
              eq(commsChannels.clientId, clientId),
              eq(commsChannels.type, "channel"),
              isNotNull(commsChannels.archivedAt),
            ),
          )
          .orderBy(desc(commsChannels.archivedAt))
          .limit(1),
      "comms.restoreClientChannel.findArchived",
    );

    if (archived) {
      try {
        const [row] = await getDb()
          .update(commsChannels)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(commsChannels.id, archived.id))
          .returning();
        if (row) return { channel: row, restored: true, created: false };
      } catch (e: any) {
        // Unique partial index (one active channel per client) — a concurrent
        // caller restored or created an active channel first. Re-read the winner.
        const winner = await getChannelByClientId(clientId);
        if (winner) return { channel: winner, restored: false, created: false };
        throw e;
      }
    }

    const { channel, created } = await provisionClientChannel(clientId, channelName);
    return { channel, restored: false, created };
  });
}

/**
 * Return all active (non-archived) clients that have no active comms channel.
 * Used by the startup backfill to provision missing channels idempotently.
 */
export async function listActiveClientsWithoutChannel(): Promise<
  Array<{ id: string; firmName: string }>
> {
  return withDbAttribution("comms:listActiveClientsWithoutChannel", () =>
    dbRetry(
      () =>
        getDb()
          .select({ id: clients.id, firmName: clients.firmName })
          .from(clients)
          .where(
            and(
              or(eq(clients.isArchived, false), isNull(clients.isArchived)),
              sql`NOT EXISTS (
                SELECT 1 FROM ${commsChannels}
                WHERE ${commsChannels.clientId} = ${clients.id}
                  AND ${commsChannels.archivedAt} IS NULL
              )`,
            ),
          ),
      "comms.listActiveClientsWithoutChannel",
    ),
  );
}

// ─── Teammate picker ─────────────────────────────────────────────────────────

export interface CommsPickerUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  email: string | null;
}

/**
 * Picker-safe teammate list for the New DM dialog. Unlike the Team Lead+
 * GET /api/users surface, this returns ONLY display fields (no role,
 * settings, or audit columns) so it is safe for any authenticated user.
 * Soft-deleted users are excluded.
 */
export async function listCommsPickerUsers(): Promise<CommsPickerUser[]> {
  return withDbAttribution("comms:listCommsPickerUsers", () =>
    dbRetry(
      () =>
        getDb()
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            profileImageUrl: users.profileImageUrl,
            email: users.email,
          })
          .from(users)
          .where(isNull(users.deletedAt))
          .orderBy(users.firstName, users.lastName, users.email),
      "comms.listCommsPickerUsers",
    ),
  );
}

// ─── DM channels ─────────────────────────────────────────────────────────────

export async function findOrCreateDmChannel(
  userIds: string[],
): Promise<{ channel: CommsChannel; created: boolean }> {
  return withDbAttribution("comms:findOrCreateDmChannel", async () => {
    const sorted = [...userIds].sort();
    const type = sorted.length === 2 ? "dm" : "group_dm";
    // slug is varchar(80); joining 3+ user IDs overflows it, so group DMs
    // fall back to a deterministic hash of the sorted member list.
    const joined = `dm-${sorted.join("-")}`;
    const slug =
      joined.length <= 80
        ? joined
        : `dm-${createHash("sha256").update(sorted.join("-")).digest("hex").slice(0, 40)}`;

    const [existing] = await getDb()
      .select()
      .from(commsChannels)
      .where(and(eq(commsChannels.slug, slug), isNull(commsChannels.archivedAt)))
      .limit(1);
    if (existing) return { channel: existing, created: false };

    const [channel] = await getDb()
      .insert(commsChannels)
      .values({ type, visibility: "private", slug, createdBy: sorted[0] })
      .returning();
    await getDb()
      .insert(commsChannelMembers)
      .values(sorted.map((uid) => ({ channelId: channel.id, userId: uid, role: "member" })));
    return { channel, created: true };
  });
}
