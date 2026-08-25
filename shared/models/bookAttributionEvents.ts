/**
 * Task #5106 — Book Attribution Event Ledger + Per-Provider Delivery State.
 *
 * This module defines TWO tightly-coupled tables:
 *
 *   book_attribution_events
 *     An append-only, book-specific attribution event ledger (NOT a generic
 *     CDP tracker). One row per meaningful funnel moment — a closed vocabulary
 *     of `eventName` values aligned to the blueprint's GA4/Meta/Google Ads
 *     event map. Each row carries:
 *       - stable durable eventId (UUID PK)
 *       - closed-vocabulary eventName
 *       - source authority + source IDs (contact/checkout/order/application/appointment/opportunity)
 *       - order/item context (packageCode, amountCents, currency, itemSku)
 *       - privacy classification (public / pii_contact / sensitive)
 *       - occurredAt (when the business fact happened)
 *       - required globally unique logical idempotency key
 *       - created timestamp
 *
 *   book_attribution_event_deliveries
 *     Per-provider delivery state for each attribution event row. One row per
 *     (eventId, provider) pair. Providers: ga4, meta_capi, google_ads.
 *     Statuses: pending / deferred / sent / retry / dead / disabled.
 *     Carries: attempt count, nextAttemptAt, lease token + expiry,
 *     external receipt/idempotency, sanitized error class, timestamps.
 *     Unique constraint on (event_id, provider).
 *     Provider-scoped claims index on (provider, status, next_attempt_at).
 *
 * Source IDs are immutable scalar snapshots rather than foreign keys. This lets
 * privacy/retention jobs delete parent contact/order records without rewriting
 * historical ledger facts. The public @shared/schema barrel re-exports this module.
 *
 * Design notes:
 *   - "Attribution event" = a fact that a measurement platform should learn
 *     about (a purchase, a checkout started, an appointment booked, etc.). It is
 *     not a lifecycle audit event (those live in book_lifecycle_events).
 *   - The ledger is append-only: rows are never updated. Delivery state is the
 *     only mutable part and lives in the sibling table.
 *   - sourceAuthority identifies which verified system originated the fact.
 *     A vocabulary entry does not itself authorize a producer; producers must
 *     still be wired only at an established authoritative state transition.
 *   - Privacy classification gates whether an approved provider may resolve
 *     contact/revenue context. Ledger JSON is always limited to non-PII
 *     attribution fields regardless of classification.
 *   - Idempotency key is required and globally unique so a single logical
 *     event can never produce two ledger rows even after worker retries.
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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Attribution event name vocabulary (blueprint-aligned) ─────────────────────

/**
 * Closed vocabulary of book-funnel attribution event names.
 * Names are aligned to the blueprint §12.1 GA4 event map and the corresponding
 * Meta / Google Ads equivalents. Adding a new event requires a code change here
 * AND a forward migration — callers may not supply arbitrary strings.
 *
 * Blueprint alignment:
 *   view_item              → GA4 view_item / Meta ViewContent
 *   select_item            → GA4 select_item
 *   begin_checkout         → GA4 begin_checkout / Meta InitiateCheckout
 *   add_shipping_info      → GA4 add_shipping_info
 *   add_payment_info       → GA4 add_payment_info / Meta AddPaymentInfo
 *   purchase               → GA4 purchase / Meta Purchase / Google Ads conversion
 *   refund                 → GA4 refund
 *   book_video_start       → GA4 book_video_start
 *   book_video_complete    → GA4 book_video_complete
 *   bump_view              → GA4 bump_view
 *   bump_accept            → GA4 bump_accept
 *   bonus_offer_view       → GA4 bonus_offer_view
 *   audit_application_start  → GA4 audit_application_start
 *   audit_application_submit → GA4 audit_application_submit / Meta Lead
 *   audit_application_qualified → approved qualified application state
 *   audit_application_not_qualified → approved alternate next step
 *   scheduler_view         → GA4 scheduler_view
 *   appointment_booked     → GA4 appointment_booked / Meta Schedule
 *   appointment_attended   → GA4 appointment_attended (imported from CRM)
 *   appointment_no_show    → verified appointment no-show state
 *   qualified_opportunity  → GA4 qualified_opportunity (imported from CRM)
 *   client_closed          → GA4 client_closed / Google Ads offline (with revenue)
 *   access_ready           → secure access capability became available
 *   book_download          → GA4 book_download
 *   complete_collection_purchased → verified Complete Collection purchase
 *   audiobook_start        → GA4 audiobook_start
 */
