// @db-pool-intent: ambient
/**
 * NoBull Comms storage — drafts & scheduled messages.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Drafts, Scheduled messages.
 */

import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import { commsDrafts, commsScheduledMessages, type CommsDraft, type CommsScheduledMessage } from "@shared/schema";

// ─── Drafts ───────────────────────────────────────────────────────────────────

export async function upsertDraft(
  userId: string,
  channelId: string,
  parentId: string | null,
  content: string,
  metadata?: unknown,
): Promise<CommsDraft> {
  return withDbAttribution("comms:upsertDraft", async () => {
    const now = new Date();
    // Use raw SQL for the upsert so we can match the composite unique index
    // (user_id, channel_id, COALESCE(parent_id, '')) without a partial-index
    // ON CONFLICT clause that Drizzle doesn't support for expression indexes.
    const db = getDb();
    const result = await dbRetry(
      () =>
        db.execute(
          sql`
            INSERT INTO comms_drafts (user_id, channel_id, parent_id, content, metadata, updated_at, created_at)
            VALUES (
              ${userId},
              ${channelId},
              ${parentId},
              ${content},
              ${metadata !== undefined ? JSON.stringify(metadata) : null}::jsonb,
              ${now},
              ${now}
            )
            ON CONFLICT (user_id, channel_id, COALESCE(parent_id, ''))
            DO UPDATE SET
              content    = EXCLUDED.content,
              metadata   = EXCLUDED.metadata,
              updated_at = EXCLUDED.updated_at
            RETURNING *
          `,
        ),
      "comms.upsertDraft",
    );
    return result.rows[0] as CommsDraft;
  });
}

export async function getDraft(
  userId: string,
  channelId: string,
  parentId: string | null,
): Promise<CommsDraft | null> {
  return withDbAttribution("comms:getDraft", async () => {
    const db = getDb();
    const result = await dbRetry(
      () =>
        db.execute(
          sql`
            SELECT * FROM comms_drafts
            WHERE user_id = ${userId}
              AND channel_id = ${channelId}
              AND COALESCE(parent_id, '') = ${parentId ?? ''}
            LIMIT 1
          `,
        ),
      "comms.getDraft",
    );
    return (result.rows[0] as CommsDraft) ?? null;
  });
}

export async function deleteDraft(
  userId: string,
  channelId: string,
  parentId: string | null,
): Promise<boolean> {
  return withDbAttribution("comms:deleteDraft", async () => {
    const db = getDb();
    const result = await dbRetry(
      () =>
        db.execute(
          sql`
            DELETE FROM comms_drafts
            WHERE user_id = ${userId}
              AND channel_id = ${channelId}
              AND COALESCE(parent_id, '') = ${parentId ?? ''}
          `,
        ),
      "comms.deleteDraft",
    );
    return (result.rowCount ?? 0) > 0;
  });
}

export async function listDraftsForUser(userId: string): Promise<CommsDraft[]> {
  return withDbAttribution("comms:listDraftsForUser", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsDrafts)
          .where(eq(commsDrafts.userId, userId))
          .orderBy(desc(commsDrafts.updatedAt)),
      "comms.listDraftsForUser",
    );
    return rows;
  });
}

// ─── Scheduled messages ───────────────────────────────────────────────────────

export async function createScheduledMessage(data: {
  userId: string;
  channelId: string;
  parentId?: string | null;
  content: string;
  metadata?: unknown;
  scheduledFor: Date;
}): Promise<CommsScheduledMessage> {
  return withDbAttribution("comms:createScheduledMessage", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsScheduledMessages)
          .values({
            userId: data.userId,
            channelId: data.channelId,
            parentId: data.parentId ?? null,
            content: data.content,
            metadata: data.metadata as any,
            scheduledFor: data.scheduledFor,
            status: "pending",
          })
          .returning(),
      "comms.createScheduledMessage",
    );
    return row;
  });
}

export async function getScheduledMessageById(id: string): Promise<CommsScheduledMessage | null> {
  return withDbAttribution("comms:getScheduledMessageById", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsScheduledMessages)
          .where(eq(commsScheduledMessages.id, id))
          .limit(1),
      "comms.getScheduledMessageById",
    );
    return row ?? null;
  });
}

