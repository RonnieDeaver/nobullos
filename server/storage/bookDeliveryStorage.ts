// @db-pool-intent: ambient
/**
 * Private paid-book delivery persistence.
 *
 * This module deliberately stores only token/session hashes. It never returns
 * an email address, object key, raw capability, payment detail, or intake
 * data to a public caller.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookContacts,
  bookDeliveryAssets,
  bookDeliveryAudit,
  bookDeliveryLinks,
  bookDeliverySessions,
  bookEntitlements,
  bookOrders,
  type BookDeliveryAsset,
  type BookEntitlement,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { bookCommerceLabel } from "./bookCommerceStorage";

const now = () => new Date();

export const deliveryLinkPurposeSchema = z.enum(["initial", "resend", "reissue"]);
export type DeliveryLinkPurpose = z.infer<typeof deliveryLinkPurposeSchema>;

export const createDeliveryLinkSchema = z.object({
  entitlementId: z.string().min(1),
  tokenHash: z.string().length(64).regex(/^[a-f0-9]+$/),
  purpose: deliveryLinkPurposeSchema,
  idempotencyKey: z.string().min(1).max(128),
  expiresAt: z.date(),
  actorUserId: z.string().min(1).optional().nullable(),
});

export async function createBookDeliveryLink(
  raw: z.infer<typeof createDeliveryLinkSchema>,
) {
  const input = createDeliveryLinkSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("delivery-link-create"), async () => {
    const db = getDb();
    const [inserted] = await db
      .insert(bookDeliveryLinks)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted) return { link: inserted, created: true };

    const [existing] = await db
      .select()
      .from(bookDeliveryLinks)
      .where(eq(bookDeliveryLinks.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!existing) throw new Error("delivery link conflict without persisted row");
    if (
      existing.entitlementId !== input.entitlementId ||
      existing.tokenHash !== input.tokenHash ||
      existing.purpose !== input.purpose
    ) {
      throw new Error("delivery link idempotency conflict");
    }
    return { link: existing, created: false };
  });
}

/** The live authority gate used immediately before every private stream. */
export async function findActiveBookDeliveryEntitlement(
  entitlementId: string,
): Promise<BookEntitlement | null> {
  return withDbAttribution(bookCommerceLabel("delivery-entitlement-read"), async () => {
    const [entitlement] = await getDb()
      .select()
      .from(bookEntitlements)
      .where(
        and(
          eq(bookEntitlements.id, entitlementId),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
        ),
      )
      .limit(1);
    return entitlement ?? null;
  });
}

export async function listActiveDeliveryEntitlementsForOrder(orderId: string) {
  return withDbAttribution(bookCommerceLabel("delivery-entitlements-order"), async () =>
    getDb()
      .select()
      .from(bookEntitlements)
      .where(
        and(
          eq(bookEntitlements.orderId, orderId),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
        ),
      ),
  );
}

/**
 * Capability-token checkout recovery seam. The checkout route first proves the
 * resume token and verified completed state; this read then requires the paid
 * order's active digital entitlement before any delivery capability is minted.
 */
export async function findActiveDigitalDeliveryEntitlementForCheckout(
  checkoutSessionId: string,
): Promise<BookEntitlement | null> {
  return withDbAttribution(bookCommerceLabel("delivery-entitlement-checkout"), async () => {
    const [row] = await getDb()
      .select({ entitlement: bookEntitlements })
      .from(bookEntitlements)
      .innerJoin(bookOrders, eq(bookEntitlements.orderId, bookOrders.id))
      .where(
        and(
          eq(bookOrders.checkoutSessionId, checkoutSessionId),
          eq(bookEntitlements.entitlementCode, "digital_book"),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
        ),
      )
      .limit(1);
    return row?.entitlement ?? null;
  });
}

export interface BuyerDeliveryEntitlement {
  entitlement: BookEntitlement;
  email: string;
}

