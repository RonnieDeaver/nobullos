// @db-pool-intent: worker
// @cross-instance-safe: periodic tick uses enqueueJob with dedupeKey per scheduled-message ID,
// so concurrent instances compete on the same dedupe key and only one job is inserted per message.
// The delivery handler uses FOR UPDATE SKIP LOCKED (via claimDueScheduledMessage) for safe cross-instance delivery.
/**
 * Comms Scheduled Message Delivery
 *
 * Two moving parts:
 *   1. Producer tick (startCommsScheduledDeliveryScheduler) — runs every 60 s,
 *      scans comms_scheduled_messages for due rows, enqueues one
 *      `comms_scheduled_delivery` work-queue job per message.
 *
 *   2. Handler (handleCommsScheduledDelivery) — registered in workQueueHandlers.ts,
 *      claims a single due scheduled message, posts it as a real comms message,
 *      marks it delivered, and notifies the author on failure.
 */

import { runWithWorkerDb } from "../db";
import { workerLog } from "./workerLogger";
import { enqueueJob } from "./workScheduler";
import { notifyUser } from "./notifications/userInbox";
import { broadcastTwilioEvent } from "./twilioEvents";
import * as commsStorage from "../storage/commsStorage";
import type { WorkQueueJob } from "@shared/schema";

export const COMMS_SCHEDULED_DELIVERY_QUEUE = "comms_scheduled_delivery";
const TICK_INTERVAL_MS = 60_000;

let tickTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Producer tick ────────────────────────────────────────────────────────────

// Rows that have been `delivering` for longer than this threshold are assumed
// to be from a crashed process and are reset to `pending` for re-delivery.
const STALE_DELIVERING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

async function runDeliveryTick(): Promise<void> {
  try {
    await runWithWorkerDb(async () => {
      // Recover any rows stranded in `delivering` by a previous crash.
      const reclaimed = await commsStorage.reclaimStaleDeliveringMessages(STALE_DELIVERING_THRESHOLD_MS);
      if (reclaimed > 0) {
        workerLog({
          worker: "comms_scheduled_delivery_tick",
          event: "reclaimed_stale_delivering",
          workloadClass: "maintenance",
          count: reclaimed,
        } as any);
      }
      const ids = await commsStorage.listDueScheduledMessageIds();
      for (const id of ids) {
        await enqueueJob({
          queueName: COMMS_SCHEDULED_DELIVERY_QUEUE,
          workloadClass: "maintenance",
          payload: { scheduledMessageId: id },
          dedupeKey: `comms:scheduled:deliver:${id}`,
          priority: 200,
          maxAttempts: 3,
        });
      }
      if (ids.length > 0) {
        workerLog({
          worker: "comms_scheduled_delivery_tick",
          event: "enqueued_due_messages",
          workloadClass: "maintenance",
          count: ids.length,
        } as any);
      }
    });
  } catch (err: any) {
    console.error("[CommsScheduledDelivery] Tick error:", err?.message);
  }
}

function scheduleTick(): void {
  tickTimer = setTimeout(async () => {
    await runDeliveryTick();
    scheduleTick();
  }, TICK_INTERVAL_MS);
}

export function startCommsScheduledDeliveryScheduler(): void {
  // Run once shortly after boot, then every 60 s.
  setTimeout(async () => {
    await runDeliveryTick();
    scheduleTick();
  }, 5_000);
}