export async function listScheduledMessagesForChannel(
  channelId: string,
  userId: string,
): Promise<CommsScheduledMessage[]> {
  return withDbAttribution("comms:listScheduledMessagesForChannel", async () => {
    return dbRetry(
      () =>
        getDb()
          .select()
          .from(commsScheduledMessages)
          .where(
            and(
              eq(commsScheduledMessages.channelId, channelId),
              eq(commsScheduledMessages.userId, userId),
              eq(commsScheduledMessages.status, "pending"),
            ),
          )
          .orderBy(asc(commsScheduledMessages.scheduledFor)),
      "comms.listScheduledMessagesForChannel",
    );
  });
}

export async function listAllScheduledMessagesForUser(
  userId: string,
): Promise<CommsScheduledMessage[]> {
  return withDbAttribution("comms:listAllScheduledMessagesForUser", async () => {
    return dbRetry(
      () =>
        getDb()
          .select()
          .from(commsScheduledMessages)
          .where(
            and(
              eq(commsScheduledMessages.userId, userId),
              eq(commsScheduledMessages.status, "pending"),
            ),
          )
          .orderBy(asc(commsScheduledMessages.scheduledFor)),
      "comms.listAllScheduledMessagesForUser",
    );
  });
}

export async function updateScheduledMessage(
  id: string,
  data: Partial<Pick<CommsScheduledMessage, "content" | "scheduledFor" | "status" | "errorMessage" | "deliveredMessageId">>,
): Promise<CommsScheduledMessage | null> {
  return withDbAttribution("comms:updateScheduledMessage", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsScheduledMessages)
      .set({ ...data, updatedAt: now })
      .where(eq(commsScheduledMessages.id, id))
      .returning();
    return row ?? null;
  });
}

export async function cancelScheduledMessage(
  id: string,
  userId: string,
): Promise<CommsScheduledMessage | null> {
  return withDbAttribution("comms:cancelScheduledMessage", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsScheduledMessages)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(commsScheduledMessages.id, id),
          eq(commsScheduledMessages.userId, userId),
          eq(commsScheduledMessages.status, "pending"),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * Atomically claim a specific scheduled message for delivery (pending → delivering).
 * Returns the row if the claim succeeded, null if the row was not found,
 * was not pending, or another instance already claimed it.
 */
export async function claimScheduledMessageById(id: string): Promise<CommsScheduledMessage | null> {
  return withDbAttribution("comms:claimScheduledMessageById", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(commsScheduledMessages)
      .set({ status: "delivering", updatedAt: now })
      .where(
        and(
          eq(commsScheduledMessages.id, id),
          eq(commsScheduledMessages.status, "pending"),
          // Re-verify the message is still due. Prevents early delivery if the
          // user rescheduled to the future after the producer enqueued this job.
          lte(commsScheduledMessages.scheduledFor, now),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * Reset stale `delivering` rows to `pending` so they can be re-claimed after
 * a crash or restart. Only rows older than `staleThresholdMs` are touched.
 */
export async function reclaimStaleDeliveringMessages(staleThresholdMs: number): Promise<number> {
  return withDbAttribution("comms:reclaimStaleDelivering", async () => {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const rows = await getDb()
      .update(commsScheduledMessages)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(commsScheduledMessages.status, "delivering"),
          lte(commsScheduledMessages.updatedAt, cutoff),
        ),
      )
      .returning({ id: commsScheduledMessages.id });
    return rows.length;
  });
}

/** Claim a single due scheduled message for delivery (status: pending → delivering). */
export async function claimDueScheduledMessage(): Promise<CommsScheduledMessage | null> {
  return withDbAttribution("comms:claimDueScheduledMessage", async () => {
    const now = new Date();
    const result = await getDb().execute(
      sql`
        UPDATE comms_scheduled_messages
        SET status = 'delivering', updated_at = ${now}
        WHERE id = (
          SELECT id FROM comms_scheduled_messages
          WHERE status = 'pending'
            AND scheduled_for <= ${now}
          ORDER BY scheduled_for ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `,
    );
    return (result.rows[0] as CommsScheduledMessage) ?? null;
  });
}

/** List IDs of pending scheduled messages due for delivery (used by producer tick). */
export async function listDueScheduledMessageIds(): Promise<string[]> {
  return withDbAttribution("comms:listDueScheduledMessageIds", async () => {
    const now = new Date();
    const rows = await dbRetry(
      () =>
        getDb()
          .select({ id: commsScheduledMessages.id })
          .from(commsScheduledMessages)
          .where(
            and(
              eq(commsScheduledMessages.status, "pending"),
              lte(commsScheduledMessages.scheduledFor, now),
            ),
          )
          .orderBy(asc(commsScheduledMessages.scheduledFor))
          .limit(50),
      "comms.listDueScheduledMessageIds",
    );
    return rows.map((r) => r.id);
  });
}