/** Used by the generic resend flow internally; callers never expose misses. */
export async function listActiveDeliveryEntitlementsForEmail(
  normalizedEmail: string,
): Promise<BuyerDeliveryEntitlement[]> {
  return withDbAttribution(bookCommerceLabel("delivery-entitlements-email"), async () => {
    const rows = await getDb()
      .select({ entitlement: bookEntitlements, email: bookContacts.email })
      .from(bookEntitlements)
      .innerJoin(bookContacts, eq(bookEntitlements.contactId, bookContacts.id))
      .where(
        and(
          eq(bookContacts.email, normalizedEmail),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
        ),
      );
    return rows.map((row) => ({ entitlement: row.entitlement, email: row.email }));
  });
}

export async function getBookDeliveryRecipient(entitlementId: string): Promise<string | null> {
  return withDbAttribution(bookCommerceLabel("delivery-recipient-read"), async () => {
    const [row] = await getDb()
      .select({ email: bookContacts.email })
      .from(bookEntitlements)
      .innerJoin(bookContacts, eq(bookEntitlements.contactId, bookContacts.id))
      .where(eq(bookEntitlements.id, entitlementId))
      .limit(1);
    return row?.email ?? null;
  });
}

export async function exchangeBookDeliveryLink(params: {
  tokenHash: string;
  sessionHash: string;
  sessionExpiresAt: Date;
}): Promise<{ entitlementId: string } | null> {
  return withDbAttribution(bookCommerceLabel("delivery-link-exchange"), async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [link] = await tx
        .select()
        .from(bookDeliveryLinks)
        .where(eq(bookDeliveryLinks.tokenHash, params.tokenHash))
        .for("update")
        .limit(1);
      if (!link || link.consumedAt || link.revokedAt || link.expiresAt <= now()) return null;

      const [entitlement] = await tx
        .select()
        .from(bookEntitlements)
        .where(
          and(
            eq(bookEntitlements.id, link.entitlementId),
            eq(bookEntitlements.status, "active"),
            sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
          ),
        )
        .limit(1);
      if (!entitlement) return null;

      const [consumed] = await tx
        .update(bookDeliveryLinks)
        .set({ consumedAt: now() })
        .where(and(eq(bookDeliveryLinks.id, link.id), isNull(bookDeliveryLinks.consumedAt)))
        .returning({ id: bookDeliveryLinks.id });
      if (!consumed) return null;

      await tx.insert(bookDeliverySessions).values({
        entitlementId: entitlement.id,
        sessionHash: params.sessionHash,
        expiresAt: params.sessionExpiresAt,
      });
      await insertDeliveryAuditTx(tx, {
        entitlementId: entitlement.id,
        eventType: "link_exchanged",
        outcome: "completed",
        idempotencyKey: `delivery-exchange:${link.id}`,
      });
      return { entitlementId: entitlement.id };
    });
  });
}

export async function resolveBookDeliverySession(sessionHash: string): Promise<BookEntitlement | null> {
  return withDbAttribution(bookCommerceLabel("delivery-session-resolve"), async () => {
    const [row] = await getDb()
      .select({ entitlement: bookEntitlements })
      .from(bookDeliverySessions)
      .innerJoin(bookEntitlements, eq(bookDeliverySessions.entitlementId, bookEntitlements.id))
      .where(
        and(
          eq(bookDeliverySessions.sessionHash, sessionHash),
          isNull(bookDeliverySessions.revokedAt),
          gt(bookDeliverySessions.expiresAt, now()),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
        ),
      )
      .limit(1);
    return row?.entitlement ?? null;
  });
}

export async function listActiveBookDeliveryAssets(
  entitlementCode: string,
): Promise<BookDeliveryAsset[]> {
  return withDbAttribution(bookCommerceLabel("delivery-assets-list"), async () =>
    getDb()
      .select()
      .from(bookDeliveryAssets)
      .where(
        and(
          eq(bookDeliveryAssets.entitlementCode, entitlementCode),
          eq(bookDeliveryAssets.status, "active"),
        ),
      ),
  );
}

