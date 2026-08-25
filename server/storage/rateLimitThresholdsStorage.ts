import { db } from "../db";
import {
  rateLimitThresholds,
  type RateLimitThresholdRecord,
  type InsertRateLimitThreshold,
} from "@shared/schema";
import { eq, sql } from "drizzle-orm";

export async function ensureRateLimitThresholdsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "rate_limit_thresholds" (
      "category" varchar(128) PRIMARY KEY NOT NULL,
      "threshold" integer NOT NULL
    )
  `);
}

export async function listRateLimitThresholds(): Promise<RateLimitThresholdRecord[]> {
  return db.select().from(rateLimitThresholds);
}

export async function upsertRateLimitThreshold(record: InsertRateLimitThreshold): Promise<void> {
  await db
    .insert(rateLimitThresholds)
    .values(record)
    .onConflictDoUpdate({
      target: rateLimitThresholds.category,
      set: { threshold: record.threshold },
    });
}

export async function deleteRateLimitThreshold(category: string): Promise<void> {
  await db.delete(rateLimitThresholds).where(eq(rateLimitThresholds.category, category));
}

export async function deleteAllRateLimitThresholds(): Promise<void> {
  await db.delete(rateLimitThresholds);
}
