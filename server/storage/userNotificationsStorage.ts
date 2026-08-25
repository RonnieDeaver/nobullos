// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Task #1686 — Per-user in-app notification inbox storage.
 *
 * Backs the `notifyUser()` helper, the `/api/notifications/*` REST API,
 * and the bell + dropdown + `/notifications` inbox page. This is the
 * inbox foundation only — wiring real events into it is downstream
 * (Phases 2 & 3 of the Notifications epic).
 */

import { and, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../db";
import {
  clients,
  userNotifications,
  users,
  type UserNotification,
  type UserNotificationCategory,
} from "@shared/schema";

// ─── Bucket classification ──────────────────────────────────────────────────
//
// Two buckets drive the bell split:
//   "system"   — categories: system, queue_health (infra/integration alerts)
//   "personal" — everything else (comms, booking, mention, assignment, etc.)
//
// Classification is derived at read time from the category field; no migration.
export const SYSTEM_BUCKET_CATEGORIES = ["system", "queue_health"] as const;

export type NotificationBucket = "personal" | "system";

export function getNotificationBucket(category: string): NotificationBucket {
  return (SYSTEM_BUCKET_CATEGORIES as readonly string[]).includes(category)
    ? "system"
    : "personal";
}

export interface NotifyUserInput {
  userId: string;
  category: UserNotificationCategory | string;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Look up the single UNREAD non-archived notification matching
 *  (userId, dedupeKey), regardless of age. Returns undefined if none.
 *
 *  No time window: the unread-dedupe partial UNIQUE index guarantees at
 *  most one such row exists, and the goal is "one unread notification per
 *  (user, dedupeKey) until the user reads/archives it" — a duplicate
 *  must be suppressed even if the original is days old. Once the user
 *  reads or archives the row it leaves the partial index, so the next
 *  dispatch with the same key produces a fresh notification. */
export async function findRecentDedupeMatch(
  userId: string,
  dedupeKey: string,
): Promise<UserNotification | undefined> {
  return withDbAttribution("userNotifications:findDedupe", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(userNotifications)
          .where(
            and(
              eq(userNotifications.userId, userId),
              eq(userNotifications.dedupeKey, dedupeKey),
              isNull(userNotifications.readAt),
              isNull(userNotifications.archivedAt),
            ),
          )
          .orderBy(desc(userNotifications.createdAt))
          .limit(1),
      "userNotifications.findDedupe",
    );
    return row;
  });
}

export async function insertUserNotification(
  input: NotifyUserInput,
): Promise<UserNotification> {
  return withDbAttribution("userNotifications:insert", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(userNotifications)
          .values({
            userId: input.userId,
            category: input.category,
            title: input.title,
            body: input.body ?? null,
            deepLink: input.deepLink ?? null,
            metadata:
              (input.metadata as Record<string, unknown> | null | undefined) ??
              null,
            dedupeKey: input.dedupeKey ?? null,
          })
          .returning(),
      "userNotifications.insert",
    );
    return row;
  });
}

// Task #1721 Phase 1.1 — Combined user-check + dedupe-lookup + insert +
// unread-count in a single round-trip. The legacy notifyUser() common path
// performed four sequential DB calls (userExists / findRecentDedupeMatch /
// insertUserNotification / getUnreadCount) which produced multi-second
// connection holds on the API pool. This CTE collapses them into one
// statement against `user_notifications`.
//
// Result shape:
//   { status: 'inserted', row, unreadCount } — new row written
//   { status: 'deduped',  row, unreadCount } — existing unread dedupe match
//   { status: 'missing_user', row: null, unreadCount: 0 } — user FK absent
//   { status: 'race',     row: null, unreadCount: 0 } — concurrent insert
//                                                       collided; caller
//                                                       should fall back
export interface NotifyUserCombinedResult {
  status: "inserted" | "deduped" | "missing_user" | "race";
  row: UserNotification | null;
  unreadCount: number;
}

