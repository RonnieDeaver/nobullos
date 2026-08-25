/**
 * Task #5096 — Book Commerce Foundation: operations tables.
 *
 * Split out of shared/models/bookCommerce.ts to keep each model file under the
 * project's 1000-line limit. This module holds the operational / downstream
 * tables of the book commerce domain:
 *   - book_payment_events        provider webhook event log
 *   - book_lifecycle_events      append-only state-transition audit
 *   - book_entitlements          order-anchored access grants
 *   - book_audit_applications    buyer bonus-qualification intake applications
 *   - book_appointments          post-purchase scheduled sessions
 *   - book_provider_correlations external provider ID ↔ local ID map
 *   - book_outbox                transactional outbox
 *
 * Dependency direction is one-way: this module imports the core tables
 * (bookContacts, bookCheckoutSessions, bookOrders) from ./bookCommerce. The
 * public @shared/schema barrel exports both modules without a reverse import.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { scheduledMeetings } from "./booking";
import {
  bookContacts,
  bookCheckoutSessions,
  bookOrders,
} from "./bookCommerce";

// ──────────────────────────────────────────────────────────────────

/**
 * book_payment_events — append-only log of provider payment webhook events.
 * Replay uniqueness is composite: (provider, provider_event_id) WHERE NOT NULL,
 * so the same event ID from two different providers never collide but replays
 * from the same provider are a DB-level no-op.
 */
export const bookPaymentEvents = pgTable(
  "book_payment_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orderId: varchar("order_id").references(() => bookOrders.id, {
      onDelete: "set null",
    }),
    checkoutSessionId: varchar("checkout_session_id").references(
      () => bookCheckoutSessions.id,
      { onDelete: "set null" },
    ),
    /** Provider name, e.g. 'stripe'. */
    provider: varchar("provider", { length: 64 }).notNull(),
    /** Provider-assigned event ID for idempotent replay. */
    providerEventId: varchar("provider_event_id", { length: 256 }),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    /** Amount in cents as reported by the provider (may differ from order total). */
    amountCents: integer("amount_cents"),
    currency: varchar("currency", { length: 3 }),
    /** Raw provider payload (stripped of PCI-sensitive fields before storage). */
    rawPayload: jsonb("raw_payload"),
    processedAt: timestamp("processed_at"),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    orderIdx: index("book_payment_events_order_id_idx").on(t.orderId),
    checkoutSessionIdx: index("book_payment_events_checkout_session_id_idx").on(
      t.checkoutSessionId,
    ),
    // Composite uniqueness: same provider_event_id from the same provider is a replay.
    providerEventUniq: uniqueIndex("book_payment_events_provider_event_uniq")
      .on(t.provider, t.providerEventId)
      .where(sql`provider_event_id IS NOT NULL`),
    createdAtIdx: index("book_payment_events_created_at_idx").on(t.createdAt),
    retentionIdx: index("book_payment_events_retention_until_idx").on(t.retentionUntil),
    amountCheck: check(
      "book_payment_events_amount_check",
      sql`amount_cents IS NULL OR amount_cents >= 0`,
    ),
  }),
);

export const insertBookPaymentEventSchema = createInsertSchema(bookPaymentEvents).omit({
  id: true,
  createdAt: true,
  retentionUntil: true,
  retentionReason: true,
});
export type InsertBookPaymentEvent = z.infer<typeof insertBookPaymentEventSchema>;
export type BookPaymentEvent = typeof bookPaymentEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_lifecycle_events — append-only state-transition and event log for the
 * book commerce domain. Never updated, never pruned (low cardinality, audit value).
 * `actor_user_id` null = system/webhook; set = operator-initiated.
 *
 * `idempotency_key` is globally unique (when non-NULL) so retry storms cannot
 * insert duplicate lifecycle entries for the same logical event.
 */
