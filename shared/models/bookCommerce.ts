/**
 * Task #5096 — Book Commerce Foundation (revised).
 *
 * Core tables (contacts, checkout sessions, orders, order items) plus the
 * shared constants, reusable attribution/consent field sets, and legal status-
 * transition maps live here. Operational tables (payment events, lifecycle
 * events, entitlements, audit applications, appointments, provider
 * correlations, outbox) live in ./bookCommerceOperations; the public
 * @shared/schema barrel exports both modules from one stable entry point.
 *
 * Catalog behavior (pricing display, package descriptions, availability)
 * lives outside this slice. The two SKU prices are embedded as DB CHECK
 * constraints only — the authoritative catalog is a separate concern.
 *
 * Cross-domain design notes:
 *   - book_contacts.scheduled_meeting_id → scheduled_meetings(id) is a
 *     nullable SET NULL FK; the meeting domain owns that record.
 *   - book_appointments.scheduled_meeting_id — same nullable SET NULL FK.
 *   - All monetary amounts are stored as integer cents (USD) with non-negative
 *     CHECK constraints. Order financials satisfy
 *     total = subtotal - discount + shipping + tax and discount <= subtotal.
 *   - Status columns are CHECK-constrained to closed enums.
 *   - Legal transition maps (bookOrderTransitions, etc.) are exported for
 *     storage-layer validation; same-state transitions are always excluded.
 *   - Idempotency keys: partial-unique where status-scoped; globally unique
 *     when the key must survive delivery (outbox, lifecycle events,
 *     audit applications).
 *
 * Attribution (blueprint): a reusable first/latest field set (UTM
 * source/medium/campaign/term/content, referrer, landing URL, gclid, gbraid,
 * wbraid, fbclid, generic click id, and permitted session/device ids) is
 * captured on contacts and snapshotted onto orders. Checkout sessions capture
 * the current-touch equivalents. All attribution columns are server-owned.
 *
 * Consent (blueprint): sms_consent_ledger remains the authority. Book tables
 * carry only consent *snapshots* — state, evidence reference, captured/confirmed
 * timestamps, copy version, source URL, and confirmation status — never raw
 * IP/user-agent. The evidence reference points at the authoritative ledger /
 * evidence record.
 *
 * Prices:
 *   digital  = $4.99  →  499 cents
 *   complete = $19.99 → 1999 cents
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
  unique,
  check,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";
import { scheduledMeetings } from "./booking";
import { smsConsentLedger } from "./communications";
import type { BookPurchasePolicySnapshot } from "../bookCommerceLaunch";

// ── Package codes ─────────────────────────────────────────────────────────────

/**
 * Closed set of purchasable package codes.
 * Catalog-level behavior (descriptions, feature flags) lives outside this slice.
 * Prices are embedded as DB CHECK constraints:
 *   digital  = $4.99  →  499 cents
 *   complete = $19.99 → 1999 cents
 */
export const bookPackageCodes = ["digital", "complete"] as const;
export type BookPackageCode = (typeof bookPackageCodes)[number];

/**
 * Entitlement codes — one or more entitlements are granted per package.
 * A complete order grants all three; a digital order grants digital_book only.
 * Catalog behavior (which package grants what) lives outside this slice.
 */
export const bookEntitlementCodes = [
  "digital_book",
  "audiobook",
  "print_fulfillment",
] as const;
export type BookEntitlementCode = (typeof bookEntitlementCodes)[number];

// ── Consent snapshot enums (ledger remains authoritative) ──────────────────────

/** SMS consent state snapshot. Authority is sms_consent_ledger. */
export const bookSmsConsentStates = ["unknown", "opted_in", "opted_out"] as const;
export type BookSmsConsentState = (typeof bookSmsConsentStates)[number];

/** SMS double-opt-in confirmation status snapshot. */
export const bookSmsConsentConfirmationStatuses = [
  "not_requested",
  "pending",
  "confirmed",
  "declined",
  "revoked",
] as const;
export type BookSmsConsentConfirmationStatus =
  (typeof bookSmsConsentConfirmationStatuses)[number];

/** Email marketing subscription state snapshot. */
export const bookEmailMarketingStatuses = [
  "unknown",
  "subscribed",
  "unsubscribed",
] as const;
export type BookEmailMarketingStatus =
  (typeof bookEmailMarketingStatuses)[number];

/**
 * States a verified external opt-out is allowed to tighten. External providers
 * can move either state to `unsubscribed`; no inbound provider event may move
 * `unsubscribed` back to a less restrictive state.
 */
export const bookEmailMarketingTightenableStates = [
  "unknown",
  "subscribed",
] as const satisfies readonly BookEmailMarketingStatus[];

// ── Checkout session statuses ──────────────────────────────────────────────────

export const checkoutSessionStatuses = [
  "pending",
  "completed",
  "expired",
  "abandoned",
] as const;
export type CheckoutSessionStatus = (typeof checkoutSessionStatuses)[number];

// ── Order statuses + legal transitions ────────────────────────────────────────