function rowToUserNotification(r: Record<string, any>): UserNotification {
  return {
    id: r.id,
    userId: r.user_id,
    category: r.category,
    title: r.title,
    body: r.body ?? null,
    deepLink: r.deep_link ?? null,
    metadata: r.metadata ?? null,
    dedupeKey: r.dedupe_key ?? null,
    readAt: r.read_at ? new Date(r.read_at) : null,
    archivedAt: r.archived_at ? new Date(r.archived_at) : null,
    createdAt: r.created_at ? new Date(r.created_at) : new Date(),
    updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
  };
}

export async function notifyUserCombined(
  input: NotifyUserInput,
): Promise<NotifyUserCombinedResult> {
  return withDbAttribution("userNotifications:notifyCombined", async () => {
    const dedupeKey = input.dedupeKey ?? null;
    const body = input.body ?? null;
    const deepLink = input.deepLink ?? null;
    const metadata =
      (input.metadata as Record<string, unknown> | null | undefined) ?? null;
    const metadataJson = metadata === null ? null : JSON.stringify(metadata);
    const result = await dbRetry(
      () =>
        getDb().execute(sql`
          WITH user_check AS (
            SELECT id FROM users WHERE id = ${input.userId} LIMIT 1
          ),
          existing AS (
            SELECT * FROM user_notifications
            WHERE user_id = ${input.userId}
              AND dedupe_key = ${dedupeKey}
              AND read_at IS NULL
              AND archived_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
          ),
          inserted AS (
            INSERT INTO user_notifications
              (user_id, category, title, body, deep_link, metadata, dedupe_key)
            SELECT
              ${input.userId},
              ${input.category},
              ${input.title},
              ${body},
              ${deepLink},
              ${metadataJson}::jsonb,
              ${dedupeKey}
            WHERE EXISTS (SELECT 1 FROM user_check)
              AND NOT EXISTS (SELECT 1 FROM existing)
            ON CONFLICT DO NOTHING
            RETURNING *
          ),
          combined AS (
            SELECT 'inserted'::text AS status, i.* FROM inserted i
            UNION ALL
            SELECT 'deduped'::text AS status, e.* FROM existing e
            WHERE NOT EXISTS (SELECT 1 FROM inserted)
          )
          SELECT
            c.status,
            c.id, c.user_id, c.category, c.title, c.body, c.deep_link,
            c.metadata, c.dedupe_key, c.read_at, c.archived_at,
            c.created_at, c.updated_at,
            (
              -- Pre-insert snapshot count. Data-modifying CTEs run in
              -- the statement snapshot, so the freshly-inserted row is
              -- NOT visible to this subselect; we add +1 below when
              -- status='inserted' to keep the count accurate.
              SELECT count(*)::int FROM user_notifications
              WHERE user_id = ${input.userId}
                AND read_at IS NULL
                AND archived_at IS NULL
            ) + (CASE WHEN c.status = 'inserted' THEN 1 ELSE 0 END) AS unread_count,
            EXISTS (SELECT 1 FROM user_check) AS user_present
          FROM combined c
          UNION ALL
          SELECT
            'no_user'::text AS status,
            NULL::varchar, NULL::varchar, NULL::varchar, NULL::text,
            NULL::text, NULL::text, NULL::jsonb, NULL::varchar,
            NULL::timestamp, NULL::timestamp, NULL::timestamp, NULL::timestamp,
            0::int AS unread_count,
            EXISTS (SELECT 1 FROM user_check) AS user_present
          WHERE NOT EXISTS (SELECT 1 FROM combined)
        `),
      "userNotifications.notifyCombined",
    );
    const rows = (result as any).rows as Array<Record<string, any>>;
    const r = rows?.[0];
    if (!r) {
      return { status: "race", row: null, unreadCount: 0 };
    }
    if (r.status === "no_user") {
      if (r.user_present === false || r.user_present === "f") {
        return { status: "missing_user", row: null, unreadCount: 0 };
      }
      return { status: "race", row: null, unreadCount: 0 };
    }
    return {
      status: r.status === "inserted" ? "inserted" : "deduped",
      row: rowToUserNotification(r),
      unreadCount: Number(r.unread_count ?? 0),
    };
  });
}