export function stopCommsScheduledDeliveryScheduler(): void {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

// ─── Delivery handler ─────────────────────────────────────────────────────────

export async function handleCommsScheduledDelivery(job: WorkQueueJob): Promise<void> {
  const payload = job.payload as { scheduledMessageId?: string };
  const scheduledMessageId = payload?.scheduledMessageId;
  if (!scheduledMessageId) {
    workerLog({ worker: COMMS_SCHEDULED_DELIVERY_QUEUE, event: "missing_id", workloadClass: "maintenance" } as any);
    return;
  }

  await runWithWorkerDb(async () => {
    // Atomically claim the row (pending → delivering). If another instance or
    // duplicate job already claimed it, the UPDATE returns 0 rows and we bail.
    const scheduled = await commsStorage.claimScheduledMessageById(scheduledMessageId);
    if (!scheduled) {
      workerLog({ worker: COMMS_SCHEDULED_DELIVERY_QUEUE, event: "already_processed_or_not_found", workloadClass: "maintenance", id: scheduledMessageId } as any);
      return;
    }

    let deliveredMessageId: string | null = null;
    let deliveryError: string | null = null;

    try {
      const message = await commsStorage.createMessage({
        channelId: scheduled.channelId,
        userId: scheduled.userId,
        parentId: scheduled.parentId ?? null,
        content: scheduled.content,
        contentType: "text",
        metadata: scheduled.metadata as any ?? null,
      });
      deliveredMessageId = message.id;

      // Broadcast SSE so open windows see the new message immediately.
      const memberIds = await commsStorage.getChannelMemberIds(scheduled.channelId);
      broadcastTwilioEvent({
        type: "comms:message",
        channelId: scheduled.channelId,
        message: {
          id: message.id,
          channelId: message.channelId,
          userId: message.userId,
          parentId: message.parentId,
          content: message.content,
          contentType: message.contentType,
          editedAt: message.editedAt ? String(message.editedAt) : null,
          deletedAt: message.deletedAt ? String(message.deletedAt) : null,
          metadata: message.metadata,
          createdAt: String(message.createdAt),
          updatedAt: String(message.updatedAt),
        },
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      // Mark delivered and record the real message ID.
      await commsStorage.updateScheduledMessage(scheduledMessageId, {
        status: "delivered",
        deliveredMessageId,
      });

      // Broadcast a scheduled-message-delivered event so the sender's UI clears the pending entry.
      broadcastTwilioEvent({
        type: "comms:scheduled_message",
        action: "delivered",
        channelId: scheduled.channelId,
        scheduledMessageId,
        targetUserIds: [scheduled.userId],
      });

      workerLog({ worker: COMMS_SCHEDULED_DELIVERY_QUEUE, event: "delivered", workloadClass: "maintenance", id: scheduledMessageId, messageId: deliveredMessageId } as any);
    } catch (err: any) {
      deliveryError = err?.message ?? "Unknown delivery error";
      console.error(`[CommsScheduledDelivery] Delivery failed for ${scheduledMessageId}:`, deliveryError);

      // Determine whether more work-queue retries remain.
      // attemptCount is 0-indexed (0 = first attempt) and maxAttempts defaults to 3.
      const attemptsDone = (job.attemptCount ?? 0) + 1;
      const maxAttempts = job.maxAttempts ?? 3;
      const isLastAttempt = attemptsDone >= maxAttempts;

      if (isLastAttempt) {
        // All retries exhausted — mark terminal so the UI surfaces the failure.
        await commsStorage.updateScheduledMessage(scheduledMessageId, {
          status: "failed",
          errorMessage: deliveryError,
        });

        // Notify the author that their scheduled message failed to send.
        try {
          await notifyUser(scheduled.userId, {
            title: "Scheduled message could not be sent",
            body: `Your message scheduled for ${scheduled.scheduledFor.toLocaleString()} failed to deliver: ${deliveryError}`,
            category: "system",
          });
        } catch (notifyErr: any) {
          console.warn(`[CommsScheduledDelivery] Failed to notify author ${scheduled.userId}:`, notifyErr?.message);
        }

        broadcastTwilioEvent({
          type: "comms:scheduled_message",
          action: "failed",
          channelId: scheduled.channelId,
          scheduledMessageId,
          targetUserIds: [scheduled.userId],
        });
      } else {
        // More retries remain — reset to pending so the next work-queue attempt
        // can re-claim the row via claimScheduledMessageById.
        await commsStorage.updateScheduledMessage(scheduledMessageId, {
          status: "pending",
        });
      }

      // Re-throw so the work queue records the failure and schedules a retry.
      throw err;
    }
  });
}
