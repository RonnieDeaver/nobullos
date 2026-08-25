/**
 * Secure paid-book delivery service.
 *
 * Links are high-entropy HMAC capabilities, but the database keeps only
 * domain-separated SHA-256 evidence. Email links place the capability in the
 * URL fragment, so it never reaches servers, logs, analytics, or history after
 * the access center exchanges it for an HttpOnly cookie.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSystemSettingFresh } from "../storage/settingsStorage";
import { composeOutboundEmails } from "./outboundEmail";
import { getPublicBaseUrl } from "./publicUrl";
import { normalizeBookEmail } from "../storage/bookCommerceStorage";
import {
  createBookDeliveryLink,
  exchangeBookDeliveryLink,
  findActiveDigitalDeliveryEntitlementForCheckout,
  findActiveBookDeliveryEntitlement,
  getAuthorizedBookDeliveryAssetForOrder,
  getBookDeliveryOrderSummary,
  getBookDeliveryRecipient,
  insertBookDeliveryAudit,
  listActiveBookDeliveryAssetsForOrder,
  listActiveDeliveryEntitlementsForEmail,
  listActiveDeliveryEntitlementsForOrder,
  listActiveDigitalDeliveryOrderIds,
  resolveBookDeliverySession,
  revokeBookDeliveryCredentials,
  type DeliveryLinkPurpose,
} from "../storage/bookDeliveryStorage";
import type { WorkQueueJob } from "@shared/schema";
import { enqueueJob } from "./workScheduler";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { runWithWorkerDb } from "../db";
import { getPackageByCode } from "./bookCommerceCatalog";

export const BOOK_DELIVERY_SENDER_USER_ID_KEY = "book_delivery_sender_user_id";
export const BOOK_DELIVERY_LINK_TTL_MS = 72 * 60 * 60 * 1000;
export const BOOK_IMMEDIATE_ACCESS_LINK_TTL_MS = 5 * 60 * 1000;
export const BOOK_DELIVERY_SESSION_TTL_MS = 30 * 60 * 1000;
export const BOOK_DELIVERY_COOKIE = "book_delivery_session";
export const BOOK_PAID_DELIVERY_QUEUE = "book_paid_delivery";

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) throw new Error("Book delivery is not configured");
  return value;
}

function sha256(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** Deterministic 256-bit capability makes a crashed email compose safely replayable. */
export function deriveBookDeliveryToken(entitlementId: string, idempotencyKey: string): string {
  return createHmac("sha256", secret())
    .update(`book-delivery-link:v1\n${entitlementId}\n${idempotencyKey}`, "utf8")
    .digest("base64url");
}

export function hashBookDeliveryToken(token: string): string {
  return sha256(`book-delivery-token-evidence:v1\n${token}`);
}

export function hashBookDeliverySession(session: string): string {
  return sha256(`book-delivery-session-evidence:v1\n${session}`);
}

function hashEquals(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

async function configuredSenderUserId(): Promise<string> {
  const setting = await getSystemSettingFresh(BOOK_DELIVERY_SENDER_USER_ID_KEY);
  const senderUserId = setting?.value?.trim();
  if (!senderUserId) throw new Error("Book delivery sender is not configured");
  return senderUserId;
}

function makeAccessUrl(token: string): string {
  const base = getPublicBaseUrl({ allowLocalhostFallback: true });
  return `${base.replace(/\/$/, "")}/book/access#access=${encodeURIComponent(token)}`;
}

async function ensureLink(params: {
  entitlementId: string;
  purpose: DeliveryLinkPurpose;
  idempotencyKey: string;
  actorUserId?: string | null;
  ttlMs?: number;
}): Promise<{ token: string; expiresAt: Date; linkId: string }> {
  const token = deriveBookDeliveryToken(params.entitlementId, params.idempotencyKey);
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? BOOK_DELIVERY_LINK_TTL_MS));
  const result = await createBookDeliveryLink({
    entitlementId: params.entitlementId,
    purpose: params.purpose,
    idempotencyKey: params.idempotencyKey,
    tokenHash: hashBookDeliveryToken(token),
    expiresAt,
    actorUserId: params.actorUserId ?? null,
  });
  return { token, expiresAt: result.link.expiresAt, linkId: result.link.id };
}