export const bookAttributionEventNames = [
  "view_item",
  "select_item",
  "begin_checkout",
  "add_shipping_info",
  "add_payment_info",
  "purchase",
  "refund",
  "book_video_start",
  "book_video_complete",
  "bump_view",
  "bump_accept",
  "bonus_offer_view",
  "audit_application_start",
  "audit_application_submit",
  "audit_application_qualified",
  "audit_application_not_qualified",
  "scheduler_view",
  "appointment_booked",
  "appointment_attended",
  "appointment_no_show",
  "qualified_opportunity",
  "client_closed",
  "access_ready",
  "book_download",
  "complete_collection_purchased",
  "audiobook_start",
] as const;
export type BookAttributionEventName = (typeof bookAttributionEventNames)[number];

// ── Source authority vocabulary ────────────────────────────────────────────────

/**
 * Which system originated the fact that triggered this attribution event.
 *   book_commerce   — server-side book commerce lifecycle (webhook → worker)
 *   stripe_webhook  — Stripe payment webhook directly
 *   ghl_webhook     — a verified, approved GHL contract (no opportunity/close
 *                     producer exists until that contract is proven)
 *   manual_import   — operator-initiated back-fill / import
 */
export const bookAttributionSourceAuthorities = [
  "book_commerce",
  "stripe_webhook",
  "ghl_webhook",
  "manual_import",
] as const;
export type BookAttributionSourceAuthority =
  (typeof bookAttributionSourceAuthorities)[number];

// ── Privacy classification vocabulary ─────────────────────────────────────────

/**
 * Privacy classification controls which attributed facts a delivery worker
 * may forward to external platforms.
 *
 *   public       — no PII; safe to send as-is (e.g. anonymous funnel event)
 *   pii_contact  — references a contact; any future provider identifier lookup
 *                  requires explicit consent and hashing/normalisation
 *   sensitive    — contains a revenue classification; requires explicit opt-in
 *                  policy gate before forwarding; currently reserved for
 *                  client_closed / qualified_opportunity with revenue
 */
export const bookAttributionPrivacyClasses = [
  "public",
  "pii_contact",
  "sensitive",
] as const;
export type BookAttributionPrivacyClass =
  (typeof bookAttributionPrivacyClasses)[number];

// ── Delivery provider vocabulary ──────────────────────────────────────────────

/**
 * Measurement platform providers that each attribution event may be delivered
 * to. A row in book_attribution_event_deliveries exists for each explicitly
 * eligible provider (not all three by default — eligibility is determined
 * server-side at insertion time based on event name and privacy class).
 */
export const bookAttributionDeliveryProviders = [
  "ga4",
  "meta_capi",
  "google_ads",
] as const;
export type BookAttributionDeliveryProvider =
  (typeof bookAttributionDeliveryProviders)[number];

// ── Delivery status vocabulary ─────────────────────────────────────────────────

/**
 * Delivery state machine for each (event, provider) row:
 *   pending   — inserted, awaiting first delivery attempt
 *   deferred  — intentionally delayed (e.g. waiting for consent signal)
 *   sent      — successfully acknowledged by the external platform
 *   retry     — a previous attempt failed transiently; will retry
 *   dead      — all attempts exhausted; requires manual intervention
 *   disabled  — provider not enabled for this event; will never be sent
 */
