/**
 * Task #5105 — GHL outbound buyer lifecycle automation.
 *
 * Architecture constraints enforced here (see GHL.md):
 *
 *   - GHL is an operational MIRROR only. NoBull OS is the sole authority for
 *     checkout, Stripe payment facts, orders, refunds, entitlements/access, and
 *     SMS consent. This module NEVER mutates NoBull state, never grants/revokes
 *     access, never confirms receipts. Applying `book_buyer` triggers GHL
 *     onboarding + buyer-to-booking workflows ONLY; the canonical NoBull receipt
 *     and book access are produced independently by the order/entitlement path.
 *   - All GHL mutations are idempotent tag / custom-field / opportunity updates
 *     that trigger GHL-side configured workflows — we never send messages.
 *   - Marketing SMS gating: the canonical SMS consent state comes from
 *     `sms_consent_ledger` (via getConsentStatusForPhone), keyed by the buyer's
 *     normalized phone — NOT from the bookContacts snapshot. Marketing workflow
 *     tags are applied only when the ledger state is EXACTLY `opted_in`; consent
 *     evidence/copy/source/confirmedAt are mirrored to the approved custom
 *     fields. `unknown`/`opted_out`/absent never enables marketing SMS.
 *   - Tag/field/stage names are the EXACT approved constants from GHL.md §7–§9;
 *     the config carries only environment-specific GHL internal IDs.
 *   - Handlers are self-sufficient: outbox payloads carry only source IDs
 *     (orderId / appointmentId / applicationId / checkoutSessionId), so every
 *     handler re-loads the contact, order, package, amount, and consent from the
 *     DB. A missing contact/correlation for an event that SHOULD have one raises
 *     a RETRYABLE reconciliation error (ordering race) — it is NOT success.
 *   - Opportunity creation is idempotent across POST timeouts: we search GHL by
 *     the durable `order_id` custom field before creating, then persist the
 *     correlation, so a timed-out create does not duplicate.
 *   - Physical fulfillment messaging remains disabled (config literal false).
 *
 * Config contract (GHL.md lockstep):
 *   - Versioned, strict, disabled by default, fail-closed.
 *   - Backed by the `ghl_buyer_sync_config_v1` system_setting key.
 *   - `enabled: true` additionally requires `approved: true`, a matching
 *     connected `locationId`, and environment-appropriate activation
 *     safeguards (production requires `productionActivationConfirmed: true`).
 */
// @db-pool-intent: ambient

import { z } from "zod";
import { ghlApiRequest as realGhlApiRequest, GhlApiError } from "./ghlIntegration";
import { storage } from "../storage";
import { insertBookProviderCorrelation } from "../storage/bookCommerceEngagementStorage";
import { CorrelationConflictError } from "../storage/bookCommerceStorage";
import { getConsentStatusForPhone } from "./smsConsent";
import type { BookOutboxEventType } from "@shared/schema";
import { isKillSwitchEnabled } from "./killSwitches";
import { isRunningInDeployment } from "../lib/deploymentEnv";

// ─── Approved GHL vocabulary (GHL.md §7 fields, §8 tags, §9 stages) ───────────
//
// These names are contract constants, NOT config. The config supplies only the
// environment-specific GHL internal IDs that map to these names. Changing any
// literal here is a spec change requiring an owner-approved GHL.md update.

/** Approved contact tag names (GHL.md §8). */
export const GHL_TAGS = {
  checkoutStarted: "book_checkout_started",
  buyer: "book_buyer",
  lfreDigital: "lfre_digital",
  lfreAudio: "lfre_audio",
  lfrePrint: "lfre_print",
  lfreComplete: "lfre_complete",
  bonusViewed: "book_bonus_viewed",
  auditApplied: "audit_applied",
  auditQualified: "audit_qualified",
  auditUnqualified: "audit_unqualified",
  auditManualReview: "audit_manual_review",
  hirsBooked: "HIRS_booked",
  hirsAttended: "HIRS_attended",
  hirsNoShow: "HIRS_no_show",
  hirsCancelled: "HIRS_cancelled",
  workflowAActive: "workflow_a_active",
  workflowCActive: "workflow_c_active",
  workflowDActive: "workflow_d_active",
  workflowEActive: "workflow_e_active",
  workflowFActive: "workflow_f_active",
  closedClient: "closed_client",
  longTermNurture: "long_term_nurture",
} as const;

/** Approved pipeline stage names (GHL.md §9). Config maps names → env stage IDs. */
export const GHL_STAGE_NAMES = [
  "Checkout Started",
  "Book Purchased",
  "Applied",
  "Qualified",
  "Unqualified / Manual Review",
  "Meeting Booked",
  "Meeting Attended",
  "No-Show",
  "Proposal / Active Sales",
  "Closed Client",
  "Lost / Unqualified",
] as const;
export type GhlStageName = (typeof GHL_STAGE_NAMES)[number];

/**
 * Approved CUSTOM field names (GHL.md §7). Config maps names → env field IDs.
 *
 * `email` / `first_name` / `phone` from §7 are STANDARD GHL contact fields (not
 * custom fields) and are therefore intentionally NOT in this map — they carry
 * no environment-specific custom-field ID. Every remaining §7 field (all
 * `Source of truth = NoBull OS` / GHL-mirrored custom fields) is required in
 * lockstep with the doc.
 */
export const GHL_FIELD_NAMES = [
  "sms_marketing_status",
  "sms_consent_timestamp",
  "sms_consent_copy_version",
  "sms_consent_source_url",
  "email_marketing_status",
  "order_id",
  "stripe_payment_intent_id",
  "selected_package",
  // Attribution custom fields (§7).
  "first_touch_utm_source",
  "first_touch_utm_medium",
  "first_touch_utm_campaign",
  "first_touch_utm_content",
  "first_touch_utm_term",
  "last_touch_utm_source",
  "last_touch_utm_medium",
  "last_touch_utm_campaign",
  "gclid",
  "fbclid",
  // Application / qualification custom fields (§7).
  "qualification_status",
  "qualification_reason",
  "audit_role",
  "audit_monthly_inquiry_range",
  "audit_revenue_or_proxy_range",
  "audit_improvement_timeline",
  // Appointment + opportunity custom fields (§7).
  "appointment_id",
  "appointment_status",
  "appointment_attended_at",
  "opportunity_stage",
  "attributed_revenue",
] as const;
export type GhlFieldName = (typeof GHL_FIELD_NAMES)[number];

// ─── Config contract ─────────────────────────────────────────────────────────

export const GHL_BUYER_SYNC_CONFIG_SETTING = "ghl_buyer_sync_config_v1";

const envSchema = z.enum(["development", "staging", "production"]);

const stageIdMap = z.object(
  Object.fromEntries(GHL_STAGE_NAMES.map((n) => [n, z.string().min(1).max(128)])) as Record<
    GhlStageName,
    z.ZodString
  >,
);

const fieldIdMap = z.object(
  Object.fromEntries(GHL_FIELD_NAMES.map((n) => [n, z.string().min(1).max(128)])) as Record<
    GhlFieldName,
    z.ZodString
  >,
);

/**
 * Strict, versioned config. All environment-specific IDs are required before the
 * feature may be enabled. `enabled: true` is additionally cross-validated in
 * loadGhlBuyerSyncConfig against approval + safeguard fields.
 */
