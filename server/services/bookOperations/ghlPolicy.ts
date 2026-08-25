/**
 * Book Operations projection of the GHL relay ownership boundary.
 *
 * LOCKSTEP: this literal list must match GHL_HANDLED_EVENT_TYPES in
 * server/services/ghlOutboundSync.ts. The worker's source-scan contract
 * requires its own literal, so Book Operations centralizes its one local copy
 * here rather than importing the worker and its runtime dependencies.
 */
import { sql, type SQL } from "drizzle-orm";
import type { BookOutboxEventType } from "@shared/schema";

export const GHL_OPS_HANDLED_EVENT_TYPES: readonly BookOutboxEventType[] = [
  "checkout.recoverable",
  "checkout.completed",
  "order.payment_captured",
  "order.partially_refunded",
  "application.submitted",
  "application.qualified",
  "application.not_qualified",
  "appointment.scheduled",
  "appointment.cancelled",
  "appointment.completed",
  "appointment.no_show",
  "order.refunded",
  "order.cancelled",
  "bonus.viewed",
  "consent.sms_updated",
];

export function isGhlOpsHandledEventType(value: string): boolean {
  return (GHL_OPS_HANDLED_EVENT_TYPES as readonly string[]).includes(value);
}

export function ghlOpsHandledEventTypesSql(): SQL {
  return sql.join(
    GHL_OPS_HANDLED_EVENT_TYPES.map((eventType) => sql`${eventType}`),
    sql`, `,
  );
}

export function ghlOpsHandledEventTypesLiteral(): string {
  return GHL_OPS_HANDLED_EVENT_TYPES.map((eventType) => `'${eventType}'`).join(
    ", ",
  );
}