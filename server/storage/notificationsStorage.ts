/**
 * Task #994 — Storage helpers for notification settings and delivery history.
 *
 * All reads/writes go through `withDbAttribution` so pool checkouts are
 * attributed to the notifications subsystem and are visible in the Health
 * dashboard's hold-label stats.
 */

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, dbRetry, withDbAttribution } from "../db";
import {
  notificationDeliveries,
  notificationHealthState,
  notificationSettings,
  type InsertNotificationDelivery,
  type NotificationDelivery,
  type NotificationHealthState,
  type NotificationSetting,
  type NotificationSettingSource,
} from "@shared/schema";

let tableReady: Promise<void> | null = null;

/**
 * Idempotent table creation — mirrors the pattern used by
 * pendingDigestAlertsStorage. Lets the new tables come online even on
 * environments where the migration has not yet been applied.
 */
export async function ensureNotificationTables(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "notification_settings" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "notification_id" varchar NOT NULL UNIQUE,
          "enabled" boolean NOT NULL DEFAULT true,
          "channel_id" varchar,
          "channel_name" varchar,
          "updated_by" varchar,
          "updated_at" timestamp NOT NULL DEFAULT now(),
          "created_at" timestamp NOT NULL DEFAULT now(),
          "source" varchar NOT NULL DEFAULT 'default',
          "metadata_json" jsonb
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "notification_settings_notif_idx"
          ON "notification_settings" ("notification_id")
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "notification_deliveries" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "notification_id" varchar NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "channel_id" varchar,
          "channel_name" varchar,
          "status" varchar NOT NULL,
          "error_message" text,
          "error_code" varchar,
          "slack_ts" varchar,
          "payload_preview" text,
          "trigger_source" varchar,
          "trigger_actor_id" varchar,
          "dedupe_key" varchar,
          "metadata_json" jsonb
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "notif_deliveries_notif_created_idx"
          ON "notification_deliveries" ("notification_id", "created_at" DESC)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "notif_deliveries_created_idx"
          ON "notification_deliveries" ("created_at" DESC)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "notif_deliveries_status_created_idx"
          ON "notification_deliveries" ("status", "created_at" DESC)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "notif_deliveries_dedupe_key_idx"
          ON "notification_deliveries" ("dedupe_key")
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "notification_health_state" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "notification_id" varchar NOT NULL,
          "dedupe_key" varchar NOT NULL,
          "state" varchar NOT NULL,
          "failure_type" varchar,
          "transitioned_at" timestamp NOT NULL DEFAULT now(),
          "last_notified_at" timestamp,
          "occurrence_count" jsonb,
          "metadata_json" jsonb
        )
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS "notification_health_state_notif_key_uniq"
          ON "notification_health_state" ("notification_id", "dedupe_key")
      `);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

export async function getNotificationSetting(
  notificationId: string,
): Promise<NotificationSetting | undefined> {
  await ensureNotificationTables();
  return withDbAttribution("notifications:getSetting", async () => {
    const [row] = await dbRetry(
      () =>
        db
          .select()
          .from(notificationSettings)
          .where(eq(notificationSettings.notificationId, notificationId))
          .limit(1),
      "notifications.getSetting",
    );
    return row;
  });
}

export async function getAllNotificationSettings(): Promise<NotificationSetting[]> {
  await ensureNotificationTables();
  return withDbAttribution("notifications:getAllSettings", async () => {
    return dbRetry(
      () => db.select().from(notificationSettings),
      "notifications.getAllSettings",
    );
  });
}

export interface UpsertNotificationSettingInput {
  notificationId: string;
  enabled?: boolean;
  channelId?: string | null;
  channelName?: string | null;
  updatedBy?: string | null;
  source?: NotificationSettingSource;
  metadataJson?: unknown;
}

export async function upsertNotificationSetting(
  input: UpsertNotificationSettingInput,
): Promise<NotificationSetting> {
  await ensureNotificationTables();
  const existing = await getNotificationSetting(input.notificationId);
  const updatedAt = new Date();
  // When creating a fresh settings row and the caller hasn't specified an
  // explicit `enabled`, fall back to the registry's `defaultEnabled` so we
  // never silently flip a planned/disabled-by-default notification on just
  // because someone saved a channel.
  const { getNotification } = await import("../services/notifications/registry");
  const registryDefaultEnabled =
    getNotification(input.notificationId)?.defaultEnabled ?? true;
  return withDbAttribution("notifications:upsertSetting", async () => {
    if (existing) {
      const [row] = await db
        .update(notificationSettings)
        .set({
          enabled: input.enabled ?? existing.enabled,
          channelId:
            input.channelId === undefined ? existing.channelId : input.channelId || null,
          channelName:
            input.channelName === undefined
              ? existing.channelName
              : input.channelName || null,
          updatedBy: input.updatedBy ?? existing.updatedBy,
          source: input.source ?? "notification_settings",
          metadataJson:
            (input.metadataJson as Record<string, unknown> | null | undefined) ??
            existing.metadataJson,
          updatedAt,
        })
        .where(eq(notificationSettings.notificationId, input.notificationId))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(notificationSettings)
      .values({
        notificationId: input.notificationId,
        enabled: input.enabled ?? registryDefaultEnabled,
        channelId: input.channelId ?? null,
        channelName: input.channelName ?? null,
        updatedBy: input.updatedBy ?? null,
        source: input.source ?? "notification_settings",
        metadataJson:
          (input.metadataJson as Record<string, unknown> | null | undefined) ?? null,
      })
      .returning();
    return row;
  });
}

export async function insertNotificationDelivery(
  input: InsertNotificationDelivery,
): Promise<NotificationDelivery | null> {
  await ensureNotificationTables();
  try {
    return await withDbAttribution("notifications:insertDelivery", async () => {
      const [row] = await db.insert(notificationDeliveries).values(input).returning();
      return row;
    });
  } catch (err: any) {
    console.error(
      "[notifications/storage] insertDelivery failed for",
      input.notificationId,
      err?.message ?? err,
    );
    return null;
  }
}

export async function listNotificationDeliveries(
  notificationId: string,
  limit = 20,
): Promise<NotificationDelivery[]> {
  await ensureNotificationTables();
  return withDbAttribution("notifications:listDeliveries", async () => {
    return dbRetry(
      () =>
        db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.notificationId, notificationId))
          .orderBy(desc(notificationDeliveries.createdAt))
          .limit(Math.max(1, Math.min(limit, 200))),
      "notifications.listDeliveries",
    );
  });
}

export interface DeliveryStats24h {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export async function getDeliveryStats24h(): Promise<Map<string, DeliveryStats24h>> {
  await ensureNotificationTables();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await withDbAttribution("notifications:stats24h", async () =>
    dbRetry(
      () =>
        db
          .select({
            notificationId: notificationDeliveries.notificationId,
            status: notificationDeliveries.status,
            count: sql<number>`count(*)::int`,
          })
          .from(notificationDeliveries)
          .where(sql`${notificationDeliveries.createdAt} >= ${cutoff}`)
          .groupBy(notificationDeliveries.notificationId, notificationDeliveries.status),
      "notifications.stats24h",
    ),
  );
  const map = new Map<string, DeliveryStats24h>();
  for (const r of rows) {
    const cur =
      map.get(r.notificationId) ?? { total: 0, success: 0, failed: 0, skipped: 0 };
    cur.total += r.count;
    if (r.status === "success") cur.success += r.count;
    else if (r.status === "failed") cur.failed += r.count;
    else cur.skipped += r.count;
    map.set(r.notificationId, cur);
  }
  return map;
}

// ───────── Task #4645 — Slack-wide outcome stats (outage detector) ─────────

export interface SlackOutcomeTopFailing {
  notificationId: string;
  channelId: string | null;
  failures: number;
}

export interface SlackOutcomeStats {
  windowFailures: number;
  windowSuccesses: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  failingSince: Date | null;
  topFailing: SlackOutcomeTopFailing[];
  lastErrorMessage: string | null;
}

/**
 * Aggregate delivery-outcome stats for the sustained Slack-outage detector
 * (Task #4645). Only `success` and `failed` rows count as observations —
 * every `skipped_*` status (kill switch, disconnected, no channel, dedupe)
 * is deliberately excluded so paused periods can neither open nor close the
 * outage state.
 *
 * `failingSince` is the earliest failure inside the lookback horizon with no
 * later success — the start of the current uninterrupted failure streak,
 * capped at `lookbackMs` so an all-time-broken ledger (prod as of 2026-08)
 * yields "lookback+ days" instead of an unbounded scan. NULL when the most
 * recent observation is a success (no active streak).
 */
export async function getSlackOutcomeStats(opts: {
  windowMs: number;
  lookbackMs: number;
  now?: Date;
}): Promise<SlackOutcomeStats> {
  await ensureNotificationTables();
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - opts.windowMs);
  const lookbackStart = new Date(now.getTime() - opts.lookbackMs);
  return withDbAttribution("notifications:slackOutcomeStats", async () => {
    const aggRes: any = await dbRetry(
      () =>
        db.execute(sql`
          SELECT
            count(*) FILTER (WHERE "status" = 'failed' AND "created_at" >= ${windowStart}) AS window_failures,
            count(*) FILTER (WHERE "status" = 'success' AND "created_at" >= ${windowStart}) AS window_successes,
            max("created_at") FILTER (WHERE "status" = 'failed') AS last_failure_at,
            max("created_at") FILTER (WHERE "status" = 'success') AS last_success_at
          FROM "notification_deliveries"
          WHERE "created_at" >= ${lookbackStart}
            AND "created_at" <= ${now}
            AND "status" IN ('success', 'failed')
        `),
      "notifications.slackOutcomeStats",
    );
    const agg = ((aggRes?.rows ?? []) as any[])[0] ?? {};

    const sinceRes: any = await db.execute(sql`
      SELECT min("created_at") AS failing_since
      FROM "notification_deliveries"
      WHERE "status" = 'failed'
        AND "created_at" >= ${lookbackStart}
        AND "created_at" <= ${now}
        AND "created_at" > COALESCE(
          (
            SELECT max("created_at") FROM "notification_deliveries"
            WHERE "status" = 'success'
              AND "created_at" >= ${lookbackStart}
              AND "created_at" <= ${now}
          ),
          ${lookbackStart}
        )
    `);

    const topRes: any = await db.execute(sql`
      SELECT "notification_id", "channel_id", count(*)::int AS failures
      FROM "notification_deliveries"
      WHERE "status" = 'failed'
        AND "created_at" >= ${windowStart}
        AND "created_at" <= ${now}
      GROUP BY "notification_id", "channel_id"
      ORDER BY failures DESC
      LIMIT 5
    `);

    const errRes: any = await db.execute(sql`
      SELECT "error_message"
      FROM "notification_deliveries"
      WHERE "status" = 'failed'
        AND "created_at" >= ${lookbackStart}
        AND "created_at" <= ${now}
      ORDER BY "created_at" DESC
      LIMIT 1
    `);

    const toDate = (v: unknown): Date | null =>
      v ? (v instanceof Date ? v : new Date(v as string)) : null;
    return {
      windowFailures: Number(agg.window_failures ?? 0),
      windowSuccesses: Number(agg.window_successes ?? 0),
      lastFailureAt: toDate(agg.last_failure_at),
      lastSuccessAt: toDate(agg.last_success_at),
      failingSince: toDate(((sinceRes?.rows ?? []) as any[])[0]?.failing_since),
      topFailing: ((topRes?.rows ?? []) as any[]).map((r) => ({
        notificationId: String(r.notification_id),
        channelId: r.channel_id != null ? String(r.channel_id) : null,
        failures: Number(r.failures ?? 0),
      })),
      lastErrorMessage:
        (((errRes?.rows ?? []) as any[])[0]?.error_message as string | undefined) ??
        null,
    };
  });
}

export async function getLastDeliveryByNotification(): Promise<
  Map<string, NotificationDelivery>
> {
  await ensureNotificationTables();
  const rows = await withDbAttribution("notifications:lastDeliveries", async () =>
    dbRetry(
      () =>
        db.execute(sql`
          SELECT DISTINCT ON ("notification_id") *
          FROM "notification_deliveries"
          ORDER BY "notification_id", "created_at" DESC
        `),
      "notifications.lastDeliveries",
    ),
  );
  const out = new Map<string, NotificationDelivery>();
  const list = (rows as any).rows ?? rows;
  for (const r of list as any[]) {
    out.set(r.notification_id, {
      id: r.id,
      notificationId: r.notification_id,
      createdAt: r.created_at,
      channelId: r.channel_id,
      channelName: r.channel_name,
      status: r.status,
      errorMessage: r.error_message,
      errorCode: r.error_code,
      slackTs: r.slack_ts,
      payloadPreview: r.payload_preview,
      triggerSource: r.trigger_source,
      triggerActorId: r.trigger_actor_id,
      dedupeKey: r.dedupe_key,
      metadataJson: r.metadata_json,
    });
  }
  return out;
}

/** Returns the number of rows deleted. */
export async function pruneOldDeliveries(opts: {
  olderThan: Date;
  keepPerNotification: number;
}): Promise<number> {
  await ensureNotificationTables();
  return withDbAttribution("notifications:pruneOldDeliveries", async () => {
    // Phase A — bulk delete by age.
    const ageRes: any = await db.execute(sql`
      DELETE FROM "notification_deliveries"
      WHERE "created_at" < ${opts.olderThan}
    `);
    const ageDeleted = Number(ageRes?.rowCount ?? ageRes?.rows?.[0]?.count ?? 0);

    // Phase B — keep at most N per notification id.
    const capRes: any = await db.execute(sql`
      WITH ranked AS (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY "notification_id"
            ORDER BY "created_at" DESC
          ) AS rn
        FROM "notification_deliveries"
      )
      DELETE FROM "notification_deliveries"
      WHERE id IN (SELECT id FROM ranked WHERE rn > ${opts.keepPerNotification})
    `);
    const capDeleted = Number(capRes?.rowCount ?? 0);
    return ageDeleted + capDeleted;
  });
}

// ──────────────── Health-state (transition tracking) ────────────────

export async function getHealthState(
  notificationId: string,
  dedupeKey: string,
): Promise<NotificationHealthState | undefined> {
  await ensureNotificationTables();
  return withDbAttribution("notifications:getHealthState", async () => {
    const [row] = await db
      .select()
      .from(notificationHealthState)
      .where(
        and(
          eq(notificationHealthState.notificationId, notificationId),
          eq(notificationHealthState.dedupeKey, dedupeKey),
        ),
      )
      .limit(1);
    return row;
  });
}

export async function upsertHealthState(input: {
  notificationId: string;
  dedupeKey: string;
  state: "healthy" | "unhealthy";
  failureType?: string | null;
  lastNotifiedAt?: Date | null;
  metadataJson?: unknown;
}): Promise<NotificationHealthState> {
  await ensureNotificationTables();
  return withDbAttribution("notifications:upsertHealthState", async () => {
    const existing = await getHealthState(input.notificationId, input.dedupeKey);
    if (existing) {
      const [row] = await db
        .update(notificationHealthState)
        .set({
          state: input.state,
          failureType: input.failureType ?? existing.failureType,
          transitionedAt:
            existing.state !== input.state ? new Date() : existing.transitionedAt,
          lastNotifiedAt: input.lastNotifiedAt ?? existing.lastNotifiedAt,
          metadataJson:
            (input.metadataJson as Record<string, unknown> | null | undefined) ??
            existing.metadataJson,
        })
        .where(eq(notificationHealthState.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(notificationHealthState)
      .values({
        notificationId: input.notificationId,
        dedupeKey: input.dedupeKey,
        state: input.state,
        failureType: input.failureType ?? null,
        lastNotifiedAt: input.lastNotifiedAt ?? null,
        metadataJson:
          (input.metadataJson as Record<string, unknown> | null | undefined) ?? null,
      })
      .returning();
    return row;
  });
}
