// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — messages.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Messages, Link-preview image proxy, Thread following & thread inbox, Edit history, Permalinks.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import { notifyUser } from "../../services/notifications/userInbox";
import { stripFormatting } from "@shared/commsFormatting";
import * as commsStorage from "../../storage/commsStorage";
import { unfurlUrl, extractUrls } from "../../services/commsUnfurl";
import { getUser } from "../../storage/clientStorage";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { getUserId, extractMentionedUserIds, isTeamLead } from "./shared";

export function registerCommsMessageRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Messages
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/channels/:id/messages", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.visibility === "private") {
        const isMember = await commsStorage.isChannelMember(channel.id, userId, { allowArchived: true });
        if (!isMember) return res.status(403).json({ error: "Access denied" });
      }
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      const after = typeof req.query.after === "string" ? req.query.after : undefined;
      const around = typeof req.query.around === "string" ? req.query.around : undefined;
      const parentId = typeof req.query.parentId === "string" ? req.query.parentId : undefined;
      const limit = parseInt(req.query.limit as string) || 50;

      if (around) {
        // Fetch a window of messages centred on the anchor: up to 30 older + anchor + up to 29 newer.
        // Anchor must belong to this channel (and thread scope if parentId is set) — no cross-channel IDOR.
        // Fetch all three slices via listMessages so every message carries the same enriched
        // shape (user, reactionCounts, replyCount, attachments) — no raw-row cast needed.
        // parentId undefined = root timeline (parentId IS NULL scope).
        const scopedParentId = parentId ?? null;
        const [olderMsgs, newerMsgs, anchorResult] = await Promise.all([
          commsStorage.listMessages(channel.id, { before: around, limit: 30, parentId: scopedParentId, currentUserId: userId }),
          commsStorage.listMessages(channel.id, { after: around, limit: 29, parentId: scopedParentId, currentUserId: userId }),
          commsStorage.listMessages(channel.id, { id: around, limit: 1, parentId: scopedParentId, currentUserId: userId }),
        ]);
        const anchorMsg = anchorResult[0];
        if (!anchorMsg) {
          return res.status(404).json({ error: "Anchor message not found in this channel" });
        }
        const merged: typeof olderMsgs = [...olderMsgs];
        merged.push(anchorMsg);
        for (const m of newerMsgs) merged.push(m);
        const seen = new Set<string>();
        const deduped = merged.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        deduped.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        return res.json(deduped);
      }

      const messages = await commsStorage.listMessages(channel.id, {
        before,
        after,
        limit,
        parentId: parentId ?? null,
        currentUserId: userId,
      });
      res.json(messages);
    } catch (err: any) {
      console.error("[Comms] List messages error:", err.message);
      res.status(500).json({ error: "Failed to list messages" });
    }
  });

  // ── Link-preview image proxy ────────────────────────────────────────────────
  // Serves external link-preview images through the server so readers'
  // browsers never contact the outside site directly (tracking-pixel privacy
  // leak). Re-runs SSRF/private-IP checks, enforces size cap + timeout, and
  // rejects non-image responses.
  app.get("/api/comms/link-preview-image", isAuthenticated, async (req: any, res) => {
    const rawUrl = req.query.url;
    if (typeof rawUrl !== "string" || !rawUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }
    try {
      const { fetchImageForProxy } = await import("../../services/commsUnfurl");
      const image = await fetchImageForProxy(rawUrl);
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Content-Length", String(image.body.byteLength));
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", "inline");
      res.end(image.body);
    } catch (err: any) {
      const msg = err?.message ?? "Fetch failed";
      const status =
        msg === "Invalid URL" || msg === "Unsupported protocol" || msg === "Credentials not allowed"
          ? 400
          : msg.startsWith("SSRF") || msg === "Not an image" || msg === "Image too large"
            ? 403
            : 502;
      res.status(status).json({ error: "Unable to load preview image" });
    }
  });

  const sendMessageSchema = z.object({
    content: z.string().min(1).max(10000),
    parentId: z.string().nullable().optional(),
    clientIds: z.array(z.string()).optional(),
  });

  app.post("/api/comms/channels/:id/messages", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isMember = await commsStorage.isChannelMember(channel.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a channel member" });

      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { content, parentId, clientIds } = parsed.data;

      const message = await commsStorage.createMessage({
        channelId: channel.id,
        userId,
        parentId: parentId ?? null,
        content,
      });

      // Client tagging: auto-tag from channel binding + explicit clientIds
      const tagIds: string[] = [];
      if (channel.clientId) tagIds.push(channel.clientId);
      if (clientIds) tagIds.push(...clientIds);
      const uniqueTagIds = [...new Set(tagIds)];
      if (uniqueTagIds.length > 0) {
        const method = channel.clientId && uniqueTagIds.includes(channel.clientId)
          ? "channel_bound"
          : "mention";
        await commsStorage.tagMessageWithClients(message.id, uniqueTagIds, method).catch((e) =>
          console.error("[Comms] Client tag error:", e?.message),
        );
      }

      const memberIds = await commsStorage.getChannelMemberIds(channel.id);
      // Include sender info so SSE consumers (rail preview, popups) can show
      // the sender name without an extra API call.
      const sender = await getUser(userId).catch(() => undefined);
      const event = {
        type: "comms:message" as const,
        channelId: channel.id,
        message: {
          ...message,
          user: sender
            ? {
                id: sender.id,
                firstName: sender.firstName ?? undefined,
                lastName: sender.lastName ?? undefined,
                profileImageUrl: sender.profileImageUrl ?? undefined,
              }
            : null,
          createdAt: message.createdAt.toISOString(),
          updatedAt: message.updatedAt.toISOString(),
          editedAt: message.editedAt?.toISOString() ?? null,
          deletedAt: message.deletedAt?.toISOString() ?? null,
        },
        // null = client-bound team-wide channel; omit targetUserIds so
        // deliverLocal fans out to ALL SSE subscribers instead of nobody.
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      };
      broadcastTwilioEvent(event);

      // Notify offline members who were mentioned
      const mentionedUserIds = extractMentionedUserIds(content);
      for (const mentionedId of mentionedUserIds) {
        if (mentionedId === userId) continue;
        // null = team-wide channel; mentions reach anyone, skip only per-member check
        if (memberIds !== null && !memberIds.includes(mentionedId)) continue;
        notifyUser(mentionedId, {
          category: "mention",
          title: `New mention in #${channel.name ?? "comms"}`,
          body: stripFormatting(content).slice(0, 200),
          deepLink: `/comms?channel=${channel.id}&message=${message.id}`,
          dedupeKey: `comms:mention:${message.id}:${mentionedId}`,
        }).catch((e) => console.error("[Comms] Notify mention error:", e?.message));
      }

      // @channel / @here broadcast — notify non-muted members (excludes sender)
      const hasBroadcast = /@channel|@here/.test(content);
      if (hasBroadcast && memberIds !== null && memberIds.length > 0) {
        const prefMap = await commsStorage.getChannelMemberPrefMap(channel.id, memberIds).catch(() => new Map<string, string>());
        for (const memberId of memberIds) {
          if (memberId === userId) continue;
          const pref = prefMap.get(memberId) ?? "all";
          if (pref === "muted") continue;
          notifyUser(memberId, {
            category: "mention",
            title: `@channel in #${channel.name ?? "comms"}`,
            body: stripFormatting(content).slice(0, 200),
            deepLink: `/comms?channel=${channel.id}&message=${message.id}`,
            dedupeKey: `comms:broadcast:${message.id}:${memberId}`,
          }).catch((e) => console.error("[Comms] Notify broadcast error:", e?.message));
        }
      }

      // Thread follow: auto-follow for sender of root messages and thread replies.
      // Mentioned users in thread replies are auto-followed fire-and-forget.
      const rootMessageId = parentId ?? null;
      if (rootMessageId) {
        // User replied in a thread — auto-follow the thread root
        commsStorage.autoFollowThread(rootMessageId, channel.id, userId).catch((e) =>
          console.error("[Comms] Auto-follow (reply) error:", e?.message),
        );
        // Notify followers that a new reply arrived (update thread inbox)
        broadcastTwilioEvent({
          type: "comms:thread_unread" as const,
          channelId: channel.id,
          rootMessageId,
          messageId: message.id,
        });
        // Auto-follow mentioned users in thread replies
        for (const mentionedId of mentionedUserIds) {
          if (mentionedId === userId) continue;
          if (memberIds !== null && !memberIds.includes(mentionedId)) continue;
          commsStorage.autoFollowThread(rootMessageId, channel.id, mentionedId).catch((e) =>
            console.error("[Comms] Auto-follow (mention) error:", e?.message),
          );
        }
      } else {
        // User sent a root message — auto-follow this thread (as the root author)
        commsStorage.autoFollowThread(message.id, channel.id, userId).catch((e) =>
          console.error("[Comms] Auto-follow (root) error:", e?.message),
        );
      }

      res.status(201).json(message);

      // ── Fire-and-forget URL unfurl ────────────────────────────────────────
      // Runs OUTSIDE the DB hold / response path. Persists results, then
      // patches the message metadata + emits a SSE event so connected
      // clients can show the preview card without polling.
      const urlsToUnfurl = extractUrls(content);
      if (urlsToUnfurl.length > 0) {
        void (async () => {
          try {
            const results = await Promise.all(urlsToUnfurl.map((u) => unfurlUrl(u)));
            const valid = results.filter((r) => !r.error && r.title);
            if (valid.length === 0) return;
            // Persist previews to DB (best-effort; don't let a DB blip drop the SSE)
            await Promise.all(
              valid.map((r) => commsStorage.upsertLinkPreview(r).catch((e) =>
                console.error("[Comms] Persist link preview error:", e?.message),
              )),
            );
            // Patch message metadata with preview data
            const previewPayload = valid.map((r) => ({
              url: r.url,
              title: r.title,
              description: r.description,
              imageUrl: r.imageUrl,
              siteName: r.siteName,
              faviconUrl: r.faviconUrl,
            }));
            await commsStorage.setMessageLinkPreviews(message.id, previewPayload).catch((e) =>
              console.error("[Comms] Set link previews error:", e?.message),
            );
            // Broadcast SSE so open clients update without re-fetching the whole list
            broadcastTwilioEvent({
              type: "comms:link_preview" as const,
              channelId: channel.id,
              messageId: message.id,
              previews: previewPayload,
              ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
            });
          } catch (e: any) {
            console.error("[Comms] Unfurl pipeline error:", e?.message);
          }
        })();
      }
    } catch (err: any) {
      console.error("[Comms] Send message error:", err.message);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Thread following & thread inbox
  // ──────────────────────────────────────────────────────────────────────────

  // GET /api/comms/threads — list followed threads with unread counts
  app.get("/api/comms/threads", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const items = await commsStorage.listFollowedThreads(userId);
      const enriched = await commsStorage.enrichFollowedThreadsWithUnread(userId, items);
      // Sort: threads with unread first, then by lastReplyAt desc
      enriched.sort((a, b) => {
        if (b.unreadReplies !== a.unreadReplies) return b.unreadReplies - a.unreadReplies;
        const at = a.lastReplyAt?.getTime() ?? 0;
        const bt = b.lastReplyAt?.getTime() ?? 0;
        return bt - at;
      });
      res.json(enriched);
    } catch (err: any) {
      console.error("[Comms] List threads error:", err.message);
      res.status(500).json({ error: "Failed to list threads" });
    }
  });

  // GET /api/comms/threads/unread-summary — aggregate badge counts
  app.get("/api/comms/threads/unread-summary", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const summary = await commsStorage.getThreadUnreadSummary(userId);
      res.json(summary);
    } catch (err: any) {
      console.error("[Comms] Thread unread summary error:", err.message);
      res.status(500).json({ error: "Failed to get thread unread summary" });
    }
  });

  // POST /api/comms/threads/:rootMessageId/follow — manually follow a thread
  app.post("/api/comms/threads/:rootMessageId/follow", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { rootMessageId } = req.params;
      // Resolve channelId from the root message
      const rootMsgResult = await db
        .execute(sql`SELECT channel_id FROM comms_messages WHERE id = ${rootMessageId} LIMIT 1`);
      const rootMsg = rootMsgResult.rows[0];
      if (!rootMsg) return res.status(404).json({ error: "Thread not found" });
      const channelId = (rootMsg as any).channel_id as string;
      // Ensure user is a member of the channel
      const isMember = await commsStorage.isChannelMember(channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a channel member" });
      const row = await commsStorage.followThread(rootMessageId, channelId, userId);
      broadcastTwilioEvent({
        type: "comms:thread_follow" as const,
        rootMessageId,
        channelId,
        targetUserIds: [userId],
        following: true,
      });
      res.json(row);
    } catch (err: any) {
      console.error("[Comms] Follow thread error:", err.message);
      res.status(500).json({ error: "Failed to follow thread" });
    }
  });

  // DELETE /api/comms/threads/:rootMessageId/follow — unfollow a thread
  app.delete("/api/comms/threads/:rootMessageId/follow", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { rootMessageId } = req.params;
      const row = await commsStorage.unfollowThread(rootMessageId, userId);
      if (!row) return res.status(404).json({ error: "Thread membership not found" });
      broadcastTwilioEvent({
        type: "comms:thread_follow" as const,
        rootMessageId,
        channelId: row.channelId,
        targetUserIds: [userId],
        following: false,
      });
      res.json(row);
    } catch (err: any) {
      console.error("[Comms] Unfollow thread error:", err.message);
      res.status(500).json({ error: "Failed to unfollow thread" });
    }
  });

  // POST /api/comms/threads/:rootMessageId/read — mark thread replies as read
  app.post("/api/comms/threads/:rootMessageId/read", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { rootMessageId } = req.params;
      const threadReadResult = await db
        .execute(sql`SELECT channel_id FROM comms_messages WHERE id = ${rootMessageId} LIMIT 1`);
      const threadReadMsg = threadReadResult.rows[0];
      if (!threadReadMsg) return res.status(404).json({ error: "Thread not found" });
      const channelId = (threadReadMsg as any).channel_id as string;
      const row = await commsStorage.markThreadRead(rootMessageId, channelId, userId);
      broadcastTwilioEvent({
        type: "comms:thread_unread" as const,
        channelId,
        rootMessageId,
        targetUserIds: [userId],
      });
      res.json(row);
    } catch (err: any) {
      console.error("[Comms] Mark thread read error:", err.message);
      res.status(500).json({ error: "Failed to mark thread read" });
    }
  });

  // POST /api/comms/threads/:rootMessageId/unread — mark thread unread from message
  app.post("/api/comms/threads/:rootMessageId/unread", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { rootMessageId } = req.params;
      const { messageId } = req.body;
      if (!messageId || typeof messageId !== "string") {
        return res.status(400).json({ error: "messageId required" });
      }
      const threadUnreadResult = await db
        .execute(sql`SELECT channel_id FROM comms_messages WHERE id = ${rootMessageId} LIMIT 1`);
      const threadUnreadMsg = threadUnreadResult.rows[0];
      if (!threadUnreadMsg) return res.status(404).json({ error: "Thread not found" });
      const channelId = (threadUnreadMsg as any).channel_id as string;
      const row = await commsStorage.markThreadUnread(rootMessageId, channelId, userId, messageId);
      if (!row) return res.status(404).json({ error: "Message not found in thread" });
      broadcastTwilioEvent({
        type: "comms:thread_unread" as const,
        channelId,
        rootMessageId,
        targetUserIds: [userId],
      });
      res.json(row);
    } catch (err: any) {
      console.error("[Comms] Mark thread unread error:", err.message);
      res.status(500).json({ error: "Failed to mark thread unread" });
    }
  });

  // GET /api/comms/threads/:rootMessageId/membership — get own follow state for a thread
  app.get("/api/comms/threads/:rootMessageId/membership", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { rootMessageId } = req.params;
      const row = await commsStorage.getThreadMembership(rootMessageId, userId);
      res.json(row ?? { rootMessageId, userId, following: false });
    } catch (err: any) {
      console.error("[Comms] Thread membership error:", err.message);
      res.status(500).json({ error: "Failed to get thread membership" });
    }
  });

  app.patch("/api/comms/messages/:id", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const message = await commsStorage.getMessageById(req.params.id);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const channelForEdit = await commsStorage.getChannelById(message.channelId);
      if (channelForEdit?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      if (message.userId !== userId) return res.status(403).json({ error: "Cannot edit others' messages" });
      // Require current channel membership: ex-members cannot edit historical
      // messages in channels/DMs they no longer belong to.
      const isMemberForEdit = await commsStorage.isChannelMember(message.channelId, userId);
      if (!isMemberForEdit) return res.status(403).json({ error: "Not a member" });

      const { content } = req.body;
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content required" });
      }
      const updated = await commsStorage.editMessage(message.id, userId, content);
      if (!updated) return res.status(404).json({ error: "Message not found or not owned" });

      const memberIds = await commsStorage.getChannelMemberIds(message.channelId);
      broadcastTwilioEvent({
        type: "comms:message_edit",
        channelId: message.channelId,
        messageId: message.id,
        content,
        editedAt: updated.editedAt!.toISOString(),
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.json(updated);
    } catch (err: any) {
      console.error("[Comms] Edit message error:", err.message);
      res.status(500).json({ error: "Failed to edit message" });
    }
  });

  app.delete("/api/comms/messages/:id", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const message = await commsStorage.getMessageById(req.params.id);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const channelForDelete = await commsStorage.getChannelById(message.channelId);
      if (channelForDelete?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isLead = isTeamLead(req);
      if (message.userId !== userId && !isLead) {
        return res.status(403).json({ error: "Cannot delete others' messages" });
      }
      // Owner path: require current channel membership so ex-members cannot
      // delete their historical messages in private channels or DMs.
      // Team leads acting as moderators (not as message owners) are exempt here —
      // their channel-level access is gated by the DM-privacy check below.
      if (message.userId === userId && !isLead) {
        const isMemberForDelete = await commsStorage.isChannelMember(message.channelId, userId);
        if (!isMemberForDelete) return res.status(403).json({ error: "Not a member" });
      }
      // DM privacy hardening: team-lead moderation bypass does NOT extend to
      // DM/group_dm channels where the team lead is not a member. Fail closed
      // so private 1:1 conversations cannot be moderated by non-participants.
      if (message.userId !== userId && isLead) {
        if (channelForDelete?.type === "dm" || channelForDelete?.type === "group_dm") {
          const isMember = await commsStorage.isStrictChannelMember(message.channelId, userId);
          if (!isMember) {
            return res.status(403).json({ error: "Cannot moderate messages in a DM you are not part of" });
          }
        }
      }
      const updated = await commsStorage.softDeleteMessage(message.id, message.userId ?? userId);
      if (!updated) {
        // Team lead deleting someone else's message
        const delResult = await db.execute(
          sql`UPDATE comms_messages SET deleted_at = NOW(), updated_at = NOW() WHERE id = ${message.id} RETURNING id`,
        );
        if (!delResult.rows[0]) return res.status(404).json({ error: "Message not found" });
      }
      const memberIds = await commsStorage.getChannelMemberIds(message.channelId);
      broadcastTwilioEvent({
        type: "comms:message_delete",
        channelId: message.channelId,
        messageId: message.id,
        deletedAt: new Date().toISOString(),
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Delete message error:", err.message);
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Edit history (Task #3254)

  // GET /api/comms/messages/:id/edit-history — list prior versions (channel members only)
  app.get("/api/comms/messages/:id/edit-history", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const message = await commsStorage.getMessageById(req.params.id);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const isMember = await commsStorage.isChannelMember(message.channelId, userId);
      if (!isMember && !isTeamLead(req)) return res.status(403).json({ error: "Not a member" });
      const history = await commsStorage.getMessageEditHistory(message.id);
      res.json(history);
    } catch (err: any) {
      console.error("[Comms] Edit history error:", err.message);
      res.status(500).json({ error: "Failed to get edit history" });
    }
  });

  // POST /api/comms/messages/:id/edit-history/:historyId/restore — restore a
  // prior version. Author or team lead / CEO only; current content is saved as
  // a new history version first (inside restoreEditVersion).
  app.post("/api/comms/messages/:id/edit-history/:historyId/restore", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const message = await commsStorage.getMessageById(req.params.id);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const channelForRestore = await commsStorage.getChannelById(message.channelId);
      if (channelForRestore?.archivedAt) return res.status(423).json({ error: "Channel is archived" });
      const isLead = isTeamLead(req);
      if (message.userId !== userId && !isLead) {
        return res.status(403).json({ error: "Cannot restore others' messages" });
      }
      // Author path: require current channel membership (same rule as edit).
      if (message.userId === userId) {
        const isMember = await commsStorage.isChannelMember(message.channelId, userId);
        if (!isMember && !isLead) return res.status(403).json({ error: "Not a member" });
      }
      // DM privacy: team-lead moderation does not extend into DMs they are not part of.
      if (message.userId !== userId && isLead) {
        if (channelForRestore?.type === "dm" || channelForRestore?.type === "group_dm") {
          const isMember = await commsStorage.isStrictChannelMember(message.channelId, userId);
          if (!isMember) {
            return res.status(403).json({ error: "Cannot restore messages in a DM you are not part of" });
          }
        }
      }
      const restored = await commsStorage.restoreEditVersion(message.id, req.params.historyId, userId);
      if (!restored) return res.status(404).json({ error: "Version not found" });
      const memberIds = await commsStorage.getChannelMemberIds(message.channelId);
      broadcastTwilioEvent({
        type: "comms:message_edit",
        channelId: message.channelId,
        messageId: message.id,
        content: restored.content,
        editedAt: (restored.editedAt ?? new Date()).toISOString(),
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });
      res.json(restored);
    } catch (err: any) {
      console.error("[Comms] Restore version error:", err.message);
      res.status(500).json({ error: "Failed to restore version" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Permalinks (Task #3254)

  // GET /api/comms/permalink?messageId=… — resolve a message id to its channel
  // (and thread root, if any) so the client can navigate + jump to it.
  app.get("/api/comms/permalink", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const messageId = req.query.messageId;
      if (!messageId || typeof messageId !== "string") {
        return res.status(400).json({ error: "messageId required" });
      }
      const message = await commsStorage.getMessageById(messageId);
      if (!message) return res.status(404).json({ error: "Message not found" });
      const isMember = await commsStorage.isChannelMember(message.channelId, userId);
      if (!isMember && !isTeamLead(req)) return res.status(403).json({ error: "Not a member" });
      res.json({
        messageId: message.id,
        channelId: message.channelId,
        parentId: message.parentId ?? null,
        createdAt: message.createdAt.toISOString(),
      });
    } catch (err: any) {
      console.error("[Comms] Permalink resolve error:", err.message);
      res.status(500).json({ error: "Failed to resolve permalink" });
    }
  });

}