export const bookOrderStatuses = [
  "pending_payment",
  "payment_captured",
  "fulfillment_queued",
  "fulfilled",
  "refunded",
  "partially_refunded",
  "cancelled",
  "disputed",
] as const;
export type BookOrderStatus = (typeof bookOrderStatuses)[number];

/**
 * Legal state-machine transitions for book orders.
 * Storage must validate that (fromStatus → toStatus) is an allowed edge.
 * Same-state transitions are always excluded.
 * Terminal states (refunded, cancelled) have no outbound edges.
 */
export const bookOrderTransitions: Record<BookOrderStatus, readonly BookOrderStatus[]> = {
  pending_payment:    ["payment_captured", "cancelled"],
  payment_captured:   ["fulfillment_queued", "partially_refunded", "refunded", "disputed"],
  fulfillment_queued: ["fulfilled", "partially_refunded", "refunded", "disputed"],
  fulfilled:          ["partially_refunded", "refunded", "disputed"],
  partially_refunded: ["refunded", "disputed"],
  disputed:           ["payment_captured", "refunded"],
  refunded:           [],
  cancelled:          [],
} as const;

/** Returns true if the transition from → to is allowed. */
export function isValidBookOrderTransition(
  from: BookOrderStatus,
  to: BookOrderStatus,
): boolean {
  if (from === to) return false;
  return (bookOrderTransitions[from] as readonly string[]).includes(to);
}

// ── Audit application statuses + legal transitions ────────────────────────────

export const bookAuditApplicationStatuses = [
  "draft",
  "submitted",
  "qualified",
  "not_qualified",
  "withdrawn",
] as const;
export type BookAuditApplicationStatus =
  (typeof bookAuditApplicationStatuses)[number];

/**
 * Legal state-machine transitions for buyer bonus-qualification applications.
 * Terminal states (qualified, not_qualified, withdrawn) have no outbound edges.
 */
export const bookAuditApplicationTransitions: Record<
  BookAuditApplicationStatus,
  readonly BookAuditApplicationStatus[]
> = {
  draft:         ["submitted", "withdrawn"],
  submitted:     ["qualified", "not_qualified", "withdrawn"],
  qualified:     [],
  not_qualified: [],
  withdrawn:     [],
} as const;

export function isValidBookAuditApplicationTransition(
  from: BookAuditApplicationStatus,
  to: BookAuditApplicationStatus,
): boolean {
  if (from === to) return false;
  return (bookAuditApplicationTransitions[from] as readonly string[]).includes(to);
}

// ── Appointment statuses + legal transitions ──────────────────────────────────

