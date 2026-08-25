/**
 * Server-owned book-funnel policy and purchase-disclosure contract.
 *
 * Approval state is code-reviewed configuration, not browser input and not an
 * environment toggle. A paid offer cannot open until every policy it depends
 * on has a durable version plus both owner and counsel approval evidence.
 *
 * The current records are intentionally fail-closed: the legacy privacy notice
 * remains published for compatibility, but no final owner/counsel-approved
 * funnel policy set was supplied with the launch blueprint.
 */

export type BookFunnelPolicyKey =
  | "privacy"
  | "terms"
  | "shippingReturns"
  | "checkoutDisclosure";

export type BookFunnelPolicyApprovalStatus =
  | "approved"
  | "legacy_unverified"
  | "missing_approval";

export interface BookFunnelPolicyRecord {
  key: BookFunnelPolicyKey;
  title: string;
  canonicalPath: string | null;
  legacyPaths: readonly string[];
  version: string | null;
  approvalStatus: BookFunnelPolicyApprovalStatus;
  ownerApproved: boolean;
  counselApproved: boolean;
  approvedAt: string | null;
  published: boolean;
}

export const BOOK_FUNNEL_POLICY_MANIFEST: Readonly<
  Record<BookFunnelPolicyKey, Readonly<BookFunnelPolicyRecord>>
> = Object.freeze({
  privacy: Object.freeze({
    key: "privacy",
    title: "Privacy Policy",
    canonicalPath: "privacy/",
    legacyPaths: Object.freeze(["privacy-policy/"]),
    version: "privacy-legacy-2026-08-21",
    approvalStatus: "legacy_unverified",
    ownerApproved: false,
    counselApproved: false,
    approvedAt: null,
    published: true,
  }),
  terms: Object.freeze({
    key: "terms",
    title: "Terms of Purchase",
    canonicalPath: "terms/",
    legacyPaths: Object.freeze([]),
    version: "terms-pending-2026-08-21",
    approvalStatus: "missing_approval",
    ownerApproved: false,
    counselApproved: false,
    approvedAt: null,
    published: false,
  }),
  shippingReturns: Object.freeze({
    key: "shippingReturns",
    title: "Shipping & Returns",
    canonicalPath: "shipping-returns/",
    legacyPaths: Object.freeze([]),
    version: "shipping-returns-pending-2026-08-21",
    approvalStatus: "missing_approval",
    ownerApproved: false,
    counselApproved: false,
    approvedAt: null,
    published: false,
  }),
  checkoutDisclosure: Object.freeze({
    key: "checkoutDisclosure",
    title: "Book Checkout Purchase Disclosure",
    canonicalPath: null,
    legacyPaths: Object.freeze([]),
    version: "checkout-disclosure-pending-2026-08-21",
    approvalStatus: "missing_approval",
    ownerApproved: false,
    counselApproved: false,
    approvedAt: null,
    published: false,
  }),
});

export function isBookFunnelPolicyApproved(
  policy: BookFunnelPolicyRecord,
): boolean {
  return (
    policy.approvalStatus === "approved" &&
    policy.ownerApproved &&
    policy.counselApproved &&
    policy.published &&
    typeof policy.version === "string" &&
    policy.version.length > 0
  );
}

export const BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION =
  "book-purchase-policy-snapshot-v1" as const;

export interface BookPurchasePolicySnapshot {
  schemaVersion: typeof BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  presentationSurface: "book_checkout";
  acceptanceAction: "payment_submission";
  privacyVersion: string;
  termsVersion: string;
  shippingReturnsVersion: string;
  checkoutDisclosureVersion: string;
  taxTreatmentVersion: string;
  refundHandlingVersion: string;
  supportProcedureVersion: string;
  verificationEvidenceVersion: string;
  approvalEnvironment: string;
}

export interface BookPurchasePolicySnapshotInput {
  capturedAt?: Date;
  taxTreatmentVersion: string;
  refundHandlingVersion: string;
  supportProcedureVersion: string;
  verificationEvidenceVersion: string;
  approvalEnvironment: string;
}

/**
 * Build the immutable checkout snapshot only from the approved manifest.
 * Returns null while any policy approval is absent; callers must fail closed.
 */
export function buildApprovedBookPurchasePolicySnapshot(
  input: BookPurchasePolicySnapshotInput,
): BookPurchasePolicySnapshot | null {
  const privacy = BOOK_FUNNEL_POLICY_MANIFEST.privacy;
  const terms = BOOK_FUNNEL_POLICY_MANIFEST.terms;
  const shippingReturns = BOOK_FUNNEL_POLICY_MANIFEST.shippingReturns;
  const checkoutDisclosure = BOOK_FUNNEL_POLICY_MANIFEST.checkoutDisclosure;
  const required = [privacy, terms, shippingReturns, checkoutDisclosure];
  if (required.some((policy) => !isBookFunnelPolicyApproved(policy))) {
    return null;
  }
  const versions = [
    input.taxTreatmentVersion,
    input.refundHandlingVersion,
    input.supportProcedureVersion,
    input.verificationEvidenceVersion,
    input.approvalEnvironment,
  ];
  if (versions.some((value) => !value.trim() || value.length > 128)) {
    return null;
  }
  return {
    schemaVersion: BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    presentationSurface: "book_checkout",
    acceptanceAction: "payment_submission",
    privacyVersion: privacy.version!,
    termsVersion: terms.version!,
    shippingReturnsVersion: shippingReturns.version!,
    checkoutDisclosureVersion: checkoutDisclosure.version!,
    taxTreatmentVersion: input.taxTreatmentVersion,
    refundHandlingVersion: input.refundHandlingVersion,
    supportProcedureVersion: input.supportProcedureVersion,
    verificationEvidenceVersion: input.verificationEvidenceVersion,
    approvalEnvironment: input.approvalEnvironment,
  };
}
