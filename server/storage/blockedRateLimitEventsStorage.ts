import { db } from "../db";
import {
  blockedRateLimitEvents,
  type BlockedRateLimitEventRecord,
  type InsertBlockedRateLimitEvent,
} from "@shared/schema";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";

export async function ensureBlockedRateLimitEventsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "blocked_rate_limit_events" (
      "id" serial PRIMARY KEY NOT NULL,
      "timestamp" bigint NOT NULL,
      "category" varchar(128) NOT NULL,
      "method" varchar(16) NOT NULL,
      "path" text NOT NULL,
      "ip" varchar(64) NOT NULL,
      "user_id" varchar(128)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "blocked_rate_limit_events_timestamp_idx"
      ON "blocked_rate_limit_events" ("timestamp")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "blocked_rate_limit_events_user_timestamp_idx"
      ON "blocked_rate_limit_events" ("user_id", "timestamp")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "blocked_rate_limit_events_ip_timestamp_idx"
      ON "blocked_rate_limit_events" ("ip", "timestamp")
  `);
}

export async function insertBlockedRateLimitEvent(
  record: InsertBlockedRateLimitEvent,
): Promise<void> {
  await db.insert(blockedRateLimitEvents).values(record);
}

export async function* iterateUserBlockedRateLimitEvents(
  userId: string,
  rangeStart: number | null,
  rangeEnd: number | null,
  pageSize: number = 1000,
): AsyncIterableIterator<BlockedRateLimitEventRecord> {
  let lastTs = -1;
  let lastId = -1;
  while (true) {
    const conditions = [eq(blockedRateLimitEvents.userId, userId)];
    if (rangeStart !== null) conditions.push(gte(blockedRateLimitEvents.timestamp, rangeStart));
    if (rangeEnd !== null) conditions.push(lte(blockedRateLimitEvents.timestamp, rangeEnd));
    if (lastTs >= 0) {
      conditions.push(
        sql`(${blockedRateLimitEvents.timestamp}, ${blockedRateLimitEvents.id}) > (${lastTs}, ${lastId})`,
      );
    }
    const rows = await db
      .select()
      .from(blockedRateLimitEvents)
      .where(and(...conditions))
      .orderBy(asc(blockedRateLimitEvents.timestamp), asc(blockedRateLimitEvents.id))
      .limit(pageSize);
    if (rows.length === 0) return;
    for (const row of rows) {
      yield row;
    }
    const last = rows[rows.length - 1];
    lastTs = last.timestamp;
    lastId = last.id;
    if (rows.length < pageSize) return;
  }
}

export async function loadRecentBlockedRateLimitEvents(
  sinceTimestamp: number,
  maxRows: number = 5000,
): Promise<BlockedRateLimitEventRecord[]> {
  const rows = await db
    .select()
    .from(blockedRateLimitEvents)
    .where(gte(blockedRateLimitEvents.timestamp, sinceTimestamp))
    .orderBy(desc(blockedRateLimitEvents.timestamp))
    .limit(maxRows);
  return rows.reverse();
}

export async function countBlockedRateLimitEventsOlderThan(cutoffTimestamp: number): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blockedRateLimitEvents)
    .where(lt(blockedRateLimitEvents.timestamp, cutoffTimestamp));
  return result[0]?.count ?? 0;
}

export async function pruneBlockedRateLimitEventsOlderThan(cutoffTimestamp: number): Promise<number> {
  const rows = await db
    .delete(blockedRateLimitEvents)
    .where(lt(blockedRateLimitEvents.timestamp, cutoffTimestamp))
    .returning({ id: blockedRateLimitEvents.id });
  return rows.length;
}

export async function countBlockedRateLimitEvents(): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blockedRateLimitEvents);
  return result[0]?.count ?? 0;
}

export interface BlockedRateLimitEventFilters {
  userId?: string | null;
  ip?: string | null;
  category?: string | null;
  rangeStart?: number | null;
  rangeEnd?: number | null;
}

export interface ListBlockedRateLimitEventsResult {
  rows: BlockedRateLimitEventRecord[];
  total: number;
}

function buildFilterConditions(filters: BlockedRateLimitEventFilters) {
  const conditions = [] as ReturnType<typeof eq>[];
  if (filters.userId) conditions.push(eq(blockedRateLimitEvents.userId, filters.userId));
  if (filters.ip) conditions.push(eq(blockedRateLimitEvents.ip, filters.ip));
  if (filters.category) conditions.push(eq(blockedRateLimitEvents.category, filters.category));
  if (filters.rangeStart !== null && filters.rangeStart !== undefined) {
    conditions.push(gte(blockedRateLimitEvents.timestamp, filters.rangeStart));
  }
  if (filters.rangeEnd !== null && filters.rangeEnd !== undefined) {
    conditions.push(lte(blockedRateLimitEvents.timestamp, filters.rangeEnd));
  }
  return conditions;
}

export async function listBlockedRateLimitEvents(
  filters: BlockedRateLimitEventFilters,
  limit: number,
  offset: number,
): Promise<ListBlockedRateLimitEventsResult> {
  const conditions = buildFilterConditions(filters);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rowsQuery = db
    .select()
    .from(blockedRateLimitEvents)
    .orderBy(desc(blockedRateLimitEvents.timestamp), desc(blockedRateLimitEvents.id))
    .limit(limit)
    .offset(offset);

  const countQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(blockedRateLimitEvents);

  const [rows, countResult] = await Promise.all([
    whereClause ? rowsQuery.where(whereClause) : rowsQuery,
    whereClause ? countQuery.where(whereClause) : countQuery,
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function* iterateBlockedRateLimitEvents(
  filters: BlockedRateLimitEventFilters,
  pageSize: number = 1000,
): AsyncIterableIterator<BlockedRateLimitEventRecord> {
  let lastTs = -1;
  let lastId = -1;
  while (true) {
    const conditions = buildFilterConditions(filters);
    if (lastTs >= 0) {
      conditions.push(
        sql`(${blockedRateLimitEvents.timestamp}, ${blockedRateLimitEvents.id}) > (${lastTs}, ${lastId})`,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = db
      .select()
      .from(blockedRateLimitEvents)
      .orderBy(asc(blockedRateLimitEvents.timestamp), asc(blockedRateLimitEvents.id))
      .limit(pageSize);
    const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery);
    if (rows.length === 0) return;
    for (const row of rows) {
      yield row;
    }
    const last = rows[rows.length - 1];
    lastTs = last.timestamp;
    lastId = last.id;
    if (rows.length < pageSize) return;
  }
}

export async function listDistinctBlockedRateLimitCategories(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: blockedRateLimitEvents.category })
    .from(blockedRateLimitEvents);
  return rows.map((r) => r.category).sort();
}
