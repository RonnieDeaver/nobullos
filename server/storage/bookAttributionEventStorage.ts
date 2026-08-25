// @db-pool-intent: mixed
//
// Task #5106 — Book Attribution Event Ledger + Per-Provider Delivery State.
//
// This module is intentionally scoped to the attribution event ledger and its
// per-provider delivery state. It does NOT touch lifecycle events, outbox,
// orders, contacts, or any other book commerce entity.
//
// Ownership:
//   - insertBookAttributionEvent: insert ON CONFLICT (idempotency key) +
//     validate identity on replay + create delivery intent rows for explicitly
//     eligible providers only.
//   - loadAttributionEventFacts: load allow-listed attribution/order
//     facts for a given event (used by workers before forwarding to platforms).
//   - claimDeliveryBatch: lease-safe worker claim of pending/retry rows.
//   - finalizeDelivery: mark a leased row as sent (with external receipt).
//   - failDelivery: increment attempts and schedule retry or move to dead.
//   - recoverExpiredLeases: sweep rows whose lease has expired back to
//     pending/retry so another worker can claim them.
//
// Pool intent: mixed. Authoritative API writes inherit the API-scoped handle;
// later delivery workers inherit the worker-scoped handle.
//
// No network calls. All functions are pure DB operations.

import { and, eq, gt, lte, or, sql, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  bookAttributionEvents,
  bookAttributionEventDeliveries,
  bookAttributionEventNames,
  bookAttributionSourceAuthorities,
  bookAttributionPrivacyClasses,
  bookAttributionDeliveryProviders,
  bookAttributionDeliveryStatuses,
  bookOrders,
  type BookAttributionEvent,
  type BookAttributionEventDelivery,
  type BookAttributionEventName,
  type BookAttributionDeliveryProvider,
  type BookAttributionDeliveryStatus,
  type BookAttributionPrivacyClass,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { IncompleteAggregateError, IdempotencyConflictError } from "./bookCommerceStorage";

// ═══════════════════════════════════════════════════════════════════════════
// Attribution label helper
// ═══════════════════════════════════════════════════════════════════════════

const ATTRIBUTION_PREFIX = "route:book-attribution";

function attrLabel(op: string): string {
  return `${ATTRIBUTION_PREFIX}:${op}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider eligibility table
//
// Not all events are relevant to all providers.  Only explicitly eligible
// (event, provider) pairs get a delivery intent row. This prevents dead
// rows for events that a provider does not consume (e.g. book_video_start
// has no business value in Google Ads offline conversions).
//
// The eligibility table is intentionally conservative: only events where
// we have a confirmed blueprint mapping are marked eligible. New mappings
// require a code change here (not a migration — the delivery rows are
// created at insert time, not retroactively).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns the set of providers that should receive a delivery intent for the
 * given (eventName, privacyClass) combination.
 *
 * Rules:
 * Browser-only interactions do not create server-delivery rows. Server intent
 * is deliberately limited to authoritative commerce and lifecycle outcomes.
 * Every intent starts deferred; a later delivery stage must prove provider
 * configuration, policy approval, environment, and consent before release.
 */
function eligibleProviders(
  eventName: BookAttributionEventName,
  privacyClass: BookAttributionPrivacyClass,
): BookAttributionDeliveryProvider[] {
  const providers: BookAttributionDeliveryProvider[] = [];

  const ga4Events: BookAttributionEventName[] = [
    "purchase",
    "refund",
    "audit_application_submit",
    "audit_application_qualified",
    "audit_application_not_qualified",
    "appointment_booked",
    "appointment_attended",
    "appointment_no_show",
    "qualified_opportunity",
    "client_closed",
    "access_ready",
    "book_download",
    "complete_collection_purchased",
  ];
  if (ga4Events.includes(eventName)) providers.push("ga4");

  const metaEvents: BookAttributionEventName[] = [
    "purchase",
    "audit_application_submit",
  ];
  if (metaEvents.includes(eventName) && privacyClass !== "sensitive") {
    providers.push("meta_capi");
  }

  const googleAdsEvents: BookAttributionEventName[] = [
    "purchase",
    "audit_application_qualified",
    "appointment_attended",
    "qualified_opportunity",
    "client_closed",
  ];
  if (googleAdsEvents.includes(eventName)) {
    providers.push("google_ads");
  }

  return providers;
}

/**
 * All provider delivery is fail-closed until the delivery stage proves its
 * explicit provider, policy, environment, and consent gates.
 */
function initialDeliveryStatus(
  _provider: BookAttributionDeliveryProvider,
  _privacyClass: BookAttributionPrivacyClass,
): BookAttributionDeliveryStatus {
  return "deferred";
}

// ═══════════════════════════════════════════════════════════════════════════
// Attribution / order / contact fact allow-list
//
// The attribution snapshot stored in the ledger row and the facts loaded
// for delivery workers are both allow-listed to prevent PII leakage into
// JSONB blobs. The allow-list mirrors the blueprint §12.2 attribution fields.
// ═══════════════════════════════════════════════════════════════════════════

/** Allow-listed attribution snapshot keys (no PII). */
const ATTRIBUTION_SNAPSHOT_ALLOW_LIST = [
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "referrer",
  "landingUrl",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "sessionId",
] as const;
export type AttributionSnapshotKey = (typeof ATTRIBUTION_SNAPSHOT_ALLOW_LIST)[number];

const UTM_VALUE_MAX = 200;
const URL_VALUE_MAX = 2000;
const REFERRER_VALUE_MAX = 1000;
const CLICK_ID_VALUE_MAX = 256;
const SESSION_ID_VALUE_MAX = 128;

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return cleaned || undefined;
}

function looksSensitive(value: string): boolean {
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, " "));
    if (decoded !== value) candidates.push(decoded);
  } catch {
    return true;
  }
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
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
    if (
      /^\+?[\d(). -]+$/.test(candidate) &&
      digits.length >= 10 &&
      digits.length <= 19
    ) {
      return true;
    }
    return lower.includes("card_number") || lower.includes("application_answer");
  });
}

function sanitizeCampaignValue(value: unknown): string | undefined {
  const cleaned = cleanString(value, UTM_VALUE_MAX);
  if (!cleaned || looksSensitive(cleaned)) return undefined;
  try {
    const decoded = decodeURIComponent(cleaned.replace(/\+/g, " "));
    if (!/^[A-Za-z0-9][A-Za-z0-9._~+%:-]*$/.test(decoded)) return undefined;
  } catch {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._~+%:-]*$/.test(cleaned) ? cleaned : undefined;
}

function sanitizeClickId(value: unknown): string | undefined {
  const cleaned = cleanString(value, CLICK_ID_VALUE_MAX);
  if (!cleaned || looksSensitive(cleaned)) return undefined;
  return /^[A-Za-z0-9._~-]+$/.test(cleaned) ? cleaned : undefined;
}

function sanitizeSessionId(value: unknown): string | undefined {
  const cleaned = cleanString(value, SESSION_ID_VALUE_MAX);
  if (!cleaned || cleaned.length < 8 || looksSensitive(cleaned)) return undefined;
  return /^[A-Za-z0-9._~-]+$/.test(cleaned) ? cleaned : undefined;
}

function sanitizePublicUrl(
  value: unknown,
  options: { includeCampaignParams: boolean; max: number },
): string | undefined {
  const raw = cleanString(value, options.max);
  if (!raw) return undefined;
  try {
    const source = new URL(raw);
    if (!["https:", "http:"].includes(source.protocol)) return undefined;
    if (source.username || source.password) return undefined;

    let pathname = source.pathname;
    try {
      const decodedPath = decodeURIComponent(pathname);
      if (
        looksSensitive(decodedPath) ||
        decodedPath.split("/").some((segment) => segment.length > 128)
      ) {
        pathname = "/";
      }
    } catch {
      pathname = "/";
    }

    const safe = new URL(pathname, source.origin);
    if (options.includeCampaignParams) {
      const campaignParams: ReadonlyArray<readonly [string, (value: unknown) => string | undefined]> = [
        ["utm_source", sanitizeCampaignValue],
        ["utm_medium", sanitizeCampaignValue],
        ["utm_campaign", sanitizeCampaignValue],
        ["utm_term", sanitizeCampaignValue],
        ["utm_content", sanitizeCampaignValue],
        ["gclid", sanitizeClickId],
        ["gbraid", sanitizeClickId],
        ["wbraid", sanitizeClickId],
        ["fbclid", sanitizeClickId],
      ];
      for (const [key, sanitizer] of campaignParams) {
        const sanitized = sanitizer(source.searchParams.get(key));
        if (sanitized) safe.searchParams.set(key, sanitized);
      }
    }
    return safe.toString().slice(0, options.max);
  } catch {
    return undefined;
  }
}

const attributionSnapshotValueSchema = z
  .object({
    utmSource: z.unknown().transform(sanitizeCampaignValue),
    utmMedium: z.unknown().transform(sanitizeCampaignValue),
    utmCampaign: z.unknown().transform(sanitizeCampaignValue),
    utmTerm: z.unknown().transform(sanitizeCampaignValue),
    utmContent: z.unknown().transform(sanitizeCampaignValue),
    referrer: z
      .unknown()
      .transform((value) =>
        sanitizePublicUrl(value, { includeCampaignParams: false, max: REFERRER_VALUE_MAX }),
      ),
    landingUrl: z
      .unknown()
      .transform((value) =>
        sanitizePublicUrl(value, { includeCampaignParams: true, max: URL_VALUE_MAX }),
      ),
    gclid: z.unknown().transform(sanitizeClickId),
    gbraid: z.unknown().transform(sanitizeClickId),
    wbraid: z.unknown().transform(sanitizeClickId),
    fbclid: z.unknown().transform(sanitizeClickId),
    sessionId: z.unknown().transform(sanitizeSessionId),
  })
  .partial()
  .strip();

function sanitizeAttributionSnapshot(
  value: unknown,
): Partial<Record<AttributionSnapshotKey, string>> {
  const parsed = attributionSnapshotValueSchema.parse(value);
  const out: Partial<Record<AttributionSnapshotKey, string>> = {};
  for (const key of ATTRIBUTION_SNAPSHOT_ALLOW_LIST) {
    const field = parsed[key];
    if (field !== undefined) out[key] = field;
  }
  return out;
}

function opaqueReferenceSchema(max: number): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._~:-]*$/)
    .refine((value) => !looksSensitive(value), "sensitive identifiers are not allowed");
}

/** Allow-listed order facts for delivery context. */
const ORDER_FACTS_ALLOW_LIST = [
  "id",
  "orderNumber",
  "packageCode",
  "totalAmountCents",
  "currency",
  "status",
] as const;

/** Filter an object to only allow-listed keys (defensive allow-list enforcement). */
function filterAllowList<T extends string>(
  obj: Record<string, unknown> | null | undefined,
  allowList: readonly T[],
): Partial<Record<T, unknown>> {
  if (!obj) return {};
  const out: Partial<Record<T, unknown>> = {};
  for (const key of allowList) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Insert attribution event (ON CONFLICT + identity validation + delivery intents)
// ═══════════════════════════════════════════════════════════════════════════

export const insertAttributionEventSchema = z.object({
  eventName: z.enum(bookAttributionEventNames),
  sourceAuthority: z.enum(bookAttributionSourceAuthorities),
  /** Source IDs — all optional. */
  contactId: opaqueReferenceSchema(128).optional().nullable(),
  checkoutSessionId: opaqueReferenceSchema(128).optional().nullable(),
  orderId: opaqueReferenceSchema(128).optional().nullable(),
  applicationId: opaqueReferenceSchema(128).optional().nullable(),
  appointmentId: opaqueReferenceSchema(128).optional().nullable(),
  opportunityRef: opaqueReferenceSchema(256).optional().nullable(),
  /** Order / item context — all optional. */
  packageCode: z.enum(["digital", "complete"] as const).optional().nullable(),
  amountCents: z.number().int().min(0).optional().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional().nullable(),
  itemSku: opaqueReferenceSchema(64).optional().nullable(),
  privacyClass: z.enum(bookAttributionPrivacyClasses).default("public"),
  /**
   * Attribution snapshot to store. Allow-listed on write (caller may provide
   * more keys; only ATTRIBUTION_SNAPSHOT_ALLOW_LIST keys are persisted).
   */
  attributionSnapshot: z.unknown().optional().nullable(),
  occurredAt: z.date(),
  /** Required globally unique logical key. */
  idempotencyKey: opaqueReferenceSchema(256),
});
export type InsertAttributionEventInput = z.infer<typeof insertAttributionEventSchema>;

export interface InsertAttributionEventResult {
  event: BookAttributionEvent;
  /** True when a NEW row was inserted; false on idempotent replay. */
  created: boolean;
  /** Delivery intent rows created (empty on replay). */
  deliveries: BookAttributionEventDelivery[];
}

/**
 * Insert a book attribution event into the ledger.
 *
 * Idempotency:
 *   When idempotencyKey is provided the insert uses ON CONFLICT DO NOTHING on
 *   the globally unique index. On a conflict we SELECT the existing row and
 *   validate its identity (eventName + sourceAuthority must match the caller's
 *   request). A mismatch throws IdempotencyConflictError — we never silently
 *   return a row for a different logical event.
 *
 * Attribution snapshot:
 *   The caller's attributionSnapshot is filtered through the allow-list before
 *   storage. Unknown keys are silently dropped.
 *
 * Delivery intents:
 *   After a successful insert, delivery intent rows are created for each
 *   explicitly eligible provider (determined by eligibleProviders()). On
 *   replay (created: false) no delivery rows are created.
 *
 * No network calls. No side effects outside the DB.
 */
export async function insertBookAttributionEvent(
  raw: InsertAttributionEventInput,
): Promise<InsertAttributionEventResult> {
  const input = insertAttributionEventSchema.parse(raw);

  // Filter the attribution snapshot to the allow-list.
  const filteredSnapshot =
    input.attributionSnapshot != null
      ? sanitizeAttributionSnapshot(input.attributionSnapshot)
      : null;

  return withDbAttribution(attrLabel("event-insert"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      // Insert the event row. ON CONFLICT DO NOTHING on the idempotency key.
      const [inserted] = await tx
        .insert(bookAttributionEvents)
        .values({
          eventName: input.eventName,
          sourceAuthority: input.sourceAuthority,
          contactId: input.contactId ?? null,
          checkoutSessionId: input.checkoutSessionId ?? null,
          orderId: input.orderId ?? null,
          applicationId: input.applicationId ?? null,
          appointmentId: input.appointmentId ?? null,
          opportunityRef: input.opportunityRef ?? null,
          packageCode: input.packageCode ?? null,
          amountCents: input.amountCents ?? null,
          currency: input.currency ?? null,
          itemSku: input.itemSku ?? null,
          privacyClass: input.privacyClass,
          attributionSnapshot: filteredSnapshot as Record<string, unknown> | null,
          occurredAt: input.occurredAt,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        // Fresh insert — create delivery intent rows for eligible providers.
        const providers = eligibleProviders(input.eventName, input.privacyClass);
        const deliveries: BookAttributionEventDelivery[] = [];

        for (const provider of providers) {
          const status = initialDeliveryStatus(provider, input.privacyClass);
          const [delivery] = await tx
            .insert(bookAttributionEventDeliveries)
            .values({
              eventId: inserted.id,
              provider,
              status,
              attempts: 0,
              maxAttempts: 5,
              nextAttemptAt: null,
              // Stable external idempotency key for the platform
              externalIdempotencyKey: `${inserted.id}:${provider}`,
            })
            .onConflictDoNothing()
            .returning();
          if (delivery) deliveries.push(delivery);
        }

        return { event: inserted, created: true, deliveries };
      }

      // Fetch the existing row and validate identity.
      const [existing] = await tx
        .select()
        .from(bookAttributionEvents)
        .where(eq(bookAttributionEvents.idempotencyKey, input.idempotencyKey))
        .limit(1);

      if (!existing) {
        throw new IncompleteAggregateError(
          `attribution event ${input.idempotencyKey} conflicted but no row was found`,
        );
      }

      const identityFields = [
        ["eventName", existing.eventName, input.eventName],
        ["sourceAuthority", existing.sourceAuthority, input.sourceAuthority],
        ["contactId", existing.contactId, input.contactId ?? null],
        ["checkoutSessionId", existing.checkoutSessionId, input.checkoutSessionId ?? null],
        ["orderId", existing.orderId, input.orderId ?? null],
        ["applicationId", existing.applicationId, input.applicationId ?? null],
        ["appointmentId", existing.appointmentId, input.appointmentId ?? null],
        ["opportunityRef", existing.opportunityRef, input.opportunityRef ?? null],
        ["packageCode", existing.packageCode, input.packageCode ?? null],
        ["amountCents", existing.amountCents, input.amountCents ?? null],
        ["currency", existing.currency, input.currency ?? null],
        ["itemSku", existing.itemSku, input.itemSku ?? null],
        ["privacyClass", existing.privacyClass, input.privacyClass],
        ["occurredAt", existing.occurredAt.getTime(), input.occurredAt.getTime()],
      ] as const;
      const mismatch = identityFields.find(([, persisted, requested]) => persisted !== requested);
      if (mismatch) {
        throw new IdempotencyConflictError(
          "attribution-event",
          input.idempotencyKey,
          `existing ${mismatch[0]} does not match requested value`,
        );
      }

      // Replay — return existing row with no new deliveries.
      return { event: existing, created: false, deliveries: [] };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Load allow-listed attribution/order facts for a delivery worker
// ═══════════════════════════════════════════════════════════════════════════

export interface AttributionEventFacts {
  event: BookAttributionEvent;
  /** Allow-listed attribution snapshot (already filtered at insert). */
  attributionSnapshot: Partial<Record<AttributionSnapshotKey, unknown>>;
  /** Allow-listed order facts. */
  orderFacts: Partial<Record<(typeof ORDER_FACTS_ALLOW_LIST)[number], unknown>> | null;
}

/**
 * Load allow-listed attribution/order facts for a given event ID.
 * Called by delivery workers before forwarding to an external platform.
 *
 * Returns null if the event does not exist (caller should mark delivery dead).
 *
 * No contact PII is loaded here. A later provider stage must use a separate,
 * consent-gated identifier loader if approved enhanced conversion is enabled.
 */
export async function loadAttributionEventFacts(
  eventId: string,
): Promise<AttributionEventFacts | null> {
  const safeEventId = opaqueReferenceSchema(128).parse(eventId);
  return withDbAttribution(attrLabel("load-facts"), async () => {
    const db = getDb();

    const [event] = await db
      .select()
      .from(bookAttributionEvents)
      .where(eq(bookAttributionEvents.id, safeEventId))
      .limit(1);

    if (!event) return null;

    // Load order facts if an orderId is present.
    let orderFacts: AttributionEventFacts["orderFacts"] = null;
    if (event.orderId) {
      const [order] = await db
        .select({
          id: bookOrders.id,
          orderNumber: bookOrders.orderNumber,
          packageCode: bookOrders.packageCode,
          totalAmountCents: bookOrders.totalAmountCents,
          currency: bookOrders.currency,
          status: bookOrders.status,
        })
        .from(bookOrders)
        .where(eq(bookOrders.id, event.orderId))
        .limit(1);
      if (order) {
        orderFacts = filterAllowList(
          order as Record<string, unknown>,
          ORDER_FACTS_ALLOW_LIST,
        );
      }
    }

    return {
      event,
      attributionSnapshot: sanitizeAttributionSnapshot(event.attributionSnapshot ?? {}),
      orderFacts,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Lease-safe worker operations: claim / finalize / fail / recover
// ═══════════════════════════════════════════════════════════════════════════

export const claimDeliveryBatchSchema = z.object({
  provider: z.enum(bookAttributionDeliveryProviders),
  /** Must be newly generated for this claim call, never a stable worker ID. */
  leaseOwnerToken: opaqueReferenceSchema(64),
  /** How long the lease is valid for (milliseconds). Default: 60 000 (60s). */
  leaseDurationMs: z.number().int().min(1000).max(600_000).default(60_000),
  /** Maximum rows to claim in one batch. Default: 10. */
  batchSize: z.number().int().min(1).max(100).default(10),
});
export type ClaimDeliveryBatchInput = z.infer<typeof claimDeliveryBatchSchema>;

/**
 * Atomically claim a batch of pending/retry delivery rows for a provider.
 *
 * Uses a raw SQL UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) so
 * concurrent workers on the same provider never race on the same rows.
 * Returns the claimed rows. The caller must finalize or fail each row within
 * leaseDurationMs to prevent stale-lease accumulation.
 */
export async function claimAttributionDeliveryBatch(
  raw: ClaimDeliveryBatchInput,
): Promise<BookAttributionEventDelivery[]> {
  const input = claimDeliveryBatchSchema.parse(raw);
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + input.leaseDurationMs);

  return withDbAttribution(attrLabel("claim-batch"), async () => {
    const db = getDb();

    const result = await db.execute(sql`
      UPDATE book_attribution_event_deliveries
      SET
        lease_token      = ${input.leaseOwnerToken},
        lease_expires_at = ${leaseExpiry},
        updated_at       = ${now}
      WHERE id IN (
        SELECT id
        FROM book_attribution_event_deliveries
        WHERE provider = ${input.provider}
          AND status IN ('pending', 'retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (lease_expires_at IS NULL OR lease_expires_at < ${now})
        ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.batchSize}
      )
      RETURNING *
    `);

    return (result.rows as Record<string, unknown>[]).map(rowToDelivery);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export const finalizeDeliverySchema = z.object({
  deliveryId: opaqueReferenceSchema(128),
  leaseToken: opaqueReferenceSchema(64),
  externalReceiptId: opaqueReferenceSchema(256).optional().nullable(),
});
export type FinalizeDeliveryInput = z.infer<typeof finalizeDeliverySchema>;

/**
 * Mark a leased delivery row as successfully sent.
 *
 * Validates that the caller holds the current lease token (prevents a stale
 * worker from finalizing a row that has been reclaimed). Sets status=sent,
 * clears the lease, records the external receipt and sent timestamp.
 *
 * Returns the updated row, or null if the delivery does not exist or the
 * lease token does not match (caller should not retry finalizeDelivery).
 */
export async function finalizeAttributionDelivery(
  raw: FinalizeDeliveryInput,
): Promise<BookAttributionEventDelivery | null> {
  const input = finalizeDeliverySchema.parse(raw);
  const now = new Date();

  return withDbAttribution(attrLabel("finalize"), async () => {
    const [row] = await getDb()
      .update(bookAttributionEventDeliveries)
      .set({
        status: "sent",
        attempts: sql`attempts + 1`,
        leaseToken: null,
        leaseExpiresAt: null,
        externalReceiptId: input.externalReceiptId ?? null,
        errorClass: null,
        sentAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(bookAttributionEventDeliveries.id, input.deliveryId),
          eq(bookAttributionEventDeliveries.leaseToken, input.leaseToken),
          gt(bookAttributionEventDeliveries.leaseExpiresAt, now),
        ),
      )
      .returning();
    return row ?? null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export const failDeliverySchema = z.object({
  deliveryId: opaqueReferenceSchema(128),
  leaseToken: opaqueReferenceSchema(64),
  /** Sanitized error class (no PII, no stack traces). */
  errorClass: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9._:-]*$/),
  /** How many milliseconds to wait before the next retry attempt. */
  retryAfterMs: z.number().int().min(0).optional().nullable(),
});
export type FailDeliveryInput = z.infer<typeof failDeliverySchema>;

export interface FailDeliveryResult {
  delivery: BookAttributionEventDelivery | null;
  /** True if the row was moved to dead (attempts exhausted). */
  exhausted: boolean;
}

/**
 * Record a failed delivery attempt. Validates lease token ownership.
 *
 * If attempts + 1 >= max_attempts → status=dead.
 * Otherwise → status=retry, nextAttemptAt = now + retryAfterMs.
 *
 * Returns null if delivery not found or lease token mismatch.
 */
export async function failAttributionDelivery(
  raw: FailDeliveryInput,
): Promise<FailDeliveryResult> {
  const input = failDeliverySchema.parse(raw);
  const now = new Date();

  return withDbAttribution(attrLabel("fail"), async () => {
    const nextAttemptAt =
      input.retryAfterMs != null
        ? new Date(now.getTime() + input.retryAfterMs)
        : null;
    const [updated] = await getDb()
      .update(bookAttributionEventDeliveries)
      .set({
        status: sql<BookAttributionDeliveryStatus>`
          CASE
            WHEN attempts + 1 >= max_attempts THEN 'dead'
            ELSE 'retry'
          END
        `,
        attempts: sql`attempts + 1`,
        leaseToken: null,
        leaseExpiresAt: null,
        errorClass: input.errorClass,
        nextAttemptAt: sql`
          CASE
            WHEN attempts + 1 >= max_attempts THEN NULL
            ELSE ${nextAttemptAt}::timestamp
          END
        `,
        updatedAt: now,
      })
      .where(
        and(
          eq(bookAttributionEventDeliveries.id, input.deliveryId),
          eq(bookAttributionEventDeliveries.leaseToken, input.leaseToken),
          gt(bookAttributionEventDeliveries.leaseExpiresAt, now),
        ),
      )
      .returning();

    return {
      delivery: updated ?? null,
      exhausted: updated?.status === "dead",
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export const recoverExpiredLeasesSchema = z.object({
  provider: z.enum(bookAttributionDeliveryProviders),
  limit: z.number().int().min(1).max(200).default(50),
});
export type RecoverExpiredLeasesInput = z.infer<typeof recoverExpiredLeasesSchema>;

export interface RecoverExpiredLeasesResult {
  recovered: number;
}

/**
 * Sweep delivery rows whose lease has expired and move them back to
 * pending/retry so another worker can claim them.
 *
 * Only touches rows in status=pending or status=retry with an expired
 * lease_expires_at. Does NOT touch dead/sent/disabled/deferred rows.
 * Uses SKIP LOCKED to avoid racing with active workers.
 */
export async function recoverExpiredAttributionLeases(
  raw: RecoverExpiredLeasesInput,
): Promise<RecoverExpiredLeasesResult> {
  const input = recoverExpiredLeasesSchema.parse(raw);
  const now = new Date();

  return withDbAttribution(attrLabel("recover-leases"), async () => {
    const db = getDb();

    const result = await db.execute(sql`
      UPDATE book_attribution_event_deliveries
      SET
        lease_token      = NULL,
        lease_expires_at = NULL,
        updated_at       = ${now}
      WHERE id IN (
        SELECT id
        FROM book_attribution_event_deliveries
        WHERE provider = ${input.provider}
          AND status IN ('pending', 'retry')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ${now}
        ORDER BY lease_expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      )
      RETURNING id
    `);

    return { recovered: result.rows.length };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Convenience query: load delivery rows for an event
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load all delivery rows for a given attribution event ID.
 * Used for diagnostics, support queries, and dead-letter review.
 */
export async function loadEventDeliveries(
  eventId: string,
): Promise<BookAttributionEventDelivery[]> {
  const safeEventId = opaqueReferenceSchema(128).parse(eventId);
  return withDbAttribution(attrLabel("load-deliveries"), async () => {
    return getDb()
      .select()
      .from(bookAttributionEventDeliveries)
      .where(eq(bookAttributionEventDeliveries.eventId, safeEventId));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal row mapper (raw SQL rows → typed Drizzle objects)
// ═══════════════════════════════════════════════════════════════════════════

function rowToDelivery(raw: Record<string, unknown>): BookAttributionEventDelivery {
  return {
    id: raw.id as string,
    eventId: (raw.event_id ?? raw.eventId) as string,
    provider: (raw.provider as BookAttributionDeliveryProvider),
    status: (raw.status as BookAttributionDeliveryStatus),
    attempts: (raw.attempts as number) ?? 0,
    maxAttempts: ((raw.max_attempts ?? raw.maxAttempts) as number | null) ?? 5,
    nextAttemptAt: raw.next_attempt_at
      ? new Date(raw.next_attempt_at as string)
      : (raw.nextAttemptAt as Date | null) ?? null,
    leaseToken: (raw.lease_token ?? raw.leaseToken ?? null) as string | null,
    leaseExpiresAt: raw.lease_expires_at
      ? new Date(raw.lease_expires_at as string)
      : (raw.leaseExpiresAt as Date | null) ?? null,
    externalReceiptId: (raw.external_receipt_id ?? raw.externalReceiptId ?? null) as string | null,
    externalIdempotencyKey:
      (raw.external_idempotency_key ?? raw.externalIdempotencyKey ?? null) as string | null,
    errorClass: (raw.error_class ?? raw.errorClass ?? null) as string | null,
    createdAt: raw.created_at
      ? new Date(raw.created_at as string)
      : (raw.createdAt as Date) ?? new Date(),
    updatedAt: raw.updated_at
      ? new Date(raw.updated_at as string)
      : (raw.updatedAt as Date) ?? new Date(),
    sentAt: raw.sent_at
      ? new Date(raw.sent_at as string)
      : (raw.sentAt as Date | null) ?? null,
  };
}