export const bookLifecycleEvents = pgTable(
  "book_lifecycle_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    contactId: varchar("contact_id").references(() => bookContacts.id, {
      onDelete: "set null",
    }),
    orderId: varchar("order_id").references(() => bookOrders.id, {
      onDelete: "set null",
    }),
    checkoutSessionId: varchar("checkout_session_id").references(
      () => bookCheckoutSessions.id,
      { onDelete: "set null" },
    ),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    /** Prior state value (for transition events). */
    fromStatus: varchar("from_status", { length: 64 }),
    /** New state value (for transition events). */
    toStatus: varchar("to_status", { length: 64 }),
    /** null = system; set = human operator. */
    actorUserId: varchar("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    /** Globally unique when non-NULL — prevents duplicate entries on retry. */
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    contactIdx: index("book_lifecycle_events_contact_id_idx").on(t.contactId),
    orderIdx: index("book_lifecycle_events_order_id_idx").on(t.orderId),
    eventTypeIdx: index("book_lifecycle_events_event_type_idx").on(t.eventType),
    createdAtIdx: index("book_lifecycle_events_created_at_idx").on(t.createdAt),
    retentionIdx: index("book_lifecycle_events_retention_until_idx").on(t.retentionUntil),
    idempotencyUniq: uniqueIndex("book_lifecycle_events_idempotency_uniq")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);

export const insertBookLifecycleEventSchema = createInsertSchema(bookLifecycleEvents).omit({
  id: true,
  createdAt: true,
  retentionUntil: true,
  retentionReason: true,
});
export type InsertBookLifecycleEvent = z.infer<typeof insertBookLifecycleEventSchema>;
export type BookLifecycleEvent = typeof bookLifecycleEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_entitlements — what a buyer is entitled to access after purchase.
 * Granted at fulfillment; revoked on refund/cancellation/manual correction.
 *
 * Design:
 *   - order_id is required (NOT NULL) — entitlements are always anchored to
 *     an order. contact_id is optional (SET NULL).
 *   - entitlement_code (e.g. 'digital_book', 'audiobook', 'print_fulfillment')
 *     drives the active-unique constraint, not package_code, because a
 *     complete order grants multiple entitlement types. package_code is an
 *     immutable snapshot of the purchased package.
 *   - Idempotency: unique(order_id, entitlement_code) WHERE status = 'active',
 *     so a complete order can hold one active 'digital_book', one 'audiobook',
 *     and one 'print_fulfillment' without collision, but the same code cannot
 *     be active twice on the same order.
 *   - A digital order grants exactly one 'digital_book' entitlement.
 */
export const bookEntitlements = pgTable(
  "book_entitlements",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Optional; SET NULL if contact is deleted. */
    contactId: varchar("contact_id")
      .references(() => bookContacts.id, { onDelete: "set null" }),
    /**
     * Required — every entitlement must trace to an order. Same-domain
     * authority link: RESTRICT (not SET NULL, which would violate NOT NULL and
     * fail parent deletes in a misleading way).
     */
    orderId: varchar("order_id")
      .references(() => bookOrders.id, { onDelete: "restrict" })
      .notNull(),
    /** Snapshot of the purchased package at grant time. */
    packageCode: varchar("package_code", { length: 32 }).notNull(),
    /**
     * What this entitlement grants access to.
     * Examples: 'digital_book', 'audiobook', 'print_fulfillment'.
     */
    entitlementCode: varchar("entitlement_code", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    /** Optional hard expiry (null = perpetual). */
    expiresAt: timestamp("expires_at"),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedReason: text("revoked_reason"),
    /** Operator who manually granted/revoked (null = system). */
    actorUserId: varchar("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    contactIdx: index("book_entitlements_contact_id_idx").on(t.contactId),
    orderIdx: index("book_entitlements_order_id_idx").on(t.orderId),
    statusIdx: index("book_entitlements_status_idx").on(t.status),
    /**
     * Idempotent grant per entitlement code per order.
     * Allows a complete order to hold digital_book + audiobook + print_fulfillment
     * as three distinct active rows, while preventing a duplicate active
     * digital_book on the same order.
     */
    orderEntitlementActiveUniq: uniqueIndex("book_entitlements_order_entitlement_active_uniq")
      .on(t.orderId, t.entitlementCode)
      .where(sql`status = 'active'`),
    packageCheck: check(
      "book_entitlements_package_check",
      sql`package_code IN ('digital','complete')`,
    ),
    entitlementCodeCheck: check(
      "book_entitlements_entitlement_code_check",
      sql`entitlement_code IN ('digital_book','audiobook','print_fulfillment')`,
    ),
    statusCheck: check(
      "book_entitlements_status_check",
      sql`status IN ('active','revoked','expired')`,
    ),
  }),
);

