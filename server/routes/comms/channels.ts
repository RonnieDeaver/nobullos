// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — channels.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Channels, Default channels for new users, Channel members.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { getUser } from "../../storage/clientStorage";
import { getUserId, isTeamLead, isChannelAdminFor } from "./shared";

export function registerCommsChannelRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Channels
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/channels", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channels = await commsStorage.listChannelsForUser(userId);
      const channelIds = channels.map((c) => c.id);
      const clientIds = channels.filter((c) => c.clientId).map((c) => c.clientId!);
      const dmChannelIds = channels.filter((c) => c.type === "dm" || c.type === "group_dm").map((c) => c.id);
      const [unreadSummaries, activeCalls, clientFirmNames, lastMessageTimestamps, notifPrefMap, notifSettings, dmParticipantsMap] = await Promise.all([
        commsStorage.getUnreadSummaryForUser(userId, channelIds),
        commsStorage.getActiveCallsForChannels(channelIds),
        commsStorage.getClientFirmNamesForChannels(clientIds),
        commsStorage.getLastMessageTimestampsForChannels(channelIds),
        commsStorage.getChannelNotifPrefMap(userId, channelIds),
        commsStorage.getUserNotificationSettings(userId),
        commsStorage.getDmParticipantsForChannels(dmChannelIds, userId),
      ]);
      // Names-only view derived from the same query — keeps dmParticipantNames
      // (used by channelDisplayName) in lockstep with dmParticipants.
      // getDmParticipantNamesForChannels remains the canonical names wrapper.
      const dmParticipantNamesMap = new Map<string, string[]>();
      for (const [chId, list] of dmParticipantsMap) {
        dmParticipantNamesMap.set(chId, list.map((p) => p.name));
      }
      // If the user has keywords, compute keyword hit counts in one extra query
      // and add them to mentionCount so the badge reflects keyword activity.
      const keywords: string[] = notifSettings?.keywords ?? [];
      const keywordHitMap = keywords.length > 0
        ? await commsStorage.getKeywordUnreadCountsForUser(userId, channelIds, keywords).catch(() => new Map<string, number>())
        : new Map<string, number>();

      const result = channels.map((c) => {
        const summary = unreadSummaries.get(c.id);
        const kwHits = keywordHitMap.get(c.id) ?? 0;
        return {
          ...c,
          unreadCount: summary?.unreadCount ?? 0,
          // Keyword hits are added to mentionCount so they badge the same way
          mentionCount: (summary?.mentionCount ?? 0) + kwHits,
          oldestUnreadMessageId: summary?.oldestUnreadMessageId ?? null,
          activeCall: activeCalls.get(c.id) ?? null,
          clientFirmName: c.clientId ? (clientFirmNames.get(c.clientId) ?? null) : null,
          dmParticipantNames: (c.type === "dm" || c.type === "group_dm") ? (dmParticipantNamesMap.get(c.id) ?? null) : null,
          dmParticipants: (c.type === "dm" || c.type === "group_dm") ? (dmParticipantsMap.get(c.id) ?? null) : null,
          lastMessageAt: lastMessageTimestamps.get(c.id) ?? null,
          notifPref: notifPrefMap.get(c.id) ?? "all",
        };
      });
      res.json(result);
    } catch (err: any) {
      console.error("[Comms] List channels error:", err.message);
      res.status(500).json({ error: "Failed to list channels" });
    }
  });

  // Shared enrichment: attach dmParticipantNames to any dm/group_dm rows in a
  // channels list so every channels endpoint labels DMs consistently (Task #3337).
  // Non-DM channels get dmParticipantNames: null, matching GET /api/comms/channels.
  async function enrichWithDmParticipantNames<T extends { id: string; type: string }>(
    channels: T[],
    currentUserId: string,
  ): Promise<(T & { dmParticipantNames: string[] | null; dmParticipants: { userId: string; name: string }[] | null })[]> {
    const dmChannelIds = channels
      .filter((c) => c.type === "dm" || c.type === "group_dm")
      .map((c) => c.id);
    const participantsMap =
      dmChannelIds.length > 0
        ? await commsStorage.getDmParticipantsForChannels(dmChannelIds, currentUserId)
        : new Map<string, { userId: string; name: string }[]>();
    // Names derived from the same rows; getDmParticipantNamesForChannels stays
    // the canonical names-only wrapper over getDmParticipantsForChannels.
    return channels.map((c) => {
      const isDm = c.type === "dm" || c.type === "group_dm";
      const participants = isDm ? (participantsMap.get(c.id) ?? null) : null;
      return {
        ...c,
        dmParticipantNames: participants ? participants.map((p) => p.name) : null,
        dmParticipants: participants,
      };
    });
  }

  app.get("/api/comms/channels/public", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channels = await commsStorage.listPublicChannels();
      res.json(await enrichWithDmParticipantNames(channels, userId));
    } catch (err: any) {
      console.error("[Comms] List public channels error:", err.message);
      res.status(500).json({ error: "Failed to list public channels" });
    }
  });

  // ── Default channels for new users (Task #3308) ──────────────────────────
  // Team-lead+ manage a list of standard channels every newly created user
  // account auto-joins. Stored in system_settings (comms_default_channel_ids).

  app.get("/api/comms/default-channels", isAuthenticated, async (req: any, res) => {
    try {
      if (!isTeamLead(req)) return res.status(403).json({ error: "Requires team lead" });
      const { getDefaultChannelIds } = await import("../../services/commsDefaultChannels");
      const channelIds = await getDefaultChannelIds();
      const channels = (
        await Promise.all(channelIds.map((id) => commsStorage.getChannelById(id)))
      )
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          visibility: c.visibility,
          archivedAt: c.archivedAt,
        }));
      res.json({ channelIds, channels });
    } catch (err: any) {
      console.error("[Comms] Get default channels error:", err.message);
      res.status(500).json({ error: "Failed to get default channels" });
    }
  });

  const setDefaultChannelsSchema = z.object({
    channelIds: z.array(z.string().uuid()).max(50),
  });

  app.put("/api/comms/default-channels", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      if (!isTeamLead(req)) return res.status(403).json({ error: "Requires team lead" });
      const parsed = setDefaultChannelsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const channelIds = Array.from(new Set(parsed.data.channelIds));
      // Validate every ID is a real, non-archived, non-client standard channel.
      for (const id of channelIds) {
        const channel = await commsStorage.getChannelById(id);
        if (!channel) return res.status(400).json({ error: `Channel not found: ${id}` });
        if (channel.type !== "channel")
          return res.status(400).json({ error: `Not a standard channel: ${channel.name ?? id}` });
        if (channel.clientId)
          return res.status(400).json({ error: `Client channels cannot be defaults: ${channel.name ?? id}` });
        if (channel.archivedAt)
          return res.status(400).json({ error: `Archived channels cannot be defaults: ${channel.name ?? id}` });
      }
      const { setDefaultChannelIds } = await import("../../services/commsDefaultChannels");
      await setDefaultChannelIds(channelIds, getUserId(req));
      res.json({ channelIds });
    } catch (err: any) {
      console.error("[Comms] Set default channels error:", err.message);
      res.status(500).json({ error: "Failed to save default channels" });
    }
  });

  // Task #3324 — bulk-join EXISTING users to the configured default
  // channels. Team-lead+, idempotent (already-members untouched),
  // archived/client channels skipped, audit-logged by the service.
  const applyExistingSchema = z.object({
    userIds: z.array(z.string().min(1)).max(500).optional(),
  });

  app.post(
    "/api/comms/default-channels/apply-existing",
    isAuthenticated,
    commsWriteLimiter,
    async (req: any, res) => {
      try {
        if (!isTeamLead(req)) return res.status(403).json({ error: "Requires team lead" });
        const parsed = applyExistingSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
        const { applyDefaultChannelsToExistingUsers } = await import(
          "../../services/commsDefaultChannels"
        );
        const result = await applyDefaultChannelsToExistingUsers(
          getUserId(req),
          parsed.data.userIds,
        );
        res.json(result);
      } catch (err: any) {
        console.error("[Comms] Apply default channels to existing users error:", err.message);
        res.status(500).json({ error: "Failed to apply default channels to existing users" });
      }
    },
  );

  // Task #3376 — recent bulk-add runs, sourced from the audit rows the
  // apply-existing action writes. Team-lead+ only (same gate as the action).
  app.get(
    "/api/comms/default-channels/apply-runs",
    isAuthenticated,
    async (req: any, res) => {
      try {
        if (!isTeamLead(req)) return res.status(403).json({ error: "Requires team lead" });
        const rawLimit = parseInt(String(req.query.limit ?? "5"), 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
        const { getActivityLogs } = await import("../../storage/activityStorage");
        const { data } = await getActivityLogs({
          actionType: "comms_default_channels_applied_to_existing",
          limit,
        });
        res.json({
          runs: data.map((log) => {
            const meta = (log.metadata ?? {}) as Record<string, any>;
            return {
              id: log.id,
              actorName: log.userName ?? null,
              timestamp: log.timestamp,
              usersProcessed: typeof meta.usersProcessed === "number" ? meta.usersProcessed : null,
              membershipsAdded: typeof meta.membershipsAdded === "number" ? meta.membershipsAdded : null,
              alreadyMembers: typeof meta.alreadyMembers === "number" ? meta.alreadyMembers : null,
              channelsSkipped: Array.isArray(meta.channelsSkipped) ? meta.channelsSkipped.length : 0,
            };
          }),
        });
      } catch (err: any) {
        console.error("[Comms] Get default-channel apply runs error:", err.message);
        res.status(500).json({ error: "Failed to load bulk-add run history" });
      }
    },
  );

  const createChannelSchema = z.object({
    name: z.string().min(1).max(80),
    type: z.enum(["channel"]).default("channel"),
    visibility: z.enum(["public", "private"]).default("public"),
    topic: z.string().max(500).optional(),
    description: z.string().max(1000).optional(),
    clientId: z.string().optional(),
    memberUserIds: z.array(z.string()).optional(),
  });

  app.post("/api/comms/channels", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const parsed = createChannelSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { memberUserIds, ...data } = parsed.data;

      const slug = data.name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 80);

      const existing = await commsStorage.getChannelBySlug(slug);
      if (existing) return res.status(409).json({ error: "A channel with that name already exists" });

      const channel = await commsStorage.createChannel({ ...data, slug, createdBy: userId });
      await commsStorage.addChannelMember(channel.id, userId, "channel_admin");

      const extraMembers = memberUserIds?.filter((id) => id !== userId) ?? [];
      for (const uid of extraMembers) {
        await commsStorage.addChannelMember(channel.id, uid, "member");
      }

      res.status(201).json(channel);
    } catch (err: any) {
      console.error("[Comms] Create channel error:", err.message);
      res.status(500).json({ error: "Failed to create channel" });
    }
  });

  app.get("/api/comms/channels/archived", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channels = await commsStorage.listArchivedChannels(userId);
      res.json(await enrichWithDmParticipantNames(channels, userId));
    } catch (err: any) {
      console.error("[Comms] List archived channels error:", err.message);
      res.status(500).json({ error: "Failed to list archived channels" });
    }
  });

  app.get("/api/comms/channels/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.visibility === "private") {
        const isMember = await commsStorage.isChannelMember(channel.id, userId, { allowArchived: true });
        if (!isMember) return res.status(403).json({ error: "Access denied" });
      }
      const members = await commsStorage.getChannelMembers(channel.id);
      const activeCall = await commsStorage.getActiveCallForChannel(channel.id);
      const [enriched] = await enrichWithDmParticipantNames([channel], userId);
      res.json({ ...enriched, members, activeCall });
    } catch (err: any) {
      console.error("[Comms] Get channel error:", err.message);
      res.status(500).json({ error: "Failed to get channel" });
    }
  });

  const updateChannelSchema = z.object({
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
    clientId: z.string().nullable().optional(),
  });

  app.patch("/api/comms/channels/:id", isAuthenticated, async (req: any, res) => {
    try {
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      // DMs/group_dms cannot have their metadata managed via this route.
      if (channel.type !== "channel") {
        return res.status(400).json({ error: "Metadata management is only available for regular channels" });
      }
      if (channel.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      // Client-bound channels are team-wide — any authenticated staff member may manage
      // them (e.g. rename or unlink). Once unlinked (clientId null) the channel reverts
      // to a normal private channel and the standard admin/team-lead gate applies.
      const canManage = channel.clientId
        ? true
        : await isChannelAdminFor(req, channel.id);
      if (!canManage) return res.status(403).json({ error: "Requires channel admin or team lead" });

      const parsed = updateChannelSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

      let slug: string | undefined;
      if (parsed.data.name) {
        slug = parsed.data.name
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
          .slice(0, 80);
      }

      const updated = await commsStorage.updateChannel(channel.id, {
        ...parsed.data,
        ...(slug ? { slug } : {}),
      });

      if (updated) {
        const memberIds = await commsStorage.getChannelMemberIds(channel.id);

        // Emit system messages for each changed field.
        const actor = req.user?.dbUser
          ? `${req.user.dbUser.firstName ?? ""} ${req.user.dbUser.lastName ?? ""}`.trim() || "Someone"
          : "Someone";

        if (parsed.data.name && channel.name && parsed.data.name !== channel.name) {
          await commsStorage.createMessage({
            channelId: channel.id,
            userId: null,
            content: `${actor} renamed the channel from "${channel.name}" to "${parsed.data.name}"`,
            contentType: "system",
            metadata: { type: "channel_renamed", oldName: channel.name, newName: parsed.data.name },
          });
        }
        if ("topic" in parsed.data && parsed.data.topic !== channel.topic) {
          const topicMsg = parsed.data.topic
            ? `${actor} set the channel topic: "${parsed.data.topic}"`
            : `${actor} cleared the channel topic`;
          await commsStorage.createMessage({
            channelId: channel.id,
            userId: null,
            content: topicMsg,
            contentType: "system",
            metadata: { type: "channel_topic_changed", topic: parsed.data.topic ?? null },
          });
        }
        if ("description" in parsed.data && parsed.data.description !== channel.description) {
          const descMsg = parsed.data.description
            ? `${actor} updated the channel description`
            : `${actor} cleared the channel description`;
          await commsStorage.createMessage({
            channelId: channel.id,
            userId: null,
            content: descMsg,
            contentType: "system",
            metadata: { type: "channel_description_changed" },
          });
        }

        broadcastTwilioEvent({
          type: "comms:channel_update",
          channelId: channel.id,
          name: updated.name ?? "",
          topic: updated.topic ?? null,
          description: updated.description ?? null,
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });
      }

      res.json(updated);
    } catch (err: any) {
      console.error("[Comms] Update channel error:", err.message);
      res.status(500).json({ error: "Failed to update channel" });
    }
  });

  app.delete("/api/comms/channels/:id", isAuthenticated, async (req: any, res) => {
    try {
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      // DMs/group_dms cannot be archived via this route.
      if (channel.type !== "channel") {
        return res.status(400).json({ error: "Only regular channels can be archived" });
      }
      const canManage = await isChannelAdminFor(req, channel.id);
      if (!canManage) return res.status(403).json({ error: "Requires channel admin or team lead" });

      const userId = getUserId(req);
      const actor = req.user?.dbUser
        ? `${req.user.dbUser.firstName ?? ""} ${req.user.dbUser.lastName ?? ""}`.trim() || "Someone"
        : "Someone";
      await commsStorage.createMessage({
        channelId: channel.id,
        userId: null,
        content: `${actor} archived this channel`,
        contentType: "system",
        metadata: { type: "channel_archived", archivedBy: userId },
      });

      await commsStorage.archiveChannel(channel.id);

      const memberIds = await commsStorage.getChannelMemberIds(channel.id);
      broadcastTwilioEvent({
        type: "comms:channel_update",
        channelId: channel.id,
        name: channel.name ?? "",
        topic: channel.topic ?? null,
        description: channel.description ?? null,
        archived: true,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Archive channel error:", err.message);
      res.status(500).json({ error: "Failed to archive channel" });
    }
  });

  app.get("/api/comms/channels/:id/stats", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.visibility === "private") {
        const isMember = await commsStorage.isChannelMember(channel.id, userId, { allowArchived: true });
        if (!isMember) return res.status(403).json({ error: "Access denied" });
      }
      const stats = await commsStorage.getChannelStats(channel.id);
      res.json(stats);
    } catch (err: any) {
      console.error("[Comms] Channel stats error:", err.message);
      res.status(500).json({ error: "Failed to get channel stats" });
    }
  });

  app.post("/api/comms/channels/:id/unarchive", isAuthenticated, async (req: any, res) => {
    try {
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (!channel.archivedAt) return res.status(400).json({ error: "Channel is not archived" });
      if (channel.type !== "channel") {
        return res.status(400).json({ error: "Only regular channels can be restored" });
      }

      // Team leads can always restore; channel admins can restore if still a member.
      const canManage = await isChannelAdminFor(req, channel.id);
      if (!canManage) return res.status(403).json({ error: "Requires channel admin or team lead" });

      // For client-bound channels, guard against the unique active-per-client constraint.
      if (channel.clientId) {
        const { channel: restored } = await commsStorage.restoreClientChannel(
          channel.clientId,
          channel.name ?? `client-${channel.clientId.slice(0, 8)}`,
        );
        const userId = getUserId(req);
        await commsStorage.createMessage({
          channelId: restored.id,
          userId: null,
          content: "This channel has been restored",
          contentType: "system",
          metadata: { type: "channel_restored", restoredBy: userId },
        });
        const memberIds = await commsStorage.getChannelMemberIds(restored.id);
        broadcastTwilioEvent({
          type: "comms:channel_update",
          channelId: restored.id,
          name: restored.name ?? "",
          topic: restored.topic ?? null,
          description: restored.description ?? null,
          archived: false,
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });
        return res.json(restored);
      }

      const restored = await commsStorage.unarchiveChannel(channel.id);
      if (!restored) return res.status(500).json({ error: "Restore failed" });

      const userId = getUserId(req);
      await commsStorage.createMessage({
        channelId: restored.id,
        userId: null,
        content: "This channel has been restored",
        contentType: "system",
        metadata: { type: "channel_restored", restoredBy: userId },
      });

      const memberIds = await commsStorage.getChannelMemberIds(restored.id);
      broadcastTwilioEvent({
        type: "comms:channel_update",
        channelId: restored.id,
        name: restored.name ?? "",
        topic: restored.topic ?? null,
        description: restored.description ?? null,
        archived: false,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      res.json(restored);
    } catch (err: any) {
      console.error("[Comms] Unarchive channel error:", err.message);
      res.status(500).json({ error: "Failed to restore channel" });
    }
  });

  const privacySchema = z.object({
    visibility: z.enum(["public", "private"]),
  });

  app.patch("/api/comms/channels/:id/privacy", isAuthenticated, async (req: any, res) => {
    try {
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.type !== "channel") {
        return res.status(400).json({ error: "DMs cannot have their privacy changed" });
      }
      if (channel.archivedAt) return res.status(423).json({ error: "Channel is archived" });

      const canManage = await isChannelAdminFor(req, channel.id);
      if (!canManage) return res.status(403).json({ error: "Requires channel admin or team lead" });

      const parsed = privacySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

      if (parsed.data.visibility === channel.visibility) {
        return res.json(channel);
      }

      const updated = await commsStorage.updateChannel(channel.id, {
        visibility: parsed.data.visibility,
      });
      if (!updated) return res.status(500).json({ error: "Update failed" });

      const actor = req.user?.dbUser
        ? `${req.user.dbUser.firstName ?? ""} ${req.user.dbUser.lastName ?? ""}`.trim() || "Someone"
        : "Someone";
      const direction = parsed.data.visibility === "public" ? "public" : "private";
      await commsStorage.createMessage({
        channelId: channel.id,
        userId: null,
        content: `${actor} converted this channel to ${direction}`,
        contentType: "system",
        metadata: { type: "channel_privacy_changed", visibility: parsed.data.visibility },
      });

      const memberIds = await commsStorage.getChannelMemberIds(channel.id);
      broadcastTwilioEvent({
        type: "comms:channel_update",
        channelId: channel.id,
        name: updated.name ?? "",
        topic: updated.topic ?? null,
        description: updated.description ?? null,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      res.json(updated);
    } catch (err: any) {
      console.error("[Comms] Privacy change error:", err.message);
      res.status(500).json({ error: "Failed to update channel privacy" });
    }
  });

  app.post("/api/comms/channels/:id/join", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.visibility !== "public") {
        return res.status(403).json({ error: "Cannot join a private channel without an invite" });
      }
      const member = await commsStorage.addChannelMember(channel.id, userId, "member");
      res.json(member);
    } catch (err: any) {
      console.error("[Comms] Join channel error:", err.message);
      res.status(500).json({ error: "Failed to join channel" });
    }
  });

  app.post("/api/comms/channels/:id/leave", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      await commsStorage.removeChannelMember(channel.id, userId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Leave channel error:", err.message);
      res.status(500).json({ error: "Failed to leave channel" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Channel members
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/channels/:id/members", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.visibility === "private") {
        const isMember = await commsStorage.isChannelMember(channel.id, userId, { allowArchived: true });
        if (!isMember) return res.status(403).json({ error: "Access denied" });
      }
      const members = await commsStorage.getChannelMembersWithUsers(channel.id);
      res.json(members);
    } catch (err: any) {
      console.error("[Comms] List members error:", err.message);
      res.status(500).json({ error: "Failed to list members" });
    }
  });

  app.post("/api/comms/channels/:id/members", isAuthenticated, async (req: any, res) => {
    try {
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const canManage = await isChannelAdminFor(req, channel.id);
      if (!canManage) return res.status(403).json({ error: "Requires channel admin or team lead" });
      const { userId: targetUserId } = req.body;
      if (!targetUserId || typeof targetUserId !== "string") {
        return res.status(400).json({ error: "userId required" });
      }
      const member = await commsStorage.addChannelMember(channel.id, targetUserId, "member");

      const actor = req.user?.dbUser
        ? `${req.user.dbUser.firstName ?? ""} ${req.user.dbUser.lastName ?? ""}`.trim() || "Someone"
        : "Someone";
      const addedUser = await getUser(targetUserId).catch(() => undefined);
      const addedName = addedUser
        ? `${addedUser.firstName ?? ""} ${addedUser.lastName ?? ""}`.trim() || "a user"
        : "a user";
      await commsStorage.createMessage({
        channelId: channel.id,
        userId: null,
        content: `${actor} added ${addedName} to the channel`,
        contentType: "system",
        metadata: { type: "member_added", addedBy: getUserId(req), addedUserId: targetUserId },
      });

      // Notify existing members (including the newly added one) that membership
      // changed so their channel list and member panels refresh.
      const memberIds = await commsStorage.getChannelMemberIds(channel.id);
      broadcastTwilioEvent({
        type: "comms:member_change",
        channelId: channel.id,
        action: "add",
        userId: targetUserId,
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      res.json(member);
    } catch (err: any) {
      console.error("[Comms] Add member error:", err.message);
      res.status(500).json({ error: "Failed to add member" });
    }
  });

  const memberRoleSchema = z.object({
    role: z.enum(["channel_admin", "member"]),
  });

  app.patch(
    "/api/comms/channels/:id/members/:uid/role",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const channel = await commsStorage.getChannelById(req.params.id);
        if (!channel) return res.status(404).json({ error: "Channel not found" });
        if (channel.type !== "channel") {
          return res.status(400).json({ error: "Role management only applies to regular channels" });
        }
        if (channel.archivedAt) return res.status(423).json({ error: "Channel is archived" });

        const canManage = await isChannelAdminFor(req, channel.id);
        if (!canManage) return res.status(403).json({ error: "Requires channel admin or team lead" });

        const parsed = memberRoleSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

        const updated = await commsStorage.updateChannelMemberRole(
          channel.id,
          req.params.uid,
          parsed.data.role,
        );
        if (!updated) return res.status(404).json({ error: "Member not found" });

        const actor = req.user?.dbUser
          ? `${req.user.dbUser.firstName ?? ""} ${req.user.dbUser.lastName ?? ""}`.trim() || "Someone"
          : "Someone";
        const action = parsed.data.role === "channel_admin" ? "promoted" : "demoted";
        await commsStorage.createMessage({
          channelId: channel.id,
          userId: null,
          content: `${actor} ${action} a member`,
          contentType: "system",
          metadata: { type: "member_role_changed", targetUserId: req.params.uid, role: parsed.data.role },
        });

        const memberIds = await commsStorage.getChannelMemberIds(channel.id);
        broadcastTwilioEvent({
          type: "comms:member_change",
          channelId: channel.id,
          action: "role_update",
          userId: req.params.uid,
          ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
        });

        res.json(updated);
      } catch (err: any) {
        console.error("[Comms] Update member role error:", err.message);
        res.status(500).json({ error: "Failed to update member role" });
      }
    },
  );

  app.delete(
    "/api/comms/channels/:id/members/:uid",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = getUserId(req);
        const channel = await commsStorage.getChannelById(req.params.id);
        if (!channel) return res.status(404).json({ error: "Channel not found" });
        if (channel.archivedAt) return res.status(423).json({ error: "Channel is archived" });
        const canManage = await isChannelAdminFor(req, channel.id);
        if (!canManage && userId !== req.params.uid) {
          return res.status(403).json({ error: "Can only remove yourself or requires channel admin" });
        }

        // Capture the pre-removal member list so the removed user still gets the event.
        const memberIdsBefore = await commsStorage.getChannelMemberIds(channel.id);
        await commsStorage.removeChannelMember(channel.id, req.params.uid);

        const actor = req.user?.dbUser
          ? `${req.user.dbUser.firstName ?? ""} ${req.user.dbUser.lastName ?? ""}`.trim() || "Someone"
          : "Someone";
        const removedUser = await getUser(req.params.uid).catch(() => undefined);
        const removedName = removedUser
          ? `${removedUser.firstName ?? ""} ${removedUser.lastName ?? ""}`.trim() || "a user"
          : "a user";
        await commsStorage.createMessage({
          channelId: channel.id,
          userId: null,
          content: `${actor} removed ${removedName} from the channel`,
          contentType: "system",
          metadata: { type: "member_removed", removedBy: userId, removedUserId: req.params.uid },
        });

        broadcastTwilioEvent({
          type: "comms:member_change",
          channelId: channel.id,
          action: "remove",
          userId: req.params.uid,
          ...(memberIdsBefore !== null ? { targetUserIds: memberIdsBefore } : {}),
        });

        res.json({ ok: true });
      } catch (err: any) {
        console.error("[Comms] Remove member error:", err.message);
        res.status(500).json({ error: "Failed to remove member" });
      }
    },
  );

}