export const ghlBuyerSyncConfigSchema = z
  .object({
    version: z.literal(1),
    /** Master feature gate. Default false. Requires approved:true to take effect. */
    enabled: z.boolean(),
    /**
     * Explicit owner approval that this config's IDs were provisioned against
     * the approved GHL sub-account. `enabled` has no effect unless approved.
     */
    approved: z.boolean(),
    /** Free-text approval evidence (owner name + date + reference). Required. */
    approvalEvidence: z.string().min(3).max(2000),
    /** Deployment environment this config targets. Must match the runtime env. */
    environment: envSchema,
    /**
     * Extra confirmation required to activate in production, so a staging config
     * copy-pasted into prod cannot silently go live.
     */
    productionActivationConfirmed: z.boolean(),
    /** Connected GHL Location ID (must match the runtime-connected location). */
    locationId: z.string().min(1).max(128),
    /** GHL Pipeline ID (`Book Buyer Pipeline`). */
    pipelineId: z.string().min(1).max(128),
    /** Stage IDs keyed by the exact approved stage name (all required). */
    stages: stageIdMap,
    /** Custom field IDs keyed by the exact approved field name (all required). */
    customFields: fieldIdMap,
    /**
     * Owner map: workflow/task ownership placeholders (email or GHL user IDs)
     * so automation and manual-review routing target real owners.
     */
    ownerMap: z.object({
      salesTaskOwner: z.string().min(1).max(256),
      manualReviewOwner: z.string().min(1).max(256),
    }),
    /**
     * GHL calendar ID used for the qualified buyer-to-booking flow (mirrors
     * book_buyer_ghl_calendar_v1). Present for reconciliation / auditing.
     */
    calendarId: z.string().min(1).max(128),
    /**
     * Approved workflow IDs — the FULL A–F + post-attended set from GHL.md §11.
     * GHL workflows fire on tags; these IDs let us reconcile/stop workflows and
     * are audited here. Every workflow named in §11 is required in lockstep so
     * a partially-provisioned sub-account cannot be enabled.
     */
    workflowIds: z.object({
      workflowA: z.string().min(1).max(128),
      workflowB: z.string().min(1).max(128),
      workflowC: z.string().min(1).max(128),
      workflowD: z.string().min(1).max(128),
      workflowE: z.string().min(1).max(128),
      workflowF: z.string().min(1).max(128),
      postAttended: z.string().min(1).max(128),
    }),
    /**
     * Approved workflow VERSION IDs (GHL.md §5/§20 require versioned workflow
     * definitions). Recorded per workflow so reconciliation/audit can prove the
     * exact deployed workflow revision matches the approved blueprint.
     */
    workflowVersionIds: z.object({
      workflowA: z.string().min(1).max(128),
      workflowB: z.string().min(1).max(128),
      workflowC: z.string().min(1).max(128),
      workflowD: z.string().min(1).max(128),
      workflowE: z.string().min(1).max(128),
      workflowF: z.string().min(1).max(128),
      postAttended: z.string().min(1).max(128),
    }),
    /**
     * Expected STOP-CONDITION evidence per workflow (GHL.md §11 + §19 checklist).
     * Free-text approval evidence that each workflow's exit/stop condition was
     * verified in the non-production lane (e.g. "Workflow A exits on purchase —
     * §19 row 11 passed 2026-01-15"). Required so activation cannot proceed
     * without the stop-condition evidence the task mandates.
     */
    workflowStopConditions: z.object({
      workflowA: z.string().min(3).max(1000),
      workflowB: z.string().min(3).max(1000),
      workflowC: z.string().min(3).max(1000),
      workflowD: z.string().min(3).max(1000),
      workflowE: z.string().min(3).max(1000),
      workflowF: z.string().min(3).max(1000),
      postAttended: z.string().min(3).max(1000),
    }),
    /**
     * Sender identity + ownership approval references (GHL.md §12, §13, §20 G-4/
     * G-5). These are approval REFERENCES (not the sender addresses/numbers
     * themselves, which live in secrets), so activation records that the
     * owner-approved employee registry and sender identities were resolved.
     */
    senderApprovals: z.object({
      /** Approved marketing email sender identity reference (§13, G-5). */
      marketingEmailSenderRef: z.string().min(1).max(256),
      /** Approved GHL SMS sending number / A2P registration reference (§13, G-5). */
      smsSenderRef: z.string().min(1).max(256),
      /** Owner-approved employee registry reference for §12 placeholders (G-4). */
      ownershipRegistryRef: z.string().min(1).max(256),
    }),
    /** SMS consent disclosure copy version currently mirrored to GHL. */
    smsConsentCopyVersion: z.string().min(1).max(128),
    /** Physical fulfillment messaging MUST remain disabled. */
    physicalFulfillmentMessagingEnabled: z.literal(false),
  })
  .strict();

export type GhlBuyerSyncConfig = z.infer<typeof ghlBuyerSyncConfigSchema>;

export type GhlBuyerSyncConfigResult =
  | { ok: true; config: GhlBuyerSyncConfig }
  | {
      ok: false;
      reason:
        | "disabled"
        | "not_approved"
        | "not_configured"
        | "invalid"
        | "parse_error"
        | "env_mismatch"
        | "location_mismatch"
        | "location_unresolved"
        | "prod_activation_unconfirmed";
      detail?: string;
    };

/**
 * Runtime seams injected for testability. Production uses the real DB/GHL/
 * consent/env implementations; tests inject fakes to exercise real ordering,
 * replay, and reconciliation paths without any network or DB.
 */
export interface GhlBuyerSyncDeps {
  ghlApiRequest: (path: string, init?: RequestInit) => Promise<Response>;
  loadConfig: () => Promise<GhlBuyerSyncConfigResult>;
  loadContact: (contactId: string) => Promise<ContactRecord | null>;
  loadOrder: (orderId: string) => Promise<OrderRecord | null>;
  loadOrderByCheckoutSession: (sessionId: string) => Promise<OrderRecord | null>;
  loadAppointment: (appointmentId: string) => Promise<AppointmentRecord | null>;
  loadApplication: (applicationId: string) => Promise<ApplicationRecord | null>;
  loadCheckoutSession: (sessionId: string) => Promise<CheckoutSessionRecord | null>;
  /**
   * Active entitlement codes for an order (authoritative from NoBull). Used by
   * the partial-refund handler to re-derive which SKU tags must remain.
   */
  loadActiveEntitlementCodes: (orderId: string) => Promise<string[]>;
  getConsentForPhone: (phone: string) => Promise<CanonicalConsent>;
  findGhlContactId: (localContactId: string) => Promise<string | null>;
  findGhlOpportunityId: (localOrderId: string) => Promise<string | null>;
  storeContactCorrelation: (ghlContactId: string, localContactId: string) => Promise<void>;
  storeOpportunityCorrelation: (ghlOpportunityId: string, localOrderId: string) => Promise<void>;
  currentEnvironment: () => "development" | "staging" | "production";
}

// ─── Domain record shapes (loaded from NoBull DB) ─────────────────────────────

export interface ContactRecord {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
}
export interface OrderRecord {
  id: string;
  orderNumber: string;
  contactId: string | null;
  packageCode: string;
  totalAmountCents: number;
  currency: string;
  status: string;
}
export interface AppointmentRecord {
  id: string;
  contactId: string | null;
  orderId: string | null;
  /** Durable appointment status (mirrored lifecycle state). */
  status: string | null;
  /** Durable scheduled time (for reconciliation / anchoring). */
  scheduledAt: Date | null;
  /**
   * Durable last-transition timestamp. Used as the authoritative
   * appointment_attended_at on the completed event so a RETRY does not stamp a
   * fresh (wrong) `new Date()`. The transition to `completed` stamped this row's
   * updatedAt when attendance was mirrored, so it is stable across replays.
   */
  updatedAt: Date | null;
}
export interface ApplicationRecord {
  id: string;
  contactId: string;
  orderId: string | null;
  qualificationStatus: string | null;
  decisionReason: string | null;
}
export interface CheckoutSessionRecord {
  id: string;
  contactId: string | null;
  packageCode: string | null;
}
export interface CanonicalConsent {
  state: "unknown" | "opted_in" | "opted_out";
  source: string | null;
  evidence: string | null;
  copyVersion: string | null;
  sourceUrl: string | null;
  confirmedAt: Date | null;
}