export const insertBookEntitlementSchema = createInsertSchema(bookEntitlements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  grantedAt: true,
  revokedAt: true,
  // Decision fields are server-stamped.
  revokedReason: true,
});
export type InsertBookEntitlement = z.infer<typeof insertBookEntitlementSchema>;
export type BookEntitlement = typeof bookEntitlements.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_delivery_assets — approved, server-configured mappings from a commerce
 * entitlement to a private object-storage key.  The key is never returned to a
 * buyer; delivery routes authorize the entitlement before opening the stream.
 *
 * Assets intentionally start disabled.  The product may sell before an
 * approved PDF/audio file is supplied, but that never turns an object path into
 * a public URL or makes a placeholder file downloadable.
 */
export const bookDeliveryAssets = pgTable(
  "book_delivery_assets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entitlementCode: varchar("entitlement_code", { length: 64 }).notNull(),
    /** PRIVATE_OBJECT_DIR-relative key. Never serialize this to buyers. */
    objectKey: text("object_key").notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 128 }).notNull(),
    maxBytes: integer("max_bytes").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("disabled"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    entitlementIdx: index("book_delivery_assets_entitlement_idx").on(t.entitlementCode),
    activeEntitlementUniq: uniqueIndex("book_delivery_assets_active_entitlement_uniq")
      .on(t.entitlementCode)
      .where(sql`status = 'active'`),
    statusCheck: check(
      "book_delivery_assets_status_check",
      sql`status IN ('active','disabled','retired')`,
    ),
    keyCheck: check(
      "book_delivery_assets_key_check",
      sql`length(object_key) > 0 AND left(object_key, 1) <> '/' AND position('..' in object_key) = 0`,
    ),
    bytesCheck: check("book_delivery_assets_max_bytes_check", sql`max_bytes > 0`),
  }),
);
export type BookDeliveryAsset = typeof bookDeliveryAssets.$inferSelect;

/**
 * book_delivery_links — one-time, purpose-bound buyer capabilities. Only a
 * SHA-256 evidence hash is stored. `idempotency_key` lets the initial and
 * support-triggered deliveries retry safely without minting duplicate emails.
 */
export const bookDeliveryLinks = pgTable(
  "book_delivery_links",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entitlementId: varchar("entitlement_id")
      .references(() => bookEntitlements.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    revokedAt: timestamp("revoked_at"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    tokenHashUniq: uniqueIndex("book_delivery_links_token_hash_uniq").on(t.tokenHash),
    idempotencyUniq: uniqueIndex("book_delivery_links_idempotency_uniq").on(t.idempotencyKey),
    entitlementExpiryIdx: index("book_delivery_links_entitlement_expiry_idx").on(
      t.entitlementId,
      t.expiresAt,
    ),
    purposeCheck: check(
      "book_delivery_links_purpose_check",
      sql`purpose IN ('initial','resend','reissue')`,
    ),
  }),
);
export type BookDeliveryLink = typeof bookDeliveryLinks.$inferSelect;

/**
 * book_delivery_sessions — browser sessions created only after a one-time link
 * exchange. The raw cookie value is never persisted and all downloads still
 * re-read the live entitlement.
 */