export const bookAppointmentStatuses = [
  "pending",
  "scheduled",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type BookAppointmentStatus = (typeof bookAppointmentStatuses)[number];

/**
 * Legal state-machine transitions for book appointments.
 * no_show → scheduled allows reschedule convergence to one row per application.
 * Terminal states (completed, cancelled) have no outbound edges.
 */
export const bookAppointmentTransitions: Record<
  BookAppointmentStatus,
  readonly BookAppointmentStatus[]
> = {
  pending:   ["scheduled", "cancelled"],
  scheduled: ["completed", "cancelled", "no_show"],
  no_show:   ["scheduled"],
  completed: [],
  cancelled: [],
} as const;

export function isValidBookAppointmentTransition(
  from: BookAppointmentStatus,
  to: BookAppointmentStatus,
): boolean {
  if (from === to) return false;
  return (bookAppointmentTransitions[from] as readonly string[]).includes(to);
}

// ── Payment event types ────────────────────────────────────────────────────────

export const paymentEventTypes = [
  "payment_intent_created",
  "payment_intent_succeeded",
  "payment_intent_payment_failed",
  "charge_refunded",
  "charge_dispute_created",
  "charge_dispute_closed",
  "checkout_session_completed",
  "checkout_session_expired",
  "other",
] as const;
export type PaymentEventType = (typeof paymentEventTypes)[number];

// ── Lifecycle event types ──────────────────────────────────────────────────────

export const bookLifecycleEventTypes = [
  "contact_created",
  "checkout_started",
  "checkout_completed",
  "checkout_expired",
  "order_created",
  "payment_captured",
  "fulfillment_queued",
  "fulfilled",
  "refund_initiated",
  "refunded",
  "partially_refunded",
  "cancelled",
  "disputed",
  "entitlement_granted",
  "entitlement_revoked",
  "application_submitted",
  "application_qualified",
  "application_not_qualified",
  "application_withdrawn",
  "appointment_scheduled",
  "appointment_completed",
  "appointment_cancelled",
  "appointment_no_show",
  "delivery_link_issued",
  "delivery_link_exchanged",
  "delivery_email_requested",
  "delivery_downloaded",
  "delivery_access_revoked",
  "manual_correction",
] as const;
export type BookLifecycleEventType = (typeof bookLifecycleEventTypes)[number];

// ── Entitlement statuses ───────────────────────────────────────────────────────

export const entitlementStatuses = ["active", "revoked", "expired"] as const;
export type EntitlementStatus = (typeof entitlementStatuses)[number];

// ── Outbox statuses ────────────────────────────────────────────────────────────

export const bookOutboxStatuses = [
  "pending",
  "delivered",
  "failed",
  "dead_letter",
] as const;
export type BookOutboxStatus = (typeof bookOutboxStatuses)[number];

export const bookOutboxEventTypes = [
  "order.created",
  "order.payment_captured", "order.partially_refunded", "order.disputed", "order.fulfillment_queued",
  "order.fulfilled",
  "order.refunded",
  "order.cancelled",
  "entitlement.granted",
  "entitlement.revoked",
  "application.submitted",
  "application.qualified",
  "application.not_qualified",
  "appointment.scheduled",
  "appointment.cancelled",
  // Task #5105 — appointment terminal states needed for GHL lifecycle sync
  "appointment.completed",
  "appointment.no_show",
  "checkout.completed",
  "checkout.expired",
  // Task #5105 — checkout recoverable and buyer bonus viewed events for GHL
  "checkout.recoverable",
  "bonus.viewed",
  // Canonical SMS-ledger change mirrored to an already-correlated GHL contact.
  "consent.sms_updated",
] as const;
export type BookOutboxEventType = (typeof bookOutboxEventTypes)[number];

// ── Reusable attribution field set (blueprint) ─────────────────────────────────
//
// A single conceptual attribution touch: UTM parameters, referrer, landing URL,
// ad-platform click identifiers (gclid/gbraid/wbraid/fbclid + generic clickId),
// and the permitted session/device identifiers. Each factory call returns FRESH
// Drizzle column builders (builders are single-use), so the same logical set can
// be materialised as first-touch, latest-touch, and current-touch columns on
// different tables while the DDL and TS stay in lockstep.
//
// `prefix` is the snake_case column-name prefix (e.g. "first_touch",
// "latest_touch", "current_touch"). `key` is the camelCase property prefix
// (e.g. "firstTouch"). All columns are nullable and server-owned.

function attributionColumns<K extends string, P extends string>(
  prefix: P,
  key: K,
) {
  return {
    [`${key}UtmSource`]: varchar(`${prefix}_utm_source`, { length: 200 }),
    [`${key}UtmMedium`]: varchar(`${prefix}_utm_medium`, { length: 200 }),
    [`${key}UtmCampaign`]: varchar(`${prefix}_utm_campaign`, { length: 200 }),
    [`${key}UtmTerm`]: varchar(`${prefix}_utm_term`, { length: 200 }),
    [`${key}UtmContent`]: varchar(`${prefix}_utm_content`, { length: 200 }),
    [`${key}Referrer`]: text(`${prefix}_referrer`),
    [`${key}LandingUrl`]: text(`${prefix}_landing_url`),
    [`${key}Gclid`]: varchar(`${prefix}_gclid`, { length: 200 }),
    [`${key}Gbraid`]: varchar(`${prefix}_gbraid`, { length: 200 }),
    [`${key}Wbraid`]: varchar(`${prefix}_wbraid`, { length: 200 }),
    [`${key}Fbclid`]: varchar(`${prefix}_fbclid`, { length: 200 }),
    [`${key}ClickId`]: varchar(`${prefix}_click_id`, { length: 200 }),
    [`${key}SessionId`]: varchar(`${prefix}_session_id`, { length: 200 }),
    [`${key}DeviceId`]: varchar(`${prefix}_device_id`, { length: 200 }),
  } as {
    [S in (typeof attributionSuffixes)[number] as `${K}${S}`]: ReturnType<
      typeof varchar
    >;
  };
}

/** The camelCase attribution property suffixes, for omit()-list generation. */
const attributionSuffixes = [
  "UtmSource",
  "UtmMedium",
  "UtmCampaign",
  "UtmTerm",
  "UtmContent",
  "Referrer",
  "LandingUrl",
  "Gclid",
  "Gbraid",
  "Wbraid",
  "Fbclid",
  "ClickId",
  "SessionId",
  "DeviceId",
] as const;

/** Build an omit() map ({ prop: true }) for a set of attribution keys. */
function attributionOmit(...keys: string[]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const key of keys) {
    for (const suffix of attributionSuffixes) {
      out[`${key}${suffix}`] = true;
    }
  }
  return out;
}

// ── Reusable SMS-consent snapshot field set (blueprint) ────────────────────────
//
// A purchase-/contact-time SMS consent *snapshot*. The authority is
// sms_consent_ledger; these columns preserve the evidence that applied at the
// moment, so an order's consent posture survives contact edits/deletion. Never
// store raw IP/user-agent here — `smsConsentEvidenceRef` points at the
// authoritative ledger/evidence record.