// ─── Reconciliation error (retryable "not yet mirrored") ─────────────────────

/**
 * Raised when an event that SHOULD have a mirrored contact / correlation does
 * not yet — an ordering race where the upstream mirror has not caught up. The
 * relay treats this as a retryable failure, NOT a delivered success.
 */
export class GhlReconciliationNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhlReconciliationNeededError";
  }
}

// ─── Config loader (fail-closed) ─────────────────────────────────────────────

export async function loadGhlBuyerSyncConfig(): Promise<GhlBuyerSyncConfigResult> {
  try {
    const setting = await storage.getSystemSetting(GHL_BUYER_SYNC_CONFIG_SETTING);
    if (!setting?.value?.trim()) {
      return { ok: false, reason: "not_configured" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(setting.value);
    } catch {
      return { ok: false, reason: "parse_error", detail: "config is not valid JSON" };
    }
    const parsed = ghlBuyerSyncConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const cfg = parsed.data;

    // Cross-field activation safeguards (all fail-closed).
    if (!cfg.enabled) return { ok: false, reason: "disabled" };
    if (!cfg.approved) return { ok: false, reason: "not_approved" };

    const runtimeEnv = resolveRuntimeEnv();
    if (cfg.environment !== runtimeEnv) {
      return {
        ok: false,
        reason: "env_mismatch",
        detail: `config env ${cfg.environment} != runtime env ${runtimeEnv}`,
      };
    }
    if (cfg.environment === "production" && !cfg.productionActivationConfirmed) {
      return { ok: false, reason: "prod_activation_unconfirmed" };
    }

    // Connected-location match — FAIL CLOSED. We must be able to resolve the
    // runtime-connected GHL location and it MUST equal the config location.
    // A config-only location (no connected location resolvable) is NOT
    // acceptable: an unresolved connected location means we cannot prove the
    // config's IDs belong to the sub-account we are actually connected to, so
    // we refuse to enable rather than mirror against an unverified location.
    const connectedLocation = await resolveConnectedLocationId();
    if (!connectedLocation) {
      return {
        ok: false,
        reason: "location_unresolved",
        detail: "connected GHL location id is not resolvable — refusing to enable (fail-closed)",
      };
    }
    if (connectedLocation !== cfg.locationId) {
      return {
        ok: false,
        reason: "location_mismatch",
        detail: `config location ${cfg.locationId} != connected ${connectedLocation}`,
      };
    }

    return { ok: true, config: cfg };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: "parse_error",
      detail: `settings read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function resolveRuntimeEnv(): "development" | "staging" | "production" {
  const explicit = (process.env.APP_ENV ?? "").toLowerCase();
  if (explicit === "staging") return "staging";
  if (explicit === "production") return "production";
  if (explicit === "development") return "development";
  // Fall back to deployment detection: deployed → production, else development.
  return isRunningInDeployment() ? "production" : "development";
}

async function resolveConnectedLocationId(): Promise<string | null> {
  try {
    const setting = await storage.getSystemSetting("ghl_location_id");
    return setting?.value?.trim() || null;
  } catch {
    return null;
  }
}

// ─── Correlation helpers ─────────────────────────────────────────────────────

const GHL_PROVIDER = "ghl";
const GHL_CONTACT_ENTITY_TYPE = "contact";
const GHL_OPPORTUNITY_ENTITY_TYPE = "opportunity";
const LOCAL_CONTACT_ENTITY_TYPE = "contact";
const LOCAL_ORDER_ENTITY_TYPE = "order";

type GhlBuyerDb = ReturnType<(typeof import("../db"))["getDb"]>;

async function withGhlBuyerDb<T>(
  label: string,
  callback: (db: GhlBuyerDb) => Promise<T>,
): Promise<T> {
  const { getDb, withDbAttribution } = await import("../db");
  return withDbAttribution(`book-commerce:ghl-buyer-${label}`, async () =>
    callback(getDb()),
  );
}

export async function findGhlContactId(localContactId: string): Promise<string | null> {
  const { bookProviderCorrelations } = await import("@shared/schema");
  const { and, eq } = await import("drizzle-orm");
  return withGhlBuyerDb("find-contact-correlation", async (db) => {
    const [row] = await db
      .select({ providerEntityId: bookProviderCorrelations.providerEntityId })
      .from(bookProviderCorrelations)
      .where(
        and(
          eq(bookProviderCorrelations.provider, GHL_PROVIDER),
          eq(bookProviderCorrelations.providerEntityType, GHL_CONTACT_ENTITY_TYPE),
          eq(bookProviderCorrelations.localEntityType, LOCAL_CONTACT_ENTITY_TYPE),
          eq(bookProviderCorrelations.localEntityId, localContactId),
        ),
      )
      .limit(1);
    return row?.providerEntityId ?? null;
  });
}

export async function findGhlOpportunityId(localOrderId: string): Promise<string | null> {
  const { bookProviderCorrelations } = await import("@shared/schema");
  const { and, eq } = await import("drizzle-orm");
  return withGhlBuyerDb("find-opportunity-correlation", async (db) => {
    const [row] = await db
      .select({ providerEntityId: bookProviderCorrelations.providerEntityId })
      .from(bookProviderCorrelations)
      .where(
        and(
          eq(bookProviderCorrelations.provider, GHL_PROVIDER),
          eq(bookProviderCorrelations.providerEntityType, GHL_OPPORTUNITY_ENTITY_TYPE),
          eq(bookProviderCorrelations.localEntityType, LOCAL_ORDER_ENTITY_TYPE),
          eq(bookProviderCorrelations.localEntityId, localOrderId),
        ),
      )
      .limit(1);
    return row?.providerEntityId ?? null;
  });
}

async function storeContactCorrelation(ghlContactId: string, localContactId: string): Promise<void> {
  await insertBookProviderCorrelation({
    provider: GHL_PROVIDER,
    providerEntityType: GHL_CONTACT_ENTITY_TYPE,
    providerEntityId: ghlContactId,
    localEntityType: LOCAL_CONTACT_ENTITY_TYPE,
    localEntityId: localContactId,
  });
}

async function storeOpportunityCorrelation(
  ghlOpportunityId: string,
  localOrderId: string,
): Promise<void> {
  await insertBookProviderCorrelation({
    provider: GHL_PROVIDER,
    providerEntityType: GHL_OPPORTUNITY_ENTITY_TYPE,
    providerEntityId: ghlOpportunityId,
    localEntityType: LOCAL_ORDER_ENTITY_TYPE,
    localEntityId: localOrderId,
  });
}

// ─── Default DB loaders ──────────────────────────────────────────────────────

async function defaultLoadContact(contactId: string): Promise<ContactRecord | null> {
  const { bookContacts } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-contact", async (db) => {
    const [row] = await db
      .select({
        id: bookContacts.id,
        email: bookContacts.email,
        name: bookContacts.name,
        phone: bookContacts.phone,
      })
      .from(bookContacts)
      .where(eq(bookContacts.id, contactId))
      .limit(1);
    return row ?? null;
  });
}

async function defaultLoadOrder(orderId: string): Promise<OrderRecord | null> {
  const { bookOrders } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-order", async (db) => {
    const [row] = await db
      .select({
        id: bookOrders.id,
        orderNumber: bookOrders.orderNumber,
        contactId: bookOrders.contactId,
        packageCode: bookOrders.packageCode,
        totalAmountCents: bookOrders.totalAmountCents,
        currency: bookOrders.currency,
        status: bookOrders.status,
      })
      .from(bookOrders)
      .where(eq(bookOrders.id, orderId))
      .limit(1);
    return row ?? null;
  });
}

async function defaultLoadOrderByCheckoutSession(sessionId: string): Promise<OrderRecord | null> {
  const { bookOrders } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-order-by-checkout", async (db) => {
    const [row] = await db
      .select({
        id: bookOrders.id,
        orderNumber: bookOrders.orderNumber,
        contactId: bookOrders.contactId,
        packageCode: bookOrders.packageCode,
        totalAmountCents: bookOrders.totalAmountCents,
        currency: bookOrders.currency,
        status: bookOrders.status,
      })
      .from(bookOrders)
      .where(eq(bookOrders.checkoutSessionId, sessionId))
      .limit(1);
    return row ?? null;
  });
}

async function defaultLoadAppointment(appointmentId: string): Promise<AppointmentRecord | null> {
  const { bookAppointments } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-appointment", async (db) => {
    const [row] = await db
      .select({
        id: bookAppointments.id,
        contactId: bookAppointments.contactId,
        orderId: bookAppointments.orderId,
        status: bookAppointments.status,
        scheduledAt: bookAppointments.scheduledAt,
        updatedAt: bookAppointments.updatedAt,
      })
      .from(bookAppointments)
      .where(eq(bookAppointments.id, appointmentId))
      .limit(1);
    return row ?? null;
  });
}

async function defaultLoadApplication(applicationId: string): Promise<ApplicationRecord | null> {
  const { bookAuditApplications } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-application", async (db) => {
    const [row] = await db
      .select({
        id: bookAuditApplications.id,
        contactId: bookAuditApplications.contactId,
        orderId: bookAuditApplications.orderId,
        qualificationStatus: bookAuditApplications.status,
        decisionReason: bookAuditApplications.decisionReason,
      })
      .from(bookAuditApplications)
      .where(eq(bookAuditApplications.id, applicationId))
      .limit(1);
    return row ?? null;
  });
}

async function defaultLoadCheckoutSession(sessionId: string): Promise<CheckoutSessionRecord | null> {
  const { bookCheckoutSessions } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-checkout", async (db) => {
    const [row] = await db
      .select({
        id: bookCheckoutSessions.id,
        contactId: bookCheckoutSessions.contactId,
        packageCode: bookCheckoutSessions.packageCode,
      })
      .from(bookCheckoutSessions)
      .where(eq(bookCheckoutSessions.id, sessionId))
      .limit(1);
    return row ?? null;
  });
}

async function defaultLoadActiveEntitlementCodes(orderId: string): Promise<string[]> {
  const { bookEntitlements } = await import("@shared/schema");
  const { and, eq } = await import("drizzle-orm");
  return withGhlBuyerDb("load-active-entitlements", async (db) => {
    const rows = await db
      .select({ entitlementCode: bookEntitlements.entitlementCode })
      .from(bookEntitlements)
      .where(
        and(
          eq(bookEntitlements.orderId, orderId),
          eq(bookEntitlements.status, "active"),
        ),
      );
    return rows.map((r) => r.entitlementCode);
  });
}

async function defaultGetConsentForPhone(phone: string): Promise<CanonicalConsent> {
  const status = await getConsentStatusForPhone(phone);
  return {
    state: status.state,
    source: status.source,
    evidence: status.evidence,
    copyVersion: null, // ledger evidence/copy version is carried in evidence text
    sourceUrl: null,
    confirmedAt: status.optedInAt,
  };
}

// ─── Default deps ─────────────────────────────────────────────────────────────

export function makeDefaultDeps(): GhlBuyerSyncDeps {
  return {
    ghlApiRequest: realGhlApiRequest,
    loadConfig: loadGhlBuyerSyncConfig,
    loadContact: defaultLoadContact,
    loadOrder: defaultLoadOrder,
    loadOrderByCheckoutSession: defaultLoadOrderByCheckoutSession,
    loadAppointment: defaultLoadAppointment,
    loadApplication: defaultLoadApplication,
    loadCheckoutSession: defaultLoadCheckoutSession,
    loadActiveEntitlementCodes: defaultLoadActiveEntitlementCodes,
    getConsentForPhone: defaultGetConsentForPhone,
    findGhlContactId,
    findGhlOpportunityId,
    storeContactCorrelation,
    storeOpportunityCorrelation,
    currentEnvironment: resolveRuntimeEnv,
  };
}

// ─── GHL API operations (all via deps.ghlApiRequest) ─────────────────────────

interface GhlContactResponse {
  id: string;
  email?: string;
  tags?: string[];
}

async function lookupGhlContactByEmail(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  email: string,
): Promise<GhlContactResponse | null> {
  try {
    const resp = await deps.ghlApiRequest(
      `/contacts/search/duplicate?locationId=${encodeURIComponent(config.locationId)}&email=${encodeURIComponent(email)}`,
    );
    const data = (await resp.json()) as { contact?: GhlContactResponse };
    return data.contact ?? null;
  } catch (err) {
    if (err instanceof GhlApiError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Resolve the GHL contact for a local contact, creating it if absent. The
 * correlation is stored so subsequent events reuse it. Email dedup prevents
 * duplicate contacts on a timed-out create.
 */
async function resolveOrCreateGhlContact(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  contact: ContactRecord,
): Promise<string> {
  const existingCorrelation = await deps.findGhlContactId(contact.id);
  if (existingCorrelation) return existingCorrelation;

  // No correlation yet — reconcile a possibly-already-created remote contact by
  // email before creating (POST timeout reconciliation).
  const remote = await lookupGhlContactByEmail(deps, config, contact.email);
  let ghlContactId: string;
  if (remote) {
    ghlContactId = remote.id;
  } else {
    const body: Record<string, unknown> = {
      locationId: config.locationId,
      email: contact.email,
    };
    if (contact.name) body.firstName = contact.name.split(" ")[0];
    if (contact.phone) body.phone = contact.phone;
    const resp = await deps.ghlApiRequest("/contacts/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await resp.json()) as { contact?: GhlContactResponse };
    const id = result.contact?.id;
    if (!id) throw new GhlApiError("GHL contact create response missing id", undefined, false);
    ghlContactId = id;
  }

  try {
    await deps.storeContactCorrelation(ghlContactId, contact.id);
  } catch (err) {
    // A concurrent handler may have won the correlation race; treat a conflict
    // that maps THIS contact to a DIFFERENT ghl id as retryable reconciliation.
    if (err instanceof CorrelationConflictError) {
      const now = await deps.findGhlContactId(contact.id);
      if (now) return now;
      throw new GhlReconciliationNeededError(
        `Correlation conflict for contact ${contact.id}: ${err.message}`,
      );
    }
    throw err;
  }
  return ghlContactId;
}

/**
 * Require an EXISTING GHL contact correlation. Used by events that must not
 * create a contact (appointment/application/bonus events that follow a purchase
 * or apply step). A missing correlation is a retryable ordering race.
 */
async function requireExistingGhlContact(
  deps: GhlBuyerSyncDeps,
  localContactId: string,
  eventLabel: string,
): Promise<string> {
  const id = await deps.findGhlContactId(localContactId);
  if (!id) {
    throw new GhlReconciliationNeededError(
      `No GHL contact correlation for local contact ${localContactId} on ${eventLabel} — mirror not caught up`,
    );
  }
  return id;
}

async function addTags(deps: GhlBuyerSyncDeps, ghlContactId: string, tags: string[]): Promise<void> {
  const clean = tags.filter(Boolean);
  if (!clean.length) return;
  await deps.ghlApiRequest(`/contacts/${encodeURIComponent(ghlContactId)}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: clean }),
  });
}