export const bookAttributionDeliveryStatuses = [
  "pending",
  "deferred",
  "sent",
  "retry",
  "dead",
  "disabled",
] as const;
export type BookAttributionDeliveryStatus =
  (typeof bookAttributionDeliveryStatuses)[number];

// ── Tables ─────────────────────────────────────────────────────────────────────

/**
 * book_attribution_events — append-only book-specific attribution event ledger.
 *
 * One row per meaningful funnel measurement moment. Never updated after insert.
 * Delivery state lives in book_attribution_event_deliveries.
 *
 * Source ID columns (all nullable immutable scalar snapshots):
 *   contactId         → book_contacts
 *   checkoutSessionId → book_checkout_sessions
 *   orderId           → book_orders
 *   applicationId     → book_audit_applications
 *   appointmentId     → book_appointments
 *   opportunityRef    → external GHL opportunity ID (varchar, no FK)
 *
 * Order/item context (all nullable — not all events have order context):
 *   packageCode, amountCents, currency, itemSku
 *
 * Privacy classification gates what facts delivery workers may forward.
 * occurredAt is the authoritative business timestamp (not the insert time).
 * idempotencyKey is required and globally unique — deduplication across
 * retries, replays, and cross-system imports.
 */
export const bookAttributionEvents = pgTable(
  "book_attribution_events",
  {
    // ── Identity ────────────────────────────────────────────────────────────
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Closed vocabulary event name aligned to the blueprint's event map. */
    eventName: varchar("event_name", { length: 64 }).notNull(),

    // ── Source authority + source IDs ───────────────────────────────────────
    /** Which system originated the business fact. */
    sourceAuthority: varchar("source_authority", { length: 32 }).notNull(),
    /** Immutable source reference; intentionally not an FK. */
    contactId: varchar("contact_id"),
    /** Immutable source reference; intentionally not an FK. */
    checkoutSessionId: varchar("checkout_session_id"),
    /** Immutable source reference; intentionally not an FK. */
    orderId: varchar("order_id"),
    /** Immutable source reference; intentionally not an FK. */
    applicationId: varchar("application_id"),
    /** Immutable source reference; intentionally not an FK. */
    appointmentId: varchar("appointment_id"),
    /**
     * External GHL/CRM opportunity reference (no FK — cross-system).
     * Reserved for a future approved client_closed / qualified_opportunity
     * authority. Presence of this field never makes a raw CRM update trusted.
     */
    opportunityRef: varchar("opportunity_ref", { length: 256 }),

    // ── Order / item context ─────────────────────────────────────────────────
    /** Package code snapshot at event time (digital/complete or null). */
    packageCode: varchar("package_code", { length: 32 }),
    /** Monetary amount in integer cents (e.g. order total for purchase). */
    amountCents: integer("amount_cents"),
    /** ISO 4217 currency code (e.g. USD). */
    currency: varchar("currency", { length: 3 }),
    /** Item SKU snapshot at event time (e.g. LFRE-DIGITAL-2026). */
    itemSku: varchar("item_sku", { length: 64 }),

    // ── Privacy classification ───────────────────────────────────────────────
    /**
     * Privacy classification governs what the delivery layer may forward.
     * public     → no PII forwarding restrictions
     * pii_contact → contact lookup remains consent-gated and hashed
     * sensitive  → gate on explicit policy; reserved for revenue/intake events
     */
    privacyClass: varchar("privacy_class", { length: 16 })
      .notNull()
      .default("public"),

    // ── Attribution context snapshot ─────────────────────────────────────────
    /**
     * JSONB snapshot of allow-listed attribution facts (UTM, click IDs, etc.)
     * loaded at insert time. Never raw PII. Any later contact lookup is a
     * separate consent-gated boundary. The storage API enforces this allow-list.
     */
    attributionSnapshot: jsonb("attribution_snapshot"),

    // ── Timing ────────────────────────────────────────────────────────────────
    /** When the business fact occurred (authoritative; may predate insert). */
    occurredAt: timestamp("occurred_at").notNull(),

    // ── Idempotency ──────────────────────────────────────────────────────────
    /**
     * Required globally unique logical idempotency key.
     * Prevents duplicate ledger rows on retries or cross-system replays.
     * Format convention: <eventName>:<sourceAuthority>:<sourceId>
     */
    idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),

    // ── Timestamps ────────────────────────────────────────────────────────────
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    eventNameIdx: index("book_attribution_events_event_name_idx").on(t.eventName),
    contactIdx: index("book_attribution_events_contact_id_idx").on(t.contactId),
    checkoutSessionIdx: index("book_attribution_events_checkout_session_id_idx").on(
      t.checkoutSessionId,
    ),
    orderIdx: index("book_attribution_events_order_id_idx").on(t.orderId),
    applicationIdx: index("book_attribution_events_application_id_idx").on(
      t.applicationId,
    ),
    appointmentIdx: index("book_attribution_events_appointment_id_idx").on(
      t.appointmentId,
    ),
    occurredAtIdx: index("book_attribution_events_occurred_at_idx").on(t.occurredAt),
    createdAtIdx: index("book_attribution_events_created_at_idx").on(t.createdAt),
    idempotencyUniq: uniqueIndex("book_attribution_events_idempotency_uniq").on(
      t.idempotencyKey,
    ),
    eventNameCheck: check(
      "book_attribution_events_event_name_check",
      sql`event_name IN ('view_item','select_item','begin_checkout','add_shipping_info','add_payment_info','purchase','refund','book_video_start','book_video_complete','bump_view','bump_accept','bonus_offer_view','audit_application_start','audit_application_submit','audit_application_qualified','audit_application_not_qualified','scheduler_view','appointment_booked','appointment_attended','appointment_no_show','qualified_opportunity','client_closed','access_ready','book_download','complete_collection_purchased','audiobook_start')`,
    ),
    sourceAuthorityCheck: check(
      "book_attribution_events_source_authority_check",
      sql`source_authority IN ('book_commerce','stripe_webhook','ghl_webhook','manual_import')`,
    ),
    privacyClassCheck: check(
      "book_attribution_events_privacy_class_check",
      sql`privacy_class IN ('public','pii_contact','sensitive')`,
    ),
    packageCodeCheck: check(
      "book_attribution_events_package_code_check",
      sql`package_code IS NULL OR package_code IN ('digital','complete')`,
    ),
    amountCentsCheck: check(
      "book_attribution_events_amount_cents_check",
      sql`amount_cents IS NULL OR amount_cents >= 0`,
    ),
    currencyCheck: check(
      "book_attribution_events_currency_check",
      sql`currency IS NULL OR (currency = upper(currency) AND length(currency) = 3)`,
    ),
  }),
);

