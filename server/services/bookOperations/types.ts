/**
 * Shared TypeScript types for the book operations read-model surface.
 *
 * No DB imports here — pure type definitions reused across the focused
 * sub-modules and re-exported through the barrel.
 */

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface BookOperationsSummaryFunnelStage {
  stage: string;
  count: number;
}

export interface BookOperationsSummaryConversionRate {
  from: string;
  to: string;
  /** null when the upstream stage has 0 events (division-by-zero guard). */
  rate: number | null;
}

export interface BookOperationsSummarySlice {
  key: string;
  label: string;
  grossCents: number;
  refundCents: number;
  netCents: number;
  orderCount: number;
}

export interface BookOperationsSummaryFinancials {
  grossCents: number;
  refundCents: number;
  netCents: number;
  orderCount: number;
  /** null when orderCount = 0. */
  aovCents: number | null;
}

export interface BookOperationsSummaryMarginInputs {
  status: "unavailable";
  value: null;
}

export interface BookOperationsSummary {
  period: { from: string; to: string };
  funnel: BookOperationsSummaryFunnelStage[];
  conversionRates: BookOperationsSummaryConversionRate[];
  packageSlices: BookOperationsSummarySlice[];
  channelSlices: BookOperationsSummarySlice[];
  campaignSlices: BookOperationsSummarySlice[];
  financials: BookOperationsSummaryFinancials;
  /** Margin inputs are not available from local DB data alone. */
  marginInputs: BookOperationsSummaryMarginInputs;
}

// ─── Records list ─────────────────────────────────────────────────────────────

export interface BookOperationListItem {
  contactId: string | null;
  contactEmailMasked: string | null;
  contactNameMasked: string | null;
  contactPhoneMasked: string | null;
  checkoutSessionId: string | null;
  checkoutStatus: string | null;
  checkoutPackageCode: string | null;
  checkoutPaymentState: string | null;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
  orderTotalCents: number | null;
  createdAt: string;
}

export interface BookOperationListResult {
  total: number;
  hasMore: boolean;
  items: BookOperationListItem[];
}

// ─── Detail ───────────────────────────────────────────────────────────────────

export interface BookOperationEntitlementDeliveryAuditEntry {
  id: string;
  /** Fixed public code; unknown stored values collapse to delivery_event. */
  eventType: string;
  outcome: string;
  createdAt: string;
}

export interface BookOperationEntitlement {
  id: string;
  entitlementCode: string;
  packageCode: string;
  status: string;
  grantedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  /** Bounded to 50 newest entries; never unbounded. */
  deliveryAudit: BookOperationEntitlementDeliveryAuditEntry[];
}

export interface BookOperationPaymentEventRef {
  id: string;
  provider: string;
  /** Provider-assigned event ID — exact correlation for support. */
  providerEventId: string | null;
  eventType: string;
  amountCents: number | null;
  currency: string | null;
  processedAt: string | null;
  createdAt: string;
  /** No raw_payload — never returned. */
}

export interface BookOperationLifecycleEntry {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
  /** metadata is intentionally omitted — may contain intake data. */
}

export interface BookOperationProviderCorrelation {
  id: string;
  provider: string;
  providerEntityType: string;
  /** Provider-side ID — exact correlation for support. */
  providerEntityId: string;
  localEntityType: string;
  localEntityId: string;
  createdAt: string;
}

export interface BookOperationOutboxState {
  id: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  /** payload is intentionally omitted — may contain provider data. */
}

export interface BookOperationAttributionDelivery {
  id: string;
  /** Parent event ID — exact correlation for support. */
  eventId: string;
  provider: string;
  status: string;
  attempts: number;
  externalReceiptId: string | null;
  /** Idempotency key sent TO the external platform — exact replay correlation. */
  externalIdempotencyKey: string | null;
  /** Sanitized error class (no raw provider errors). */
  errorClass: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface BookOperationDetail {
  // Contact (masked)
  contactId: string | null;
  contactEmailMasked: string | null;
  contactNameMasked: string | null;
  contactPhoneMasked: string | null;

  // Checkout (no address_snapshot)
  checkoutSessionId: string | null;
  checkoutPackageCode: string | null;
  checkoutStatus: string | null;
  checkoutPaymentState: string | null;
  checkoutSubtotalCents: number | null;
  checkoutDiscountCents: number | null;
  checkoutShippingCents: number | null;
  checkoutTaxCents: number | null;
  checkoutTotalCents: number | null;
  checkoutCurrency: string | null;
  checkoutCreatedAt: string | null;
  checkoutCompletedAt: string | null;

  // Order
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
  orderPackageCode: string | null;
  orderTotalCents: number | null;
  orderRefundedCents: number | null;
  orderCurrency: string | null;
  orderCreatedAt: string | null;

  // Entitlements + bounded safe delivery audit
  entitlements: BookOperationEntitlement[];

  // Application — status only (no answers, notes, decisionReason)
  applicationStatus: string | null;
  applicationSubmittedAt: string | null;
  applicationDecidedAt: string | null;

  // Appointment — status only (no notes, cancelledReason)
  appointmentStatus: string | null;
  appointmentScheduledAt: string | null;

  // Payment event safe refs (no raw_payload)
  paymentEvents: BookOperationPaymentEventRef[];

  // Lifecycle timeline (no metadata)
  lifecycleEvents: BookOperationLifecycleEntry[];

  // Provider correlations
  providerCorrelations: BookOperationProviderCorrelation[];

  // GHL outbox state (no payload)
  outboxEntries: BookOperationOutboxState[];

  // Attribution delivery state + correlations
  attributionDeliveries: BookOperationAttributionDelivery[];
}

// ─── Exceptions ───────────────────────────────────────────────────────────────

export type BookOperationExceptionKind =
  | "all"
  | "payments"
  | "ghl"
  | "analytics"
  | "delivery";

export interface BookOperationException {
  source:
    | "checkout_payment"
    | "payment_event"
    | "ghl_outbox"
    | "analytics_delivery"
    | "delivery_audit";
  exceptionKind: string;
  entityId: string;
  entityType: string;
  providerOrPlatform: string | null;
  localReferenceId: string | null;
  /** Eligible local command target, null when the row is inspect-only. */
  repairTargetId: string | null;
  status: string;
  /** Sanitized reason — never raw provider error text. */
  reason: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface BookOperationExceptionsResult {
  total: number;
  hasMore: boolean;
  items: BookOperationException[];
}

// ─── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayBookOutboxEntryInput {
  outboxId: string;
  actorUserId: string;
  idempotencyKey: string;
}

/**
 * Result shape consumed by server/routes/bookOperations.ts.
 *
 * The route assigns the result to `UnknownRecord` (Record<string, unknown>)
 * and checks `result.replayed === true` to decide whether to kick the GHL
 * worker.  The index signature makes this type structurally assignable to
 * Record<string, unknown> without losing the named fields.
 */
export interface ReplayBookOutboxEntryResult {
  /** true when the outbox row was successfully transitioned to pending. */
  replayed: boolean;
  /** true when the same idempotency-key lifecycle event already existed. */
  idempotent: boolean;
  outboxId: string;
  // Index signature for compatibility with Record<string, unknown>
  [key: string]: unknown;
}