export interface ListUserNotificationsOptions {
  /** When true, archived rows are included; otherwise only non-archived. */
  includeArchived?: boolean;
  /** When set, filter to a single category. */
  category?: string;
  /** When set, filter to a bucket (personal or system). */
  bucket?: NotificationBucket;
  /** When true, only unread rows. */
  unreadOnly?: boolean;
  /** When true, only archived rows. Implies includeArchived=true. */
  archivedOnly?: boolean;
  limit?: number;
  offset?: number;
}

function listConditions(userId: string, opts: ListUserNotificationsOptions) {
  const conditions = [eq(userNotifications.userId, userId)];
  if (opts.archivedOnly) {
    conditions.push(sql`${userNotifications.archivedAt} is not null`);
  } else if (!opts.includeArchived) {
    conditions.push(isNull(userNotifications.archivedAt));
  }
  if (opts.unreadOnly) conditions.push(isNull(userNotifications.readAt));
  if (opts.category) {
    conditions.push(eq(userNotifications.category, opts.category));
  } else if (opts.bucket === "system") {
    conditions.push(
      inArray(userNotifications.category, [...SYSTEM_BUCKET_CATEGORIES]),
    );
  } else if (opts.bucket === "personal") {
    conditions.push(
      notInArray(userNotifications.category, [...SYSTEM_BUCKET_CATEGORIES]),
    );
  }
  return conditions;
}

/** A notification row plus the display-ready client name resolved from
 *  `metadata.clientId` (Task #4472). `clientName` is null when the row
 *  has no clientId in metadata or the referenced client no longer exists. */
export type UserNotificationWithClient = UserNotification & {
  clientName: string | null;
};

export async function listUserNotifications(
  userId: string,
  opts: ListUserNotificationsOptions = {},
): Promise<UserNotificationWithClient[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  return withDbAttribution("userNotifications:list", async () => {
    return dbRetry(
      () =>
        // Task #4472 — resolve the client display name at read time via a
        // single LEFT JOIN on the clients PK (metadata->>'clientId'), so
        // the meta line can show "4m ago · SMS · Harper & Lane" without a
        // per-row lookup (no N+1) and without write-time enrichment that
        // would go stale on client renames.
        getDb()
          .select({
            ...getTableColumns(userNotifications),
            clientName: clients.firmName,
          })
          .from(userNotifications)
          .leftJoin(
            clients,
            sql`${userNotifications.metadata}->>'clientId' = ${clients.id}`,
          )
          .where(and(...listConditions(userId, opts)))
          .orderBy(desc(userNotifications.createdAt))
          .limit(limit)
          .offset(offset),
      "userNotifications.list",
    );
  });
}

/** Total row count matching the same filter set as listUserNotifications.
 *  Used to drive pagination "Next" affordance on the inbox page. */
export async function countUserNotifications(
  userId: string,
  opts: ListUserNotificationsOptions = {},
): Promise<number> {
  return withDbAttribution("userNotifications:listCount", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(userNotifications)
          .where(and(...listConditions(userId, opts))),
      "userNotifications.listCount",
    );
    return Number(row?.count ?? 0);
  });
}

/** Verify that a userId actually corresponds to a row in `users`.
 *  notifyUser() uses this to refuse to write inbox rows for unknown
 *  recipients (a misrouted webhook handler), which would otherwise
 *  silently fail the FK at insert time. */
export async function userExists(userId: string): Promise<boolean> {
  if (!userId) return false;
  return withDbAttribution("userNotifications:userExists", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
      "userNotifications.userExists",
    );
    return !!row;
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return withDbAttribution("userNotifications:unreadCount", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(userNotifications)
          .where(
            and(
              eq(userNotifications.userId, userId),
              isNull(userNotifications.readAt),
              isNull(userNotifications.archivedAt),
            ),
          ),
      "userNotifications.unreadCount",
    );
    return Number(row?.count ?? 0);
  });
}

