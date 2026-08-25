// @db-pool-intent: worker
// @cross-instance-safe: periodic tick uses enqueueJob with a per-tick-window dedupeKey,
// so concurrent instances compete on the same dedupe key and only one drain job runs.
// Delivery is idempotent: notifyUser dedupes on `comms:reminder:<id>` and the row is
// flipped to `delivered` only after a successful notify.
/**
 * Comms reminder delivery.
 *
 * Two moving parts (mirrors commsScheduledDelivery.ts):
 *   1. Producer tick (startCommsReminderScheduler) — runs every 60 s, checks for
 *      due comms_message_reminders rows and enqueues one `comms_reminder_deliver`
 *      drain job when any exist.
 *   2. Handler (handleCommsReminderDeliver) — registered in workQueueHandlers.ts,
 *      claims a batch of due reminders and fans out a system notification per
 *      user with a permalink back to the message.
 */

import type { WorkQueueJob } from "@shared/schema";
import { runWithWorkerDb } from "../db";
import { enqueueJob } from "./workScheduler";
import {
  claimDueReminders,
  markReminderDelivered,
} from "../storage/commsStorage";
import { notifyUser } from "./notifications/userInbox";

export const COMMS_REMINDER_QUEUE = "comms_reminder_deliver";
const TICK_INTERVAL_MS = 60_000;
const BATCH_SIZE = 50;

let tickTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Producer tick ───────────────────────────────────────────────────────────

async function runReminderTick(): Promise<void> {
  try {
    await runWithWorkerDb(async () => {
      const due = await claimDueReminders(1);
      if (due.length === 0) return;
      // One drain job per minute window; concurrent instances dedupe on the key.
      const windowKey = Math.floor(Date.now() / TICK_INTERVAL_MS);
      await enqueueJob({
        queueName: COMMS_REMINDER_QUEUE,
        workloadClass: "maintenance",
        payload: {},
        dedupeKey: `comms:reminder:drain:${windowKey}`,
        priority: 200,
        maxAttempts: 3,
      });
    });
  } catch (err: any) {
    console.error("[CommsReminder] Tick error:", err?.message);
  }
}

function scheduleTick(): void {
  tickTimer = setTimeout(async () => {
    await runReminderTick();
    scheduleTick();
  }, TICK_INTERVAL_MS);
}

export function startCommsReminderScheduler(): void {
  setTimeout(async () => {
    await runReminderTick();
    scheduleTick();
  }, 7_000);
}

export function stopCommsReminderScheduler(): void {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleCommsReminderDeliver(_job: WorkQueueJob): Promise<void> {
  const reminders = await claimDueReminders(BATCH_SIZE);
  if (reminders.length === 0) return;

  await Promise.all(
    reminders.map(async (r) => {
      try {
        const deepLink = `/comms?channel=${r.channelId}&message=${r.messageId}`;
        await notifyUser(r.userId, {
          category: "system",
          title: "Reminder: message in your Comms",
          body: r.note ? r.note : "You set a reminder for a message.",
          deepLink,
          dedupeKey: `comms:reminder:${r.id}`,
        });
        await markReminderDelivered(r.id);
      } catch (err: any) {
        console.error(`[CommsReminder] Failed to deliver reminder ${r.id}:`, err?.message);
      }
    }),
  );
}
