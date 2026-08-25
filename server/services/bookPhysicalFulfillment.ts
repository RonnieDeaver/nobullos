/**
 * Provider-neutral physical-fulfillment boundary for a future approved vendor.
 *
 * The boundary is deliberately inactive. No implementation, credential,
 * provider SDK, endpoint, or speculative network call is registered here.
 * Complete Collection remains unavailable while this state is inactive.
 */

export type BookPhysicalFulfillmentStatus =
  | "submitted"
  | "accepted"
  | "in_production"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "replacement_requested"
  | "replaced"
  | "exception";

export interface BookPhysicalFulfillmentCorrelation {
  orderId: string;
  orderNumber: string;
  idempotencyKey: string;
  providerOrderId: string | null;
}

export interface BookPhysicalFulfillmentCreateRequest {
  correlation: BookPhysicalFulfillmentCorrelation;
  packageCode: "complete";
  recipient: {
    name: string;
    address: {
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
}

export interface BookPhysicalFulfillmentResult {
  correlation: BookPhysicalFulfillmentCorrelation;
  status: BookPhysicalFulfillmentStatus;
  trackingNumber: string | null;
  trackingUrl: string | null;
  updatedAt: string;
}

export interface BookPhysicalFulfillmentProvider {
  createOrder(
    request: BookPhysicalFulfillmentCreateRequest,
  ): Promise<BookPhysicalFulfillmentResult>;
  getStatus(
    correlation: BookPhysicalFulfillmentCorrelation,
  ): Promise<BookPhysicalFulfillmentResult>;
  getTracking(
    correlation: BookPhysicalFulfillmentCorrelation,
  ): Promise<BookPhysicalFulfillmentResult>;
  cancelOrder(
    correlation: BookPhysicalFulfillmentCorrelation,
  ): Promise<BookPhysicalFulfillmentResult>;
  requestReplacement(
    correlation: BookPhysicalFulfillmentCorrelation,
    reasonCode: string,
  ): Promise<BookPhysicalFulfillmentResult>;
}

export const BOOK_PHYSICAL_FULFILLMENT_BOUNDARY = Object.freeze({
  state: "inactive" as const,
  provider: null,
  providerApproved: false,
  capabilities: Object.freeze({
    create: false,
    status: false,
    tracking: false,
    cancel: false,
    replacement: false,
  }),
});

/**
 * Server-only acceptance gate for physical orders. Environment flags cannot
 * activate this boundary; a future approved provider implementation must
 * change the boundary state and every required capability in code.
 */
export function isBookPhysicalFulfillmentActive(): boolean {
  const boundary = BOOK_PHYSICAL_FULFILLMENT_BOUNDARY as {
    state: string;
    providerApproved: boolean;
    capabilities: Record<string, boolean>;
  };
  return (
    boundary.state === "active" &&
    boundary.providerApproved &&
    Object.values(boundary.capabilities).every(Boolean)
  );
}
