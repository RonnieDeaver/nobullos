// @db-pool-intent: api
/**
 * Service Desk routes — workflow status machine & event helpers.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: STATUS, TRANSITIONS, REQUIRES_WAITING_ON, recordEvent, updateMirrorStatus.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import { getDb, withDbAttribution } from "../../db";
import { sdTicketEvents, clickupTasks } from "@shared/schema";
import { eq } from "drizzle-orm";

// ─── Workflow action helpers ───────────────────────────────────────────────

/** Status names as they appear in ClickUp (must match exactly). */
export const STATUS = {
  SUBMITTED: "submitted",
  SCHEDULED: "scheduled",
  IN_PROGRESS: "in progress",
  NEEDS_INFO: "needs information",
  WAITING_AM: "waiting on account manager",
  WAITING_CLIENT: "waiting on client",
  WAITING_APPROVAL: "waiting on approval",
  BLOCKED: "blocked",
  QUALITY_REVIEW: "quality review",
  DELIVERED: "delivered",
  CLOSED: "closed",
  REOPENED: "reopened",
  OUT_OF_SCOPE: "out of scope",
  CANCELED: "canceled",
  DUPLICATE: "duplicate",
} as const;

/** Allowed next statuses from each current status. */
export const TRANSITIONS: Record<string, string[]> = {
  [STATUS.SUBMITTED]: [STATUS.SCHEDULED, STATUS.CANCELED, STATUS.DUPLICATE],
  [STATUS.SCHEDULED]: [STATUS.IN_PROGRESS, STATUS.NEEDS_INFO, STATUS.CANCELED, STATUS.DUPLICATE, STATUS.OUT_OF_SCOPE],
  [STATUS.IN_PROGRESS]: [STATUS.NEEDS_INFO, STATUS.WAITING_AM, STATUS.WAITING_CLIENT, STATUS.WAITING_APPROVAL, STATUS.BLOCKED, STATUS.QUALITY_REVIEW, STATUS.CANCELED],
  [STATUS.NEEDS_INFO]: [STATUS.SCHEDULED, STATUS.IN_PROGRESS, STATUS.CANCELED],
  [STATUS.WAITING_AM]: [STATUS.SCHEDULED, STATUS.IN_PROGRESS, STATUS.CANCELED],
  [STATUS.WAITING_CLIENT]: [STATUS.WAITING_AM, STATUS.CANCELED],
  [STATUS.WAITING_APPROVAL]: [STATUS.SCHEDULED, STATUS.IN_PROGRESS, STATUS.CANCELED],
  [STATUS.BLOCKED]: [STATUS.SCHEDULED, STATUS.IN_PROGRESS, STATUS.CANCELED],
  [STATUS.QUALITY_REVIEW]: [STATUS.DELIVERED, STATUS.IN_PROGRESS, STATUS.CANCELED],
  [STATUS.DELIVERED]: [STATUS.CLOSED, STATUS.REOPENED],
  [STATUS.CLOSED]: [STATUS.REOPENED],
  [STATUS.REOPENED]: [STATUS.SCHEDULED, STATUS.IN_PROGRESS],
  [STATUS.OUT_OF_SCOPE]: [],
  [STATUS.CANCELED]: [],
  [STATUS.DUPLICATE]: [],
};

/** Statuses requiring waiting-on metadata in the request body. */
export const REQUIRES_WAITING_ON: Set<string> = new Set([
  STATUS.WAITING_AM, STATUS.WAITING_CLIENT, STATUS.WAITING_APPROVAL, STATUS.BLOCKED,
]);

export async function recordEvent(
  taskId: string,
  eventType: string,
  actorUserId: string | null,
  data: Record<string, any>,
): Promise<void> {
  await withDbAttribution("serviceDesk:recordEvent", async () => {
    const db = getDb();
    await db.insert(sdTicketEvents).values({
      clickupTaskId: taskId,
      eventType,
      actorUserId: actorUserId ?? undefined,
      data,
    } as any);
  });
}

export async function updateMirrorStatus(taskId: string, status: string): Promise<void> {
  await withDbAttribution("serviceDesk:mirrorStatus", async () => {
    const db = getDb();
    await db
      .update(clickupTasks)
      .set({ status, dateUpdated: String(Date.now()), updatedAt: new Date() })
      .where(eq(clickupTasks.id, taskId));
  });
}