export interface EntitledBookDeliveryAsset {
  asset: BookDeliveryAsset;
  entitlement: BookEntitlement;
}

/**
 * A browser session proves one active entitlement, then the service uses that
 * entitlement's order as the authority boundary. This lets a Complete buyer's
 * later-launched audiobook appear without minting a second browser credential,
 * while every returned asset still requires its own live entitlement and
 * active asset gate.
 */
export async function listActiveBookDeliveryAssetsForOrder(
  orderId: string,
): Promise<EntitledBookDeliveryAsset[]> {
  return withDbAttribution(bookCommerceLabel("delivery-assets-order-list"), async () =>
    getDb()
      .select({
        asset: bookDeliveryAssets,
        entitlement: bookEntitlements,
      })
      .from(bookEntitlements)
      .innerJoin(
        bookDeliveryAssets,
        eq(bookEntitlements.entitlementCode, bookDeliveryAssets.entitlementCode),
      )
      .where(
        and(
          eq(bookEntitlements.orderId, orderId),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
          eq(bookDeliveryAssets.status, "active"),
        ),
      )
      .orderBy(asc(bookDeliveryAssets.filename)),
  );
}

export async function getAuthorizedBookDeliveryAsset(params: {
  entitlementId: string;
  assetId: string;
}): Promise<BookDeliveryAsset | null> {
  return withDbAttribution(bookCommerceLabel("delivery-asset-authorize"), async () => {
    const [row] = await getDb()
      .select({ asset: bookDeliveryAssets })
      .from(bookEntitlements)
      .innerJoin(
        bookDeliveryAssets,
        eq(bookEntitlements.entitlementCode, bookDeliveryAssets.entitlementCode),
      )
      .where(
        and(
          eq(bookEntitlements.id, params.entitlementId),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
          eq(bookDeliveryAssets.id, params.assetId),
          eq(bookDeliveryAssets.status, "active"),
        ),
      )
      .limit(1);
    return row?.asset ?? null;
  });
}

