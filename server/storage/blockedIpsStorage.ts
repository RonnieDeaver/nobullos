import { db } from "../db";
import { blockedIps, type BlockedIpRecord, type InsertBlockedIp } from "@shared/schema";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

export async function ensureBlockedIpsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "blocked_ips" (
      "ip" varchar(64) PRIMARY KEY NOT NULL,
      "blocked_at" bigint NOT NULL,
      "reason" text,
      "expires_at" bigint
    )
  `);
  await db.execute(sql`
    ALTER TABLE "blocked_ips" ADD COLUMN IF NOT EXISTS "expires_at" bigint
  `);
}

export async function listBlockedIps(): Promise<BlockedIpRecord[]> {
  return db.select().from(blockedIps);
}

export async function insertBlockedIp(record: InsertBlockedIp): Promise<void> {
  await db.insert(blockedIps).values(record).onConflictDoNothing();
}

export async function deleteBlockedIp(ip: string): Promise<void> {
  await db.delete(blockedIps).where(eq(blockedIps.ip, ip));
}

export async function updateBlockedIpExpiry(ip: string, expiresAt: number | null): Promise<boolean> {
  const rows = await db
    .update(blockedIps)
    .set({ expiresAt })
    .where(eq(blockedIps.ip, ip))
    .returning({ ip: blockedIps.ip });
  return rows.length > 0;
}

export async function deleteExpiredBlockedIps(now: number): Promise<string[]> {
  const rows = await db
    .delete(blockedIps)
    .where(and(isNotNull(blockedIps.expiresAt), lte(blockedIps.expiresAt, now)))
    .returning({ ip: blockedIps.ip });
  return rows.map((r) => r.ip);
}