export const insertBookAttributionEventSchema = createInsertSchema(
  bookAttributionEvents,
).omit({
  id: true,
  createdAt: true,
});
export type InsertBookAttributionEvent = z.infer<
  typeof insertBookAttributionEventSchema
>;
export type BookAttributionEvent = typeof bookAttributionEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * book_attribution_event_deliveries — per-provider delivery state.
 *
 * One row per (event_id, provider) pair. Only inserted for providers that are
 * explicitly eligible for the event (based on event name + privacy class).
 * Not all three providers receive every event.
 *
 * Lease protocol (worker-safe):
 *   1. Worker atomically claims a batch: UPDATE WHERE status IN ('pending','retry')
 *      AND next_attempt_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at < now())
 *      SET lease_token = <uuid>, lease_expires_at = now() + interval.
 *   2. Worker delivers to external platform.
 *   3. Worker finalizes: on success → status=sent, externalReceiptId set;
 *      on transient failure → status=retry, attempts++, nextAttemptAt = backoff;
 *      on dead → status=dead.
 *   4. Lease expiry enables re-claim by another worker without data loss.
 *
 * errorClass stores a sanitized error classification (no raw PII or stack traces).
 * externalIdempotencyKey is the key sent to the external platform for their
 * own deduplication (stable across retries for the same delivery row).
 */