export interface UnreadCountByBucket {
  personal: number;
  system: number;
  total: number;
}

/** Returns unread counts split by bucket (personal vs system).
 *  Used by the bell badge (personal drives the main red count;
 *  system drives the muted secondary indicator). */
export async function getUnreadCountByBucket(
  userId: string,
): Promise<UnreadCountByBucket> {
  return withDbAttribution("userNotifications:unreadCountByBucket", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select({
            category: userNotifications.category,
            count: sql<number>`count(*)::int`,
          })
          .from(userNotifications)
          .where(
            and(
              eq(userNotifications.userId, userId),
              isNull(userNotifications.readAt),
              isNull(userNotifications.archivedAt),
            ),
          )
          .groupBy(userNotifications.category),
      "userNotifications.unreadCountByBucket",
    );
    let personal = 0;
    let system = 0;
    for (const r of rows) {
      const count = Number(r.count ?? 0);
      if ((SYSTEM_BUCKET_CATEGORIES as readonly string[]).includes(r.category)) {
        system += count;
      } else {
        personal += count;
      }
    }
    return { personal, system, total: personal + system };
  });
}

/** Mark every unread notification in one bucket as read.
 *  Returns the number of rows updated. */
export async function markAllReadBucket(
  userId: string,
  bucket: NotificationBucket,
): Promise<number> {
  return withDbAttribution("userNotifications:markAllReadBucket", async () => {
    const now = new Date();
    const bucketCondition =
      bucket === "system"
        ? inArray(userNotifications.category, [...SYSTEM_BUCKET_CATEGORIES])
        : notInArray(userNotifications.category, [...SYSTEM_BUCKET_CATEGORIES]);
    const res = await getDb()
      .update(userNotifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.archivedAt),
          bucketCondition,
        ),
      )
      .returning({ id: userNotifications.id });
    return res.length;
  });
}

export interface BundledSystemNotification {
  /** All row IDs in this bundle (most-recent first). Used for mark-all-read. */
  ids: string[];
  category: string;
  title: string;
  /** The `metadata.notificationId` grouping key, if present. */
  notificationId: string | null;
  /** Number of rows collapsed into this bundle. */
  count: number;
  /** Timestamp of the most-recent occurrence. */
  latestAt: Date;
  /** True if any row in the bundle is still unread. */
  hasUnread: boolean;
  body: string | null;
  deepLink: string | null;
  /** Task #4512 — display-ready client name resolved from `metadata->>'clientId'`.
   *  Non-null only when EVERY row in the bundle carries the same clientId and
   *  the referenced client still exists; null when mixed or absent. */
  clientName: string | null;
}

/** List system-bucket notifications grouped by (category, notificationId, title).
 *  Repeated alerts from the same source are collapsed into a single entry with
 *  an occurrence count and the latest timestamp, reducing the 99+ badge problem.
 *  Bundling is read-time only — no data is mutated. */
