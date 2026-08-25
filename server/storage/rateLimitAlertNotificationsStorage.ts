import { db } from "../db";
import {
  rateLimitAlertNotifications,
  type InsertRateLimitAlertNotification,
  type RateLimitAlertNotification,
} from "@shared/schema";
import { and, desc, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";

let tableReady: Promise<void> | null = null;

export async function ensureRateLimitAlertNotificationsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "rate_limit_alert_notifications" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "channel" varchar(16) NOT NULL,
          "destination" text NOT NULL,
          "status" varchar(16) NOT NULL,
          "error_message" text,
          "user_id" varchar,
          "user_label" text,
          "category" varchar(64) NOT NULL,
          "count" integer NOT NULL,
          "max_requests" integer NOT NULL,
          "warning_percent" integer NOT NULL,
          "window_ms" bigint NOT NULL,
          "window_start" bigint NOT NULL,
          "triggered_at" bigint NOT NULL,
          "attempted_at" bigint NOT NULL,
          "alert" jsonb,
          "trigger_source" varchar(16) NOT NULL DEFAULT 'scheduled',
          "trigger_actor_id" varchar
        )
      `);
      await db.execute(sql`
        ALTER TABLE "rate_limit_alert_notifications"
          ADD COLUMN IF NOT EXISTS "trigger_source" varchar(16) NOT NULL DEFAULT 'scheduled'
      `);
      await db.execute(sql`
        ALTER TABLE "rate_limit_alert_notifications"
          ADD COLUMN IF NOT EXISTS "trigger_actor_id" varchar
      `);
      await db.execute(sql`
        ALTER TABLE "rate_limit_alert_notifications"
          ADD COLUMN IF NOT EXISTS "latency_ms" integer
      `);
      await db.execute(sql`
        ALTER TABLE "rate_limit_alert_notifications"
          ADD COLUMN IF NOT EXISTS "attempt_number" integer NOT NULL DEFAULT 1
      `);
      await db.execute(sql`
        ALTER TABLE "rate_limit_alert_notifications"
          ADD COLUMN IF NOT EXISTS "parent_notification_id" varchar
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "rate_limit_alert_notifications_attempted_at_idx"
          ON "rate_limit_alert_notifications" ("attempted_at" DESC)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "rate_limit_alert_notifications_parent_idx"
          ON "rate_limit_alert_notifications" ("parent_notification_id")
      `);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

export async function insertRateLimitAlertNotification(
  data: InsertRateLimitAlertNotification,
): Promise<RateLimitAlertNotification> {
  await ensureRateLimitAlertNotificationsTable();
  const [row] = await db.insert(rateLimitAlertNotifications).values(data).returning();
  return row;
}

export type RateLimitAlertNotificationFilters = {
  status?: string;
  channel?: string;
  category?: string;
  search?: string;
  triggerSource?: string;
  startMs?: number;
  endMs?: number;
  // Task #1251: when non-empty, restrict results to rows whose chain root
  // (id itself OR parent_notification_id) is in this set. Used to filter
  // notification history down to chains that hit the auto-retry cap.
  chainRootIds?: string[];
};

function buildAlertNotificationWhere(
  filters: RateLimitAlertNotificationFilters,
): SQL | undefined {
  const conds: SQL[] = [];
  if (filters.status) conds.push(eq(rateLimitAlertNotifications.status, filters.status));
  if (filters.channel) conds.push(eq(rateLimitAlertNotifications.channel, filters.channel));
  if (filters.category) conds.push(eq(rateLimitAlertNotifications.category, filters.category));
  if (filters.triggerSource) {
    conds.push(eq(rateLimitAlertNotifications.triggerSource, filters.triggerSource));
  }
  if (typeof filters.startMs === "number" && Number.isFinite(filters.startMs)) {
    conds.push(gte(rateLimitAlertNotifications.attemptedAt, filters.startMs));
  }
  if (typeof filters.endMs === "number" && Number.isFinite(filters.endMs)) {
    conds.push(lte(rateLimitAlertNotifications.attemptedAt, filters.endMs));
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const searchCond = or(
      ilike(rateLimitAlertNotifications.destination, pattern),
      ilike(rateLimitAlertNotifications.userLabel, pattern),
      ilike(rateLimitAlertNotifications.userId, pattern),
      ilike(rateLimitAlertNotifications.category, pattern),
    );
    if (searchCond) conds.push(searchCond);
  }
  if (filters.chainRootIds && filters.chainRootIds.length > 0) {
    // A row "belongs to" a chain root if its own id is the root (attempt #1
    // row) or its parent_notification_id points at the root (descendants).
    const rootCond = or(
      inArray(rateLimitAlertNotifications.id, filters.chainRootIds),
      inArray(
        rateLimitAlertNotifications.parentNotificationId,
        filters.chainRootIds,
      ),
    );
    if (rootCond) conds.push(rootCond);
  }
  if (conds.length === 0) return undefined;
  if (conds.length === 1) return conds[0];
  return and(...conds);
}

export async function listRecentRateLimitAlertNotifications(
  limit = 50,
  filters: RateLimitAlertNotificationFilters = {},
): Promise<(RateLimitAlertNotification & { hasChildren: boolean })[]> {
  await ensureRateLimitAlertNotificationsTable();
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const where = buildAlertNotificationWhere(filters);
  const base = db.select().from(rateLimitAlertNotifications);
  const filtered = where ? base.where(where) : base;
  const rows = await filtered
    .orderBy(desc(rateLimitAlertNotifications.attemptedAt))
    .limit(safeLimit);
  if (rows.length === 0) return [];
  // Single grouped query to find which of the returned ids have at least
  // one descendant in the chain (i.e. appears as parent_notification_id
  // on some other row). Lets the UI render the chain expander on the
  // originating attempt #1 row too, not just on retries.
  const ids = rows.map((r) => r.id);
  const childRows = await db
    .selectDistinct({ parent: rateLimitAlertNotifications.parentNotificationId })
    .from(rateLimitAlertNotifications)
    .where(inArray(rateLimitAlertNotifications.parentNotificationId, ids));
  const parentsWithChildren = new Set(
    childRows.map((r) => r.parent).filter((p): p is string => !!p),
  );
  return rows.map((r) => ({ ...r, hasChildren: parentsWithChildren.has(r.id) }));
}

// Export-oriented variant. Hard ceiling protects against a runaway pull;
// admins can choose a smaller cap for a faster file.
export const ALERT_NOTIFICATION_EXPORT_HARD_CEILING = 100_000;
export const ALERT_NOTIFICATION_EXPORT_DEFAULT_LIMIT = 5_000;

export async function getRateLimitAlertNotification(
  id: string,
): Promise<RateLimitAlertNotification | null> {
  await ensureRateLimitAlertNotificationsTable();
  const [row] = await db
    .select()
    .from(rateLimitAlertNotifications)
    .where(eq(rateLimitAlertNotifications.id, id))
    .limit(1);
  return row ?? null;
}

// Returns every row in a retry chain, ordered by attemptNumber ASC then
// attemptedAt ASC. Accepts either the chain root id or any descendant id;
// if a descendant is supplied we follow its parentNotificationId to the
// root and return the chain from that root. Returns an empty array if the
// supplied id does not exist.
export async function getNotificationChain(
  notificationId: string,
): Promise<RateLimitAlertNotification[]> {
  await ensureRateLimitAlertNotificationsTable();
  const seed = await getRateLimitAlertNotification(notificationId);
  if (!seed) return [];
  const rootId = seed.parentNotificationId ?? seed.id;
  const rows = await db
    .select()
    .from(rateLimitAlertNotifications)
    .where(
      or(
        eq(rateLimitAlertNotifications.id, rootId),
        eq(rateLimitAlertNotifications.parentNotificationId, rootId),
      )!,
    );
  return rows.sort((a, b) => {
    const an = a.attemptNumber ?? 1;
    const bn = b.attemptNumber ?? 1;
    if (an !== bn) return an - bn;
    return Number(a.attemptedAt) - Number(b.attemptedAt);
  });
}

// Returns the highest attempt number recorded for a given retry chain
// (root notification id + destination), so the canonical resend path can
// stamp the new row with attemptNumber = max + 1.
export async function getMaxAttemptForChain(
  rootId: string,
  destination: string,
): Promise<number> {
  await ensureRateLimitAlertNotificationsTable();
  const [row] = await db
    .select({
      max: sql<number>`COALESCE(MAX(${rateLimitAlertNotifications.attemptNumber}), 0)`,
    })
    .from(rateLimitAlertNotifications)
    .where(
      and(
        or(
          eq(rateLimitAlertNotifications.id, rootId),
          eq(rateLimitAlertNotifications.parentNotificationId, rootId),
        )!,
        eq(rateLimitAlertNotifications.destination, destination),
      ),
    );
  return Number(row?.max ?? 0);
}

// Returns the most recent (parent + destination)-keyed attempt for any of
// the supplied root ids. Used by the auto-retry pass to dedupe — if the
// latest attempt in a chain has already succeeded, was just retried, or
// has reached the attempt cap, the pass should skip it.
export type LatestAttemptByChain = {
  rootId: string;
  destination: string;
  status: string;
  attemptNumber: number;
  attemptedAt: number;
};
export async function getLatestAttemptsForChains(
  rootIds: string[],
): Promise<LatestAttemptByChain[]> {
  if (rootIds.length === 0) return [];
  await ensureRateLimitAlertNotificationsTable();
  const rows = await db
    .select({
      id: rateLimitAlertNotifications.id,
      parent: rateLimitAlertNotifications.parentNotificationId,
      destination: rateLimitAlertNotifications.destination,
      status: rateLimitAlertNotifications.status,
      attemptNumber: rateLimitAlertNotifications.attemptNumber,
      attemptedAt: rateLimitAlertNotifications.attemptedAt,
    })
    .from(rateLimitAlertNotifications)
    .where(
      or(
        inArray(rateLimitAlertNotifications.id, rootIds),
        inArray(rateLimitAlertNotifications.parentNotificationId, rootIds),
      )!,
    );
  const latest = new Map<string, LatestAttemptByChain>();
  for (const r of rows) {
    const root = r.parent ?? r.id;
    const key = `${root}::${r.destination}`;
    const ts = Number(r.attemptedAt);
    const cur = latest.get(key);
    if (!cur || ts > cur.attemptedAt) {
      latest.set(key, {
        rootId: root,
        destination: r.destination,
        status: r.status,
        attemptNumber: r.attemptNumber,
        attemptedAt: ts,
      });
    }
  }
  return Array.from(latest.values());
}

// Task #1251: returns the distinct chain root ids whose most-recent attempt
// is `failed` AND whose attempt_number has reached the auto-retry cap. Used
// by the notification history UI to (a) compute a per-row "Exhausted" badge
// and (b) drive the "Exhausted only" quick-filter. Computed via a window
// function so we get exactly one "latest" row per (chain root, destination)
// without pulling the whole table into Node.
export async function listExhaustedChainRootIds(
  maxAttempts: number,
): Promise<string[]> {
  await ensureRateLimitAlertNotificationsTable();
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) return [];
  const result: any = await db.execute(sql`
    WITH ranked AS (
      SELECT
        COALESCE("parent_notification_id", "id") AS root_id,
        "destination",
        "status",
        "attempt_number",
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE("parent_notification_id", "id"), "destination"
          ORDER BY "attempted_at" DESC
        ) AS rn
      FROM "rate_limit_alert_notifications"
    )
    SELECT DISTINCT root_id
    FROM ranked
    WHERE rn = 1
      AND "status" = 'failed'
      AND "attempt_number" >= ${maxAttempts}
  `);
  const rows = (result?.rows ?? result ?? []) as Array<{ root_id?: string | null }>;
  return rows
    .map((r) => (typeof r.root_id === "string" ? r.root_id : null))
    .filter((s): s is string => !!s);
}

// Eligible candidates for the background auto-retry pass: rows that we
// originally inserted as the first attempt (parentNotificationId IS NULL)
// AND whose most-recent attempt failed AND were attempted at least
// `minAgeMs` ago. The dedupe and attempt-cap checks happen in the service
// once the latest-by-chain map is computed.
export async function listFailedRetryCandidates(
  minAgeMs: number,
  lookbackMs: number,
  limit: number,
): Promise<RateLimitAlertNotification[]> {
  await ensureRateLimitAlertNotificationsTable();
  const now = Date.now();
  const upper = now - minAgeMs;
  const lower = now - lookbackMs;
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return db
    .select()
    .from(rateLimitAlertNotifications)
    .where(
      and(
        eq(rateLimitAlertNotifications.status, "failed"),
        // Only retry through the canonical path on root rows; descendants
        // are already part of a chain whose latest status drives dedupe.
        sql`${rateLimitAlertNotifications.parentNotificationId} IS NULL`,
        lte(rateLimitAlertNotifications.attemptedAt, upper),
        sql`${rateLimitAlertNotifications.attemptedAt} >= ${lower}`,
      ),
    )
    .orderBy(desc(rateLimitAlertNotifications.attemptedAt))
    .limit(safeLimit);
}

// Returns failed first-attempt rows matching the same filters used in the
// notification history list. Used by bulk retry so an admin can resend all
// failed alerts that match what they're currently looking at.
export async function listFailedNotificationsForRetry(
  filters: RateLimitAlertNotificationFilters = {},
  limit = 200,
): Promise<RateLimitAlertNotification[]> {
  await ensureRateLimitAlertNotificationsTable();
  const where = buildAlertNotificationWhere({ ...filters, status: "failed" });
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const base = db.select().from(rateLimitAlertNotifications);
  const filtered = where ? base.where(where) : base;
  return filtered
    .orderBy(desc(rateLimitAlertNotifications.attemptedAt))
    .limit(safeLimit);
}

export async function listAlertNotificationsForExport(
  filters: RateLimitAlertNotificationFilters = {},
  limit: number = ALERT_NOTIFICATION_EXPORT_DEFAULT_LIMIT,
): Promise<RateLimitAlertNotification[]> {
  await ensureRateLimitAlertNotificationsTable();
  const safeLimit = Math.max(
    1,
    Math.min(Math.floor(limit), ALERT_NOTIFICATION_EXPORT_HARD_CEILING),
  );
  const where = buildAlertNotificationWhere(filters);
  const base = db.select().from(rateLimitAlertNotifications);
  const filtered = where ? base.where(where) : base;
  return filtered
    .orderBy(desc(rateLimitAlertNotifications.attemptedAt))
    .limit(safeLimit);
}

export interface AlertNotificationsRangeStats {
  totalRows: number;
  oldestAttemptedAt: number | null;
  newestAttemptedAt: number | null;
}

export async function getAlertNotificationsRangeStats(): Promise<AlertNotificationsRangeStats> {
  await ensureRateLimitAlertNotificationsTable();
  const result: any = await db.execute(sql`
    SELECT
      COUNT(*)::bigint AS total,
      MIN("attempted_at") AS oldest,
      MAX("attempted_at") AS newest
    FROM "rate_limit_alert_notifications"
  `);
  const row = (result?.rows ?? result)?.[0] ?? {};
  const total = Number(row.total ?? 0);
  const oldest = row.oldest != null ? Number(row.oldest) : null;
  const newest = row.newest != null ? Number(row.newest) : null;
  return {
    totalRows: Number.isFinite(total) ? total : 0,
    oldestAttemptedAt: oldest != null && Number.isFinite(oldest) ? oldest : null,
    newestAttemptedAt: newest != null && Number.isFinite(newest) ? newest : null,
  };
}

export async function countAlertNotificationsOlderThan(
  cutoffMs: number,
): Promise<number> {
  await ensureRateLimitAlertNotificationsTable();
  const result: any = await db.execute(sql`
    SELECT COUNT(*)::bigint AS n
    FROM "rate_limit_alert_notifications"
    WHERE "attempted_at" < ${cutoffMs}
  `);
  const row = (result?.rows ?? result)?.[0] ?? {};
  const n = Number(row.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}