function smsConsentSnapshotColumns() {
  return {
    smsConsentState: varchar("sms_consent_state", { length: 16 })
      .notNull()
      .default("unknown"),
    /**
     * Nullable FK to the authoritative consent record (sms_consent_ledger.id).
     * ON DELETE RESTRICT so evidence cannot be silently orphaned. The ledger is
     * the single consent authority; the sibling columns are purchase-time
     * snapshots only.
     */
    smsConsentEvidenceRef: varchar("sms_consent_evidence_ref", { length: 256 })
      .references(() => smsConsentLedger.id, { onDelete: "restrict" }),
    smsConsentCapturedAt: timestamp("sms_consent_captured_at"),
    smsConsentCopyVersion: varchar("sms_consent_copy_version", { length: 64 }),
    smsConsentSourceUrl: text("sms_consent_source_url"),
    smsConsentConfirmationStatus: varchar("sms_consent_confirmation_status", {
      length: 16,
    })
      .notNull()
      .default("not_requested"),
    smsConsentConfirmedAt: timestamp("sms_consent_confirmed_at"),
  } as const;
}

const smsConsentStateCheckSql = sql`sms_consent_state IN ('unknown','opted_in','opted_out')`;
const smsConsentConfirmationCheckSql = sql`sms_consent_confirmation_status IN ('not_requested','pending','confirmed','declined','revoked')`;

// ── Tables ────────────────────────────────────────────────────────────────────

/**
 * book_contacts — person who interacts with the book commerce surface.
 * Separate from the main clients table: a book buyer may not be an existing
 * client. `client_id` is an optional FK for when the contact is later matched
 * or manually linked to a client record. `scheduled_meeting_id` links to the
 * cross-domain booking meeting (nullable SET NULL — the meeting domain owns
 * that record).
 *
 * First/latest attribution and SMS/email consent snapshots are captured here;
 * attribution first-touch columns and all consent columns are server-owned.
 */
export const bookContacts = pgTable(
  "book_contacts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    email: varchar("email", { length: 320 }).notNull(),
    name: text("name"),
    phone: varchar("phone", { length: 50 }),
    /** Optional link to an existing client record (manually linked or auto-matched). */
    clientId: varchar("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    /**
     * Cross-domain meeting link — nullable SET NULL. The booking domain owns
     * scheduled_meetings; we hold a reference only for correlation.
     */
    scheduledMeetingId: varchar("scheduled_meeting_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    // ── First-touch attribution (server-owned, write-once at contact creation) ──
    ...attributionColumns("first_touch", "firstTouch"),
    // ── Latest-touch attribution (updated on each new session / checkout) ──────
    ...attributionColumns("latest_touch", "latestTouch"),
    // ── SMS consent snapshot (authority: sms_consent_ledger) ───────────────────
    ...smsConsentSnapshotColumns(),
    /** Email marketing subscription state snapshot. */
    emailMarketingStatus: varchar("email_marketing_status", { length: 16 })
      .notNull()
      .default("unknown"),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    // ── Timestamps ────────────────────────────────────────────────────────────
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    emailUniq: uniqueIndex("book_contacts_email_uniq").on(t.email),
    clientIdx: index("book_contacts_client_id_idx").on(t.clientId),
    meetingIdx: index("book_contacts_meeting_id_idx").on(t.scheduledMeetingId),
    retentionIdx: index("book_contacts_retention_until_idx").on(t.retentionUntil),
    createdAtIdx: index("book_contacts_created_at_idx").on(t.createdAt),
    smsConsentStateCheck: check(
      "book_contacts_sms_consent_state_check",
      smsConsentStateCheckSql,
    ),
    smsConsentConfirmationCheck: check(
      "book_contacts_sms_consent_confirmation_check",
      smsConsentConfirmationCheckSql,
    ),
    emailMarketingStatusCheck: check(
      "book_contacts_email_marketing_status_check",
      sql`email_marketing_status IN ('unknown','subscribed','unsubscribed')`,
    ),
  }),
);

export const insertBookContactSchema = createInsertSchema(bookContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // First-touch attribution is server-stamped once at creation, never from bodies.
  ...attributionOmit("firstTouch"),
  // Consent snapshots are server-owned (derived from the authoritative ledger).
  smsConsentState: true,
  smsConsentEvidenceRef: true,
  smsConsentCapturedAt: true,
  smsConsentCopyVersion: true,
  smsConsentSourceUrl: true,
  smsConsentConfirmationStatus: true,
  smsConsentConfirmedAt: true,
  emailMarketingStatus: true,
});
export type InsertBookContact = z.infer<typeof insertBookContactSchema>;
export type BookContact = typeof bookContacts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_checkout_sessions — ephemeral checkout intent. `provider_session_id`
 * doubles as the durable PaymentIntent binding (never renamed).
 * Server-owned quote: subtotal/discount/shipping/tax components;
 * amountTotalCents = subtotal - discount + shipping + tax (formula).
 * quoteVersion is an optimistic CAS counter. paymentState tracks the
 * authoritative payment lifecycle. DB catalog guard: subtotal locked to
 * catalog price (digital=499, complete=1999) + formula check.
 */