export async function listSystemBundled(
  userId: string,
  opts: { includeArchived?: boolean; limit?: number } = {},
): Promise<BundledSystemNotification[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  return withDbAttribution("userNotifications:listSystemBundled", async () => {
    const archiveClause = opts.includeArchived
      ? sql``
      : sql`AND un.archived_at IS NULL`;
    const result = await dbRetry(
      () =>
        getDb().execute(sql`
          SELECT
            array_agg(un.id::text ORDER BY un.created_at DESC) AS ids,
            un.category,
            un.title,
            un.metadata->>'notificationId' AS notification_id,
            (array_agg(un.body ORDER BY un.created_at DESC))[1] AS body,
            (array_agg(un.deep_link ORDER BY un.created_at DESC))[1] AS deep_link,
            COUNT(*)::int AS count,
            MAX(un.created_at) AS latest_at,
            BOOL_OR(un.read_at IS NULL AND un.archived_at IS NULL) AS has_unread,
            -- Task #4512 — per-bundle client name, resolved via the same
            -- read-time LEFT JOIN as listUserNotifications (no N+1). Only
            -- surfaced when every row in the bundle carries the same
            -- clientId (mixed or partially-absent bundles stay null) and
            -- the referenced client row still exists.
            CASE
              WHEN COUNT(DISTINCT un.metadata->>'clientId') = 1
               AND COUNT(un.metadata->>'clientId') = COUNT(*)
              THEN MAX(c.firm_name)
              ELSE NULL
            END AS client_name
          FROM user_notifications un
          LEFT JOIN clients c ON un.metadata->>'clientId' = c.id
          WHERE un.user_id = ${userId}
            AND un.category = ANY(ARRAY['system','queue_health']::text[])
            ${archiveClause}
          GROUP BY un.category, un.metadata->>'notificationId', un.title
          ORDER BY MAX(un.created_at) DESC
          LIMIT ${limit}
        `),
      "userNotifications.listSystemBundled",
    );
    const rows = (result as any).rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ids: Array.isArray(r.ids) ? (r.ids as string[]) : [],
      category: String(r.category ?? ""),
      title: String(r.title ?? ""),
      notificationId: r.notification_id ? String(r.notification_id) : null,
      count: Number(r.count ?? 1),
      latestAt: r.latest_at ? new Date(String(r.latest_at)) : new Date(),
      hasUnread: r.has_unread === true || r.has_unread === "t",
      body: r.body ? String(r.body) : null,
      deepLink: r.deep_link ? String(r.deep_link) : null,
      clientName: r.client_name ? String(r.client_name) : null,
    }));
  });
}

/** Mark all notifications in a bundled system group as read.
 *  Accepts an array of notification IDs (the `ids` from BundledSystemNotification). */
export async function markBundleRead(
  userId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  return withDbAttribution("userNotifications:markBundleRead", async () => {
    const now = new Date();
    const res = await getDb()
      .update(userNotifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(userNotifications.userId, userId),
          inArray(userNotifications.id, ids),
          isNull(userNotifications.readAt),
        ),
      )
      .returning({ id: userNotifications.id });
    return res.length;
  });
}

/** Mark one notification read. Returns the updated row, or undefined if
 *  no row matched (e.g. wrong owner). Owner-scoped by `userId`. */
export async function markRead(
  userId: string,
  id: string,
): Promise<UserNotification | undefined> {
  return withDbAttribution("userNotifications:markRead", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(userNotifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(userNotifications.id, id),
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
        ),
      )
      .returning();
    return row;
  });
}

/** Mark one notification unread (clears `readAt`). Owner-scoped. */
export async function markUnread(
  userId: string,
  id: string,
): Promise<UserNotification | undefined> {
  return withDbAttribution("userNotifications:markUnread", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(userNotifications)
      .set({ readAt: null, updatedAt: now })
      .where(
        and(
          eq(userNotifications.id, id),
          eq(userNotifications.userId, userId),
          isNull(userNotifications.archivedAt),
        ),
      )
      .returning();
    return row;
  });
}

/** Mark every unread notification for the user as read. Returns the
 *  number of rows updated. */
export async function markAllRead(userId: string): Promise<number> {
  return withDbAttribution("userNotifications:markAllRead", async () => {
    const now = new Date();
    const res = await getDb()
      .update(userNotifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.archivedAt),
        ),
      )
      .returning({ id: userNotifications.id });
    return res.length;
  });
}

export async function archiveNotification(
  userId: string,
  id: string,
): Promise<UserNotification | undefined> {
  return withDbAttribution("userNotifications:archive", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(userNotifications)
      .set({
        archivedAt: now,
        // Archiving implies read; many UIs use "archive" as the
        // dismiss/clear action.
        readAt: sql`COALESCE(${userNotifications.readAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(userNotifications.id, id),
          eq(userNotifications.userId, userId),
        ),
      )
      .returning();
    return row;
  });
}