export const bookDeliverySessions = pgTable(
  "book_delivery_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entitlementId: varchar("entitlement_id")
      .references(() => bookEntitlements.id, { onDelete: "cascade" })
      .notNull(),
    sessionHash: varchar("session_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    sessionHashUniq: uniqueIndex("book_delivery_sessions_session_hash_uniq").on(t.sessionHash),
    entitlementExpiryIdx: index("book_delivery_sessions_entitlement_expiry_idx").on(
      t.entitlementId,
      t.expiresAt,
    ),
  }),
);
export type BookDeliverySession = typeof bookDeliverySessions.$inferSelect;

/** Append-only, safe evidence for support and buyer delivery activity. */
export const bookDeliveryAudit = pgTable(
  "book_delivery_audit",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entitlementId: varchar("entitlement_id")
      .references(() => bookEntitlements.id, { onDelete: "cascade" })
      .notNull(),
    assetId: varchar("asset_id").references(() => bookDeliveryAssets.id, {
      onDelete: "set null",
    }),
    actorUserId: varchar("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    /** Never token/email/object path/card/intake data. */
    detail: varchar("detail", { length: 400 }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    entitlementIdx: index("book_delivery_audit_entitlement_idx").on(t.entitlementId, t.createdAt),
    idempotencyUniq: uniqueIndex("book_delivery_audit_idempotency_uniq")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    outcomeCheck: check(
      "book_delivery_audit_outcome_check",
      sql`outcome IN ('accepted','denied','completed','unavailable','failed')`,
    ),
  }),
);
export type BookDeliveryAudit = typeof bookDeliveryAudit.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_audit_applications — buyer bonus-qualification / intake application.
 * Tracks whether a book buyer qualifies for a bonus program or bonus content.
 *
 * State machine: draft → submitted → qualified | not_qualified | withdrawn.
 * Terminals: qualified, not_qualified, withdrawn.
 *
 * idempotency_key is required and globally unique — one application record
 * per logical submission attempt. contact_id is required; order_id is optional.
 */
export const bookAuditApplications = pgTable(
  "book_audit_applications",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /**
     * Required — the applicant. Same-domain authority link: RESTRICT (not SET
     * NULL, which would violate NOT NULL and fail parent deletes misleadingly).
     */
    contactId: varchar("contact_id")
      .references(() => bookContacts.id, { onDelete: "restrict" })
      .notNull(),
    /** Optional link to the qualifying order. */
    orderId: varchar("order_id")
      .references(() => bookOrders.id, { onDelete: "set null" }),
    /**
     * Globally unique. Required for idempotent submit — callers that retry
     * a submission receive the existing row rather than a duplicate.
     */
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    /** Buyer-supplied qualification answers (free-form JSON). */
    answers: jsonb("answers"),
    submittedAt: timestamp("submitted_at"),
    decidedAt: timestamp("decided_at"),
    decisionReason: text("decision_reason"),
    /** Reference to external consent evidence captured at submit time. */
    consentEvidenceRef: varchar("consent_evidence_ref", { length: 256 }),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    idempotencyUniq: uniqueIndex("book_audit_applications_idempotency_uniq").on(
      t.idempotencyKey,
    ),
    contactIdx: index("book_audit_applications_contact_id_idx").on(t.contactId),
    orderIdx: index("book_audit_applications_order_id_idx").on(t.orderId),
    statusCreatedIdx: index("book_audit_applications_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    retentionIdx: index("book_audit_applications_retention_until_idx").on(t.retentionUntil),
    statusCheck: check(
      "book_audit_applications_status_check",
      sql`status IN ('draft','submitted','qualified','not_qualified','withdrawn')`,
    ),
  }),
);

