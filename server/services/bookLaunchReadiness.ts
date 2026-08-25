// @db-pool-intent: api
/**
 * Local, fail-closed launch readiness for paid book offers.
 *
 * Reads only environment-scoped configuration, already-cached Stripe health,
 * and local delivery-asset rows. It never probes Stripe or a fulfillment
 * provider and never performs network I/O.
 */
import { and, eq, inArray } from "drizzle-orm";
import { bookDeliveryAssets } from "@shared/schema";
import {
  BOOK_FUNNEL_POLICY_MANIFEST,
  BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION,
  buildApprovedBookPurchasePolicySnapshot,
  isBookFunnelPolicyApproved,
  type BookPurchasePolicySnapshot,
} from "@shared/bookCommerceLaunch";
import { getDb, withDbAttribution } from "../db";
import {
  readCachedIntegrationStatusOnly,
  type CachedIntegrationStatus,
} from "./integrationStatusCache";
import { registerModuleStateResetForTest } from "./moduleStateReset";
import {
  BOOK_PHYSICAL_FULFILLMENT_BOUNDARY,
} from "./bookPhysicalFulfillment";
import {
  PackageNotSelectableError,
  resolveCompleteUsShippingCents,
  type BookCommercePackageCode,
  type PackageLaunchGateContext,
} from "./bookCommerceCatalog";
import { isRunningInDeployment } from "../lib/deploymentEnv";

const STRIPE_HEALTH_MAX_AGE_MS = 5 * 60_000;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type BookLaunchBlockerState =
  | "missing"
  | "unapproved"
  | "stale"
  | "disconnected"
  | "inactive"
  | "invalid"
  | "environment_mismatch";

export interface BookLaunchBlocker {
  code: string;
  state: BookLaunchBlockerState;
  detail: string;
}

export interface BookPackageLaunchReadiness {
  purchasable: boolean;
  blockers: BookLaunchBlocker[];
  policySnapshot: BookPurchasePolicySnapshot | null;
}

export interface BookLaunchReadinessReport {
  evaluatedAt: string;
  environment: string;
  policySnapshotSchemaVersion: typeof BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION;
  policies: Array<{
    key: string;
    version: string | null;
    approvalStatus: string;
    ownerApproved: boolean;
    counselApproved: boolean;
    published: boolean;
    canonicalPath: string | null;
  }>;
  fulfillmentBoundary: typeof BOOK_PHYSICAL_FULFILLMENT_BOUNDARY;
  packages: {
    digital: BookPackageLaunchReadiness;
    complete: BookPackageLaunchReadiness;
  };
}

function runtimeEnvironment(): string {
  if (isRunningInDeployment()) return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return process.env.NODE_ENV?.trim() || "development";
}

function configuredVersion(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && VERSION_PATTERN.test(value) ? value : null;
}

function addFlagBlocker(
  blockers: BookLaunchBlocker[],
  envName: string,
  code: string,
  detail: string,
): void {
  if (process.env[envName] !== "true") {
    blockers.push({ code, state: "unapproved", detail });
  }
}

function requireVersion(
  blockers: BookLaunchBlocker[],
  envName: string,
  code: string,
  detail: string,
): string | null {
  const raw = process.env[envName]?.trim();
  const version = configuredVersion(envName);
  if (!version) {
    blockers.push({
      code,
      state: raw ? "invalid" : "missing",
      detail,
    });
  }
  return version;
}

interface ActiveAssetFacts {
  activeCodes: Set<string>;
  readFailed: boolean;
}

interface BookLaunchReadinessDependencyOverride {
  now?: Date;
  stripe?: CachedIntegrationStatus<{
    connected: boolean;
    disconnectReason?: string | null;
  }>;
  assets?: ActiveAssetFacts;
}

async function readActiveAssetFacts(): Promise<ActiveAssetFacts> {
  try {
    const rows = await withDbAttribution(
      "book-launch-readiness:delivery-assets",
      async () =>
        getDb()
          .select({ entitlementCode: bookDeliveryAssets.entitlementCode })
          .from(bookDeliveryAssets)
          .where(
            and(
              eq(bookDeliveryAssets.status, "active"),
              inArray(bookDeliveryAssets.entitlementCode, [
                "digital_book",
                "audiobook",
                "print_fulfillment",
              ]),
            ),
          ),
    );
    return {
      activeCodes: new Set(rows.map((row) => row.entitlementCode)),
      readFailed: false,
    };
  } catch {
    return { activeCodes: new Set(), readFailed: true };
  }
}

let testReportOverride: BookLaunchReadinessReport | null = null;
let testDependencyOverride: BookLaunchReadinessDependencyOverride | null = null;

export function __setBookLaunchReadinessReportForTest(
  report: BookLaunchReadinessReport | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Book launch readiness override is test-only");
  }
  testReportOverride = report;
}