export const bookCheckoutSessions = pgTable(
  "book_checkout_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    contactId: varchar("contact_id")
      .references(() => bookContacts.id, { onDelete: "set null" }),
    packageCode: varchar("package_code", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    /**
     * External payment provider session/PaymentIntent ID.
     * Used as both the Stripe Checkout session correlation and (Task #5097)
     * the durable PaymentIntent binding. Never renamed or repurposed.
     */
    providerSessionId: varchar("provider_session_id", { length: 256 }),
    /** Currency code, ISO 4217 uppercase, e.g. USD. */
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    // ── Server-owned quote components (Task #5097) ───────────────────────────
    /** Catalog subtotal before discount/shipping/tax (server-owned). */
    subtotalAmountCents: integer("subtotal_amount_cents").notNull(),
    /** Discount applied (server-owned; integer cents; 0 initial default). */
    discountAmountCents: integer("discount_amount_cents").notNull().default(0),
    /** Shipping charged (server-owned; integer cents; 0 initial default). */
    shippingAmountCents: integer("shipping_amount_cents").notNull().default(0),
    /** Tax charged (server-owned; integer cents; updated on quote persist). */
    taxAmountCents: integer("tax_amount_cents").notNull().default(0),
    /**
     * Formula-derived total = subtotal - discount + shipping + tax.
     * Kept as amountTotalCents for backward compatibility; enforced via
     * book_checkout_sessions_total_formula_check constraint.
     */
    amountTotalCents: integer("amount_total_cents").notNull(),
    /** Optimistic-lock version counter; incremented on each quote update. */
    quoteVersion: integer("quote_version").notNull().default(0),
    /** When the quoted total expires (null = no expiry). */
    quoteExpiresAt: timestamp("quote_expires_at"),
    /** Stripe Tax calculation ID for the current quote (nullable). */
    stripeTaxCalculationId: varchar("stripe_tax_calculation_id", { length: 256 }),
    /** JSONB snapshot of billing/shipping address at quote time. */
    addressSnapshot: jsonb("address_snapshot"),
    /** Authoritative payment lifecycle state. */
    paymentState: varchar("payment_state", { length: 32 }).notNull().default("none"),
    /** Durable last payment error string (null = no error). */
    paymentError: text("payment_error"),
    /** Durable unknown/unmatched state reason (null = not unknown). */
    paymentUnknownReason: text("payment_unknown_reason"),
    /** Durable reconciliation note (null = not flagged). */
    reconciliationNote: text("reconciliation_note"),
    // ────────────────────────────────────────────────────────────────────────
    /** Replay-safe idempotency key (partial unique: only non-NULL rows). */
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    /** Hashed resume token (never plaintext) for resuming an abandoned session. */
    resumeTokenHash: varchar("resume_token_hash", { length: 256 }),
    /** Durable proof that this checkout completed the required contact step. */
    contactCompletedAt: timestamp("contact_completed_at"),
    /**
     * Exact server-owned policy/disclosure versions presented for this
     * checkout. Null is legacy-only; new launch-ready sessions are stamped at
     * creation and a DB trigger rejects later mutation.
     */
    policySnapshot: jsonb("policy_snapshot").$type<BookPurchasePolicySnapshot | null>(),
    // ── Current-touch attribution snapshot at session start ────────────────────
    ...attributionColumns("current_touch", "currentTouch"),
    expiresAt: timestamp("expires_at"),
    completedAt: timestamp("completed_at"),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    contactIdx: index("book_checkout_sessions_contact_id_idx").on(t.contactId),
    statusIdx: index("book_checkout_sessions_status_idx").on(t.status),
    providerSessionIdx: uniqueIndex("book_checkout_sessions_provider_session_uniq")
      .on(t.providerSessionId)
      .where(sql`provider_session_id IS NOT NULL`),
    idempotencyIdx: uniqueIndex("book_checkout_sessions_idempotency_uniq")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    resumeTokenIdx: uniqueIndex("book_checkout_sessions_resume_token_uniq")
      .on(t.resumeTokenHash)
      .where(sql`resume_token_hash IS NOT NULL`),
    paymentStateIdx: index("book_checkout_sessions_payment_state_idx").on(t.paymentState),
    quoteExpiresAtIdx: index("book_checkout_sessions_quote_expires_at_idx")
      .on(t.quoteExpiresAt)
      .where(sql`quote_expires_at IS NOT NULL`),
    createdAtIdx: index("book_checkout_sessions_created_at_idx").on(t.createdAt),
    retentionIdx: index("book_checkout_sessions_retention_until_idx").on(t.retentionUntil),
    statusCheck: check(
      "book_checkout_sessions_status_check",
      sql`status IN ('pending','completed','expired','abandoned')`,
    ),
    currencyCheck: check(
      "book_checkout_sessions_currency_check",
      sql`currency = upper(currency) AND length(currency) = 3`,
    ),
    amountCheck: check(
      "book_checkout_sessions_amount_check",
      sql`amount_total_cents >= 0`,
    ),
    packageCheck: check(
      "book_checkout_sessions_package_check",
      sql`package_code IN ('digital','complete')`,
    ),
    // Subtotal catalog guard: currency USD and subtotal locked to package catalog price.
    // Replaces the old amount_total_cents catalog guard (Task #5097).
    subtotalCatalogCheck: check(
      "book_checkout_sessions_subtotal_catalog_check",
      sql`currency = 'USD' AND (
        (package_code = 'digital'  AND subtotal_amount_cents =  499) OR
        (package_code = 'complete' AND subtotal_amount_cents = 1999)
      )`,
    ),
    subtotalCheck: check(
      "book_checkout_sessions_subtotal_check",
      sql`subtotal_amount_cents >= 0`,
    ),
    discountCheck: check(
      "book_checkout_sessions_discount_check",
      sql`discount_amount_cents >= 0 AND discount_amount_cents <= subtotal_amount_cents`,
    ),
    shippingCheck: check(
      "book_checkout_sessions_shipping_check",
      sql`shipping_amount_cents >= 0`,
    ),
    taxCheck: check(
      "book_checkout_sessions_tax_check",
      sql`tax_amount_cents >= 0`,
    ),
    // Total formula: amount_total_cents = subtotal - discount + shipping + tax.
    totalFormulaCheck: check(
      "book_checkout_sessions_total_formula_check",
      sql`amount_total_cents = subtotal_amount_cents - discount_amount_cents + shipping_amount_cents + tax_amount_cents`,
    ),
    paymentStateCheck: check(
      "book_checkout_sessions_payment_state_check",
      sql`payment_state IN ('none','intent_created','processing','captured','failed','canceled','unknown','reconciliation_needed')`,
    ),
    quoteVersionCheck: check(
      "book_checkout_sessions_quote_version_check",
      sql`quote_version >= 0`,
    ),
  }),
);

