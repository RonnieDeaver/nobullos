// @db-pool-intent: ambient
//
// Task #5096 — book-commerce persistence, CORE slice (contacts, checkout
// sessions, orders + immutable item snapshot). Every getDb() call lands on the
// ambient API pool (see scripts/lint-db-pool-tenancy.ts + server/db.ts). Also
// owns the cross-slice shared helpers/errors and re-exports the whole storage
// surface as a barrel.
//
// Invariants: contact upsert normalizes email, keeps first-touch immutable, and
// updates only caller-provided latest-touch + consent-evidence fields (ledger
// is the consent authority). Checkout/order creation gate the package via the
// production selectability rule, stamp price/currency/attribution server-side,
// and converge via DB uniqueness (ON CONFLICT), throwing loudly rather than
// returning an unrelated or partial row. No network I/O inside any transaction.

import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookContacts,
  bookCheckoutSessions,
  bookOrders,
  bookOrderItems,
  bookLifecycleEvents,
  bookOutbox,
  bookPackageCodes,
  bookSmsConsentStates,
  bookSmsConsentConfirmationStatuses,
  bookEmailMarketingStatuses,
  smsConsentLedger,
  checkoutSessionStatuses,
  type BookContact,
  type BookCheckoutSession,
  type BookOrder,
  type BookOrderItem,
  type BookLifecycleEvent,
  type BookOutboxEntry,
  type BookLifecycleEventType,
  type BookOutboxEventType,
  type BookPackageCode,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import {
  isPackageSelectable,
  requirePackageByCode,
  PackageNotSelectableError,
  type BookCommercePackageCode,
} from "../services/bookCommerceCatalog";
import {
  getBookLaunchReadinessReport,
  launchGateContextFromReport,
  requireBookPackageLaunchReady,
} from "../services/bookLaunchReadiness";

// ═══════════════════════════════════════════════════════════════════════════
// Shared errors (imported by the event + engagement slices)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thrown BEFORE any DB mutation when a caller requests a state transition that
 * the shared legal-transition map disallows (including same-state moves).
 */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: "order" | "application" | "appointment",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Thrown when a persisted aggregate that must be complete (e.g. an order and
 * its child rows) is found partially materialized on a replay path.
 */
export class IncompleteAggregateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteAggregateError";
  }
}

/**
 * Thrown when the same external provider ID is already correlated to a
 * DIFFERENT local entity than the caller is asserting.
 */
export class CorrelationConflictError extends Error {
  constructor(
    public readonly provider: string,
    public readonly providerEntityType: string,
    public readonly providerEntityId: string,
    public readonly existingLocal: string,
    public readonly incomingLocal: string,
  ) {
    super(
      `Provider correlation conflict for ${provider}/${providerEntityType}/${providerEntityId}: ` +
        `already mapped to ${existingLocal}, refusing to remap to ${incomingLocal}`,
    );
    this.name = "CorrelationConflictError";
  }
}

/**
 * Thrown when an idempotency-keyed replay is asked to converge two logically
 * DIFFERENT operations onto one persisted row (e.g. a checkout idempotency key
 * replayed with a different contact/package, an order-number bound to another
 * checkout, or a payment-provider event replayed with a different payload
 * identity). We never silently return an unrelated row.
 */
export class IdempotencyConflictError extends Error {
  constructor(
    public readonly scope: string,
    public readonly key: string,
    public readonly detail: string,
  ) {
    super(`Idempotency conflict for ${scope} (${key}): ${detail}`);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Thrown when an entitlement grant references an order that is missing or in a
 * status that does not permit fulfilment (must be payment_captured,
 * fulfillment_queued, or fulfilled).
 */
export class OrderNotEligibleForEntitlementError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly detail: string,
  ) {
    super(`Order ${orderId} not eligible for entitlement: ${detail}`);
    this.name = "OrderNotEligibleForEntitlementError";
  }
}

/**
 * Thrown when a contact upsert references SMS-consent evidence that cannot be
 * trusted: the sms_consent_ledger row is missing, carries a state outside the
 * book-commerce consent vocabulary, or contradicts a caller-supplied phone.
 * The ledger is the authority for consent state/evidence — callers may not
 * assert those fields directly.
 */
