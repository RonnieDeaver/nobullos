import { db } from "../db";
import { sql, desc } from "drizzle-orm";
import {
  rateLimitNotificationPruneHistory,
  type InsertRateLimitNotificationPruneHistory,
  type RateLimitNotificationPruneHistory,
} from "@shared/schema";

let tableReady: Promise<void> | null = null;

export async function ensureRateLimitNotificationPruneHistoryTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "rate_limit_notification_prune_history" (
          "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "ran_at" timestamp NOT NULL DEFAULT now(),
          "triggered_by" varchar(32) NOT NULL,
          "actor_id" varchar,
          "retention_days" integer NOT NULL,
          "cutoff_ms" bigint NOT NULL,
          "deleted_rows" integer NOT NULL DEFAULT 0,
          "duration_ms" integer NOT NULL DEFAULT 0,
          "status" varchar(16) NOT NULL DEFAULT 'ok',
          "error_message" text
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "rate_limit_notification_prune_history_ran_at_idx"
          ON "rate_limit_notification_prune_history" ("ran_at" DESC)
      `);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

export async function insertRateLimitNotificationPruneHistory(
  data: InsertRateLimitNotificationPruneHistory,
): Promise<RateLimitNotificationPruneHistory> {
  await ensureRateLimitNotificationPruneHistoryTable();
  const [row] = await db
    .insert(rateLimitNotificationPruneHistory)
    .values(data)
    .returning();
  return row;
}

export async function listRateLimitNotificationPruneHistory(
  limit = 10,
): Promise<RateLimitNotificationPruneHistory[]> {
  await ensureRateLimitNotificationPruneHistoryTable();
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  return db
    .select()
    .from(rateLimitNotificationPruneHistory)
    .orderBy(desc(rateLimitNotificationPruneHistory.ranAt))
    .limit(safeLimit);
}