export const insertBookCheckoutSessionSchema = createInsertSchema(bookCheckoutSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  resumeTokenHash: true,
  retentionUntil: true,
  retentionReason: true,
  // Server-owned quote/payment state fields — never from callers.
  subtotalAmountCents: true,
  discountAmountCents: true,
  shippingAmountCents: true,
  taxAmountCents: true,
  quoteVersion: true,
  quoteExpiresAt: true,
  stripeTaxCalculationId: true,
  addressSnapshot: true,
  paymentState: true,
  paymentError: true,
  paymentUnknownReason: true,
  reconciliationNote: true,
  policySnapshot: true,
  // Current-touch attribution is server-stamped from the session context.
  ...attributionOmit("currentTouch"),
});
export type InsertBookCheckoutSession = z.infer<typeof insertBookCheckoutSessionSchema>;
export type BookCheckoutSession = typeof bookCheckoutSessions.$inferSelect;

// ── Address snapshot (strict schema for billing/shipping address) ─────────────

export const addressSnapshotSchema = z.object({
  line1: z.string().max(200).optional().nullable(),
  line2: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  country: z.string().max(2).optional().nullable(),
}).strict();
export type AddressSnapshot = z.infer<typeof addressSnapshotSchema>;

// ── Checkout payment state ────────────────────────────────────────────────────
export const checkoutPaymentStates = [
  "none",
  "intent_created",
  "processing",
  "captured",
  "failed",
  "canceled",
  "unknown",
  "reconciliation_needed",
] as const;
export type CheckoutPaymentState = (typeof checkoutPaymentStates)[number];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_orders — the authoritative commerce record created after a successful
 * payment capture. Once created the financial snapshot is immutable at the row
 * level (enforced by DB triggers); mutations (refunds, cancellations) are
 * recorded as status transitions and lifecycle events, except for the status
 * field and refund tracking columns.
 *
 * Financials (all integer cents, non-negative):
 *   total = subtotal - discount + shipping + tax, with discount <= subtotal.
 *   Catalog guard: digital subtotal = 499, complete subtotal = 1999.
 *   Components are populated from the locked checkout quote; shipping/tax
 *   may be non-zero when tax calculation or shipping charges apply.
 *
 * Authoritative relationships:
 *   - checkout_session_id is unique WHERE NOT NULL — one order per checkout.
 *   - A composite unique key (id, package_code, currency, subtotal_amount_cents)
 *     backs a composite FK from book_order_items so the item's package/currency/
 *     line-total cannot diverge from the parent order.
 *
 * Attribution snapshot: full first/latest attribution is captured here at
 * order-creation time. An SMS consent snapshot preserves purchase-time consent
 * evidence even if the contact later changes or is deleted.
 */
