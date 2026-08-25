// @db-pool-intent: ambient
//
// Task #5096 — book-commerce persistence, ENGAGEMENT slice
// (buyer bonus-qualification applications, appointments, provider correlations).
//
// Every getDb() call in this module lands on the ambient API pool.
// See scripts/lint-db-pool-tenancy.ts for the contract and server/db.ts
// for the routing.
//
// Invariants owned in the ENGAGEMENT slice:
//
//   - Qualification applications are conflict-safe on the REQUIRED idempotencyKey
//     (return existing on replay). Initial status is draft. Transitions validate
//     the shared legal map (illegal / same-state throw before DB mutation) and
//     use a CAS; submitted stamps submittedAt, qualified/not_qualified stamps
//     decidedAt + decisionReason. Lifecycle + outbox rows are appended
//     transactionally with deterministic keys.
//
//   - Appointments upsert by the REQUIRED auditApplicationId using the matching
//     partial-unique index (targetWhere), so reschedules update the same row and
//     never create duplicates. Transitions validate the shared legal map and CAS.
//     Booked/cancelled changes append lifecycle + outbox rows transactionally.
//
//   - Provider correlations insert conflict-safe on the composite
//     (provider, provider_entity_type, provider_entity_id). A replay with the
//     SAME local mapping returns the existing row (inserted: false); the same
//     external ID mapping to a DIFFERENT local entity throws
//     CorrelationConflictError rather than silently accepting it.

import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookAuditApplications,
  bookAppointments,
  bookProviderCorrelations,
  bookOrders,
  bookContacts,
  scheduledMeetings,
  users,
  bookEntitlements,
  bookAuditApplicationStatuses,
  bookAppointmentStatuses,
  isValidBookAuditApplicationTransition,
  isValidBookAppointmentTransition,
  type BookAuditApplication,
  type BookAuditApplicationStatus,
  type BookAppointment,
  type BookAppointmentStatus,
  type BookProviderCorrelation,
  type BookLifecycleEvent,
  type BookOutboxEntry,
  type BookLifecycleEventType,
  type BookOutboxEventType,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import {
  bookCommerceLabel,
  insertLifecycleEventTx,
  insertOutboxTx,
  IllegalTransitionError,
  IncompleteAggregateError,
  IdempotencyConflictError,
  CorrelationConflictError,
} from "./bookCommerceStorage";

// ═══════════════════════════════════════════════════════════════════════════
// 8. Qualification application — create (idempotent) + legal transition
// ═══════════════════════════════════════════════════════════════════════════

export const createAuditApplicationSchema = z.object({
  contactId: z.string().min(1),
  orderId: z.string().optional().nullable(),
  /** Required, globally unique — returns the existing row on replay. */
  idempotencyKey: z.string().min(1).max(128),
  answers: z.record(z.unknown()).optional().nullable(),
  consentEvidenceRef: z.string().max(256).optional().nullable(),
});
export type CreateAuditApplicationInput = z.infer<typeof createAuditApplicationSchema>;

export interface CreateAuditApplicationResult {
  application: BookAuditApplication;
  /** True when a new row was created; false on idempotent replay. */
  created: boolean;
}

/**
 * Create a qualification application (status draft), conflict-safe on the
 * required idempotencyKey.
 *
 * When orderId is provided the order is loaded and its contactId must equal the
 * submitted contactId (else IdempotencyConflictError). On idempotency replay
 * the existing row's contactId and orderId must match the request, otherwise
 * IdempotencyConflictError. Never returns undefined under the non-null type.
 */