export class ConsentEvidenceConflictError extends Error {
  constructor(
    public readonly ledgerId: string,
    public readonly detail: string,
  ) {
    super(`SMS consent evidence conflict for ledger ${ledgerId}: ${detail}`);
    this.name = "ConsentEvidenceConflictError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers (imported by the event + engagement slices)
// ═══════════════════════════════════════════════════════════════════════════

/** Attribution namespace prefix for every withDbAttribution label. */
export const BOOK_COMMERCE_ATTRIBUTION_PREFIX = "route:book-commerce";

/** Build a namespaced attribution label: route:book-commerce:<operation>. */
export function bookCommerceLabel(operation: string): string {
  return `${BOOK_COMMERCE_ATTRIBUTION_PREFIX}:${operation}`;
}

/** Normalize an email for the conflict-safe upsert (trim + lowercase). */
export function normalizeBookEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Minimal drizzle transaction handle shape the shared insert helpers need.
 * Using the concrete tx type from db.transaction would couple every caller to
 * an internal generic; this structural type keeps the helpers reusable.
 * Exported for use by the checkout-engine storage slice.
 */
export type TxLike = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Append a lifecycle event inside an open transaction, deduped on the globally
 * unique idempotency key. Returns the inserted row, or the pre-existing row
 * when the key already existed (idempotent replay).
 */
export async function insertLifecycleEventTx(
  tx: TxLike,
  values: {
    contactId?: string | null;
    orderId?: string | null;
    checkoutSessionId?: string | null;
    eventType: BookLifecycleEventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    actorUserId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    idempotencyKey: string;
  },
): Promise<BookLifecycleEvent> {
  const [row] = await tx
    .insert(bookLifecycleEvents)
    .values({
      contactId: values.contactId ?? null,
      orderId: values.orderId ?? null,
      checkoutSessionId: values.checkoutSessionId ?? null,
      eventType: values.eventType,
      fromStatus: values.fromStatus ?? null,
      toStatus: values.toStatus ?? null,
      actorUserId: values.actorUserId ?? null,
      reason: values.reason ?? null,
      metadata: values.metadata ?? null,
      idempotencyKey: values.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;

  const [existing] = await tx
    .select()
    .from(bookLifecycleEvents)
    .where(eq(bookLifecycleEvents.idempotencyKey, values.idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new IncompleteAggregateError(
      `lifecycle event ${values.idempotencyKey} conflicted but no row was found`,
    );
  }
  return existing;
}

/**
 * Append an outbox entry inside an open transaction, deduped on the globally
 * unique idempotency key. Returns the inserted row, or the pre-existing row.
 */
export async function insertOutboxTx(
  tx: TxLike,
  values: {
    eventType: BookOutboxEventType;
    sourceType: string;
    sourceId: string;
    payload?: Record<string, unknown> | null;
    idempotencyKey: string;
  },
): Promise<BookOutboxEntry> {
  const [row] = await tx
    .insert(bookOutbox)
    .values({
      eventType: values.eventType,
      sourceType: values.sourceType,
      sourceId: values.sourceId,
      status: "pending",
      payload: values.payload ?? null,
      maxAttempts: 5,
      idempotencyKey: values.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;

  const [existing] = await tx
    .select()
    .from(bookOutbox)
    .where(eq(bookOutbox.idempotencyKey, values.idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new IncompleteAggregateError(
      `outbox entry ${values.idempotencyKey} conflicted but no row was found`,
    );
  }
  return existing;
}

/**
 * Append an outbox entry outside a transaction (uses getDb() directly).
 * Idempotent: onConflictDoNothing on the idempotencyKey. Returns the inserted
 * or pre-existing row. Used for post-commit or non-transactional outbox writes.
 */
export async function insertOutboxEntry(
  values: {
    eventType: BookOutboxEventType;
    sourceType: string;
    sourceId: string;
    payload?: Record<string, unknown> | null;
    idempotencyKey: string;
  },
): Promise<BookOutboxEntry> {
  return withDbAttribution(bookCommerceLabel("outbox-insert"), async () => {
    const db = getDb();
    const [row] = await db
      .insert(bookOutbox)
      .values({
        eventType: values.eventType,
        sourceType: values.sourceType,
        sourceId: values.sourceId,
        status: "pending",
        payload: values.payload ?? null,
        maxAttempts: 5,
        idempotencyKey: values.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();

    if (row) return row;

    const [existing] = await db
      .select()
      .from(bookOutbox)
      .where(eq(bookOutbox.idempotencyKey, values.idempotencyKey))
      .limit(1);
    if (!existing) {
      throw new IncompleteAggregateError(
        `outbox entry ${values.idempotencyKey} conflicted but no row was found`,
      );
    }
    return existing;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Attribution + consent snapshot helpers (mirror the shared blueprint)
// ═══════════════════════════════════════════════════════════════════════════

/** The 14 camelCase attribution suffixes (lockstep with the shared model). */
const ATTRIBUTION_SUFFIXES = [
  "UtmSource", "UtmMedium", "UtmCampaign", "UtmTerm", "UtmContent", "Referrer",
  "LandingUrl", "Gclid", "Gbraid", "Wbraid", "Fbclid", "ClickId", "SessionId",
  "DeviceId",
] as const;
type AttributionSuffix = (typeof ATTRIBUTION_SUFFIXES)[number];

/** camelCase input keys for one attribution touch. */
const ATTRIBUTION_INPUT_KEYS = [
  "utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent", "referrer",
  "landingUrl", "gclid", "gbraid", "wbraid", "fbclid", "clickId", "sessionId",
  "deviceId",
] as const;
type AttributionInputKey = (typeof ATTRIBUTION_INPUT_KEYS)[number];

/** Map an input key (utmSource) to its column suffix (UtmSource). */
function suffixFor(key: AttributionInputKey): AttributionSuffix {
  return (key.charAt(0).toUpperCase() + key.slice(1)) as AttributionSuffix;
}

/** One attribution touch as a plain input record (all optional). */
type AttributionInput = Partial<Record<AttributionInputKey, string | null | undefined>>;

function cleanAttributionString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return cleaned || undefined;
}

function attributionValueLooksSensitive(value: string): boolean {
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, " "));
    if (decoded !== value) candidates.push(decoded);
  } catch {
    return true;
  }
  return candidates.some((candidate) => {
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(candidate)) return true;
    if (
      /\b(?:bearer|password|secret|access[_-]?token|api[_-]?key|private[_-]?key)\b/i.test(
        candidate,
      )
    ) {
      return true;
    }
    if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(candidate)) {
      return true;
    }
    if (/(?:^|[^a-z0-9])(?:sk|rk)_(?:live|test)_[a-z0-9_-]{8,}/i.test(candidate)) {
      return true;
    }
    const digits = candidate.replace(/\D/g, "");
    return (
      /^\+?[\d(). -]+$/.test(candidate) &&
      digits.length >= 10 &&
      digits.length <= 19
    );
  });
}

function sanitizeCampaignAttribution(value: unknown): string | undefined {
  const cleaned = cleanAttributionString(value, 200);
  if (!cleaned || attributionValueLooksSensitive(cleaned)) return undefined;
  try {
    const decoded = decodeURIComponent(cleaned.replace(/\+/g, " "));
    if (!/^[A-Za-z0-9][A-Za-z0-9._~+%:-]*$/.test(decoded)) return undefined;
  } catch {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._~+%:-]*$/.test(cleaned)
    ? cleaned
    : undefined;
}

function sanitizeOpaqueAttribution(value: unknown): string | undefined {
  const cleaned = cleanAttributionString(value, 256);
  if (!cleaned || attributionValueLooksSensitive(cleaned)) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(cleaned) ? cleaned : undefined;
}

function sanitizeAttributionUrl(
  value: unknown,
  includeCampaignParams: boolean,
): string | undefined {
  const raw = cleanAttributionString(value, 2000);
  if (!raw) return undefined;
  try {
    const source = new URL(raw);
    if (!["https:", "http:"].includes(source.protocol)) return undefined;
    if (source.username || source.password) return undefined;

    let pathname = source.pathname;
    try {
      const decodedPath = decodeURIComponent(pathname);
      if (
        attributionValueLooksSensitive(decodedPath) ||
        decodedPath.split("/").some((segment) => segment.length > 128)
      ) {
        pathname = "/";
      }
    } catch {
      pathname = "/";
    }

    const safe = new URL(pathname, source.origin);
    if (includeCampaignParams) {
      const campaignParams: ReadonlyArray<
        readonly [string, (candidate: unknown) => string | undefined]
      > = [
        ["utm_source", sanitizeCampaignAttribution],
        ["utm_medium", sanitizeCampaignAttribution],
        ["utm_campaign", sanitizeCampaignAttribution],
        ["utm_term", sanitizeCampaignAttribution],
        ["utm_content", sanitizeCampaignAttribution],
        ["gclid", sanitizeOpaqueAttribution],
        ["gbraid", sanitizeOpaqueAttribution],
        ["wbraid", sanitizeOpaqueAttribution],
        ["fbclid", sanitizeOpaqueAttribution],
      ];
      for (const [key, sanitizer] of campaignParams) {
        const sanitized = sanitizer(source.searchParams.get(key));
        if (sanitized) safe.searchParams.set(key, sanitized);
      }
    }
    return safe.toString().slice(0, 2000);
  } catch {
    return undefined;
  }
}

const campaignAttr = z.unknown().transform(sanitizeCampaignAttribution).optional();
const opaqueAttr = z.unknown().transform(sanitizeOpaqueAttribution).optional();
const referrerAttr = z
  .unknown()
  .transform((value) => sanitizeAttributionUrl(value, false))
  .optional();
const landingAttr = z
  .unknown()
  .transform((value) => sanitizeAttributionUrl(value, true))
  .optional();

/** Reusable server-side privacy boundary for one attribution touch. */
export const attributionTouchSchema = z
  .object({
    utmSource: campaignAttr,
    utmMedium: campaignAttr,
    utmCampaign: campaignAttr,
    utmTerm: campaignAttr,
    utmContent: campaignAttr,
    referrer: referrerAttr,
    landingUrl: landingAttr,
    gclid: opaqueAttr,
    gbraid: opaqueAttr,
    wbraid: opaqueAttr,
    fbclid: opaqueAttr,
    clickId: opaqueAttr,
    sessionId: opaqueAttr,
    deviceId: opaqueAttr,
  })
  .strict();
export type AttributionTouchInput = z.infer<typeof attributionTouchSchema>;

/** Public funnel boundary: accept legacy keys during rollout, but never persist them. */
export const publicBookAttributionTouchSchema = attributionTouchSchema.transform(
  ({ clickId: _legacyClickId, deviceId: _legacyDeviceId, ...approved }) => approved,
);

/** `{ <prefix><Suffix>: value ?? null }` for an INSERT .values() touch. */
function attributionInsertValues(
  prefix: string,
  input: AttributionInput | undefined,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of ATTRIBUTION_INPUT_KEYS) {
    out[`${prefix}${suffixFor(key)}`] = input?.[key] ?? null;
  }
  return out;
}

/** Read one attribution touch off a persisted row (for order snapshotting). */
function attributionFromRow(
  prefix: string,
  row: Record<string, unknown>,
): AttributionInput {
  const out: AttributionInput = {};
  for (const key of ATTRIBUTION_INPUT_KEYS) {
    out[key] = (row[`${prefix}${suffixFor(key)}`] as string | null) ?? null;
  }
  return out;
}

/** Per-field merge: `primary` value when non-null, else `fallback`, else null. */
function mergeAttribution(
  primary: AttributionInput,
  fallback: AttributionInput,
): AttributionInput {
  const out: AttributionInput = {};
  for (const key of ATTRIBUTION_INPUT_KEYS) {
    out[key] = primary[key] ?? fallback[key] ?? null;
  }
  return out;
}

/** The 7 SMS-consent snapshot columns (camelCase), lockstep with the model. */
const SMS_CONSENT_COLUMNS = [
  "smsConsentState", "smsConsentEvidenceRef", "smsConsentCapturedAt",
  "smsConsentCopyVersion", "smsConsentSourceUrl", "smsConsentConfirmationStatus",
  "smsConsentConfirmedAt",
] as const;

/** Read the SMS-consent snapshot off a persisted row (for order snapshotting). */
function smsConsentFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of SMS_CONSENT_COLUMNS) {
    out[col] = row[col] ?? null;
  }
  // state/confirmationStatus are NOT NULL with defaults — never write null.
  out.smsConsentState = row.smsConsentState ?? "unknown";
  out.smsConsentConfirmationStatus = row.smsConsentConfirmationStatus ?? "not_requested";
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Contact upsert — first-touch immutable; latest/consent selectively updated
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trusted SMS-consent evidence input. `ledgerId` is the pointer; the upsert
 * SELECTs the ledger row FOR SHARE and derives state/evidenceRef/capturedAt.
 * Only disclosure-confirmation fields are caller-owned.
 */
const smsConsentSnapshotSchema = z.object({
  ledgerId: z.string().min(1),
  copyVersion: z.string().max(64).optional().nullable(),
  sourceUrl: z.string().max(4000).optional().nullable(),
  confirmationStatus: z.enum(bookSmsConsentConfirmationStatuses).optional(),
  confirmedAt: z.date().optional().nullable(),
});
export type SmsConsentSnapshotInput = z.infer<typeof smsConsentSnapshotSchema>;

/** Resolved consent snapshot (ledger-derived + caller disclosure fields). */
interface ResolvedConsentSnapshot {
  state: (typeof bookSmsConsentStates)[number];
  evidenceRef: string;
  capturedAt: Date;
  copyVersion: string | null;
  sourceUrl: string | null;
  confirmationStatus?: (typeof bookSmsConsentConfirmationStatuses)[number];
  confirmedAt: Date | null;
}

export const upsertContactSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(200).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  clientId: z.string().optional().nullable(),
  scheduledMeetingId: z.string().optional().nullable(),
  /** Written once at creation; ignored on conflict. */
  firstTouch: attributionTouchSchema.optional(),
  /** Only explicitly provided keys are updated on conflict. */
  latestTouch: attributionTouchSchema.optional(),
  /** SMS consent snapshot — only provided keys update on conflict. */
  smsConsent: smsConsentSnapshotSchema.optional(),
  /** Email marketing status snapshot — updates only when provided. */
  emailMarketingStatus: z.enum(bookEmailMarketingStatuses).optional(),
});
export type UpsertContactInput = z.infer<typeof upsertContactSchema>;

export interface UpsertContactResult {
  contact: BookContact;
  /** Authoritative: true when a NEW row was inserted (RETURNING xmax = 0). */
  created: boolean;
}

/** Latest-touch SET clause: update only provided keys, else keep column value. */
function latestTouchSetClause(
  latest: AttributionTouchInput | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ATTRIBUTION_INPUT_KEYS) {
    const col = `latestTouch${suffixFor(key)}`;
    out[col] =
      latest !== undefined && latest[key] !== undefined
        ? latest[key]
        : sql`${(bookContacts as unknown as Record<string, unknown>)[col]}`;
  }
  return out;
}

/**
 * SMS-consent SET clause. When no evidence is supplied every consent column is
 * kept as-is (an upsert without smsConsent NEVER clears the snapshot). When a
 * resolved snapshot IS supplied, the ledger-derived authority fields
 * (state/evidenceRef/capturedAt) and the caller's disclosure fields are all
 * written; confirmationStatus keeps its durable value unless explicitly given.
 */
function smsConsentSetClause(
  consent: ResolvedConsentSnapshot | undefined,
): Record<string, unknown> {
  const keep = (col: string) =>
    sql`${(bookContacts as unknown as Record<string, unknown>)[col]}`;
  if (consent === undefined) {
    return {
      smsConsentState: keep("smsConsentState"),
      smsConsentEvidenceRef: keep("smsConsentEvidenceRef"),
      smsConsentCapturedAt: keep("smsConsentCapturedAt"),
      smsConsentCopyVersion: keep("smsConsentCopyVersion"),
      smsConsentSourceUrl: keep("smsConsentSourceUrl"),
      smsConsentConfirmationStatus: keep("smsConsentConfirmationStatus"),
      smsConsentConfirmedAt: keep("smsConsentConfirmedAt"),
    };
  }
  return {
    smsConsentState: consent.state,
    smsConsentEvidenceRef: consent.evidenceRef,
    smsConsentCapturedAt: consent.capturedAt,
    smsConsentCopyVersion: consent.copyVersion,
    smsConsentSourceUrl: consent.sourceUrl,
    smsConsentConfirmationStatus:
      consent.confirmationStatus !== undefined
        ? consent.confirmationStatus
        : keep("smsConsentConfirmationStatus"),
    smsConsentConfirmedAt: consent.confirmedAt,
  };
}

/** Type guard: is the ledger state part of the book-commerce consent vocab? */
function isBookSmsConsentState(
  value: string,
): value is (typeof bookSmsConsentStates)[number] {
  return (bookSmsConsentStates as readonly string[]).includes(value);
}

/**
 * Conflict-safe contact upsert on the normalized email.
 *
 * Runs inside ONE transaction so a supplied SMS-consent evidence pointer is
 * read (FOR SHARE) and validated against the same snapshot that the upsert
 * writes:
 *   - the sms_consent_ledger row must exist (else ConsentEvidenceConflictError);
 *   - ledger.state must be a valid book-commerce consent state;
 *   - a caller phone that differs from ledger.phoneNormalized is a conflict;
 *     when evidence is present the contact phone is derived from the ledger.
 * State/evidenceRef/capturedAt are always taken from the ledger; only the
 * disclosure-confirmation fields come from the focused input.
 *
 * ON CONFLICT (email):
 *   - first-touch columns are omitted from the SET → immutable;
 *   - latest-touch columns update only when the caller provides them;
 *   - the consent snapshot updates only when evidence is supplied — a call
 *     without smsConsent never clears it;
 *   - emailMarketingStatus updates only when provided.
 *
 * `created` is the authoritative RETURNING (xmax = 0) signal.
 */
export async function upsertBookContact(
  raw: UpsertContactInput,
): Promise<UpsertContactResult> {
  const input = upsertContactSchema.parse(raw);
  const email = normalizeBookEmail(input.email);

  return withDbAttribution(bookCommerceLabel("contact-upsert"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      // Resolve trusted consent evidence (if any) under a shared lock so the
      // ledger row cannot be mutated between validation and the write.
      let resolvedConsent: ResolvedConsentSnapshot | undefined;
      let phoneValue: string | null = input.phone ?? null;

      if (input.smsConsent) {
        const ledgerId = input.smsConsent.ledgerId;
        const [ledger] = await tx
          .select({
            id: smsConsentLedger.id,
            state: smsConsentLedger.state,
            phoneNormalized: smsConsentLedger.phoneNormalized,
            updatedAt: smsConsentLedger.updatedAt,
          })
          .from(smsConsentLedger)
          .where(eq(smsConsentLedger.id, ledgerId))
          .for("share")
          .limit(1);

        if (!ledger) {
          throw new ConsentEvidenceConflictError(
            ledgerId,
            "sms_consent_ledger row does not exist",
          );
        }
        if (!isBookSmsConsentState(ledger.state)) {
          throw new ConsentEvidenceConflictError(
            ledgerId,
            `ledger state "${ledger.state}" is not a valid book-commerce consent state`,
          );
        }
        if (
          input.phone !== undefined &&
          input.phone !== null &&
          input.phone !== ledger.phoneNormalized
        ) {
          throw new ConsentEvidenceConflictError(
            ledgerId,
            `supplied phone ${input.phone} conflicts with ledger phone ${ledger.phoneNormalized}`,
          );
        }

        // Evidence present → derive the contact phone from the ledger.
        phoneValue = ledger.phoneNormalized;
        resolvedConsent = {
          state: ledger.state,
          evidenceRef: ledger.id,
          capturedAt: ledger.updatedAt,
          copyVersion: input.smsConsent.copyVersion ?? null,
          sourceUrl: input.smsConsent.sourceUrl ?? null,
          confirmationStatus: input.smsConsent.confirmationStatus,
          confirmedAt: input.smsConsent.confirmedAt ?? null,
        };
      }

      const rows = await tx
        .insert(bookContacts)
        .values({ // spread-write-approved: focused Zod input plus ledger-derived consent and attribution whitelist only
          email,
          name: input.name ?? null,
          phone: phoneValue,
          clientId: input.clientId ?? null,
          scheduledMeetingId: input.scheduledMeetingId ?? null,
          ...attributionInsertValues("firstTouch", input.firstTouch),
          ...attributionInsertValues("latestTouch", input.latestTouch),
          smsConsentState: resolvedConsent?.state ?? "unknown",
          smsConsentEvidenceRef: resolvedConsent?.evidenceRef ?? null,
          smsConsentCapturedAt: resolvedConsent?.capturedAt ?? null,
          smsConsentCopyVersion: resolvedConsent?.copyVersion ?? null,
          smsConsentSourceUrl: resolvedConsent?.sourceUrl ?? null,
          smsConsentConfirmationStatus:
            resolvedConsent?.confirmationStatus ?? "not_requested",
          smsConsentConfirmedAt: resolvedConsent?.confirmedAt ?? null,
          emailMarketingStatus: input.emailMarketingStatus ?? "unknown",
        })
        .onConflictDoUpdate({
          target: bookContacts.email,
          set: {
            name: input.name !== undefined ? input.name : sql`${bookContacts.name}`,
            // When consent evidence is present the phone is ledger-derived;
            // otherwise update only when the caller explicitly provided one.
            phone:
              resolvedConsent !== undefined
                ? phoneValue
                : input.phone !== undefined
                  ? input.phone
                  : sql`${bookContacts.phone}`,
            clientId:
              input.clientId !== undefined
                ? input.clientId
                : sql`${bookContacts.clientId}`,
            scheduledMeetingId:
              input.scheduledMeetingId !== undefined
                ? input.scheduledMeetingId
                : sql`${bookContacts.scheduledMeetingId}`,
            emailMarketingStatus:
              input.emailMarketingStatus !== undefined
                ? input.emailMarketingStatus
                : sql`${bookContacts.emailMarketingStatus}`,
            updatedAt: sql`now()`,
            ...latestTouchSetClause(input.latestTouch),
            ...smsConsentSetClause(resolvedConsent),
            // first-touch columns deliberately absent → never overwritten.
          },
        })
        .returning({
          ...getTableColumns(bookContacts),
          inserted: sql<boolean>`(xmax = 0)`,
        });

      const { inserted, ...contact } = rows[0];
      return { contact: contact as BookContact, created: inserted };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Idempotent checkout session creation (production gate; authoritative)
// ═══════════════════════════════════════════════════════════════════════════

export const createCheckoutSessionSchema = z.object({
  contactId: z.string().min(1),
  packageCode: z.enum(bookPackageCodes),
  idempotencyKey: z.string().min(1).max(128),
  providerSessionId: z.string().max(256).optional().nullable(),
  resumeTokenHash: z.string().max(256).optional().nullable(),
  currentTouch: attributionTouchSchema.optional(),
  expiresAt: z.date().optional().nullable(),
});
export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>;

export interface CreateCheckoutSessionResult {
  session: BookCheckoutSession;
  created: boolean;
}

/** Reject a package that fails the production-default selectability gate. */
function assertPackageSelectable(
  code: BookCommercePackageCode,
  launchGateCtx: ReturnType<typeof launchGateContextFromReport>,
): void {
  const sel = isPackageSelectable(code, undefined, launchGateCtx);
  if (!sel.selectable) {
    throw new PackageNotSelectableError(code, sel.reason ?? "package not selectable");
  }
}

/**
 * Create a checkout session at the exact server catalog price/currency,
 * gate-checked and deduped on idempotencyKey. Replay verifies contactId AND
 * packageCode match; otherwise IdempotencyConflictError.
 */
export async function createBookCheckoutSession(
  raw: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult> {
  const input = createCheckoutSessionSchema.parse(raw);
  const pkg = requirePackageByCode(input.packageCode);
  const readiness = await requireBookPackageLaunchReady(
    pkg.code as BookCommercePackageCode,
  );
  assertPackageSelectable(
    pkg.code as BookCommercePackageCode,
    {
      digitalReady: pkg.code === "digital",
      completeReady: pkg.code === "complete",
    },
  );

  return withDbAttribution(bookCommerceLabel("checkout-create"), async () => {
    const db = getDb();

    const [inserted] = await db
      .insert(bookCheckoutSessions)
      .values({ // spread-write-approved: focused checkout schema plus server-owned catalog and attribution whitelist only
        contactId: input.contactId,
        packageCode: pkg.code,
        status: checkoutSessionStatuses[0],
        subtotalAmountCents: pkg.amountCents,
        discountAmountCents: 0,
        shippingAmountCents: 0,
        taxAmountCents: 0,
        amountTotalCents: pkg.amountCents, // = subtotal - 0 + 0 + 0
        quoteVersion: 0,
        paymentState: "none",
        policySnapshot: readiness.policySnapshot,
        currency: pkg.currency,
        idempotencyKey: input.idempotencyKey,
        providerSessionId: input.providerSessionId ?? null,
        resumeTokenHash: input.resumeTokenHash ?? null,
        ...attributionInsertValues("currentTouch", input.currentTouch),
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return { session: inserted, created: true };
    }

    const [existing] = await db
      .select()
      .from(bookCheckoutSessions)
      .where(eq(bookCheckoutSessions.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (!existing) {
      throw new IncompleteAggregateError(
        `checkout session insert conflicted on idempotencyKey ${input.idempotencyKey} but no existing row was found`,
      );
    }

    if (existing.contactId !== input.contactId) {
      throw new IdempotencyConflictError(
        "checkout-session",
        input.idempotencyKey,
        `existing contactId ${existing.contactId} != requested ${input.contactId}`,
      );
    }
    if (existing.packageCode !== input.packageCode) {
      throw new IdempotencyConflictError(
        "checkout-session",
        input.idempotencyKey,
        `existing packageCode ${existing.packageCode} != requested ${input.packageCode}`,
      );
    }
    return { session: existing, created: false };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Authoritative order creation (all fields derived from checkout + contact)
// ═══════════════════════════════════════════════════════════════════════════

export const createOrderSchema = z.object({
  /** Required — the order derives everything else from this checkout session. */
  checkoutSessionId: z.string().min(1),
  /** Server-generated human-readable order number (unique). */
  orderNumber: z.string().min(1).max(64),
  createdByUserId: z.string().optional().nullable(),
  // NOTE: no packageCode/contactId/attribution/price/gate overrides — all are
  // derived authoritatively from the checkout session and its contact.
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export interface CreateOrderResult {
  order: BookOrder;
  item: BookOrderItem;
  lifecycleEvent: BookLifecycleEvent;
  outboxEntry: BookOutboxEntry;
}

/** Deterministic outbox key for the initial order-created event. */
export function orderCreatedOutboxKey(orderId: string): string {
  return `order-created:${orderId}`;
}

/** Deterministic lifecycle key for the initial order-created event. */
export function orderCreatedLifecycleKey(orderId: string): string {
  return `order-created:${orderId}`;
}

/**
 * Internal tx-aware order creation core. Accepts an already-locked checkout
 * session + its contact (both pre-fetched FOR UPDATE by the caller). Derives
 * all commerce fields from the locked checkout quote. Used by both the public
 * `createBookOrder` and the verified-webhook applicator so the full aggregate
 * is written in ONE transaction. Gate re-run is the caller's responsibility.
 */
export async function createBookOrderInTx(
  tx: TxLike,
  checkout: BookCheckoutSession,
  contact: BookContact,
  orderNumber: string,
  createdByUserId: string | null,
): Promise<CreateOrderResult> {
  const pkg = requirePackageByCode(checkout.packageCode as BookPackageCode);

  // Immutable order financials derived from the locked checkout quote.
  const subtotal = checkout.subtotalAmountCents ?? pkg.amountCents;
  const discount = checkout.discountAmountCents ?? 0;
  const shipping = checkout.shippingAmountCents ?? 0;
  const tax = checkout.taxAmountCents ?? 0;
  const total = subtotal - discount + shipping + tax;

  const contactRow = contact as unknown as Record<string, unknown>;
  const checkoutRow = checkout as unknown as Record<string, unknown>;
  const firstSnapshot = attributionFromRow("firstTouch", contactRow);
  const latestSnapshot = mergeAttribution(
    attributionFromRow("currentTouch", checkoutRow),
    attributionFromRow("latestTouch", contactRow),
  );
  const smsSnapshot = smsConsentFromRow(contactRow);

  const [order] = await tx
    .insert(bookOrders)
    .values({ // spread-write-approved: trusted locked DB rows transformed through attribution/consent whitelists only
      contactId: contact.id,
      checkoutSessionId: checkout.id,
      orderNumber,
      status: "pending_payment",
      packageCode: pkg.code,
      currency: pkg.currency,
      subtotalAmountCents: subtotal,
      discountAmountCents: discount,
      shippingAmountCents: shipping,
      taxAmountCents: tax,
      totalAmountCents: total,
      createdByUserId: createdByUserId ?? null,
      ...attributionInsertValues("firstTouch", firstSnapshot),
      ...attributionInsertValues("latestTouch", latestSnapshot),
      ...smsSnapshot,
      policySnapshot: checkout.policySnapshot ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (!order) {
    return replayExistingOrder(tx, checkout.id, orderNumber);
  }

  const [item] = await tx
    .insert(bookOrderItems)
    .values({
      orderId: order.id,
      packageCode: pkg.code,
      packageLabel: pkg.name,
      quantity: 1,
      unitPriceCents: subtotal,
      lineTotalCents: subtotal,
      currency: pkg.currency,
      discountAmountCents: 0,
    })
    .returning();

  const lifecycleEvent = await insertLifecycleEventTx(tx, {
    contactId: order.contactId,
    orderId: order.id,
    checkoutSessionId: order.checkoutSessionId,
    eventType: "order_created",
    fromStatus: null,
    toStatus: "pending_payment",
    actorUserId: createdByUserId ?? null,
    idempotencyKey: orderCreatedLifecycleKey(order.id),
  });

  const outboxEntry = await insertOutboxTx(tx, {
    eventType: "order.created",
    sourceType: "order",
    sourceId: order.id,
    payload: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      contactId: order.contactId,
      checkoutSessionId: order.checkoutSessionId,
      packageCode: order.packageCode,
      totalAmountCents: order.totalAmountCents,
      currency: order.currency,
    },
    idempotencyKey: orderCreatedOutboxKey(order.id),
  });

  return { order, item, lifecycleEvent, outboxEntry };
}

/**
 * Authoritatively create an order from a checkout session. Locks the session
 * FOR UPDATE, loads the contact, re-runs the package gate, then delegates the
 * full aggregate write to `createBookOrderInTx`. Replay raises
 * IdempotencyConflictError rather than returning an unrelated order.
 */
export async function createBookOrder(
  raw: CreateOrderInput,
): Promise<CreateOrderResult> {
  const input = createOrderSchema.parse(raw);
  const readinessReport = await getBookLaunchReadinessReport();

  return withDbAttribution(bookCommerceLabel("order-create"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      // Authoritative source: the checkout session (locked for the txn).
      const [checkout] = await tx
        .select()
        .from(bookCheckoutSessions)
        .where(eq(bookCheckoutSessions.id, input.checkoutSessionId))
        .for("update")
        .limit(1);

      if (!checkout) {
        throw new IdempotencyConflictError(
          "order",
          input.checkoutSessionId,
          "checkout session does not exist",
        );
      }
      if (!checkout.contactId) {
        throw new IdempotencyConflictError(
          "order",
          input.checkoutSessionId,
          "checkout session has no contact",
        );
      }

      const [contact] = await tx
        .select()
        .from(bookContacts)
        .where(eq(bookContacts.id, checkout.contactId))
        .limit(1);
      if (!contact) {
        throw new IdempotencyConflictError(
          "order",
          input.checkoutSessionId,
          `checkout contact ${checkout.contactId} not found`,
        );
      }

      // Derive package + re-run the production gate on the derived package.
      assertPackageSelectable(
        checkout.packageCode as BookCommercePackageCode,
        launchGateContextFromReport(readinessReport),
      );

      // Delegate to the shared tx helper (also used by the webhook applicator).
      return createBookOrderInTx(
        tx,
        checkout,
        contact,
        input.orderNumber,
        input.createdByUserId ?? null,
      );
    });
  });
}

/**
 * Replay path: an order already exists for this checkout OR the orderNumber is
 * taken. Fetch by checkoutSessionId, verify identity (checkout ↔ orderNumber
 * both match), then verify the complete aggregate; throw if inconsistent.
 */
async function replayExistingOrder(
  tx: TxLike,
  checkoutSessionId: string,
  orderNumber: string,
): Promise<CreateOrderResult> {
  const [order] = await tx
    .select()
    .from(bookOrders)
    .where(eq(bookOrders.checkoutSessionId, checkoutSessionId))
    .limit(1);

  if (!order) {
    // No order for this checkout, yet the insert conflicted → the orderNumber
    // must be bound to a DIFFERENT checkout. Never return an unrelated order.
    throw new IdempotencyConflictError(
      "order",
      orderNumber,
      `orderNumber is already bound to another checkout (not ${checkoutSessionId})`,
    );
  }
  if (order.orderNumber !== orderNumber) {
    throw new IdempotencyConflictError(
      "order",
      orderNumber,
      `checkout ${checkoutSessionId} already bound to orderNumber ${order.orderNumber}`,
    );
  }

  const [item] = await tx
    .select()
    .from(bookOrderItems)
    .where(eq(bookOrderItems.orderId, order.id))
    .limit(1);

  const [lifecycleEvent] = await tx
    .select()
    .from(bookLifecycleEvents)
    .where(eq(bookLifecycleEvents.idempotencyKey, orderCreatedLifecycleKey(order.id)))
    .limit(1);

  const [outboxEntry] = await tx
    .select()
    .from(bookOutbox)
    .where(eq(bookOutbox.idempotencyKey, orderCreatedOutboxKey(order.id)))
    .limit(1);

  if (!item || !lifecycleEvent || !outboxEntry) {
    throw new IncompleteAggregateError(
      `order ${orderNumber} (${order.id}) is persisted with an incomplete aggregate ` +
        `(item=${!!item}, lifecycle=${!!lifecycleEvent}, outbox=${!!outboxEntry})`,
    );
  }

  return { order, item, lifecycleEvent, outboxEntry };
}

export type { BookContact, BookCheckoutSession, BookOrder, BookOrderItem, BookLifecycleEvent, BookOutboxEntry };