export const bookOrders = pgTable(
  "book_orders",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    contactId: varchar("contact_id")
      .references(() => bookContacts.id, { onDelete: "set null" }),
    /**
     * Authority link — every order originates from a checkout session.
     * NOT NULL + ON DELETE RESTRICT (not SET NULL, which would break NOT NULL
     * and fail parent deletes misleadingly).
     */
    checkoutSessionId: varchar("checkout_session_id")
      .references(() => bookCheckoutSessions.id, { onDelete: "restrict" })
      .notNull(),
    /** Human-readable order number, unique and stable. Server-generated. */
    orderNumber: varchar("order_number", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending_payment"),
    packageCode: varchar("package_code", { length: 32 }).notNull(),
    /** ISO 4217 uppercase currency code. */
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    // ── Financial snapshot (integer cents) ─────────────────────────────────────
    /** Catalog subtotal before discount/shipping/tax. */
    subtotalAmountCents: integer("subtotal_amount_cents").notNull(),
    /** Discount applied (0 for the current fixed catalog). */
    discountAmountCents: integer("discount_amount_cents").notNull().default(0),
    /** Shipping charged (0 for the current fixed catalog). */
    shippingAmountCents: integer("shipping_amount_cents").notNull().default(0),
    /** Tax charged (0 for the current fixed catalog). */
    taxAmountCents: integer("tax_amount_cents").notNull().default(0),
    /** Total charged = subtotal - discount + shipping + tax. */
    totalAmountCents: integer("total_amount_cents").notNull(),
    /** Total refunded to date in cents (0 = no refund). */
    refundedAmountCents: integer("refunded_amount_cents").notNull().default(0),
    /** Actor who created the order (null = system/webhook-driven). */
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // ── Full first/latest attribution snapshot at order-creation time ──────────
    ...attributionColumns("first_touch", "firstTouch"),
    ...attributionColumns("latest_touch", "latestTouch"),
    // ── SMS consent snapshot at purchase time (authority: sms_consent_ledger) ──
    ...smsConsentSnapshotColumns(),
    /**
     * Immutable copy of the originating checkout's purchase-policy snapshot.
     * Nullable only for legacy orders created before the launch gate existed.
     */
    policySnapshot: jsonb("policy_snapshot").$type<BookPurchasePolicySnapshot | null>(),
    // ── Retention metadata ───────────────────────────────────────────────────
    retentionUntil: timestamp("retention_until"),
    retentionReason: varchar("retention_reason", { length: 200 }),
    // ── Timestamps ────────────────────────────────────────────────────────────
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    orderNumberUniq: uniqueIndex("book_orders_order_number_uniq").on(t.orderNumber),
    contactIdx: index("book_orders_contact_id_idx").on(t.contactId),
    statusIdx: index("book_orders_status_idx").on(t.status),
    checkoutSessionIdx: index("book_orders_checkout_session_id_idx").on(t.checkoutSessionId),
    // One order per checkout session.
    checkoutSessionUniq: uniqueIndex("book_orders_checkout_session_uniq")
      .on(t.checkoutSessionId)
      .where(sql`checkout_session_id IS NOT NULL`),
    // Composite UNIQUE CONSTRAINT (not a unique index) that backs the order-item
    // composite FK. Modeled as a table constraint so it is available at FK
    // creation time under push-first — a unique index is not accepted as the
    // referenced key by drizzle-kit push (Postgres 42830).
    packageSnapshotUniq: unique("book_orders_package_snapshot_uniq").on(
      t.id,
      t.packageCode,
      t.currency,
      t.subtotalAmountCents,
    ),
    createdAtIdx: index("book_orders_created_at_idx").on(t.createdAt),
    retentionIdx: index("book_orders_retention_until_idx").on(t.retentionUntil),
    statusCheck: check(
      "book_orders_status_check",
      sql`status IN ('pending_payment','payment_captured','fulfillment_queued','fulfilled','refunded','partially_refunded','cancelled','disputed')`,
    ),
    currencyCheck: check(
      "book_orders_currency_check",
      sql`currency = upper(currency) AND length(currency) = 3`,
    ),
    // All financial components non-negative.
    subtotalCheck: check(
      "book_orders_subtotal_check",
      sql`subtotal_amount_cents >= 0`,
    ),
    discountCheck: check(
      "book_orders_discount_check",
      sql`discount_amount_cents >= 0 AND discount_amount_cents <= subtotal_amount_cents`,
    ),
    shippingCheck: check(
      "book_orders_shipping_check",
      sql`shipping_amount_cents >= 0`,
    ),
    taxCheck: check(
      "book_orders_tax_check",
      sql`tax_amount_cents >= 0`,
    ),
    totalCheck: check(
      "book_orders_total_amount_check",
      sql`total_amount_cents >= 0`,
    ),
    // total = subtotal - discount + shipping + tax.
    totalFormulaCheck: check(
      "book_orders_total_formula_check",
      sql`total_amount_cents = subtotal_amount_cents - discount_amount_cents + shipping_amount_cents + tax_amount_cents`,
    ),
    refundedAmountCheck: check(
      "book_orders_refunded_amount_check",
      sql`refunded_amount_cents >= 0 AND refunded_amount_cents <= total_amount_cents`,
    ),
    packageCheck: check(
      "book_orders_package_check",
      sql`package_code IN ('digital','complete')`,
    ),
    // Catalog guard on the subtotal: digital=499, complete=1999.
    catalogSubtotalCheck: check(
      "book_orders_catalog_subtotal_check",
      sql`(package_code = 'digital'  AND subtotal_amount_cents =  499) OR
          (package_code = 'complete' AND subtotal_amount_cents = 1999)`,
    ),
    smsConsentStateCheck: check(
      "book_orders_sms_consent_state_check",
      smsConsentStateCheckSql,
    ),
    smsConsentConfirmationCheck: check(
      "book_orders_sms_consent_confirmation_check",
      smsConsentConfirmationCheckSql,
    ),
  }),
);