async function composeAccessEmail(params: {
  email: string;
  links: Array<{ token: string; entitlementId: string }>;
  batchKey: string;
  actorUserId?: string | null;
  kind: "initial" | "resend" | "reissue";
}): Promise<void> {
  if (params.links.length === 0) return;
  const senderUserId = await configuredSenderUserId();
  const urls = params.links.map((item) => makeAccessUrl(item.token));
  const linkLines = urls.map((url) => `Access your paid book: ${url}`).join("\n");
  const subject = "Your secure access to Law Firm Revenue Engine";
  const bodyText =
    `Thank you for your purchase.\n\n${linkLines}\n\n` +
    "For your security, each link can be used once and expires in 72 hours. " +
    "After opening it, access is checked again before every download.";
  const bodyHtml =
    `<p>Thank you for your purchase.</p>${urls
      .map((url) => `<p><a href="${url.replace(/"/g, "%22")}">Access your paid book</a></p>`)
      .join("")}<p>For your security, each link can be used once and expires in 72 hours.</p>`;
  await composeOutboundEmails({
    senderUserId,
    createdBy: params.actorUserId ?? senderUserId,
    subject,
    bodyText,
    bodyHtml,
    messageClass: "transactional",
    consentSource: "paid_book_delivery",
    recipients: [{ email: params.email }],
    clientBatchKey: params.batchKey,
  });
  for (const item of params.links) {
    await insertBookDeliveryAudit({
      entitlementId: item.entitlementId,
      actorUserId: params.actorUserId ?? null,
      eventType: `email_${params.kind}`,
      outcome: "accepted",
      idempotencyKey: `delivery-email:${params.kind}:${item.entitlementId}:${params.batchKey}`,
    });
  }
}

/** Called from the verified Stripe path; safe on every retry. */
export async function ensureInitialBookDeliveryForOrder(orderId: string): Promise<void> {
  const entitlements = await listActiveDeliveryEntitlementsForOrder(orderId);
  for (const entitlement of entitlements) {
    if (entitlement.entitlementCode !== "digital_book") continue;
    const key = `book-initial:${entitlement.id}`;
    const { token } = await ensureLink({
      entitlementId: entitlement.id,
      purpose: "initial",
      idempotencyKey: key,
    });
    const email = await getBookDeliveryRecipient(entitlement.id);
    if (!email) continue;
    await composeAccessEmail({
      email,
      links: [{ token, entitlementId: entitlement.id }],
      batchKey: key,
      kind: "initial",
    });
  }
}

/**
 * Mint a short-lived recovery capability only after the caller has independently
 * proven a completed checkout. A five-minute deterministic bucket makes status
 * polling idempotent while allowing a later browser recovery to receive a fresh
 * one-time link after an earlier capability was consumed.
 */
export async function createImmediateBookAccessCapabilityForCheckout(
  checkoutSessionId: string,
): Promise<string | null> {
  const entitlement = await findActiveDigitalDeliveryEntitlementForCheckout(checkoutSessionId);
  if (!entitlement) return null;
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const { token } = await ensureLink({
    entitlementId: entitlement.id,
    purpose: "reissue",
    idempotencyKey: `book-checkout-immediate:${entitlement.id}:${bucket}`,
    ttlMs: BOOK_IMMEDIATE_ACCESS_LINK_TTL_MS,
  });
  return token;
}

/** Public endpoint calls this and always receives a generic accepted response. */
export async function requestBookDeliveryResend(email: string): Promise<void> {
  const normalized = normalizeBookEmail(email);
  const entitlements = await listActiveDeliveryEntitlementsForEmail(normalized);
  const digital = entitlements.filter((row) => row.entitlement.entitlementCode === "digital_book");
  if (digital.length === 0) return;
  // A UI retry uses the same five-minute idempotency bucket; a buyer who has
  // already consumed a link can request a fresh one in the next bucket without
  // support intervention. The capability itself is never based on their email.
  const requestWindow = Math.floor(Date.now() / (5 * 60 * 1000));
  const emailHash = sha256(normalized).slice(0, 32);
  const batchKey = `book-resend:${emailHash}:${requestWindow}`;
  const links = await Promise.all(
    digital.map(async ({ entitlement }) => ({
      entitlementId: entitlement.id,
      token: (await ensureLink({
        entitlementId: entitlement.id,
        purpose: "resend",
        idempotencyKey: `${batchKey}:${entitlement.id}`,
      })).token,
    })),
  );
  await composeAccessEmail({ email: normalized, links, batchKey, kind: "resend" });
}

export async function supportResendBookDelivery(params: {
  entitlementId: string;
  actorUserId: string;
  idempotencyKey: string;
}): Promise<void> {
  if (!(await findActiveBookDeliveryEntitlement(params.entitlementId))) return;
  await insertBookDeliveryAudit({
    entitlementId: params.entitlementId,
    actorUserId: params.actorUserId,
    eventType: "support_resend",
    outcome: "accepted",
    idempotencyKey: `delivery-support-resend:${params.entitlementId}:${params.idempotencyKey}`,
  });
  const email = await getBookDeliveryRecipient(params.entitlementId);
  if (!email) return;
  const key = `book-support-resend:${params.entitlementId}:${params.idempotencyKey}`;
  const { token } = await ensureLink({
    entitlementId: params.entitlementId,
    purpose: "resend",
    idempotencyKey: key,
    actorUserId: params.actorUserId,
  });
  await composeAccessEmail({
    email,
    links: [{ token, entitlementId: params.entitlementId }],
    batchKey: key,
    actorUserId: params.actorUserId,
    kind: "resend",
  });
}

export async function supportReissueBookDelivery(params: {
  entitlementId: string;
  actorUserId: string;
  idempotencyKey: string;
}): Promise<void> {
  if (!(await findActiveBookDeliveryEntitlement(params.entitlementId))) return;
  await insertBookDeliveryAudit({
    entitlementId: params.entitlementId,
    actorUserId: params.actorUserId,
    eventType: "support_reissue",
    outcome: "accepted",
    idempotencyKey: `delivery-support-reissue:${params.entitlementId}:${params.idempotencyKey}`,
  });
  const key = `book-support-reissue:${params.entitlementId}:${params.idempotencyKey}`;
  const linked = await ensureLink({
    entitlementId: params.entitlementId,
    purpose: "reissue",
    idempotencyKey: key,
    actorUserId: params.actorUserId,
  });
  // Preserve this deterministically re-derived replacement link on an
  // idempotent retry while invalidating every earlier link and session.
  await revokeBookDeliveryCredentials({
    entitlementIds: [params.entitlementId],
    actorUserId: params.actorUserId,
    reason: "support_reissue",
    exceptLinkId: linked.linkId,
  });
  const email = await getBookDeliveryRecipient(params.entitlementId);
  if (!email) return;
  await composeAccessEmail({
    email,
    links: [{ token: linked.token, entitlementId: params.entitlementId }],
    batchKey: key,
    actorUserId: params.actorUserId,
    kind: "reissue",
  });
}

export async function exchangeBookDeliveryCapability(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hashBookDeliveryToken(token);
  // Same-shape local check prevents changes to the token normalizer from
  // weakening the lookup's constant-size comparison contract.
  if (!hashEquals(tokenHash, hashBookDeliveryToken(token))) return null;
  const session = randomBytes(32).toString("base64url");
  const result = await exchangeBookDeliveryLink({
    tokenHash,
    sessionHash: hashBookDeliverySession(session),
    sessionExpiresAt: new Date(Date.now() + BOOK_DELIVERY_SESSION_TTL_MS),
  });
  return result ? session : null;
}

export async function resolveBookDeliveryBrowserSession(cookieValue: string | undefined) {
  if (!cookieValue || !/^[A-Za-z0-9_-]{43}$/.test(cookieValue)) return null;
  return resolveBookDeliverySession(hashBookDeliverySession(cookieValue));
}

export async function listBookDeliveryAssetsForSession(cookieValue: string | undefined) {
  const entitlement = await resolveBookDeliveryBrowserSession(cookieValue);
  if (!entitlement) return null;
  const assets = await listActiveBookDeliveryAssetsForOrder(entitlement.orderId);
  await insertBookDeliveryAudit({
    entitlementId: entitlement.id,
    eventType: "assets_viewed",
    outcome: "completed",
    idempotencyKey: `delivery-assets-viewed:${entitlement.id}:${Math.floor(Date.now() / 60_000)}`,
  });
  return {
    entitlement,
    assets: assets.map(({ asset, entitlement: assetEntitlement }) => ({
      id: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
      entitlementCode: assetEntitlement.entitlementCode,
    })),
  };
}

type BuyerOrderState =
  | "confirmed"
  | "partially_refunded"
  | "refunded"
  | "cancelled"
  | "under_review";
export async function authorizeBookDeliveryDownload(params: {
  cookieValue: string | undefined;
  assetId: string;
}) {
  const entitlement = await resolveBookDeliveryBrowserSession(params.cookieValue);
  if (!entitlement) return null;
  const authorized = await getAuthorizedBookDeliveryAssetForOrder({
    orderId: entitlement.orderId,
    assetId: params.assetId,
  });
  if (!authorized) {
    await insertBookDeliveryAudit({
      entitlementId: entitlement.id,
      eventType: "download",
      outcome: "denied",
      idempotencyKey: `delivery-download-denied:${entitlement.id}:${params.assetId}:${Math.floor(Date.now() / 60_000)}`,
    });
    return null;
  }
  const { asset, entitlement: assetEntitlement } = authorized;
  await insertBookDeliveryAudit({
    entitlementId: assetEntitlement.id,
    assetId: asset.id,
    eventType: "download",
    outcome: "accepted",
  });
  return { entitlement: assetEntitlement, asset };
}

export async function recordBookDeliveryDownloadOutcome(params: {
  entitlementId: string;
  assetId: string;
  outcome: "completed" | "unavailable" | "failed";
}): Promise<void> {
  await insertBookDeliveryAudit({
    entitlementId: params.entitlementId,
    assetId: params.assetId,
    eventType: "download",
    outcome: params.outcome,
  });
}
export async function revokeDeliveryForOrder(orderId: string, reason: string): Promise<void> {
  await revokeBookDeliveryCredentials({ orderId, reason });
}

export async function enqueueBookPaidDelivery(orderId: string): Promise<void> {
  await enqueueJob({
    queueName: BOOK_PAID_DELIVERY_QUEUE,
    workloadClass: "interactive",
    payload: { orderId },
    dedupeKey: `book_paid_delivery:${orderId}`,
    maxAttempts: 5,
  });
}

/** Post-commit kick; authority persisted first and boot recovery heals misses. */
export async function kickBookPaidDeliverySafe(orderId: string | null | undefined): Promise<void> {
  if (!orderId) return;
  try {
    await enqueueBookPaidDelivery(orderId);
  } catch (error) {
    console.error(
      "[book-delivery] delivery kick deferred to boot catch-up:",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export async function handleBookPaidDelivery(job: WorkQueueJob): Promise<void> {
  const orderId = (job.payload as { orderId?: unknown } | null)?.orderId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    console.error("[book-delivery] paid delivery job dropped: missing orderId");
    return;
  }
  await ensureInitialBookDeliveryForOrder(orderId);
}

let deliveryBootCatchupTimer: NodeJS.Timeout | null = null;

/**
 * A one-shot deploy recovery closes the only gap between an entitlement's
 * committed grant and its post-commit queue kick. It does not create a new
 * polling scheduler; idempotent links and outbound batches make every item a
 * no-op after its initial message is durable.
 */
export function scheduleBookDeliveryBootCatchup(): void {
  if (deliveryBootCatchupTimer || (!isRunningInDeployment() && process.env.BOOK_DELIVERY_CATCHUP_FORCE !== "1")) {
    return;
  }
  const queuePage = (afterOrderId?: string): void => {
    void runWithWorkerDb(async () => {
      const orderIds = await listActiveDigitalDeliveryOrderIds(200, afterOrderId);
      await Promise.all(orderIds.map((orderId) => enqueueBookPaidDelivery(orderId)));
      if (orderIds.length > 0) console.log(`[book-delivery] boot recovery queued ${orderIds.length} paid order(s)`);
      // This is a bounded deployment catch-up chain, not a polling loop. Each
      // page is cursor-ordered so every active entitlement is reached even
      // when a missed queue kick affected more than one batch.
      if (orderIds.length === 200) {
        deliveryBootCatchupTimer = setTimeout(() => queuePage(orderIds.at(-1)), 0);
        deliveryBootCatchupTimer.unref?.();
      }
    }).catch((error) => {
      console.warn(
        "[book-delivery] boot recovery failed (next deployment retries):",
        error instanceof Error ? error.message : "unknown",
      );
    });
  };
  deliveryBootCatchupTimer = setTimeout(() => queuePage(), 30_000);
  deliveryBootCatchupTimer.unref?.();
}

export const __test = {
  deriveBookDeliveryToken,
  hashBookDeliveryToken,
  hashBookDeliverySession,
};

function toBuyerOrderState(status: string): BuyerOrderState {
  if (status === "partially_refunded") return "partially_refunded";
  if (status === "refunded") return "refunded";
  if (status === "cancelled") return "cancelled";
  if (status === "disputed") return "under_review";
  return "confirmed";
}

export async function getBookDeliveryOrderStatusForSession(
  cookieValue: string | undefined,
) {
  const entitlement = await resolveBookDeliveryBrowserSession(cookieValue);
  if (!entitlement) return null;
  const [order, entitlements, assets] = await Promise.all([
    getBookDeliveryOrderSummary(entitlement.orderId),
    listActiveDeliveryEntitlementsForOrder(entitlement.orderId),
    listActiveBookDeliveryAssetsForOrder(entitlement.orderId),
  ]);
  if (!order) return null;
  const entitlementCodes = new Set(entitlements.map((item) => item.entitlementCode));
  const availableAssetCodes = new Set(
    assets.map(({ entitlement: assetEntitlement }) => assetEntitlement.entitlementCode),
  );
  const packageLabel = getPackageByCode(order.packageCode)?.name ?? "Book purchase";
  await insertBookDeliveryAudit({
    entitlementId: entitlement.id,
    eventType: "order_status_viewed",
    outcome: "completed",
    idempotencyKey: `delivery-order-viewed:${entitlement.id}:${Math.floor(Date.now() / 60_000)}`,
  });
  return {
    orderNumber: order.orderNumber,
    placedAt: order.createdAt.toISOString(),
    packageCode: order.packageCode,
    packageLabel,
    orderState: toBuyerOrderState(order.status),
    currency: order.currency,
    totalAmountCents: order.totalAmountCents,
    refundedAmountCents: order.refundedAmountCents,
    digitalDelivery: availableAssetCodes.has("digital_book")
      ? "available"
      : entitlementCodes.has("digital_book")
        ? "preparing"
        : "unavailable",
    audioDelivery: availableAssetCodes.has("audiobook")
      ? "available"
      : entitlementCodes.has("audiobook")
        ? "preparing"
        : "not_included",
    // No address, carrier, or tracking fields exist until physical operations
    // launch. A Complete purchase is explicitly inactive rather than implied.
    physicalFulfillment: order.packageCode === "complete" ? "not_active" : "not_included",
  };
}