export function __setBookLaunchReadinessDependenciesForTest(
  override: BookLaunchReadinessDependencyOverride | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Book launch readiness dependency override is test-only");
  }
  testDependencyOverride = override;
}

registerModuleStateResetForTest(
  "bookLaunchReadiness",
  () => {
    testReportOverride = null;
    testDependencyOverride = null;
  },
);

function makeReadyPackage(
  snapshot: BookPurchasePolicySnapshot,
): BookPackageLaunchReadiness {
  return { purchasable: true, blockers: [], policySnapshot: snapshot };
}

/** Explicit helper for existing hermetic commerce suites. Never used in app code. */
export function makeReadyBookLaunchReadinessReportForTest(): BookLaunchReadinessReport {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Ready book launch report is test-only");
  }
  const snapshot: BookPurchasePolicySnapshot = {
    schemaVersion: BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    presentationSurface: "book_checkout",
    acceptanceAction: "payment_submission",
    privacyVersion: "test-privacy-v1",
    termsVersion: "test-terms-v1",
    shippingReturnsVersion: "test-shipping-returns-v1",
    checkoutDisclosureVersion: "test-checkout-disclosure-v1",
    taxTreatmentVersion: "test-tax-v1",
    refundHandlingVersion: "test-refund-v1",
    supportProcedureVersion: "test-support-v1",
    verificationEvidenceVersion: "test-evidence-v1",
    approvalEnvironment: "test",
  };
  return {
    evaluatedAt: new Date().toISOString(),
    environment: "test",
    policySnapshotSchemaVersion: BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION,
    policies: Object.values(BOOK_FUNNEL_POLICY_MANIFEST).map((policy) => ({
      key: policy.key,
      version: policy.version,
      approvalStatus: policy.approvalStatus,
      ownerApproved: policy.ownerApproved,
      counselApproved: policy.counselApproved,
      published: policy.published,
      canonicalPath: policy.canonicalPath,
    })),
    fulfillmentBoundary: BOOK_PHYSICAL_FULFILLMENT_BOUNDARY,
    packages: {
      digital: makeReadyPackage(snapshot),
      complete: makeReadyPackage(snapshot),
    },
  };
}

