import { db } from "../db";
import {
  pendingDigestAlerts,
  type InsertPendingDigestAlert,
  type PendingDigestAlert,
} from "@shared/schema";
import { asc, inArray, sql } from "drizzle-orm";

type PendingDigestAlertPayload = InsertPendingDigestAlert["payload"];

let tableReady: Promise<void> | null = null;

export async function ensurePendingDigestAlertsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "pending_digest_alerts" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "payload" jsonb NOT NULL,
          "queued_at" bigint NOT NULL
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "pending_digest_alerts_queued_at_idx"
          ON "pending_digest_alerts" ("queued_at" ASC)
      `);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

export async function insertPendingDigestAlert(
  payload: PendingDigestAlertPayload,
  queuedAt: number,
): Promise<PendingDigestAlert> {
  await ensurePendingDigestAlertsTable();
  const [row] = await db
    .insert(pendingDigestAlerts)
    .values({ payload, queuedAt })
    .returning();
  return row;
}

export async function listPendingDigestAlerts(): Promise<PendingDigestAlert[]> {
  await ensurePendingDigestAlertsTable();
  return db
    .select()
    .from(pendingDigestAlerts)
    .orderBy(asc(pendingDigestAlerts.queuedAt));
}

export async function deletePendingDigestAlerts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await ensurePendingDigestAlertsTable();
  await db.delete(pendingDigestAlerts).where(inArray(pendingDigestAlerts.id, ids));
}

export async function deleteAllPendingDigestAlerts(): Promise<void> {
  await ensurePendingDigestAlertsTable();
  await db.delete(pendingDigestAlerts);
}

export interface PendingDigestAlertsStats {
  totalRows: number;
  oldestQueuedAt: number | null;
  newestQueuedAt: number | null;
}

export async function getPendingDigestAlertsStats(): Promise<PendingDigestAlertsStats> {
  await ensurePendingDigestAlertsTable();
  const result: any = await db.execute(sql`
    SELECT
      COUNT(*)::bigint AS total,
      MIN("queued_at") AS oldest,
      MAX("queued_at") AS newest
    FROM "pending_digest_alerts"
  `);
  const row = (result?.rows ?? result)?.[0] ?? {};
  const total = Number(row.total ?? 0);
  const oldest = row.oldest != null ? Number(row.oldest) : null;
  const newest = row.newest != null ? Number(row.newest) : null;
  return {
    totalRows: Number.isFinite(total) ? total : 0,
    oldestQueuedAt: oldest != null && Number.isFinite(oldest) ? oldest : null,
    newestQueuedAt: newest != null && Number.isFinite(newest) ? newest : null,
  };
}

export async function countPendingDigestAlertsOlderThan(
  cutoffMs: number,
): Promise<number> {
  await ensurePendingDigestAlertsTable();
  const result: any = await db.execute(sql`
    SELECT COUNT(*)::bigint AS n
    FROM "pending_digest_alerts"
    WHERE "queued_at" < ${cutoffMs}
  `);
  const row = (result?.rows ?? result)?.[0] ?? {};
  const n = Number(row.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function deletePendingDigestAlertsOlderThan(
  cutoffMs: number,
): Promise<number> {
  await ensurePendingDigestAlertsTable();
  const result: any = await db.execute(sql`
    DELETE FROM "pending_digest_alerts"
    WHERE "queued_at" < ${cutoffMs}
  `);
  if (typeof result?.rowCount === "number") return result.rowCount;
  if (typeof result?.count === "number") return result.count;
  return 0;
}
