// @cross-instance-safe: per-connection SSE heartbeat writing to one client's response; no shared side effect.
/**
 * Task #1686 — Per-user in-app notification inbox REST API + SSE.
 *
 * All routes are scoped to the authenticated user. There is NO admin
 * cross-user read path on this surface — admins cannot list someone
 * else's inbox via these endpoints.
 *
 * Routes:
 *   GET    /api/notifications                  list current user's notifications
 *   GET    /api/notifications/unread-count     unread count for the bell badge
 *   GET    /api/notifications/events           SSE push (per-user scoped)
 *   PATCH  /api/notifications/:id/read         mark single read
 *   PATCH  /api/notifications/:id/unread       mark single unread
 *   PATCH  /api/notifications/mark-all-read    mark all read
 *   PATCH  /api/notifications/:id/archive      archive (also marks read)
 *   POST   /api/notifications/test             admin-only — write a test row
 *                                              to the *caller's own* inbox
 *
 * Real-time events for state changes flow back through the existing
 * twilioEvents SSE/pg_notify channel, fanned out to the recipient
 * userId only — duplicate tabs stay consistent without polling.
 *
 * The legacy POST variants of the mutation routes are kept as aliases
 * so older clients that fired POST instead of PATCH don't break during
 * rollout — both methods land in the same handler.
 */

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { userNotificationCategories } from "@shared/schema";
import {
  archiveNotification,
  countUserNotifications,
  getUnreadCountByBucket,
  listSystemBundled,
  listUserNotifications,
  markAllRead,
  markAllReadBucket,
  markBundleRead,
  markRead,
  markUnread,
  type NotificationBucket,
} from "../storage/userNotificationsStorage";
import {
  broadcastNotificationStateChange,
  broadcastUnreadCount,
  notifyUser,
} from "../services/notifications/userInbox";
import { addTwilioEventSubscriber } from "../services/twilioEvents";
import { asyncHandler } from "../observability/httpErrors";