export const insertBookAuditApplicationSchema = createInsertSchema(bookAuditApplications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Decision/state fields are server-owned — never set from a request body.
  submittedAt: true,
  decidedAt: true,
  decisionReason: true,
  retentionUntil: true,
  retentionReason: true,
});
export type InsertBookAuditApplication = z.infer<typeof insertBookAuditApplicationSchema>;
export type BookAuditApplication = typeof bookAuditApplications.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_appointments — scheduled sessions or follow-up appointments associated
 * with a book purchase or audit application (e.g. onboarding calls,
 * qualification interviews, coaching sessions).
 *
 * `audit_application_id` links to the qualifying application; unique WHERE NOT NULL
 * enforces exactly one appointment per application (rescheduling flows through
 * status transitions on the same row: no_show → scheduled).
 *
 * `scheduled_meeting_id` is a nullable cross-domain FK to scheduled_meetings
 * (SET NULL — booking domain owns that record).
 *
 * Status machine: pending → scheduled | cancelled;
 *                 scheduled → completed | cancelled | no_show;
 *                 no_show → scheduled (reschedule).
 * Terminals: completed, cancelled.
 */
export const bookAppointments = pgTable(
  "book_appointments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    contactId: varchar("contact_id")
      .references(() => bookContacts.id, { onDelete: "set null" }),
    orderId: varchar("order_id")
      .references(() => bookOrders.id, { onDelete: "set null" }),
    entitlementId: varchar("entitlement_id")
      .references(() => bookEntitlements.id, { onDelete: "set null" }),
    /**
     * Authority link to the qualifying audit application. Required (NOT NULL)
     * and ON DELETE RESTRICT — an appointment always belongs to an application,
     * and rescheduling converges to one row per application (unique below)
     * rather than creating multiple appointment records.
     */
    auditApplicationId: varchar("audit_application_id")
      .references(() => bookAuditApplications.id, { onDelete: "restrict" })
      .notNull(),
    /**
     * Cross-domain FK to scheduled_meetings — nullable SET NULL.
     * Populated when the appointment maps to an existing booking record.
     */
    scheduledMeetingId: varchar("scheduled_meeting_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    scheduledAt: timestamp("scheduled_at"),
    /** Timezone as IANA string (e.g. 'America/Chicago'). */
    timezone: varchar("timezone", { length: 64 }),
    notes: text("notes"),
    cancelledAt: timestamp("cancelled_at"),
    cancelledReason: text("cancelled_reason"),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    contactIdx: index("book_appointments_contact_id_idx").on(t.contactId),
    orderIdx: index("book_appointments_order_id_idx").on(t.orderId),
    statusIdx: index("book_appointments_status_idx").on(t.status),
    scheduledAtIdx: index("book_appointments_scheduled_at_idx").on(t.scheduledAt),
    meetingIdx: index("book_appointments_meeting_id_idx").on(t.scheduledMeetingId),
    retentionIdx: index("book_appointments_retention_until_idx").on(t.retentionUntil),
    // One appointment per application — reschedule via status transition, not new row.
    auditApplicationUniq: uniqueIndex("book_appointments_audit_application_uniq")
      .on(t.auditApplicationId)
      .where(sql`audit_application_id IS NOT NULL`),
    statusCheck: check(
      "book_appointments_status_check",
      sql`status IN ('pending','scheduled','completed','cancelled','no_show')`,
    ),
  }),
);

export const insertBookAppointmentSchema = createInsertSchema(bookAppointments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
  retentionUntil: true,
  retentionReason: true,
});
export type InsertBookAppointment = z.infer<typeof insertBookAppointmentSchema>;
export type BookAppointment = typeof bookAppointments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_provider_correlations — stores cross-provider reference IDs for
 * book commerce records (e.g. Stripe payment intent ID ↔ order ID, external
 * CRM contact ID ↔ book contact ID). Enables bidirectional lookup without
 * polluting core tables with vendor-specific columns.
 *
 * Unique per (provider, provider_entity_type, provider_entity_id) so the
 * same external ID can appear at most once per provider context.
 */