export async function getBookLaunchReadinessReport(): Promise<BookLaunchReadinessReport> {
  if (testReportOverride) return testReportOverride;

  const environment = runtimeEnvironment();
  const evaluatedAt = testDependencyOverride?.now ?? new Date();
  const [stripe, assets] = await Promise.all([
    testDependencyOverride?.stripe ??
      readCachedIntegrationStatusOnly<{
        connected: boolean;
        disconnectReason?: string | null;
      }>("stripe"),
    testDependencyOverride?.assets ?? readActiveAssetFacts(),
  ]);

  const digital: BookLaunchBlocker[] = [];
  const completeOnly: BookLaunchBlocker[] = [];

  addFlagBlocker(
    digital,
    "BOOK_COMMERCE_DIGITAL_ENABLED",
    "digital.offer_disabled",
    "Digital Edition has not been explicitly enabled.",
  );
  addFlagBlocker(
    digital,
    "BOOK_COMMERCE_STRIPE_CONFIGURATION_APPROVED",
    "payment.configuration_unapproved",
    "Stripe product, price, webhook, and refund configuration approval is missing.",
  );
  if (!process.env.STRIPE_PUBLISHABLE_KEY?.trim()) {
    digital.push({
      code: "payment.publishable_key_missing",
      state: "missing",
      detail: "Stripe publishable configuration is missing.",
    });
  }
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    digital.push({
      code: "payment.secret_key_missing",
      state: "missing",
      detail: "Stripe server configuration is missing.",
    });
  }
  const stripeCheckedAt = stripe.lastCheckedAt
    ? Date.parse(stripe.lastCheckedAt)
    : Number.NaN;
  if (stripe.value?.connected !== true) {
    digital.push({
      code:
        stripe.value?.connected === false
          ? "payment.stripe_disconnected"
          : "payment.stripe_health_unknown",
      state: stripe.value?.connected === false ? "disconnected" : "missing",
      detail: "Cached Stripe integration health is not connected.",
    });
  } else if (
    !Number.isFinite(stripeCheckedAt) ||
    evaluatedAt.getTime() - stripeCheckedAt > STRIPE_HEALTH_MAX_AGE_MS
  ) {
    digital.push({
      code: "payment.stripe_health_stale",
      state: "stale",
      detail: "Cached Stripe integration health is older than five minutes.",
    });
  }

  for (const policy of Object.values(BOOK_FUNNEL_POLICY_MANIFEST)) {
    if (!isBookFunnelPolicyApproved(policy)) {
      digital.push({
        code: `policy.${policy.key}_unapproved`,
        state:
          policy.approvalStatus === "missing_approval" ? "missing" : "unapproved",
        detail: `${policy.title} lacks a published owner/counsel-approved version.`,
      });
    }
  }

  addFlagBlocker(
    digital,
    "BOOK_COMMERCE_TAX_TREATMENT_APPROVED",
    "tax.treatment_unapproved",
    "Tax treatment has not been approved.",
  );
  const taxTreatmentVersion = requireVersion(
    digital,
    "BOOK_COMMERCE_TAX_TREATMENT_VERSION",
    "tax.treatment_version_missing",
    "An approved tax-treatment version is required.",
  );
  addFlagBlocker(
    digital,
    "BOOK_COMMERCE_REFUND_HANDLING_APPROVED",
    "refund.handling_unapproved",
    "Refund handling has not been approved.",
  );
  const refundHandlingVersion = requireVersion(
    digital,
    "BOOK_COMMERCE_REFUND_HANDLING_VERSION",
    "refund.handling_version_missing",
    "An approved refund-handling version is required.",
  );

  if (assets.readFailed) {
    digital.push({
      code: "asset.inventory_unavailable",
      state: "missing",
      detail: "The private delivery-asset inventory could not be read.",
    });
  } else if (!assets.activeCodes.has("digital_book")) {
    digital.push({
      code: "asset.digital_book_missing",
      state: "missing",
      detail: "No active private Digital Edition asset is configured.",
    });
  }
  if (!process.env.PRIVATE_OBJECT_DIR?.trim()) {
    digital.push({
      code: "delivery.private_storage_missing",
      state: "missing",
      detail: "Private object-storage delivery is not configured.",
    });
  }
  addFlagBlocker(
    digital,
    "BOOK_COMMERCE_TRANSACTIONAL_DELIVERY_APPROVED",
    "delivery.transactional_delivery_unapproved",
    "Transactional receipt and access delivery has not been approved.",
  );
  addFlagBlocker(
    digital,
    "BOOK_COMMERCE_SUPPORT_PROCEDURE_APPROVED",
    "support.procedure_unapproved",
    "Book-order support ownership and procedure approval is missing.",
  );
  const supportProcedureVersion = requireVersion(
    digital,
    "BOOK_COMMERCE_SUPPORT_PROCEDURE_VERSION",
    "support.procedure_version_missing",
    "A versioned support procedure is required.",
  );
  const verificationEvidenceVersion = requireVersion(
    digital,
    "BOOK_COMMERCE_DIGITAL_VERIFICATION_EVIDENCE_VERSION",
    "verification.evidence_missing",
    "Digital launch verification evidence is required.",
  );
  const approvalEnvironment = configuredVersion(
    "BOOK_COMMERCE_APPROVAL_ENVIRONMENT",
  );
  if (!approvalEnvironment) {
    digital.push({
      code: "verification.environment_missing",
      state: "missing",
      detail: "The approval environment is not configured.",
    });
  } else if (approvalEnvironment !== environment) {
    digital.push({
      code: "verification.environment_mismatch",
      state: "environment_mismatch",
      detail: `Approval evidence is for ${approvalEnvironment}, not ${environment}.`,
    });
  }

  addFlagBlocker(
    completeOnly,
    "BOOK_COMMERCE_COMPLETE_ENABLED",
    "complete.offer_disabled",
    "Complete Collection has not been explicitly enabled.",
  );
  addFlagBlocker(
    completeOnly,
    "BOOK_COMMERCE_COMPLETE_APPROVED",
    "complete.offer_unapproved",
    "Complete Collection launch approval is missing.",
  );
  completeOnly.push({
    code: "fulfillment.provider_inactive",
    state: "inactive",
    detail: "No physical-fulfillment provider boundary is active.",
  });
  for (const [capability, active] of Object.entries(
    BOOK_PHYSICAL_FULFILLMENT_BOUNDARY.capabilities,
  )) {
    if (!active) {
      completeOnly.push({
        code: `fulfillment.${capability}_capability_inactive`,
        state: "inactive",
        detail: `Physical-fulfillment ${capability} capability is inactive.`,
      });
    }
  }
  addFlagBlocker(
    completeOnly,
    "BOOK_COMMERCE_COMPLETE_US_SCOPE_APPROVED",
    "fulfillment.us_scope_unapproved",
    "U.S. fulfillment scope has not been approved.",
  );
  const internationalDecision = process.env
    .BOOK_COMMERCE_COMPLETE_INTERNATIONAL_SCOPE?.trim();
  if (
    internationalDecision !== "domestic_only" &&
    internationalDecision !== "approved"
  ) {
    completeOnly.push({
      code: "fulfillment.international_scope_undecided",
      state: "missing",
      detail:
        "International scope must be explicitly approved or set to domestic_only.",
    });
  }
  const completeShippingCents = resolveCompleteUsShippingCents();
  if (completeShippingCents === null) {
    completeOnly.push({
      code:
        process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS == null
          ? "shipping.rate_missing"
          : "shipping.rate_invalid",
      state:
        process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS == null
          ? "missing"
          : "invalid",
      detail:
        process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS == null
          ? "Approved U.S. shipping charges are not configured."
          : "The configured U.S. shipping charge is invalid.",
    });
  }
  for (const [envName, code, detail] of [
    [
      "BOOK_COMMERCE_COMPLETE_SHIPPING_TIMES_VERSION",
      "shipping.times_missing",
      "Approved shipping-time disclosures are missing.",
    ],
    [
      "BOOK_COMMERCE_COMPLETE_CANCELLATION_VERSION",
      "cancellation.policy_missing",
      "Approved cancellation handling is missing.",
    ],
    [
      "BOOK_COMMERCE_COMPLETE_RETURN_VERSION",
      "returns.policy_missing",
      "Approved return handling is missing.",
    ],
    [
      "BOOK_COMMERCE_COMPLETE_REPLACEMENT_VERSION",
      "replacement.policy_missing",
      "Approved replacement handling is missing.",
    ],
    [
      "BOOK_COMMERCE_COMPLETE_MARGIN_EVIDENCE_VERSION",
      "margin.evidence_missing",
      "Approved margin evidence is missing.",
    ],
    [
      "BOOK_COMMERCE_COMPLETE_VERIFICATION_EVIDENCE_VERSION",
      "verification.complete_evidence_missing",
      "Complete Collection verification evidence is missing.",
    ],
  ] as const) {
    requireVersion(completeOnly, envName, code, detail);
  }
  if (!assets.readFailed && !assets.activeCodes.has("audiobook")) {
    completeOnly.push({
      code: "asset.audiobook_missing",
      state: "missing",
      detail: "No active final audiobook asset is configured.",
    });
  }
  if (!assets.readFailed && !assets.activeCodes.has("print_fulfillment")) {
    completeOnly.push({
      code: "asset.print_source_missing",
      state: "missing",
      detail: "No active final print source asset is configured.",
    });
  }

  const policySnapshot =
    taxTreatmentVersion &&
    refundHandlingVersion &&
    supportProcedureVersion &&
    verificationEvidenceVersion &&
    approvalEnvironment === environment
      ? buildApprovedBookPurchasePolicySnapshot({
          capturedAt: evaluatedAt,
          taxTreatmentVersion,
          refundHandlingVersion,
          supportProcedureVersion,
          verificationEvidenceVersion,
          approvalEnvironment,
        })
      : null;
  if (!policySnapshot) {
    digital.push({
      code: "policy.purchase_snapshot_unavailable",
      state: "unapproved",
      detail: "An approved immutable purchase-policy snapshot cannot be built.",
    });
  }

  const digitalReady = digital.length === 0 && policySnapshot !== null;
  const completeBlockers = [...digital, ...completeOnly];
  const completeReady =
    digitalReady && completeOnly.length === 0 && policySnapshot !== null;

  return {
    evaluatedAt: evaluatedAt.toISOString(),
    environment,
    policySnapshotSchemaVersion: BOOK_PURCHASE_POLICY_SNAPSHOT_SCHEMA_VERSION,
    policies: Object.values(BOOK_FUNNEL_POLICY_MANIFEST).map((policy) => ({
      key: policy.key,
      version: policy.version,
      approvalStatus: policy.approvalStatus,
      ownerApproved: policy.ownerApproved,
      counselApproved: policy.counselApproved,
      published: policy.published,
      canonicalPath: policy.canonicalPath,
    })),
    fulfillmentBoundary: BOOK_PHYSICAL_FULFILLMENT_BOUNDARY,
    packages: {
      digital: {
        purchasable: digitalReady,
        blockers: digital,
        policySnapshot: digitalReady ? policySnapshot : null,
      },
      complete: {
        purchasable: completeReady,
        blockers: completeBlockers,
        policySnapshot: completeReady ? policySnapshot : null,
      },
    },
  };
}

export function launchGateContextFromReport(
  report: BookLaunchReadinessReport,
): PackageLaunchGateContext {
  return {
    digitalReady: report.packages.digital.purchasable,
    completeReady: report.packages.complete.purchasable,
  };
}

export async function requireBookPackageLaunchReady(
  packageCode: BookCommercePackageCode,
  report?: BookLaunchReadinessReport,
): Promise<BookPackageLaunchReadiness> {
  const resolved = report ?? (await getBookLaunchReadinessReport());
  const state = resolved.packages[packageCode];
  if (!state.purchasable || !state.policySnapshot) {
    throw new PackageNotSelectableError(
      packageCode,
      state.blockers.map((blocker) => blocker.code).join(", ") ||
        "launch readiness is closed",
    );
  }
  return state;
}