const listQuerySchema = z.object({
  includeArchived: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional(),
  unreadOnly: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional(),
  archivedOnly: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional(),
  category: z.string().min(1).max(64).optional(),
  bucket: z.enum(["personal", "system"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional(),
});

const markAllReadBodySchema = z.object({
  bucket: z.enum(["personal", "system"]).optional(),
});

const systemBundledQuerySchema = z.object({
  includeArchived: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const markBundleReadBodySchema = z.object({
  ids: z.array(z.string().min(1).max(128)).min(1).max(200),
});

const testBodySchema = z.object({
  category: z.enum(userNotificationCategories).optional(),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(4000).optional(),
  deepLink: z.string().max(1024).optional(),
  dedupeKey: z.string().max(128).optional(),
  metadata: z.record(z.unknown()).optional(),
});

function getUserId(req: any): string | null {
  return req?.user?.claims?.sub ?? null;
}

function isTruthyFlag(v: unknown): boolean {
  return v === "1" || v === "true";
}

type MaybeAsyncRequestHandler =
  | RequestHandler
  | ((...args: Parameters<RequestHandler>) => Promise<void>);
export interface RegisterUserNotificationRoutesOpts {
  isAuthenticated: MaybeAsyncRequestHandler;
  requireTeamLead: MaybeAsyncRequestHandler;
}

export function registerUserNotificationRoutes(
  app: Express,
  opts: RegisterUserNotificationRoutesOpts,
): void {
  const { isAuthenticated, requireTeamLead } = opts;

  // Task #3816: this router's hand-rolled per-route catch blocks moved to
  // asyncHandler(fn, <legacy error token>) — unexpected errors keep each
  // route's exact old `{ error: "<token>" }` 500 body, while logging and
  // the added message/code/requestId fields come from the global error
  // middleware. Response contracts are unchanged.
  app.get("/api/notifications", isAuthenticated, asyncHandler(async (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_query", details: parsed.error.flatten() });
    }
    const filter = {
      includeArchived: isTruthyFlag(parsed.data.includeArchived),
      archivedOnly: isTruthyFlag(parsed.data.archivedOnly),
      unreadOnly: isTruthyFlag(parsed.data.unreadOnly),
      category: parsed.data.category,
      bucket: parsed.data.bucket as NotificationBucket | undefined,
    };
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const [rows, total] = await Promise.all([
      listUserNotifications(userId, { ...filter, limit, offset }),
      countUserNotifications(userId, filter),
    ]);
    res.json({
      notifications: rows,
      // Back-compat — older clients (bell dropdown initial release)
      // read the response as a bare array. We continue to expose
      // both shapes so a stale client still works.
      items: rows,
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }, "list_failed"));

  // Bundled system-bucket listing — groups repeated alerts by
  // (category, notificationId, title) so 14× the same keepalive alert
  // appears as one row with count=14.
  app.get(
    "/api/notifications/system-bundled",
    isAuthenticated,
    asyncHandler(async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = systemBundledQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_query", details: parsed.error.flatten() });
      }
      const bundles = await listSystemBundled(userId, {
        includeArchived: isTruthyFlag(parsed.data.includeArchived),
        limit: parsed.data.limit ?? 50,
      });
      res.json({ bundles });
    }, "system_bundled_failed"),
  );

  // Mark all notifications in a bundled group read (accepts array of IDs).
  app.patch(
    "/api/notifications/mark-bundle-read",
    isAuthenticated,
    asyncHandler(async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = markBundleReadBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const updated = await markBundleRead(userId, parsed.data.ids);
      await broadcastUnreadCount(userId);
      res.json({ ok: true, updated });
    }, "mark_bundle_read_failed"),
  );

  app.get(
    "/api/notifications/unread-count",
    isAuthenticated,
    asyncHandler(async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const counts = await getUnreadCountByBucket(userId);
      // `count` is personal-only for the main bell badge.
      // `system` is the secondary muted indicator.
      res.json({ count: counts.personal, personal: counts.personal, system: counts.system });
    }, "unread_count_failed"),
  );

  // SSE — the bell component subscribes once on mount. The actual
  // delivery is performed by the twilioEvents broadcaster; this route
  // just exposes a per-user-scoped subscription channel without
  // requiring Twilio-specific access (any authenticated user has an
  // inbox).
  app.get("/api/notifications/events", isAuthenticated, (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = addTwilioEventSubscriber(res, { userId });
    // Task #2840 — the 25 s heartbeat was verified against both a direct
    // localhost connection and the public proxy: an idle stream survives
    // 65+ s with only these heartbeats, so 25 s is comfortably below any
    // idle-timeout in the path. (The "drops every 5–6 s" pattern was the
    // client's fixed retry timer re-issuing FAILED attempts, not an
    // established connection being dropped — see client/src/lib/sseReconnect.ts.)
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        /* dropped — close handler will clean up */
      }
    }, 25000);
    // Task #2840 — connection-lifetime observability. Express's request
    // logger only fires on `finish`, which a dropped SSE socket never
    // reaches (it emits `close` without `finish`), so established-stream
    // drops were invisible in the logs. Log the lifetime on close so a
    // genuine proxy/LB drop pattern shows up with real durations.
    const connectedAt = Date.now();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      const lifetimeMs = Date.now() - connectedAt;
      console.log(
        `[userNotifications] SSE closed user=${userId} after ${Math.round(lifetimeMs / 1000)}s`,
      );
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  const markReadHandler: RequestHandler = asyncHandler(async (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing_id" });
    const row = await markRead(userId, id);
    if (row) {
      await broadcastNotificationStateChange(userId, row, "notification:read");
    } else {
      // No row matched the (id, userId, unread) predicate. Still
      // refresh the badge — the row may have already been read in
      // another tab, and the caller's tab needs to reconcile.
      await broadcastUnreadCount(userId);
    }
    res.json({ ok: true, notification: row ?? null });
  }, "mark_read_failed");
  // Multi-line form required for bare-reference handlers (Task #4995).
  app.patch(
    "/api/notifications/:id/read",
    isAuthenticated,
    markReadHandler,
  );
  app.post(
    "/api/notifications/:id/read",
    isAuthenticated,
    markReadHandler, // legacy
  );

  const markUnreadHandler: RequestHandler = asyncHandler(async (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing_id" });
    const row = await markUnread(userId, id);
    if (row) {
      await broadcastNotificationStateChange(
        userId,
        row,
        "notification:unread",
      );
    } else {
      await broadcastUnreadCount(userId);
    }
    res.json({ ok: true, notification: row ?? null });
  }, "mark_unread_failed");
  app.patch(
    "/api/notifications/:id/unread",
    isAuthenticated,
    markUnreadHandler,
  );

  const markAllReadHandler: RequestHandler = asyncHandler(async (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const parsed = markAllReadBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const bucket = parsed.data.bucket as NotificationBucket | undefined;
    const updated = bucket
      ? await markAllReadBucket(userId, bucket)
      : await markAllRead(userId);
    await broadcastUnreadCount(userId);
    res.json({ ok: true, updated });
  }, "mark_all_read_failed");
  app.patch(
    "/api/notifications/mark-all-read",
    isAuthenticated,
    markAllReadHandler,
  );
  app.post(
    "/api/notifications/read-all",
    isAuthenticated,
    markAllReadHandler, // legacy
  );

  const archiveHandler: RequestHandler = asyncHandler(async (req: any, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing_id" });
    const row = await archiveNotification(userId, id);
    if (!row) return res.status(404).json({ error: "not_found" });
    await broadcastNotificationStateChange(
      userId,
      row,
      "notification:archived",
    );
    res.json({ ok: true, notification: row });
  }, "archive_failed");
  app.patch(
    "/api/notifications/:id/archive",
    isAuthenticated,
    archiveHandler,
  );
  app.post(
    "/api/notifications/:id/archive",
    isAuthenticated,
    archiveHandler, // legacy
  );

  // Admin-only test fire — writes a notification to the *caller's own*
  // inbox so an admin can verify the pipeline end-to-end without
  // poking another user. Bypasses dedupe by default (each press
  // produces a fresh row); pass `dedupeKey` to test dedupe behaviour.
  app.post(
    "/api/notifications/test",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = testBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const result = await notifyUser(userId, {
        category: parsed.data.category ?? "system",
        title: parsed.data.title ?? "Test notification",
        body:
          parsed.data.body ??
          "This is a test notification fired from /api/notifications/test.",
        deepLink: parsed.data.deepLink ?? "/notifications",
        dedupeKey: parsed.data.dedupeKey ?? null,
        metadata: parsed.data.metadata ?? { source: "admin_test" },
      });
      if (!result) return res.status(500).json({ error: "notify_failed" });
      res.json({
        ok: true,
        deduped: result.deduped,
        notification: result.notification,
      });
    },
  );
}