export const bookProviderCorrelations = pgTable(
  "book_provider_correlations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Provider name, e.g. 'stripe', 'hubspot', 'convertkit'. */
    provider: varchar("provider", { length: 64 }).notNull(),
    /** Provider-side entity type, e.g. 'payment_intent', 'customer', 'contact'. */
    providerEntityType: varchar("provider_entity_type", { length: 128 }).notNull(),
    /** Provider-side entity ID. */
    providerEntityId: varchar("provider_entity_id", { length: 256 }).notNull(),
    /** Local entity type, e.g. 'order', 'contact', 'checkout_session'. */
    localEntityType: varchar("local_entity_type", { length: 64 }).notNull(),
    /** Local entity ID. */
    localEntityId: varchar("local_entity_id", { length: 128 }).notNull(),
    metadata: jsonb("metadata"),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    providerEntityUniq: uniqueIndex("book_provider_correlations_provider_entity_uniq").on(
      t.provider,
      t.providerEntityType,
      t.providerEntityId,
    ),
    localEntityIdx: index("book_provider_correlations_local_entity_idx").on(
      t.localEntityType,
      t.localEntityId,
    ),
    providerIdx: index("book_provider_correlations_provider_idx").on(t.provider),
    createdAtIdx: index("book_provider_correlations_created_at_idx").on(t.createdAt),
    retentionIdx: index("book_provider_correlations_retention_until_idx").on(t.retentionUntil),
  }),
);

export const insertBookProviderCorrelationSchema = createInsertSchema(bookProviderCorrelations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  retentionUntil: true,
  retentionReason: true,
});
export type InsertBookProviderCorrelation = z.infer<typeof insertBookProviderCorrelationSchema>;
export type BookProviderCorrelation = typeof bookProviderCorrelations.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_outbox — transactional outbox for book commerce domain events.
 * Producer inserts a row in the same transaction as the business write;
 * a relay worker polls, delivers, then marks delivered or failed.
 * Dead-letter after max_attempts exhausted.
 *
 * `idempotency_key` is globally unique when non-NULL — prevents duplicate
 * logical events from ever entering the outbox, even after prior delivery.
 * The operational polling index is (status, next_retry_at) for efficient
 * lease/dispatch queries.
 */
export const bookOutbox = pgTable(
  "book_outbox",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    /** Source entity type, e.g. 'order', 'contact'. */
    sourceType: varchar("source_type", { length: 64 }).notNull(),
    /** Source entity ID. */
    sourceId: varchar("source_id", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    payload: jsonb("payload"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastAttemptAt: timestamp("last_attempt_at"),
    nextRetryAt: timestamp("next_retry_at"),
    deliveredAt: timestamp("delivered_at"),
    errorMessage: text("error_message"),
    /** Globally unique when non-NULL. Prevents duplicate logical events. */
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Operational polling index: worker leases pending rows ordered by retry time.
    statusRetryIdx: index("book_outbox_status_next_retry_idx").on(t.status, t.nextRetryAt),
    sourceIdx: index("book_outbox_source_idx").on(t.sourceType, t.sourceId),
    createdAtIdx: index("book_outbox_created_at_idx").on(t.createdAt),
    // Globally unique — prevents re-entry of the same logical event at any point.
    idempotencyUniq: uniqueIndex("book_outbox_idempotency_uniq")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    statusCheck: check(
      "book_outbox_status_check",
      sql`status IN ('pending','delivered','failed','dead_letter')`,
    ),
    attemptCheck: check(
      "book_outbox_attempt_check",
      sql`attempt_count >= 0`,
    ),
  }),
);

export const insertBookOutboxSchema = createInsertSchema(bookOutbox).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  attemptCount: true,
  lastAttemptAt: true,
  deliveredAt: true,
  errorMessage: true,
});
export type InsertBookOutbox = z.infer<typeof insertBookOutboxSchema>;
export type BookOutboxEntry = typeof bookOutbox.$inferSelect;
