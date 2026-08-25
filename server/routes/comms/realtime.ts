// @cross-instance-safe: SSE heartbeat setInterval is per-connection (created and destroyed per HTTP request, no shared state).
// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — realtime.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: SSE events stream, Presence, User status.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { commsWriteLimiter } from "../middleware";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import { addTwilioEventSubscriber } from "../../services/twilioEvents";
import {
  markCommsUserOnline,
  markCommsUserOffline,
  heartbeatCommsUser,
  listOnlineCommsUserIds,
  isCommsUserOnline,
  deriveEffectiveStatus,
  COMMS_PRESENCE_HEARTBEAT_MS,
} from "../../services/commsPresence";
import * as commsStorage from "../../storage/commsStorage";
import { getUserId } from "./shared";

export function registerCommsRealtimeRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // SSE events stream  (per-user scoped)
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/events", isAuthenticated, (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`event: ready\ndata: {"presenceHeartbeatMs":${COMMS_PRESENCE_HEARTBEAT_MS},"serverTime":"${new Date().toISOString()}"}\n\n`);

    markCommsUserOnline(userId);
    broadcastTwilioEvent({ type: "comms:presence", userId, online: true });
    // Broadcast status on connect so all clients immediately learn this user's
    // effective status (may be online/away depending on manual setting).
    commsStorage.getUserStatus(userId).then(async (row) => {
      if (row) row = await commsStorage.resolveDndExpiry(userId, row);
      if (row) row = await commsStorage.resolveCustomStatusExpiry(userId, row);
      const effectiveStatus = deriveEffectiveStatus(row, true);
      broadcastTwilioEvent({
        type: "comms:user_status",
        userId,
        effectiveStatus,
        manualStatus: row?.manualStatus ?? null,
        customEmoji: row?.customEmoji ?? null,
        customText: row?.customText ?? null,
        customExpiresAt: row?.customExpiresAt?.toISOString() ?? null,
        dndExpiresAt: row?.dndExpiresAt?.toISOString() ?? null,
      });
    }).catch(() => {});

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
        heartbeatCommsUser(userId);
      } catch {
        /* close handler cleans up */
      }
    }, 25000);

    const unsubscribe = addTwilioEventSubscriber(res, { userId });

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      markCommsUserOffline(userId);
      broadcastTwilioEvent({ type: "comms:presence", userId, online: false });
      // Best-effort: broadcast updated status so other clients see the
      // online→away/offline transition immediately when the stream closes.
      commsStorage.getUserStatus(userId).then(async (row) => {
        if (row) row = await commsStorage.resolveDndExpiry(userId, row);
        if (row) row = await commsStorage.resolveCustomStatusExpiry(userId, row);
        const effectiveStatus = deriveEffectiveStatus(row, false);
        broadcastTwilioEvent({
          type: "comms:user_status",
          userId,
          effectiveStatus,
          manualStatus: row?.manualStatus ?? null,
          customEmoji: row?.customEmoji ?? null,
          customText: row?.customText ?? null,
          customExpiresAt: row?.customExpiresAt?.toISOString() ?? null,
          dndExpiresAt: row?.dndExpiresAt?.toISOString() ?? null,
        });
      }).catch(() => {});
    };
    req.on("close", close);
    req.on("aborted", close);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SSE reconnect catch-up — called immediately after re-establishing the SSE
  // stream so the client can refresh messages in any channel that had activity
  // while the connection was dropped.  Returns the list of channel IDs that
  // have had message activity since `since`, along with the server's current
  // time so the client can anchor the next catch-up window correctly.
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/events/catch-up", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const sinceParam = typeof req.query.since === "string" ? req.query.since : null;
      if (!sinceParam) {
        return res.status(400).json({ error: "since query param required (ISO 8601)" });
      }
      const since = new Date(sinceParam);
      if (isNaN(since.getTime())) {
        return res.status(400).json({ error: "since must be a valid ISO 8601 timestamp" });
      }
      const activeChannelIds = await commsStorage.getActiveChannelIdsSince(userId, since);
      res.json({ activeChannelIds, serverTime: new Date().toISOString() });
    } catch (err: any) {
      console.error("[Comms] Catch-up error:", err.message);
      res.status(500).json({ error: "Failed to compute catch-up" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Presence
  // ──────────────────────────────────────────────────────────────────────────
  // Task #3130 — picker-safe teammate list for the New DM dialog. The full
  // GET /api/users surface is Team Lead+ only; this endpoint is open to any
  // authenticated user but returns ONLY display fields (id, name, avatar,
  // email) so regular users can start DMs without seeing role/admin data.
  // Rate limiting: inherits the same global apiLimiter as every other
  // /api/comms GET (read-only, so writeLimiter does not apply).
  app.get("/api/comms/users", isAuthenticated, async (_req, res) => {
    try {
      const teammates = await commsStorage.listCommsPickerUsers();
      res.json(teammates);
    } catch (error) {
      console.error("[Comms] Error fetching picker users:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/comms/presence", isAuthenticated, (_req, res) => {
    res.json({ onlineUserIds: listOnlineCommsUserIds() });
  });

  // Task #4788 — the heartbeat fires every 25 s from EVERY open tab
  // (client/src/contexts/CommsContext.tsx). It rides the dedicated
  // commsWrite bucket (60/min) and is exempt from the shared writeLimiter,
  // so idle presence pings cannot starve interactive saves (prod evidence:
  // 215 of 351 write-category 429s were this path).
  app.post("/api/comms/presence/heartbeat", isAuthenticated, commsWriteLimiter, (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    heartbeatCommsUser(userId);
    markCommsUserOnline(userId);
    // Persist activity anchor for auto-away (best-effort, no await-on-error)
    commsStorage.touchUserActivity(userId).catch(() => {});
    res.json({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // User status
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/comms/status/me — own effective status + custom status.
   * Lazily resolves DND + custom expiry so the caller always gets an accurate
   * status. Broadcasts comms:user_status if expiry-driven changes occurred.
   */
  app.get("/api/comms/status/me", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      let row = await commsStorage.getUserStatus(userId);
      const rowBefore = row ? { ...row } : null;
      const isOnline = isCommsUserOnline(userId);
      const statusBefore = deriveEffectiveStatus(row, isOnline);
      if (row) row = await commsStorage.resolveDndExpiry(userId, row);
      if (row) row = await commsStorage.resolveCustomStatusExpiry(userId, row);
      const effectiveStatus = deriveEffectiveStatus(row, isOnline);
      // Broadcast on any expiry-driven field change — not only effectiveStatus —
      // so clients clear emoji/text when a custom status expires even if the
      // underlying presence (online/away) stays the same.
      const anyExpiryChange =
        effectiveStatus !== statusBefore ||
        (rowBefore?.customEmoji && !row?.customEmoji) ||
        (rowBefore?.customText && !row?.customText) ||
        (rowBefore?.dndExpiresAt && !row?.dndExpiresAt);
      if (anyExpiryChange) {
        broadcastTwilioEvent({
          type: "comms:user_status",
          userId,
          effectiveStatus,
          manualStatus: row?.manualStatus ?? null,
          customEmoji: row?.customEmoji ?? null,
          customText: row?.customText ?? null,
          customExpiresAt: row?.customExpiresAt?.toISOString() ?? null,
          dndExpiresAt: row?.dndExpiresAt?.toISOString() ?? null,
        });
      }
      res.json({
        userId,
        effectiveStatus,
        manualStatus: row?.manualStatus ?? null,
        dndExpiresAt: row?.dndExpiresAt?.toISOString() ?? null,
        priorStatus: row?.priorStatus ?? null,
        customEmoji: row?.customEmoji ?? null,
        customText: row?.customText ?? null,
        customExpiresAt: row?.customExpiresAt?.toISOString() ?? null,
        recentCustomStatuses: row?.recentCustomStatuses ?? [],
      });
    } catch (err: any) {
      console.error("[Comms] Get status error:", err.message);
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  const setStatusSchema = z.object({
    status: z.enum(["online", "away", "dnd", "offline"]),
    dndExpiresAt: z.string().datetime().nullable().optional(),
  });

  /**
   * PUT /api/comms/status/me — set manual status.
   * Broadcasts comms:user_status so all connected clients update immediately.
   */
  app.put("/api/comms/status/me", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = setStatusSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { status, dndExpiresAt } = parsed.data;
      const dndDate = dndExpiresAt ? new Date(dndExpiresAt) : undefined;
      const row = await commsStorage.setUserManualStatus(userId, status, dndDate);
      const isOnline = isCommsUserOnline(userId);
      const effectiveStatus = deriveEffectiveStatus(row, isOnline);
      const payload = {
        userId,
        effectiveStatus,
        manualStatus: row.manualStatus ?? null,
        dndExpiresAt: row.dndExpiresAt?.toISOString() ?? null,
        priorStatus: row.priorStatus ?? null,
        customEmoji: row.customEmoji ?? null,
        customText: row.customText ?? null,
        customExpiresAt: row.customExpiresAt?.toISOString() ?? null,
        recentCustomStatuses: row.recentCustomStatuses ?? [],
      };
      broadcastTwilioEvent({
        type: "comms:user_status",
        userId,
        effectiveStatus,
        manualStatus: row.manualStatus ?? null,
        customEmoji: row.customEmoji ?? null,
        customText: row.customText ?? null,
        customExpiresAt: row.customExpiresAt?.toISOString() ?? null,
        dndExpiresAt: row.dndExpiresAt?.toISOString() ?? null,
      });
      res.json(payload);
    } catch (err: any) {
      console.error("[Comms] Set status error:", err.message);
      res.status(500).json({ error: "Failed to set status" });
    }
  });

  const setCustomStatusSchema = z.union([
    z.object({
      clear: z.literal(true),
    }),
    z.object({
      emoji: z.string().min(1).max(64),
      text: z.string().max(100),
      expiresAt: z.string().datetime().nullable().optional(),
    }),
  ]);

  /**
   * PUT /api/comms/status/me/custom — set or clear custom status.
   * On set, prepends to recentCustomStatuses (capped at 5).
   * Broadcasts comms:user_status to keep remote members in sync.
   */
  app.put("/api/comms/status/me/custom", isAuthenticated, commsWriteLimiter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = setCustomStatusSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const body = parsed.data;
      let row;
      if ("clear" in body && body.clear) {
        row = await commsStorage.setUserCustomStatus(userId, null);
      } else {
        const d = body as { emoji: string; text: string; expiresAt?: string | null };
        row = await commsStorage.setUserCustomStatus(userId, {
          emoji: d.emoji,
          text: d.text,
          expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
        });
      }
      const isOnline = isCommsUserOnline(userId);
      const effectiveStatus = deriveEffectiveStatus(row, isOnline);
      const payload = {
        userId,
        effectiveStatus,
        manualStatus: row.manualStatus ?? null,
        dndExpiresAt: row.dndExpiresAt?.toISOString() ?? null,
        priorStatus: row.priorStatus ?? null,
        customEmoji: row.customEmoji ?? null,
        customText: row.customText ?? null,
        customExpiresAt: row.customExpiresAt?.toISOString() ?? null,
        recentCustomStatuses: row.recentCustomStatuses ?? [],
      };
      broadcastTwilioEvent({
        type: "comms:user_status",
        userId,
        effectiveStatus,
        manualStatus: row.manualStatus ?? null,
        customEmoji: row.customEmoji ?? null,
        customText: row.customText ?? null,
        customExpiresAt: row.customExpiresAt?.toISOString() ?? null,
        dndExpiresAt: row.dndExpiresAt?.toISOString() ?? null,
      });
      res.json(payload);
    } catch (err: any) {
      console.error("[Comms] Set custom status error:", err.message);
      res.status(500).json({ error: "Failed to set custom status" });
    }
  });

  /**
   * GET /api/comms/status/bulk?userIds=a,b,c
   * Returns effective status for a list of user IDs (for member lists,
   * DM headers, message author hovers).
   */
  app.get("/api/comms/status/bulk", isAuthenticated, async (req: any, res) => {
    try {
      const raw = typeof req.query.userIds === "string" ? req.query.userIds : "";
      const userIds = raw
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
        .slice(0, 100); // cap to prevent abuse
      if (userIds.length === 0) return res.json([]);
      const rowMap = await commsStorage.getUserStatusBulk(userIds);
      const now = Date.now();
      const result = await Promise.all(
        userIds.map(async (uid: string) => {
          let row = rowMap.get(uid) ?? null;
          const rowBefore = row ? { ...row } : null;
          const isOnline = isCommsUserOnline(uid);
          const statusBefore = deriveEffectiveStatus(row, isOnline, now);
          if (row) row = await commsStorage.resolveDndExpiry(uid, row);
          if (row) row = await commsStorage.resolveCustomStatusExpiry(uid, row);
          const effectiveStatus = deriveEffectiveStatus(row, isOnline, now);
          // Broadcast on any expiry-driven field change, not only effectiveStatus,
          // so custom-status emoji/text clears propagate to all clients live.
          const anyExpiryChange =
            effectiveStatus !== statusBefore ||
            (rowBefore?.customEmoji && !row?.customEmoji) ||
            (rowBefore?.customText && !row?.customText) ||
            (rowBefore?.dndExpiresAt && !row?.dndExpiresAt);
          if (anyExpiryChange) {
            broadcastTwilioEvent({
              type: "comms:user_status",
              userId: uid,
              effectiveStatus,
              manualStatus: row?.manualStatus ?? null,
              customEmoji: row?.customEmoji ?? null,
              customText: row?.customText ?? null,
              customExpiresAt: row?.customExpiresAt?.toISOString() ?? null,
              dndExpiresAt: row?.dndExpiresAt?.toISOString() ?? null,
            });
          }
          return {
            userId: uid,
            effectiveStatus,
            manualStatus: row?.manualStatus ?? null,
            dndExpiresAt: row?.dndExpiresAt?.toISOString() ?? null,
            customEmoji: row?.customEmoji ?? null,
            customText: row?.customText ?? null,
            customExpiresAt: row?.customExpiresAt?.toISOString() ?? null,
          };
        }),
      );
      res.json(result);
    } catch (err: any) {
      console.error("[Comms] Bulk status error:", err.message);
      res.status(500).json({ error: "Failed to get statuses" });
    }
  });

}