export const insertBookOrderSchema = createInsertSchema(bookOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Server-owned fields.
  orderNumber: true,
  refundedAmountCents: true,
  policySnapshot: true,
  // Full attribution snapshot — server stamps from session/contact at creation.
  ...attributionOmit("firstTouch", "latestTouch"),
  // Consent snapshot is server-owned (from the authoritative ledger).
  smsConsentState: true,
  smsConsentEvidenceRef: true,
  smsConsentCapturedAt: true,
  smsConsentCopyVersion: true,
  smsConsentSourceUrl: true,
  smsConsentConfirmationStatus: true,
  smsConsentConfirmedAt: true,
});
export type InsertBookOrder = z.infer<typeof insertBookOrderSchema>;
export type BookOrder = typeof bookOrders.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_order_items — immutable financial snapshot of what was purchased.
 * Exactly ONE item row per order (unique on order_id alone). Written once at
 * order creation and never updated (DB trigger rejects all UPDATEs).
 *
 * A composite FK (order_id, package_code, currency, line_total_cents) →
 * book_orders (id, package_code, currency, subtotal_amount_cents) guarantees
 * the item's package/currency/line-total match the parent order snapshot.
 *
 * Fixed catalog rules:
 *   quantity = 1, unit_price_cents = catalog price, line_total = unit_price,
 *   discount_amount_cents = 0 and discount_label IS NULL.
 * Prices: digital → 499 ($4.99); complete → 1999 ($19.99).
 */
export const bookOrderItems = pgTable(
  "book_order_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orderId: varchar("order_id")
      .references(() => bookOrders.id, { onDelete: "cascade" })
      .notNull(),
    packageCode: varchar("package_code", { length: 32 }).notNull(),
    /** Snapshot of the product label at purchase time. */
    packageLabel: text("package_label").notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** Unit price in cents at the time of purchase. */
    unitPriceCents: integer("unit_price_cents").notNull(),
    /** Total line amount = quantity × unit_price_cents. */
    lineTotalCents: integer("line_total_cents").notNull(),
    /** ISO 4217 uppercase. */
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    /** Free-form snapshot of any applied discount (must be NULL under fixed catalog). */
    discountLabel: text("discount_label"),
    discountAmountCents: integer("discount_amount_cents").notNull().default(0),
    /** Arbitrary snapshot metadata (promo codes, variant info, etc.). */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    orderIdx: index("book_order_items_order_id_idx").on(t.orderId),
    // Exactly one item per order.
    orderUniq: uniqueIndex("book_order_items_order_uniq").on(t.orderId),
    // Composite FK to the parent order snapshot: item package/currency/line-total
    // cannot diverge from order package/currency/subtotal. References the
    // book_orders_package_snapshot_uniq unique index.
    packageSnapshotFk: foreignKey({
      name: "book_order_items_package_snapshot_fk",
      columns: [t.orderId, t.packageCode, t.currency, t.lineTotalCents],
      foreignColumns: [
        bookOrders.id,
        bookOrders.packageCode,
        bookOrders.currency,
        bookOrders.subtotalAmountCents,
      ],
    }).onDelete("cascade"),
    packageCheck: check(
      "book_order_items_package_check",
      sql`package_code IN ('digital','complete')`,
    ),
    // Fixed catalog: exactly one unit.
    quantityCheck: check(
      "book_order_items_quantity_check",
      sql`quantity = 1`,
    ),
    unitPriceCheck: check(
      "book_order_items_unit_price_check",
      sql`unit_price_cents >= 0`,
    ),
    lineTotalCheck: check(
      "book_order_items_line_total_check",
      sql`line_total_cents >= 0`,
    ),
    // line_total = quantity × unit_price (and quantity = 1 → line_total = unit_price).
    lineTotalFormulaCheck: check(
      "book_order_items_line_total_formula_check",
      sql`line_total_cents = quantity * unit_price_cents`,
    ),
    // Fixed catalog: no discount, and discount label must be NULL.
    discountCheck: check(
      "book_order_items_discount_check",
      sql`discount_amount_cents = 0 AND discount_label IS NULL`,
    ),
    currencyCheck: check(
      "book_order_items_currency_check",
      sql`currency = upper(currency) AND length(currency) = 3`,
    ),
    /**
     * Catalog price guard:
     *   digital  = $4.99  →  499 cents
     *   complete = $19.99 → 1999 cents
     */
    catalogPriceCheck: check(
      "book_order_items_catalog_price_check",
      sql`(package_code = 'digital' AND unit_price_cents = 499) OR (package_code = 'complete' AND unit_price_cents = 1999)`,
    ),
  }),
);

export const insertBookOrderItemSchema = createInsertSchema(bookOrderItems).omit({
  id: true,
  createdAt: true,
});
export type InsertBookOrderItem = z.infer<typeof insertBookOrderItemSchema>;
export type BookOrderItem = typeof bookOrderItems.$inferSelect;