export async function getAuthorizedBookDeliveryAssetForOrder(params: {
  orderId: string;
  assetId: string;
}): Promise<EntitledBookDeliveryAsset | null> {
  return withDbAttribution(bookCommerceLabel("delivery-asset-order-authorize"), async () => {
    const [row] = await getDb()
      .select({
        asset: bookDeliveryAssets,
        entitlement: bookEntitlements,
      })
      .from(bookEntitlements)
      .innerJoin(
        bookDeliveryAssets,
        eq(bookEntitlements.entitlementCode, bookDeliveryAssets.entitlementCode),
      )
      .where(
        and(
          eq(bookEntitlements.orderId, params.orderId),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
          eq(bookDeliveryAssets.id, params.assetId),
          eq(bookDeliveryAssets.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export interface BookDeliveryOrderSummary {
  orderNumber: string;
  status: string;
  packageCode: string;
  currency: string;
  totalAmountCents: number;
  refundedAmountCents: number;
  createdAt: Date;
}

/**
 * Deliberately narrow buyer projection. Address, contact, provider payment,
 * attribution, consent, and intake fields are never selected.
 */
export async function getBookDeliveryOrderSummary(
  orderId: string,
): Promise<BookDeliveryOrderSummary | null> {
  return withDbAttribution(bookCommerceLabel("delivery-order-summary"), async () => {
    const [order] = await getDb()
      .select({
        orderNumber: bookOrders.orderNumber,
        status: bookOrders.status,
        packageCode: bookOrders.packageCode,
        currency: bookOrders.currency,
        totalAmountCents: bookOrders.totalAmountCents,
        refundedAmountCents: bookOrders.refundedAmountCents,
        createdAt: bookOrders.createdAt,
      })
      .from(bookOrders)
      .where(eq(bookOrders.id, orderId))
      .limit(1);
    return order ?? null;
  });
}

export async function revokeBookDeliveryCredentials(params: {
  entitlementIds?: string[];
  orderId?: string;
  actorUserId?: string | null;
  reason: string;
  /** Reissue creates the replacement link before invalidating predecessors. */
  exceptLinkId?: string | null;
}): Promise<number> {
  if ((!params.entitlementIds || params.entitlementIds.length === 0) && !params.orderId) return 0;
  return withDbAttribution(bookCommerceLabel("delivery-credentials-revoke"), async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const ids = params.entitlementIds?.length
        ? params.entitlementIds
        : (await tx.select({ id: bookEntitlements.id }).from(bookEntitlements)
          .where(eq(bookEntitlements.orderId, params.orderId!))).map((r) => r.id);
      if (ids.length === 0) return 0;
      const stamp = now();
      const revokeLinksPredicate = and(
        inArray(bookDeliveryLinks.entitlementId, ids),
        isNull(bookDeliveryLinks.revokedAt),
        params.exceptLinkId
          ? sql`${bookDeliveryLinks.id} <> ${params.exceptLinkId}`
          : undefined,
      );
      await tx.update(bookDeliveryLinks)
        .set({ revokedAt: stamp })
        .where(revokeLinksPredicate);
      await tx.update(bookDeliverySessions)
        .set({ revokedAt: stamp })
        .where(and(inArray(bookDeliverySessions.entitlementId, ids), isNull(bookDeliverySessions.revokedAt)));
      for (const entitlementId of ids) {
        await insertDeliveryAuditTx(tx, {
          entitlementId,
          actorUserId: params.actorUserId ?? null,
          eventType: "access_revoked",
          outcome: "completed",
          detail: params.reason.slice(0, 400),
          idempotencyKey: `delivery-credentials-revoked:${entitlementId}:${params.reason}`,
        });
      }
      return ids.length;
    });
  });
}

export async function insertBookDeliveryAudit(params: {
  entitlementId: string;
  assetId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  outcome: "accepted" | "denied" | "completed" | "unavailable" | "failed";
  detail?: string | null;
  idempotencyKey?: string | null;
}): Promise<void> {
  return withDbAttribution(bookCommerceLabel("delivery-audit-insert"), async () => {
    await insertDeliveryAuditTx(getDb(), params);
  });
}

/** Boot catch-up reads the commerce authority, not a raw buyer identifier. */
export async function listActiveDigitalDeliveryOrderIds(
  limit: number,
  afterOrderId?: string,
): Promise<string[]> {
  return withDbAttribution(bookCommerceLabel("delivery-catchup-list"), async () => {
    const rows = await getDb()
      .selectDistinct({ orderId: bookEntitlements.orderId })
      .from(bookEntitlements)
      .where(
        and(
          eq(bookEntitlements.entitlementCode, "digital_book"),
          eq(bookEntitlements.status, "active"),
          sql`(${bookEntitlements.expiresAt} IS NULL OR ${bookEntitlements.expiresAt} > now())`,
          afterOrderId ? gt(bookEntitlements.orderId, afterOrderId) : undefined,
        ),
      )
      .orderBy(asc(bookEntitlements.orderId))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => row.orderId);
  });
}

async function insertDeliveryAuditTx(
  db: any,
  params: {
    entitlementId: string;
    assetId?: string | null;
    actorUserId?: string | null;
    eventType: string;
    outcome: "accepted" | "denied" | "completed" | "unavailable" | "failed";
    detail?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<void> {
  await db.insert(bookDeliveryAudit).values({
    entitlementId: params.entitlementId,
    assetId: params.assetId ?? null,
    actorUserId: params.actorUserId ?? null,
    eventType: params.eventType,
    outcome: params.outcome,
    detail: params.detail?.slice(0, 400) ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
  }).onConflictDoNothing();
}