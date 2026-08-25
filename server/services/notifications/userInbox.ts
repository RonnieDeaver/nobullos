// @db-pool-intent: ambient
//
// This file does not call `getDb()` directly. Storage helpers it
// delegates to (server/storage/userNotificationsStorage.ts) inherit
// the caller's ambient pool. Task #1729 Phase 2.3 adds a
// `NotifyUserContext` arg so worker-context callers can opt into the
// worker pool via `runWithWorkerDb(...)` — gated by the
// `db_pool_tenancy_enforcement_enabled` kill switch.

/**
 * Task #1686 — `notifyUser()` helper.
 *
 * The single entry point for writing a row into the per-user in-app
 * notification inbox (table `user_notifications`). Every event that
 * Phases 2 & 3 wire up will go through here.
 *
 * Behaviour:
 *   - When `dedupeKey` is supplied AND an UNREAD non-archived row
 *     already exists for the same (userId, dedupeKey), the existing row
 *     is returned and no new row is inserted (enforced both in-query and
 *     by the `user_notifications_user_dedupe_unread_uniq` partial UNIQUE
 *     index). This stops a chatty source (e.g. a retry loop) from
 *     flooding the bell; once the user reads/archives the row a fresh
 *     dispatch with the same key produces a new notification.
 *   - On insert success the helper broadcasts a `notification:new`
 *     event scoped to the recipient userId via the existing
 *     twilioEvents SSE/pg_notify channel, so an open browser tab
 *     bumps the bell count in real time.
 *   - Failures are logged and swallowed; the caller (often a webhook
 *     handler) never sees a notification-pipeline failure block
 *     primary work.
 *
 * This helper is independent of the Slack-channel notification system
 * in server/services/notifications/{dispatcher,resolver,registry}.ts —
 * that subsystem routes admin watcher events into Slack channels and
 * is unrelated to the per-user inbox.
 */

import {
  userNotificationCategories,
  type UserNotification,
  type UserNotificationCategory,
} from "@shared/schema";
import {
  archiveNotification,
  findRecentDedupeMatch,
  getUnreadCount,
  getUnreadCountByBucket,
  insertUserNotification,
  notifyUserCombined,
  userExists,
  type NotifyUserInput,
} from "../../storage/userNotificationsStorage";
import { broadcastTwilioEvent } from "../twilioEvents";
import { maybeEnqueueUserSlackDm } from "./userSlackSender";
import { isPoolEpicSwitchEnabled } from "../poolEpicKillSwitches";
import { runWithWorkerDb, workerDb, db as apiDb } from "../../db";

// Task #1729 Phase 2.3 — pool-aware context.
//
// `notifyUser()` historically ran every storage call against the
// ambient `getDb()`, which means a worker-context caller (matching
// engine, recovery sweep, queue-backlog alerts) silently spent API-pool
// connections instead of worker-pool connections. Callers that run on
// the background-worker side now pass `{ source: "worker:..." }` (or
// the explicit `db: workerDb` handle); when the Phase 0 kill switch
// `db_pool_tenancy_enforcement_enabled` is ON, that hint causes the
// entire notifyUser body to execute inside `runWithWorkerDb(...)` so
// every nested `getDb()` lands on the worker pool.
//
// Default behavior (no context arg, or switch OFF) is unchanged — the
// helper continues to use whatever pool the caller's async context
// already resolves to (typically the API pool for request handlers).
export interface NotifyUserContext {
  /**
   * Caller scope label. Sources prefixed with `worker:` are treated as
   * background work and routed onto the worker pool when the tenancy
   * kill switch is enabled. Request/route callers should leave this
   * unset or pass an `api:` prefix.
   */
  source?: string;
  /**
   * Explicit Drizzle handle. Pass `workerDb` from `server/db.ts` to
   * force worker-pool routing irrespective of `source`. Passing `apiDb`
   * or omitting this field leaves the routing unchanged. This is a
   * routing hint only — storage functions still read from `getDb()`.
   */
  db?: typeof workerDb | typeof apiDb;
}

/**
 * Decide whether a given NotifyUserContext should route this call onto
 * the worker pool. Exported for tests; pure function so the gating
 * logic can be exercised without touching the DB.
 */
export function shouldRouteToWorkerPool(ctx?: NotifyUserContext): boolean {
  if (!isPoolEpicSwitchEnabled("db_pool_tenancy_enforcement_enabled")) {
    return false;
  }
  if (!ctx) return false;
  if (ctx.db === workerDb) return true;
  if (typeof ctx.source === "string" && ctx.source.startsWith("worker:")) {
    return true;
  }
  return false;
}

function runWithRoutedDb<T>(
  ctx: NotifyUserContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return shouldRouteToWorkerPool(ctx) ? runWithWorkerDb(fn) : fn();
}