export const bookAttributionEventDeliveries = pgTable(
  "book_attribution_event_deliveries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /**
     * FK to the parent attribution event (CASCADE — if the ledger row is ever
     * deleted the delivery state is also removed). NOT NULL.
     */
    eventId: varchar("event_id")
      .references(() => bookAttributionEvents.id, { onDelete: "cascade" })
      .notNull(),
    /** Target measurement platform provider. */
    provider: varchar("provider", { length: 16 }).notNull(),

    // ── Delivery status + attempt tracking ───────────────────────────────────
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    /** Total delivery attempts made (incremented on each attempt). */
    attempts: integer("attempts").notNull().default(0),
    /** Maximum attempts before the row is moved to dead. */
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** When the next delivery attempt should be made (null = immediately eligible). */
    nextAttemptAt: timestamp("next_attempt_at"),

    // ── Lease fields (worker safety) ──────────────────────────────────────────
    /**
     * Random token set when a worker claims this row. Cleared on finalization.
     * A second worker that finds a non-null, expired lease may reclaim.
     */
    leaseToken: varchar("lease_token", { length: 64 }),
    leaseExpiresAt: timestamp("lease_expires_at"),

    // ── External platform receipt ─────────────────────────────────────────────
    /**
     * Receipt/event ID returned by the external platform on success.
     * Used for reconciliation and support queries.
     */
    externalReceiptId: varchar("external_receipt_id", { length: 256 }),
    /**
     * Idempotency key sent TO the external platform. Stable across retries
     * so the platform can deduplicate repeated sends of the same logical event.
     * Format: <eventId>:<provider>
     */
    externalIdempotencyKey: varchar("external_idempotency_key", { length: 256 }),

    // ── Error tracking ────────────────────────────────────────────────────────
    /**
     * Sanitized error classification (no raw PII, no stack traces, no secrets).
     * Examples: network_timeout, rate_limited, invalid_payload, auth_error.
     */
    errorClass: varchar("error_class", { length: 64 }),

    // ── Timestamps ────────────────────────────────────────────────────────────
    /** When this delivery row was first created. */
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** When the last status change occurred. */
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    /** When delivery was successfully acknowledged (null until sent). */
    sentAt: timestamp("sent_at"),
  },
  (t) => ({
    // Unique: at most one delivery row per (event, provider).
    eventProviderUniq: uniqueIndex(
      "book_attribution_event_deliveries_event_provider_uniq",
    ).on(t.eventId, t.provider),
    // Worker polling index: provider-scoped pending/retry claim path.
    pendingClaimsIdx: index(
      "book_attribution_event_deliveries_pending_claims_idx",
    ).on(t.provider, t.status, t.nextAttemptAt),
    // Lease expiry sweep index.
    leaseExpiresIdx: index(
      "book_attribution_event_deliveries_lease_expires_idx",
    )
      .on(t.leaseExpiresAt)
      .where(sql`lease_expires_at IS NOT NULL`),
    statusCheck: check(
      "book_attribution_event_deliveries_status_check",
      sql`status IN ('pending','deferred','sent','retry','dead','disabled')`,
    ),
    providerCheck: check(
      "book_attribution_event_deliveries_provider_check",
      sql`provider IN ('ga4','meta_capi','google_ads')`,
    ),
    attemptsCheck: check(
      "book_attribution_event_deliveries_attempts_check",
      sql`attempts >= 0 AND max_attempts >= 1`,
    ),
  }),
);

export const insertBookAttributionEventDeliverySchema = createInsertSchema(
  bookAttributionEventDeliveries,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  sentAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
  externalReceiptId: true,
  errorClass: true,
});
export type InsertBookAttributionEventDelivery = z.infer<
  typeof insertBookAttributionEventDeliverySchema
>;
export type BookAttributionEventDelivery =
  typeof bookAttributionEventDeliveries.$inferSelect;
