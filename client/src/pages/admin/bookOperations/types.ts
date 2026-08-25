/**
 * Client-side type definitions mirroring server/services/bookOperations.ts
 * and server/routes/bookOperations.ts exactly.
 *
 * No fabricated fields — every shape matches the server contracts.
 */

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface BookOpsFunnelStage {
  stage: string;
  count: number;
}

export interface BookOpsConversionRate {
  from: string;
  to: string;
  rate: number | null;
}

export interface BookOpsSlice {
  key: string;
  label: string;
  grossCents: number;
  refundCents: number;
  netCents: number;
  orderCount: number;
}

export interface BookOpsFinancials {
  grossCents: number;
  refundCents: number;
  netCents: number;
  orderCount: number;
  aovCents: number | null;
}

export interface BookOpsMarginInputs {
  status: "unavailable";
  value: null;
}

export interface BookOpsSummary {
  period: { from: string; to: string };
  funnel: BookOpsFunnelStage[];
  conversionRates: BookOpsConversionRate[];
  packageSlices: BookOpsSlice[];
  channelSlices: BookOpsSlice[];
  campaignSlices: BookOpsSlice[];
  financials: BookOpsFinancials;
  marginInputs: BookOpsMarginInputs;
}

// ─── List records ─────────────────────────────────────────────────────────────

export interface BookOpsListItem {
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

export interface BookOpsListResult {
  total: number;
  hasMore: boolean;
  items: BookOpsListItem[];
}

// ─── Record detail ────────────────────────────────────────────────────────────

export interface BookOpsEntitlementAudit {
  id: string;
  eventType: string;
  outcome: string;
  createdAt: string;
}

export interface BookOpsEntitlement {
  id: string;
  entitlementCode: string;
  packageCode: string;
  status: string;
  grantedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  deliveryAudit: BookOpsEntitlementAudit[];
}

export interface BookOpsPaymentEventRef {
  id: string;
  provider: string;
  providerEventId: string | null;
  eventType: string;
  amountCents: number | null;
  currency: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface BookOpsLifecycleEntry {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface BookOpsProviderCorrelation {
  id: string;
  provider: string;
  providerEntityType: string;
  providerEntityId: string;
  localEntityType: string;
  localEntityId: string;
  createdAt: string;
}

export interface BookOpsOutboxState {
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
}

export interface BookOpsAttributionDelivery {
  id: string;
  eventId: string;
  provider: string;
  status: string;
  attempts: number;
  externalReceiptId: string | null;
  externalIdempotencyKey: string | null;
  errorClass: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface BookOpsDetail {
  // Contact (masked)
  contactId: string | null;
  contactEmailMasked: string | null;
  contactNameMasked: string | null;
  contactPhoneMasked: string | null;

  // Checkout
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

  // Entitlements + delivery audit
  entitlements: BookOpsEntitlement[];

  // Application (status only, no answers/notes)
  applicationStatus: string | null;
  applicationSubmittedAt: string | null;
  applicationDecidedAt: string | null;

  // Appointment (status only)
  appointmentStatus: string | null;
  appointmentScheduledAt: string | null;

  // Payment events (no raw_payload)
  paymentEvents: BookOpsPaymentEventRef[];

  // Lifecycle timeline
  lifecycleEvents: BookOpsLifecycleEntry[];

  // Provider correlations
  providerCorrelations: BookOpsProviderCorrelation[];

  // GHL outbox state
  outboxEntries: BookOpsOutboxState[];

  // Attribution delivery state
  attributionDeliveries: BookOpsAttributionDelivery[];
}

// ─── Exceptions ───────────────────────────────────────────────────────────────

export type BookOpsExceptionSource =
  | "checkout_payment"
  | "payment_event"
  | "ghl_outbox"
  | "analytics_delivery"
  | "delivery_audit";

export interface BookOpsException {
  source: BookOpsExceptionSource;
  exceptionKind: string;
  entityId: string;
  entityType: string;
  providerOrPlatform: string | null;
  localReferenceId: string | null;
  repairTargetId: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface BookOpsExceptionsResult {
  total: number;
  hasMore: boolean;
  items: BookOpsException[];
}

// ─── Health ───────────────────────────────────────────────────────────────────

export interface BookOpsHealthProvider {
  connected: boolean | null;
  disconnectReason: string | null;
  lastCheckedAt: string | null;
  lastProbeError: string | null;
}

export interface BookOpsHealth {
  source: "cache_only";
  providers: {
    stripe: BookOpsHealthProvider;
    ghl: BookOpsHealthProvider;
  };
  launchReadiness: {
    evaluatedAt: string;
    environment: string;
    policies: Array<{
      key: string;
      version: string | null;
      approvalStatus: string;
      ownerApproved: boolean;
      counselApproved: boolean;
      published: boolean;
      canonicalPath: string | null;
    }>;
    fulfillmentBoundary: {
      state: "inactive";
      provider: null;
      providerApproved: false;
      capabilities: Record<string, boolean>;
    };
    packages: Record<
      "digital" | "complete",
      {
        purchasable: boolean;
        blockers: Array<{
          code: string;
          state: string;
          detail: string;
        }>;
      }
    >;
  };
}

// ─── Filter enum values (matching route schema) ───────────────────────────────

export const RECORD_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "exception", label: "Exception" },
  { value: "refunded", label: "Refunded" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const EXCEPTION_KIND_OPTIONS = [
  { value: "all", label: "All kinds" },
  { value: "payments", label: "Payments" },
  { value: "ghl", label: "GHL outbox" },
  { value: "analytics", label: "Analytics" },
  { value: "delivery", label: "Delivery" },
] as const;

export type RecordStatusFilter = (typeof RECORD_STATUS_OPTIONS)[number]["value"];
export type ExceptionKindFilter = (typeof EXCEPTION_KIND_OPTIONS)[number]["value"];