export async function createBookAuditApplication(
  raw: CreateAuditApplicationInput,
): Promise<CreateAuditApplicationResult> {
  const input = createAuditApplicationSchema.parse(raw);

  return withDbAttribution(bookCommerceLabel("application-create"), async () => {
    const db = getDb();

    // Relationship integrity: an order-linked application must belong to the
    // order's contact.
    if (input.orderId) {
      const [order] = await db
        .select({ contactId: bookOrders.contactId })
        .from(bookOrders)
        .where(eq(bookOrders.id, input.orderId))
        .limit(1);
      if (!order) {
        throw new IdempotencyConflictError(
          "audit-application",
          input.idempotencyKey,
          `orderId ${input.orderId} does not exist`,
        );
      }
      if (order.contactId !== input.contactId) {
        throw new IdempotencyConflictError(
          "audit-application",
          input.idempotencyKey,
          `order ${input.orderId} belongs to contact ${order.contactId}, not ${input.contactId}`,
        );
      }
    }

    const [inserted] = await db
      .insert(bookAuditApplications)
      .values({
        contactId: input.contactId,
        orderId: input.orderId ?? null,
        idempotencyKey: input.idempotencyKey,
        status: "draft",
        answers: input.answers ?? null,
        consentEvidenceRef: input.consentEvidenceRef ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return { application: inserted, created: true };
    }

    const [existing] = await db
      .select()
      .from(bookAuditApplications)
      .where(eq(bookAuditApplications.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (!existing) {
      throw new IncompleteAggregateError(
        `audit application insert conflicted on idempotencyKey ${input.idempotencyKey} but no existing row was found`,
      );
    }
    if (existing.contactId !== input.contactId) {
      throw new IdempotencyConflictError(
        "audit-application",
        input.idempotencyKey,
        `existing contactId ${existing.contactId} != requested ${input.contactId}`,
      );
    }
    if ((existing.orderId ?? null) !== (input.orderId ?? null)) {
      throw new IdempotencyConflictError(
        "audit-application",
        input.idempotencyKey,
        `existing orderId ${existing.orderId} != requested ${input.orderId ?? null}`,
      );
    }
    return { application: existing, created: false };
  });
}

/**
 * Resolve an EXISTING audit application for a contact, for signed-webhook
 * appointment bootstrap. NEVER creates one.
 *
 * Resolution order (most-deterministic first):
 *   1. Exact match on the deterministic idempotencyKey (a prior bootstrap of
 *      the SAME GHL appointment) — the strongest signal.
 *   2. Otherwise the most recent qualified/submitted application for the
 *      contact (an application that legitimately reached a bookable stage).
 *
 * Returns null when neither exists — the caller must then treat the event as
 * needing operator reconciliation (retryable 500) rather than fabricating a
 * brand-new application for a signed external event.
 */
export async function resolveBookAuditApplicationForBootstrap(params: {
  contactId: string;
  deterministicIdempotencyKey: string;
}): Promise<BookAuditApplication | null> {
  return withDbAttribution(
    bookCommerceLabel("application-resolve-bootstrap"),
    async () => {
      const db = getDb();

      // 1. Deterministic key match (prior bootstrap of the same appointment).
      const [byKey] = await db
        .select()
        .from(bookAuditApplications)
        .where(
          eq(
            bookAuditApplications.idempotencyKey,
            params.deterministicIdempotencyKey,
          ),
        )
        .limit(1);
      if (byKey) {
        // Guard: the deterministic-key row must belong to this contact.
        if (byKey.contactId === params.contactId) return byKey;
        return null;
      }

      // 2. Most recent qualified/submitted application for the contact.
      const [byContact] = await db
        .select()
        .from(bookAuditApplications)
        .where(
          and(
            eq(bookAuditApplications.contactId, params.contactId),
            inArray(bookAuditApplications.status, ["qualified", "submitted"]),
          ),
        )
        .orderBy(sql`${bookAuditApplications.createdAt} DESC`)
        .limit(1);
      return byContact ?? null;
    },
  );
}

export const transitionAuditApplicationSchema = z.object({
  applicationId: z.string().min(1),
  fromStatus: z.enum(bookAuditApplicationStatuses),
  toStatus: z.enum(bookAuditApplicationStatuses),
  actorUserId: z.string().optional().nullable(),
  /**
   * Required for terminal decisions. The buyer journey also records its
   * immutable pending/manual routing marker on the draft → submitted edge so a
   * crash can resume without re-evaluating newer policy or different answers.
   */
  decisionReason: z.string().max(1000).optional().nullable(),
  /** Accepted only on the draft → submitted edge; route schemas own field bounds. */
  answers: z.record(z.unknown()).optional(),
});
export type TransitionAuditApplicationInput = z.infer<typeof transitionAuditApplicationSchema>;

export interface TransitionAuditApplicationResult {
  transitioned: boolean;
  application: BookAuditApplication | null;
  lifecycleEvent: BookLifecycleEvent | null;
  outboxEntry: BookOutboxEntry | null;
}

const APPLICATION_LIFECYCLE: Record<BookAuditApplicationStatus, BookLifecycleEventType | null> = {
  draft: null,
  submitted: "application_submitted",
  qualified: "application_qualified",
  not_qualified: "application_not_qualified",
  withdrawn: "application_withdrawn",
};

const APPLICATION_OUTBOX: Partial<Record<BookAuditApplicationStatus, BookOutboxEventType>> = {
  submitted: "application.submitted",
  qualified: "application.qualified",
  not_qualified: "application.not_qualified",
};

export function applicationTransitionLifecycleKey(
  applicationId: string,
  from: BookAuditApplicationStatus,
  to: BookAuditApplicationStatus,
): string {
  return `application-transition:${applicationId}:${from}:${to}`;
}
export function applicationTransitionOutboxKey(
  applicationId: string,
  from: BookAuditApplicationStatus,
  to: BookAuditApplicationStatus,
): string {
  return `application-transition:${applicationId}:${from}:${to}`;
}

/**
 * Legally transition a qualification application. Validates the shared legal
 * map before the DB write (illegal / same-state throws). CAS on the current
 * status; submitted stamps submittedAt; qualified/not_qualified stamps
 * decidedAt + decisionReason. Lifecycle + outbox rows (when the target status
 * fans out) are appended transactionally with deterministic keys.
 */
export async function transitionBookAuditApplication(
  raw: TransitionAuditApplicationInput,
): Promise<TransitionAuditApplicationResult> {
  const input = transitionAuditApplicationSchema.parse(raw);

  if (!isValidBookAuditApplicationTransition(input.fromStatus, input.toStatus)) {
    throw new IllegalTransitionError("application", input.fromStatus, input.toStatus);
  }

  const now = new Date();
  const isDecision = input.toStatus === "qualified" || input.toStatus === "not_qualified";

  const result = await withDbAttribution(bookCommerceLabel("application-transition"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookAuditApplications)
        .set({
          status: input.toStatus,
          submittedAt:
            input.toStatus === "submitted"
              ? now
              : sql`${bookAuditApplications.submittedAt}`,
          decidedAt: isDecision ? now : sql`${bookAuditApplications.decidedAt}`,
          decisionReason:
            isDecision ||
            (input.toStatus === "submitted" && input.decisionReason !== undefined)
              ? input.decisionReason ?? null
              : sql`${bookAuditApplications.decisionReason}`,
          answers:
            input.toStatus === "submitted" && input.answers !== undefined
              ? input.answers
              : sql`${bookAuditApplications.answers}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bookAuditApplications.id, input.applicationId),
            eq(bookAuditApplications.status, input.fromStatus),
          ),
        )
        .returning();

      if (!updated) {
        return { transitioned: false, application: null, lifecycleEvent: null, outboxEntry: null };
      }

      const lifecycleType = APPLICATION_LIFECYCLE[input.toStatus];
      let lifecycleEvent: BookLifecycleEvent | null = null;
      if (lifecycleType) {
        lifecycleEvent = await insertLifecycleEventTx(tx, {
          contactId: updated.contactId,
          orderId: updated.orderId,
          eventType: lifecycleType,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          actorUserId: input.actorUserId ?? null,
          reason: input.decisionReason ?? null,
          idempotencyKey: applicationTransitionLifecycleKey(
            updated.id,
            input.fromStatus,
            input.toStatus,
          ),
        });
      }

      const outboxType = APPLICATION_OUTBOX[input.toStatus];
      let outboxEntry: BookOutboxEntry | null = null;
      if (outboxType) {
        outboxEntry = await insertOutboxTx(tx, {
          eventType: outboxType,
          sourceType: "application",
          sourceId: updated.id,
          payload: {
            applicationId: updated.id,
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
            decisionReason: input.decisionReason ?? null,
          },
          idempotencyKey: applicationTransitionOutboxKey(
            updated.id,
            input.fromStatus,
            input.toStatus,
          ),
        });
      }

      return { transitioned: true, application: updated, lifecycleEvent, outboxEntry };
    });
  });

  if (result.outboxEntry) {
    const { kickGhlOutboundSyncFireAndForget } = await import("../services/ghlOutboundKick");
    kickGhlOutboundSyncFireAndForget();
  }
  return result;
}

export interface BookBuyerCheckoutContext {
  contactId: string;
  orderId: string;
  email: string;
  name: string | null;
  attribution: {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmTerm: string | null;
    utmContent: string | null;
  };
}

export async function findBookBuyerCheckoutContext(
  checkoutSessionId: string,
): Promise<BookBuyerCheckoutContext | null> {
  return withDbAttribution(bookCommerceLabel("buyer-journey-checkout-context"), async () => {
    const [row] = await getDb()
      .select({
        contactId: bookContacts.id,
        orderId: bookOrders.id,
        email: bookContacts.email,
        name: bookContacts.name,
        utmSource: bookOrders.latestTouchUtmSource,
        utmMedium: bookOrders.latestTouchUtmMedium,
        utmCampaign: bookOrders.latestTouchUtmCampaign,
        utmTerm: bookOrders.latestTouchUtmTerm,
        utmContent: bookOrders.latestTouchUtmContent,
      })
      .from(bookOrders)
      .innerJoin(bookContacts, eq(bookOrders.contactId, bookContacts.id))
      .where(eq(bookOrders.checkoutSessionId, checkoutSessionId))
      .limit(1);
    if (!row) return null;
    return {
      contactId: row.contactId,
      orderId: row.orderId,
      email: row.email,
      name: row.name,
      attribution: {
        utmSource: row.utmSource,
        utmMedium: row.utmMedium,
        utmCampaign: row.utmCampaign,
        utmTerm: row.utmTerm,
        utmContent: row.utmContent,
      },
    };
  });
}

export interface BookBuyerJourneyState {
  application: BookAuditApplication;
  buyer: {
    email: string;
    name: string | null;
    attribution: BookBuyerCheckoutContext["attribution"];
  };
  appointment: {
    status: BookAppointmentStatus;
    scheduledAt: Date | null;
    endAt: Date | null;
    timezone: string | null;
    meetingTypeName: string | null;
    hostName: string | null;
    meetingLink: string | null;
  } | null;
}

export async function getBookBuyerJourneyState(
  applicationId: string,
): Promise<BookBuyerJourneyState | null> {
  return withDbAttribution(bookCommerceLabel("buyer-journey-state"), async () => {
    const [row] = await getDb()
      .select({
        application: bookAuditApplications,
        email: bookContacts.email,
        name: bookContacts.name,
        utmSource: bookOrders.latestTouchUtmSource,
        utmMedium: bookOrders.latestTouchUtmMedium,
        utmCampaign: bookOrders.latestTouchUtmCampaign,
        utmTerm: bookOrders.latestTouchUtmTerm,
        utmContent: bookOrders.latestTouchUtmContent,
        appointmentStatus: bookAppointments.status,
        appointmentScheduledAt: bookAppointments.scheduledAt,
        appointmentTimezone: bookAppointments.timezone,
        meetingEndAt: scheduledMeetings.endTimeUtc,
        meetingTypeName: scheduledMeetings.meetingTypeName,
        hostFirstName: users.firstName,
        hostLastName: users.lastName,
        meetingLink: scheduledMeetings.zoomJoinUrl,
      })
      .from(bookAuditApplications)
      .innerJoin(bookContacts, eq(bookAuditApplications.contactId, bookContacts.id))
      .leftJoin(bookOrders, eq(bookAuditApplications.orderId, bookOrders.id))
      .leftJoin(
        bookAppointments,
        eq(bookAppointments.auditApplicationId, bookAuditApplications.id),
      )
      .leftJoin(
        scheduledMeetings,
        eq(bookAppointments.scheduledMeetingId, scheduledMeetings.id),
      )
      .leftJoin(users, eq(scheduledMeetings.accountManagerUserId, users.id))
      .where(eq(bookAuditApplications.id, applicationId))
      .limit(1);
    if (!row) return null;
    return {
      application: row.application,
      buyer: {
        email: row.email,
        name: row.name,
        attribution: {
          utmSource: row.utmSource,
          utmMedium: row.utmMedium,
          utmCampaign: row.utmCampaign,
          utmTerm: row.utmTerm,
          utmContent: row.utmContent,
        },
      },
      appointment: row.appointmentStatus
        ? {
            status: row.appointmentStatus as BookAppointmentStatus,
            scheduledAt: row.appointmentScheduledAt,
            endAt: row.meetingEndAt,
            timezone: row.appointmentTimezone,
            meetingTypeName: row.meetingTypeName,
            hostName:
              [row.hostFirstName, row.hostLastName].filter(Boolean).join(" ").trim() ||
              null,
            meetingLink: row.meetingLink,
          }
        : null,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Appointment — upsert by auditApplicationId + legal transition
// ═══════════════════════════════════════════════════════════════════════════

export const upsertAppointmentSchema = z.object({
  /** Required — the partial-unique key that converges reschedules to one row. */
  auditApplicationId: z.string().min(1),
  /** Optional; when set, must belong to the application's order. */
  entitlementId: z.string().optional().nullable(),
  scheduledMeetingId: z.string().optional().nullable(),
  scheduledAt: z.date().optional().nullable(),
  timezone: z.string().max(64).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  // NOTE: contactId + orderId are derived from the audit application.
});
export type UpsertAppointmentInput = z.infer<typeof upsertAppointmentSchema>;

export interface UpsertAppointmentResult {
  appointment: BookAppointment;
  /** True when a new row was created (RETURNING xmax = 0). */
  created: boolean;
}

/**
 * Upsert an appointment keyed on auditApplicationId, using the matching
 * partial-unique index (targetWhere: audit_application_id IS NOT NULL).
 *
 * contactId and orderId are DERIVED from the required audit application (never
 * caller-supplied). When entitlementId is supplied it must belong to that
 * application's order (else IdempotencyConflictError). A reschedule updates the
 * SAME row's scheduling fields; identity columns (contactId/orderId/
 * auditApplicationId) are NEVER in the conflict SET, so they cannot be remapped.
 * Status is not changed here — use transitionBookAppointment.
 */
export async function upsertBookAppointment(
  raw: UpsertAppointmentInput,
): Promise<UpsertAppointmentResult> {
  const input = upsertAppointmentSchema.parse(raw);

  return withDbAttribution(bookCommerceLabel("appointment-upsert"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      const [application] = await tx
        .select({
          id: bookAuditApplications.id,
          contactId: bookAuditApplications.contactId,
          orderId: bookAuditApplications.orderId,
        })
        .from(bookAuditApplications)
        .where(eq(bookAuditApplications.id, input.auditApplicationId))
        .limit(1);

      if (!application) {
        throw new IdempotencyConflictError(
          "appointment",
          input.auditApplicationId,
          "audit application does not exist",
        );
      }

      const derivedContactId = application.contactId;
      const derivedOrderId = application.orderId;

      // If an entitlement is supplied, it must belong to the application order.
      if (input.entitlementId) {
        const [ent] = await tx
          .select({ orderId: bookEntitlements.orderId })
          .from(bookEntitlements)
          .where(eq(bookEntitlements.id, input.entitlementId))
          .limit(1);
        if (!ent) {
          throw new IdempotencyConflictError(
            "appointment",
            input.auditApplicationId,
            `entitlementId ${input.entitlementId} does not exist`,
          );
        }
        if (!derivedOrderId || ent.orderId !== derivedOrderId) {
          throw new IdempotencyConflictError(
            "appointment",
            input.auditApplicationId,
            `entitlement ${input.entitlementId} (order ${ent.orderId}) does not belong to application order ${derivedOrderId}`,
          );
        }
      }

      const rows = await tx
        .insert(bookAppointments)
        .values({
          auditApplicationId: input.auditApplicationId,
          contactId: derivedContactId ?? null,
          orderId: derivedOrderId ?? null,
          entitlementId: input.entitlementId ?? null,
          scheduledMeetingId: input.scheduledMeetingId ?? null,
          status: "pending",
          scheduledAt: input.scheduledAt ?? null,
          timezone: input.timezone ?? null,
          notes: input.notes ?? null,
        })
        .onConflictDoUpdate({
          target: bookAppointments.auditApplicationId,
          targetWhere: sql`audit_application_id IS NOT NULL`,
          set: {
            // Identity columns intentionally absent — never remapped.
            entitlementId:
              input.entitlementId !== undefined
                ? input.entitlementId
                : sql`${bookAppointments.entitlementId}`,
            scheduledMeetingId:
              input.scheduledMeetingId !== undefined
                ? input.scheduledMeetingId
                : sql`${bookAppointments.scheduledMeetingId}`,
            scheduledAt:
              input.scheduledAt !== undefined
                ? input.scheduledAt
                : sql`${bookAppointments.scheduledAt}`,
            timezone:
              input.timezone !== undefined
                ? input.timezone
                : sql`${bookAppointments.timezone}`,
            notes:
              input.notes !== undefined ? input.notes : sql`${bookAppointments.notes}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({
          ...getTableColumns(bookAppointments),
          inserted: sql<boolean>`(xmax = 0)`,
        });

      const { inserted, ...appointment } = rows[0];
      return { appointment: appointment as BookAppointment, created: inserted };
    });
  });
}

export const updateAppointmentScheduleSchema = z.object({
  appointmentId: z.string().min(1),
  scheduledAt: z.date().optional().nullable(),
  timezone: z.string().max(64).optional().nullable(),
});
export type UpdateAppointmentScheduleInput = z.infer<
  typeof updateAppointmentScheduleSchema
>;

export interface UpdateAppointmentScheduleResult {
  appointment: BookAppointment | null;
  /** True when scheduledAt or timezone actually changed on the row. */
  updated: boolean;
}

/**
 * Reschedule an EXISTING appointment WITHOUT a status transition.
 *
 * Used by the GHL inbound webhook when an AppointmentUpdate arrives with the
 * SAME mapped status but a changed startTime/timezone: that is a reschedule,
 * not a state change. Only the scheduling columns are touched; status,
 * identity columns, cancelledAt/Reason, and lifecycle/outbox are all left
 * untouched (rescheduling within the same status is not a lifecycle event).
 *
 * Returns `updated: false` (no-op) when neither field differs from the row,
 * so replays and no-change updates never churn updatedAt spuriously.
 */
export async function updateBookAppointmentSchedule(
  raw: UpdateAppointmentScheduleInput,
): Promise<UpdateAppointmentScheduleResult> {
  const input = updateAppointmentScheduleSchema.parse(raw);

  return withDbAttribution(
    bookCommerceLabel("appointment-reschedule"),
    async () => {
      const db = getDb();

      const [current] = await db
        .select({
          id: bookAppointments.id,
          scheduledAt: bookAppointments.scheduledAt,
          timezone: bookAppointments.timezone,
        })
        .from(bookAppointments)
        .where(eq(bookAppointments.id, input.appointmentId))
        .limit(1);

      if (!current) {
        return { appointment: null, updated: false };
      }

      const nextScheduledAt =
        input.scheduledAt !== undefined ? input.scheduledAt : current.scheduledAt;
      const nextTimezone =
        input.timezone !== undefined ? input.timezone : current.timezone;

      const scheduleChanged =
        (nextScheduledAt?.getTime() ?? null) !==
          (current.scheduledAt?.getTime() ?? null) ||
        (nextTimezone ?? null) !== (current.timezone ?? null);

      if (!scheduleChanged) {
        const [row] = await db
          .select()
          .from(bookAppointments)
          .where(eq(bookAppointments.id, input.appointmentId))
          .limit(1);
        return { appointment: row ?? null, updated: false };
      }

      const [updated] = await db
        .update(bookAppointments)
        .set({
          scheduledAt:
            input.scheduledAt !== undefined
              ? input.scheduledAt
              : sql`${bookAppointments.scheduledAt}`,
          timezone:
            input.timezone !== undefined
              ? input.timezone
              : sql`${bookAppointments.timezone}`,
          updatedAt: sql`now()`,
        })
        .where(eq(bookAppointments.id, input.appointmentId))
        .returning();

      return { appointment: updated ?? null, updated: true };
    },
  );
}

export const transitionAppointmentSchema = z.object({
  appointmentId: z.string().min(1),
  fromStatus: z.enum(bookAppointmentStatuses),
  toStatus: z.enum(bookAppointmentStatuses),
  actorUserId: z.string().optional().nullable(),
  scheduledMeetingId: z.string().optional().nullable(),
  scheduledAt: z.date().optional().nullable(),
  timezone: z.string().max(64).optional().nullable(),
  cancelledReason: z.string().max(1000).optional().nullable(),
});
export type TransitionAppointmentInput = z.infer<typeof transitionAppointmentSchema>;

export interface TransitionAppointmentResult {
  transitioned: boolean;
  appointment: BookAppointment | null;
  lifecycleEvent: BookLifecycleEvent | null;
  outboxEntry: BookOutboxEntry | null;
}

const APPOINTMENT_LIFECYCLE: Record<BookAppointmentStatus, BookLifecycleEventType | null> = {
  pending: null,
  scheduled: "appointment_scheduled",
  completed: "appointment_completed",
  cancelled: "appointment_cancelled",
  no_show: "appointment_no_show",
};

const APPOINTMENT_OUTBOX: Partial<Record<BookAppointmentStatus, BookOutboxEventType>> = {
  scheduled: "appointment.scheduled",
  cancelled: "appointment.cancelled",
  // Task #5105 — terminal appointment states needed by GHL lifecycle sync
  completed: "appointment.completed",
  no_show: "appointment.no_show",
};

export function appointmentTransitionLifecycleKey(
  appointmentId: string,
  from: BookAppointmentStatus,
  to: BookAppointmentStatus,
): string {
  return `appointment-transition:${appointmentId}:${from}:${to}`;
}
export function appointmentTransitionOutboxKey(
  appointmentId: string,
  from: BookAppointmentStatus,
  to: BookAppointmentStatus,
): string {
  return `appointment-transition:${appointmentId}:${from}:${to}`;
}

/**
 * Legally transition an appointment. Validates the shared legal map before the
 * DB write (illegal / same-state throws). CAS on the current status, persisting
 * scheduledMeetingId / scheduledAt / timezone on a (re)schedule and
 * cancelledAt / cancelledReason on cancel. Booked (scheduled) and cancelled
 * changes append lifecycle + outbox rows transactionally with deterministic keys.
 */
export async function transitionBookAppointment(
  raw: TransitionAppointmentInput,
): Promise<TransitionAppointmentResult> {
  const input = transitionAppointmentSchema.parse(raw);

  if (!isValidBookAppointmentTransition(input.fromStatus, input.toStatus)) {
    throw new IllegalTransitionError("appointment", input.fromStatus, input.toStatus);
  }

  const now = new Date();

  const result = await withDbAttribution(bookCommerceLabel("appointment-transition"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookAppointments)
        .set({
          status: input.toStatus,
          scheduledMeetingId:
            input.scheduledMeetingId !== undefined
              ? input.scheduledMeetingId
              : sql`${bookAppointments.scheduledMeetingId}`,
          scheduledAt:
            input.scheduledAt !== undefined
              ? input.scheduledAt
              : sql`${bookAppointments.scheduledAt}`,
          timezone:
            input.timezone !== undefined
              ? input.timezone
              : sql`${bookAppointments.timezone}`,
          cancelledAt:
            input.toStatus === "cancelled"
              ? now
              : sql`${bookAppointments.cancelledAt}`,
          cancelledReason:
            input.toStatus === "cancelled"
              ? input.cancelledReason ?? null
              : sql`${bookAppointments.cancelledReason}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bookAppointments.id, input.appointmentId),
            eq(bookAppointments.status, input.fromStatus),
          ),
        )
        .returning();

      if (!updated) {
        return { transitioned: false, appointment: null, lifecycleEvent: null, outboxEntry: null };
      }

      const lifecycleType = APPOINTMENT_LIFECYCLE[input.toStatus];
      let lifecycleEvent: BookLifecycleEvent | null = null;
      if (lifecycleType) {
        lifecycleEvent = await insertLifecycleEventTx(tx, {
          contactId: updated.contactId,
          orderId: updated.orderId,
          eventType: lifecycleType,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          actorUserId: input.actorUserId ?? null,
          reason: input.cancelledReason ?? null,
          idempotencyKey: appointmentTransitionLifecycleKey(
            updated.id,
            input.fromStatus,
            input.toStatus,
          ),
        });
      }

      const outboxType = APPOINTMENT_OUTBOX[input.toStatus];
      let outboxEntry: BookOutboxEntry | null = null;
      if (outboxType) {
        outboxEntry = await insertOutboxTx(tx, {
          eventType: outboxType,
          sourceType: "appointment",
          sourceId: updated.id,
          payload: {
            appointmentId: updated.id,
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
          },
          idempotencyKey: appointmentTransitionOutboxKey(
            updated.id,
            input.fromStatus,
            input.toStatus,
          ),
        });
      }

      return { transitioned: true, appointment: updated, lifecycleEvent, outboxEntry };
    });
  });

  if (result.outboxEntry) {
    const { kickGhlOutboundSyncFireAndForget } = await import("../services/ghlOutboundKick");
    kickGhlOutboundSyncFireAndForget();
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Provider correlation — conflict-safe insert with conflict detection
// ═══════════════════════════════════════════════════════════════════════════

export const insertProviderCorrelationSchema = z.object({
  provider: z.string().min(1).max(64),
  providerEntityType: z.string().min(1).max(128),
  providerEntityId: z.string().min(1).max(256),
  localEntityType: z.string().min(1).max(64),
  localEntityId: z.string().min(1).max(128),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type InsertProviderCorrelationInput = z.infer<typeof insertProviderCorrelationSchema>;

export interface InsertProviderCorrelationResult {
  correlation: BookProviderCorrelation;
  /** True when a new row was created; false on same-mapping replay. */
  inserted: boolean;
}

/**
 * Conflict-safe provider correlation insert on the composite
 * (provider, provider_entity_type, provider_entity_id).
 *
 *   - fresh insert                → { inserted: true }
 *   - replay with SAME local pair → { inserted: false } (existing row)
 *   - same external ID → DIFFERENT local entity → throws CorrelationConflictError
 */
export async function insertBookProviderCorrelation(
  raw: InsertProviderCorrelationInput,
): Promise<InsertProviderCorrelationResult> {
  const input = insertProviderCorrelationSchema.parse(raw);

  return withDbAttribution(bookCommerceLabel("provider-correlation-insert"), async () => {
    const db = getDb();

    const [inserted] = await db
      .insert(bookProviderCorrelations)
      .values({
        provider: input.provider,
        providerEntityType: input.providerEntityType,
        providerEntityId: input.providerEntityId,
        localEntityType: input.localEntityType,
        localEntityId: input.localEntityId,
        metadata: input.metadata ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return { correlation: inserted, inserted: true };
    }

    const [existing] = await db
      .select()
      .from(bookProviderCorrelations)
      .where(
        and(
          eq(bookProviderCorrelations.provider, input.provider),
          eq(bookProviderCorrelations.providerEntityType, input.providerEntityType),
          eq(bookProviderCorrelations.providerEntityId, input.providerEntityId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new IncompleteAggregateError(
        `provider correlation insert conflicted (${input.provider}/${input.providerEntityType}/${input.providerEntityId}) but no existing row was found`,
      );
    }

    // Same external ID must map to the same local entity, else it is a conflict.
    if (
      existing.localEntityType !== input.localEntityType ||
      existing.localEntityId !== input.localEntityId
    ) {
      throw new CorrelationConflictError(
        input.provider,
        input.providerEntityType,
        input.providerEntityId,
        `${existing.localEntityType}:${existing.localEntityId}`,
        `${input.localEntityType}:${input.localEntityId}`,
      );
    }

    return { correlation: existing, inserted: false };
  });
}

// Re-export shared status types for consumers of this slice.
export type {
  BookAuditApplication,
  BookAuditApplicationStatus,
  BookAppointment,
  BookAppointmentStatus,
  BookProviderCorrelation,
};
