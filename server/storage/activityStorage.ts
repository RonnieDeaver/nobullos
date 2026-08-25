// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type UserActivityLog, type InsertUserActivityLog, userActivityLogs,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { eq, and, gte, lte, desc, sql, count, inArray, isNull } from "drizzle-orm";
import { users } from "@shared/models/auth";
import { bindArrayParam } from "../utils/sqlArray";

type InsertActivityLogsFn = (events: InsertUserActivityLog[]) => Promise<void>;
let insertActivityLogsOverride: InsertActivityLogsFn | null = null;

// Test-only seam (Task #1189) so route-level tests can simulate a logging
// failure without taking down the real `user_activity_logs` table. Production
// code paths never set this; null restores the default DB-backed insert.
export function __test_setInsertActivityLogsOverride(fn: InsertActivityLogsFn | null): void {
  insertActivityLogsOverride = fn;
}

export async function insertActivityLogs(events: InsertUserActivityLog[]): Promise<void> {
  if (events.length === 0) return;
  if (insertActivityLogsOverride) {
    await insertActivityLogsOverride(events);
    return;
  }
  await getDb().transaction(async (tx) => {
    await tx.insert(userActivityLogs).values(events);
  });
}

export async function getActivityLogs(filters: {
  userId?: string;
  systemOnly?: boolean;
  actionType?: string;
  actionTypes?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
  requireMetadataLastError?: boolean;
}): Promise<{ data: (UserActivityLog & { userName?: string })[]; total: number }> {
  const conditions = [];
  if (filters.systemOnly) {
    conditions.push(isNull(userActivityLogs.userId));
  } else if (filters.userId) {
    conditions.push(eq(userActivityLogs.userId, filters.userId));
  }
  if (filters.actionType) conditions.push(eq(userActivityLogs.actionType, filters.actionType));
  if (filters.actionTypes && filters.actionTypes.length > 0) conditions.push(inArray(userActivityLogs.actionType, filters.actionTypes));
  if (filters.dateFrom) conditions.push(gte(userActivityLogs.timestamp, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(userActivityLogs.timestamp, filters.dateTo));
  if (filters.requireMetadataLastError) {
    conditions.push(
      sql`${userActivityLogs.metadata} ? 'lastError' AND ${userActivityLogs.metadata}->>'lastError' IS NOT NULL`,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await getDb()
    .select({ value: count() })
    .from(userActivityLogs)
    .where(whereClause);

  const rows = await getDb()
    .select({
      id: userActivityLogs.id,
      userId: userActivityLogs.userId,
      actionType: userActivityLogs.actionType,
      route: userActivityLogs.route,
      actionDetail: userActivityLogs.actionDetail,
      metadata: userActivityLogs.metadata,
      sessionId: userActivityLogs.sessionId,
      duration: userActivityLogs.duration,
      timestamp: userActivityLogs.timestamp,
      userFirstName: users.firstName,
      userLastName: users.lastName,
    })
    .from(userActivityLogs)
    .leftJoin(users, eq(userActivityLogs.userId, users.id))
    .where(whereClause)
    .orderBy(desc(userActivityLogs.timestamp))
    .limit(filters.limit || 100)
    .offset(filters.offset || 0);

  const data = rows.map((r: typeof rows[number]) => ({
    id: r.id,
    userId: r.userId,
    actionType: r.actionType,
    route: r.route,
    actionDetail: r.actionDetail,
    metadata: r.metadata,
    sessionId: r.sessionId,
    duration: r.duration,
    timestamp: r.timestamp,
    userName: [r.userFirstName, r.userLastName].filter(Boolean).join(" ") || undefined,
  }));

  return { data, total: countResult.value };
}

export async function getActivityLogsByIds(ids: string[]): Promise<(UserActivityLog & { userName?: string })[]> {
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({
      id: userActivityLogs.id,
      userId: userActivityLogs.userId,
      actionType: userActivityLogs.actionType,
      route: userActivityLogs.route,
      actionDetail: userActivityLogs.actionDetail,
      metadata: userActivityLogs.metadata,
      sessionId: userActivityLogs.sessionId,
      duration: userActivityLogs.duration,
      timestamp: userActivityLogs.timestamp,
      userFirstName: users.firstName,
      userLastName: users.lastName,
    })
    .from(userActivityLogs)
    .leftJoin(users, eq(userActivityLogs.userId, users.id))
    .where(inArray(userActivityLogs.id, ids))
    .orderBy(desc(userActivityLogs.timestamp));

  return rows.map((r: typeof rows[number]) => ({
    id: r.id,
    userId: r.userId,
    actionType: r.actionType,
    route: r.route,
    actionDetail: r.actionDetail,
    metadata: r.metadata,
    sessionId: r.sessionId,
    duration: r.duration,
    timestamp: r.timestamp,
    userName: [r.userFirstName, r.userLastName].filter(Boolean).join(" ") || undefined,
  }));
}

// Task #1912 — Returns the delete/restore audit timeline for one or more
// target users by scanning `user_activity_logs` for `user_deleted` /
// `user_restored` rows whose metadata names the target. The rows already
// carry the actor (`userId`), prior email, and timestamp; we left-join
// `users` for the actor display name. Returned events are sorted newest
// first per target so callers can grab `[0]` as the latest event.
export type DeleteRestoreEvent = {
  id: string;
  actionType: "user_deleted" | "user_restored";
  actorId: string | null;
  actorName: string | null;
  timestamp: Date;
  priorEmail: string | null;
};

export async function getUserDeleteRestoreHistory(
  targetUserIds: string[],
): Promise<Record<string, DeleteRestoreEvent[]>> {
  const result: Record<string, DeleteRestoreEvent[]> = {};
  if (targetUserIds.length === 0) return result;
  const rows = await withDbAttribution("activity:getUserDeleteRestoreHistory", () =>
    getDb()
    .select({
      id: userActivityLogs.id,
      actionType: userActivityLogs.actionType,
      actorId: userActivityLogs.userId,
      metadata: userActivityLogs.metadata,
      timestamp: userActivityLogs.timestamp,
      actorFirstName: users.firstName,
      actorLastName: users.lastName,
      actorEmail: users.email,
    })
    .from(userActivityLogs)
    .leftJoin(users, eq(userActivityLogs.userId, users.id))
    .where(
      and(
        inArray(userActivityLogs.actionType, ["user_deleted", "user_restored"]),
        sql`${userActivityLogs.metadata}->>'targetUserId' = ANY(${bindArrayParam(targetUserIds, "text")})`,
      ),
    )
    .orderBy(desc(userActivityLogs.timestamp))
  );

  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, any>;
    const targetId = typeof meta.targetUserId === "string" ? meta.targetUserId : null;
    if (!targetId) continue;
    const actorName =
      [r.actorFirstName, r.actorLastName].filter(Boolean).join(" ") ||
      r.actorEmail ||
      null;
    const event: DeleteRestoreEvent = {
      id: r.id,
      actionType: r.actionType as "user_deleted" | "user_restored",
      actorId: r.actorId,
      actorName,
      timestamp: r.timestamp,
      priorEmail: typeof meta.priorEmail === "string" ? meta.priorEmail : null,
    };
    (result[targetId] ??= []).push(event);
  }
  return result;
}

// Task #1950 — Reassignment history for one or more "from" users.
// Scans `user_activity_logs` for `user_work_reassigned` rows whose
// metadata names the source user (`fromUserId`), so the deleted-users
// panel can show "On <date>, Sam's 12 clients moved to Alex" with the
// actual client names / thread keys / meeting ids expandable. Returned
// events are newest-first per from-user.
export type ReassignmentEvent = {
  id: string;
  actorId: string | null;
  actorName: string | null;
  timestamp: Date;
  fromUserId: string;
  fromUserName: string | null;
  toUserId: string;
  toUserName: string | null;
  counts: { clients: number; threads: number; bookings: number };
  items: {
    clients: { id: string; label: string }[];
    threads: { threadKey: string }[];
    bookings: { id: string; label: string; startTimeUtc: string }[];
  };
};

// Task #1981 — the same audit rows can be keyed either by the source user
// ("out" — what this user shed) or the destination user ("in" — what this
// user inherited). Both directions share one row-mapper; only the metadata
// key used for filtering and bucketing differs.
type ReassignmentDirection = "out" | "in";

function mapReassignmentRow(r: {
  id: string;
  actorId: string | null;
  metadata: unknown;
  timestamp: Date;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorEmail: string | null;
}): ReassignmentEvent | null {
  const meta = (r.metadata ?? {}) as Record<string, any>;
  const fromId = typeof meta.fromUserId === "string" ? meta.fromUserId : null;
  const actorName =
    [r.actorFirstName, r.actorLastName].filter(Boolean).join(" ") ||
    r.actorEmail ||
    null;
  const rawCounts = (meta.counts ?? {}) as Record<string, any>;
  const rawItems = (meta.items ?? {}) as Record<string, any>;
  return {
    id: r.id,
    actorId: r.actorId,
    actorName,
    timestamp: r.timestamp,
    fromUserId: fromId ?? "",
    fromUserName: typeof meta.fromUserName === "string" ? meta.fromUserName : null,
    toUserId: typeof meta.toUserId === "string" ? meta.toUserId : "",
    toUserName: typeof meta.toUserName === "string" ? meta.toUserName : null,
    counts: {
      clients: Number(rawCounts.clients) || 0,
      threads: Number(rawCounts.threads) || 0,
      bookings: Number(rawCounts.bookings) || 0,
    },
    items: {
      clients: Array.isArray(rawItems.clients) ? rawItems.clients : [],
      threads: Array.isArray(rawItems.threads) ? rawItems.threads : [],
      bookings: Array.isArray(rawItems.bookings) ? rawItems.bookings : [],
    },
  };
}

async function getReassignmentHistoryByDirection(
  userIds: string[],
  direction: ReassignmentDirection,
): Promise<Record<string, ReassignmentEvent[]>> {
  const result: Record<string, ReassignmentEvent[]> = {};
  if (userIds.length === 0) return result;
  const metaKey = direction === "out" ? "fromUserId" : "toUserId";
  const rows = await withDbAttribution("activity:getUserReassignmentHistory", () =>
    getDb()
      .select({
        id: userActivityLogs.id,
        actorId: userActivityLogs.userId,
        metadata: userActivityLogs.metadata,
        timestamp: userActivityLogs.timestamp,
        actorFirstName: users.firstName,
        actorLastName: users.lastName,
        actorEmail: users.email,
      })
      .from(userActivityLogs)
      .leftJoin(users, eq(userActivityLogs.userId, users.id))
      .where(
        and(
          eq(userActivityLogs.actionType, "user_work_reassigned"),
          sql`${userActivityLogs.metadata}->>${metaKey} = ANY(${bindArrayParam(userIds, "text")})`,
        ),
      )
      .orderBy(desc(userActivityLogs.timestamp)),
  );

  for (const r of rows) {
    const event = mapReassignmentRow(r);
    if (!event) continue;
    const bucketId = direction === "out" ? event.fromUserId : event.toUserId;
    if (!bucketId) continue;
    (result[bucketId] ??= []).push(event);
  }
  return result;
}

// Keyed by the *source* user id — "what each user shed".
export async function getUserReassignmentHistory(
  fromUserIds: string[],
): Promise<Record<string, ReassignmentEvent[]>> {
  return getReassignmentHistoryByDirection(fromUserIds, "out");
}

// Task #1981 — keyed by the *destination* user id — "what each user
// inherited". Lets the active-user panel show inbound reassignments.
export async function getUserInboundReassignmentHistory(
  toUserIds: string[],
): Promise<Record<string, ReassignmentEvent[]>> {
  return getReassignmentHistoryByDirection(toUserIds, "in");
}

// Task #1941 — Generic entity-audit history. Mirrors the Task #1912
// `getUserDeleteRestoreHistory` shape but is parameterized by entity
// type so client + product (and future entities) can share one
// endpoint and one frontend popover. Returns events newest-first per
// target id.
export type EntityAuditEntity = "client" | "product";

export type EntityAuditEvent = {
  id: string;
  actionType: string;
  actorId: string | null;
  actorName: string | null;
  timestamp: Date;
  actionDetail: string | null;
  metadata: Record<string, any> | null;
};

const ENTITY_ACTION_TYPES: Record<EntityAuditEntity, string[]> = {
  client: [
    "client_created",
    "client_updated",
    "client_deleted",
    // Task #3711 — offboarding lifecycle rows (scheduled/rescheduled/
    // cancelled by an operator; completed by the sweep's system actor) show
    // up in the client History popover alongside the CRUD events.
    "client_offboarding_scheduled",
    "client_offboarding_rescheduled",
    "client_offboarding_cancelled",
    "client_offboarding_completed",
  ],
  product: ["product_added", "product_removed"],
};

const ENTITY_METADATA_KEY: Record<EntityAuditEntity, string> = {
  client: "clientId",
  product: "clientId",
};

export async function getEntityAuditHistory(
  entity: EntityAuditEntity,
  ids: string[],
): Promise<Record<string, EntityAuditEvent[]>> {
  const result: Record<string, EntityAuditEvent[]> = {};
  if (ids.length === 0) return result;
  const actionTypes = ENTITY_ACTION_TYPES[entity];
  const metadataKey = ENTITY_METADATA_KEY[entity];
  const rows = await withDbAttribution("activity:getEntityAuditHistory", () =>
    getDb()
      .select({
        id: userActivityLogs.id,
        actionType: userActivityLogs.actionType,
        actorId: userActivityLogs.userId,
        actionDetail: userActivityLogs.actionDetail,
        metadata: userActivityLogs.metadata,
        timestamp: userActivityLogs.timestamp,
        actorFirstName: users.firstName,
        actorLastName: users.lastName,
        actorEmail: users.email,
      })
      .from(userActivityLogs)
      .leftJoin(users, eq(userActivityLogs.userId, users.id))
      .where(
        and(
          inArray(userActivityLogs.actionType, actionTypes),
          sql`${userActivityLogs.metadata}->>${sql.raw(`'${metadataKey}'`)} = ANY(${bindArrayParam(ids, "text")})`,
        ),
      )
      .orderBy(desc(userActivityLogs.timestamp)),
  );

  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, any>;
    const targetId = typeof meta[metadataKey] === "string" ? meta[metadataKey] : null;
    if (!targetId) continue;
    const actorName =
      [r.actorFirstName, r.actorLastName].filter(Boolean).join(" ") ||
      r.actorEmail ||
      null;
    // For product entity, the per-product bucket key is `${clientId}:${product}`.
    const bucketKey =
      entity === "product" && typeof meta.product === "string"
        ? `${targetId}:${meta.product}`
        : targetId;
    const event: EntityAuditEvent = {
      id: r.id,
      actionType: r.actionType,
      actorId: r.actorId,
      actorName,
      timestamp: r.timestamp,
      actionDetail: r.actionDetail,
      metadata: meta,
    };
    (result[bucketKey] ??= []).push(event);
  }
  return result;
}

export async function getActivityStats(dateFrom?: Date, dateTo?: Date): Promise<{
  activeUsersToday: number;
  totalEventsToday: number;
  topPages: { route: string; count: number }[];
  topActions: { actionType: string; count: number }[];
  avgSessionDuration: number;
}> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const rangeStart = dateFrom || todayStart;
  const rangeEnd = dateTo || new Date();

  const rangeConds = [gte(userActivityLogs.timestamp, rangeStart), lte(userActivityLogs.timestamp, rangeEnd)];

  const [activeUsers] = await getDb()
    .select({ value: sql<number>`count(distinct ${userActivityLogs.userId})` })
    .from(userActivityLogs)
    .where(and(...rangeConds));

  const [totalEvents] = await getDb()
    .select({ value: count() })
    .from(userActivityLogs)
    .where(and(...rangeConds));

  const topPages = await getDb()
    .select({
      route: userActivityLogs.route,
      count: sql<number>`count(*)::int`,
    })
    .from(userActivityLogs)
    .where(and(
      eq(userActivityLogs.actionType, "page_view"),
      gte(userActivityLogs.timestamp, rangeStart),
      lte(userActivityLogs.timestamp, rangeEnd),
    ))
    .groupBy(userActivityLogs.route)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  const topActions = await getDb()
    .select({
      actionType: userActivityLogs.actionType,
      count: sql<number>`count(*)::int`,
    })
    .from(userActivityLogs)
    .where(and(
      gte(userActivityLogs.timestamp, rangeStart),
      lte(userActivityLogs.timestamp, rangeEnd),
    ))
    .groupBy(userActivityLogs.actionType)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  const [avgDuration] = await getDb()
    .select({ value: sql<number>`coalesce(avg(${userActivityLogs.duration}), 0)::int` })
    .from(userActivityLogs)
    .where(and(
      eq(userActivityLogs.actionType, "page_view"),
      gte(userActivityLogs.timestamp, rangeStart),
      lte(userActivityLogs.timestamp, rangeEnd),
      sql`${userActivityLogs.duration} > 0`,
    ));

  return {
    activeUsersToday: Number(activeUsers.value) || 0,
    totalEventsToday: Number(totalEvents.value) || 0,
    topPages: topPages.filter((p: { route: string | null; count: number }) => p.route) as { route: string; count: number }[],
    topActions: topActions as { actionType: string; count: number }[],
    avgSessionDuration: Number(avgDuration.value) || 0,
  };
}