async function removeTags(deps: GhlBuyerSyncDeps, ghlContactId: string, tags: string[]): Promise<void> {
  const clean = tags.filter(Boolean);
  if (!clean.length) return;
  await deps.ghlApiRequest(`/contacts/${encodeURIComponent(ghlContactId)}/tags`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: clean }),
  });
}

async function setFields(
  deps: GhlBuyerSyncDeps,
  ghlContactId: string,
  fields: Array<{ id: string; value: string }>,
): Promise<void> {
  const clean = fields.filter((f) => f.id);
  if (!clean.length) return;
  await deps.ghlApiRequest(`/contacts/${encodeURIComponent(ghlContactId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customFields: clean }),
  });
}

async function moveOpportunityStage(
  deps: GhlBuyerSyncDeps,
  opportunityId: string,
  stageId: string,
  status?: "open" | "won" | "lost",
): Promise<void> {
  const body: Record<string, unknown> = { stageId };
  if (status) body.status = status;
  await deps.ghlApiRequest(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Idempotently ensure a buyer opportunity exists for an order. Search order,
 * timeout-safe:
 *   1. stored correlation (fast path)
 *   2. GHL search by durable `order_id` custom field (reconciles timed-out POST)
 *   3. create + persist correlation
 */
async function ensureOpportunity(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  opts: {
    ghlContactId: string;
    order: OrderRecord;
    stageId: string;
    name: string;
  },
): Promise<string> {
  const correlated = await deps.findGhlOpportunityId(opts.order.id);
  if (correlated) return correlated;

  // Search GHL by the durable order_id custom field before creating.
  const found = await searchOpportunityByOrderId(deps, config, opts.order.orderNumber);
  if (found) {
    try {
      await deps.storeOpportunityCorrelation(found, opts.order.id);
    } catch (err) {
      if (!(err instanceof CorrelationConflictError)) throw err;
    }
    return found;
  }

  const body: Record<string, unknown> = {
    pipelineId: config.pipelineId,
    locationId: config.locationId,
    name: opts.name,
    pipelineStageId: opts.stageId,
    contactId: opts.ghlContactId,
    status: "open",
    monetaryValue: Math.round(opts.order.totalAmountCents / 100),
    customFields: [{ id: config.customFields.order_id, value: opts.order.orderNumber }],
  };
  const resp = await deps.ghlApiRequest("/opportunities/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await resp.json()) as { opportunity?: { id: string } };
  const id = result.opportunity?.id;
  if (!id) throw new GhlApiError("GHL opportunity create response missing id", undefined, false);
  try {
    await deps.storeOpportunityCorrelation(id, opts.order.id);
  } catch (err) {
    if (!(err instanceof CorrelationConflictError)) throw err;
  }
  return id;
}

async function searchOpportunityByOrderId(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  orderNumber: string,
): Promise<string | null> {
  try {
    const resp = await deps.ghlApiRequest(
      `/opportunities/search?location_id=${encodeURIComponent(config.locationId)}&pipeline_id=${encodeURIComponent(config.pipelineId)}&query=${encodeURIComponent(orderNumber)}`,
    );
    const data = (await resp.json()) as {
      opportunities?: Array<{ id: string; customFields?: Array<{ id: string; fieldValue?: string; value?: string }> }>;
    };
    for (const opp of data.opportunities ?? []) {
      const match = (opp.customFields ?? []).some(
        (f) => f.id === config.customFields.order_id && (f.fieldValue === orderNumber || f.value === orderNumber),
      );
      if (match) return opp.id;
    }
    return null;
  } catch (err) {
    if (err instanceof GhlApiError && err.statusCode === 404) return null;
    throw err;
  }
}

// ─── SKU tag mapping (GHL.md §8) ─────────────────────────────────────────────

function skuTagsForPackage(packageCode: string): string[] {
  // NoBull package codes → GHL SKU tags. `complete` bundles digital + audio +
  // print; `digital` is digital only.
  switch (packageCode) {
    case "complete":
      return [GHL_TAGS.lfreComplete, GHL_TAGS.lfreDigital, GHL_TAGS.lfreAudio, GHL_TAGS.lfrePrint];
    case "digital":
      return [GHL_TAGS.lfreDigital];
    default:
      return [];
  }
}

// ─── Consent → marketing gating + field mirror ───────────────────────────────

/**
 * Build the SMS consent custom-field mirror from the CANONICAL ledger state.
 * Marketing SMS is enabled ONLY when state === "opted_in". `unknown`/`opted_out`
 * mirror the restrictive status and never enable marketing.
 */
function consentFields(
  config: GhlBuyerSyncConfig,
  consent: CanonicalConsent,
): Array<{ id: string; value: string }> {
  const fields: Array<{ id: string; value: string }> = [
    { id: config.customFields.sms_marketing_status, value: consent.state },
  ];
  if (consent.confirmedAt) {
    fields.push({
      id: config.customFields.sms_consent_timestamp,
      value: consent.confirmedAt.toISOString(),
    });
  }
  // Copy version: prefer explicit ledger copyVersion, else config's current.
  fields.push({
    id: config.customFields.sms_consent_copy_version,
    value: consent.copyVersion ?? config.smsConsentCopyVersion,
  });
  if (consent.sourceUrl) {
    fields.push({ id: config.customFields.sms_consent_source_url, value: consent.sourceUrl });
  }
  return fields;
}

/** Whether marketing SMS workflow tags may be applied for this consent. */
function marketingSmsAllowed(consent: CanonicalConsent): boolean {
  return consent.state === "opted_in";
}

async function loadConsentForContact(
  deps: GhlBuyerSyncDeps,
  contact: ContactRecord,
): Promise<CanonicalConsent> {
  if (!contact.phone) {
    return { state: "unknown", source: null, evidence: null, copyVersion: null, sourceUrl: null, confirmedAt: null };
  }
  return deps.getConsentForPhone(contact.phone);
}

// ─── Per-event handlers (self-sufficient; load from DB) ──────────────────────

async function handleCheckoutStarted(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const sessionId = String(payload.checkoutSessionId ?? payload.sessionId ?? "");
  if (!sessionId) throw new Error("checkout event missing checkoutSessionId");
  const session = await deps.loadCheckoutSession(sessionId);
  if (!session) {
    throw new GhlReconciliationNeededError(`Checkout session ${sessionId} not found`);
  }
  if (!session.contactId) return; // no contact captured yet — nothing to mirror
  const contact = await deps.loadContact(session.contactId);
  if (!contact) throw new GhlReconciliationNeededError(`Contact ${session.contactId} not found`);

  const ghlContactId = await resolveOrCreateGhlContact(deps, config, contact);

  // Marketing (Workflow A) SMS is gated on canonical consent; the abandonment
  // workflow tag is applied regardless (email path), but workflow_a_active only
  // starts the eligibility window — GHL gates the SMS step on sms_marketing_status.
  const consent = await loadConsentForContact(deps, contact);
  await setFields(deps, ghlContactId, consentFields(config, consent));

  await addTags(deps, ghlContactId, [GHL_TAGS.checkoutStarted, GHL_TAGS.workflowAActive]);
  if (session.packageCode) {
    await setFields(deps, ghlContactId, [
      { id: config.customFields.selected_package, value: session.packageCode },
    ]);
  }
}

async function handleOrderPaymentCaptured(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const orderId = String(payload.orderId ?? payload.sourceId ?? "");
  if (!orderId) throw new Error("order.payment_captured missing orderId");
  const order = await deps.loadOrder(orderId);
  if (!order) throw new GhlReconciliationNeededError(`Order ${orderId} not found`);
  if (!order.contactId) {
    throw new GhlReconciliationNeededError(`Order ${orderId} has no contactId yet`);
  }
  const contact = await deps.loadContact(order.contactId);
  if (!contact) throw new GhlReconciliationNeededError(`Contact ${order.contactId} not found`);

  const ghlContactId = await resolveOrCreateGhlContact(deps, config, contact);

  // NoBull owns receipt + access; applying book_buyer only triggers GHL
  // onboarding + buyer-to-booking (Workflow C). Never confirm receipt here.

  // 1) Remove abandonment BEFORE adding buyer (purchase supersedes abandonment).
  await removeTags(deps, ghlContactId, [GHL_TAGS.checkoutStarted, GHL_TAGS.workflowAActive]);

  // 2) Mirror consent fields from the canonical ledger.
  const consent = await loadConsentForContact(deps, contact);
  await setFields(deps, ghlContactId, consentFields(config, consent));

  // 3) Add buyer + SKU tags + start buyer-to-booking. workflow_c_active is only
  //    an eligibility marker; its SMS steps are gated by GHL on opted_in. We
  //    still mirror the accurate marketing status above so GHL can gate.
  const tags = [GHL_TAGS.buyer, GHL_TAGS.workflowCActive, ...skuTagsForPackage(order.packageCode)];
  await addTags(deps, ghlContactId, tags);

  // 4) Order/package fields.
  await setFields(deps, ghlContactId, [
    { id: config.customFields.order_id, value: order.orderNumber },
    { id: config.customFields.selected_package, value: order.packageCode },
  ]);

  // 5) Opportunity → Book Purchased (idempotent, timeout-safe).
  await ensureOpportunity(deps, config, {
    ghlContactId,
    order,
    stageId: config.stages["Book Purchased"],
    name: `${contact.name ?? contact.email} — ${order.orderNumber}`,
  });
  void marketingSmsAllowed; // gating happens GHL-side via mirrored status
}

async function handleBonusViewed(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const contactId = String(payload.contactId ?? "");
  if (!contactId) throw new Error("bonus.viewed missing contactId");
  const ghlContactId = await requireExistingGhlContact(deps, contactId, "bonus.viewed");
  await addTags(deps, ghlContactId, [GHL_TAGS.bonusViewed]);
}

async function handleApplicationSubmitted(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const app = await loadAppFromPayload(deps, payload, "application.submitted");
  const ghlContactId = await requireExistingGhlContact(deps, app.contactId, "application.submitted");
  await addTags(deps, ghlContactId, [GHL_TAGS.auditApplied]);
  await setFields(deps, ghlContactId, [
    { id: config.customFields.qualification_status, value: "pending" },
  ]);
  await moveOpportunityIfPresent(deps, config, app.orderId, config.stages["Applied"]);
}

async function handleApplicationQualified(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const app = await loadAppFromPayload(deps, payload, "application.qualified");
  const ghlContactId = await requireExistingGhlContact(deps, app.contactId, "application.qualified");
  await addTags(deps, ghlContactId, [GHL_TAGS.auditQualified]);
  await setFields(deps, ghlContactId, [
    { id: config.customFields.qualification_status, value: "qualified" },
    { id: config.customFields.qualification_reason, value: app.decisionReason ?? "" },
  ]);
  await moveOpportunityIfPresent(deps, config, app.orderId, config.stages["Qualified"]);
}

/**
 * Routing marker prefix emitted by encodeRoutingDecision in
 * server/routes/bookBuyerJourney.ts: `book-buyer-routing:v1:<outcome>:<reason>`.
 * The application `decisionReason` on a not_qualified/submitted row is this
 * EXACT encoded marker — NOT free text. We parse the structured `outcome` from
 * it (never fuzzy substrings) to decide manual-review vs unqualified.
 */
const ROUTING_MARKER_PREFIX = "book-buyer-routing:v1:";

/** Returns the decoded routing outcome, or null if the marker is absent/invalid. */
function decodeRoutingOutcome(
  value: string | null,
): "qualified" | "alternate_next_step" | "manual_review" | null {
  if (!value || !value.startsWith(ROUTING_MARKER_PREFIX)) return null;
  const [outcome, reason, extra] = value.slice(ROUTING_MARKER_PREFIX.length).split(":");
  if (
    extra !== undefined ||
    !["qualified", "alternate_next_step", "manual_review"].includes(outcome) ||
    ![
      "policy_missing_or_invalid",
      "policy_disabled",
      "role_not_eligible",
      "timeline_not_eligible",
      "answer_band_ambiguous",
      "approved_policy_match",
      "approved_policy_no_match",
    ].includes(reason)
  ) {
    return null;
  }
  return outcome as "qualified" | "alternate_next_step" | "manual_review";
}

async function handleApplicationNotQualified(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const app = await loadAppFromPayload(deps, payload, "application.not_qualified");
  const ghlContactId = await requireExistingGhlContact(deps, app.contactId, "application.not_qualified");
  // Distinguish manual-review from unqualified by parsing the STRUCTURED routing
  // marker (encodeRoutingDecision), never fuzzy substrings. Only outcome
  // === "manual_review" routes to audit_manual_review; a decodable
  // "alternate_next_step" is a genuine unqualified. An UNDECODABLE reason is
  // treated conservatively as manual review (it must not be silently dropped
  // into unqualified marketing exit).
  const outcome = decodeRoutingOutcome(app.decisionReason);
  const isManualReview = outcome === "manual_review" || outcome === null;
  if (isManualReview) {
    await addTags(deps, ghlContactId, [GHL_TAGS.auditManualReview]);
    await setFields(deps, ghlContactId, [
      { id: config.customFields.qualification_status, value: "manual_review" },
      { id: config.customFields.qualification_reason, value: app.decisionReason ?? "" },
    ]);
  } else {
    await addTags(deps, ghlContactId, [GHL_TAGS.auditUnqualified]);
    await setFields(deps, ghlContactId, [
      { id: config.customFields.qualification_status, value: "unqualified" },
      { id: config.customFields.qualification_reason, value: app.decisionReason ?? "" },
    ]);
  }
  await moveOpportunityIfPresent(deps, config, app.orderId, config.stages["Unqualified / Manual Review"]);
}

async function handleAppointmentScheduled(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const appt = await loadApptFromPayload(deps, payload, "appointment.scheduled");
  if (!appt.contactId) return;
  const ghlContactId = await requireExistingGhlContact(deps, appt.contactId, "appointment.scheduled");
  // Exit Workflow C, start Workflow D.
  await removeTags(deps, ghlContactId, [GHL_TAGS.workflowCActive]);
  await addTags(deps, ghlContactId, [GHL_TAGS.hirsBooked, GHL_TAGS.workflowDActive]);
  await setFields(deps, ghlContactId, [
    { id: config.customFields.appointment_id, value: appt.id },
    { id: config.customFields.appointment_status, value: "booked" },
  ]);
  await moveOpportunityIfPresent(deps, config, appt.orderId, config.stages["Meeting Booked"]);
}

async function handleAppointmentCompleted(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const appt = await loadApptFromPayload(deps, payload, "appointment.completed");
  if (!appt.contactId) return;
  const ghlContactId = await requireExistingGhlContact(deps, appt.contactId, "appointment.completed");
  // Exit Workflow D; trigger post-attended follow-up (GHL fires on HIRS_attended).
  await removeTags(deps, ghlContactId, [GHL_TAGS.workflowDActive]);
  await addTags(deps, ghlContactId, [GHL_TAGS.hirsAttended]);
  // appointment_attended_at MUST come from the durable row's transition
  // timestamp (updatedAt), NOT a fresh new Date(): a relay RETRY would
  // otherwise stamp a wrong, later time. Fall back to scheduledAt if updatedAt
  // is somehow absent; only as a last resort use now.
  const attendedAt = appt.updatedAt ?? appt.scheduledAt ?? new Date();
  await setFields(deps, ghlContactId, [
    { id: config.customFields.appointment_status, value: "attended" },
    { id: config.customFields.appointment_attended_at, value: attendedAt.toISOString() },
  ]);
  await moveOpportunityIfPresent(deps, config, appt.orderId, config.stages["Meeting Attended"]);
}

async function handleAppointmentNoShow(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const appt = await loadApptFromPayload(deps, payload, "appointment.no_show");
  if (!appt.contactId) return;
  const ghlContactId = await requireExistingGhlContact(deps, appt.contactId, "appointment.no_show");
  // Exit Workflow D; start Workflow E.
  await removeTags(deps, ghlContactId, [GHL_TAGS.workflowDActive]);
  await addTags(deps, ghlContactId, [GHL_TAGS.hirsNoShow, GHL_TAGS.workflowEActive]);
  await setFields(deps, ghlContactId, [
    { id: config.customFields.appointment_status, value: "no_show" },
  ]);
  await moveOpportunityIfPresent(deps, config, appt.orderId, config.stages["No-Show"]);
}

async function handleAppointmentCancelled(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const appt = await loadApptFromPayload(deps, payload, "appointment.cancelled");
  if (!appt.contactId) return;
  const ghlContactId = await requireExistingGhlContact(deps, appt.contactId, "appointment.cancelled");
  // Exit Workflow D; the buyer may re-book (Workflow C eligibility restored).
  await removeTags(deps, ghlContactId, [GHL_TAGS.hirsBooked, GHL_TAGS.workflowDActive, GHL_TAGS.hirsNoShow]);
  await addTags(deps, ghlContactId, [GHL_TAGS.hirsCancelled]);
  await setFields(deps, ghlContactId, [
    { id: config.customFields.appointment_status, value: "cancelled" },
  ]);
  await moveOpportunityIfPresent(deps, config, appt.orderId, config.stages["Book Purchased"]);
}

async function handleOrderRefunded(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const orderId = String(payload.orderId ?? payload.sourceId ?? "");
  if (!orderId) throw new Error("refund event missing orderId");
  const order = await deps.loadOrder(orderId);
  if (!order) throw new GhlReconciliationNeededError(`Order ${orderId} not found for refund`);
  if (!order.contactId) return;
  const ghlContactId = await requireExistingGhlContact(deps, order.contactId, "order.refunded");

  // GHL.md §18: remove book_buyer + SKU tags, set qualification_status refunded,
  // exit ALL active workflows A–F + post-attended (never send further
  // marketing), move to Lost.
  //
  // IMPORTANT (Task #5105 issue 5): a refund is NOT a withdrawal of SMS consent.
  // We do NOT force sms_marketing_status to opted_out here — consent state is
  // owned solely by the canonical ledger. We STOP the marketing workflow active
  // tags (which is what actually halts marketing sends) but leave the mirrored
  // consent state untouched.
  await removeTags(deps, ghlContactId, [
    GHL_TAGS.buyer,
    ...skuTagsForPackage(order.packageCode),
    GHL_TAGS.workflowAActive,
    GHL_TAGS.workflowCActive,
    GHL_TAGS.workflowDActive,
    GHL_TAGS.workflowEActive,
    GHL_TAGS.workflowFActive,
  ]);
  await setFields(deps, ghlContactId, [
    { id: config.customFields.qualification_status, value: "refunded" },
  ]);
  await moveOpportunityIfPresent(deps, config, order.id, config.stages["Lost / Unqualified"], "lost");
}

/**
 * NoBull entitlement code → GHL SKU tag. Authoritative entitlements decide which
 * SKU tags a contact keeps after a partial refund. `print_fulfillment` is a
 * physical entitlement and carries NO marketing SKU tag (physical fulfillment
 * messaging stays disabled — GHL.md §16), so it maps to no tag.
 */
const ENTITLEMENT_CODE_TO_SKU_TAG: Record<string, string | null> = {
  digital_book: GHL_TAGS.lfreDigital,
  audiobook: GHL_TAGS.lfreAudio,
  print_fulfillment: GHL_TAGS.lfrePrint,
};

/**
 * order.partially_refunded (GHL.md §18 partial-refund rule): a partial refund
 * removes ONLY the refunded SKU's tag while retaining book_buyer + any SKU tags
 * still backed by an ACTIVE entitlement, and does NOT exit workflows or move the
 * opportunity to Lost (the order is not terminal). We re-derive the surviving
 * SKU tag set from the AUTHORITATIVE active entitlements (NoBull), then remove
 * exactly the SKU tags no longer backed by an active entitlement. If the order
 * is not found we ask for reconciliation; if there is no contact we no-op.
 */
async function handleOrderPartiallyRefunded(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const orderId = String(payload.orderId ?? payload.sourceId ?? "");
  if (!orderId) throw new Error("partial refund event missing orderId");
  const order = await deps.loadOrder(orderId);
  if (!order) throw new GhlReconciliationNeededError(`Order ${orderId} not found for partial refund`);
  if (!order.contactId) return;
  const ghlContactId = await requireExistingGhlContact(deps, order.contactId, "order.partially_refunded");

  // Surviving SKU tags = tags backed by a still-active entitlement.
  const activeCodes = new Set(await deps.loadActiveEntitlementCodes(order.id));
  const survivingSkuTags = new Set<string>();
  for (const code of activeCodes) {
    const tag = ENTITLEMENT_CODE_TO_SKU_TAG[code];
    if (tag) survivingSkuTags.add(tag);
  }
  // The `lfre_complete` bundle marker survives only while the WHOLE bundle
  // (digital + audio + print) is still entitled; a partial refund of any
  // component means the contact is no longer a "complete" buyer.
  if (
    activeCodes.has("digital_book") &&
    activeCodes.has("audiobook") &&
    activeCodes.has("print_fulfillment")
  ) {
    survivingSkuTags.add(GHL_TAGS.lfreComplete);
  }

  // Candidate SKU tags for this package that are NO LONGER backed by an active
  // entitlement are removed; everything still entitled is retained. book_buyer
  // and all workflow tags are untouched (order remains non-terminal).
  const packageSkuTags = skuTagsForPackage(order.packageCode);
  const tagsToRemove = packageSkuTags.filter((t) => !survivingSkuTags.has(t));

  if (tagsToRemove.length === 0) {
    // Nothing to retract (e.g. only a physical/print portion refunded, or the
    // refunded SKU carries no marketing tag) — explicit no-op.
    return;
  }
  await removeTags(deps, ghlContactId, tagsToRemove);
}

/**
 * consent.sms_updated — durable, replay-safe SMS-consent → GHL suppression
 * mirror (Task #5105 consent-mirror contract).
 *
 * A canonical consent change (inbound STOP/START keyword, Twilio 21610 block,
 * or manual operator change) must PROMPTLY tighten GHL suppression rather than
 * waiting for the next commerce event to re-read consent. The consent service
 * appends a consent.sms_updated outbox row (keyed by the consent event /
 * message SID) after each canonical state change; this handler:
 *
 *   1. Loads the CANONICAL ledger state for the phone (authoritative — never
 *      trusts a stale state carried in the payload).
 *   2. Mirrors sms_marketing_status + consent evidence fields to GHL.
 *   3. When opted_out, removes ALL marketing workflow active tags (A/C/E/F)
 *      so no further marketing SMS fires, while PRESERVING transactional /
 *      appointment-logistics tags (book_buyer, appointment tags, workflow D
 *      which is post-attended logistics are left untouched).
 *
 * Loop avoidance: when the change originated from a GHL DND webhook
 * (source === "ghl_dnd"), GHL has ALREADY suppressed the contact, so we do NOT
 * write back to GHL (that would ping-pong). NoBull ledger state is still the
 * authority and was already updated by the producer; this handler simply
 * no-ops the outbound leg for that source.
 */
async function handleConsentSmsUpdated(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const source = payload.source == null ? null : String(payload.source);
  // Loop avoidance: a GHL-originated DND suppression is already applied in GHL.
  if (source === "ghl_dnd") return;

  const phone = payload.phone == null ? "" : String(payload.phone);
  const contactId = payload.contactId == null ? "" : String(payload.contactId);
  if (!contactId) throw new Error("consent.sms_updated missing contactId");
  if (!phone) throw new Error("consent.sms_updated missing phone");

  const ghlContactId = await requireExistingGhlContact(deps, contactId, "consent.sms_updated");

  // Authoritative canonical ledger state — NOT the (possibly stale) payload.
  const consent = await deps.getConsentForPhone(phone);

  // Mirror the exact canonical consent state + evidence.
  await setFields(deps, ghlContactId, consentFields(config, consent));

  // Opt-out promptly removes every MARKETING workflow active tag; transactional
  // / appointment-logistics tags are intentionally preserved.
  if (consent.state === "opted_out") {
    await removeTags(deps, ghlContactId, [
      GHL_TAGS.workflowAActive,
      GHL_TAGS.workflowCActive,
      GHL_TAGS.workflowEActive,
      GHL_TAGS.workflowFActive,
    ]);
  }
}

// ─── Payload loaders shared by handlers ──────────────────────────────────────

async function loadAppFromPayload(
  deps: GhlBuyerSyncDeps,
  payload: Record<string, unknown>,
  label: string,
): Promise<ApplicationRecord> {
  const applicationId = String(payload.applicationId ?? payload.sourceId ?? "");
  if (!applicationId) throw new Error(`${label} missing applicationId`);
  const app = await deps.loadApplication(applicationId);
  if (!app) throw new GhlReconciliationNeededError(`Application ${applicationId} not found for ${label}`);
  return app;
}

async function loadApptFromPayload(
  deps: GhlBuyerSyncDeps,
  payload: Record<string, unknown>,
  label: string,
): Promise<AppointmentRecord> {
  const appointmentId = String(payload.appointmentId ?? payload.sourceId ?? "");
  if (!appointmentId) throw new Error(`${label} missing appointmentId`);
  const appt = await deps.loadAppointment(appointmentId);
  if (!appt) throw new GhlReconciliationNeededError(`Appointment ${appointmentId} not found for ${label}`);
  return appt;
}

async function moveOpportunityIfPresent(
  deps: GhlBuyerSyncDeps,
  config: GhlBuyerSyncConfig,
  orderId: string | null,
  stageId: string,
  status?: "open" | "won" | "lost",
): Promise<void> {
  if (!orderId) return;
  const oppId = await deps.findGhlOpportunityId(orderId);
  if (!oppId) return; // no opportunity yet — nothing to move (buyer may be pre-purchase)
  await moveOpportunityStage(deps, oppId, stageId, status);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export interface GhlSyncResult {
  ok: boolean;
  skipped: boolean;
  /**
   * DEFER signal. When true the relay must push next_retry_at forward by a
   * bounded delay WITHOUT incrementing attempt_count and WITHOUT marking the
   * row delivered or dead-letter. Set for config not-ready / disabled /
   * approval-pending / kill switch: the event is neither handled nor failed —
   * it must simply wait for the gate to open (or the switch to lift). A
   * deferred row is NEVER treated as a successful delivery.
   */
  deferred?: boolean;
  skipReason?: string;
  error?: string;
  retryable?: boolean;
}

/**
 * Dispatch a single outbox event to GHL. Called by the relay queue handler.
 *
 * Returns:
 *   - { ok: true } on success
 *   - { ok: false, skipped: true, skipReason } when the event is genuinely
 *     IRRELEVANT to GHL (an unhandled outbox event type). Only these — and
 *     truly successful rows — may be retired by the relay.
 *   - { ok: false, deferred: true, skipReason } when the feature is
 *     disabled/not-configured/not-approved or the kill switch is set. The relay
 *     DEFERS these (bounded delay, no attempt consumed, never delivered).
 *   - { ok: false, retryable: true } on transient failure OR reconciliation
 *     race (relay retries with bounded back-off, then dead-letters)
 */
export async function dispatchGhlBuyerSyncEvent(
  eventType: BookOutboxEventType,
  payload: Record<string, unknown> | null,
  injectedDeps?: GhlBuyerSyncDeps,
): Promise<GhlSyncResult> {
  if (isKillSwitchEnabled("ghl_outbound_sync")) {
    // Kill switch is NOT a delivery: defer so no attempt is consumed and the
    // row is never retired while mirroring is paused.
    return { ok: false, skipped: false, deferred: true, skipReason: "kill_switch_ghl_outbound_sync" };
  }

  const deps = injectedDeps ?? makeDefaultDeps();

  const configResult = await deps.loadConfig();
  if (!configResult.ok) {
    // Config not ready / disabled / not-approved / approval pending: DEFER.
    // The event is neither handled nor failed — it must wait for the gate to
    // open. Never delivered, never dead-lettered, never an attempt consumed.
    return { ok: false, skipped: false, deferred: true, skipReason: `config_not_ready:${configResult.reason}` };
  }
  const config = configResult.config;
  const p = payload ?? {};

  try {
    switch (eventType) {
      case "checkout.recoverable":
      case "checkout.completed":
        await handleCheckoutStarted(deps, config, p);
        break;
      case "order.payment_captured":
        await handleOrderPaymentCaptured(deps, config, p);
        break;
      case "bonus.viewed":
        await handleBonusViewed(deps, config, p);
        break;
      case "application.submitted":
        await handleApplicationSubmitted(deps, config, p);
        break;
      case "application.qualified":
        await handleApplicationQualified(deps, config, p);
        break;
      case "application.not_qualified":
        await handleApplicationNotQualified(deps, config, p);
        break;
      case "appointment.scheduled":
        await handleAppointmentScheduled(deps, config, p);
        break;
      case "appointment.completed":
        await handleAppointmentCompleted(deps, config, p);
        break;
      case "appointment.no_show":
        await handleAppointmentNoShow(deps, config, p);
        break;
      case "appointment.cancelled":
        await handleAppointmentCancelled(deps, config, p);
        break;
      case "order.partially_refunded":
        await handleOrderPartiallyRefunded(deps, config, p);
        break;
      case "order.refunded":
      case "order.cancelled":
        await handleOrderRefunded(deps, config, p);
        break;
      case "consent.sms_updated" as BookOutboxEventType:
        // Durable SMS consent mirror (see handleConsentSmsUpdated). Handler is
        // ready; the outbox event type + producer land in a separate change.
        await handleConsentSmsUpdated(deps, config, p);
        break;
      default:
        // Not a GHL-handled event type — truly irrelevant, skip without error.
        return { ok: false, skipped: true, skipReason: `unhandled_event_type:${eventType}` };
    }
    return { ok: true, skipped: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Reconciliation races and GHL transient errors are retryable; a
    // GhlApiError carries its own retryable flag (401/403/validation = false).
    let retryable = true;
    if (err instanceof GhlApiError) retryable = err.retryable;
    if (err instanceof GhlReconciliationNeededError) retryable = true;
    return { ok: false, skipped: false, error: message, retryable };
  }
}

// ─── Mapping start/stop (idempotent lifecycle) ───────────────────────────────

let _syncActive = false;

export function isGhlBuyerSyncActive(): boolean {
  return _syncActive;
}

/**
 * Start GHL buyer sync. Idempotent. Validates config (fail-closed) before
 * marking active; returns false if config is not ready.
 */
export async function startGhlBuyerSync(): Promise<boolean> {
  if (_syncActive) return true;
  const result = await loadGhlBuyerSyncConfig();
  if (!result.ok) {
    console.log(
      `[GhlBuyerSync] Not starting: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`,
    );
    return false;
  }
  _syncActive = true;
  console.log("[GhlBuyerSync] Buyer sync mapping started.");
  return true;
}

export function stopGhlBuyerSync(): void {
  if (!_syncActive) return;
  _syncActive = false;
  console.log("[GhlBuyerSync] Buyer sync mapping stopped.");
}

/** Reset for tests only. */
export function __resetGhlBuyerSyncStateForTest(): void {
  _syncActive = false;
}