// Task #1721 Phase 1.1 — Kill switch for the combined-CTE notifyUser
// path. Defaults to ON.
//
// Phase 0 (Task #1727) added the canonical `system_settings` mirror
// `notify_user_optimized_path_enabled`, which is the rollback path
// operators should reach for from now on (no redeploy required).
// The legacy env switch `NOTIFY_USER_OPTIMIZED_PATH_DISABLED=true` is
// still honoured by `isPoolEpicSwitchEnabled()` so anything wired to
// the older lever keeps working through the rollout.
function optimizedPathEnabled(): boolean {
  return isPoolEpicSwitchEnabled("notify_user_optimized_path_enabled");
}

const KNOWN_CATEGORIES = new Set<string>(userNotificationCategories);

export interface NotifyUserOptions {
  category: UserNotificationCategory | string;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface NotifyUserResult {
  notification: UserNotification;
  deduped: boolean;
}

export async function notifyUser(
  userId: string,
  opts: NotifyUserOptions,
  ctx?: NotifyUserContext,
): Promise<NotifyUserResult | null> {
  if (!userId || !opts?.title || !opts?.category) {
    console.warn(
      "[notifyUser] missing required args (userId/title/category); skipping",
    );
    return null;
  }
  if (!KNOWN_CATEGORIES.has(opts.category)) {
    // Categories drive the Slack-forwarding routing in Phase 2 and the
    // per-user preferences UI in Phase 3 — silently inserting unknown
    // categories would lock callers into an unmappable string. Reject
    // with a loud warning so the caller fixes their call site instead
    // of producing dead inbox rows.
    console.warn(
      `[notifyUser] unknown category "${opts.category}" for user=${userId}; ` +
        `must be one of [${userNotificationCategories.join(", ")}]; skipping`,
    );
    return null;
  }
  return runWithRoutedDb(ctx, () => notifyUserImpl(userId, opts));
}

async function notifyUserImpl(
  userId: string,
  opts: NotifyUserOptions,
): Promise<NotifyUserResult | null> {
  try {
    const input: NotifyUserInput = {
      userId,
      category: opts.category,
      title: opts.title,
      body: opts.body ?? null,
      deepLink: opts.deepLink ?? null,
      dedupeKey: opts.dedupeKey ?? null,
      metadata: opts.metadata ?? null,
    };
    let row: UserNotification;
    let unreadCount: number | null = null;
    if (optimizedPathEnabled()) {
      const combined = await notifyUserCombined(input);
      if (combined.status === "missing_user") {
        console.warn(
          `[notifyUser] recipient user=${userId} does not exist; skipping`,
        );
        return null;
      }
      if (combined.status === "race" || !combined.row) {
        const fallback = opts.dedupeKey
          ? await findRecentDedupeMatch(userId, opts.dedupeKey)
          : undefined;
        if (fallback) {
          return { notification: fallback, deduped: true };
        } else {
          if (!(await userExists(userId))) {
            console.warn(
              `[notifyUser] recipient user=${userId} does not exist; skipping`,
            );
            return null;
          }
          try {
            row = await insertUserNotification(input);
          } catch (insertErr: any) {
            // A racing inserter can land between our dedupe-window
            // probe and this insert. The unread-dedupe partial unique
            // index then raises 23505 — recover by re-reading the row
            // that beat us instead of aborting the surrounding work
            // (notifyUser must never throw past the hook).
            if (insertErr?.code === "23505" && opts.dedupeKey) {
              const racedRow = await findRecentDedupeMatch(
                userId,
                opts.dedupeKey,
              );
              if (racedRow) {
                return { notification: racedRow, deduped: true };
              }
            }
            throw insertErr;
          }
        }
      } else {
        if (combined.status === "deduped") {
          return { notification: combined.row, deduped: true };
        }
        row = combined.row;
        unreadCount = combined.unreadCount;
      }
    } else {
      if (!(await userExists(userId))) {
        console.warn(
          `[notifyUser] recipient user=${userId} does not exist; skipping`,
        );
        return null;
      }
      if (opts.dedupeKey) {
        const existing = await findRecentDedupeMatch(userId, opts.dedupeKey);
        if (existing) {
          return { notification: existing, deduped: true };
        }
      }
      try {
        row = await insertUserNotification(input);
      } catch (insertErr: any) {
        if (insertErr?.code === "23505" && opts.dedupeKey) {
          const racedRow = await findRecentDedupeMatch(
            userId,
            opts.dedupeKey,
          );
          if (racedRow) {
            return { notification: racedRow, deduped: true };
          }
        }
        throw insertErr;
      }
    }
    try {
      broadcastTwilioEvent({
        type: "notification:new",
        userId,
        notification: serializeForPush(row),
      });
      // Refreshed per-bucket counts → all tabs reconcile their bell badge
      // and system indicator without local guessing.
      // `count` is personal-only (drives the main red badge).
      try {
        const counts = await getUnreadCountByBucket(userId);
        broadcastTwilioEvent({
          type: "notification:count_updated",
          userId,
          count: counts.personal,
          personal: counts.personal,
          system: counts.system,
        });
      } catch (countErr: any) {
        console.warn(
          `[notifyUser] count broadcast failed for ${userId}: ${countErr?.message ?? countErr}`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[notifyUser] broadcast failed for ${row.id}: ${err?.message ?? err}`,
      );
    }
    // Task #1687 — Phase 2: after the in-app row is persisted and
    // broadcast, enqueue a per-user Slack DM. Best-effort; the
    // helper never throws and Slack failures never block in-app.
    try {
      await maybeEnqueueUserSlackDm({
        userId,
        category: opts.category,
        notificationId: row.id,
        content: {
          title: opts.title,
          body: opts.body ?? null,
          deepLink: opts.deepLink ?? null,
        },
      });
    } catch (err: any) {
      console.warn(
        `[notifyUser] slack-dm enqueue hook failed for ${row.id}: ${err?.message ?? err}`,
      );
    }
    return { notification: row, deduped: false };
  } catch (err: any) {
    // A failure to write the inbox row should never propagate up to the
    // caller — the originating webhook/handler will have already
    // completed its primary work.
    console.error(
      `[notifyUser] failed for user=${userId} category=${opts.category}: ${err?.message ?? err}`,
    );
    return null;
  }
}

/** Emit a single-row state-change event (read / unread / archived) and
 *  a refreshed unread count to the recipient's SSE subscribers. Called
 *  by the REST routes after a successful mutation; safe to call inside
 *  request handlers (errors are swallowed). */
export async function broadcastNotificationStateChange(
  userId: string,
  notification: UserNotification,
  type: "notification:read" | "notification:unread" | "notification:archived",
): Promise<void> {
  try {
    broadcastTwilioEvent({
      type,
      userId,
      notificationId: notification.id,
      readAt: notification.readAt ? notification.readAt.toISOString() : null,
      archivedAt: notification.archivedAt
        ? notification.archivedAt.toISOString()
        : null,
      updatedAt: notification.updatedAt.toISOString(),
    });
  } catch (err: any) {
    console.warn(
      `[notifyUser] state broadcast (${type}) failed for ${notification.id}: ${err?.message ?? err}`,
    );
  }
  await broadcastUnreadCount(userId);
}

/**
 * Resolve (archive) the active dedupe-backed notification for a
 * (userId, dedupeKey) pair, if one is currently unread. Returns true
 * when a row was archived.
 *
 * This is the correct way to "clear" a deduped alert: archiving the
 * outstanding row both dismisses it from the recipient's bell AND frees
 * the dedupe key, so a later re-trigger under the same key produces a
 * fresh notification instead of silently deduping against a stale row.
 * Best-effort — failures are logged and swallowed so the caller's
 * primary work is never blocked.
 */
export async function resolveDedupeNotification(
  userId: string,
  dedupeKey: string,
): Promise<boolean> {
  try {
    const existing = await findRecentDedupeMatch(userId, dedupeKey);
    if (!existing) return false;
    const archived = await archiveNotification(userId, existing.id);
    if (!archived) return false;
    await broadcastNotificationStateChange(
      userId,
      archived,
      "notification:archived",
    );
    return true;
  } catch (err: any) {
    console.warn(
      `[notifyUser] resolveDedupeNotification failed for user=${userId} key=${dedupeKey}: ${err?.message ?? err}`,
    );
    return false;
  }
}

/** Look up the user's current per-bucket unread counts and broadcast them.
 *  Used after bulk mutations (mark-all-read) where there is no single row
 *  to push.
 *
 *  The event payload includes:
 *   - `count`    — personal bucket count (drives the main bell badge)
 *   - `personal` — same as count (explicit field for clarity)
 *   - `system`   — system bucket count (drives the muted secondary indicator)
 */
export async function broadcastUnreadCount(userId: string): Promise<void> {
  try {
    const counts = await getUnreadCountByBucket(userId);
    broadcastTwilioEvent({
      type: "notification:count_updated",
      userId,
      count: counts.personal,
      personal: counts.personal,
      system: counts.system,
    });
  } catch (err: any) {
    console.warn(
      `[notifyUser] count broadcast failed for ${userId}: ${err?.message ?? err}`,
    );
  }
}

function serializeForPush(row: UserNotification) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    metadata: row.metadata,
    dedupeKey: row.dedupeKey,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
